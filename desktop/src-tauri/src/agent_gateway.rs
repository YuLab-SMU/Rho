//! Turn-scoped live capability bridge for external ACP Agents.
//!
//! The gateway validates capability IDs and argument shapes, then dispatches
//! them faithfully through their existing Rho owner. It does not evaluate
//! intent or create an additional approval decision.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use rho_control_plane::{CapabilityRegistry, OperationMonitor};
use rho_core::ExecutionOrigin;
use rho_kernel::ArkSession;
use rho_protocol::{CapabilityId, OperationId};
use rho_server::{coordinator::dispatch_workspace_request, workspace_lane::WorkspaceBrokerLane};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use uuid::Uuid;

const MAX_GATEWAY_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentGatewayRequest {
    token: String,
    capability_id: String,
    arguments: Value,
}

#[derive(Debug, Serialize)]
struct AgentGatewayResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub(crate) struct AgentGatewayHandle {
    address: String,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl AgentGatewayHandle {
    pub(crate) fn mcp_environment(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("RHO_AGENT_GATEWAY_ADDR".to_string(), self.address.clone()),
            ("RHO_AGENT_GATEWAY_TOKEN".to_string(), self.token.clone()),
        ])
    }

    pub(crate) async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.task.await;
    }
}

pub(crate) async fn start_agent_gateway(
    app: AppHandle,
    session: Arc<ArkSession>,
    context: Arc<WorkspaceBrokerLane>,
) -> Result<AgentGatewayHandle> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .context("binding the turn-scoped Rho Agent Gateway")?;
    let address = listener.local_addr()?.to_string();
    let token = format!("rho-agent-token-{}", Uuid::new_v4().simple());
    let task_token = token.clone();
    let monitor = OperationMonitor::new(|observation| {
        crate::startup_runtime::write_startup_log(&format!(
            "agent_operation_observed operation_id={} capability_id={} effect_class={:?} argument_bytes={}",
            observation.operation_id.as_str(),
            observation.capability_id.as_str(),
            observation.effect_class,
            observation.argument_bytes,
        ));
    });
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _peer)) = accepted else { break };
                    let _ = handle_connection(
                        stream,
                        &task_token,
                        session.as_ref(),
                        context.as_ref(),
                        &monitor,
                        &app,
                    ).await;
                }
            }
        }
    });
    Ok(AgentGatewayHandle {
        address,
        token,
        shutdown: Some(shutdown_tx),
        task,
    })
}

async fn handle_connection(
    stream: TcpStream,
    token: &str,
    session: &ArkSession,
    context: &WorkspaceBrokerLane,
    monitor: &OperationMonitor,
    app: &AppHandle,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let bytes = tokio::time::timeout(Duration::from_secs(30), read_bounded_line(&mut reader))
        .await
        .context("Agent Gateway request timed out")??;
    let response = match serde_json::from_slice::<AgentGatewayRequest>(&bytes) {
        Ok(request) if request.token == token => {
            match execute(request, session, context, monitor, app).await {
                Ok(result) => AgentGatewayResponse {
                    ok: true,
                    result: Some(result),
                    error: None,
                },
                Err(error) => AgentGatewayResponse {
                    ok: false,
                    result: None,
                    error: Some(error.to_string()),
                },
            }
        }
        Ok(_) => AgentGatewayResponse {
            ok: false,
            result: None,
            error: Some("Agent Gateway token is invalid".to_string()),
        },
        Err(_) => AgentGatewayResponse {
            ok: false,
            result: None,
            error: Some("Agent Gateway request is malformed".to_string()),
        },
    };
    let encoded = serde_json::to_vec(&response)?;
    ensure!(
        encoded.len() <= MAX_GATEWAY_MESSAGE_BYTES,
        "Agent Gateway response exceeds its byte bound"
    );
    writer.write_all(&encoded).await?;
    writer.write_all(b"\n").await?;
    writer.shutdown().await?;
    Ok(())
}

async fn read_bounded_line(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            break;
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        ensure!(
            output.len().saturating_add(consumed) <= MAX_GATEWAY_MESSAGE_BYTES,
            "Agent Gateway request exceeds its byte bound"
        );
        output.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if output.last() == Some(&b'\n') {
            output.pop();
            break;
        }
    }
    ensure!(!output.is_empty(), "Agent Gateway request is empty");
    Ok(output)
}

fn workspace_request(
    registry: &CapabilityRegistry,
    capability_id: &str,
    arguments: Value,
) -> Result<(&'static str, Value)> {
    let capability = CapabilityId::new(capability_id.to_string())?;
    registry.validate_arguments(&capability, &arguments)?;
    match capability_id {
        "workspace.inspect" => Ok(("workspace.snapshot", json!({}))),
        "workspace.inspect_object" => Ok((
            "workspace.inspect_object",
            json!({
                "name": arguments.get("object").cloned().unwrap_or(Value::Null)
            }),
        )),
        rho_protocol::RUN_R_CAPABILITY => Ok(("workspace.execute", arguments)),
        _ => bail!("Rho capability is registered but not connected to the live Agent Gateway"),
    }
}

async fn execute(
    request: AgentGatewayRequest,
    session: &ArkSession,
    context: &WorkspaceBrokerLane,
    monitor: &OperationMonitor,
    app: &AppHandle,
) -> Result<Value> {
    let capability_id = CapabilityId::new(request.capability_id.clone())?;
    let registry = CapabilityRegistry::canonical()?;
    registry.validate_arguments(&capability_id, &request.arguments)?;
    let registered = registry.descriptor(&capability_id)?;
    monitor.observe(
        OperationId::new(format!("agent_gateway_{}", Uuid::new_v4().simple()))?,
        capability_id.clone(),
        registered.descriptor.effect_class,
        registered.destinations.clone(),
        &request.arguments,
    );
    let state = app.state::<crate::AppState>();
    match request.capability_id.as_str() {
        rho_protocol::ENVIRONMENT_INSPECT_CAPABILITY => {
            return serde_json::to_value(
                crate::commands::environment::environment_health_for_state(&state)
                    .await
                    .map_err(anyhow::Error::msg)?,
            )
            .map_err(Into::into);
        }
        rho_protocol::ENVIRONMENT_OPERATION_INSPECT_CAPABILITY => {
            let operation_id = request.arguments["operation_id"]
                .as_str()
                .context("environment.operation.inspect requires operation_id")?;
            let root = state.project_root.read().await.clone();
            let project_root = rho_store::normalize_project_root(root.to_string_lossy().as_ref());
            return serde_json::to_value(
                crate::application_state::store_executor(&state)
                    .await?
                    .environment_repository()
                    .operation(project_root, operation_id.to_string())
                    .await?,
            )
            .map_err(Into::into);
        }
        rho_protocol::ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY => {
            let incident_id = request.arguments["incident_id"]
                .as_str()
                .context("environment.explain_incident requires incident_id")?;
            let root = state.project_root.read().await.clone();
            let project_root = rho_store::normalize_project_root(root.to_string_lossy().as_ref());
            let incident = crate::application_state::store_executor(&state)
                .await?
                .environment_repository()
                .list_incidents(project_root, true, 200)
                .await?
                .into_iter()
                .find(|record| record.incident.incident_id == incident_id);
            return serde_json::to_value(incident).map_err(Into::into);
        }
        _ => {}
    }
    let (request_type, arguments) =
        workspace_request(&registry, &request.capability_id, request.arguments)?;
    let mut workspace = context.lock().await;
    let identity = workspace.broker.identity().clone();
    let executor = workspace.executor.clone();
    dispatch_workspace_request(
        request_type,
        &json!({
            "arguments": arguments,
            "expected_workspace": {
                "kernel_instance_id": identity.kernel_instance_id,
                "state_revision": identity.state_revision,
                "project_revision": identity.project_revision,
            }
        }),
        ExecutionOrigin::Agent,
        session,
        &mut workspace.broker,
        &executor,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_maps_registered_workspace_capabilities_without_policy_decisions() {
        let registry = CapabilityRegistry::canonical().unwrap();
        assert_eq!(
            workspace_request(
                &registry,
                "workspace.inspect",
                json!({"query": "everything"}),
            )
            .unwrap()
            .0,
            "workspace.snapshot"
        );
        assert_eq!(
            workspace_request(
                &registry,
                rho_protocol::RUN_R_CAPABILITY,
                json!({"code": "x <- 1"}),
            )
            .unwrap()
            .0,
            "workspace.execute"
        );
        assert!(workspace_request(&registry, "workspace.run_r", json!({"code": ""})).is_err());
        assert!(workspace_request(&registry, "artifact.commit", json!({})).is_err());
    }
}
