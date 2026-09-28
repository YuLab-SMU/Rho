use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Notify;

struct Port {
    active: AtomicBool,
    calls: Mutex<Vec<NativeMcpCall>>,
    pending: Mutex<Vec<oneshot::Sender<NativeMcpResult>>>,
    entered: Notify,
    completed: AtomicUsize,
    hold: bool,
}
impl Port {
    fn new(hold: bool) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicBool::new(true),
            calls: Mutex::new(vec![]),
            pending: Mutex::new(vec![]),
            entered: Notify::new(),
            completed: AtomicUsize::new(0),
            hold,
        })
    }
    fn complete(&self) {
        for sender in self.pending.lock().unwrap().drain(..) {
            self.completed.fetch_add(1, Ordering::SeqCst);
            let _ = sender.send(Ok(NativeMcpReply {
                value: json!({"retained":"original"}),
                failed: false,
            }));
        }
    }
    async fn accepted(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let changed = self.entered.notified();
                if !self.calls.lock().unwrap().is_empty() {
                    break;
                }
                changed.await;
            }
        })
        .await
        .unwrap();
    }
}
impl NativeMcpPort for Port {
    fn begin(&self, call: NativeMcpCall) -> Result<NativeMcpPending, String> {
        if !self.active.load(Ordering::SeqCst) {
            return Err("No active original task admission".into());
        }
        let (sender, receiver) = oneshot::channel();
        let large = call.arguments["large"] == true;
        let failed = call.arguments["failed"] == true;
        self.calls.lock().unwrap().push(call);
        if self.hold {
            self.pending.lock().unwrap().push(sender);
        } else {
            self.completed.fetch_add(1, Ordering::SeqCst);
            let value = if large {
                json!({"text":"x".repeat(MAX_REPLY_BYTES)})
            } else {
                json!({"answer":"科学结果"})
            };
            let _ = sender.send(Ok(NativeMcpReply { value, failed }));
        }
        self.entered.notify_waiters();
        Ok(receiver)
    }
}
fn specs() -> Vec<NativeMcpTool> {
    vec![NativeMcpTool {
        name: "fixture.call".into(),
        description: "Fixture owner callback".into(),
        parameters: json!({"type":"object"}).as_object().unwrap().clone(),
        read_only: false,
    }]
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap()
}
fn post(
    endpoint: &NativeTaskEndpoint,
    session: Option<&str>,
    value: Value,
) -> reqwest::RequestBuilder {
    let request = client()
        .post(&endpoint.url)
        .bearer_auth(&endpoint.token)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-06-18")
        .json(&value);
    if let Some(session) = session {
        request.header("mcp-session-id", session)
    } else {
        request
    }
}
async fn rpc(response: reqwest::Response) -> Value {
    assert!(
        response.status().is_success(),
        "MCP fixture HTTP status {}",
        response.status()
    );
    let bytes = response.bytes().await.unwrap();
    if let Ok(value) = serde_json::from_slice(&bytes) {
        return value;
    }
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter_map(|line| {
            line.strip_prefix("data:")
                .and_then(|data| serde_json::from_str::<Value>(data.trim()).ok())
        })
        .find(|value| value.get("id").is_some())
        .expect("A correlated MCP reply")
}
fn init() -> Value {
    json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rho-private-endpoint-fixture","version":"1"}
    }})
}
async fn initialize(endpoint: &NativeTaskEndpoint) -> String {
    let response = post(endpoint, None, init()).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let session = response.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(rpc(response).await.get("result").is_some());
    let response = post(
        endpoint,
        Some(&session),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
    )
    .send()
    .await
    .unwrap();
    assert!(response.status().is_success());
    session
}
fn call(id: Value, arguments: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"fixture.call","arguments":arguments}})
}

#[tokio::test]
async fn endpoint_uses_private_identity_and_keeps_numeric_and_text_request_ids_distinct() {
    let port = Port::new(false);
    let endpoint = native_mcp_endpoint(port.clone(), specs()).await.unwrap();
    let session = initialize(&endpoint.endpoint).await;
    let listed = rpc(post(
        &endpoint.endpoint,
        Some(&session),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .send()
    .await
    .unwrap())
    .await;
    assert_eq!(listed["result"]["tools"][0]["name"], "fixture.call");
    for id in [json!(9), json!("9")] {
        let output = rpc(post(
            &endpoint.endpoint,
            Some(&session),
            call(id.clone(), json!({"Unicode":"原始输入"})),
        )
        .send()
        .await
        .unwrap())
        .await;
        assert_eq!(output["id"], id);
        assert_eq!(output["result"]["structuredContent"]["answer"], "科学结果");
    }
    {
        let calls = port.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].session, session);
        assert_eq!(calls[0].request, json!(9));
        assert_eq!(calls[1].request, json!("9"));
        assert_eq!(calls[0].connection, calls[1].connection);
        assert!(!calls[0].connection.is_empty());
        assert_ne!(calls[0].connection, endpoint.endpoint.token);
        assert_eq!(calls[0].arguments["Unicode"], "原始输入");
    }
    // A credential and descriptor do not replace the owner's active admission.
    port.active.store(false, Ordering::SeqCst);
    let refused = rpc(post(
        &endpoint.endpoint,
        Some(&session),
        call(json!(10), json!({})),
    )
    .send()
    .await
    .unwrap())
    .await;
    assert!(refused.get("error").is_some());
    assert_eq!(port.calls.lock().unwrap().len(), 2);
    endpoint.lease.close().await.unwrap();
    assert!(endpoint.lease.is_closed());
}

#[tokio::test]
async fn separate_endpoints_refuse_token_session_origin_and_host_swaps() {
    let one_port = Port::new(false);
    let two_port = Port::new(false);
    let one = native_mcp_endpoint(one_port.clone(), specs())
        .await
        .unwrap();
    let two = native_mcp_endpoint(two_port.clone(), specs())
        .await
        .unwrap();
    let one_session = initialize(&one.endpoint).await;
    let two_session = initialize(&two.endpoint).await;
    let wrong = client()
        .post(&one.endpoint.url)
        .bearer_auth(&two.endpoint.token)
        .json(&init())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    for method in [Method::GET, Method::DELETE] {
        let response = client()
            .request(method, &two.endpoint.url)
            .bearer_auth(&two.endpoint.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-session-id", &one_session)
            .header("mcp-protocol-version", "2025-06-18")
            .send()
            .await
            .unwrap();
        assert!(!response.status().is_success());
    }
    let wrong = post(&two.endpoint, Some(&one_session), call(json!(3), json!({})))
        .send()
        .await
        .unwrap();
    assert!(!wrong.status().is_success());
    for (header, value) in [
        ("origin", "http://foreign.example"),
        ("host", "foreign.example"),
    ] {
        let response = post(&one.endpoint, Some(&one_session), call(json!(4), json!({})))
            .header(header, value)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let duplicate = post(&one.endpoint, Some(&one_session), call(json!(5), json!({})))
        .header("authorization", "Bearer extra")
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::UNAUTHORIZED);
    assert!(one_port.calls.lock().unwrap().is_empty());
    assert!(two_port.calls.lock().unwrap().is_empty());
    one.lease.close().await.unwrap();
    let closed = post(&one.endpoint, Some(&one_session), call(json!(6), json!({})))
        .send()
        .await;
    assert!(closed.is_err() || closed.unwrap().status() == StatusCode::UNAUTHORIZED);
    let output = rpc(
        post(&two.endpoint, Some(&two_session), call(json!(7), json!({})))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(output.get("result").is_some());
    assert_eq!(two_port.calls.lock().unwrap().len(), 1);
    two.lease.close().await.unwrap();
}

#[tokio::test]
async fn closing_mcp_wait_preserves_owner_work_and_fences_new_calls() {
    let port = Port::new(true);
    let endpoint = native_mcp_endpoint(port.clone(), specs()).await.unwrap();
    let session = initialize(&endpoint.endpoint).await;
    let request = post(
        &endpoint.endpoint,
        Some(&session),
        call(json!(20), json!({})),
    );
    let waiting = tokio::spawn(async move { request.send().await.unwrap().bytes().await });
    port.accepted().await;
    let cancellation = post(&endpoint.endpoint, Some(&session), json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":20,"reason":"Fixture stopped waiting"}})).send().await.unwrap();
    assert!(cancellation.status().is_success());
    waiting.abort();
    let _ = waiting.await;
    endpoint.lease.close().await.unwrap();
    assert_eq!(port.calls.lock().unwrap().len(), 1);
    assert_eq!(port.pending.lock().unwrap().len(), 1);
    assert_eq!(port.completed.load(Ordering::SeqCst), 0);
    port.complete();
    assert_eq!(port.completed.load(Ordering::SeqCst), 1);
    assert!(port.pending.lock().unwrap().is_empty());
    let repeated = post(
        &endpoint.endpoint,
        Some(&session),
        call(json!(20), json!({})),
    )
    .send()
    .await;
    assert!(repeated.is_err() || repeated.unwrap().status() == StatusCode::UNAUTHORIZED);
    assert_eq!(port.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn request_catalog_session_and_reply_bounds_preserve_original_observations() {
    let port = Port::new(false);
    let duplicate = specs().into_iter().chain(specs()).collect();
    assert!(native_mcp_endpoint(port.clone(), duplicate).await.is_err());
    let mut oversized = specs();
    oversized[0]
        .parameters
        .insert("description".into(), json!("x".repeat(MAX_CATALOG_BYTES)));
    assert!(native_mcp_endpoint(port.clone(), oversized).await.is_err());
    let endpoint = native_mcp_endpoint(port.clone(), specs()).await.unwrap();
    for id in 0..MAX_SESSIONS + 2 {
        let invalid = post(
            &endpoint.endpoint,
            None,
            json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":{}}),
        )
        .send()
        .await
        .unwrap();
        assert!(!invalid.status().is_success());
    }
    let session = initialize(&endpoint.endpoint).await;
    let large = post(
        &endpoint.endpoint,
        Some(&session),
        call(json!(30), json!({"text":"x".repeat(MAX_REQUEST_BYTES)})),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(large.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(port.calls.lock().unwrap().is_empty());
    for _ in 1..MAX_SESSIONS {
        initialize(&endpoint.endpoint).await;
    }
    let excess = post(&endpoint.endpoint, None, init()).send().await.unwrap();
    assert!(!excess.status().is_success());
    let mut unknown = call(json!(31), json!({}));
    unknown["params"]["name"] = "undeclared".into();
    let response = rpc(post(&endpoint.endpoint, Some(&session), unknown)
        .send()
        .await
        .unwrap())
    .await;
    assert!(response.get("error").is_some());
    assert!(port.calls.lock().unwrap().is_empty());
    let response = rpc(post(
        &endpoint.endpoint,
        Some(&session),
        call(json!(32), json!({"large":true})),
    )
    .send()
    .await
    .unwrap())
    .await;
    assert!(response.get("error").is_some());
    assert_eq!(port.completed.load(Ordering::SeqCst), 1);
    let response = rpc(post(
        &endpoint.endpoint,
        Some(&session),
        call(json!(33), json!({"failed":true})),
    )
    .send()
    .await
    .unwrap())
    .await;
    assert_eq!(response["result"]["isError"], true);
    assert_eq!(port.completed.load(Ordering::SeqCst), 2);
    endpoint.lease.close().await.unwrap();
}

#[tokio::test]
async fn streaming_response_retains_capacity_until_http_body_is_closed() {
    let port = Port::new(false);
    let endpoint = native_mcp_endpoint(port.clone(), specs()).await.unwrap();
    let session = initialize(&endpoint.endpoint).await;
    let stream = client()
        .get(&endpoint.endpoint.url)
        .bearer_auth(&endpoint.endpoint.token)
        .header("accept", "text/event-stream")
        .header("mcp-session-id", &session)
        .header("mcp-protocol-version", "2025-06-18")
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), StatusCode::OK);
    assert_eq!(
        endpoint.lease.shared.requests.available_permits(),
        MAX_REQUESTS - 1
    );
    assert!(port.calls.lock().unwrap().is_empty());
    drop(stream);
    tokio::time::timeout(Duration::from_secs(2), async {
        while endpoint.lease.shared.requests.available_permits() != MAX_REQUESTS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("HTTP stream drop releases its capacity");
    endpoint.lease.close().await.unwrap();
}
