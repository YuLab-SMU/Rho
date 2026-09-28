//! A cross-window takeover observes the original view's native attachment.
//! Missing replies or browser registrations never stand in for revoked authority.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode},
    server,
};
use rho_agent_api::{AgentTaskCommand, AgentTaskRequest};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::json;

pub(crate) async fn check_takeover(
    metadata: &Metadata,
    call: &PluginCall,
    caller: &PluginViewCaller,
    request: &AgentTaskRequest,
    host: &HostCallClient,
) -> Result<(), Failure> {
    let AgentTaskCommand::TakeOver {
        control,
        stop: true,
    } = &request.command
    else {
        return Ok(());
    };
    // Identical retries only inspect an admitted request; the owner still checks
    // its complete digest and original instance before returning that receipt.
    if metadata
        .native
        .owner
        .store
        .agent_receipt(&metadata.scope, &request.request_id)?
        .is_some()
    {
        return Ok(());
    }
    let task = metadata
        .native
        .owner
        .get(&metadata.scope, &control.task_id)?;
    if task.attachment.controller.window_id == request.window.window_id {
        return Ok(());
    }
    let view = task
        .attachment
        .controller
        .incarnation
        .strip_prefix("view:")
        .and_then(|id| ViewInstanceId::new(id).ok())
        .ok_or_else(|| {
            Failure::invalid("The original controller has no observable view identity")
        })?;
    let pending = host
        .begin(
            RequestId::new(format!("agent-presence-{}", uuid::Uuid::new_v4())).unwrap(),
            call.request.clone(),
            manifest::key("views.presence"),
            json!({"view":view}),
        )
        .map_err(|_| Failure::invalid("Original controller presence could not be observed"))?;
    let value = pending
        .receive()
        .await
        .map_err(|_| Failure::invalid("Original controller presence is unconfirmed"))?;
    if value["status"] != "ready" || value["completeness"] != "complete" {
        return Err(Failure::invalid(
            "Original controller presence is incomplete",
        ));
    }
    let presence: PluginViewPresence = decode(&value["data"])?;
    if presence.view != view || presence.window.as_str() != task.attachment.controller.window_id {
        return Err(Failure::invalid(
            "Controller presence differs from its original identity",
        ));
    }
    if !matches!(
        presence.state,
        PluginViewPresenceState::Detached | PluginViewPresenceState::Closed
    ) {
        return Err(Failure::invalid(
            "The controlling view is still attached; stop the Agent there before taking over",
        ));
    }
    // The presence read awaited another Host response. Reobserve the requesting
    // view immediately before synchronous owner admission, including connection.
    let pending = host
        .begin(
            RequestId::new(format!("agent-takeover-caller-{}", uuid::Uuid::new_v4())).unwrap(),
            call.request.clone(),
            manifest::key("views.caller"),
            json!({}),
        )
        .map_err(|_| Failure::invalid("The requesting controller could not be revalidated"))?;
    let fresh = server::caller(pending.receive().await)?;
    if &fresh != caller {
        return Err(Failure::invalid(
            "The requesting controller changed before takeover",
        ));
    }
    Ok(())
}
