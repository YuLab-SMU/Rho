//! Complete HTTP boundary/session tests using credentials issued by the real task service.
use super::*;
use async_trait::async_trait;
use axum::body::{Body, to_bytes};
use rho_contract::*;
use rho_host::{
    NativeAgentFactory, NativeAgentSession, NativeEvent, NativeEventPage, NativeOpenFailure,
    NativeOpenRequest, NativeProcessProof, NativePrompt,
};
use serde_json::{Value, json};
use std::sync::Mutex as SyncMutex;
use tower::ServiceExt;

#[derive(Default)]
struct CapturedFactory {
    tokens: SyncMutex<Vec<String>>,
}
struct QuietSession {
    state: SyncMutex<AgentClientSession>,
    changed: tokio::sync::Notify,
}
#[async_trait]
impl NativeAgentFactory for CapturedFactory {
    async fn open(
        &self,
        request: NativeOpenRequest,
    ) -> Result<Arc<dyn NativeAgentSession>, NativeOpenFailure> {
        self.tokens.lock().unwrap().push(request.token);
        Ok(Arc::new(QuietSession {
            state: SyncMutex::new(AgentClientSession {
                id: uuid::Uuid::new_v4().to_string(),
                provider: request.provider,
                native_session_id: request
                    .native_session_id
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                project_root: request.root.to_string_lossy().into_owned(),
                window: request.window,
                model: "fixture".into(),
                effort: None,
                state: "ready".into(),
                messages: vec![],
                activity: vec![],
                decisions: vec![],
                error: None,
                truncated: false,
                elapsed_ms: None,
                last_request_id: None,
            }),
            changed: tokio::sync::Notify::new(),
        }))
    }
    async fn recover_process(&self, _: &NativeProcessProof) -> Result<(), String> {
        Ok(())
    }
}
#[async_trait]
impl NativeAgentSession for QuietSession {
    fn snapshot(&self) -> AgentClientSession {
        self.state.lock().unwrap().clone()
    }
    fn capabilities(&self) -> AgentNativeCapabilities {
        AgentNativeCapabilities {
            resume: true,
            history: "native_context_history".into(),
            images: false,
            embedded_context: true,
            modes: vec![],
            current_mode: None,
            models: vec![AgentModel {
                id: "fixture".into(),
                name: "Fixture".into(),
                efforts: vec![],
                default_effort: None,
            }],
        }
    }
    fn events(&self, _: u64) -> NativeEventPage {
        NativeEventPage {
            events: vec![],
            cursor: 0,
            gap: false,
        }
    }
    fn native_turn_id(&self) -> Option<String> {
        None
    }
    fn process_proof(&self) -> Option<NativeProcessProof> {
        Some(NativeProcessProof {
            pid: 1,
            start_time: 1,
            executable: "fixture".into(),
            marker: "test-only".into(),
        })
    }
    fn rebind(&self, window: AgentControllerRef) {
        self.state.lock().unwrap().window = window;
    }
    async fn configure(&self, _: &str, _: Option<&str>, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    async fn send(&self, _: NativePrompt) -> Result<(), String> {
        Err("This fixture never sends a model prompt".into())
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn decide(&self, _: u64, _: &str) -> Result<(), String> {
        Ok(())
    }
    async fn close(&self) {
        self.state.lock().unwrap().state = "disconnected".into();
        self.changed.notify_waiters();
    }
    async fn changed(&self) {
        self.changed.notified().await;
    }
    async fn history(
        &self,
        _: Option<String>,
        _: u32,
    ) -> Result<(Vec<NativeEvent>, Option<String>), String> {
        Ok((vec![], None))
    }
}
struct Fixture {
    _directory: tempfile::TempDir,
    state: AppState,
    app: Router,
    host: Arc<NextHost>,
    root: String,
    window: ApplicationWindowRef,
    factory: Arc<CapturedFactory>,
    shutdown: CancellationToken,
}
impl Fixture {
    async fn new() -> Self {
        let (directory, mut state, _) = super::tests::fixture().await;
        let factory = Arc::new(CapturedFactory::default());
        state.task_agents =
            rho_host::AgentTaskService::with_factory(state.application.clone(), factory.clone());
        let (host, root) = {
            let hosting = state.hosting.read().await;
            let selected = hosting.selected.as_ref().unwrap();
            (
                selected.host.clone(),
                selected.root.to_string_lossy().into_owned(),
            )
        };
        let mut context = NextHost::local_context();
        context.connection_id = "studio:mcp-test".into();
        let result = host
            .dispatch(
                &context,
                HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                    window_id: "mcp-test-window".into(),
                    incarnation: "test-life".into(),
                    label: "MCP test".into(),
                    previous_session: None,
                }),
            )
            .await
            .unwrap();
        let ApplicationBridgeReply::Registered(registration) =
            serde_json::from_value(result).unwrap()
        else {
            panic!()
        };
        let shutdown = CancellationToken::new();
        let app = router(state.clone(), shutdown.clone());
        Self {
            _directory: directory,
            state,
            app,
            host,
            root,
            window: registration.session.window,
            factory,
            shutdown,
        }
    }
    async fn command(&self, command: AgentTaskCommand) -> AgentTaskDetail {
        let request_id = uuid::Uuid::new_v4().to_string();
        let result = self
            .state
            .task_agents
            .command(
                self.host.clone(),
                NextHost::local_context(),
                AgentTasksCommand {
                    project_root: self.root.clone(),
                    window: self.window.clone(),
                    request_id: request_id.clone(),
                    command,
                },
                format!("{}/mcp", self.state.origin),
                "unused-general-token".into(),
            )
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let value = self
                    .state
                    .task_agents
                    .query(
                        &self.host,
                        &NextHost::local_context(),
                        AgentTasksQuery {
                            project_root: self.root.clone(),
                            query: AgentTaskQuery::Receipt {
                                request_id: request_id.clone(),
                            },
                        },
                    )
                    .await
                    .unwrap();
                if let AgentTaskQueryResult::Receipt {
                    receipt: Some(receipt),
                } = value
                    && !matches!(receipt.status.as_str(), "prepared" | "submitted")
                {
                    assert_eq!(receipt.status, "succeeded", "{:?}", receipt.error);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let AgentTaskQueryResult::Detail { detail } = self
            .state
            .task_agents
            .query(
                &self.host,
                &NextHost::local_context(),
                AgentTasksQuery {
                    project_root: self.root.clone(),
                    query: AgentTaskQuery::Get {
                        task_id: result.detail.summary.task.task_id,
                    },
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        *detail
    }
    async fn task(&self) -> (AgentTaskDetail, String) {
        let task = self
            .command(AgentTaskCommand::Create {
                provider: AgentProvider::Kimi,
                model: "fixture".into(),
                effort: None,
            })
            .await;
        let connected = self
            .command(AgentTaskCommand::Connect {
                control: control(&task),
            })
            .await;
        let token = self.factory.tokens.lock().unwrap().last().unwrap().clone();
        (connected, token)
    }
    async fn post(&self, token: &str, session: Option<&str>, value: Value) -> Response {
        let mut request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, "127.0.0.1:10001")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18");
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        self.app
            .clone()
            .oneshot(request.body(Body::from(value.to_string())).unwrap())
            .await
            .unwrap()
    }
    async fn initialize(&self, token: &str) -> String {
        let response = self.post(token, None, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rho-http-identity-test","version":"1"}}})).await;
        assert_eq!(response.status(), StatusCode::OK);
        let session = response
            .headers()
            .get("mcp-session-id")
            .expect("stateful MCP session")
            .to_str()
            .unwrap()
            .to_owned();
        let value = rpc_body(response).await;
        assert!(value.get("result").is_some(), "{value}");
        let response = self
            .post(
                token,
                Some(&session),
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await;
        assert!(response.status().is_success());
        session
    }
    async fn rpc(&self, token: &str, session: &str, method: &str, params: Value) -> Value {
        let response = self
            .post(
                token,
                Some(session),
                json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}),
            )
            .await;
        rpc_body(response).await
    }
    async fn close(&self) {
        self.shutdown.cancel();
        self.state.task_agents.close().await;
    }
}
fn control(task: &AgentTaskDetail) -> AgentTaskControl {
    AgentTaskControl {
        task_id: task.summary.task.task_id.clone(),
        generation: task.summary.attachment.generation,
    }
}
async fn rpc_body(response: Response) -> Value {
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        to_bytes(response.into_body(), MAX_REPLY),
    )
    .await
    .unwrap()
    .unwrap();
    if let Ok(json) = serde_json::from_slice(&bytes) {
        return json;
    }
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    text.lines()
        .filter_map(|line| {
            line.strip_prefix("data:")
                .and_then(|data| serde_json::from_str::<Value>(data.trim()).ok())
        })
        .find(|value| value.get("id").is_some())
        .unwrap_or_else(|| panic!("No RPC response in SSE body: {text}"))
}

#[tokio::test]
async fn initialized_transport_cannot_switch_to_another_managed_token_on_first_request() {
    let f = Fixture::new().await;
    let (_, one) = f.task().await;
    let (_, two) = f.task().await;
    let session = f.initialize(&one).await;
    let swapped = f.rpc(&two, &session, "tools/list", json!({})).await;
    assert!(
        swapped.get("error").is_some(),
        "A different token must not claim an initialized transport: {swapped}"
    );
    let own = f.rpc(&one, &session, "tools/list", json!({})).await;
    assert!(own["result"]["tools"].is_array(), "{own}");
    f.close().await;
}

#[tokio::test]
async fn managed_mcp_credentials_bind_every_request_and_cannot_control_the_browser() {
    let f = Fixture::new().await;
    let (task, one) = f.task().await;
    let (_, two) = f.task().await;
    let first = f.state.task_agents.mcp_connections.resolve(&one).unwrap();
    let second = f.state.task_agents.mcp_connections.resolve(&two).unwrap();
    assert_ne!(first.context.caller, second.context.caller);
    let session = f.initialize(&one).await;
    assert!(
        f.rpc(&one, &session, "ping", json!({}))
            .await
            .get("result")
            .is_some()
    );
    for method in [
        "ping",
        "tools/list",
        "resources/list",
        "resources/templates/list",
    ] {
        assert!(
            f.rpc(&two, &session, method, json!({}))
                .await
                .get("error")
                .is_some(),
            "identity swap passed {method}"
        );
    }
    let browser = Request::builder()
        .uri("/api/info")
        .header(header::HOST, "127.0.0.1:10001")
        .header(header::AUTHORIZATION, format!("Bearer {one}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        f.app.clone().oneshot(browser).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let browser_command = Request::builder()
        .method("POST").uri("/api/agents/tasks/command")
        .header(header::HOST, "127.0.0.1:10001")
        .header(header::AUTHORIZATION, format!("Bearer {one}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-rho-studio-window", &f.window.window_id)
        .body(Body::from(serde_json::to_vec(&AgentTasksCommand {
            project_root: f.root.clone(), window: f.window.clone(), request_id: uuid::Uuid::new_v4().to_string(),
            command: AgentTaskCommand::Rename { control: control(&task), title: "must not be applied".into() },
        }).unwrap())).unwrap();
    assert_eq!(f.app.clone().oneshot(browser_command).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let disconnected = f
        .command(AgentTaskCommand::Disconnect {
            control: control(&task),
        })
        .await;
    assert!(!first.is_valid());
    let revoked = f
        .post(
            &one,
            Some(&session),
            json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
        )
        .await;
    assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
    let resumed = f
        .command(AgentTaskCommand::Resume {
            control: control(&disconnected),
        })
        .await;
    let current_token = f.factory.tokens.lock().unwrap().last().unwrap().clone();
    let current = f
        .state
        .task_agents
        .mcp_connections
        .resolve(&current_token)
        .unwrap();
    assert_eq!(first.context.caller, current.context.caller);
    assert_eq!(resumed.summary.task.task_id, task.summary.task.task_id);
    assert_ne!(first.context.connection_id, current.context.connection_id);
    assert!(
        f.rpc(&current_token, &session, "ping", json!({}))
            .await
            .get("error")
            .is_some()
    );
    let fresh = f.initialize(&current_token).await;
    assert!(
        f.rpc(&current_token, &fresh, "ping", json!({}))
            .await
            .get("result")
            .is_some()
    );
    f.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn managed_http_calls_attribute_operations_to_distinct_tasks_and_resume_reuses_request_scope()
{
    let f = Fixture::new().await;
    let (one_task, one) = f.task().await;
    let (_, two) = f.task().await;
    let one_session = f.initialize(&one).await;
    let two_session = f.initialize(&two).await;
    let params = json!({"name":"rho.process.run_local.v1","arguments":{"client_request_id":"same-request-key","arguments":{"program":"/usr/bin/printf","args":["42"]},"preconditions":[],"return_after_acceptance":false}});
    let one_result = f
        .rpc(&one, &one_session, "tools/call", params.clone())
        .await;
    let two_result = f
        .rpc(&two, &two_session, "tools/call", params.clone())
        .await;
    let one_record = &one_result["result"]["structuredContent"]["result"];
    let two_record = &two_result["result"]["structuredContent"]["result"];
    assert_eq!(one_record["status"], "succeeded", "{one_result}");
    assert_eq!(two_record["status"], "succeeded", "{two_result}");
    assert_ne!(
        one_record["operation"]["operation_id"],
        two_record["operation"]["operation_id"]
    );
    assert_ne!(
        one_record["operation"]["caller"],
        two_record["operation"]["caller"]
    );
    let disconnected = f
        .command(AgentTaskCommand::Disconnect {
            control: control(&one_task),
        })
        .await;
    f.command(AgentTaskCommand::Resume {
        control: control(&disconnected),
    })
    .await;
    let resumed = f.factory.tokens.lock().unwrap().last().unwrap().clone();
    let resumed_session = f.initialize(&resumed).await;
    let repeated = f
        .rpc(&resumed, &resumed_session, "tools/call", params)
        .await;
    assert_eq!(
        repeated["result"]["structuredContent"]["result"]["operation"]["operation_id"],
        one_record["operation"]["operation_id"]
    );
    f.close().await;
}

#[tokio::test]
async fn managed_identity_also_fences_http_event_stream_and_session_delete() {
    let f = Fixture::new().await;
    let (_, one) = f.task().await;
    let (_, two) = f.task().await;
    let session = f.initialize(&one).await;
    for method in ["GET", "DELETE"] {
        let request = Request::builder()
            .method(method)
            .uri("/mcp")
            .header(header::HOST, "127.0.0.1:10001")
            .header(header::AUTHORIZATION, format!("Bearer {two}"))
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .header("mcp-session-id", &session)
            .body(Body::empty())
            .unwrap();
        let response = f.app.clone().oneshot(request).await.unwrap();
        assert!(
            matches!(
                response.status(),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
            ),
            "wrong identity passed {method}: {}",
            response.status()
        );
    }
    assert!(
        f.rpc(&one, &session, "ping", json!({}))
            .await
            .get("result")
            .is_some(),
        "rejected DELETE must not terminate the original session"
    );
    let request = Request::builder()
        .method("DELETE")
        .uri("/mcp")
        .header(header::HOST, "127.0.0.1:10001")
        .header(header::AUTHORIZATION, format!("Bearer {one}"))
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .header("mcp-session-id", &session)
        .body(Body::empty())
        .unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert!(
        response.status().is_success(),
        "the owning identity can end its transport: {}",
        response.status()
    );
    assert!(
        !f.post(
            &one,
            Some(&session),
            json!({"jsonrpc":"2.0","id":3,"method":"ping"})
        )
        .await
        .status()
        .is_success()
    );
    f.close().await;
}
