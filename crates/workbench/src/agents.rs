//! Authenticated hosting adapter to external Agent clients. Scientific work still
//! returns through the existing MCP/Host ports and original domain owners.
use super::{AppState, failure};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rho_contract::{
    AgentAction, AgentClientAction, ApplicationWindowRef, ConnectAgent, DiscoverAgent, HostRequest,
    QueryRequest,
};
use rho_host::{ExternalAgentClient, NextHost};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, Notify, OnceCell};

const MAX_ACTIVE_CONNECTIONS: usize = 8;
const MAX_CONNECTION_ATTEMPTS: usize = 128;

pub(super) struct AgentClients {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    probes: tokio::sync::Semaphore,
    closed: AtomicBool,
}
impl Default for AgentClients {
    fn default() -> Self {
        Self {
            slots: Mutex::default(),
            probes: tokio::sync::Semaphore::new(2),
            closed: AtomicBool::new(false),
        }
    }
}
struct Slot {
    signature: String,
    result: OnceCell<Result<Arc<ExternalAgentClient>, String>>,
    ready: Notify,
}
impl Slot {
    fn begin(
        self: &Arc<Self>,
        clients: Arc<AgentClients>,
        task: impl std::future::Future<Output = Result<Arc<ExternalAgentClient>, String>>
        + Send
        + 'static,
    ) {
        let slot = self.clone();
        // Setup belongs to this admitted Host request, not to the lifetime
        // of an HTTP response. A lost acknowledgement reuses the same slot.
        tokio::spawn(async move {
            let result = task.await;
            // Serialize publication with shutdown, including a connection
            // that completes after the user has closed this Host.
            let slots = clients.slots.lock().await;
            let late_client = if clients.closed.load(Ordering::Acquire) {
                result.as_ref().ok().cloned()
            } else {
                None
            };
            let _ = slot.result.set(result);
            slot.ready.notify_waiters();
            drop(slots);
            if let Some(client) = late_client {
                client.close().await;
            }
        });
    }
    fn active(&self) -> bool {
        match self.result.get() {
            None => true,
            Some(Ok(client)) => client.snapshot().state != "disconnected",
            Some(Err(_)) => false,
        }
    }
    async fn wait(&self) -> &Result<Arc<ExternalAgentClient>, String> {
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if let Some(result) = self.result.get() {
                return result;
            }
            ready.await;
        }
    }
}
impl AgentClients {
    pub async fn has_live(&self) -> bool {
        self.slots.lock().await.values().any(|slot| slot.active())
    }
    pub async fn close(&self) {
        let slots = self.slots.lock().await;
        self.closed.store(true, Ordering::Release);
        let clients: Vec<_> = slots
            .values()
            .filter_map(|slot| slot.result.get().and_then(|r| r.as_ref().ok()).cloned())
            .collect();
        drop(slots);
        for client in clients {
            client.close().await;
        }
    }
}
fn window_header(headers: &HeaderMap, window: &ApplicationWindowRef) -> Result<(), String> {
    if headers
        .get("x-rho-studio-window")
        .and_then(|h| h.to_str().ok())
        != Some(&window.window_id)
    {
        return Err("Agent request belongs to another Studio window".into());
    }
    Ok(())
}
async fn validate_window(host: &NextHost, window: &ApplicationWindowRef) -> Result<(), String> {
    let value = host
        .dispatch(
            &NextHost::local_context(),
            HostRequest::QuerySnapshot(QueryRequest {
                capability: rho_contract::CapabilityRef {
                    id: "application.context".into(),
                    version: 1,
                },
                arguments: json!({"window":window,"limit":1}),
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    if value["status"] != "ready" || value["data"]["source"] != "live_bridge" {
        return Err("This Studio window is not synchronized; retry when it is online".into());
    }
    Ok(())
}
pub(super) async fn discover(
    State(state): State<AppState>,
    Json(request): Json<DiscoverAgent>,
) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    if selected.root.to_str() != Some(&request.project_root) {
        return failure(StatusCode::CONFLICT, "Project changed");
    }
    let Ok(_permit) = selected.agents.probes.try_acquire() else {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Agent discovery is busy; try again shortly",
        );
    };
    let result =
        rho_host::discover_agent(request.provider, &selected.root, request.model.as_deref()).await;
    Json(result).into_response()
}
pub(super) async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ConnectAgent>,
) -> Response {
    if uuid::Uuid::parse_str(&request.request_id).is_err() {
        return failure(StatusCode::BAD_REQUEST, "Invalid Agent request identity");
    }
    if let Err(e) = window_header(&headers, &request.window) {
        return failure(StatusCode::FORBIDDEN, e);
    }
    let (host, root, clients) = {
        let hosting = state.hosting.read().await;
        let Some(selected) = &hosting.selected else {
            return failure(StatusCode::CONFLICT, "Select a project first");
        };
        if selected.root.to_str() != Some(&request.project_root) {
            return failure(StatusCode::CONFLICT, "Project changed");
        }
        (
            selected.host.clone(),
            selected.root.clone(),
            selected.agents.clone(),
        )
    };
    if let Err(e) = validate_window(&host, &request.window).await {
        return failure(StatusCode::CONFLICT, e);
    }
    let signature = json!([
        request.provider,
        request.model,
        request.effort,
        request.window
    ])
    .to_string();
    let slot = {
        let mut slots = clients.slots.lock().await;
        if clients.closed.load(Ordering::Acquire) {
            return failure(StatusCode::CONFLICT, "This Host is closing");
        }
        if let Some(slot) = slots.get(&request.request_id) {
            if slot.signature != signature {
                return failure(
                    StatusCode::CONFLICT,
                    "Connection request identity reused with different input",
                );
            }
            slot.clone()
        } else {
            if slots.values().filter(|slot| slot.active()).count() >= MAX_ACTIVE_CONNECTIONS {
                return failure(
                    StatusCode::TOO_MANY_REQUESTS,
                    "This Host already has eight active Agent connections; disconnect one first",
                );
            }
            if slots.len() >= MAX_CONNECTION_ATTEMPTS {
                return failure(
                    StatusCode::TOO_MANY_REQUESTS,
                    "This Host has reached its retained Agent connection attempt budget",
                );
            }
            let slot = Arc::new(Slot {
                signature,
                result: OnceCell::new(),
                ready: Notify::new(),
            });
            slots.insert(request.request_id.clone(), slot.clone());
            slot.begin(clients.clone(), async move {
                let _host = host;
                let token = state
                    .authorization
                    .strip_prefix("Bearer ")
                    .ok_or("Missing local connection credential")?;
                ExternalAgentClient::connect(
                    request.provider,
                    &root,
                    request.window,
                    &request.model,
                    request.effort.as_deref(),
                    &format!("{}/mcp", state.origin),
                    token,
                )
                .await
            });
            slot
        }
    };
    let result = slot.wait().await;
    match result {
        Ok(client) => Json(client.snapshot()).into_response(),
        Err(error) => failure(StatusCode::BAD_GATEWAY, error.clone()),
    }
}
pub(super) async fn sessions(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return Json(json!([])).into_response();
    };
    let window = headers
        .get("x-rho-studio-window")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let rows: Vec<_> = selected
        .agents
        .slots
        .lock()
        .await
        .values()
        .filter_map(|slot| slot.result.get().and_then(|r| r.as_ref().ok()))
        .map(|c| c.snapshot())
        .filter(|s| s.window.window_id == window)
        .collect();
    Json(rows).into_response()
}
pub(super) async fn action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AgentClientAction>,
) -> Response {
    if let Err(e) = window_header(&headers, &request.window) {
        return failure(StatusCode::FORBIDDEN, e);
    }
    let (host, client) = {
        let hosting = state.hosting.read().await;
        let Some(selected) = &hosting.selected else {
            return failure(StatusCode::CONFLICT, "Select a project first");
        };
        if selected.root.to_str() != Some(&request.project_root) {
            return failure(StatusCode::CONFLICT, "Project changed");
        }
        let client = selected
            .agents
            .slots
            .lock()
            .await
            .values()
            .filter_map(|slot| slot.result.get().and_then(|r| r.as_ref().ok()))
            .find(|c| c.snapshot().id == request.session_id)
            .cloned();
        (selected.host.clone(), client)
    };
    let Some(client) = client else {
        return failure(StatusCode::NOT_FOUND, "Agent connection not found");
    };
    if client.snapshot().window.window_id != request.window.window_id {
        return failure(
            StatusCode::FORBIDDEN,
            "Agent connection belongs to another window",
        );
    }
    let result: Result<Value, String> = async {
        match request.action {
            AgentAction::Read => {}
            AgentAction::Prompt { text, request_id } => {
                validate_window(&host, &request.window).await?;
                client
                    .prompt(&text, false, &request_id, request.window)
                    .await?;
            }
            AgentAction::Test { request_id } => {
                validate_window(&host, &request.window).await?;
                client.prompt("", true, &request_id, request.window).await?;
            }
            AgentAction::Interrupt => client.interrupt().await?,
            AgentAction::Decision { id, option } => client.decide(id, &option).await?,
            AgentAction::Disconnect => client.close().await,
        }
        serde_json::to_value(client.snapshot()).map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(e) => failure(StatusCode::CONFLICT, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn slot() -> Arc<Slot> {
        Arc::new(Slot {
            signature: "fixture".into(),
            result: OnceCell::new(),
            ready: Notify::new(),
        })
    }

    #[tokio::test]
    async fn lost_http_wait_does_not_cancel_admitted_setup_or_lose_its_result() {
        let clients = Arc::new(AgentClients::default());
        let slot = slot();
        let (release, ready) = tokio::sync::oneshot::channel::<()>();
        slot.begin(clients, async move {
            ready.await.unwrap();
            Err("fixture setup result".into())
        });
        let first = slot.clone();
        let waiter = tokio::spawn(async move { first.wait().await.as_ref().err().cloned() });
        waiter.abort();
        release.send(()).unwrap();
        let (a, b) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(slot.wait(), slot.wait())
        })
        .await
        .unwrap();
        assert_eq!(
            a.as_ref().err().map(String::as_str),
            Some("fixture setup result")
        );
        assert_eq!(
            b.as_ref().err().map(String::as_str),
            Some("fixture setup result")
        );
        assert!(!slot.active());
    }

    #[tokio::test]
    async fn failed_connection_history_does_not_consume_active_connection_capacity() {
        let clients = AgentClients::default();
        let mut slots = clients.slots.lock().await;
        for i in 0..12 {
            let slot = slot();
            assert!(slot.result.set(Err("fixture unavailable".into())).is_ok());
            slots.insert(i.to_string(), slot);
        }
        assert_eq!(slots.values().filter(|s| s.active()).count(), 0);
        slots.insert("pending".into(), slot());
        assert_eq!(slots.values().filter(|s| s.active()).count(), 1);
        drop(slots);
        assert!(clients.has_live().await);
    }
}
