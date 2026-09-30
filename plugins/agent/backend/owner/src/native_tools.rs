//! Semantic native-tool admission uses explicit Send and tool identities. The
//! original native journal remains the only owner of scientific results.
use crate::*;
use rho_agent_api::component::{PluginRequest, RequestId};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const MAX_NATIVE_TOOLS: usize = 24;
pub const MAX_NATIVE_TOOL_CALLS: usize = 64;
pub const MAX_NATIVE_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_NATIVE_TOOL_RESULT_BYTES: usize = 96 * 1024;
pub const MAX_NATIVE_TOOL_RECORD_BYTES: usize = 192 * 1024;
pub const MAX_PROJECT_NATIVE_TOOL_BYTES: usize = 64 * 1024 * 1024;

pub fn validate_grants(origin: &AgentNativeCommandOrigin) -> Result<(), AgentTaskError> {
    let mut names = BTreeSet::new();
    if origin.tools.len() > MAX_NATIVE_TOOLS
        || serde_json::to_vec(&origin.tools).map_err(storage)?.len() > 64 * 1024
    {
        return Err(AgentTaskError::Budget(
            "Native tool catalog exceeds its bounds".into(),
        ));
    }
    for tool in &origin.tools {
        let selection = &tool.selection;
        let target_valid = match &selection.target {
            AgentNativeToolTarget::Provider { binding } => {
                binding.project == origin.binding.project
                    && binding.provider != origin.binding.provider
            }
            AgentNativeToolTarget::Host {
                project,
                capability,
                fixed_arguments,
            } => {
                project == &origin.binding.project
                    && (1..=65535).contains(&capability.version)
                    && fixed_arguments.len() <= 128
                    && fixed_arguments
                        .keys()
                        .all(|name| !name.is_empty() && name.len() <= 256)
            }
        };
        if !target_valid
            || selection.name.is_empty()
            || selection.name.len() > 64
            || !selection
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            || !names.insert(&selection.name)
            || !tool.required_scopes.is_subset(&origin.scopes)
            || tool.description.len() > 4096
            || !tool.input_schema.is_object()
        {
            return Err(invalid("Invalid captured native tool selection"));
        }
    }
    Ok(())
}
fn storage(error: impl ToString) -> AgentTaskError {
    AgentTaskError::Storage(error.to_string())
}
fn captured_request(
    grant: &AgentNativeToolGrant,
    input: &AgentNativeToolInvocation,
) -> Result<AgentNativeToolRequest, AgentTaskError> {
    Ok(match &grant.selection.target {
        AgentNativeToolTarget::Provider { binding } => AgentNativeToolRequest::Provider {
            request: PluginRequest {
                binding: binding.clone(),
                arguments: input.arguments.clone(),
                preconditions: input.preconditions.clone(),
            },
        },
        AgentNativeToolTarget::Host {
            project,
            capability,
            fixed_arguments,
        } => AgentNativeToolRequest::Host {
            project: project.clone(),
            capability: capability.clone(),
            arguments: native_host_tool_arguments(
                fixed_arguments,
                &input.arguments,
                &input.preconditions,
            )?,
        },
    })
}
fn native_tool_request(input: &AgentNativeToolInvocation) -> RequestId {
    let digest =
        Sha256::digest(serde_json::to_vec(&(&input.send_request, &input.tool_request)).unwrap());
    RequestId::new(format!("agent-native-tool-{digest:x}")).unwrap()
}
pub fn validate_native_tool(
    scope: &AgentTaskScope,
    capture: &StoredAgentNativeAdmission,
    receipt: &AgentNativeToolReceipt,
) -> Result<(), AgentTaskError> {
    let input = &receipt.invocation;
    if uuid::Uuid::parse_str(&input.tool_request)
        .map_err(|_| invalid("Invalid tool request identity"))?
        .to_string()
        != input.tool_request
        || capture.request.request_id != input.send_request
        || capture.task_id != receipt.task_id
        || capture.origin.project_root != scope.project
        || capture.origin.principal != scope.principal
        || !matches!(capture.request.command, AgentTaskCommand::Send { .. })
        || receipt.request != native_tool_request(input)
        || receipt.updated_at_ms < receipt.created_at_ms
    {
        return Err(AgentTaskError::RequestConflict);
    }
    let grant = capture
        .origin
        .tools
        .iter()
        .find(|t| t.selection.name == input.tool)
        .ok_or_else(|| invalid("Tool is outside the original Send selection"))?;
    if receipt.kind != grant.kind || receipt.native_request != captured_request(grant, input)? {
        return Err(AgentTaskError::RequestConflict);
    }
    if serde_json::to_vec(input).map_err(storage)?.len() > MAX_NATIVE_TOOL_ARGUMENT_BYTES
        || serde_json::to_vec(receipt).map_err(storage)?.len() > MAX_NATIVE_TOOL_RECORD_BYTES
        || serde_json::to_vec(&receipt.result).map_err(storage)?.len()
            > MAX_NATIVE_TOOL_RESULT_BYTES
    {
        return Err(AgentTaskError::Budget(
            "Native tool record exceeds its byte budget".into(),
        ));
    }
    match receipt.phase {
        AgentNativeToolPhase::Prepared
            if receipt.operation.is_some()
                || receipt.result.is_some()
                || receipt.error.is_some()
                || receipt.failed =>
        {
            return Err(AgentTaskError::RequestConflict);
        }
        AgentNativeToolPhase::Resolved if receipt.result.is_none() || receipt.error.is_some() => {
            return Err(AgentTaskError::RequestConflict);
        }
        AgentNativeToolPhase::Uncertain
            if receipt.error.as_deref().is_none_or(str::is_empty) || !receipt.failed =>
        {
            return Err(AgentTaskError::RequestConflict);
        }
        _ => (),
    }
    if (receipt.kind == AgentNativeToolKind::Query && receipt.operation.is_some())
        || (receipt.kind == AgentNativeToolKind::Operation
            && receipt.phase == AgentNativeToolPhase::Resolved
            && receipt.operation.is_none())
    {
        return Err(AgentTaskError::RequestConflict);
    }
    Ok(())
}

impl AgentTaskOwner {
    /// The gate defines acceptance before a concurrent Stop. Once accepted, the
    /// containing backend retains the child through its original Host reply.
    pub fn admit_native_tool(
        &self,
        scope: &AgentTaskScope,
        task_id: &str,
        generation: u64,
        input: AgentNativeToolInvocation,
        at: u64,
    ) -> Result<(AgentNativeToolReceipt, bool), AgentTaskError> {
        let _gate = self
            .gate
            .lock()
            .map_err(|_| storage("Native tool admission is unavailable"))?;
        let capture = self
            .store
            .agent_native_admission(scope, &input.send_request)?
            .ok_or(AgentTaskError::NotFound)?;
        let grant = capture
            .origin
            .tools
            .iter()
            .find(|t| t.selection.name == input.tool)
            .ok_or_else(|| invalid("Tool is outside the original Send selection"))?;
        let record = AgentNativeToolReceipt {
            task_id: task_id.into(),
            request: native_tool_request(&input),
            native_request: captured_request(grant, &input)?,
            kind: grant.kind,
            invocation: input,
            phase: AgentNativeToolPhase::Prepared,
            operation: None,
            result: None,
            failed: false,
            error: None,
            created_at_ms: at,
            updated_at_ms: at,
        };
        validate_native_tool(scope, &capture, &record)?;
        if let Some(old) = self.store.agent_native_tool(
            scope,
            &record.invocation.send_request,
            &record.invocation.tool_request,
        )? {
            if old.invocation != record.invocation
                || old.task_id != record.task_id
                || old.native_request != record.native_request
            {
                return Err(AgentTaskError::RequestConflict);
            }
            return Ok((old, true));
        }
        let task = self.get(scope, task_id)?;
        let send = self
            .store
            .agent_receipt(scope, &record.invocation.send_request)?
            .ok_or(AgentTaskError::NotFound)?;
        if task.host_incarnation != self.host_incarnation
            || task.attachment.generation != generation
            || task.active_request.as_deref() != Some(&record.invocation.send_request)
            || task.attachment.control_frozen
            || task.attachment.state == "stopping"
            || !matches!(send.status.as_str(), "prepared" | "submitted")
        {
            return Err(invalid(
                "The original Send no longer accepts new native tools",
            ));
        }
        self.store.put_agent_native_tool(scope, &record)?;
        Ok((record, false))
    }
}
