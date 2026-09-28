// Included by native_science so both targets exercise the same framed backend,
// native connection and real private-MCP transport helpers.
async fn host_fixture(factory: Arc<Factory>, optional: &[&str]) -> Fixture {
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
    Fixture::open_with_factory(directory, environment, optional, factory).await
}
fn host_contract(name: &str) -> Value {
    let checkpoint = name == "plugins.checkpoint";
    json!({"project":"project-one","capability":{"id":name,"version":1},
        "kind":if checkpoint {"operation"}else{"query"},"description":"Read or checkpoint the captured branch",
        "input_schema":if checkpoint {
            json!({"type":"object","properties":{"branch":{"type":"string"},"expected_head":{"type":"string"},"changes":{"type":"object"},"native_default":{"type":["string","null"]}},"required":["branch","expected_head","changes"],"additionalProperties":false})
        }else{json!({"type":"object","properties":{"branch":{"type":"string"}},"required":["branch"],"additionalProperties":false})},
        "required_scopes":[if checkpoint {"plugins.write"}else{"plugins.read"}]})
}
fn host_send(value: &Value, names: &[&str]) -> Value {
    let mut input = action(
        json!({"kind":"send","control":control(value),"draft_version":value["detail"]["draft"]["version"]}),
    );
    input["tools"] = names
        .iter()
        .map(|name| {
            json!({"name":name,"target":{"type":"host","project":"project-one",
        "capability":{"id":name,"version":1},"fixed_arguments":{"branch":"chosen-branch"}}})
        })
        .collect();
    input
}
async fn host_descriptor(f: &mut Fixture, native: &PluginCall, name: &str, descriptor: Value) {
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, arguments }
        if parent_request == &native.request && capability == &manifest::key("host.core_contract")
            && arguments == &json!({"capability":{"id":name,"version":1}}))
    );
    answer(f, frame, descriptor).await;
}
async fn host_caller(f: &mut Fixture, native: &PluginCall) {
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, .. }
        if parent_request == &native.request && capability == &manifest::key("views.caller"))
    );
    answer(f, frame, origin("view-one")).await;
}
#[tokio::test]
async fn native_host_tools_capture_branch_and_correlate_normalized_original_operation() {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = host_fixture(
        factory.clone(),
        &[
            "host.core_contract",
            "plugins.branch_head",
            "plugins.checkpoint",
            "operation.get",
            "plugins.delegated_operation",
        ],
    )
    .await;
    let created = f.native_create().await;
    let saved = draft(
        &mut f,
        &created,
        "Checkpoint the selected branch; do not build or apply",
    )
    .await;
    let input = host_send(&saved, &["plugins.branch_head", "plugins.checkpoint"]);
    let mut native = scientific(
        "native-host-tools",
        "agent.native.command",
        input.clone(),
        true,
    );
    native.scopes.insert("plugins.write".into());
    begin(&mut f, &native).await;
    for name in ["plugins.branch_head", "plugins.checkpoint"] {
        host_descriptor(&mut f, &native, name, host_contract(name)).await;
    }
    host_caller(&mut f, &native).await;
    sent(&factory, 1).await;
    let mcp = Mcp::connect(&factory).await;
    let read = json!({"send_request":input["request_id"],"tool_request":uuid::Uuid::new_v4().to_string(),"tool":"plugins.branch_head","arguments":{}});
    let waiting = mcp.start(read.clone());
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, arguments }
        if parent_request == &native.request && capability == &manifest::key("plugins.branch_head")
            && arguments == &json!({"branch":"chosen-branch"}))
    );
    answer(&mut f, frame, json!({"revision":"sha256:original"})).await;
    assert_ne!(waiting.await.unwrap()["result"]["isError"], true);
    let tool = json!({"send_request":input["request_id"],"tool_request":uuid::Uuid::new_v4().to_string(),"tool":"plugins.checkpoint",
        "arguments":{"expected_head":"sha256:original","changes":{}},"preconditions":null});
    let mut override_branch = tool.clone();
    override_branch["arguments"]["branch"] = json!("another-branch");
    rejected(mcp.call(override_branch).await);
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
    assert_eq!(capability, &manifest::key("plugins.checkpoint"));
    assert_eq!(
        arguments,
        &json!({"branch":"chosen-branch","expected_head":"sha256:original","changes":{}})
    );
    let request = child.request.clone();
    let mut normalized = arguments.clone();
    normalized["native_default"] = Value::Null;
    let record = json!({"operation":{"operation_id":"original-host-operation","caller":{"kind":"plugin","id":"agent-one"},
        "causation_id":native.operation_id,"idempotency_scope":f.environment.project_root,"capability":capability,
        "normalized_arguments":normalized,"preconditions":[]},"status":"succeeded","output":{"revision":"sha256:checkpoint"},
        "error":null,"recovery":null,"cancellation_requested":false});
    f.writer
        .send(
            child.request,
            RpcBody::HostResult {
                result: record.clone(),
            },
        )
        .await
        .unwrap();
    let correlated = f.read().await;
    assert!(
        matches!(&correlated.body, RpcBody::HostCall { parent_request, capability, arguments }
        if parent_request == &native.request && capability == &manifest::key("plugins.delegated_operation")
            && arguments == &json!({"parent_operation":native.operation_id,"request":request}))
    );
    answer(
        &mut f,
        correlated,
        json!({"operation_id":"original-host-operation"}),
    )
    .await;
    let result = waiting.await.unwrap();
    assert_ne!(result["result"]["isError"], true);
    assert_eq!(mcp.call(tool.clone()).await["result"], result["result"]);
    let receipt = f
        .query(
            "agent.native.tool",
            json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
        )
        .await;
    assert_eq!(receipt["phase"], "resolved");
    assert_eq!(receipt["operation"], "original-host-operation");
    assert_eq!(receipt["native_request"]["type"], "host");
    assert_eq!(
        receipt["native_request"]["arguments"]["branch"],
        "chosen-branch"
    );
    assert!(
        receipt["native_request"]["arguments"]
            .get("native_default")
            .is_none()
    );
    inspect_original(&mut f, &native, &tool, &request, record).await;
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
async fn native_host_selection_refuses_foreign_contracts_and_uncaptured_grants_before_launch() {
    for variant in [
        "missing-inspection",
        "missing-port",
        "missing-scope",
        "foreign-project",
        "wrong-version",
        "control",
        "unknown-fixed",
    ] {
        let factory = Arc::new(Factory::default());
        let mut optional = vec!["operation.get", "plugins.delegated_operation"];
        if variant != "missing-inspection" {
            optional.push("host.core_contract");
        }
        if variant != "missing-port" {
            optional.push("plugins.checkpoint");
        }
        let mut f = host_fixture(factory.clone(), &optional).await;
        let created = f.native_create().await;
        let saved = draft(&mut f, &created, "Keep this draft and its chosen branch").await;
        let mut input = host_send(&saved, &["plugins.checkpoint"]);
        if variant == "unknown-fixed" {
            input["tools"][0]["target"]["fixed_arguments"]["other_branch"] = json!("unrecognized");
        }
        let mut native = scientific("refused-native-host", "agent.native.command", input, true);
        if variant != "missing-scope" {
            native.scopes.insert("plugins.write".into());
        }
        begin(&mut f, &native).await;
        if variant != "missing-inspection" {
            let mut descriptor = host_contract("plugins.checkpoint");
            match variant {
                "foreign-project" => descriptor["project"] = json!("another-project"),
                "wrong-version" => descriptor["capability"]["version"] = json!(2),
                "control" => descriptor["kind"] = json!("control"),
                _ => (),
            }
            host_descriptor(&mut f, &native, "plugins.checkpoint", descriptor).await;
        }
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!("{variant}: {frame:?}")
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed, "{variant}");
        f.settle(&native, plan.outcome).await;
        assert_eq!(factory.opens.load(Ordering::SeqCst), 0, "{variant}");
        assert_eq!(factory.sends.load(Ordering::SeqCst), 0, "{variant}");
        let current = f
            .query(
                "agent.native.task",
                json!({"task_id":created["detail"]["summary"]["task"]["task_id"]}),
            )
            .await;
        assert_eq!(
            current["draft"]["content"]["text"],
            "Keep this draft and its chosen branch"
        );
        f.release().await;
    }
}

#[tokio::test]
async fn native_host_query_needs_no_operation_or_plugin_manifest_grant() {
    let factory = Arc::new(Factory::default());
    factory.hold.store(true, Ordering::SeqCst);
    let mut f = host_fixture(
        factory.clone(),
        &["host.core_contract", "plugins.branch_head"],
    )
    .await;
    let created = f.native_create().await;
    let saved = draft(&mut f, &created, "Read the selected branch only").await;
    let input = host_send(&saved, &["plugins.branch_head"]);
    let native = call(
        "native-host-read",
        "agent.native.command",
        input.clone(),
        true,
    );
    assert!(!native.scopes.contains("operation.read"));
    assert!(!native.scopes.contains("plugins.write"));
    begin(&mut f, &native).await;
    host_descriptor(
        &mut f,
        &native,
        "plugins.branch_head",
        host_contract("plugins.branch_head"),
    )
    .await;
    host_caller(&mut f, &native).await;
    sent(&factory, 1).await;
    let mcp = Mcp::connect(&factory).await;
    let tool = json!({"send_request":input["request_id"],"tool_request":uuid::Uuid::new_v4().to_string(),"tool":"plugins.branch_head","arguments":{}});
    let waiting = mcp.start(tool.clone());
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall { parent_request, capability, arguments }
        if parent_request == &native.request && capability == &manifest::key("plugins.branch_head")
            && arguments == &json!({"branch":"chosen-branch"}))
    );
    answer(&mut f, frame, json!({"revision":"sha256:read-only"})).await;
    assert_ne!(waiting.await.unwrap()["result"]["isError"], true);
    let receipt = f
        .query(
            "agent.native.tool",
            json!({"send_request":tool["send_request"],"tool_request":tool["tool_request"]}),
        )
        .await;
    assert_eq!(receipt["phase"], "resolved");
    assert!(receipt["operation"].is_null());
    assert_eq!(receipt["result"]["data"]["revision"], "sha256:read-only");
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
