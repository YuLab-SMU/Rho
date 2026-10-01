//! Real native ACP -> private MCP -> public Host -> ordinary R provider.
use super::*;

fn control(detail: &Value) -> Value {
    json!({"task_id":detail["summary"]["task"]["task_id"],"generation":detail["summary"]["attachment"]["generation"]})
}
async fn command(host: &NextHost, binding: &Value, command: Value) -> Value {
    let request = uuid::Uuid::new_v4().to_string();
    succeeded(
        host,
        &request,
        "agent.native.command",
        1,
        json!({"binding":binding,"arguments":{"request_id":request,"command":command}}),
    )
    .await
    .output
    .unwrap()
}
async fn file_ready(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(45), async {
        let mut interval = tokio::time::interval(Duration::from_millis(20));
        while !path.exists() {
            if let Ok(bytes) = std::fs::read(path.with_file_name("native-science-evidence.json")) {
                let evidence: Value = serde_json::from_slice(&bytes).unwrap();
                assert!(evidence.get("error").is_none(), "{evidence}");
            }
            interval.tick().await;
        }
    })
    .await
    .expect("disposable native/R fixture must actually enter");
}
async fn idle(host: &NextHost, instance: &Value) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = query(host, "plugins.instance", json!({"instance":instance})).await;
            if state["retained_calls"] == 0 && state["pending_messages"] == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires independent Agent/R packages and isolated ACP fixture; scripts/test-agent-plugin-real-r.mjs"]
async fn ordinary_native_agent_executes_real_r_once_and_retains_child_after_stop() {
    assert_eq!(
        std::env::var("RHO_AGENT_NATIVE_SCIENCE_FIXTURE").as_deref(),
        Ok("1")
    );
    for stop in [false, true] {
        exercise(stop).await;
    }
}
async fn exercise(stop: bool) {
    let checkout = std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap();
    let archives = ["RHO_AGENT_PLUGIN_PACKAGE", "RHO_R_PLUGIN_PACKAGE"].map(|name| {
        let package = std::fs::canonicalize(std::env::var_os(name).unwrap()).unwrap();
        assert!(!package.starts_with(&checkout));
        snapshot_directory(&package, None, &backend_target()).unwrap()
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
    let fixture_host = host.clone();
    let cleanup_root = root.clone();
    let result = tokio::spawn(async move {
        let host = fixture_host;
        let r = succeeded(&host,"native-activate-r","plugins.activate",1,json!({"revision":archives[1].revision.id,"artifact":archives[1].artifacts[0].id,"target":backend_target(),"alias":"native-r","configuration":{"ark":std::fs::canonicalize(std::env::var_os("RHO_ARK").unwrap()).unwrap(),"r_home":std::fs::canonicalize(std::env::var_os("RHO_R_HOME").unwrap()).unwrap(),"execution_timeout_seconds":60}})).await.output.unwrap()["instance"]["identity"].clone();
        let session = succeeded(&host,"native-create-r","r.create_session",1,json!({"binding":binding(&host,&r,"r.create_session",1).await,"arguments":{}})).await.output.unwrap()["session_id"].clone();
        let agent = succeeded(&host,"native-activate-agent","plugins.activate",1,json!({"revision":archives[0].revision.id,"artifact":archives[0].artifacts[0].id,"target":backend_target(),"alias":"native-agent","configuration":{},"optional_capabilities":[{"id":"plugins.inspect","version":1},{"id":"r.execute","version":2},{"id":"operation.get","version":1},{"id":"plugins.delegated_operation","version":1}]})).await.output.unwrap()["instance"]["identity"].clone();
        let commands = binding(&host,&agent,"agent.native.command",1).await;
        let created = command(&host,&commands,json!({"kind":"create","provider":"kimi","model":"fixture","effort":null})).await;
        let task = created["detail"]["summary"]["task"]["task_id"].clone();
        let saved = command(&host,&commands,json!({"kind":"save_draft","control":control(&created["detail"]),"version":created["detail"]["draft"]["version"],"content":{"text":"Run the original authorized R counter 中文","assets":[],"context":[]}})).await;
        // Open before Send to verify scientific calls use the later Send parent.
        let connected = command(&host,&commands,json!({"kind":"connect","control":control(&saved["detail"])})).await;
        let mut r_binding = binding(&host,&r,"r.execute",2).await;
        r_binding["target"] = session.clone();
        let arguments = json!({"expected_session":session,"run":{"code":"counter <- if (exists('counter', inherits=FALSE)) counter + 1L else 1L; writeLines('entered', 'entered-r'); while (!file.exists('release-r')) Sys.sleep(0.01); counter"}});
        std::fs::write(root.join("native-science-input.json"), serde_json::to_vec(&arguments).unwrap()).unwrap();
        if !stop { std::fs::write(root.join("release-r"), "continue").unwrap(); }
        let send = uuid::Uuid::new_v4().to_string();
        let request = json!({"binding":commands,"arguments":{"request_id":send,"command":{"kind":"send","control":control(&connected["detail"]),"draft_version":connected["detail"]["draft"]["version"]},"tools":[{"name":"execute","target":{"type":"provider","binding":r_binding}}]}});
        let running_host = host.clone();
        let running_request = request.clone();
        let running = tokio::spawn(async move { invoke(&running_host,"original-native-send","agent.native.command",1,running_request).await });
        file_ready(&root.join("entered-r")).await;
        file_ready(&root.join("native-science-evidence.json")).await;
        let evidence: Value = serde_json::from_slice(&std::fs::read(root.join("native-science-evidence.json")).unwrap()).unwrap();
        assert!(evidence.get("error").is_none(), "{evidence}");
        let tool = evidence["invocation"]["tool_request"].clone();
        if stop {
            let detail = query(&host,"agent.native.task",json!({"binding":binding(&host,&agent,"agent.native.task",1).await,"arguments":{"task_id":task}})).await;
            let stopped = command(&host,&commands,json!({"kind":"stop","control":control(&detail)})).await;
            assert_eq!(stopped["receipt"]["status"], "succeeded");
            assert!(!running.is_finished(), "Original Send must retain the accepted R child after native stop");
            std::fs::write(root.join("release-r"), "continue").unwrap();
        }
        let original = tokio::time::timeout(Duration::from_secs(60),running).await.unwrap().unwrap();
        assert_eq!(original.status, if stop {OperationStatus::Failed} else {OperationStatus::Succeeded}, "{original:?}");
        let lookup = json!({"send_request":send,"tool_request":tool});
        let receipt = query(&host,"agent.native.tool",json!({"binding":binding(&host,&agent,"agent.native.tool",1).await,"arguments":lookup})).await;
        assert_eq!(receipt["phase"], "resolved", "{receipt}");
        assert_eq!(receipt["result"]["status"], "succeeded");
        let child_id = OperationId::new(receipt["operation"].as_str().unwrap()).unwrap();
        let child = host.get_operation(&NextHost::local_context(),&child_id).await.unwrap().unwrap();
        assert_eq!(child.status, OperationStatus::Succeeded);
        assert_eq!(child.operation.causation_id, Some(original.operation.operation_id.clone()));
        assert_eq!(child.operation.normalized_arguments["binding"], r_binding);
        assert_eq!(child.operation.normalized_arguments["arguments"], arguments);
        assert_eq!(child.output.as_ref().unwrap()["session_id"], session);
        let observed = query(&host,"agent.native.tool.operation",json!({"binding":binding(&host,&agent,"agent.native.tool.operation",1).await,"arguments":lookup})).await;
        assert_eq!(observed["operation"]["operation_id"], json!(child_id));
        assert_eq!(observed["operation"]["output"], json!(child.output));
        let repeated = invoke(&host,"repeat-native-observation","agent.native.command",1,request).await;
        assert_eq!(repeated.status, OperationStatus::Succeeded);
        assert_eq!(repeated.output.as_ref().unwrap()["receipt"]["status"], if stop {"interrupted"} else {"succeeded"});
        let evidence: Value = serde_json::from_slice(&std::fs::read(root.join("native-science-evidence.json")).unwrap()).unwrap();
        assert_eq!(evidence["prompts"], 1);
        succeeded(&host,"native-verify-counter","r.execute",2,json!({"binding":r_binding,"arguments":{"expected_session":session,"run":{"code":"stopifnot(counter == 1L); counter"}}})).await;
        for (index, instance) in [&agent,&r].into_iter().enumerate() {
            idle(&host,instance).await;
            succeeded(&host,&format!("native-release-{index}"),"plugins.release",1,json!({"instance":instance})).await;
            succeeded(&host,&format!("native-remove-{index}"),"plugins.remove",1,json!({"revision":archives[index].revision.id})).await;
        }
        assert_eq!(host.get_operation(&NextHost::local_context(),&child_id).await.unwrap().unwrap().output,child.output);
    }).await;
    let _ = std::fs::write(cleanup_root.join("release-r"), "finish fixture");
    host.drain().await;
    result.unwrap();
}
