//! Immutable native task admission; observation only, never a dispatch credential.
//! The containing backend supplies the validated original caller and Operation.
use crate::{AgentTaskError, AgentTaskScope};
use rho_agent_api::component::{OperationId, ProviderBinding, RequestId};
use rho_agent_api::{
    AgentCommandReceipt, AgentTask, AgentTaskCommand, AgentTaskDraft, AgentTaskRequest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const MAX_NATIVE_ADMISSION_BYTES: usize = 128 * 1024;
pub const MAX_PROJECT_NATIVE_ADMISSION_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentNativeCommandOrigin {
    pub operation: OperationId,
    pub request: RequestId,
    pub binding: ProviderBinding,
    pub project_root: String,
    pub principal: String,
    pub scopes: BTreeSet<String>,
}
impl AgentNativeCommandOrigin {
    pub fn validate(&self, scope: &AgentTaskScope) -> Result<(), AgentTaskError> {
        if self.binding.capability.id.as_str() != "agent.native.command"
            || self.binding.capability.version != 1
            || self.binding.target.is_some()
            || self.project_root != scope.project
            || self.principal != scope.principal
            || !self.scopes.contains("application.control")
            || !self.scopes.contains("plugins.read")
            || self.scopes.len() > 128
            || self
                .scopes
                .iter()
                .any(|s| s.is_empty() || s.len() > 128 || s.chars().any(char::is_control))
        {
            return Err(AgentTaskError::InvalidInput(
                "Invalid native Agent command admission".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAgentNativeAdmission {
    pub task_id: String,
    pub request_digest: String,
    pub request: AgentTaskRequest,
    pub input_task: AgentTask,
    pub input_draft: AgentTaskDraft,
    pub origin: AgentNativeCommandOrigin,
}
impl StoredAgentNativeAdmission {
    pub fn validate(
        &self,
        scope: &AgentTaskScope,
        receipt: &AgentCommandReceipt,
    ) -> Result<(), AgentTaskError> {
        self.origin.validate(scope)?;
        if self.task_id != receipt.task_id
            || self.request.project_root != scope.project
            || self.input_task.task_id != self.task_id
            || self.input_task.project_root != scope.project
            || receipt.command != crate::agent_command_name(&self.request.command)
            || agent_input_digest(&self.request, &self.input_task, &self.input_draft)?
                != receipt.input_digest
            || self.request.request_id != receipt.request_id
            || self.request_digest != receipt.request_digest
            || agent_request_digest(&self.request)? != self.request_digest
        {
            return Err(AgentTaskError::RequestConflict);
        }
        // Only Send includes draft content in the receipt. Other commands still
        // hash their original input, including a draft they may then replace.
        if let AgentTaskCommand::Send { draft_version, .. } = self.request.command {
            if draft_version != self.input_draft.version
                || receipt.submitted_draft_version != Some(draft_version)
                || receipt.input_assets != self.input_draft.content.assets
                || !same_json(&receipt.input_context, &self.input_draft.content.context)?
                || match &receipt.submitted_draft {
                    Some(draft) => !same_json(draft, &self.input_draft.content)?,
                    None => false,
                }
            {
                return Err(AgentTaskError::RequestConflict);
            }
        } else if !receipt.input_assets.is_empty()
            || !receipt.input_context.is_empty()
            || receipt.submitted_draft.is_some()
            || receipt.submitted_draft_version.is_some()
        {
            return Err(AgentTaskError::RequestConflict);
        }
        if matches!(self.request.command, AgentTaskCommand::AddAsset { .. }) {
            return Err(AgentTaskError::InvalidInput(
                "Native attachment bytes require a separate scoped Control".into(),
            ));
        }
        if serde_json::to_vec(self)
            .map_err(|e| AgentTaskError::Storage(e.to_string()))?
            .len()
            > MAX_NATIVE_ADMISSION_BYTES
        {
            return Err(AgentTaskError::Budget(
                "Native command admission exceeds its byte budget".into(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn agent_request_digest(request: &AgentTaskRequest) -> Result<String, AgentTaskError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(request).map_err(|e| AgentTaskError::InvalidInput(e.to_string()))?
        )
    ))
}

/// Same captured input digest used by the native task owner, before a command
/// updates configuration or the editable next draft.
pub(crate) fn agent_input_digest(
    request: &AgentTaskRequest,
    task: &AgentTask,
    draft: &AgentTaskDraft,
) -> Result<String, AgentTaskError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!({
                "command": request.command, "draft": draft.content, "model": task.model,
                "effort": task.effort, "mode": task.mode
            }))
            .map_err(|e| AgentTaskError::InvalidInput(e.to_string()))?
        )
    ))
}

fn same_json<T: Serialize>(left: &T, right: &T) -> Result<bool, AgentTaskError> {
    Ok(
        serde_json::to_value(left).map_err(|e| AgentTaskError::Storage(e.to_string()))?
            == serde_json::to_value(right).map_err(|e| AgentTaskError::Storage(e.to_string()))?,
    )
}
