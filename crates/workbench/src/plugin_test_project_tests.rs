//! The same child Host is selected at every transport boundary; no edge owns
//! scientific state or substitutes the analysis project when selection fails.
use super::*;
use axum::body::{Body, to_bytes};
use rho_contract::*;
use rho_plugin_protocol as p;
use rho_plugins::{PluginRepository, repository_path};
use serde_json::{Value, json};
use tower::ServiceExt;
#[path = "../../host/tests/fixtures/plugins.rs"]
mod fixture;

struct Test {
    _directory: tempfile::TempDir,
    app: Router,
    host: Arc<NextHost>,
    root: String,
    project: p::PluginTestProject,
    shutdown: CancellationToken,
}
impl Test {
    async fn new() -> Self {
        let (directory, state, _) = tests::fixture().await;
        let source = directory.path().join("external");
        fixture::package(&source, "1", false);
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(source.join("plugin.json")).unwrap()).unwrap();
        manifest["source"]["files"]
            .as_array_mut()
            .unwrap()
            .extend([json!("index.html"), json!("chunk.js")]);
        manifest["views"] = json!([{"id":"view","title":"Test view","entrypoint":"dist/index.html","state_schema":{},"configuration_schema":{},"resource_kinds":[]}]);
        std::fs::write(
            source.join("index.html"),
            "<!doctype html><script type=module src=./chunk.js></script>",
        )
        .unwrap();
        std::fs::write(source.join("chunk.js"), "export const project='test';").unwrap();
        for name in ["index.html", "chunk.js"] {
            std::fs::copy(source.join(name), source.join("dist").join(name)).unwrap();
        }
        std::fs::write(
            source.join("plugin.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let archive =
            rho_plugins::snapshot_directory(&source, None, &rho_plugins::backend_target()).unwrap();
        let (host, root) = {
            let hosting = state.hosting.read().await;
            PluginRepository::open(&repository_path(&hosting.profile.database))
                .unwrap()
                .import(&archive)
                .unwrap();
            let selected = hosting.selected.as_ref().unwrap();
            (
                selected.host.clone(),
                selected.root.to_string_lossy().into_owned(),
            )
        };
        let output = host.invoke(&NextHost::local_context(), invocation("create", "plugins.test_create", json!({"name":"Transport test 中文","instances":{"subject":{"plugin":archive.revision.manifest.id,"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"configuration":{},"dependencies":{}}}}))).await.unwrap();
        assert_eq!(output.status, OperationStatus::Succeeded, "{output:?}");
        let observation: p::PluginTestProjectObservation =
            serde_json::from_value(output.output.unwrap()).unwrap();
        let shutdown = CancellationToken::new();
        let app = router(state.clone(), shutdown.clone());
        Self {
            _directory: directory,
            app,
            host,
            root,
            project: observation.project,
            shutdown,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Value,
        selector: Option<&str>,
        session: Option<&str>,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "127.0.0.1:10001")
            .header(header::AUTHORIZATION, "Bearer fixture-only")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("x-rho-studio-window", "window")
            .header("mcp-protocol-version", "2025-06-18");
        if let Some(id) = selector {
            request = request.header("x-rho-test-project", id);
        }
        if let Some(id) = session {
            request = request.header("mcp-session-id", id);
        }
        self.app
            .clone()
            .oneshot(
                request
                    .body(if body.is_null() {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn port(&self, selector: Option<&str>, request: Value) -> Value {
        body(self.request("POST","/api/host",json!({"project_root":self.root,"frame":{"id":"test-frame","test_project":selector,"request":request}}),None,None).await).await
    }
    async fn query(&self, selector: Option<&str>, capability: &str, arguments: Value) -> Value {
        self.port(selector,json!({"method":"query_snapshot","params":{"capability":{"id":capability,"version":1},"arguments":arguments}})).await
    }
    async fn invoke(&self, selector: Option<&str>, capability: &str, arguments: Value) -> Value {
        self.port(selector,json!({"method":"invoke","params":{"client_request_id":uuid::Uuid::new_v4().to_string(),"capability":{"id":capability,"version":1},"arguments":arguments,"preconditions":[]}})).await
    }
    async fn initialize(&self, selector: Option<&str>) -> String {
        let response=self.request("POST","/mcp",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-project-edge","version":"1"}}}),selector,None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let session = response.headers()["mcp-session-id"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(body(response).await["result"].is_object());
        assert!(
            self.request(
                "POST",
                "/mcp",
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                selector,
                Some(&session)
            )
            .await
            .status()
            .is_success()
        );
        session
    }
    async fn close(self) {
        self.shutdown.cancel();
        self.host.drain().await;
    }
}
fn invocation(id: &str, capability: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn body(response: Response) -> Value {
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        to_bytes(response.into_body(), MAX_REPLY),
    )
    .await
    .unwrap()
    .unwrap();
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .and_then(|s| serde_json::from_str::<Value>(s.trim()).ok())
            })
            .find(|value| value.get("id").is_some())
            .unwrap()
    })
}

#[tokio::test]
async fn plugin_test_http_ports_assets_and_tokens_never_fall_back_to_analysis() {
    let t = Test::new().await;
    let id = Some(t.project.id.as_str());
    let child = t.query(id, "plugins.instances", json!({"limit":100})).await;
    assert_eq!(child["result"]["data"]["total"], 1);
    assert_eq!(
        t.query(None, "plugins.instances", json!({"limit":100}))
            .await["result"]["data"]["total"],
        0
    );
    assert_eq!(
        t.query(Some("missing"), "plugins.instances", json!({"limit":100}))
            .await["ok"],
        false
    );
    let activation = t.project.activation_operations.values().next().unwrap();
    let request = json!({"method":"get_operation","params":{"operation_id":activation}});
    assert!(t.port(None, request.clone()).await["result"].is_null());
    assert_eq!(t.port(id, request).await["result"]["status"], "succeeded");
    let instance = t.project.instances.values().next().unwrap();
    let opened=t.invoke(id,"views.open",json!({"instance":instance,"contribution":"view","window":"window","configuration":{},"state":{}})).await;
    assert_eq!(opened["result"]["status"], "succeeded", "{opened}");
    let view = &opened["result"]["output"]["view"];
    let connection =
        t.query(id, "views.connection", json!({"view":view})).await["result"]["data"].clone();
    let asset = format!(
        "/view/plugin-test/{}/{}/{}/dist/chunk.js",
        t.project.id,
        connection["connection"].as_str().unwrap(),
        connection["asset_token"].as_str().unwrap()
    );
    // Opaque iframe imports use scoped asset tokens, never the Host bearer.
    for (origin, expected) in [
        ("null", StatusCode::OK),
        ("https://foreign.invalid", StatusCode::FORBIDDEN),
    ] {
        let response = t
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&asset)
                    .header(header::HOST, "127.0.0.1:10001")
                    .header(header::ORIGIN, origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let reply = t.request("GET", &asset, Value::Null, None, None).await;
    assert_eq!(reply.status(), StatusCode::OK);
    assert_eq!(reply.headers()["access-control-allow-origin"], "*");
    assert_eq!(
        t.request(
            "GET",
            &asset.replace(&format!("plugin-test/{}", t.project.id), "plugin"),
            Value::Null,
            None,
            None
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let message = json!({"protocol_version":1,"connection":connection["connection"],"view":view,"sequence":1,"request":"read","body":{"type":"query","capability":{"id":"plugins.list","version":1},"arguments":{"limit":10}}});
    let mut call =
        json!({"project_root":t.root,"call_token":connection["call_token"],"message":message});
    assert_eq!(
        body(
            t.request("POST", "/api/plugin-view", call.clone(), None, None)
                .await
        )
        .await["ok"],
        false
    );
    call["test_project"] = json!(t.project.id);
    assert_eq!(
        body(
            t.request("POST", "/api/plugin-view", call.clone(), None, None)
                .await
        )
        .await["ok"],
        true
    );
    // Replay stays refused even though the transport selected the right project.
    assert_eq!(
        body(
            t.request("POST", "/api/plugin-view", call, None, None)
                .await
        )
        .await["ok"],
        false
    );
    let closed = t
        .invoke(
            id,
            "views.close",
            json!({"view":view,"mode":{"kind":"retain_acknowledged","expected_version":0}}),
        )
        .await;
    assert_eq!(closed["result"]["status"], "succeeded", "{closed}");
    assert_eq!(
        t.request("GET", &asset, Value::Null, None, None)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let stopped = t
        .invoke(
            None,
            "plugins.test_stop",
            json!({"id":t.project.id,"expected_version":t.project.version}),
        )
        .await;
    assert_eq!(stopped["result"]["status"], "succeeded", "{stopped}");
    assert_eq!(
        t.query(id, "plugins.instances", json!({"limit":100})).await["ok"],
        false
    );
    assert_eq!(
        t.query(None, "plugins.instances", json!({"limit":100}))
            .await["result"]["data"]["total"],
        0
    );
    t.close().await;
}

#[tokio::test]
async fn plugin_test_mcp_selection_is_fixed_for_catalog_calls_streams_and_delete() {
    let t = Test::new().await;
    let id = Some(t.project.id.as_str());
    assert_eq!(
        t.request(
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
            Some("../invalid"),
            None
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let child = t.initialize(id).await;
    let parent = t.initialize(None).await;
    let call = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rho.plugins.instances.v1","arguments":{"limit":100}}});
    let child_reply = body(
        t.request("POST", "/mcp", call.clone(), id, Some(&child))
            .await,
    )
    .await;
    assert_eq!(
        child_reply["result"]["structuredContent"]["result"]["data"]["total"], 1,
        "{child_reply}"
    );
    assert_eq!(
        t.request("POST", "/mcp", call, id, Some(&parent))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    for method in ["POST", "GET", "DELETE"] {
        let reply = t
            .request(
                method,
                "/mcp",
                json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
                None,
                Some(&child),
            )
            .await;
        assert_eq!(reply.status(), StatusCode::FORBIDDEN);
    }
    let catalog = body(
        t.request(
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}),
            id,
            Some(&child),
        )
        .await,
    )
    .await;
    let tools = catalog["result"]["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "rho.fixture.read.v1")
    );
    assert!(
        !tools
            .iter()
            .any(|tool| tool["name"] == "rho.plugins.test_create.v1")
    );
    let stop = t
        .invoke(
            None,
            "plugins.test_stop",
            json!({"id":t.project.id,"expected_version":t.project.version}),
        )
        .await;
    assert_eq!(stop["result"]["status"], "failed");
    assert!(
        t.request("DELETE", "/mcp", Value::Null, id, Some(&child))
            .await
            .status()
            .is_success()
    );
    assert!(
        t.request("DELETE", "/mcp", Value::Null, None, Some(&parent))
            .await
            .status()
            .is_success()
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !t.host.is_idle() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let stop = t
        .invoke(
            None,
            "plugins.test_stop",
            json!({"id":t.project.id,"expected_version":t.project.version}),
        )
        .await;
    assert_eq!(stop["result"]["status"], "succeeded", "{stop}");
    assert_eq!(
        t.request(
            "POST",
            "/mcp",
            json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
            id,
            None
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    t.close().await;
}
