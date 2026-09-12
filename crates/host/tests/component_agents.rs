//! Real Rig -> Application intent -> shared Host query gateway -> project owner.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use rho_application::{
    ComponentAgentEngine, ComponentEngineExecution, ComponentEngineOutcome, ComponentToolAction,
    ComponentToolAdmission,
};
use rho_contract::*;
use rho_host::{ApplicationStore, ComponentAgentService, NextHost};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Clone, Copy)]
enum Mode {
    ReadFile,
    Context,
    ForgedWindow,
    Silent,
    Redirect,
    Diagnostics,
}
#[derive(Clone)]
struct ProviderState {
    mode: Mode,
    requests: Arc<Mutex<Vec<Value>>>,
    requested: Arc<Notify>,
}
struct Provider {
    url: String,
    state: ProviderState,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Provider {
    async fn new(mode: Mode) -> Self {
        let state = ProviderState {
            mode,
            requests: Arc::default(),
            requested: Arc::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/v1/chat/completions", post(completion))
            .route("/redirected", post(completion))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, state, task }
    }
}
fn chunk(delta: Value, finish: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
    )
}
async fn completion(
    State(state): State<ProviderState>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body.clone());
        requests.len()
    };
    state.requested.notify_one();
    if matches!(state.mode, Mode::Silent) {
        return std::future::pending().await;
    }
    if matches!(state.mode, Mode::Redirect) {
        return (
            axum::http::StatusCode::TEMPORARY_REDIRECT,
            [(axum::http::header::LOCATION, "/redirected")],
        )
            .into_response();
    }
    let mut text = chunk(json!({"role":"assistant"}), Value::Null);
    if matches!(state.mode, Mode::Diagnostics) {
        let connection = body["tools"].as_array().is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "component_verify")
        });
        let marker = body["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["role"] == "tool")
            .find_map(|m| {
                serde_json::from_str::<Value>(m["content"].as_str()?)
                    .ok()?
                    .get("marker")?
                    .as_str()
                    .map(str::to_owned)
            });
        if connection && marker.is_none() {
            text.push_str(&chunk(json!({"tool_calls":[{"index":0,"id":"diagnostic-call","type":"function","function":{"name":"component_verify","arguments":"{}"}}]}),Value::Null));
            text.push_str(&chunk(json!({}), json!("tool_calls")));
        } else {
            let serialized = body.to_string();
            let answer = marker.unwrap_or_else(|| {
                if serialized.contains(
                    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNg+M+AHQ0tCQDpMD",
                ) {
                    "green"
                } else if serialized.contains(
                    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQ",
                ) {
                    "blue"
                } else {
                    "red"
                }
                .into()
            });
            text.push_str(&chunk(json!({"content":answer}), Value::Null));
            text.push_str(&chunk(json!({}), json!("stop")));
        }
    } else if index == 1 {
        let (name, args) = match state.mode {
            Mode::ReadFile => ("project_read_text", json!({"path":"analysis.R"})),
            Mode::Context => ("application_context", json!({"limit":1})),
            Mode::ForgedWindow => (
                "application_context",
                json!({"window":{"window_id":"other-window","incarnation":"forged"},"limit":1}),
            ),
            _ => unreachable!(),
        };
        text.push_str(&chunk(json!({"tool_calls":[{"index":0,"id":"call-one","type":"function","function":{"name":name,"arguments":args.to_string()}}]}),Value::Null));
        text.push_str(&chunk(json!({}), json!("tool_calls")));
    } else {
        text.push_str(&chunk(
            json!({"content":"The verified fixture was read."}),
            Value::Null,
        ));
        text.push_str(&chunk(json!({}), json!("stop")));
    }
    text.push_str(&format!("data: {}\n\n",json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[],"usage":{"prompt_tokens":13,"completion_tokens":7,"total_tokens":20}})));
    text.push_str("data: [DONE]\n\n");
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        text,
    )
        .into_response()
}

async fn diagnostic_done(f: &Fixture, id: &str) -> ComponentModelDiagnostic {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = f
                .service
                .diagnostic(&f.host, &f.context, &f.project, id)
                .unwrap()
                .unwrap();
            if !matches!(
                value.state,
                ComponentModelTestState::Queued | ComponentModelTestState::Running
            ) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn explicit_diagnostics_are_synthetic_durable_and_idempotent() {
    let provider = Provider::new(Mode::Diagnostics).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let request = ComponentModelTestRequest {
        project_root: f.project.clone(),
        window: f.window.clone(),
        request_id: "connection-test".into(),
        model_settings_version: 1,
        kind: ComponentModelTestKind::Connection,
    };
    f.service
        .test_model(f.host.clone(), f.context.clone(), request.clone())
        .await
        .unwrap();
    f.service
        .test_model(f.host.clone(), f.context.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(
        diagnostic_done(&f, "connection-test").await.state,
        ComponentModelTestState::Passed
    );
    let mut changed = request;
    changed.kind = ComponentModelTestKind::Images;
    assert!(
        f.service
            .test_model(f.host.clone(), f.context.clone(), changed)
            .await
            .is_err()
    );
    f.service
        .test_model(
            f.host.clone(),
            f.context.clone(),
            ComponentModelTestRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                request_id: "image-test".into(),
                model_settings_version: 1,
                kind: ComponentModelTestKind::Images,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        diagnostic_done(&f, "image-test").await.state,
        ComponentModelTestState::Passed
    );
    let wire = serde_json::to_string(&provider.state.requests.lock().unwrap().clone()).unwrap();
    assert!(
        !wire.contains("native-project-evidence-27")
            && !wire.contains(&f.project)
            && !wire.contains("host-only-fixture-key")
    );
    assert_eq!(provider.state.requests.lock().unwrap().len(), 3);
    let mut settings = f.service.settings(&f.host, &f.context, &f.project).unwrap();
    settings.connection.as_mut().unwrap().model = "a-different-model".into();
    let settings = f
        .service
        .configure(&f.host, &f.context, &f.project, &f.window, &settings)
        .await
        .unwrap();
    let mut start = f.request();
    start.model_settings_version = settings.version;
    start.sources.push(AgentContextSelection {
        source: "plots".into(),
        label: "image".into(),
        reference: json!({}),
        inclusion: "image".into(),
    });
    assert!(
        f.service
            .start(f.host.clone(), f.context.clone(), &f.project, start)
            .await
            .unwrap_err()
            .to_string()
            .contains("Image input is not verified")
    );
    assert_eq!(
        f.service
            .diagnostics(&f.host, &f.context, &f.project)
            .unwrap()
            .len(),
        2
    );
    f.service.close().await;
}

#[tokio::test]
async fn source_search_never_sends_a_model_request_and_respects_scope() {
    let provider = Provider::new(Mode::ReadFile).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let request = ComponentSourceSearch {
        project_root: f.project.clone(),
        window: f.window.clone(),
        session: None,
        source: "files".into(),
        text: "analysis".into(),
        limit: 10,
    };
    let found = f
        .service
        .search_sources(&f.host, &f.context, request.clone())
        .await
        .unwrap();
    assert!(
        found
            .items
            .iter()
            .any(|item| item.selection.reference["path"] == "analysis.R")
    );
    let mut wrong = request;
    wrong.project_root = "/another-project".into();
    assert!(
        f.service
            .search_sources(&f.host, &f.context, wrong)
            .await
            .is_err()
    );
    assert!(provider.state.requests.lock().unwrap().is_empty());
    f.service.close().await;
}

#[tokio::test]
async fn unverified_images_are_rejected_before_source_or_model_work() {
    let provider = Provider::new(Mode::ReadFile).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let mut request = f.request();
    request.sources.push(AgentContextSelection {
        source: "plots".into(),
        label: "unverified".into(),
        reference: json!({}),
        inclusion: "image".into(),
    });
    let result = f
        .service
        .start(f.host.clone(), f.context.clone(), &f.project, request)
        .await
        .unwrap_err();
    assert!(result.to_string().contains("Image input is not verified"));
    assert!(provider.state.requests.lock().unwrap().is_empty());
    f.service.close().await;
}

#[tokio::test]
async fn a_silent_model_diagnostic_can_be_stopped_without_repeating_it() {
    let provider = Provider::new(Mode::Silent).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let request = ComponentModelTestRequest {
        project_root: f.project.clone(),
        window: f.window.clone(),
        request_id: "silent-test".into(),
        model_settings_version: 1,
        kind: ComponentModelTestKind::Connection,
    };
    f.service
        .test_model(f.host.clone(), f.context.clone(), request.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), provider.state.requested.notified())
        .await
        .unwrap();
    f.service
        .stop_test(&f.host, &f.context, &f.project, &f.window, "silent-test")
        .await
        .unwrap();
    assert_eq!(
        diagnostic_done(&f, "silent-test").await.state,
        ComponentModelTestState::Interrupted
    );
    assert_eq!(
        f.service
            .test_model(f.host.clone(), f.context.clone(), request)
            .await
            .unwrap()
            .state,
        ComponentModelTestState::Interrupted
    );
    f.service.close().await;
    assert_eq!(provider.state.requests.lock().unwrap().len(), 1);
}

struct Fixture {
    _directory: tempfile::TempDir,
    host: Arc<NextHost>,
    service: Arc<ComponentAgentService>,
    context: CallContext,
    project: String,
    window: ApplicationWindowRef,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("study");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("analysis.R"),
            "fixture_marker <- 'native-project-evidence-27'\n",
        )
        .unwrap();
        let project = root.canonicalize().unwrap().to_string_lossy().into_owned();
        let host = Arc::new(
            NextHost::open_project(directory.path().join("journal.sqlite"), &project)
                .await
                .unwrap(),
        );
        let service = ComponentAgentService::new(Arc::new(
            ApplicationStore::open(&directory.path().join("components.sqlite")).unwrap(),
        ));
        let mut context = NextHost::local_context();
        context.connection_id = "studio:component-test".into();
        let reply = host
            .dispatch(
                &context,
                HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                    window_id: "component-window".into(),
                    incarnation: "component-window-life".into(),
                    label: "Component test".into(),
                    previous_session: None,
                }),
            )
            .await
            .unwrap();
        let ApplicationBridgeReply::Registered(registered) = serde_json::from_value(reply).unwrap()
        else {
            panic!()
        };
        Self {
            _directory: directory,
            host,
            service,
            context,
            project,
            window: registered.session.window,
        }
    }
    async fn configure(&self, provider: &Provider) {
        let credential = self
            .service
            .put_session_key(
                &self.host,
                &self.context,
                &self.project,
                &self.window,
                "host-only-fixture-key".into(),
            )
            .unwrap();
        self.service
            .configure(
                &self.host,
                &self.context,
                &self.project,
                &self.window,
                &ComponentModelSettings {
                    version: 0,
                    enabled: true,
                    connection: Some(ComponentModelConnection {
                        protocol: ComponentModelProtocol::OpenaiCompletions,
                        base_url: provider.url.clone(),
                        model: "fixture".into(),
                        credential,
                    }),
                },
            )
            .await
            .unwrap();
    }
    fn request(&self) -> ComponentAgentStart {
        let conversation = self
            .service
            .create(
                &self.host,
                &self.context,
                &self.project,
                &self.window,
                "conversation",
                ComponentAgentProfile::Project,
            )
            .unwrap();
        ComponentAgentStart {
            request_id: "user-request".into(),
            conversation_id: conversation.conversation_id,
            conversation_version: conversation.version,
            window: self.window.clone(),
            model_settings_version: 1,
            text: "Read analysis.R and explain the fixture.".into(),
            grant: ComponentAgentGrant {
                mode: ComponentAgentMode::Explain,
                session: None,
                documents: vec![],
                files: vec![],
            },
            sources: vec![],
        }
    }
    async fn start(&self, request: ComponentAgentStart) -> ComponentAgentRun {
        self.service
            .start(
                self.host.clone(),
                self.context.clone(),
                &self.project,
                request,
            )
            .await
            .unwrap()
    }
    async fn terminal(&self, id: &str) -> ComponentAgentRun {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let run = self
                    .service
                    .run(&self.host, &self.context, &self.project, id)
                    .unwrap();
                if run.state.is_terminal() {
                    return run;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "run did not finish: {:?}",
                self.service
                    .run(&self.host, &self.context, &self.project, id)
            )
        })
    }
}

#[tokio::test]
async fn rig_reads_the_actual_project_through_the_shared_gateway_and_deduplicates_start() {
    let provider = Provider::new(Mode::ReadFile).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let request = f.request();
    let run = f.start(request.clone()).await;
    let repeated = f.start(request).await;
    assert_eq!(run.run_id, repeated.run_id);
    let final_run = f.terminal(&run.run_id).await;
    assert_eq!(
        final_run.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        final_run.reason
    );
    assert_eq!((final_run.model_calls, final_run.tool_calls), (2, 1));
    assert_eq!(final_run.input_tokens, Some(26));
    let tools = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].phase, ComponentToolPhase::Resolved);
    assert!(!tools[0].mutation);
    let query = QueryRequest {
        capability: CapabilityRef::new("project.read_text", 1).unwrap(),
        arguments: json!({"path":"analysis.R"}),
    };
    let direct = f
        .host
        .dispatch(&f.context, HostRequest::QuerySnapshot(query))
        .await
        .unwrap();
    let recorded = tools[0].result.as_ref().unwrap();
    for field in ["data", "target", "source", "status", "completeness"] {
        assert_eq!(recorded[field], direct[field], "{field}");
    }
    let requests = provider.state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    let wire = serde_json::to_string(&requests).unwrap();
    assert!(wire.contains("native-project-evidence-27"));
    assert!(!wire.contains("host-only-fixture-key"));
    assert!(!wire.contains("component:user-request"));
    let page = f
        .service
        .events(&f.host, &f.context, &f.project, &run.run_id, 0, 128)
        .unwrap();
    assert!(page.events.iter().any(|e|matches!(&e.content,ComponentAgentEventContent::Text{text} if text.contains("verified fixture"))));
    assert!(f.host.is_idle());
    f.service.close().await;
}

#[tokio::test]
async fn host_injects_window_and_rejects_model_overrides_before_any_intent() {
    for mode in [Mode::Context, Mode::ForgedWindow] {
        let provider = Provider::new(mode).await;
        let f = Fixture::new().await;
        f.configure(&provider).await;
        let run = f.start(f.request()).await;
        let result = f.terminal(&run.run_id).await;
        let requests = provider.state.requests.lock().unwrap().clone();
        let tool = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "application_context")
            .unwrap();
        assert!(
            tool["function"]["parameters"]["properties"]
                .get("window")
                .is_none()
        );
        let receipts = f
            .service
            .tools(&f.host, &f.context, &f.project, &run.run_id)
            .unwrap();
        if matches!(mode, Mode::Context) {
            assert_eq!(
                result.state,
                ComponentAgentRunState::Completed,
                "{:?}",
                result.reason
            );
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].result.as_ref().unwrap()["status"], "ready");
        } else {
            assert_eq!(result.state, ComponentAgentRunState::Failed);
            assert!(receipts.is_empty());
            assert_eq!(requests.len(), 1);
        }
        f.service.close().await;
    }
}

#[tokio::test]
async fn stop_interrupts_a_silent_provider_and_does_not_stop_other_work() {
    let provider = Provider::new(Mode::Silent).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let run = f.start(f.request()).await;
    tokio::time::timeout(Duration::from_secs(4), provider.state.requested.notified())
        .await
        .unwrap();
    f.service
        .stop(&f.host, &f.context, &f.project, &f.window, &run.run_id)
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), f.terminal(&run.run_id))
        .await
        .unwrap();
    assert_eq!(result.state, ComponentAgentRunState::Stopped);
    assert_eq!(provider.state.requests.lock().unwrap().len(), 1);
    let response = f
        .host
        .dispatch(
            &f.context,
            HostRequest::QuerySnapshot(QueryRequest {
                capability: CapabilityRef::new("project.read_text", 1).unwrap(),
                arguments: json!({"path":"analysis.R"}),
            }),
        )
        .await
        .unwrap();
    assert_eq!(response["status"], "ready");
    f.service.close().await;
}

#[tokio::test]
async fn disabled_requests_have_no_model_cost_and_cross_project_commands_are_rejected() {
    let provider = Provider::new(Mode::ReadFile).await;
    let f = Fixture::new().await;
    assert!(
        f.service
            .start(f.host.clone(), f.context.clone(), &f.project, f.request())
            .await
            .is_err()
    );
    assert!(provider.state.requests.lock().unwrap().is_empty());
    assert!(
        f.service
            .settings(&f.host, &f.context, "/another-project")
            .is_err()
    );
    f.configure(&provider).await;
    let mut settings = f.service.settings(&f.host, &f.context, &f.project).unwrap();
    settings.enabled = false;
    f.service
        .configure(&f.host, &f.context, &f.project, &f.window, &settings)
        .await
        .unwrap();
    assert!(
        f.service
            .start(f.host.clone(), f.context.clone(), &f.project, f.request())
            .await
            .is_err()
    );
    assert!(provider.state.requests.lock().unwrap().is_empty());
    f.service.close().await;
}

#[tokio::test]
async fn provider_redirect_is_not_followed_and_no_second_request_is_sent() {
    let provider = Provider::new(Mode::Redirect).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let run = f.start(f.request()).await;
    let result = f.terminal(&run.run_id).await;
    assert_eq!(result.state, ComponentAgentRunState::Failed);
    assert_eq!(provider.state.requests.lock().unwrap().len(), 1);
    assert!(
        f.service
            .tools(&f.host, &f.context, &f.project, &run.run_id)
            .unwrap()
            .is_empty()
    );
    f.service.close().await;
}

struct AlteredTicketEngine;
#[async_trait::async_trait]
impl ComponentAgentEngine for AlteredTicketEngine {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let turn = request.port.begin_model_call().await.unwrap();
        let admitted = request
            .port
            .prepare_tool(
                turn,
                "tool-call",
                "project_read_text",
                json!({"path":"analysis.R"}),
            )
            .await
            .unwrap();
        let original = admitted.tool.clone();
        let mut altered = ComponentToolAdmission {
            tool: admitted.tool,
            repeated: false,
        };
        if let ComponentToolAction::Query(query) = &mut altered.tool.action {
            query.arguments["path"] = json!("another.R");
        }
        let error = request.port.execute_tool(altered).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("differs from its durable intent")
        );
        request.port.interrupted_tool(&original).await.unwrap();
        ComponentEngineOutcome::Completed
    }
}

#[tokio::test]
async fn dispatch_reloads_the_durable_intent_instead_of_trusting_an_altered_ticket() {
    let provider = Provider::new(Mode::ReadFile).await;
    let mut f = Fixture::new().await;
    f.service = ComponentAgentService::with_engine(
        Arc::new(ApplicationStore::open(&f._directory.path().join("components.sqlite")).unwrap()),
        Arc::new(AlteredTicketEngine),
    );
    f.configure(&provider).await;
    let run = f.start(f.request()).await;
    assert_eq!(
        f.terminal(&run.run_id).await.state,
        ComponentAgentRunState::Completed
    );
    let tools = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].phase, ComponentToolPhase::Uncertain);
    assert!(provider.state.requests.lock().unwrap().is_empty());
    f.service.close().await;
}

#[tokio::test]
async fn file_context_is_previewed_frozen_and_reused_without_revalidating_a_duplicate_start() {
    let provider = Provider::new(Mode::ReadFile).await;
    let f = Fixture::new().await;
    let preview = f
        .service
        .preview_source(
            &f.host,
            &f.context,
            ComponentSourcePreviewRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                session: None,
                selection: AgentContextSelection {
                    source: "files".into(),
                    label: "analysis.R".into(),
                    reference: json!({"path":"analysis.R"}),
                    inclusion: "text".into(),
                },
            },
        )
        .await
        .unwrap();
    assert!(preview.error.is_none());
    assert!(provider.state.requests.lock().unwrap().is_empty());
    let snapshot = preview.snapshot.unwrap();
    assert!(snapshot.text.contains("native-project-evidence-27"));
    assert_eq!(snapshot.observations[0].status, QueryStatus::Ready);
    assert!(
        snapshot.selection.reference["expected_sha256"]
            .as_str()
            .is_some()
    );
    f.configure(&provider).await;
    let mut request = f.request();
    request.sources = vec![snapshot.selection];
    let run = f.start(request.clone()).await;
    assert_eq!(
        f.terminal(&run.run_id).await.state,
        ComponentAgentRunState::Completed
    );
    assert!(
        run.context.as_ref().unwrap().sources[0]
            .text
            .contains("native-project-evidence-27")
    );
    std::fs::write(
        std::path::Path::new(&f.project).join("analysis.R"),
        "changed after accepted request",
    )
    .unwrap();
    let repeated = f.start(request).await;
    assert_eq!(repeated.run_id, run.run_id);
    assert_eq!(provider.state.requests.lock().unwrap().len(), 2);
    let first = provider.state.requests.lock().unwrap()[0].clone();
    assert!(first.to_string().contains("native-project-evidence-27"));
    f.service.close().await;
}

#[tokio::test]
async fn changed_file_or_cross_window_context_is_rejected_before_model_admission() {
    let provider = Provider::new(Mode::ReadFile).await;
    let f = Fixture::new().await;
    f.configure(&provider).await;
    let preview = f
        .service
        .preview_source(
            &f.host,
            &f.context,
            ComponentSourcePreviewRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                session: None,
                selection: AgentContextSelection {
                    source: "files".into(),
                    label: "analysis.R".into(),
                    reference: json!({"path":"analysis.R"}),
                    inclusion: "text".into(),
                },
            },
        )
        .await
        .unwrap();
    let mut request = f.request();
    request.sources = vec![preview.snapshot.unwrap().selection];
    std::fs::write(
        std::path::Path::new(&f.project).join("analysis.R"),
        "a later version",
    )
    .unwrap();
    assert!(
        f.service
            .start(
                f.host.clone(),
                f.context.clone(),
                &f.project,
                request.clone()
            )
            .await
            .is_err()
    );
    assert!(
        f.service
            .run_by_request(&f.host, &f.context, &f.project, &request.request_id)
            .unwrap()
            .is_none()
    );
    assert!(provider.state.requests.lock().unwrap().is_empty());
    let denied = f
        .service
        .preview_source(
            &f.host,
            &f.context,
            ComponentSourcePreviewRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                session: None,
                selection: AgentContextSelection {
                    source: "editor".into(),
                    label: "other document".into(),
                    reference: json!({"window":{"window_id":"other","incarnation":"other"}}),
                    inclusion: "text".into(),
                },
            },
        )
        .await;
    assert!(denied.is_err());
    f.service.close().await;
}
