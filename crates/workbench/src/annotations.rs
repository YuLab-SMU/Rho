use super::{AppState, component_agents::application_failure, failure};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use rho_contract::*;
use rho_host::{ApplicationError, NextHost};

fn caller(headers: &HeaderMap, window: &ApplicationWindowRef) -> Result<CallContext, ApplicationError> {
    if headers.get("x-rho-studio-window").and_then(|value| value.to_str().ok()) != Some(window.window_id.as_str()) {
        return Err(ApplicationError::InvalidBridge);
    }
    let mut context = NextHost::local_context();
    context.connection_id = format!("studio:{}", window.window_id);
    Ok(context)
}

pub(super) async fn query(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<AnnotationsQuery>) -> Response {
    let context = match caller(&headers, &request.window) {
        Ok(context) => context,
        Err(error) => return application_failure(error, None, Some(ComponentSubmissionState::Rejected)),
    };
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return application_failure(ApplicationError::NotFound, None, Some(ComponentSubmissionState::Rejected));
    };
    match state.annotations.query(&selected.host, &context, request).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => application_failure(error, None, Some(ComponentSubmissionState::Rejected)),
    }
}

pub(super) async fn command(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<AnnotationsCommand>) -> Response {
    let context = match caller(&headers, &request.window) {
        Ok(context) => context,
        Err(error) => return application_failure(error, Some(request.request_id), Some(ComponentSubmissionState::Rejected)),
    };
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return application_failure(ApplicationError::NotFound, Some(request.request_id), Some(ComponentSubmissionState::Rejected));
    };
    match state.annotations.command(&selected.host, &context, &request).await {
        Ok(receipt) => Json(receipt).into_response(),
        Err(error) => {
            let proof = state.annotations.query(&selected.host, &context, AnnotationsQuery {
                project_root: request.project_root.clone(),
                window: request.window.clone(),
                query: AnnotationQuery::CommandStatus { request_id: request.request_id.clone() },
            }).await;
            let submission = match proof {
                Ok(AnnotationQueryResult::CommandStatus { receipt: Some(_) }) => ComponentSubmissionState::Accepted,
                Ok(AnnotationQueryResult::CommandStatus { receipt: None }) => ComponentSubmissionState::Rejected,
                _ => ComponentSubmissionState::Unknown,
            };
            application_failure(error, Some(request.request_id), Some(submission))
        }
    }
}

pub(super) async fn capture(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<ReadAnnotationCapture>) -> Response {
    let context = match caller(&headers, &request.window) {
        Ok(context) => context,
        Err(error) => return application_failure(error, None, None),
    };
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return application_failure(ApplicationError::NotFound, None, None);
    };
    match state.annotations.capture_bytes(&selected.host, &context, &request) {
        Ok((capture, bytes)) => {
            let content_type = match capture.mime_type.as_str() {
                "image/png" => "image/png",
                "image/jpeg" => "image/jpeg",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(error) => application_failure(error, None, None),
    }
}

pub(super) async fn html_token(State(state): State<AppState>, Json(request): Json<HtmlViewTokenRequest>) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    if selected.root.to_str() != Some(request.project_root.as_str()) {
        return failure(StatusCode::CONFLICT, "Project changed");
    }
    match state.html_views.mint(&selected.host, &NextHost::local_context(), &request.project_root, &request.reference).await {
        Ok(token) => Json(token).into_response(),
        Err(error) => failure(StatusCode::CONFLICT, error.to_string()),
    }
}

/// Serves one retained HTML artifact inside its own isolation policy. The bearer
/// is not required: the token is the capability and it expires on its own.
pub(super) async fn html_view(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return (StatusCode::NOT_FOUND, "Unknown view").into_response();
    }
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return (StatusCode::NOT_FOUND, "Unknown view").into_response();
    };
    let project = selected.root.to_string_lossy().into_owned();
    let Some(reference) = state.html_views.resolve(&project, &token) else {
        return (StatusCode::NOT_FOUND, "This view expired; open it again from the Viewer").into_response();
    };
    match selected.host.verified_output(&NextHost::local_context(), &reference).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                ("content-security-policy".parse::<header::HeaderName>().unwrap(),
                    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'".to_string()),
            ],
            bytes.to_vec(),
        ).into_response(),
        Err(error) => (StatusCode::CONFLICT, error.to_string()).into_response(),
    }
}
