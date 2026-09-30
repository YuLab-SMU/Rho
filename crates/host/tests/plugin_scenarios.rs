use rho_contract::*;
use rho_host::{NextHost, OperationError};
use serde_json::{Value, json};
#[path = "fixtures/plugins.rs"]
mod fixture;

async fn query(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    arguments: Value,
) -> Result<Value, OperationError> {
    Ok(host
        .query_snapshot(
            context,
            QueryRequest {
                capability: CapabilityRef::new(id, 1).unwrap(),
                arguments,
            },
        )
        .await?
        .data
        .unwrap())
}
fn save(id: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new("scenarios.checkpoint", 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}

#[tokio::test]
async fn scenario_ports_preserve_scope_original_operations_and_window_runtime_independence() {
    let temp = tempfile::tempdir().unwrap();
    let host = NextHost::open_plugin_workspace(&temp.path().join("records.sqlite"), temp.path())
        .await
        .unwrap();
    let context = NextHost::local_context();
    let listing = json!({"after":null,"limit":20});
    let original = json!({"scenario":"analysis","expected_head":null,"name":"研究 · Analysis",
        "instances":{},"providers":[],"layout":{"kind":"empty"}});
    let untouched_window = query(
        &host,
        &context,
        "windows.layout",
        json!({"window":"untouched"}),
    )
    .await
    .unwrap();
    let instances = query(&host, &context, "plugins.instances", listing.clone())
        .await
        .unwrap();
    let before = host.outbox(&context, 0, 100).await.unwrap();
    assert_eq!(
        query(&host, &context, "scenarios.list", listing.clone())
            .await
            .unwrap(),
        json!({"scenarios":[],"next":null})
    );
    assert_eq!(host.outbox(&context, 0, 100).await.unwrap(), before);
    let first = host
        .invoke(&context, save("first", original.clone()))
        .await
        .unwrap();
    assert_eq!(
        first.status,
        OperationStatus::Succeeded,
        "{:?}",
        first.error
    );
    let first_value = first.output.clone().unwrap();
    let read = json!({"revision":first_value["id"]});
    assert_eq!(
        query(&host, &context, "scenarios.get", read.clone())
            .await
            .unwrap(),
        first_value
    );
    let mut edited = original.clone();
    edited["expected_head"] = first_value["id"].clone();
    edited["name"] = json!("Edited");
    let second = host
        .invoke(&context, save("second", edited.clone()))
        .await
        .unwrap();
    assert_eq!(
        second.status,
        OperationStatus::Succeeded,
        "{:?}",
        second.error
    );
    assert!(matches!(
        host.invoke(&context, save("stale", edited)).await,
        Err(OperationError::ContentChanged(_))
    ));
    let repeated = host
        .invoke(&context, save("first", original.clone()))
        .await
        .unwrap();
    assert_eq!(json!(repeated), json!(first));
    let mut restored = original.clone();
    restored["expected_head"] = second.output.as_ref().unwrap()["id"].clone();
    let restored = host
        .invoke(&context, save("restore", restored))
        .await
        .unwrap();
    assert_eq!(restored.status, OperationStatus::Succeeded);
    let restored = restored.output.unwrap();
    assert_ne!(restored["id"], first_value["id"]);
    assert_eq!(restored["parent"], second.output.unwrap()["id"]);
    assert_eq!(
        query(&host, &context, "scenarios.get", read.clone())
            .await
            .unwrap(),
        first_value
    );
    let mut foreign = context.clone();
    foreign.caller.id = "another-user".into();
    assert!(matches!(
        query(&host, &foreign, "scenarios.get", read.clone()).await,
        Err(OperationError::NotFound(_))
    ));
    assert_eq!(
        query(&host, &foreign, "scenarios.list", listing.clone())
            .await
            .unwrap()["scenarios"],
        json!([])
    );
    let mut denied = context.clone();
    denied.scopes.remove("plugins.read");
    assert!(query(&host, &denied, "scenarios.get", read).await.is_err());
    denied = context.clone();
    denied.scopes.remove("plugins.write");
    assert!(
        host.invoke(&denied, save("denied", original.clone()))
            .await
            .is_err()
    );
    for field in ["project", "principal"] {
        let mut spoof = original.clone();
        spoof[field] = json!("forged");
        assert!(host.invoke(&context, save(field, spoof)).await.is_err());
    }
    assert_eq!(
        query(&host, &context, "plugins.instances", listing.clone())
            .await
            .unwrap(),
        instances
    );
    assert_eq!(
        query(
            &host,
            &context,
            "windows.layout",
            json!({"window":"untouched"})
        )
        .await
        .unwrap(),
        untouched_window
    );
    let events = host.outbox(&context, 0, 100).await.unwrap();
    assert_eq!(
        query(&host, &context, "scenarios.list", listing)
            .await
            .unwrap()["scenarios"][0]["revision"],
        restored["id"]
    );
    assert_eq!(host.outbox(&context, 0, 100).await.unwrap(), events);
}

#[tokio::test]
async fn an_external_plugin_uses_scenario_ports_without_a_management_privilege() {
    use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
    use std::fs;
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let database = project.join("records.sqlite");
    let package = temp.path().join("external-manager");
    fixture::package(&package, "scenarios", false);
    for path in ["backend.py", "dist/backend", "plugin.json"] {
        let path = package.join(path);
        let content = fs::read_to_string(&path)
            .unwrap()
            .replace("\"plugins.list\"", "\"scenarios.list\"")
            .replace("\"plugins.branch\"", "\"scenarios.checkpoint\"");
        fs::write(path, content).unwrap();
    }
    let archive = snapshot_directory(&package, None, &backend_target()).unwrap();
    PluginRepository::open(&repository_path(&database))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&database, &project)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let invoke = |id: &str, capability: &str, arguments| Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: vec![],
    };
    let activated = host.invoke(&context,invoke("activate","plugins.activate",json!({
        "revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"manager","configuration":{}}))).await.unwrap();
    assert_eq!(
        activated.status,
        OperationStatus::Succeeded,
        "{:?}",
        activated.error
    );
    let instance = activated.output.unwrap()["instance"]["identity"].clone();
    let read = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"capability":{"id":"fixture.read","version":1},"instance":instance}),
    )
    .await
    .unwrap();
    let listing = json!({"after":null,"limit":20});
    let result = query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":read,"arguments":{"action":"delegate","host_arguments":listing}}),
    )
    .await
    .unwrap();
    assert_eq!(
        result["delegated"]["result"]["data"]["scenarios"],
        json!([])
    );
    let definition = json!({"scenario":"external","expected_head":null,"name":"External manager","instances":{},"providers":[],"layout":{"kind":"empty"}});
    let denied = query(&host,&context,"fixture.read",json!({"binding":read,"arguments":{"action":"delegate_branch","host_arguments":definition}})).await.unwrap();
    assert_eq!(denied["delegated"]["code"], "host_call_failed");
    assert_eq!(
        query(&host, &context, "scenarios.list", listing.clone())
            .await
            .unwrap()["scenarios"],
        json!([])
    );
    let binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"capability":{"id":"fixture.run","version":1},"instance":instance}),
    )
    .await
    .unwrap();
    let request = invoke(
        "save-from-plugin",
        "fixture.run",
        json!({"binding":binding,"arguments":{"action":"delegate_operation","host_arguments":definition}}),
    );
    let result = host.invoke(&context, request.clone()).await.unwrap();
    assert_eq!(
        result.status,
        OperationStatus::Succeeded,
        "{:?}",
        result.error
    );
    let child = &result.output.as_ref().unwrap()["arguments"]["delegated"]["result"];
    assert_eq!(child["status"], "succeeded", "{child}");
    assert_eq!(
        child["operation"]["causation_id"],
        json!(result.operation.operation_id)
    );
    assert_eq!(child["operation"]["principal"], json!(context.caller));
    let first = query(&host, &context, "scenarios.list", listing.clone())
        .await
        .unwrap();
    assert_eq!(first["scenarios"][0]["scenario"], "external");
    assert_eq!(
        json!(host.invoke(&context, request).await.unwrap()),
        json!(result)
    );
    assert_eq!(
        query(&host, &context, "scenarios.list", listing)
            .await
            .unwrap(),
        first
    );
    let released = host
        .invoke(
            &context,
            invoke("release", "plugins.release", json!({"instance":instance})),
        )
        .await
        .unwrap();
    assert_eq!(
        released.status,
        OperationStatus::Succeeded,
        "{:?}",
        released.error
    );
    assert_eq!(
        query(
            &host,
            &context,
            "scenarios.get",
            json!({"revision":first["scenarios"][0]["revision"]})
        )
        .await
        .unwrap()["name"],
        "External manager"
    );
}

#[path = "fixtures/scenario_application.rs"]
mod application;
