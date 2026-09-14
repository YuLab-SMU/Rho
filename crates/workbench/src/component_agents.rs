//! Authenticated application routes; no engine or scientific dispatch logic.
use super::AppState;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rho_contract::*;
use rho_host::ApplicationError;
use rho_host::NextHost;
use serde_json::json;

fn failure(status: StatusCode, message: impl Into<String>) -> Response {
    let message = message.into();
    let (code, continuation) = if status == StatusCode::FORBIDDEN {
        (DiagnosticCode::AccessDenied, DiagnosticContinuation::None)
    } else if status == StatusCode::CONFLICT {
        (DiagnosticCode::Unavailable, DiagnosticContinuation::ReadAgain)
    } else {
        (DiagnosticCode::InvalidInput, DiagnosticContinuation::CorrectInput)
    };
    (status, Json(ComponentRequestFailure {
        error: message.clone(), diagnostic: Diagnostic { code, message, continuation, next_reads: vec![] },
        submission: ComponentSubmissionState::Rejected, request_id: None, existing_request_id: None,
    })).into_response()
}

pub(super) fn application_failure(
    error: ApplicationError,
    request_id: Option<String>,
    submission: Option<ComponentSubmissionState>,
) -> Response {
    let diagnostic = error.diagnostic();
    let status = match diagnostic.code {
        DiagnosticCode::InvalidInput => StatusCode::UNPROCESSABLE_ENTITY,
        DiagnosticCode::AccessDenied => StatusCode::FORBIDDEN,
        DiagnosticCode::NotFound => StatusCode::NOT_FOUND,
        DiagnosticCode::Busy | DiagnosticCode::BudgetExceeded => StatusCode::TOO_MANY_REQUESTS,
        DiagnosticCode::OutcomeUncertain => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::CONFLICT,
    };
    let existing_request_id = match &error {
        ApplicationError::Busy { request_id, .. } => request_id.clone(),
        _ => None,
    };
    let submission = submission.unwrap_or(if diagnostic.code == DiagnosticCode::OutcomeUncertain {
        ComponentSubmissionState::Unknown
    } else {
        ComponentSubmissionState::Rejected
    });
    (status, Json(ComponentRequestFailure {
        error: error.to_string(), diagnostic, submission, request_id, existing_request_id,
    })).into_response()
}

fn owns_window(headers: &HeaderMap, window: &ApplicationWindowRef) -> bool {
    headers
        .get("x-rho-studio-window")
        .and_then(|h| h.to_str().ok())
        == Some(&window.window_id)
}
pub(super) async fn preview_source(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComponentSourcePreviewRequest>,
) -> Response {
    if !owns_window(&headers, &request.window) {
        return failure(
            StatusCode::FORBIDDEN,
            "Source preview belongs to another window",
        );
    }
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    match state
        .component_agents
        .preview_source(&selected.host, &NextHost::local_context(), request)
        .await
    {
        Ok(preview) => Json(preview).into_response(),
        Err(error) => application_failure(error, None, None),
    }
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
        ComponentAgentQuery::Assets { conversation_id } => service.assets(host, &context, project, &conversation_id).map(|assets| json!({"assets":assets})),
        query @ ComponentAgentQuery::Runs { .. } => service
            .run_history(host, &context, ComponentAgentsQuery { project_root: project.clone(), query })
            .await.map(|runs| json!({"runs":runs})),
        ComponentAgentQuery::Diagnostics => service
            .diagnostics(host, &context, project)
            .map(|v| json!({"diagnostics":v})),
        ComponentAgentQuery::Diagnostic { request_id } => service
            .diagnostic(host, &context, project, &request_id)
            .map(|v| json!({"diagnostic":v})),
        ComponentAgentQuery::CredentialStatus => service
            .credential_status(host, &context, project)
            .map(|credential_status| json!({"credential_status":credential_status})),
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
            .observe_run(host, &context, project, &run_id)
            .await
            .map(|v| json!({"run":v})),
        ComponentAgentQuery::Request { request_id } => service
            .observe_request(host, &context, project, &request_id)
            .await
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
        Err(error) => application_failure(error, None, None),
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
    let submission_request = match &request.command {
        ComponentAgentCommand::Start { request } => Some(request.request_id.clone()),
        _ => None,
    };
    let result = match request.command {
        ComponentAgentCommand::AddAsset { conversation_id, asset_id, name, mime_type, data } => service.add_asset(host, &context, project, window, &conversation_id, &asset_id, &name, &mime_type, &data).map(|asset| json!({"asset":asset})),
        ComponentAgentCommand::RemoveAsset { conversation_id, asset_id, draft_version } => service.remove_asset(host, &context, project, window, &conversation_id, &asset_id, draft_version).map(|conversation| json!({"conversation":conversation})),
        ComponentAgentCommand::Decision { run_id, decision_id, allow } => service
            .decide_permission(host, &context, project, window, &run_id, &decision_id, allow)
            .await.map(|v| json!({"run":v})),
        ComponentAgentCommand::Rename { conversation_id, expected_version, title } => service.update_task_metadata(host, &context, project, window, &conversation_id, expected_version, Some(title), None).map(|v| json!({"conversation":v})),
        ComponentAgentCommand::Archive { conversation_id, expected_version, archived } => service.update_task_metadata(host, &context, project, window, &conversation_id, expected_version, None, Some(archived)).map(|v| json!({"conversation":v})),
        ComponentAgentCommand::Reconcile {run_id}=>service.reconcile(host,&context,project,window,&run_id).await.map(|v|json!({"run":v})),
        ComponentAgentCommand::TakeControl {conversation_id,expected_version}=>service.take_control(host,&context,project,window,&conversation_id,expected_version).await.map(|v|json!({"conversation":v})),
        ComponentAgentCommand::StopTest { request_id } => service
            .stop_test(host, &context, project, window, &request_id)
            .await
            .map(|v| json!({"diagnostic":v})),
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
                .start(host.clone(), context.clone(), project, *start)
                .await
                .map(|v| json!({"run":v}))
        }
        ComponentAgentCommand::Stop { run_id } => service
            .stop(host, &context, project, window, &run_id)
            .await
            .map(|v| json!({"run":v})),
        ComponentAgentCommand::RemoveCredential { settings_version, key_id } => service
            .remove_credential(host, &context, project, window, settings_version, &key_id)
            .await
            .map(|credential_status| json!({"credential_status":credential_status})),
        ComponentAgentCommand::Configure { settings } => service
            .configure(host, &context, project, window, &settings)
            .await
            .map(|v| json!({"settings":v})),
    };
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let submission = submission_request.as_ref().map(|id| match service.run_by_request(host, &context, project, id) {
                Ok(Some(_)) => ComponentSubmissionState::Accepted,
                Ok(None) => ComponentSubmissionState::Rejected,
                Err(_) => ComponentSubmissionState::Unknown,
            });
            application_failure(error, submission_request, submission)
        },
    }
}
pub(super) async fn credential(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComponentLocalCredential>,
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
    match state.component_agents.put_local_key(
        &selected.host,
        &NextHost::local_context(),
        &request.project_root,
        &request.window,
        request.key,
    ) {
        Ok(reference) => Json(json!({"credential":reference})).into_response(),
        Err(error) => application_failure(error, None, None),
    }
}

pub(super) async fn search_sources(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComponentSourceSearch>,
) -> Response {
    if !owns_window(&headers, &request.window) {
        return failure(
            StatusCode::FORBIDDEN,
            "Source search belongs to another window",
        );
    }
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    match state
        .component_agents
        .search_sources(&selected.host, &NextHost::local_context(), request)
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => application_failure(error, None, None),
    }
}
pub(super) async fn test_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ComponentModelTestRequest>,
) -> Response {
    if !owns_window(&headers, &request.window) {
        return failure(
            StatusCode::FORBIDDEN,
            "Model test belongs to another window",
        );
    }
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else {
        return failure(StatusCode::CONFLICT, "Select a project first");
    };
    let request_id = request.request_id.clone();
    let project = request.project_root.clone();
    match state
        .component_agents
        .test_model(selected.host.clone(), NextHost::local_context(), request)
        .await
    {
        Ok(result) => Json(json!({"diagnostic":result})).into_response(),
        Err(error) => {
            let submission = match state.component_agents.diagnostic(&selected.host, &NextHost::local_context(), &project, &request_id) {
                Ok(Some(_)) => ComponentSubmissionState::Accepted,
                Ok(None) => ComponentSubmissionState::Rejected,
                Err(_) => ComponentSubmissionState::Unknown,
            };
            application_failure(error, Some(request_id), Some(submission))
        },
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;
    async fn payload(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    #[tokio::test]
    async fn failures_retain_diagnostic_and_original_submission_identity() {
        let result = application_failure(ApplicationError::Conflict, Some("request-one".into()), Some(ComponentSubmissionState::Rejected));
        assert_eq!(result.status(), StatusCode::CONFLICT);
        let body = payload(result).await;
        assert_eq!(body["diagnostic"]["code"], "content_changed");
        assert_eq!(body["diagnostic"]["continuation"], "refresh_observation");
        assert_eq!(body["diagnostic"]["next_reads"], json!([]));
        assert_eq!(body["request_id"], "request-one");
        assert_eq!(body["submission"], "rejected");
        let body = payload(application_failure(ApplicationError::Storage("commit failed".into()), Some("request-one".into()), None)).await;
        assert_eq!(body["diagnostic"]["code"], "outcome_uncertain");
        assert_eq!(body["submission"], "unknown");
        let body = payload(application_failure(ApplicationError::Storage("commit failed".into()), Some("request-one".into()), Some(ComponentSubmissionState::Accepted))).await;
        assert_eq!(body["submission"], "accepted");
    }
    #[tokio::test]
    async fn busy_retains_only_the_owner_verified_diagnostic_reference() {
        let result = application_failure(ApplicationError::Busy { message: "A test is running".into(), request_id: Some("visible-test".into()) }, None, None);
        assert_eq!(result.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(payload(result).await["existing_request_id"], "visible-test");
        let result = application_failure(ApplicationError::Busy { message: "A test is running".into(), request_id: None }, None, None);
        assert!(payload(result).await["existing_request_id"].is_null());
    }
}

/// Only upload requests receive the larger body allowance; ordinary commands stay bounded.
pub(super) async fn asset_upload(state: State<AppState>, headers: HeaderMap, request: Json<ComponentAgentsCommand>) -> Response {
    if !matches!(request.0.command, ComponentAgentCommand::AddAsset { .. }) {
        return failure(StatusCode::BAD_REQUEST, "The upload endpoint accepts attachment uploads only");
    }
    command(state, headers, request).await
}
pub(super) async fn asset(State(state): State<AppState>, Json(request): Json<ReadComponentAgentAsset>) -> Response {
    let hosting = state.hosting.read().await;
    let Some(selected) = &hosting.selected else { return failure(StatusCode::CONFLICT, "Select a project first"); };
    match state.component_agents.asset(&selected.host, &NextHost::local_context(), &request) {
        Ok((asset, bytes)) => ([(axum::http::header::CONTENT_TYPE, asset.mime_type)], bytes).into_response(),
        Err(error) => application_failure(error, None, None),
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::*;
    use axum::{body::{Body, to_bytes}, http::{Request, header}};
    use tower::ServiceExt;
    async fn send(app: &axum::Router, path: &str, value: serde_json::Value) -> Response {
        app.clone().oneshot(Request::builder().method("POST").uri(path)
            .header(header::HOST, "127.0.0.1:10001").header(header::AUTHORIZATION, "Bearer fixture-only")
            .header(header::CONTENT_TYPE, "application/json").header("x-rho-studio-window", "upload-window")
            .body(Body::from(value.to_string())).unwrap()).await.unwrap()
    }
    #[tokio::test]
    async fn bounded_upload_route_accepts_images_above_the_ordinary_body_limit_and_reads_scoped_bytes() {
        let (_directory, state, app) = crate::tests::fixture().await;
        let (host, project) = { let hosting = state.hosting.read().await; let selected = hosting.selected.as_ref().unwrap(); (selected.host.clone(), selected.root.to_string_lossy().into_owned()) };
        let mut context = NextHost::local_context(); context.connection_id = "studio:upload".into();
        let registration = host.dispatch(&context, HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
            window_id: "upload-window".into(), incarnation: "upload-life".into(), label: "Upload test".into(), previous_session: None,
        })).await.unwrap();
        let ApplicationBridgeReply::Registered(registration) = serde_json::from_value(registration).unwrap() else { panic!() };
        let window = registration.session.window;
        state.component_agents.create(&host, &context, &project, &window, "upload-conversation", ComponentAgentProfile::Project).unwrap();
        // A complete tiny PNG with trailing bytes exercises the encoded request limit;
        // it is never sent to a model or represented as a scientific output.
        let data = format!("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC{}", "AAAA".repeat(550_000));
        let asset_id = uuid::Uuid::new_v4().to_string();
        let request = json!({"project_root":project,"window":window,"command":{"kind":"add_asset","conversation_id":"upload-conversation","asset_id":asset_id,"name":"large.png","mime_type":"image/png","data":data}});
        assert!(request.to_string().len() > 2 * 1024 * 1024 + 8192);
        assert_eq!(send(&app, "/api/agents/components/command", request.clone()).await.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let uploaded = send(&app, "/api/agents/components/asset/upload", request.clone()).await;
        assert_eq!(uploaded.status(), StatusCode::OK);
        let payload: serde_json::Value = serde_json::from_slice(&to_bytes(uploaded.into_body(), 16 * 1024).await.unwrap()).unwrap();
        assert_eq!(payload["asset"]["asset_id"], asset_id);
        assert_eq!(send(&app, "/api/agents/components/asset/upload", request).await.status(), StatusCode::OK);
        assert_eq!(state.component_agents.assets(&host, &context, &project, "upload-conversation").unwrap().len(), 1);
        let read = send(&app, "/api/agents/components/asset", json!({"project_root":project,"conversation_id":"upload-conversation","asset_id":asset_id})).await;
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(read.headers()[header::CONTENT_TYPE], "image/png");
        let bytes = to_bytes(read.into_body(), 2 * 1024 * 1024).await.unwrap();
        assert_eq!(bytes.len() as u64, payload["asset"]["bytes"].as_u64().unwrap());
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_ne!(send(&app, "/api/agents/components/asset", json!({"project_root":project,"conversation_id":"different-conversation","asset_id":asset_id})).await.status(), StatusCode::OK);
        let invalid_upload_command = json!({"project_root":project,"window":window,"command":{"kind":"create","conversation_id":"unexpected","profile":"project"}});
        assert_eq!(send(&app, "/api/agents/components/asset/upload", invalid_upload_command).await.status(), StatusCode::BAD_REQUEST);
        assert!(!state.component_agents.has_live().await);
    }
}
