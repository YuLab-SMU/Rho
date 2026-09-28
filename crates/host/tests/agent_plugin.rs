//! Real generic-Host acceptance of an independently built ordinary Agent package.
//! This target has no Agent backend dependency and never compiles package source.
use rho_contract::*;
use rho_host::NextHost;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::path::PathBuf;

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

#[tokio::test]
#[ignore = "requires an independently built package; run scripts/test-agent-plugin.mjs"]
async fn ordinary_agent_metadata_uses_generic_host_scopes_isolated_storage_and_original_journal() {
    let package =
        PathBuf::from(std::env::var_os("RHO_AGENT_PLUGIN_PACKAGE").expect("independent package"));
    assert!(!package.starts_with(
        std::fs::canonicalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).unwrap()
    ));
    let archive = snapshot_directory(&package, None, &backend_target()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let db = directory.path().join("host.sqlite");
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let active = succeeded(&host, "activate", "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"agent","configuration":{}})).await;
    let first = active.output.unwrap()["instance"]["identity"].clone();
    let list = binding(&host, &first, "agent.tasks").await;
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":list,"arguments":{"limit":20}})
        )
        .await["tasks"],
        json!([])
    );
    let create = binding(&host, &first, "agent.model.create").await;
    let arguments =
        json!({"binding":create,"arguments":{"conversation_id":"task-one","profile":"project"}});
    let created = succeeded(
        &host,
        "create-original",
        "agent.model.create",
        arguments.clone(),
    )
    .await;
    let repeated = succeeded(&host, "create-original", "agent.model.create", arguments).await;
    assert_eq!(
        created.operation.operation_id,
        repeated.operation.operation_id
    );
    assert_eq!(created.output, repeated.output);
    let draft = binding(&host, &first, "agent.model.draft").await;
    let arguments = json!({"binding":draft,"arguments":{"conversation_id":"task-one","draft_version":1,"content":{"text":"研究🙂 retained draft","context":[],"assets":[]},"grant":null}});
    let saved = succeeded(
        &host,
        "save-original",
        "agent.model.draft",
        arguments.clone(),
    )
    .await;
    assert_eq!(saved.output.as_ref().unwrap()["draft_version"], 2);
    let replay = succeeded(
        &host,
        "save-original",
        "agent.model.draft",
        arguments.clone(),
    )
    .await;
    assert_eq!(replay.operation.operation_id, saved.operation.operation_id);
    assert_eq!(replay.output, saved.output);
    let stale = invoke(&host, "stale-new-request", "agent.model.draft", arguments).await;
    assert_eq!(stale.status, OperationStatus::Failed);
    let read = binding(&host, &first, "agent.model.conversation").await;
    let before = query(
        &host,
        "agent.model.conversation",
        json!({"binding":read,"arguments":{"conversation_id":"task-one"}}),
    )
    .await;
    assert_eq!(before["draft_version"], 2);
    assert_eq!(before["draft"], "研究🙂 retained draft");
    let mut weak = NextHost::local_context();
    weak.scopes.remove("application.read");
    assert!(
        host.query_snapshot(
            &weak,
            QueryRequest {
                capability: CapabilityRef::new("agent.tasks", 1).unwrap(),
                arguments: json!({"binding":list,"arguments":{"limit":20}})
            }
        )
        .await
        .is_err()
    );
    let mut foreign = NextHost::local_context();
    foreign.caller.id = "other-principal".into();
    assert!(
        host.query_snapshot(
            &foreign,
            QueryRequest {
                capability: CapabilityRef::new("agent.tasks", 1).unwrap(),
                arguments: json!({"binding":list,"arguments":{"limit":20}})
            }
        )
        .await
        .is_err()
    );
    let second = succeeded(&host, "second-instance", "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"agent-two","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let second_list = binding(&host, &second, "agent.tasks").await;
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":second_list,"arguments":{"limit":20}})
        )
        .await["tasks"],
        json!([])
    );
    assert_eq!(
        query(
            &host,
            "agent.tasks",
            json!({"binding":list,"arguments":{"limit":20}})
        )
        .await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    succeeded(
        &host,
        "release-first",
        "plugins.release",
        json!({"instance":first}),
    )
    .await;
    succeeded(
        &host,
        "release-second",
        "plugins.release",
        json!({"instance":second}),
    )
    .await;
    succeeded(
        &host,
        "remove-agent",
        "plugins.remove",
        json!({"revision":archive.revision.id}),
    )
    .await;
    let retained = host
        .get_operation(&NextHost::local_context(), &saved.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained.status, OperationStatus::Succeeded);
    assert_eq!(retained.output, saved.output);
    assert_eq!(
        query(&host, "plugins.list", json!({"limit":20})).await["items"],
        json!([])
    );
    host.drain().await;
    drop(host);
    assert!(!root.join(".Rhistory").exists());
}
