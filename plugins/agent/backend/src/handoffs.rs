//! Ordinary-plugin handoffs reuse the existing atomic draft/receipt owner.
use crate::{
    arguments::{AppendHandoff, CredentialRequest, HandoffSource, HandoffTarget},
    manifest,
    metadata::{Failure, Metadata, decode, encoded, now},
    server,
};
use rho_agent_api::{ProjectAgentTaskRef, handoff::AgentHandoffCommand};
use rho_agent_owner::{
    component::ComponentTaskError,
    handoff::{handoff_context_key, handoff_source_expired},
};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(crate) fn read(metadata: &Metadata, call: &PluginCall) -> Result<Value, Failure> {
    match call.binding.capability.id.as_str() {
        "agent.handoff.source" => {
            let args: HandoffSource = decode(&call.arguments)?;
            encoded(
                metadata
                    .handoffs
                    .source(&metadata.scope, &args.source, &[])?,
            )
        }
        "agent.handoff.receipt" => {
            let args: CredentialRequest = decode(&call.arguments)?;
            if args.request_id.is_empty() || args.request_id.len() > 160 {
                return Err(Failure::invalid("Invalid handoff request identity"));
            }
            encoded(
                metadata
                    .handoffs
                    .receipt(&metadata.scope, &args.request_id)?,
            )
        }
        _ => Err(Failure::invalid("Unknown handoff query")),
    }
}

pub(crate) async fn target(
    metadata: &Metadata,
    call: &PluginCall,
    host: HostCallClient,
) -> Result<Value, Failure> {
    let args: HandoffTarget = decode(&call.arguments)?;
    if !call.scopes.contains("plugins.read") {
        return Err(Failure::invalid(
            "Target inspection requires its native caller scope",
        ));
    }
    let pending = host
        .begin(
            RequestId::new(format!("agent-handoff-caller-{}", uuid::Uuid::new_v4())).unwrap(),
            call.request.clone(),
            manifest::key("views.caller"),
            json!({}),
        )
        .map_err(|_| Failure::invalid("The target controller could not be observed"))?;
    let actor = metadata.actor(server::caller(pending.receive().await)?, now());
    let mut target = metadata
        .handoffs
        .target(&metadata.scope, &args.target, actor.window())?;
    // Ordinary views have independent identities even in the same window.
    if target.controller != *actor.window() {
        target.writable = false;
        target.reason = Some("This task is controlled by another view".into());
    }
    encoded(target)
}

pub(crate) async fn append(
    metadata: &Metadata,
    call: &PluginCall,
    caller: PluginViewCaller,
    host: HostCallClient,
) -> Result<Value, Failure> {
    let args: AppendHandoff = decode(&call.arguments)?;
    // An original receipt wins over changing sources, draft versions and live
    // providers. The owner still compares the entire original request digest.
    let repeated = metadata
        .handoffs
        .receipt(&metadata.scope, &args.request_id)?
        .is_some();
    if !repeated {
        if args.body.trim().is_empty()
            || args.body.len() > 16384
            || args.body.contains('\0')
            || args.context.len() > 16
        {
            return Err(Failure::invalid(
                "Handoff content is empty, invalid or exceeds its bound",
            ));
        }
        let source = metadata
            .handoffs
            .source(&metadata.scope, &args.source, &[])?;
        if source.revision != args.source_revision {
            return Err(handoff_source_expired().into());
        }
        let allowed = source
            .context
            .iter()
            .map(handoff_context_key)
            .collect::<Result<BTreeSet<_>, _>>()?;
        for selection in &args.context {
            if !allowed.contains(&handoff_context_key(selection)?) {
                return Err(Failure::invalid(
                    "This reference does not belong to the source task",
                ));
            }
        }
        // Both ordinary task kinds use this same public contributed-source
        // reader. Reject changed/unsupported references before writing a draft;
        // never retarget them or copy attachment identities to another task.
        crate::native_context::resolve(metadata, call, &caller, &args.context, &host).await?;
    }
    let at = now();
    let actor = metadata.actor(caller, at);
    let request = AgentHandoffCommand {
        project_root: metadata.scope.project.clone(),
        window: actor.window().clone(),
        request_id: args.request_id,
        source: args.source,
        source_revision: args.source_revision,
        target: args.target,
        target_draft_version: args.target_draft_version,
        target_control_generation: args.target_control_generation,
        body: args.body,
        context: args.context,
    };
    let commit = || -> Result<Value, Failure> {
        if !repeated {
            let target =
                metadata
                    .handoffs
                    .target(&metadata.scope, &request.target, actor.window())?;
            if target.controller != *actor.window() {
                return Err(ComponentTaskError::Conflict.into());
            }
        }
        encoded(metadata.handoffs.transfer(&actor, &request, &[], at)?)
    };
    match &request.target {
        ProjectAgentTaskRef::Native { .. } => metadata.native.owner.with_handoff_write(commit),
        ProjectAgentTaskRef::Rho { .. } => metadata.owner.with_handoff_write(commit),
    }
}
