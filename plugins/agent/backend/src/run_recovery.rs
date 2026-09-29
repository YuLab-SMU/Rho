//! Explicit original-tool inspection. No model or scientific operation is dispatched.
use crate::{
    arguments::ModelReconcile,
    manifest,
    metadata::{Failure, Metadata, decode, encoded, now},
    server,
};
use rho_agent_api::component::*;
use rho_agent_owner::component::{ComponentTaskError, ComponentToolAction};
use rho_plugin_sdk::{
    HostCallClient,
    protocol::{PluginCall, PluginViewCaller},
};
use serde_json::{Value, json};

pub(crate) async fn reconcile(
    metadata: &Metadata,
    runs: &crate::runs::Runs,
    call: &PluginCall,
    caller: PluginViewCaller,
    host: HostCallClient,
) -> Result<Value, Failure> {
    let args: ModelReconcile = decode(&call.arguments)?;
    if args.run_id.is_empty() || args.run_id.len() > 160 {
        return Err(Failure::invalid("Invalid original model run identity"));
    }
    if runs.live_ids()?.contains(&args.run_id) {
        return Err(Failure::invalid(
            "The original model or native tool wait is still live; inspect its current run",
        ));
    }
    let stored = metadata
        .owner
        .store
        .component_run(&metadata.scope, &args.run_id)?
        .ok_or(ComponentTaskError::NotFound)?;
    if !stored.run.state.is_terminal() || stored.native_origin.is_none() {
        return Err(Failure::invalid(
            "Take control of an interrupted task before inspecting its original tool outcomes",
        ));
    }
    let actor = metadata.actor(caller.clone(), now());
    let conversation = metadata
        .owner
        .store
        .component_conversation(&metadata.scope, &stored.run.request.conversation_id)?
        .ok_or(ComponentTaskError::NotFound)?;
    // A continuation relies on its ancestor's checked report. Refuse changes
    // while any turn is active; the version CAS also fences admission during
    // the asynchronous native reads below.
    if conversation.version != args.conversation_version
        || &conversation.controller != actor.window()
        || conversation.active_run_id.is_some()
    {
        return Err(ComponentTaskError::Conflict.into());
    }
    let recovered = inspect(metadata, call, &host, &args.run_id).await?;
    revalidate_caller(call, &host, &caller).await?;
    let at = now();
    let actor = metadata.actor(caller, at);
    encoded(metadata.owner.record_native_recovery(
        &actor,
        &args.run_id,
        args.conversation_version,
        recovered,
        at,
    )?)
}

pub(crate) async fn inspect(
    metadata: &Metadata,
    call: &PluginCall,
    host: &HostCallClient,
    id: &str,
) -> Result<Vec<ComponentRecoveredTool>, Failure> {
    let tools = metadata.owner.store.component_tools(&metadata.scope, id)?;
    let mut recovered = Vec::new();
    for tool in tools {
        let mut entry = ComponentRecoveredTool {
            receipt_id: tool.receipt.receipt_id.clone(),
            state: ComponentRecoveryState::ReadInterrupted,
            application_request_id: None,
            application_state: None,
            operations: vec![],
            documents: vec![],
            note: None,
        };
        match &tool.action {
            ComponentToolAction::PluginQuery(_)
            | ComponentToolAction::PreviousResult { .. }
            | ComponentToolAction::Rejected { .. } => {
                if tool.receipt.phase == ComponentToolPhase::Resolved {
                    entry.state = ComponentRecoveryState::Confirmed;
                } else {
                    entry.note = Some(
                        "No retained read result. A later request may make a fresh observation."
                            .into(),
                    );
                }
            }
            ComponentToolAction::PluginInvoke(_) => {
                // Reuse the checked original-parent lookup used by the public
                // tool inspector, with this new inspection as the read parent.
                let mut observation = call.clone();
                observation.arguments = json!({"run_id":id,"receipt_id":tool.receipt.receipt_id});
                let observed =
                    crate::tools::inspect_original(metadata, &observation, host.clone()).await?;
                if observed["completeness"] != "complete" {
                    entry.state = ComponentRecoveryState::Uncertain;
                    entry.note = Some("The original native Operation is not fully observable; absence is not proof that it was never submitted.".into());
                } else {
                    let operation = &observed["operation"];
                    let status: OperationStatus = decode(&operation["status"])?;
                    entry.state = match status {
                        OperationStatus::Succeeded
                        | OperationStatus::Failed
                        | OperationStatus::Cancelled => ComponentRecoveryState::Confirmed,
                        OperationStatus::Uncertain => ComponentRecoveryState::Uncertain,
                        _ => ComponentRecoveryState::Pending,
                    };
                    entry.operations.push(ComponentRecoveredOperation {
                        operation_id: decode(&operation["operation_id"])?,
                        status,
                    });
                }
            }
            _ => {
                return Err(Failure::invalid(
                    "This task contains an unsupported original tool action",
                ));
            }
        }
        recovered.push(entry);
    }
    Ok(recovered)
}

pub(crate) async fn revalidate_caller(
    call: &PluginCall,
    host: &HostCallClient,
    caller: &PluginViewCaller,
) -> Result<(), Failure> {
    let pending = host
        .begin(
            RequestId::new(format!("agent-recovery-{}", uuid::Uuid::new_v4())).unwrap(),
            call.request.clone(),
            manifest::key("views.caller"),
            json!({}),
        )
        .map_err(|_| Failure::invalid("Recovery caller revalidation is unavailable"))?;
    if server::caller(pending.receive().await)? != *caller {
        return Err(Failure::invalid(
            "The caller changed during original tool inspection; the report was not replaced",
        ));
    }
    Ok(())
}
