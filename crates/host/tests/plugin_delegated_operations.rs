#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::PluginArchive;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

fn package(path: &Path) -> PluginArchive {
    fixture::package(path, "delegated-observation", false);
    for file in ["backend.py", "dist/backend"] {
        fs::write(
            path.join(file),
            include_str!("fixtures/delegated_operation.py"),
        )
        .unwrap();
    }
    let file = path.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    manifest["requires"] = json!([
        {"capability":{"id":"fixture.run","version":1},"scopes":["plugins.run","operation.read"]},
        {"capability":{"id":"plugins.delegated_operation","version":1},"scopes":["operation.read"]}
    ]);
    // The read's active parent also carries the explicitly requested read scope.
    manifest["capabilities"][0]["required_scopes"] = json!(["plugins.read", "operation.read"]);
    fs::write(file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    snapshot_directory(path, None, &backend_target()).unwrap()
}

async fn read(
    host: &NextHost,
    context: &CallContext,
    cap: &str,
    arguments: Value,
) -> Result<QuerySnapshot, OperationError> {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
        },
    )
    .await
}
async fn query(host: &NextHost, cap: &str, arguments: Value) -> Value {
    read(host, &NextHost::local_context(), cap, arguments)
        .await
        .unwrap()
        .data
        .unwrap()
}
async fn invoke(host: &NextHost, id: &str, cap: &str, arguments: Value) -> Value {
    let record = host
        .invoke(
            &NextHost::local_context(),
            Invocation {
                client_request_id: id.into(),
                capability: CapabilityRef::new(cap, 1).unwrap(),
                arguments,
                preconditions: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record.output.unwrap()
}
async fn binding(host: &NextHost, instance: &Value, cap: &str) -> Value {
    query(
        host,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":cap,"version":1}}),
    )
    .await
}
async fn fixture_query(host: &NextHost, binding: &Value, arguments: Value) -> Value {
    query(
        host,
        "fixture.read",
        json!({"binding":binding,"arguments":arguments}),
    )
    .await
}
async fn lookup(host: &NextHost, binding: &Value, args: &Value) -> Value {
    fixture_query(host, binding, json!({"action":"lookup","lookup":args})).await["reply"].clone()
}
async fn settled(host: &NextHost, id: &OperationId) -> OperationRecord {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let record = host
                .get_operation(&NextHost::local_context(), id)
                .await
                .unwrap()
                .unwrap();
            if record.status.is_terminal() {
                return record;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn original_reverse_request_is_observable_while_pending_after_lost_reply_and_without_live_provider()
 {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let db = temp.path().join("state.sqlite");
    let archive = package(&temp.path().join("package"));
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let context = NextHost::local_context();
    let mut instances = Vec::new();
    for name in ["origin", "child"] {
        let active = invoke(&host, name, "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":name,"configuration":{}})).await;
        instances.push(active["instance"]["identity"].clone());
    }
    let origin_read = binding(&host, &instances[0], "fixture.read").await;
    let origin_run = binding(&host, &instances[0], "fixture.run").await;
    let child_read = binding(&host, &instances[1], "fixture.read").await;
    let child_run = binding(&host, &instances[1], "fixture.run").await;
    let original = host.invoke_accepted(&context, Invocation {
        client_request_id: "original-parent".into(), capability: CapabilityRef::new("fixture.run", 1).unwrap(),
        arguments: json!({"binding":origin_run,"arguments":{"action":"delegate","child":{"binding":child_run,"arguments":{"action":"hold"}}}}), preconditions: vec![]
    }).await.unwrap();
    let parent = original.operation.operation_id;
    let args = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = fixture_query(&host, &origin_read, json!({"action":"state"})).await;
            if let Some(args) = state["parents"].get(parent.as_str()) {
                return args.clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let child = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = lookup(&host, &origin_read, &args).await;
            assert_eq!(reply["type"], "host_result", "{reply}");
            if let Some(id) = reply["data"]["result"]["data"]["operation_id"].as_str() {
                return OperationId::new(id).unwrap();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let pending = host.get_operation(&context, &child).await.unwrap().unwrap();
    assert!(!pending.status.is_terminal());
    assert_eq!(pending.operation.causation_id, Some(parent.clone()));
    assert_eq!(pending.operation.caller.id, instances[0]["instance"]);

    let absent = lookup(
        &host,
        &origin_read,
        &json!({"parent_operation":parent,"request":"never-sent"}),
    )
    .await;
    assert_eq!(absent["type"], "host_result");
    assert!(absent["data"]["result"]["data"]["operation_id"].is_null());
    assert_eq!(absent["data"]["result"]["completeness"], "partial");
    assert!(
        !absent["data"]["result"]["notices"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // An equally scoped second backend cannot select the first one's caller.
    assert_eq!(lookup(&host, &child_read, &args).await["type"], "error");
    for name in ["provider", "caller", "project", "client_request_id"] {
        let mut forged = args.clone();
        forged[name] = json!("forged");
        assert_eq!(lookup(&host, &origin_read, &forged).await["type"], "error");
    }

    fixture_query(&host, &child_read, json!({"action":"finish"})).await;
    assert_eq!(
        settled(&host, &child).await.status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        lookup(&host, &origin_read, &args).await["data"]["result"]["data"]["operation_id"],
        json!(child)
    );
    assert!(
        !host
            .get_operation(&context, &parent)
            .await
            .unwrap()
            .unwrap()
            .status
            .is_terminal()
    );
    fixture_query(&host, &origin_read, json!({"action":"finish"})).await;
    assert_eq!(
        settled(&host, &parent).await.status,
        OperationStatus::Succeeded
    );
    let records = query(&host, "operation.list_recent", json!({"limit":100})).await;
    assert_eq!(
        records["operations"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| record["capability"]["id"] == "fixture.run")
            .count(),
        2
    );
    // Native trusted context models an authorized historical owner read, without
    // asking the runtime to resurrect the released backend or replay a mutation.
    let mut owner = context.clone();
    owner.principal = Some(context.principal().clone());
    owner.caller = CallerIdentity {
        kind: CallerKind::Plugin,
        id: instances[0]["instance"].as_str().unwrap().into(),
    };
    for (i, instance) in instances.iter().enumerate() {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let observed = query(&host, "plugins.instance", json!({"instance":instance})).await;
                if observed["retained_calls"] == 0 && observed["pending_messages"] == 0 { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        invoke(
            &host,
            &format!("release-{i}"),
            "plugins.release",
            json!({"instance":instance}),
        )
        .await;
    }
    assert_eq!(
        read(&host, &owner, "plugins.delegated_operation", args.clone())
            .await
            .unwrap()
            .data
            .unwrap()["operation_id"],
        json!(child)
    );
    for mode in ["principal", "scope", "caller", "view"] {
        let mut denied = owner.clone();
        match mode {
            "principal" => denied.principal.as_mut().unwrap().id = "foreign".into(),
            "scope" => {
                denied.scopes.remove("operation.read");
            }
            "caller" => denied.caller.kind = CallerKind::Human,
            _ => denied.caller.id = "view-not-backend".into(),
        }
        assert!(
            read(&host, &denied, "plugins.delegated_operation", args.clone())
                .await
                .is_err()
        );
    }
    invoke(&host, "remove-fixture", "plugins.remove", json!({"revision":archive.revision.id})).await;
    assert_eq!(query(&host, "plugins.list", json!({"limit":20})).await["items"], json!([]));
    drop(host);
    let reopened = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    assert_eq!(
        read(
            &reopened,
            &owner,
            "plugins.delegated_operation",
            args.clone()
        )
        .await
        .unwrap()
        .data
        .unwrap()["operation_id"],
        json!(child)
    );
    let other_root = temp.path().join("other-project");
    fs::create_dir(&other_root).unwrap();
    let foreign = NextHost::open_plugin_workspace(&db, &other_root)
        .await
        .unwrap();
    assert!(
        read(&foreign, &owner, "plugins.delegated_operation", args)
            .await
            .is_err()
    );
    assert_eq!(
        query(&reopened, "plugins.instances", json!({"limit":20})).await["instances"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["observed_in_this_host"] == true)
            .count(),
        0
    );
}
