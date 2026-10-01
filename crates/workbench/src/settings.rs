//! Generic application fragments, scoped by selected project and CAS version.
use super::*;
use rho_contract::{ReadApplicationState, WriteApplicationState};

async fn state_scope(state: &AppState, project: Option<&str>) -> Result<String, String> {
    if let Some(project) = project {
        let hosting = state.hosting.read().await;
        if hosting.selected.as_ref().and_then(|s| s.root.to_str()) != Some(project) {
            return Err("project changed; draft was not written".into());
        }
        Ok(format!("project:{project}"))
    } else {
        Ok("user".into())
    }
}
pub(super) async fn read_state(
    State(state): State<AppState>,
    Json(request): Json<ReadApplicationState>,
) -> Response {
    if request.key.starts_with("hosting.") {
        return failure(StatusCode::BAD_REQUEST, "use the runtime owner queries");
    }
    match state_scope(&state, request.project_root.as_deref())
        .await
        .and_then(|scope| state.application.read(&scope, &request.key))
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error),
    }
}
pub(super) async fn write_state(
    State(state): State<AppState>,
    Json(request): Json<WriteApplicationState>,
) -> Response {
    if request.state.key.starts_with("hosting.") {
        return failure(StatusCode::BAD_REQUEST, "use the runtime owner commands");
    }
    if request.project_root.is_none() && request.state.key == "runtime" {
        return failure(
            StatusCode::BAD_REQUEST,
            "Configure a runtime through its plugin; this reserved key is not writable",
        );
    }
    match state_scope(&state, request.project_root.as_deref())
        .await
        .and_then(|scope| state.application.write(&scope, &request.state))
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error),
    }
}
