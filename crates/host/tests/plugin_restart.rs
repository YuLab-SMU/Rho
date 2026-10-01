//! Actual Host reopen with a separate native backend. Browser and real-Agent
//! restart acceptance additionally exercise their ordinary clients and owners.
#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::NextHost;
use rho_plugin_protocol::PluginArchive;
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn package(path: &Path) -> PluginArchive {
    fixture::package(path, "restart", false);
    let file = path.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    manifest["source"]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!("index.html"));
    manifest["views"] = json!([{"id":"view","title":"Retained view","entrypoint":"dist/index.html",
        "state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}]);
    fs::write(
        path.join("index.html"),
        "<!doctype html><p>Restart fixture</p>",
    )
    .unwrap();
    fs::copy(path.join("index.html"), path.join("dist/index.html")).unwrap();
    fs::write(file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    snapshot_directory(path, None, &backend_target()).unwrap()
}
fn invocation(id: &str, capability: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn query(
    host: &NextHost,
    context: &CallContext,
    capability: &str,
    arguments: Value,
) -> Value {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(capability, 1).unwrap(),
            arguments,
        },
    )
    .await
    .unwrap()
    .data
    .unwrap()
}
async fn run(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    capability: &str,
    arguments: Value,
) -> OperationRecord {
    let result = host
        .invoke(context, invocation(id, capability, arguments))
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    result
}
async fn refused(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    capability: &str,
    arguments: Value,
) {
    if let Ok(record) = host
        .invoke(context, invocation(id, capability, arguments))
        .await
    {
        assert_ne!(record.status, OperationStatus::Succeeded, "{record:?}");
    }
}

#[tokio::test]
async fn host_restart_preserves_instance_view_and_original_operation_without_automatic_resume() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let database = temp.path().join("state/records.sqlite");
    let archive = package(&temp.path().join("package"));
    PluginRepository::open(&repository_path(&database))
        .unwrap()
        .import(&archive)
        .unwrap();
    let context = NextHost::local_context();
    let host = NextHost::open_plugin_workspace(&database, &project)
        .await
        .unwrap();
    let activated = run(&host, &context, "activate", "plugins.activate", json!({
        "revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),
        "alias":"retained","configuration":{"retained_counts":true}
    })).await.output.unwrap();
    let identity = activated["instance"]["identity"].clone();
    let opened = run(&host, &context, "open", "windows.open_view", json!({
        "view":{"instance":identity,"contribution":"view","window":"original-window","configuration":{},
            "state":{"draft":"未发送的内容","original_request":"original-send"}},
        "expected_layout_version":0,"group":null
    })).await.output.unwrap();
    let view = opened["view"].clone();
    let view_args = json!({"view":view["view"]});
    let connection = query(&host, &context, "views.connection", view_args.clone()).await;
    let binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":identity,"capability":{"id":"fixture.run","version":1}}),
    )
    .await;
    let scientific_args =
        json!({"binding":binding,"arguments":{"action":"commit","message":"original result"}});
    let original = run(
        &host,
        &context,
        "original-send",
        "fixture.run",
        scientific_args.clone(),
    )
    .await;
    let read = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":identity,"capability":{"id":"fixture.read","version":1}}),
    )
    .await;
    let environment = query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":read,"arguments":{"action":"environment"}}),
    )
    .await;
    let data = std::path::PathBuf::from(environment["environment"]["data_root"].as_str().unwrap());
    assert_eq!(fs::read_to_string(data.join("invocations")).unwrap(), "1");
    host.drain().await;
    let suspended = query(
        &host,
        &context,
        "plugins.instance",
        json!({"instance":identity}),
    )
    .await;
    assert_eq!(suspended["instance"]["state"], "suspended");
    assert!(suspended["instance"]["suspension"].is_string());
    assert_eq!(
        query(&host, &context, "views.inspect", view_args.clone()).await,
        view
    );
    drop(host);

    let host = NextHost::open_plugin_workspace(&database, &project)
        .await
        .unwrap();
    let observed = query(
        &host,
        &context,
        "plugins.instance",
        json!({"instance":identity}),
    )
    .await;
    assert_eq!(observed["observed_in_this_host"], false);
    assert_eq!(observed["instance"], suspended["instance"]);
    assert_eq!(
        query(
            &host,
            &context,
            "windows.layout",
            json!({"window":"original-window"})
        )
        .await,
        opened["layout"]
    );
    assert_eq!(
        query(&host, &context, "views.inspect", view_args.clone()).await,
        view
    );
    for (capability, arguments) in [
        ("views.connection", view_args.clone()),
        (
            "plugins.resolve",
            json!({"instance":identity,"capability":{"id":"fixture.read","version":1}}),
        ),
    ] {
        assert!(
            host.query_snapshot(
                &context,
                QueryRequest {
                    capability: CapabilityRef::new(capability, 1).unwrap(),
                    arguments
                }
            )
            .await
            .is_err()
        );
    }
    assert_eq!(
        fs::read_to_string(data.join("starts")).unwrap(),
        "1",
        "queries must not start a backend"
    );
    let reconnect = json!({"view":view["view"],"expected_version":view["state_version"]});
    refused(
        &host,
        &context,
        "reconnect-too-early",
        "views.reconnect",
        reconnect.clone(),
    )
    .await;
    let resume = json!({"instance":identity,"suspension":suspended["instance"]["suspension"]});
    let mut restricted = context.clone();
    restricted.scopes.remove("plugins.write");
    refused(
        &host,
        &restricted,
        "insufficient-authority",
        "plugins.resume",
        resume.clone(),
    )
    .await;
    let mut foreign = context.clone();
    foreign.caller.id = "different-principal".into();
    foreign.principal = None;
    refused(
        &host,
        &foreign,
        "foreign-owner",
        "plugins.resume",
        resume.clone(),
    )
    .await;
    let resumed = run(
        &host,
        &context,
        "resume-original",
        "plugins.resume",
        resume.clone(),
    )
    .await;
    let observation = resumed.output.as_ref().unwrap();
    assert_eq!(observation["instance"]["identity"], identity);
    assert_eq!(observation["instance"]["state"], "active");
    assert_ne!(observation["process_id"], activated["process_id"]);
    assert_eq!(fs::read_to_string(data.join("starts")).unwrap(), "2");
    assert_eq!(fs::read_to_string(data.join("invocations")).unwrap(), "1");
    assert!(
        host.query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("views.connection", 1).unwrap(),
                arguments: view_args.clone()
            }
        )
        .await
        .is_err()
    );
    refused(
        &host,
        &context,
        "wrong-view-version",
        "views.reconnect",
        json!({"view":view["view"],"expected_version":99}),
    )
    .await;
    let reattached = run(
        &host,
        &context,
        "reconnect-original",
        "views.reconnect",
        reconnect.clone(),
    )
    .await;
    assert_eq!(reattached.output.as_ref().unwrap(), &view);
    let next_connection = query(&host, &context, "views.connection", view_args.clone()).await;
    assert_ne!(next_connection["connection"], connection["connection"]);
    assert_ne!(next_connection["call_token"], connection["call_token"]);
    assert_ne!(next_connection["asset_token"], connection["asset_token"]);
    let again = run(
        &host,
        &context,
        "reconnect-again",
        "views.reconnect",
        reconnect.clone(),
    )
    .await;
    assert_eq!(again.output.unwrap(), view);
    assert_eq!(
        query(&host, &context, "views.connection", view_args.clone()).await,
        next_connection,
        "an already reconnected view must keep its transport"
    );
    let repeated = run(
        &host,
        &context,
        "original-send",
        "fixture.run",
        scientific_args,
    )
    .await;
    assert_eq!(
        repeated.operation.operation_id,
        original.operation.operation_id
    );
    assert_eq!(repeated.output, original.output);
    assert_eq!(fs::read_to_string(data.join("invocations")).unwrap(), "1");
    host.drain().await;
    let later = query(
        &host,
        &context,
        "plugins.instance",
        json!({"instance":identity}),
    )
    .await;
    assert_ne!(
        later["instance"]["suspension"],
        suspended["instance"]["suspension"]
    );
    drop(host);

    let host = NextHost::open_plugin_workspace(&database, &project)
        .await
        .unwrap();
    let old_resume = run(
        &host,
        &context,
        "resume-original",
        "plugins.resume",
        resume.clone(),
    )
    .await;
    assert_eq!(
        old_resume.operation.operation_id,
        resumed.operation.operation_id
    );
    let old_reconnect = run(
        &host,
        &context,
        "reconnect-original",
        "views.reconnect",
        reconnect.clone(),
    )
    .await;
    assert_eq!(
        old_reconnect.operation.operation_id,
        reattached.operation.operation_id
    );
    refused(&host, &context, "stale-resume", "plugins.resume", resume).await;
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.instance",
            json!({"instance":identity})
        )
        .await["instance"],
        later["instance"]
    );
    assert_eq!(
        fs::read_to_string(data.join("starts")).unwrap(),
        "2",
        "old requests must not resume a later suspension"
    );
    refused(
        &host,
        &context,
        "release-open-view",
        "plugins.release",
        json!({"instance":identity}),
    )
    .await;
    run(
        &host,
        &context,
        "close-retained",
        "views.close",
        json!({"view":view["view"],
        "mode":{"kind":"retain_acknowledged","expected_version":view["state_version"]}}),
    )
    .await;
    let released = run(
        &host,
        &context,
        "release-retained",
        "plugins.release",
        json!({"instance":identity}),
    )
    .await;
    assert_eq!(released.output.unwrap()["instance"]["state"], "released");
    refused(
        &host,
        &context,
        "resume-released",
        "plugins.resume",
        json!({"instance":identity,"suspension":later["instance"]["suspension"]}),
    )
    .await;
    host.drain().await;
}
