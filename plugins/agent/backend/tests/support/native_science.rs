use super::*;
use std::time::Duration;

fn binding() -> Value {
    json!({"capability":{"id":"r.execute","version":2},"provider":{"plugin":"org.fixture.science","instance":"science-one","revision":format!("sha256:{}","c".repeat(64)),"artifact":format!("sha256:{}","d".repeat(64))},"project":"project-one","target":"original-session"})
}
fn inspection() -> Value {
    let b = binding();
    let mut manifest = json!(manifest::manifest());
    manifest["id"] = b["provider"]["plugin"].clone();
    manifest["capabilities"] = json!([{
        "capability":b["capability"],"kind":"operation","title":"Execute","description":"Captured native scientific tool",
        "input_schema":{"type":"object","additionalProperties":false,"properties":{"code":{"type":"string"}},"required":["code"]},
        "examples":[],"output_schema":{},"recovery_schema":{},"required_scopes":["workspace.run_r"],"effects":["r.execution"],"cancellation":"unsupported","preflight":null
    }]);
    json!({"summary":{"revision":b["provider"]["revision"],"plugin":b["provider"]["plugin"],"name":"Fixture","version":"1","description":"Independent scientific provider","artifacts":[b["provider"]["artifact"]],"reference_count":0},"manifest":manifest,"parent":null,"source_file_count":1,"artifacts":[{"id":b["provider"]["artifact"],"target":"fixture","file_count":1}]})
}
fn scientific(request: &str, cap: &str, input: Value, operation: bool) -> PluginCall {
    let mut call = call(request, cap, input, operation);
    call.scopes.extend([
        "workspace.run_r".into(),
        "workspace.read".into(),
        "operation.read".into(),
    ]);
    call
}
async fn fixture_tools(factory: Arc<Factory>, with_inspection: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let project = root.join("project");
    let data = root.join("instance");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&data).unwrap();
    let environment = BackendEnvironment {
        project_root: project.to_str().unwrap().into(),
        data_root: data.to_str().unwrap().into(),
    };
    let mut grants = SCIENTIFIC_GRANTS.to_vec();
    if with_inspection {
        grants.push("plugins.inspect")
    }
    Fixture::open_with_factory(directory, environment, &grants, factory).await
}
async fn answer(f: &mut Fixture, frame: RpcFrame, data: Value) {
    f.writer
        .send(
            frame.request,
            RpcBody::HostResult {
                result: json!({"status":"ready","completeness":"complete","data":data}),
            },
        )
        .await
        .unwrap();
}
async fn begin(f: &mut Fixture, native: &PluginCall) {
    f.writer
        .send(native.request.clone(), RpcBody::Invoke(native.clone()))
        .await
        .unwrap();
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, .. } if parent_request==&native.request && capability==&manifest::key("views.caller"))
    );
    answer(f, frame, origin("view-one")).await;
}
async fn grant(f: &mut Fixture, native: &PluginCall, catalog: Value, caller: Value) {
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, arguments } if parent_request==&native.request && capability==&manifest::key("plugins.inspect") && arguments==&json!({"revision":binding()["provider"]["revision"]}))
    );
    answer(f, frame, catalog).await;
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, .. } if parent_request==&native.request && capability==&manifest::key("views.caller"))
    );
    answer(f, frame, caller).await;
}
async fn draft(f: &mut Fixture, value: &Value, text: &str) -> Value {
    f.native_action(&format!("draft-{}",uuid::Uuid::new_v4()),action(json!({"kind":"save_draft","control":control(value),"version":value["detail"]["draft"]["version"],"content":{"text":text,"assets":[],"context":[]}}))).await
}
fn send(value: &Value) -> Value {
    let mut input = action(
        json!({"kind":"send","control":control(value),"draft_version":value["detail"]["draft"]["version"]}),
    );
    input["tools"] = json!([{"name":"execute","target":{"type":"provider","binding":binding()}}]);
    input
}
#[derive(Clone)]
struct Mcp {
    url: String,
    token: String,
    session: Option<String>,
}
impl Mcp {
    async fn request(&self, value: Value) -> reqwest::Response {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap();
        let mut request = client
            .post(&self.url)
            .bearer_auth(&self.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18")
            .json(&value);
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session);
        }
        request.send().await.unwrap()
    }
    async fn connect(factory: &Factory) -> Self {
        let (url, token) = factory.endpoints.lock().unwrap()[0].clone();
        let mut m = Self {
            url,
            token,
            session: None,
        };
        let response=m.request(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"native-scientific-fixture","version":"1"}}})).await;
        m.session = Some(
            response.headers()["mcp-session-id"]
                .to_str()
                .unwrap()
                .into(),
        );
        assert!(rpc(response).await.get("result").is_some());
        assert!(
            m.request(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
                .await
                .status()
                .is_success()
        );
        m
    }
    async fn call(&self, input: Value) -> Value {
        rpc(self.request(json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":"tools/call","params":{"name":"rho_call","arguments":input}})).await).await
    }
    fn start(&self, input: Value) -> tokio::task::JoinHandle<Value> {
        let m = self.clone();
        tokio::spawn(async move { m.call(input).await })
    }
}
async fn rpc(response: reqwest::Response) -> Value {
    assert!(response.status().is_success());
    let bytes = response.bytes().await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or_else(|_| {
        String::from_utf8(bytes.to_vec())
            .unwrap()
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .and_then(|data| serde_json::from_str::<Value>(data.trim()).ok())
            })
            .find(|v| v.get("id").is_some())
            .unwrap()
    })
}
fn rejected(value: Value) {
    assert!(
        value.get("error").is_some() || value["result"]["isError"] == true,
        "{value}"
    );
}
async fn sent(factory: &Factory, count: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while factory.sends.load(Ordering::SeqCst) < count {
            tokio::task::yield_now().await
        }
    })
    .await
    .unwrap();
}
fn scientific_record(f: &Fixture, parent: &PluginCall, request: &Value) -> Value {
    json!({"operation":{"operation_id":"original-native-scientific-operation","caller":{"kind":"plugin","id":"agent-one"},"causation_id":parent.operation_id,"idempotency_scope":f.environment.project_root,"capability":request["binding"]["capability"],"normalized_arguments":request,"admission":{"owner_context":{"binding":request["binding"]}}},"status":"succeeded","output":{"value":"original result 数据"},"error":null,"recovery":null,"cancellation_requested":false})
}
async fn inspect_original(
    f: &mut Fixture,
    parent: &PluginCall,
    tool: &Value,
    original: &RequestId,
    record: Value,
) {
    let query = scientific(
        "inspect-original-tool",
        "agent.native.tool.operation",
        json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
        false,
    );
    f.writer
        .send(query.request.clone(), RpcBody::Query(query.clone()))
        .await
        .unwrap();
    let frame = f.read().await;
    assert!(
        matches!(&frame.body,RpcBody::HostCall {parent_request,capability,arguments} if parent_request==&query.request && capability==&manifest::key("plugins.delegated_operation") && arguments==&json!({"parent_operation":parent.operation_id,"request":original}))
    );
    answer(
        f,
        frame,
        json!({"operation_id":record["operation"]["operation_id"]}),
    )
    .await;
    let frame = f.read().await;
    assert!(
        matches!(&frame.body,RpcBody::HostCall {parent_request,capability,arguments} if parent_request==&query.request && capability==&manifest::key("operation.get") && arguments==&json!({"operation_id":record["operation"]["operation_id"]}))
    );
    answer(f, frame, json!({"record":record})).await;
    let frame = f.read().await;
    assert_eq!(frame.request, query.request);
    let RpcBody::QueryResult {
        data, completeness, ..
    } = frame.body
    else {
        panic!("{frame:?}")
    };
    assert_eq!(completeness, ObservationCompleteness::Complete);
    assert_eq!(data["operation"]["status"], "succeeded");
}

#[tokio::test]
async fn native_science_preserves_partial_queries_and_refuses_unverified_or_oversized_results() {
    for variant in [
        "query",
        "cached",
        "invalid-query",
        "wrong-parent",
        "wrong-precondition",
        "oversized",
    ] {
        let factory = Arc::new(Factory::default());
        factory.hold.store(true, Ordering::SeqCst);
        let mut f = fixture_tools(factory.clone(), true).await;
        let created = f.native_create().await;
        let saved = draft(&mut f, &created, "Observe the original tool").await;
        let mut input = send(&saved);
        let mut catalog = inspection();
        let is_query = matches!(variant, "query" | "cached" | "invalid-query");
        if is_query {
            input["tools"][0]["target"]["binding"]["capability"] =
                json!({"id":"r.session","version":1});
            catalog["manifest"]["capabilities"][0]["capability"] =
                input["tools"][0]["target"]["binding"]["capability"].clone();
            catalog["manifest"]["capabilities"][0]["kind"] = "query".into();
            catalog["manifest"]["capabilities"][0]["required_scopes"] = json!(["workspace.read"]);
        }
        let native = scientific(
            "bounded-native-tool",
            "agent.native.command",
            input.clone(),
            true,
        );
        begin(&mut f, &native).await;
        grant(&mut f, &native, catalog, origin("view-one")).await;
        sent(&factory, 1).await;
        let mcp = Mcp::connect(&factory).await;
        let tool = json!({"send_request":input["request_id"],"tool_request":uuid::Uuid::new_v4().to_string(),"tool":"execute","arguments":{"code":"original"},"preconditions":{"expected":"original"}});
        let waiting = mcp.start(tool.clone());
        let child = f.read().await;
        let RpcBody::HostCall { arguments, .. } = &child.body else {
            panic!("{child:?}")
        };
        let mut result = if is_query {
            json!({"status":"busy","completeness":if variant=="cached" {"cached"} else {"partial"},"data":{"last_known":"preserved"}})
        } else {
            scientific_record(&f, &native, arguments)
        };
        match variant {
            "invalid-query" => result["completeness"] = "fabricated".into(),
            "wrong-parent" => result["operation"]["causation_id"] = "another-parent".into(),
            "wrong-precondition" => {
                result["operation"]["normalized_arguments"]["preconditions"] =
                    json!({"expected":"another"})
            }
            "oversized" => result["output"] = json!("x".repeat(100 * 1024)),
            _ => (),
        }
        f.writer
            .send(child.request, RpcBody::HostResult { result })
            .await
            .unwrap();
        let observed = waiting.await.unwrap();
        assert_eq!(observed["result"]["isError"], true, "{variant}: {observed}");
        let receipt = f
            .query(
                "agent.native.tool",
                json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
            )
            .await;
        let partial = matches!(variant, "query" | "cached");
        assert_eq!(
            receipt["phase"],
            if partial { "resolved" } else { "uncertain" },
            "{receipt}"
        );
        if partial {
            assert_eq!(receipt["result"]["data"]["last_known"], "preserved");
            assert!(receipt["operation"].is_null());
        } else {
            assert!(receipt["result"].is_null());
            assert_eq!(receipt["operation"].is_string(), variant == "oversized");
        }
        finish(&factory);
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!("{frame:?}")
        };
        assert_eq!(
            plan.outcome,
            if partial {
                PluginOutcome::Succeeded
            } else {
                PluginOutcome::Uncertain
            }
        );
        f.settle(&native, plan.outcome).await;
        f.release().await;
    }
}
#[tokio::test]
async fn native_science_retains_original_send_and_child_after_dropped_wait_and_stop_without_replay()
{
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = fixture_tools(factory.clone(), true).await;
    let created = f.native_create().await;
    let saved = draft(&mut f, &created, "Run the captured scientific tool").await;
    let connected = f
        .native_action(
            "connect-before-send",
            action(json!({"kind":"connect","control":control(&saved)})),
        )
        .await;
    let mcp = Mcp::connect(&factory).await;
    let mut input = send(&connected);
    let original_send = input["request_id"].clone();
    let native = scientific(
        "native-science-send",
        "agent.native.command",
        input.clone(),
        true,
    );
    begin(&mut f, &native).await;
    grant(&mut f, &native, inspection(), origin("view-one")).await;
    sent(&factory, 1).await;
    let tool = json!({"send_request":original_send,"tool_request":uuid::Uuid::new_v4().to_string(),"tool":"execute","arguments":{"code":"original scientific input 中文"},"preconditions":null});
    let mut forged = tool.clone();
    forged["binding"] = binding();
    rejected(mcp.call(forged).await);
    for arguments in [
        json!({"code":"original", "author":{"kind":"human","id":"forged"}}),
        json!({"code":12}),
        json!({}),
    ] {
        let mut invalid = tool.clone();
        invalid["arguments"] = arguments;
        let refusal = mcp.call(invalid).await;
        assert_eq!(refusal["error"]["code"], -32602, "{refusal}");
        assert!(
            refusal["error"]["message"]
                .as_str()
                .unwrap()
                .contains("schema")
        );
    }
    // Reuse the same tool request after correction. Invalid input never reached
    // Host or occupied the original receipt; this is the first scientific child.
    let wait = mcp.start(tool.clone());
    let child = f.read().await;
    let RpcBody::HostCall {
        parent_request,
        capability,
        arguments,
    } = &child.body
    else {
        panic!("{child:?}")
    };
    assert_eq!(parent_request, &native.request);
    assert_ne!(parent_request, &id("connect-before-send"));
    assert_eq!(capability.id.as_str(), "r.execute");
    assert_eq!(arguments["binding"], binding());
    let mut result = scientific_record(&f, &native, arguments);
    result["operation"]["operation_id"] = "earlier-scientific-operation".into();
    wait.abort();
    assert!(wait.await.unwrap_err().is_cancelled());
    f.writer
        .send(child.request, RpcBody::HostResult { result })
        .await
        .unwrap();
    // This identical retry can arrive before or after result persistence. The
    // native turn remains running, so either path observes the one original call.
    let observed = mcp.call(tool.clone()).await;
    assert_eq!(
        observed["result"]["structuredContent"]["result"]["status"], "succeeded",
        "{observed}"
    );
    let mut changed = tool.clone();
    changed["arguments"]["code"] = "changed effect".into();
    rejected(mcp.call(changed).await);
    let mut tool = tool;
    tool["tool_request"] = json!(uuid::Uuid::new_v4().to_string());
    let retry = mcp.start(tool.clone());
    let child = f.read().await;
    let RpcBody::HostCall {
        parent_request,
        arguments,
        ..
    } = &child.body
    else {
        panic!("{child:?}")
    };
    assert_eq!(parent_request, &native.request);
    let child_request = child.request.clone();
    let result = scientific_record(&f, &native, arguments);
    let current = f
        .query(
            "agent.native.task",
            json!({"task_id":connected["detail"]["summary"]["task"]["task_id"]}),
        )
        .await;
    let stop = f
        .native_action(
            "stop-scientific-agent",
            action(json!({"kind":"stop","control":control(&json!({"detail":current}))})),
        )
        .await;
    assert_eq!(stop["receipt"]["status"], "succeeded");
    let receipt = f
        .query(
            "agent.native.tool",
            json!({"send_request":original_send,"tool_request":tool["tool_request"]}),
        )
        .await;
    assert_eq!(receipt["phase"], "prepared");
    assert_eq!(receipt["request"], json!(child_request));
    assert!(
        tokio::time::timeout(Duration::from_millis(40), f.reader.receive())
            .await
            .is_err(),
        "Original Send must await its accepted scientific child"
    );
    let mut later = tool.clone();
    later["tool_request"] = json!(uuid::Uuid::new_v4().to_string());
    rejected(mcp.call(later).await);
    f.writer
        .send(
            child.request,
            RpcBody::HostResult {
                result: result.clone(),
            },
        )
        .await
        .unwrap();
    let delivered = retry.await.unwrap();
    assert_ne!(delivered["result"]["isError"], true);
    assert_eq!(
        delivered["result"]["structuredContent"]["result"]["status"],
        "succeeded"
    );
    let frame = f.read().await;
    assert_eq!(frame.request, native.request);
    let RpcBody::CommitPlan(plan) = frame.body else {
        panic!("{frame:?}")
    };
    assert_eq!(plan.outcome, PluginOutcome::Failed);
    f.settle(&native, plan.outcome).await;
    let receipt = f
        .query(
            "agent.native.tool",
            json!({"send_request":original_send,"tool_request":tool["tool_request"]}),
        )
        .await;
    assert_eq!(receipt["phase"], "resolved");
    assert_eq!(receipt["operation"], "original-native-scientific-operation");
    inspect_original(&mut f, &native, &tool, &child_request, result).await;
    // The same native endpoint serves the next Send, with a distinct authority.
    let current = f
        .query(
            "agent.native.task",
            json!({"task_id":connected["detail"]["summary"]["task"]["task_id"]}),
        )
        .await;
    let saved = draft(&mut f, &json!({"detail":current}), "Next independent Send").await;
    input = send(&saved);
    let second = scientific("native-science-second", "agent.native.command", input, true);
    begin(&mut f, &second).await;
    grant(&mut f, &second, inspection(), origin("view-one")).await;
    sent(&factory, 2).await;
    assert_eq!(factory.opens.load(Ordering::SeqCst), 1);
    rejected(mcp.call(tool).await);
    finish(&factory);
    let frame = f.read().await;
    assert_eq!(frame.request, second.request);
    let RpcBody::CommitPlan(plan) = frame.body else {
        panic!("{frame:?}")
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded);
    f.settle(&second, plan.outcome).await;
    f.release().await;
}

#[tokio::test]
async fn native_science_disconnect_retains_uncertainty_and_only_observes_original_child_after_reopen()
 {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = fixture_tools(factory.clone(), true).await;
    let created = f.native_create().await;
    let saved = draft(&mut f, &created, "Original scientific intent").await;
    let input = send(&saved);
    let native = scientific(
        "interrupted-native-science",
        "agent.native.command",
        input.clone(),
        true,
    );
    begin(&mut f, &native).await;
    grant(&mut f, &native, inspection(), origin("view-one")).await;
    sent(&factory, 1).await;
    let mcp = Mcp::connect(&factory).await;
    let tool = json!({"send_request":input["request_id"],"tool_request":uuid::Uuid::new_v4().to_string(),"tool":"execute","arguments":{"code":"retain exactly once"},"preconditions":null});
    let waiting = mcp.start(tool.clone());
    let child = f.read().await;
    let RpcBody::HostCall {
        parent_request,
        arguments,
        ..
    } = &child.body
    else {
        panic!("{child:?}")
    };
    assert_eq!(parent_request, &native.request);
    let record = scientific_record(&f, &native, arguments);
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    let Fixture {
        directory,
        environment,
        reader,
        writer,
        task,
    } = f;
    drop(reader);
    drop(writer);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    let grants = [
        "plugins.inspect",
        "r.execute",
        "r.session",
        "operation.get",
        "plugins.delegated_operation",
    ];
    let mut f = Fixture::open_with_factory(directory, environment, &grants, factory.clone()).await;
    let receipt = f
        .query(
            "agent.native.tool",
            json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
        )
        .await;
    assert_eq!(receipt["phase"], "uncertain");
    assert_eq!(receipt["request"], json!(child.request));
    assert_eq!(
        receipt["native_request"]["request"]["arguments"],
        tool["arguments"]
    );
    // A missing durable child is partial evidence, never an invitation to
    // dispatch again. A cached identity is likewise not a fresh confirmation.
    for observation in [
        json!({"status":"ready","completeness":"partial","data":{"operation_id":null}}),
        json!({"status":"busy","completeness":"cached","data":{"operation_id":"cached-child"}}),
        json!({"status":"unavailable","completeness":"unavailable","data":null}),
    ] {
        let read = scientific(
            "read-missing-original",
            "agent.native.tool.operation",
            json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
            false,
        );
        f.writer
            .send(read.request.clone(), RpcBody::Query(read.clone()))
            .await
            .unwrap();
        let frame = f.read().await;
        assert!(
            matches!(&frame.body, RpcBody::HostCall { parent_request, capability, arguments }
            if parent_request == &read.request && capability == &manifest::key("plugins.delegated_operation")
                && arguments == &json!({"parent_operation":native.operation_id,"request":child.request}))
        );
        f.writer
            .send(
                frame.request,
                RpcBody::HostResult {
                    result: observation,
                },
            )
            .await
            .unwrap();
        let frame = f.read().await;
        assert_eq!(frame.request, read.request);
        let RpcBody::QueryResult {
            data, completeness, ..
        } = frame.body
        else {
            panic!("{frame:?}")
        };
        assert_eq!(completeness, ObservationCompleteness::Partial);
        assert_eq!(data["completeness"], "partial");
        assert_eq!(data["request"], json!(child.request));
        assert!(data["operation"].is_null());
        assert_eq!(
            f.query(
                "agent.native.tool",
                json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]})
            )
            .await,
            receipt
        );
    }
    inspect_original(&mut f, &native, &tool, &child.request, record).await;
    let later = f
        .query(
            "agent.native.tool",
            json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
        )
        .await;
    assert_eq!(
        later, receipt,
        "A journal lookup must not rewrite an unresolved native receipt"
    );
    assert_eq!(factory.opens.load(Ordering::SeqCst), 1);
    assert_eq!(factory.sends.load(Ordering::SeqCst), 1);
    f.release().await;
}

#[tokio::test]
async fn native_science_revalidates_manifest_grants_and_live_caller_before_native_launch() {
    for variant in [
        "missing-grant",
        "wrong-kind",
        "wrong-version",
        "changed-caller",
    ] {
        let factory = Arc::new(Factory::default());
        let mut f = fixture_tools(factory.clone(), variant != "missing-grant").await;
        let created = f.native_create().await;
        let saved = draft(&mut f, &created, "Preserve this original draft").await;
        let native = scientific(
            "refused-native-science",
            "agent.native.command",
            send(&saved),
            true,
        );
        begin(&mut f, &native).await;
        if variant != "missing-grant" {
            let frame = f.read().await;
            let mut catalog = inspection();
            if variant == "wrong-kind" {
                catalog["manifest"]["capabilities"][0]["kind"] = "control".into()
            }
            if variant == "wrong-version" {
                catalog["summary"]["revision"] = json!(format!("sha256:{}", "e".repeat(64)))
            }
            answer(&mut f, frame, catalog).await;
            if variant == "changed-caller" {
                let frame = f.read().await;
                let mut changed = origin("view-one");
                changed["view"]["connection"] = "replacement".into();
                answer(&mut f, frame, changed).await;
            }
        }
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!("{frame:?}")
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed);
        f.settle(&native, plan.outcome).await;
        assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
        assert_eq!(factory.sends.load(Ordering::SeqCst), 0);
        let current = f
            .query(
                "agent.native.task",
                json!({"task_id":created["detail"]["summary"]["task"]["task_id"]}),
            )
            .await;
        assert_eq!(
            current["draft"]["content"]["text"],
            "Preserve this original draft"
        );
        f.release().await;
    }
}

#[tokio::test]
async fn native_science_multiple_owners_keep_distinct_bindings_under_one_send() {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let environment = BackendEnvironment {
        project_root: root.join("project").to_str().unwrap().into(),
        data_root: root.join("instance").to_str().unwrap().into(),
    };
    std::fs::create_dir(&environment.project_root).unwrap();
    std::fs::create_dir(&environment.data_root).unwrap();
    let mut f = Fixture::open_with_factory(
        directory,
        environment,
        &[
            "plugins.inspect",
            "operation.get",
            "plugins.delegated_operation",
            "files.apply_patch",
            "process.run_local",
            "environment.status",
        ],
        factory.clone(),
    )
    .await;
    let created = f.native_create().await;
    let saved = draft(&mut f, &created, "Use the explicitly selected providers").await;
    let mut input = send(&saved);
    let peers = [
        (
            "files.apply_patch",
            1,
            "operation",
            vec!["project.read", "project.write"],
        ),
        (
            "process.run_local",
            2,
            "operation",
            vec!["project.read", "process.run_local"],
        ),
        (
            "environment.status",
            1,
            "query",
            vec!["project.read", "environment.read"],
        ),
    ];
    let selections: Vec<_> = peers
        .iter()
        .enumerate()
        .map(|(index, (name, version, _, _))| {
            let mut selected = binding();
            selected["capability"] = json!({"id":name,"version":version});
            selected["provider"]["plugin"] = json!(format!("org.fixture.peer{index}"));
            selected["provider"]["instance"] = json!(format!("peer-{index}"));
            selected["provider"]["revision"] =
                json!(format!("sha256:{}", index.to_string().repeat(64)));
            selected["target"] = json!(format!("captured-target-{index}"));
            json!({"name":format!("tool{index}"),"target":{"type":"provider","binding":selected}})
        })
        .collect();
    input["tools"] = json!(selections);
    let mut native = scientific(
        "multiple-native-owners",
        "agent.native.command",
        input.clone(),
        true,
    );
    for (_, _, _, scopes) in &peers {
        native
            .scopes
            .extend(scopes.iter().map(|scope| (*scope).to_owned()));
    }
    begin(&mut f, &native).await;
    for (index, (_, _, kind, scopes)) in peers.iter().enumerate() {
        let frame = f.read().await;
        let selected = &selections[index]["target"]["binding"];
        assert!(
            matches!(&frame.body, RpcBody::HostCall { parent_request, capability, arguments }
            if parent_request == &native.request && capability == &manifest::key("plugins.inspect")
                && arguments == &json!({"revision":selected["provider"]["revision"]}))
        );
        let mut catalog = inspection();
        catalog["summary"]["revision"] = selected["provider"]["revision"].clone();
        catalog["summary"]["plugin"] = selected["provider"]["plugin"].clone();
        catalog["manifest"]["id"] = selected["provider"]["plugin"].clone();
        catalog["manifest"]["capabilities"][0]["capability"] = selected["capability"].clone();
        catalog["manifest"]["capabilities"][0]["kind"] = json!(kind);
        catalog["manifest"]["capabilities"][0]["required_scopes"] = json!(scopes);
        answer(&mut f, frame, catalog).await;
    }
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { capability, .. } if capability == &manifest::key("views.caller"))
    );
    answer(&mut f, frame, origin("view-one")).await;
    sent(&factory, 1).await;
    let mcp = Mcp::connect(&factory).await;
    let mut requests = std::collections::BTreeSet::new();
    for (index, (_, _, kind, _)) in peers.iter().enumerate() {
        let tool = json!({"send_request":input["request_id"],"tool_request":uuid::Uuid::new_v4().to_string(),"tool":format!("tool{index}"),"arguments":{"code":format!("original input {index}")},"preconditions":{"expected":format!("native-state-{index}")}});
        let waiting = mcp.start(tool.clone());
        let child = f.read().await;
        let RpcBody::HostCall {
            parent_request,
            capability,
            arguments,
        } = &child.body
        else {
            panic!("{child:?}")
        };
        assert_eq!(parent_request, &native.request);
        assert_eq!(
            json!(capability),
            selections[index]["target"]["binding"]["capability"]
        );
        assert_eq!(arguments["binding"], selections[index]["target"]["binding"]);
        assert_eq!(arguments["arguments"], tool["arguments"]);
        assert_eq!(arguments["preconditions"], tool["preconditions"]);
        assert!(requests.insert(child.request.clone()));
        let result = if *kind == "query" {
            json!({"status":"ready","completeness":"complete","data":{"provider":index}})
        } else {
            let mut record = scientific_record(&f, &native, arguments);
            record["operation"]["operation_id"] = json!(format!("scientific-child-{index}"));
            record
        };
        f.writer
            .send(child.request, RpcBody::HostResult { result })
            .await
            .unwrap();
        let original = waiting.await.unwrap();
        assert_ne!(original["result"]["isError"], true, "{original}");
        let repeated = mcp.call(tool.clone()).await;
        assert_eq!(repeated["result"], original["result"]);
        let receipt = f
            .query(
                "agent.native.tool",
                json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
            )
            .await;
        assert_eq!(receipt["phase"], "resolved");
        assert_eq!(
            receipt["native_request"]["request"]["binding"],
            selections[index]["target"]["binding"]
        );
        assert_eq!(receipt["operation"].is_null(), *kind == "query");
    }
    finish(&factory);
    let frame = f.read().await;
    assert_eq!(frame.request, native.request);
    let RpcBody::CommitPlan(plan) = frame.body else {
        panic!("{frame:?}")
    };
    assert_eq!(plan.outcome, PluginOutcome::Succeeded);
    f.settle(&native, plan.outcome).await;
    f.release().await;
}

#[tokio::test]
async fn native_science_peer_tools_require_both_activation_grants_and_original_scopes() {
    for (name, version, scopes) in [
        (
            "files.apply_patch",
            1,
            vec!["project.read", "project.write"],
        ),
        (
            "process.run_local",
            2,
            vec!["project.read", "process.run_local"],
        ),
        ("slurm.submit", 2, vec!["project.read", "slurm.write"]),
        (
            "environment.status",
            1,
            vec!["project.read", "environment.read"],
        ),
        ("editor.context.search", 1, vec!["documents.read"]),
    ] {
        for missing_grant in [true, false] {
            let factory = Arc::new(Factory::default());
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let environment = BackendEnvironment {
                project_root: root.join("project").to_str().unwrap().into(),
                data_root: root.join("instance").to_str().unwrap().into(),
            };
            std::fs::create_dir(&environment.project_root).unwrap();
            std::fs::create_dir(&environment.data_root).unwrap();
            let mut optional = vec![
                "plugins.inspect",
                "operation.get",
                "plugins.delegated_operation",
            ];
            if !missing_grant {
                optional.push(name);
            }
            let mut f =
                Fixture::open_with_factory(directory, environment, &optional, factory.clone())
                    .await;
            let created = f.native_create().await;
            let saved = draft(&mut f, &created, "Retain this draft on refusal").await;
            let mut input = send(&saved);
            input["tools"][0]["target"]["binding"]["capability"] =
                json!({"id":name,"version":version});
            let mut native = scientific("refused-peer-tool", "agent.native.command", input, true);
            if missing_grant {
                native
                    .scopes
                    .extend(scopes.iter().map(|scope| (*scope).to_owned()));
            }
            begin(&mut f, &native).await;
            let frame = f.read().await;
            let mut catalog = inspection();
            catalog["manifest"]["capabilities"][0]["capability"] =
                json!({"id":name,"version":version});
            catalog["manifest"]["capabilities"][0]["kind"] = json!(if matches!(
                name,
                "environment.status" | "editor.context.search"
            ) {
                "query"
            } else {
                "operation"
            });
            catalog["manifest"]["capabilities"][0]["required_scopes"] = json!(scopes);
            answer(&mut f, frame, catalog).await;
            let frame = f.read().await;
            assert_eq!(frame.request, native.request);
            let RpcBody::CommitPlan(plan) = frame.body else {
                panic!("{frame:?}")
            };
            assert_eq!(
                plan.outcome,
                PluginOutcome::Failed,
                "{name}: missing_grant={missing_grant}"
            );
            f.settle(&native, plan.outcome).await;
            assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
            assert_eq!(factory.sends.load(Ordering::SeqCst), 0);
            f.release().await;
        }
    }
}

include!("native_host_tools.rs");
