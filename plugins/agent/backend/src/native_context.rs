//! Resolve user-selected contribution references through public read ports before
//! Send. Original admissions return their retained bytes without rereading sources.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode},
    native_selection::{query, read_id, require},
    server,
};
use rho_agent_api::*;
use rho_agent_owner::{AgentNativeContextSnapshot, AgentTaskError, MAX_NATIVE_CONTEXT_BYTES};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::json;

pub(crate) async fn capture(
    metadata: &Metadata,
    call: &PluginCall,
    caller: &PluginViewCaller,
    request: &AgentTaskRequest,
    host: &HostCallClient,
) -> Result<Vec<AgentNativeContextSnapshot>, Failure> {
    if let Some(original) = metadata
        .native
        .owner
        .store
        .agent_native_admission(&metadata.scope, &request.request_id)?
    {
        return Ok(original.origin.contexts);
    }
    let AgentTaskCommand::Send {
        control,
        draft_version,
    } = &request.command
    else {
        return Ok(vec![]);
    };
    let task = metadata
        .native
        .owner
        .get(&metadata.scope, &control.task_id)?;
    let draft = metadata
        .native
        .owner
        .store
        .agent_draft(&metadata.scope, &control.task_id)?;
    if task.attachment.controller != request.window
        || task.attachment.generation != control.generation
        || draft.version != *draft_version
    {
        return Err(AgentTaskError::Conflict.into());
    }
    if draft.content.context.is_empty() {
        return Ok(vec![]);
    }
    require(
        metadata,
        call,
        &manifest::key("plugins.inspect"),
        &["plugins.read".into()].into(),
    )?;
    let mut captures = vec![];
    for selection in &draft.content.context {
        if selection.source != "plugin" {
            return Err(Failure::invalid(
                "Select a contributed source before sending; the original draft is retained",
            ));
        }
        let reference: ContextReference = decode(&selection.reference)?;
        reference
            .validate()
            .map_err(|error| Failure::invalid(&error.to_string()))?;
        let inclusion = serde_json::from_str(&selection.inclusion)
            .map_err(|error| Failure::invalid(&error.to_string()))?;
        let preview_request = PreviewContext {
            reference: reference.clone(),
            inclusion,
            max_bytes: 16384,
        };
        preview_request
            .validate()
            .map_err(|error| Failure::invalid(&error.to_string()))?;
        let inspected: PluginInspection = decode(
            &query(
                host,
                &call.request,
                manifest::key("plugins.inspect"),
                json!({"revision":reference.provider.revision}),
            )
            .await?,
        )?;
        if inspected.summary.revision != reference.provider.revision
            || inspected.manifest.id != reference.provider.plugin
            || !inspected
                .artifacts
                .iter()
                .any(|a| a.id == reference.provider.artifact)
        {
            return Err(Failure::invalid(
                "The selected source differs from its exact plugin version",
            ));
        }
        let contribution = inspected
            .manifest
            .contexts
            .iter()
            .find(|c| c.id == reference.contribution)
            .ok_or_else(|| {
                Failure::invalid("The selected version no longer declares this context source")
            })?;
        let descriptor = inspected
            .manifest
            .capabilities
            .iter()
            .find(|c| c.capability == contribution.preview && c.kind == CapabilityKind::Query)
            .ok_or_else(|| Failure::invalid("The selected context has no public preview query"))?;
        require(
            metadata,
            call,
            &descriptor.capability,
            &descriptor.required_scopes,
        )?;
        let binding = ProviderBinding {
            provider: reference.provider.clone(),
            project: call.binding.project.clone(),
            capability: descriptor.capability.clone(),
            target: None,
        };
        let preview: ContextPreview = decode(
            &query(
                host,
                &call.request,
                descriptor.capability.clone(),
                json!(PluginRequest {
                    binding,
                    arguments: json!(preview_request),
                    preconditions: serde_json::Value::Null
                }),
            )
            .await?,
        )?;
        preview
            .validate()
            .map_err(|error| Failure::invalid(&error.to_string()))?;
        if preview.item.reference != reference
            || preview.text.len() > 16384
            || preview.truncated
            || !preview.resources.is_empty()
        {
            return Err(Failure::invalid(
                "The selected context is changed, incomplete or needs unsupported resource input. Choose a complete text inclusion; the draft is retained",
            ));
        }
        captures.push(AgentNativeContextSnapshot {
            selection: selection.clone(),
            title: preview.item.title,
            description: preview.item.description,
            text: preview.text,
            data: preview.data,
        });
        if serde_json::to_vec(&captures)
            .map_err(|error| Failure::invalid(&error.to_string()))?
            .len()
            > MAX_NATIVE_CONTEXT_BYTES
        {
            return Err(Failure::invalid(
                "The selected context exceeds 64 KiB; reduce the inclusion before sending",
            ));
        }
    }
    let pending = host
        .begin(
            read_id(),
            call.request.clone(),
            manifest::key("views.caller"),
            json!({}),
        )
        .map_err(|_| Failure::invalid("Context caller revalidation is unavailable"))?;
    if server::caller(pending.receive().await)? != *caller {
        return Err(Failure::invalid(
            "The caller changed before context admission; the draft is retained",
        ));
    }
    Ok(captures)
}
