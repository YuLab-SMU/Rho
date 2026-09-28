//! Two independent ordinary packages over a plugin-only Host and disposable R.
use rho_contract::*;
use rho_host::NextHost;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

async fn query(host: &NextHost, cap: &str, arguments: Value) -> Value {
    host.query_snapshot(
        &NextHost::local_context(),
        QueryRequest {
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
        },
    )
    .await
    .unwrap()
    .data
    .unwrap()
}
async fn binding(host: &NextHost, instance: &Value, cap: &str, version: u16) -> Value {
    query(
        host,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":cap,"version":version}}),
    )
    .await
}
async fn invoke(
    host: &NextHost,
    request: &str,
    cap: &str,
    version: u16,
    arguments: Value,
) -> OperationRecord {
    host.invoke(
        &NextHost::local_context(),
        Invocation {
            client_request_id: request.into(),
            capability: CapabilityRef::new(cap, version).unwrap(),
            arguments,
            preconditions: vec![],
        },
    )
    .await
    .unwrap()
}
async fn succeeded(
    host: &NextHost,
    request: &str,
    cap: &str,
    version: u16,
    arguments: Value,
) -> OperationRecord {
    let result = invoke(host, request, cap, version, arguments).await;
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    result
}
struct ModelServer(tokio::task::JoinHandle<()>);
impl Drop for ModelServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[derive(Clone)]
struct Model {
    calls: Arc<AtomicUsize>,
    code: String,
}
async fn completion(
    axum::extract::State(model): axum::extract::State<Model>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> impl axum::response::IntoResponse {
    assert_eq!(headers["authorization"], "Bearer scientific-fixture-only");
    assert_eq!(body["tools"].as_array().unwrap().len(), 2);
    let count = model.calls.fetch_add(1, Ordering::SeqCst);
    let chunk = |delta: Value, finish: Value| {
        format!(
            "data: {}\n\n",
            json!({"id":"scientific-fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
        )
    };
    let mut sse = chunk(json!({"role":"assistant"}), Value::Null);
    if count == 0 {
        sse.push_str(&chunk(json!({"tool_calls":[{"index":0,"id":"original-r-call","type":"function","function":{"name":"r_execute","arguments":json!({"code":model.code}).to_string()}}]}), Value::Null));
        sse.push_str(&chunk(json!({}), json!("tool_calls")));
    } else {
        let tool = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool")
            .unwrap();
        let value: Value = serde_json::from_str(tool["content"].as_str().unwrap()).unwrap();
        assert_eq!(value["status"], "succeeded");
        assert!(value["output"]["report"].is_object());
        sse.push_str(&chunk(
            json!({"content":"Original native R result observed 中文"}),
            Value::Null,
        ));
        sse.push_str(&chunk(json!({}), json!("stop")));
    }
    sse.push_str("data: [DONE]\n\n");
    ([("content-type", "text/event-stream")], sse)
}

#[tokio::test]
#[ignore = "requires independent Agent/R packages, RHO_ARK and RHO_R_HOME; scripts/test-agent-plugin-real-r.mjs"]
async fn ordinary_agent_executes_real_r_and_retains_native_result_after_model_stop() {
    for stop in [false, true] {
        exercise(stop).await;
    }
}
async fn exercise(stop: bool) {
    let checkout = std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap();
    let archives = ["RHO_AGENT_PLUGIN_PACKAGE", "RHO_R_PLUGIN_PACKAGE"].map(|name| {
        let path =
            std::fs::canonicalize(PathBuf::from(std::env::var_os(name).expect(name))).unwrap();
        assert!(!path.starts_with(&checkout));
        snapshot_directory(&path, None, &backend_target()).unwrap()
    });
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("state/host.sqlite");
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    for archive in &archives {
        repository.import(archive).unwrap();
    }
    drop(repository);
    let host = Arc::new(NextHost::open_plugin_workspace(&db, &root).await.unwrap());
    let exercise_host = host.clone();
    let cleanup_root = root.clone();
    let result = tokio::spawn(async move {
    let host = exercise_host;
    let r = succeeded(&host,"activate-r","plugins.activate",1,json!({"revision":archives[1].revision.id,"artifact":archives[1].artifacts[0].id,"target":backend_target(),"alias":"selected-r","configuration":{"ark":std::fs::canonicalize(std::env::var_os("RHO_ARK").unwrap()).unwrap(),"r_home":std::fs::canonicalize(std::env::var_os("RHO_R_HOME").unwrap()).unwrap(),"execution_timeout_seconds":30}})).await.output.unwrap()["instance"]["identity"].clone();
    let create = binding(&host, &r, "r.create_session", 1).await;
    let session = succeeded(
        &host,
        "create-native-r",
        "r.create_session",
        1,
        json!({"binding":create,"arguments":{}}),
    )
    .await
    .output
    .unwrap()["session_id"]
        .clone();
    let agent = succeeded(&host,"activate-agent","plugins.activate",1,json!({"revision":archives[0].revision.id,"artifact":archives[0].artifacts[0].id,"target":backend_target(),"alias":"scientific-agent","configuration":{},"optional_capabilities":[{"id":"r.execute","version":2},{"id":"r.session","version":1},{"id":"operation.get","version":1},{"id":"plugins.delegated_operation","version":1}]})).await.output.unwrap()["instance"]["identity"].clone();
    let model = Model {calls:Arc::new(AtomicUsize::new(0)),code:"counter <- if (exists('counter', inherits=FALSE)) counter + 1L else 1L; writeLines('entered', 'entered-r'); while (!file.exists('release-r')) Sys.sleep(0.01); counter".into()};
    let app = axum::Router::new()
        .route("/v1/chat/completions", axum::routing::post(completion))
        .with_state(model.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = ModelServer(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let key = host.dispatch(&NextHost::local_context(),HostRequest::Control(ControlRequest {capability:CapabilityRef::new("agent.model.key.store",1).unwrap(),arguments:json!({"binding":binding(&host,&agent,"agent.model.key.store",1).await,"arguments":{"request_id":"scientific-key","value":"scientific-fixture-only"}})})).await.unwrap();
    succeeded(&host,"configure-model","agent.model.configure",1,json!({"binding":binding(&host,&agent,"agent.model.configure",1).await,"arguments":{"version":0,"enabled":true,"connection":{"protocol":"openai_completions","model":"fixture","base_url":url,"credential":key}}})).await;
    let conversation = succeeded(&host,"create-task","agent.model.create",1,json!({"binding":binding(&host,&agent,"agent.model.create",1).await,"arguments":{"conversation_id":"science-task","profile":"project"}})).await.output.unwrap();
    let mut r_binding = binding(&host, &r, "r.execute", 2).await;
    r_binding["target"] = session.clone();
    let request = json!({"binding":binding(&host,&agent,"agent.model.run",1).await,"arguments":{"request_id":"original-scientific-task","conversation_id":"science-task","conversation_version":conversation["version"],"model_settings_version":1,"text":"Run the authorized counter analysis in the selected session","mode":"run","r":r_binding}});
    if !stop {
        std::fs::write(root.join("release-r"), "continue").unwrap();
    }
    let running_host = host.clone();
    let original_request = request.clone();
    let running = tokio::spawn(async move {
        invoke(
            &running_host,
            "original-model-operation",
            "agent.model.run",
            1,
            original_request,
        )
        .await
    });
    let read = binding(&host, &agent, "agent.model.run.request", 1).await;
    if stop {
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut interval = tokio::time::interval(Duration::from_millis(20));
            while !root.join("entered-r").exists() {
                interval.tick().await;
            }
        })
        .await
        .expect("original native R execution must actually enter");
        let observed = query(
            &host,
            "agent.model.run.request",
            json!({"binding":read,"arguments":{"request_id":"original-scientific-task"}}),
        )
        .await;
        succeeded(&host,"stop-model-wait","agent.model.run.stop",1,json!({"binding":binding(&host,&agent,"agent.model.run.stop",1).await,"arguments":{"run_id":observed["run_id"]}})).await;
        assert!(
            !running.is_finished(),
            "Native parent must retain the dispatched R call after model stop"
        );
        std::fs::write(root.join("release-r"), "continue").unwrap();
    }
    let original = tokio::time::timeout(Duration::from_secs(45), running)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.status, OperationStatus::Succeeded, "{original:?}");
    let run = original.output.as_ref().unwrap();
    assert_eq!(
        run["state"],
        if stop { "stopped" } else { "completed" },
        "{run}"
    );
    let receipts = query(&host,"agent.model.run.tools",json!({"binding":binding(&host,&agent,"agent.model.run.tools",1).await,"arguments":{"run_id":run["run_id"]}})).await;
    assert_eq!(receipts.as_array().unwrap().len(), 1);
    assert_eq!(receipts[0]["phase"], "resolved", "{receipts}");
    let child_id = OperationId::new(receipts[0]["operation_id"].as_str().unwrap()).unwrap();
    let child = host
        .get_operation(&NextHost::local_context(), &child_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(child.status, OperationStatus::Succeeded);
    assert_eq!(
        child.operation.causation_id,
        Some(original.operation.operation_id.clone())
    );
    assert_eq!(child.operation.normalized_arguments["binding"], r_binding);
    assert_eq!(child.output.as_ref().unwrap()["session_id"], session);
    let inspected = query(&host,"agent.model.tool.operation",json!({"binding":binding(&host,&agent,"agent.model.tool.operation",1).await,"arguments":{"run_id":run["run_id"],"receipt_id":receipts[0]["receipt_id"]}})).await;
    assert_eq!(inspected["operation"]["operation_id"], json!(child_id));
    assert_eq!(inspected["operation"]["output"], json!(child.output));
    let repeated = succeeded(
        &host,
        "repeat-model-observation",
        "agent.model.run",
        1,
        request,
    )
    .await;
    assert_eq!(repeated.output.as_ref().unwrap()["run_id"], run["run_id"]);
    assert_eq!(model.calls.load(Ordering::SeqCst), if stop { 1 } else { 2 });
    // Real native state is preserved and the task request was not replayed.
    succeeded(&host,"verify-counter","r.execute",2,json!({"binding":r_binding,"arguments":{"expected_session":session,"run":{"code":"stopifnot(counter == 1L); counter"}}})).await;
    for instance in [&agent, &r] {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let state = query(&host, "plugins.instance", json!({"instance":instance})).await;
                if state["retained_calls"] == 0 && state["pending_messages"] == 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    for (index, instance) in [&agent, &r].into_iter().enumerate() {
        succeeded(
            &host,
            &format!("release-{index}"),
            "plugins.release",
            1,
            json!({"instance":instance}),
        )
        .await;
        succeeded(
            &host,
            &format!("remove-{index}"),
            "plugins.remove",
            1,
            json!({"revision":archives[index].revision.id}),
        )
        .await;
    }
    assert_eq!(
        host.get_operation(&NextHost::local_context(), &child_id)
            .await
            .unwrap()
            .unwrap()
            .output,
        child.output
    );
    drop(provider);
    }).await;
    // A failed assertion must not leave the disposable R fixture held at its gate.
    let _ = std::fs::write(cleanup_root.join("release-r"), "finish fixture");
    host.drain().await;
    result.unwrap();
}
