//! Configuration discovery and explicit component installation only.
use super::{AppState, failure};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rho_contract::{AgentProvider, DiscoverAgent, SetupAgent};

pub(super) struct AgentClients {
    probes: tokio::sync::Semaphore,
}
impl Default for AgentClients {
    fn default() -> Self {
        Self {
            probes: tokio::sync::Semaphore::new(2),
        }
    }
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
    let Ok(_connection) = state.task_agents.reserve_connection() else {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Eight Agent connections are active; disconnect an idle task first",
        );
    };
    let result =
        rho_host::discover_agent(request.provider, &selected.root, request.model.as_deref()).await;
    state
        .task_agents
        .remember_catalog(request.project_root.clone(), result.clone());
    Json(result).into_response()
}
pub(super) async fn setup(
    State(state): State<AppState>,
    Json(request): Json<SetupAgent>,
) -> Response {
    if request.provider != AgentProvider::Deepseek {
        return failure(
            StatusCode::BAD_REQUEST,
            "This Agent has no Rho-managed connection component",
        );
    }
    let (host, root) = {
        let hosting = state.hosting.read().await;
        let Some(selected) = &hosting.selected else {
            return failure(StatusCode::CONFLICT, "Select a project first");
        };
        if selected.root.to_str() != Some(&request.project_root) {
            return failure(StatusCode::CONFLICT, "Project changed");
        }
        (selected.host.clone(), selected.root.clone())
    };
    // Explicit setup owns its work even if an HTTP acknowledgement is lost.
    // The installer is idempotent and serializes concurrent setup requests.
    let result = tokio::spawn(async move {
        let _host = host;
        rho_host::install_deepseek_component().await?;
        Ok::<_, String>(rho_host::discover_agent(AgentProvider::Deepseek, &root, None).await)
    })
    .await;
    match result {
        Ok(Ok(agent)) => Json(agent).into_response(),
        Ok(Err(error)) => failure(StatusCode::BAD_GATEWAY, error),
        Err(_) => failure(
            StatusCode::BAD_GATEWAY,
            "Connection setup could not complete",
        ),
    }
}
