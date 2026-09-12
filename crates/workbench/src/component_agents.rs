//! Authenticated application routes; no engine or scientific dispatch logic.
use super::{AppState, failure};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rho_contract::*;
use rho_host::NextHost;
use serde_json::json;

fn owns_window(headers: &HeaderMap, window: &ApplicationWindowRef) -> bool {
    headers
        .get("x-rho-studio-window")
        .and_then(|h| h.to_str().ok())
        == Some(&window.window_id)
}
pub(super) async fn query(
    State(state): State<AppState>,
    Json(request): Json<ComponentAgentsQuery>,
) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    let host = &selected.host;
    let context = NextHost::local_context();
    let project = &request.project_root;
    let service = &state.component_agents;
    let result = match request.query {
        ComponentAgentQuery::Settings => service
            .settings(host, &context, project)
            .map(|v| json!({"settings":v})),
        ComponentAgentQuery::Conversations { after, limit } => service
            .conversations(host, &context, project, after.as_deref(), limit as usize)
            .map(|v| json!({"conversations":v})),
        ComponentAgentQuery::Conversation { conversation_id } => service
            .conversation(host, &context, project, &conversation_id)
            .map(|v| json!({"conversation":v})),
        ComponentAgentQuery::Run { run_id } => service
            .run(host, &context, project, &run_id)
            .map(|v| json!({"run":v})),
        ComponentAgentQuery::Request { request_id } => service
            .run_by_request(host, &context, project, &request_id)
            .map(|v| json!({"run":v})),
        ComponentAgentQuery::Tools { run_id } => service
            .tools(host, &context, project, &run_id)
            .map(|v| json!({"tools":v})),
        ComponentAgentQuery::Events {
            run_id,
            after,
            limit,
        } => service
            .events(host, &context, project, &run_id, after, limit as usize)
            .map(|v| json!({"page":v})),
    };
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error.to_string()),
    }
}
pub(super) async fn command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComponentAgentsCommand>,
) -> Response {
    if !owns_window(&headers, &request.window) {
        return failure(
            StatusCode::FORBIDDEN,
            "Component command belongs to another Studio window",
        );
    }
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    let host = &selected.host;
    let context = NextHost::local_context();
    let project = &request.project_root;
    let window = &request.window;
    let service = &state.component_agents;
    let result = match request.command {
        ComponentAgentCommand::Create {
            conversation_id,
            profile,
        } => service
            .create(host, &context, project, window, &conversation_id, profile)
            .map(|v| json!({"conversation":v})),
        ComponentAgentCommand::SaveDraft { draft } => {
            let id = draft.conversation_id.clone();
            service
                .save_draft(host, &context, project, window, draft)
                .and_then(|_| service.conversation(host, &context, project, &id))
                .map(|v| json!({"conversation":v}))
        }
        ComponentAgentCommand::Start { request: start } => {
            if start.window != *window {
                return failure(
                    StatusCode::FORBIDDEN,
                    "Run window does not match command window",
                );
            }
            service
                .start(host.clone(), context, project, start)
                .await
                .map(|v| json!({"run":v}))
        }
        ComponentAgentCommand::Stop { run_id } => service
            .stop(host, &context, project, window, &run_id)
            .await
            .map(|v| json!({"run":v})),
        ComponentAgentCommand::Configure { settings } => service
            .configure(host, &context, project, window, &settings)
            .await
            .map(|v| json!({"settings":v})),
    };
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error.to_string()),
    }
}
pub(super) async fn credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComponentSessionCredential>,
) -> Response {
    if !owns_window(&headers, &request.window) {
        return failure(
            StatusCode::FORBIDDEN,
            "Credential belongs to another Studio window",
        );
    }
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    match state.component_agents.put_session_key(
        &selected.host,
        &NextHost::local_context(),
        &request.project_root,
        &request.window,
        request.key,
    ) {
        Ok(reference) => Json(json!({"credential":reference})).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error.to_string()),
    }
}
