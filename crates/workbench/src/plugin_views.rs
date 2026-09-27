use super::*;
use axum::extract::Path as RoutePath;
use rho_plugin_protocol::PluginViewMessage;

pub(crate) async fn asset(
    State(state): State<AppState>,
    RoutePath((connection, token, path)): RoutePath<(String, String, String)>,
) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "select a project first");
    };
    asset_response(&selected.host, &connection, &token, &path)
}

pub(crate) async fn test_asset(
    State(state): State<AppState>,
    RoutePath((test_project, connection, token, path)): RoutePath<(String, String, String, String)>,
) -> Response {
    let id = match rho_contract::TestProjectId::new(test_project) {
        Ok(id) => id,
        Err(_) => return failure(StatusCode::NOT_FOUND,"Test view is unavailable"),
    };
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT,"select a project first");
    };
    let host = match selected.host.plugin_test_host(&NextHost::local_context(),&id) {
        Ok(host) => host,
        Err(error) => return failure(StatusCode::NOT_FOUND,error.to_string()),
    };
    asset_response(&host,&connection,&token,&path)
}

fn asset_response(host: &NextHost, connection: &str, token: &str, path: &str) -> Response {
    match host.plugin_view_asset(connection, token, path) {
        Ok(asset) => {
            let mut response =
                ([(header::CONTENT_TYPE, asset.media_type)], asset.bytes).into_response();
            let headers = response.headers_mut();
            // Also sandbox direct navigation. Opaque-origin modules may read only
            // this already-scoped asset route; API routes never admit null Origin.
            headers.insert("content-security-policy","sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'".parse().unwrap());
            headers.insert("access-control-allow-origin", "*".parse().unwrap());
            response
        }
        Err(error) => failure(StatusCode::NOT_FOUND, error.to_string()),
    }
}
pub(crate) async fn dispatch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(value): Json<serde_json::Value>,
) -> Response {
    // The containing shell supplies both its existing local authority and the
    // scoped view token. The iframe receives neither of these credentials.
    let Some(token) = value.get("call_token").and_then(|v| v.as_str()) else {
        return failure(StatusCode::BAD_REQUEST, "view token required");
    };
    let Some(project) = value.get("project_root").and_then(|v| v.as_str()) else {
        return failure(StatusCode::BAD_REQUEST, "project root required");
    };
    let Some(window) = headers
        .get("x-rho-studio-window")
        .and_then(|v| v.to_str().ok())
    else {
        return failure(StatusCode::BAD_REQUEST, "window identity required");
    };
    let message = match serde_json::from_value::<PluginViewMessage>(
        value.get("message").cloned().unwrap_or_default(),
    ) {
        Ok(message) => message,
        Err(error) => return failure(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let id = message.request.to_string();
    let _permit = match state.calls.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return failure(StatusCode::TOO_MANY_REQUESTS, "too many active calls"),
    };
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "select a project first");
    };
    if selected.root.to_str() != Some(project) {
        return failure(StatusCode::CONFLICT, "project changed");
    }
    let test_project: Option<rho_contract::TestProjectId> = match serde_json::from_value(
        value.get("test_project").cloned().unwrap_or_default(),
    ) {
        Ok(id) => id,
        Err(error) => return failure(StatusCode::BAD_REQUEST,error.to_string()),
    };
    let host = match test_project {
        Some(id) => match selected.host.plugin_test_host(&NextHost::local_context(),&id) {
            Ok(host) => host,
            Err(error) => return failure(StatusCode::CONFLICT,error.to_string()),
        },
        None => selected.host.clone(),
    };
    let result = host
        .dispatch_plugin_view(&NextHost::local_context(), window, token, message)
        .await;
    let reply = match result {
        Ok(result) => SessionReply {
            id: Some(id),
            ok: true,
            result: Some(result),
            error: None,
            diagnostic: None,
        },
        Err(error) => SessionReply {
            id: Some(id),
            ok: false,
            result: None,
            error: Some(error.to_string()),
            diagnostic: Some(error.diagnostic()),
        },
    };
    match serde_json::to_vec(&reply) {
        Ok(bytes) if bytes.len() <= MAX_REPLY => {
            ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
        }
        _ => failure(
            StatusCode::PAYLOAD_TOO_LARGE,
            "view reply exceeds transport quota",
        ),
    }
}
