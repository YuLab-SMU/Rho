//! P0: real Rig driver and HTTP/SSE codec, with an isolated synthetic provider.
//! These checks do not establish live model quality or scientific dispatch safety.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use futures::StreamExt;
use rig::{
    Agent, AgentRunner,
    agent::{
        MultiTurnStreamItem,
        hook::{
            AgentHook, CompletionCall, CompletionCallAction, HookContext, ToolCall, ToolCallAction,
            ToolResultAction, ToolResultEvent,
        },
    },
    message::{ImageMediaType, Message, UserContent},
    prelude::*,
    providers::{anthropic, openai},
    streaming::StreamedAssistantContent,
    tool::{DynamicTool, ToolContext, ToolExecutionError, ToolOutput},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum Scenario {
    Tool,
    Batch,
    Loop,
    Malformed,
    InvalidSchema,
    UnknownTool,
    Silent,
    HttpFailure,
    Text,
}

#[derive(Clone)]
struct ProviderState {
    scenario: Scenario,
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
    async fn new(scenario: Scenario) -> Self {
        let state = ProviderState {
            scenario,
            requests: Arc::default(),
            requested: Arc::default(),
        };
        let app = Router::new()
            .route("/v1/chat/completions", post(completion))
            .route("/v1/messages", post(anthropic_completion))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, state, task }
    }
    fn requests(&self) -> Vec<Value> {
        self.state.requests.lock().unwrap().clone()
    }
}

fn chunk(delta: Value, finish: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"id":"synthetic-completion", "object":"chat.completion.chunk",
        "created":1, "model":"synthetic", "choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
    )
}

async fn anthropic_completion(
    State(state): State<ProviderState>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    state.requests.lock().unwrap().push(body);
    let events = [
        json!({"type":"message_start","message":{"id":"synthetic","type":"message","role":"assistant","content":[],"model":"synthetic","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Two images received"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}),
        json!({"type":"message_stop"}),
    ];
    let stream = events
        .into_iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {}\n\n",
                event["type"].as_str().unwrap(),
                event
            )
        })
        .collect::<String>();
    ([("content-type", "text/event-stream")], stream).into_response()
}

async fn completion(
    State(state): State<ProviderState>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let index = {
        let mut requests = state.requests.lock().unwrap();
        requests.push(body);
        requests.len()
    };
    state.requested.notify_one();
    if matches!(state.scenario, Scenario::Silent) {
        return std::future::pending().await;
    }
    if matches!(state.scenario, Scenario::HttpFailure) {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":{"message":"synthetic protocol rejection","type":"invalid_request_error"}}))).into_response();
    }
    let tool = !matches!(state.scenario, Scenario::Text)
        && (index == 1 || matches!(state.scenario, Scenario::Loop));
    let mut sse = chunk(json!({"role":"assistant"}), Value::Null);
    if tool {
        let name = if matches!(state.scenario, Scenario::UnknownTool) {
            "workspace_run_r"
        } else {
            "workspace_observe_object"
        };
        let arguments = match state.scenario {
            Scenario::Malformed => "{broken-json",
            Scenario::InvalidSchema => "{\"name\":42,\"principal\":\"model-forged\"}",
            _ => "{\"name\":\"fixture\"}",
        };
        let count = if matches!(state.scenario, Scenario::Batch) {
            3
        } else {
            1
        };
        for i in 0..count {
            sse.push_str(&chunk(
                json!({"tool_calls":[{"index":i,"id":format!("call-{index}-{i}"),"type":"function",
                "function":{"name":name,"arguments":""}}]}),
                Value::Null,
            ));
            // Exercise fragmented JSON rather than only complete tool-call frames.
            for part in [
                &arguments[..arguments.len() / 2],
                &arguments[arguments.len() / 2..],
            ] {
                sse.push_str(&chunk(
                    json!({"tool_calls":[{"index":i,"function":{"arguments":part}}]}),
                    Value::Null,
                ));
            }
        }
        sse.push_str(&chunk(json!({}), json!("tool_calls")));
    } else {
        sse.push_str(&chunk(json!({"content":"Observed "}), Value::Null));
        sse.push_str(&chunk(json!({"content":"fixture."}), Value::Null));
        sse.push_str(&chunk(json!({}), json!("stop")));
    }
    sse.push_str(&format!("data: {}\n\n", json!({"id":"synthetic-completion","object":"chat.completion.chunk","created":1,
        "model":"synthetic","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}})));
    sse.push_str("data: [DONE]\n\n");
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        sse,
    )
        .into_response()
}

#[derive(Clone, Debug)]
struct Intent {
    turn: usize,
    call: String,
    arguments: Value,
}
#[derive(Clone)]
struct Trusted {
    principal: String,
    pending: Arc<Mutex<Option<Intent>>>,
    trace: Arc<Mutex<Vec<String>>>,
    directory: PathBuf,
    cancellation: CancellationToken,
    fail_intent: bool,
    stop_after_intent: bool,
    tool_limit: usize,
}

#[derive(Clone)]
struct Gate(Trusted);
impl AgentHook for Gate {
    async fn on_completion_call(
        &self,
        _: &HookContext,
        _: CompletionCall<'_>,
    ) -> CompletionCallAction {
        if self.0.cancellation.is_cancelled() {
            CompletionCallAction::Stop("stopped".into())
        } else {
            CompletionCallAction::Continue
        }
    }
    async fn on_tool_call(&self, ctx: &HookContext, call: ToolCall<'_>) -> ToolCallAction {
        let trusted = &self.0;
        if trusted.cancellation.is_cancelled() {
            return ToolCallAction::stop("stopped");
        }
        if trusted
            .trace
            .lock()
            .unwrap()
            .iter()
            .filter(|x| x.starts_with("intent:"))
            .count()
            >= trusted.tool_limit
        {
            return ToolCallAction::stop("tool budget");
        }
        let Ok(arguments) = serde_json::from_str::<Value>(call.args) else {
            return ToolCallAction::stop("invalid JSON");
        };
        // Rig's dynamic API accepts arbitrary JSON. Rho must enforce the owner schema.
        if !jsonschema::is_valid(&schema(), &arguments) {
            return ToolCallAction::stop("invalid owner schema");
        }
        let intent = Intent {
            turn: ctx.turn(),
            call: call.tool_call_id.unwrap().into(),
            arguments,
        };
        if trusted.fail_intent {
            return ToolCallAction::stop("intent store unavailable");
        }
        // Real durable write in the experiment; P1 replaces it with ApplicationRepository.
        let path = trusted.directory.join(&intent.call);
        let bytes = serde_json::to_vec(
            &json!({"turn":intent.turn,"call":intent.call,"args":intent.arguments}),
        )
        .unwrap();
        let write = async {
            tokio::fs::write(&path, bytes).await?;
            tokio::fs::File::open(&path).await?.sync_all().await
        }
        .await;
        if write.is_err() {
            return ToolCallAction::stop("intent store unavailable");
        }
        trusted
            .trace
            .lock()
            .unwrap()
            .push(format!("intent:{}", intent.call));
        // A per-run slot is valid only with the sealed serial runner below. Identity
        // never enters model arguments, rewritten history or a provider payload.
        assert!(trusted.pending.lock().unwrap().replace(intent).is_none());
        if trusted.stop_after_intent {
            trusted.cancellation.cancel();
        }
        ToolCallAction::Run
    }
    async fn on_tool_result(
        &self,
        _: &HookContext,
        result: ToolResultEvent<'_>,
    ) -> ToolResultAction {
        if result.raw_result.is_success() {
            assert_eq!(
                result.tool_context.result::<String>().unwrap(),
                "private-native-receipt"
            );
            self.0
                .trace
                .lock()
                .unwrap()
                .push(format!("result:{}", result.tool_call_id.unwrap()));
        }
        ToolResultAction::Keep
    }
}

fn schema() -> Value {
    json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false})
}

fn agent(provider: &Provider) -> Agent {
    let client = openai::Client::builder()
        .api_key("synthetic-key")
        .base_url(&provider.url)
        .build()
        .unwrap()
        .completions_api();
    let tool = DynamicTool::new(
        "workspace_observe_object",
        "Read a synthetic bounded observation",
        schema(),
        |context, args| {
            Box::pin(async move {
                let trusted = context.require::<Trusted>().unwrap().clone();
                if trusted.cancellation.is_cancelled() {
                    return Err(ToolExecutionError::refused("stopped before dispatch"));
                }
                assert_eq!(trusted.principal, "private-principal");
                let intent = trusted
                    .pending
                    .lock()
                    .unwrap()
                    .take()
                    .expect("dispatch must have an intent");
                assert_eq!(intent.arguments, args);
                let bytes = tokio::fs::read(trusted.directory.join(&intent.call))
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap()["call"],
                    intent.call
                );
                trusted
                    .trace
                    .lock()
                    .unwrap()
                    .push(format!("dispatch:{}", intent.call));
                context.insert_result("private-native-receipt".to_string());
                Ok(ToolOutput::json(
                    json!({"status":"ready","completeness":"partial","observed_at":1,
            "data":{"name":"fixture","class":"numeric","values":[1,2]},"continuation":"next-page"}),
                ))
            })
        },
    );
    client
        .agent("synthetic")
        .preamble("Explain only the supplied synthetic fixture.")
        .max_tokens(2048)
        .dynamic_tool(tool)
        .build()
}

fn trusted(directory: PathBuf) -> Trusted {
    Trusted {
        principal: "private-principal".into(),
        pending: Arc::default(),
        trace: Arc::default(),
        directory,
        cancellation: CancellationToken::new(),
        fail_intent: false,
        stop_after_intent: false,
        tool_limit: 8,
    }
}
fn runner(agent: &Agent, trusted: Trusted, max_turns: usize) -> AgentRunner {
    let mut context = ToolContext::new();
    context.insert(trusted.clone());
    agent
        .runner("Inspect fixture.")
        .tool_context(context)
        .add_hook(Gate(trusted))
        .tool_concurrency(1)
        .max_turns(max_turns)
        .record_content_telemetry(false)
        .without_memory()
}

#[derive(Default)]
struct Outcome {
    text: String,
    committed: usize,
    completions: usize,
    finished: bool,
}
async fn drain(runner: AgentRunner) -> Result<Outcome, String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Outcome::default();
        let mut stream = runner.stream().await;
        while let Some(item) = stream.next().await {
            match item.map_err(|e| e.to_string())? {
                MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(text)) => {
                    output.text.push_str(&text.text)
                }
                MultiTurnStreamItem::ToolExecutionCommitted { .. } => output.committed += 1,
                MultiTurnStreamItem::CompletionCall(_) => output.completions += 1,
                MultiTurnStreamItem::FinalResponse(_) => output.finished = true,
                _ => {}
            }
        }
        Ok(output)
    })
    .await
    .map_err(|_| "test deadline exceeded".to_string())?
}

#[tokio::test]
async fn streams_tools_and_preserves_private_context_and_partial_observations() {
    let provider = Provider::new(Scenario::Tool).await;
    let dir = tempfile::tempdir().unwrap();
    let trusted = trusted(dir.path().into());
    let output = drain(runner(&agent(&provider), trusted.clone(), 4))
        .await
        .unwrap();
    assert_eq!(output.text, "Observed fixture.");
    assert!(output.finished);
    assert_eq!((output.committed, output.completions), (1, 2));
    assert_eq!(
        *trusted.trace.lock().unwrap(),
        ["intent:call-1-0", "dispatch:call-1-0", "result:call-1-0"]
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let wire = serde_json::to_string(&requests).unwrap();
    for private in [
        "private-principal",
        "private-native-receipt",
        "synthetic-key",
        dir.path().to_str().unwrap(),
    ] {
        assert!(!wire.contains(private));
    }
    assert!(wire.contains("partial") && wire.contains("next-page"));
    assert_eq!(requests[0]["tools"][0]["function"]["parameters"], schema());
    assert_eq!(requests[0]["stream"], true);
}

#[tokio::test]
async fn serial_batch_correlates_each_intent_body_and_result() {
    let provider = Provider::new(Scenario::Batch).await;
    let dir = tempfile::tempdir().unwrap();
    let trusted = trusted(dir.path().into());
    let output = drain(runner(&agent(&provider), trusted.clone(), 4))
        .await
        .unwrap();
    assert_eq!(output.committed, 3);
    assert_eq!(
        *trusted.trace.lock().unwrap(),
        (0..3)
            .flat_map(|i| [
                format!("intent:call-1-{i}"),
                format!("dispatch:call-1-{i}"),
                format!("result:call-1-{i}")
            ])
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn persistence_failure_prevents_tool_dispatch_and_next_model_call() {
    let provider = Provider::new(Scenario::Tool).await;
    let dir = tempfile::tempdir().unwrap();
    let mut trusted = trusted(dir.path().into());
    trusted.fail_intent = true;
    assert!(
        drain(runner(&agent(&provider), trusted.clone(), 4))
            .await
            .is_err()
    );
    assert!(trusted.trace.lock().unwrap().is_empty());
    assert_eq!(provider.requests().len(), 1);
}

#[tokio::test]
async fn cancellation_between_intent_and_body_prevents_dispatch() {
    let provider = Provider::new(Scenario::Tool).await;
    let dir = tempfile::tempdir().unwrap();
    let mut trusted = trusted(dir.path().into());
    trusted.stop_after_intent = true;
    let _ = drain(runner(&agent(&provider), trusted.clone(), 2)).await;
    assert_eq!(*trusted.trace.lock().unwrap(), ["intent:call-1-0"]);
    assert!(dir.path().join("call-1-0").exists());
    assert_eq!(provider.requests().len(), 1);
}

#[tokio::test]
async fn malformed_unknown_and_forged_arguments_do_not_dispatch() {
    for scenario in [
        Scenario::Malformed,
        Scenario::InvalidSchema,
        Scenario::UnknownTool,
    ] {
        let provider = Provider::new(scenario).await;
        let dir = tempfile::tempdir().unwrap();
        let trusted = trusted(dir.path().into());
        assert!(
            drain(runner(&agent(&provider), trusted.clone(), 4))
                .await
                .is_err()
        );
        assert!(trusted.trace.lock().unwrap().is_empty());
        assert_eq!(provider.requests().len(), 1);
    }
}

#[tokio::test]
async fn model_and_tool_budgets_are_separate() {
    let provider = Provider::new(Scenario::Loop).await;
    let dir = tempfile::tempdir().unwrap();
    let trusted = trusted(dir.path().into());
    assert!(
        drain(runner(&agent(&provider), trusted.clone(), 2))
            .await
            .is_err()
    );
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(
        trusted
            .trace
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.starts_with("dispatch:"))
            .count(),
        2
    );
    let provider = Provider::new(Scenario::Batch).await;
    let mut trusted = trusted;
    trusted.trace = Arc::default();
    trusted.tool_limit = 1;
    assert!(
        drain(runner(&agent(&provider), trusted.clone(), 4))
            .await
            .is_err()
    );
    assert_eq!(provider.requests().len(), 1);
    assert_eq!(trusted.trace.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn silent_provider_wait_can_be_dropped_without_waiting_for_a_token() {
    let provider = Provider::new(Scenario::Silent).await;
    let dir = tempfile::tempdir().unwrap();
    let trusted = trusted(dir.path().into());
    let cancel = trusted.cancellation.clone();
    let run = runner(&agent(&provider), trusted.clone(), 4);
    let task = tokio::spawn(async move {
        tokio::select! { biased; _ = cancel.cancelled() => true, _ = drain(run) => false }
    });
    tokio::time::timeout(Duration::from_secs(2), provider.state.requested.notified())
        .await
        .unwrap();
    trusted.cancellation.cancel();
    assert!(
        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(trusted.trace.lock().unwrap().is_empty());
}

#[tokio::test]
async fn provider_failure_does_not_retry_or_dispatch() {
    let provider = Provider::new(Scenario::HttpFailure).await;
    let dir = tempfile::tempdir().unwrap();
    let trusted = trusted(dir.path().into());
    assert!(
        drain(runner(&agent(&provider), trusted.clone(), 4))
            .await
            .is_err()
    );
    assert_eq!(provider.requests().len(), 1);
    assert!(trusted.trace.lock().unwrap().is_empty());
}

#[tokio::test]
async fn constructing_an_unused_agent_has_no_provider_cost() {
    let provider = Provider::new(Scenario::Text).await;
    let _agent = agent(&provider);
    assert!(provider.requests().is_empty());
}

#[tokio::test]
async fn image_bytes_are_encoded_in_the_provider_message_without_a_local_path() {
    let provider = Provider::new(Scenario::Text).await;
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
    let prompt = Message::User {
        content: vec![
            UserContent::text("Describe this synthetic pixel."),
            UserContent::image_base64(image, Some(ImageMediaType::PNG), None),
        ],
    };
    let result = drain(
        agent(&provider)
            .runner(prompt)
            .max_turns(1)
            .record_content_telemetry(false),
    )
    .await
    .unwrap();
    assert!(result.finished);
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    let wire = serde_json::to_string(&requests[0]).unwrap();
    assert!(wire.contains(&format!("data:image/png;base64,{image}")));
    assert!(!wire.contains("file://"));
}

#[tokio::test]
async fn anthropic_keeps_two_labelled_images_before_the_question_on_the_wire() {
    let provider = Provider::new(Scenario::Text).await;
    let images = [
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQCpcD/BFMrqcwAAAABJRU5ErkJggg==",
    ];
    let agent = anthropic::Client::builder()
        .api_key("synthetic-key")
        .base_url(provider.url.trim_end_matches("/v1"))
        .build()
        .unwrap()
        .agent("synthetic")
        .max_tokens(64)
        .build();
    let result = drain(
        agent
            .runner(Message::User {
                content: vec![
                    UserContent::text("Selected image: original-one / output 1"),
                    UserContent::image_base64(images[0], Some(ImageMediaType::PNG), None),
                    UserContent::text("Selected image: original-two / output 2"),
                    UserContent::image_base64(images[1], Some(ImageMediaType::PNG), None),
                    UserContent::text(
                        "Compare the supplied images using their original references.",
                    ),
                ],
            })
            .max_turns(1)
            .record_content_telemetry(false),
    )
    .await
    .unwrap();
    assert!(result.finished);
    assert_eq!(result.text, "Two images received");
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    let content = requests[0]["messages"][0]["content"].as_array().unwrap();
    assert_eq!(
        content
            .iter()
            .map(|block| block["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["text", "image", "text", "image", "text"]
    );
    for (position, data) in [(1, images[0]), (3, images[1])] {
        assert_eq!(
            content[position]["source"],
            json!({"type":"base64","media_type":"image/png","data":data})
        );
    }
    assert_eq!(
        content[0]["text"],
        "Selected image: original-one / output 1"
    );
    assert_eq!(
        content[2]["text"],
        "Selected image: original-two / output 2"
    );
    assert_eq!(
        content[4]["text"],
        "Compare the supplied images using their original references."
    );
    let wire = requests[0].to_string();
    assert!(!wire.contains("file://") && !wire.contains("synthetic-key"));
}

#[path = "support/engine.rs"]
mod production;
