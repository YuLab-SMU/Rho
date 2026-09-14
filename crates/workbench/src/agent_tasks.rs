//! Thin authenticated edge. Task identity, persistence and native execution stay
//! with the Host's task service and the Application/native owners.
use super::{AppState, failure};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use rho_contract::{AgentTasksCommand, AgentTasksQuery, ReadAgentAsset, TestAgent};
use rho_host::NextHost;

pub(super) async fn query(
    State(state): State<AppState>,
    Json(request): Json<AgentTasksQuery>,
) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    if selected.root.to_str() != Some(&request.project_root) {
        return failure(StatusCode::CONFLICT, "Project changed");
    }
    if let rho_contract::AgentTaskQuery::ProjectList { archived, before, limit } = &request.query {
        return match state.task_agents.project_task_page(&selected.host, &NextHost::local_context(), &request.project_root, *archived, before.as_deref(), *limit, &state.component_agents).await {
            Ok(page) => Json(rho_contract::AgentTaskQueryResult::ProjectList { page }).into_response(),
            Err(error) => failure(StatusCode::CONFLICT, error.to_string()),
        };
    }
    match state
        .task_agents
        .query(&selected.host, &NextHost::local_context(), request)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(e) => failure(StatusCode::CONFLICT, e.to_string()),
    }
}
pub(super) async fn command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<AgentTasksCommand>,
) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    if selected.root.to_str() != Some(&request.project_root) {
        return failure(StatusCode::CONFLICT, "Project changed");
    }
    if headers
        .get("x-rho-studio-window")
        .and_then(|h| h.to_str().ok())
        != Some(&request.window.window_id)
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Task command belongs to another Studio window",
        );
    }
    match state
        .task_agents
        .command(
            selected.host.clone(),
            NextHost::local_context(),
            request,
            format!("{}/mcp", state.origin),
            state
                .native_mcp_authorization
                .trim_start_matches("Bearer ")
                .into(),
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(e) => failure(StatusCode::CONFLICT, e.to_string()),
    }
}
pub(super) async fn test(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<TestAgent>,
) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    if selected.root.to_str() != Some(&request.project_root) {
        return failure(StatusCode::CONFLICT, "Project changed");
    }
    if headers
        .get("x-rho-studio-window")
        .and_then(|h| h.to_str().ok())
        != Some(&request.window.window_id)
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Diagnostic belongs to another Studio window",
        );
    }
    match state
        .task_agents
        .test(
            &selected.host,
            request,
            format!("{}/mcp", state.origin),
            state
                .native_mcp_authorization
                .trim_start_matches("Bearer ")
                .into(),
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(e) => failure(StatusCode::CONFLICT, e.to_string()),
    }
}
pub(super) async fn asset(
    State(state): State<AppState>,
    Json(request): Json<ReadAgentAsset>,
) -> Response {
    let hosting = state.hosting.read().await;
    if hosting.selected.as_ref().and_then(|s| s.root.to_str()) != Some(&request.project_root) {
        return failure(StatusCode::CONFLICT, "Project changed");
    }
    match state.task_agents.asset(
        &NextHost::local_context(),
        &request.project_root,
        &request.task_id,
        &request.asset_id,
    ) {
        Ok((asset, data)) => {
            let content_type = match asset.mime_type.as_str() {
                "image/png" => "image/png",
                "image/jpeg" => "image/jpeg",
                "image/webp" => "image/webp",
                "image/gif" => "image/gif",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, content_type)], data).into_response()
        }
        Err(e) => failure(StatusCode::NOT_FOUND, e.to_string()),
    }
}
