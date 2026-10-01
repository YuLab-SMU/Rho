//! Actual native ACP -> private MCP -> generic Host checkpoint, with no science.
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_contract::*;
use rho_host::NextHost;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

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
async fn invoke(host: &NextHost, request: &str, cap: &str, arguments: Value) -> OperationRecord {
    host.invoke(
        &NextHost::local_context(),
        Invocation {
            client_request_id: request.into(),
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
            preconditions: vec![],
        },
    )
    .await
    .unwrap()
}
async fn succeeded(host: &NextHost, request: &str, cap: &str, arguments: Value) -> OperationRecord {
    let record = invoke(host, request, cap, arguments).await;
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record
}
async fn binding(host: &NextHost, instance: &Value, cap: &str) -> Value {
    query(
        host,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":cap,"version":1}}),
    )
    .await
}

fn control(value: &Value) -> Value {
    json!({"task_id":value["detail"]["summary"]["task"]["task_id"],"generation":value["detail"]["summary"]["attachment"]["generation"]})
}
async fn command(host: &NextHost, binding: &Value, command: Value) -> Value {
    let request = uuid::Uuid::new_v4().to_string();
    succeeded(
        host,
        &request,
        "agent.native.command",
        json!({"binding":binding,"arguments":{"request_id":request,"command":command}}),
    )
    .await
    .output
    .unwrap()
}

#[tokio::test]
#[ignore = "requires independent Agent package and isolated ACP peer; scripts/test-agent-core-tools.mjs"]
async fn native_agent_checkpoints_only_the_captured_branch_and_recovers_original_operation() {
    assert_eq!(
        std::env::var("RHO_AGENT_NATIVE_CORE_FIXTURE").as_deref(),
        Ok("1")
    );
    let package =
        std::fs::canonicalize(std::env::var_os("RHO_AGENT_PLUGIN_PACKAGE").unwrap()).unwrap();
    assert!(!package.starts_with(
        std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap()
    ));
    let archive = snapshot_directory(&package, None, &backend_target()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("state/host.sqlite");
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    repository.import(&archive).unwrap();
    let branch = repository
        .create_branch(&archive.revision.id, "Chosen development branch")
        .unwrap();
    let other = repository
        .create_branch(&archive.revision.id, "Unselected branch")
        .unwrap();
    drop(repository);
    let host = Arc::new(NextHost::open_plugin_workspace(&db, &root).await.unwrap());
    let fixture_host = host.clone();
    let result = tokio::spawn(async move {
        let host = fixture_host;
        let active = succeeded(&host,"core-activate","plugins.activate",json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"core-agent","configuration":{},"optional_capabilities":[{"id":"host.core_contract","version":1},{"id":"plugins.branch_head","version":1},{"id":"plugins.checkpoint","version":1},{"id":"operation.get","version":1},{"id":"plugins.delegated_operation","version":1}]})).await;
        let instance = active.output.unwrap()["instance"]["identity"].clone();
        let commands = binding(&host, &instance, "agent.native.command").await;
        let created = command(&host,&commands,json!({"kind":"create","provider":"kimi","model":"fixture","effort":null})).await;
        let saved = command(&host,&commands,json!({"kind":"save_draft","control":control(&created),"version":created["detail"]["draft"]["version"],"content":{"text":"Checkpoint this development branch 中文; keep the running version","assets":[],"context":[]}})).await;
        let connected = command(&host,&commands,json!({"kind":"connect","control":control(&saved)})).await;
        let text = "# Disposable Agent source checkpoint\n\n中文 retained without building or applying.\n";
        let arguments = json!({"expected_head":archive.revision.id,"changes":{"README.md":{"kind":"put","content_base64":STANDARD.encode(text),"executable":false}}});
        std::fs::write(root.join("native-core-input.json"),serde_json::to_vec(&json!({"branch":branch,"other_branch":other,"arguments":arguments})).unwrap()).unwrap();
        let send = uuid::Uuid::new_v4().to_string();
        let selection = |name, capability| json!({"name":name,"target":{"type":"host","project":commands["project"],"capability":{"id":capability,"version":1},"fixed_arguments":{"branch":branch}}});
        let request = json!({"binding":commands,"arguments":{"request_id":send,"command":{"kind":"send","control":control(&connected),"draft_version":connected["detail"]["draft"]["version"]},"tools":[selection("head","plugins.branch_head"),selection("checkpoint","plugins.checkpoint")]}});
        let original = tokio::time::timeout(Duration::from_secs(60),invoke(&host,"core-original-send","agent.native.command",request.clone())).await.unwrap();
        let evidence: Value = serde_json::from_slice(&std::fs::read(root.join("native-science-evidence.json")).unwrap()).unwrap();
        assert!(evidence.get("error").is_none(), "{evidence}");
        assert_eq!(original.status, OperationStatus::Succeeded, "{original:?}");
        assert_eq!(evidence["rejected_scope_replacement"], true);
        let lookup = json!({"send_request":send,"tool_request":evidence["invocation"]["tool_request"]});
        let tool = query(&host,"agent.native.tool",json!({"binding":binding(&host,&instance,"agent.native.tool").await,"arguments":lookup})).await;
        assert_eq!(tool["phase"], "resolved", "{tool}");
        assert_eq!(tool["native_request"]["type"], "host");
        assert_eq!(tool["native_request"]["arguments"]["branch"], json!(branch));
        let operation = OperationId::new(tool["operation"].as_str().unwrap()).unwrap();
        let record = host.get_operation(&NextHost::local_context(),&operation).await.unwrap().unwrap();
        assert_eq!(record.status, OperationStatus::Succeeded);
        assert_eq!(record.operation.causation_id, Some(original.operation.operation_id.clone()));
        assert_eq!(record.operation.caller.kind, CallerKind::Plugin);
        assert_eq!(record.operation.caller.id, instance["instance"].as_str().unwrap());
        assert_eq!(record.operation.normalized_arguments["branch"],json!(branch));
        let revision = record.output.as_ref().unwrap()["revision"].clone();
        assert_ne!(revision, json!(archive.revision.id));
        assert_eq!(query(&host,"plugins.branch_head",json!({"branch":branch})).await["revision"],revision);
        assert_eq!(query(&host,"plugins.branch_head",json!({"branch":other})).await["revision"],json!(archive.revision.id));
        let read = query(&host,"plugins.read_source",json!({"revision":revision,"path":"README.md","offset":0,"limit":65536})).await;
        assert_eq!(STANDARD.decode(read["content_base64"].as_str().unwrap()).unwrap(),text.as_bytes());
        let running = query(&host,"plugins.instance",json!({"instance":instance})).await;
        assert_eq!(running["instance"]["identity"]["revision"],json!(archive.revision.id));
        let observed = query(&host,"agent.native.tool.operation",json!({"binding":binding(&host,&instance,"agent.native.tool.operation").await,"arguments":lookup})).await;
        assert_eq!(observed["operation"]["operation_id"],json!(operation));
        assert_eq!(observed["operation"]["output"],json!(record.output));
        let repeat = succeeded(&host,"core-observe-send","agent.native.command",request).await;
        assert_eq!(repeat.output.as_ref().unwrap()["receipt"]["status"], "succeeded");
        let final_evidence: Value = serde_json::from_slice(&std::fs::read(root.join("native-science-evidence.json")).unwrap()).unwrap();
        assert_eq!(final_evidence["prompts"],1);
        let connection = rusqlite::Connection::open(&db).unwrap();
        let count: i64 = connection.query_row("SELECT count(*) FROM operations WHERE capability_id = 'plugins.checkpoint'", [], |row| row.get(0)).unwrap();
        assert_eq!(count,1);
        for cap in ["plugins.build","plugins.preview","scenarios.apply"] {
            let count: i64 = connection.query_row("SELECT count(*) FROM operations WHERE capability_id = ?1", [cap], |row| row.get(0)).unwrap();
            assert_eq!(count,0,"{cap}");
        }
        drop(connection);
        tokio::time::timeout(Duration::from_secs(10),async {
            loop {
                let state=query(&host,"plugins.instance",json!({"instance":instance})).await;
                if state["retained_calls"] == 0 && state["pending_messages"] == 0 {break;}
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        succeeded(&host,"core-release","plugins.release",json!({"instance":instance})).await;
        assert_eq!(host.get_operation(&NextHost::local_context(),&operation).await.unwrap().unwrap().output,record.output);
    }).await;
    host.drain().await;
    result.unwrap();
}
