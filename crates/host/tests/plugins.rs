#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::{PluginArchive, PluginInstanceObservation};
use rho_plugins::{PluginRepository, backend_target, repository_path};
use serde_json::{Value, json};
use std::{fs, sync::Arc};

async fn query(host: &NextHost, context: &CallContext, id: &str, args: Value) -> Value {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(id, 1).unwrap(),
            arguments: args,
        },
    )
    .await
    .unwrap()
    .data
    .unwrap()
}
fn invocation(id: &str, cap: &str, args: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments: args,
        preconditions: vec![],
    }
}
async fn run(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    cap: &str,
    args: Value,
) -> OperationRecord {
    host.invoke(context, invocation(id, cap, args))
        .await
        .unwrap()
}
fn activation(archive: &PluginArchive, label: &str) -> Value {
    json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":label,"configuration":{"label":label}})
}
fn observation(record: &OperationRecord) -> PluginInstanceObservation {
    assert_eq!(
        record.status,
        OperationStatus::Succeeded,
        "status={:?} error={:?} recovery={:?}",
        record.status,
        record.error,
        record.recovery
    );
    serde_json::from_value(record.output.clone().unwrap()).unwrap()
}

#[tokio::test]
async fn retained_plugin_resources_share_host_visibility_and_survive_provider_and_host_release() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state/state.sqlite");
    let archive = fixture::package(&temp.path().join("external"), "1", false);
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    repository.import(&archive).unwrap();
    let context = NextHost::local_context();
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let instance = observation(
        &run(
            &host,
            &context,
            "resource-activate",
            "plugins.activate",
            activation(&archive, "resource"),
        )
        .await,
    );
    let binding = query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.read","version":1},"instance":instance.instance.identity})).await;
    let data = query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":binding,"arguments":{"action":"resource_put"}}),
    )
    .await;
    let reference = data["reference"].clone();
    assert_eq!(reference["bytes"], 2100003);
    let listed = query(
        &host,
        &context,
        "resources.list",
        json!({"owner":instance.instance.identity,"after":null,"limit":1}),
    )
    .await;
    assert_eq!(listed["items"][0], reference);
    assert_eq!(listed["total"], 1);
    assert_eq!(
        query(
            &host,
            &context,
            "resources.inspect",
            json!({"reference":reference})
        )
        .await,
        reference
    );
    let read = json!({"reference":reference,"offset":65530,"limit":100000});
    let chunk = query(&host, &context, "resources.read", read.clone()).await;
    assert_eq!(chunk["next"], 165530);
    assert_eq!(
        STANDARD.decode(chunk["base64"].as_str().unwrap()).unwrap(),
        (65530..165530).map(|i| (i % 251) as u8).collect::<Vec<_>>()
    );
    let mut stranger = context.clone();
    stranger.caller.id = "another-principal".into();
    assert_eq!(
        query(
            &host,
            &stranger,
            "resources.list",
            json!({"owner":null,"after":null,"limit":1})
        )
        .await["total"],
        0
    );
    let mut missing_scope = context.clone();
    missing_scope.scopes.remove("resources.read");
    for caller in [&stranger, &missing_scope] {
        assert!(
            host.query_snapshot(
                caller,
                QueryRequest {
                    capability: CapabilityRef::new("resources.read", 1).unwrap(),
                    arguments: read.clone()
                }
            )
            .await
            .is_err()
        );
    }
    let binding = query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.run","version":1},"instance":instance.instance.identity})).await;
    let invocation = invocation(
        "resource-science",
        "fixture.run",
        json!({"binding":binding,"arguments":{"action":"resource_commit","bytes":500001}}),
    );
    let record = host.invoke(&context, invocation.clone()).await.unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded);
    let result_reference = record.output.as_ref().unwrap()["reference"].clone();
    let events = host
        .events(&context, &record.operation.operation_id)
        .await
        .unwrap();
    let evidence = events
        .iter()
        .find(|event| event.kind == "effect.observed" && event.payload["kind"] == "plugin.evidence")
        .unwrap();
    assert_eq!(
        evidence.payload["detail"]["references"][0],
        result_reference
    );
    let forged = run(
        &host,
        &context,
        "resource-forged",
        "fixture.run",
        json!({"binding":binding,"arguments":{"action":"resource_commit","bytes":5,"forged":true}}),
    )
    .await;
    assert_eq!(forged.status, OperationStatus::Uncertain);
    assert!(forged.output.is_none());
    assert!(
        host.facts_for_operation(&context, &forged.operation.operation_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(forged.recovery.is_some());
    observation(
        &run(
            &host,
            &context,
            "resource-release",
            "plugins.release",
            json!({"instance":instance.instance.identity}),
        )
        .await,
    );
    let removed = run(
        &host,
        &context,
        "resource-remove",
        "plugins.remove",
        json!({"revision":archive.revision.id}),
    )
    .await;
    assert_eq!(removed.status, OperationStatus::Succeeded);
    assert!(repository.revision(&archive.revision.id).is_err());
    assert_eq!(
        query(
            &host,
            &context,
            "resources.inspect",
            json!({"reference":result_reference})
        )
        .await,
        result_reference
    );
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_project(&db, &project).await.unwrap();
    assert!(
        reopened
            .capabilities()
            .iter()
            .all(|d| d.capability.id != "fixture.read")
    );
    assert_eq!(
        query(&reopened, &context, "resources.read", read).await,
        chunk
    );
    assert_eq!(
        reopened
            .invoke(&context, invocation)
            .await
            .unwrap()
            .operation
            .operation_id,
        record.operation.operation_id
    );
    assert_eq!(
        query(
            &reopened,
            &context,
            "operation.get",
            json!({"operation_id":record.operation.operation_id})
        )
        .await["record"]["status"],
        json!("succeeded")
    );
    assert_eq!(
        query(
            &reopened,
            &context,
            "resources.inspect",
            json!({"reference":result_reference})
        )
        .await,
        result_reference
    );
    reopened.drain().await;
}

#[tokio::test]
async fn official_host_ports_bind_revisions_visibility_commit_and_release_without_r() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state/state.sqlite");
    let one = fixture::package(&temp.path().join("external-one"), "1", false);
    let two = fixture::package(&temp.path().join("external-two"), "2", false);
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    repository.import(&one).unwrap();
    repository.import(&two).unwrap();
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let context = NextHost::local_context();
    assert_eq!(
        query(&host, &context, "plugins.instances", json!({"limit":10})).await["total"],
        0
    );
    assert!(
        !host
            .capabilities()
            .iter()
            .any(|d| d.capability.id == "fixture.read")
    );
    let first = run(
        &host,
        &context,
        "activate-one",
        "plugins.activate",
        activation(&one, "one"),
    )
    .await;
    let a = observation(&first);
    let b = observation(
        &run(
            &host,
            &context,
            "activate-two",
            "plugins.activate",
            activation(&two, "two"),
        )
        .await,
    );
    assert_ne!(a.process_id, b.process_id);
    assert!(a.observed_in_this_host);
    let mut stranger = context.clone();
    stranger.caller.id = "another-principal".into();
    assert_eq!(
        query(&host, &stranger, "plugins.instances", json!({"limit":1})).await["total"],
        0
    );
    assert!(
        host.query_snapshot(
            &stranger,
            QueryRequest {
                capability: CapabilityRef::new("plugins.instance", 1).unwrap(),
                arguments: json!({"instance":a.instance.identity})
            }
        )
        .await
        .is_err()
    );
    assert!(
        host.query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("plugins.resolve", 1).unwrap(),
                arguments: json!({"capability":{"id":"fixture.run","version":1}})
            }
        )
        .await
        .is_err()
    );
    let binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"capability":{"id":"fixture.run","version":1},"instance":a.instance.identity}),
    )
    .await;
    let original = invocation(
        "original-science",
        "fixture.run",
        json!({"binding":binding,"arguments":{"action":"commit","message":"中文"},"preconditions":{}}),
    );
    let record = host.invoke(&context, original.clone()).await.unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded);
    assert_eq!(record.output.as_ref().unwrap()["label"], "one");
    let receipt = query(
        &host,
        &context,
        "operation.get",
        json!({"operation_id":record.operation.operation_id}),
    )
    .await;
    assert_eq!(receipt["output_contract"]["availability"], "registered");
    let events = host.outbox(&context, 0, 100).await.unwrap();
    assert!(
        events
            .iter()
            .any(|e| e.operation_id == record.operation.operation_id)
    );
    for (id, identity) in [
        ("release-one", &a.instance.identity),
        ("release-two", &b.instance.identity),
    ] {
        assert_eq!(
            observation(
                &run(
                    &host,
                    &context,
                    id,
                    "plugins.release",
                    json!({"instance":identity})
                )
                .await
            )
            .instance
            .state,
            rho_plugin_protocol::InstanceState::Released
        );
    }
    assert!(
        !host
            .capabilities()
            .iter()
            .any(|d| d.capability.id == "fixture.run")
    );
    assert_eq!(
        host.invoke(&context, original)
            .await
            .unwrap()
            .operation
            .operation_id,
        record.operation.operation_id
    );
    assert_eq!(
        host.invoke(
            &context,
            invocation("activate-one", "plugins.activate", activation(&one, "one"))
        )
        .await
        .unwrap()
        .operation
        .operation_id,
        first.operation.operation_id
    );
    assert_eq!(
        query(
            &host,
            &context,
            "operation.get",
            json!({"operation_id":record.operation.operation_id})
        )
        .await["output_contract"]["availability"],
        "owner_unavailable_in_this_host"
    );
    assert!(
        repository
            .inspect(&one.revision.id)
            .unwrap()
            .references
            .is_empty()
    );
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_project(&db, &project).await.unwrap();
    let historic = query(
        &reopened,
        &context,
        "plugins.instance",
        json!({"instance":a.instance.identity}),
    )
    .await;
    assert_eq!(historic["observed_in_this_host"], false);
    assert!(historic["process_id"].is_null());
    assert!(
        !reopened
            .capabilities()
            .iter()
            .any(|d| d.capability.id == "fixture.run")
    );
    reopened.drain().await;
}

#[tokio::test]
async fn activation_rejects_scope_escalation_and_collisions_without_publishing_partial_tools() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let archive = fixture::package(&temp.path().join("external"), "1", true);
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&archive).unwrap();
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let context = NextHost::local_context();
    let mut limited = context.clone();
    limited.scopes.remove("plugins.write");
    assert!(matches!(
        host.invoke(
            &limited,
            invocation(
                "no-grant",
                "plugins.activate",
                activation(&archive, "collision")
            )
        )
        .await,
        Err(OperationError::AccessDenied { .. })
    ));
    assert_eq!(
        query(&host, &context, "plugins.instances", json!({"limit":10})).await["total"],
        0
    );
    let result = run(
        &host,
        &context,
        "collision",
        "plugins.activate",
        activation(&archive, "collision"),
    )
    .await;
    assert_eq!(result.status, OperationStatus::Uncertain);
    assert!(
        !host
            .capabilities()
            .iter()
            .any(|d| d.capability.id == "fixture.run")
    );
    let instances = query(&host, &context, "plugins.instances", json!({"limit":10})).await;
    assert_eq!(instances["instances"][0]["instance"]["state"], "released");
    assert_eq!(
        query(&host, &context, "plugins.list", json!({"limit":10})).await["total"],
        1
    );
    host.drain().await;
}

#[tokio::test]
async fn backend_delegation_uses_shared_query_and_operation_ports() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let archive = fixture::package(&temp.path().join("external"), "1", false);
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&archive).unwrap();
    let host = Arc::new(NextHost::open_project(&db, &project).await.unwrap());
    let context = NextHost::local_context();
    let instance = observation(
        &run(
            &host,
            &context,
            "start",
            "plugins.activate",
            activation(&archive, "delegate"),
        )
        .await,
    );
    let binding=query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.read","version":1},"instance":instance.instance.identity})).await;
    let delegated=query(&host,&context,"fixture.read",json!({"binding":binding,"arguments":{"action":"delegate","host_arguments":{"limit":1}},"preconditions":{}})).await;
    assert_eq!(
        delegated["delegated"]["result"]["data"]["total"], 1,
        "{delegated}"
    );
    let denied=query(&host,&context,"fixture.read",json!({"binding":binding,"arguments":{"action":"delegate_branch","host_arguments":{"revision":archive.revision.id,"name":"forbidden query mutation"}},"preconditions":{}})).await;
    assert_eq!(denied["delegated"]["code"], "host_call_failed");
    let binding=query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.run","version":1},"instance":instance.instance.identity})).await;
    let result=run(&host,&context,"parent","fixture.run",json!({"binding":binding,"arguments":{"action":"delegate_operation","host_arguments":{"revision":archive.revision.id,"name":"Native delegated branch"}},"preconditions":{}})).await;
    assert_eq!(
        result.status,
        OperationStatus::Succeeded,
        "status={:?} error={:?}",
        result.status,
        result.error
    );
    let child = &result.output.as_ref().unwrap()["arguments"]["delegated"]["result"];
    assert_eq!(child["status"], "succeeded", "{child}");
    assert_eq!(
        child["operation"]["causation_id"],
        json!(result.operation.operation_id)
    );
    assert_eq!(child["operation"]["caller"]["kind"], "plugin");
    assert_eq!(child["operation"]["principal"], json!(context.caller));
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.branch_head",
            json!({"branch":child["output"]["branch"]})
        )
        .await["revision"],
        json!(archive.revision.id)
    );
    host.drain().await;
}

fn ui_package(path: &std::path::Path) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(
        path.join("index.html"),
        "<!doctype html><h1>External view</h1>",
    )
    .unwrap();
    fs::copy(path.join("index.html"), path.join("dist/index.html")).unwrap();
    fs::write(path.join("deps.lock"), "No dependencies").unwrap();
    fs::write(path.join("BUILD.md"), "Copy index.html to dist/index.html").unwrap();
    fs::write(path.join("plugin.json"),serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.view","name":"External view","version":"1","description":"Independent isolated view","license":"MIT",
        "source":{"files":["index.html"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{},"requires":[{"capability":{"id":"plugins.list","version":1},"scopes":["plugins.read"]}],
        "views":[{"id":"view","title":"External view","entrypoint":"dist/index.html","state_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false},"configuration_schema":{"type":"object","additionalProperties":false},"resource_kinds":[]}],
        "capabilities":[],"contexts":[],"backend":null,"configuration_schema":{"type":"object","additionalProperties":false},"default_configuration":{}
    })).unwrap()).unwrap();
    rho_plugins::snapshot_directory(path, None, "ui-web").unwrap()
}

#[tokio::test]
async fn ui_only_views_have_scoped_channels_durable_state_and_independent_instance_lifetimes() {
    use rho_plugin_protocol::{PluginViewConnection, PluginViewMessage, PluginViewRecord};
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state/state.sqlite");
    let archive = ui_package(&temp.path().join("external-ui"));
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&archive).unwrap();
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let context = NextHost::local_context();
    let args = json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":"ui-web","alias":"ui","configuration":{}});
    let instance =
        observation(&run(&host, &context, "ui-activate", "plugins.activate", args).await);
    assert!(instance.process_id.is_none());
    assert!(instance.observed_in_this_host);
    assert!(host.invoke(&context,invocation("oversized-view","views.open",json!({"instance":instance.instance.identity,"contribution":"view","window":"window-a","configuration":{},"state":{"text":"x".repeat(256*1024)}}))).await.is_err());
    let record=run(&host,&context,"view-open","views.open",json!({"instance":instance.instance.identity,"contribution":"view","window":"window-a","configuration":{},"state":{"text":"中文 α"}})).await;
    assert_eq!(
        record.status,
        OperationStatus::Succeeded,
        "{:?}",
        record.error
    );
    let view: PluginViewRecord = serde_json::from_value(record.output.unwrap()).unwrap();
    let connection: PluginViewConnection = serde_json::from_value(
        query(
            &host,
            &context,
            "views.connection",
            json!({"view":view.view}),
        )
        .await,
    )
    .unwrap();
    assert!(
        !serde_json::to_string(&record.operation)
            .unwrap()
            .contains(&connection.call_token)
    );
    let message = |sequence, body: Value| {
        serde_json::from_value::<PluginViewMessage>(json!({"protocol_version":1,"connection":connection.connection,"view":view.view,"sequence":sequence,"request":format!("request-{sequence}"),"body":body})).unwrap()
    };
    let list = json!({"type":"query","capability":{"id":"plugins.list","version":1},"arguments":{"after":null,"limit":10}});
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-b",
            &connection.call_token,
            message(1, list.clone())
        )
        .await
        .is_err()
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.asset_token,
            message(1, list.clone())
        )
        .await
        .is_err()
    );
    let mut stranger = context.clone();
    stranger.caller.id = "stranger".into();
    assert!(
        host.dispatch_plugin_view(
            &stranger,
            "window-a",
            &connection.call_token,
            message(1, list.clone())
        )
        .await
        .is_err()
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(1, list.clone())
        )
        .await
        .is_ok()
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(1, list.clone())
        )
        .await
        .is_err()
    );
    // The same broad scope cannot grant an undeclared capability.
    assert!(host.dispatch_plugin_view(&context,"window-a",&connection.call_token,message(2,json!({"type":"query","capability":{"id":"plugins.instances","version":1},"arguments":{"limit":10}}))).await.is_err());
    let ordered: PluginViewRecord = serde_json::from_value(run(&host,&context,"ordered-open","views.open",json!({"instance":instance.instance.identity,"contribution":"view","window":"window-a","configuration":{},"state":{"text":""}})).await.output.unwrap()).unwrap();
    let ordered_connection: PluginViewConnection = serde_json::from_value(query(&host,&context,"views.connection",json!({"view":ordered.view})).await).unwrap();
    let ordered_message=|sequence|serde_json::from_value::<PluginViewMessage>(json!({"protocol_version":1,"connection":ordered_connection.connection,"view":ordered.view,"sequence":sequence,"request":format!("ordered-{sequence}"),"body":list})).unwrap();
    let mut second=Box::pin(host.dispatch_plugin_view(&context,"window-a",&ordered_connection.call_token,ordered_message(2)));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(25),second.as_mut()).await.is_err());
    let (second,first)=tokio::join!(second,host.dispatch_plugin_view(&context,"window-a",&ordered_connection.call_token,ordered_message(1)));
    assert!(first.is_ok() && second.is_ok());
    assert_eq!(run(&host,&context,"ordered-close","views.close",json!({"view":ordered.view})).await.status,OperationStatus::Succeeded);
    let saved = host
        .dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(
                3,
                json!({"type":"set_state","expected_version":0,"state":{"text":"kept Ω"}}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(saved["status"], "succeeded");
    assert_eq!(saved["output"]["state_version"], 1);
    let stale = run(
        &host,
        &context,
        "stale-state",
        "views.update",
        json!({"view":view.view,"expected_version":0,"state":{"text":"stale"}}),
    )
    .await;
    assert_ne!(stale.status, OperationStatus::Succeeded);
    let asset = host
        .plugin_view_asset(
            connection.connection.as_str(),
            &connection.asset_token,
            "dist/index.html",
        )
        .unwrap();
    assert!(
        String::from_utf8(asset.bytes)
            .unwrap()
            .contains("External view")
    );
    assert!(
        host.plugin_view_asset(
            connection.connection.as_str(),
            &connection.asset_token,
            "dist/../plugin.json"
        )
        .is_err()
    );
    assert!(
        host.plugin_view_asset(
            connection.connection.as_str(),
            &connection.asset_token,
            "index.html"
        )
        .is_err()
    );
    assert!(
        host.plugin_view_asset(
            connection.connection.as_str(),
            &connection.call_token,
            "dist/index.html"
        )
        .is_err()
    );
    assert!(repo.remove(&archive.revision.id).is_err());
    let closed = run(
        &host,
        &context,
        "view-close",
        "views.close",
        json!({"view":view.view}),
    )
    .await;
    assert_eq!(closed.status, OperationStatus::Succeeded);
    assert!(
        host.plugin_view_asset(
            connection.connection.as_str(),
            &connection.asset_token,
            "dist/index.html"
        )
        .is_err()
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(4, list)
        )
        .await
        .is_err()
    );
    let still = query(
        &host,
        &context,
        "plugins.instance",
        json!({"instance":instance.instance.identity}),
    )
    .await;
    assert_eq!(still["instance"]["state"], "active");
    let released = run(
        &host,
        &context,
        "ui-release",
        "plugins.release",
        json!({"instance":instance.instance.identity}),
    )
    .await;
    assert_eq!(
        released.status,
        OperationStatus::Succeeded,
        "{:?}",
        released.error
    );
    repo.remove(&archive.revision.id).unwrap();
    drop(host);
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let stored = query(&host, &context, "views.inspect", json!({"view":view.view})).await;
    assert_eq!(stored["state"]["text"], "kept Ω");
    assert_eq!(stored["closed"], true);
    assert!(
        host.query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("views.connection", 1).unwrap(),
                arguments: json!({"view":view.view})
            }
        )
        .await
        .is_err()
    );
    repo.import(&archive).unwrap();
    let historical=observation(&run(&host,&context,"ui-historical","plugins.activate",json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":"ui-web","alias":"historical","configuration":{}})).await);
    let old_view=run(&host,&context,"view-historical","views.open",json!({"instance":historical.instance.identity,"contribution":"view","window":"window-a","configuration":{},"state":{"text":"saved before disconnect"}})).await.output.unwrap();
    drop(host);
    let host = NextHost::open_project(&db, &project).await.unwrap();
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.instance",
            json!({"instance":historical.instance.identity})
        )
        .await["observed_in_this_host"],
        false
    );
    assert_eq!(
        run(
            &host,
            &context,
            "close-historical",
            "views.close",
            json!({"view":old_view["view"]})
        )
        .await
        .status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        run(
            &host,
            &context,
            "release-historical",
            "plugins.release",
            json!({"instance":historical.instance.identity})
        )
        .await
        .status,
        OperationStatus::Succeeded
    );
    repo.remove(&archive.revision.id).unwrap();
}

#[tokio::test]
async fn closing_a_view_does_not_cancel_or_retarget_its_accepted_native_operation() {
    use rho_plugin_protocol::{PluginViewConnection, PluginViewMessage, PluginViewRecord};
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let native = fixture::package(&temp.path().join("native"), "1", false);
    let ui_path = temp.path().join("ui");
    ui_package(&ui_path);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(ui_path.join("plugin.json")).unwrap()).unwrap();
    manifest["requires"] =
        json!([{"capability":{"id":"fixture.run","version":1},"scopes":["plugins.run"]}]);
    fs::write(
        ui_path.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let ui = rho_plugins::snapshot_directory(&ui_path, None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&native).unwrap();
    repo.import(&ui).unwrap();
    let host = NextHost::open_project(&db, &project).await.unwrap();
    let context = NextHost::local_context();
    let native_instance = observation(
        &run(
            &host,
            &context,
            "native-start",
            "plugins.activate",
            activation(&native, "native"),
        )
        .await,
    );
    let ui_instance=observation(&run(&host,&context,"ui-start","plugins.activate",json!({"revision":ui.revision.id,"artifact":ui.artifacts[0].id,"target":"ui-web","alias":"ui","configuration":{}})).await);
    let view:PluginViewRecord=serde_json::from_value(run(&host,&context,"open","views.open",json!({"instance":ui_instance.instance.identity,"contribution":"view","window":"window-a","configuration":{},"state":{"text":""}})).await.output.unwrap()).unwrap();
    let connection: PluginViewConnection = serde_json::from_value(
        query(
            &host,
            &context,
            "views.connection",
            json!({"view":view.view}),
        )
        .await,
    )
    .unwrap();
    let binding=query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.run","version":1},"instance":native_instance.instance.identity})).await;
    let message = |sequence, body| {
        serde_json::from_value::<PluginViewMessage>(json!({"protocol_version":1,"connection":connection.connection,"view":view.view,"sequence":sequence,"request":format!("message-{sequence}"),"body":body})).unwrap()
    };
    let accepted=host.dispatch_plugin_view(&context,"window-a",&connection.call_token,message(1,json!({"type":"invoke","request_id":"x".repeat(128),"capability":{"id":"fixture.run","version":1},"arguments":{"binding":binding,"arguments":{"action":"hold"}},"preconditions":[]}))).await.unwrap();
    let record: OperationRecord = serde_json::from_value(accepted).unwrap();
    assert!(!record.status.is_terminal());
    let foreign = run(
        &host,
        &context,
        "foreign-read",
        "plugins.branch",
        json!({"revision":ui.revision.id,"name":"branch"}),
    )
    .await;
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(
                2,
                json!({"type":"get_operation","operation_id":foreign.operation.operation_id})
            )
        )
        .await
        .is_err()
    );
    let own = host
        .dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(
                3,
                json!({"type":"get_operation","operation_id":record.operation.operation_id}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        own["operation"]["operation_id"],
        json!(record.operation.operation_id)
    );
    let mut no_read = context.clone();
    no_read.scopes.remove("operation.read");
    let cancellation = host
        .dispatch_plugin_view(
            &no_read,
            "window-a",
            &connection.call_token,
            message(
                4,
                json!({"type":"cancel","operation_id":record.operation.operation_id}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(cancellation["accepted"], true);
    assert_eq!(
        run(
            &host,
            &context,
            "close",
            "views.close",
            json!({"view":view.view})
        )
        .await
        .status,
        OperationStatus::Succeeded
    );
    assert_eq!(
        run(
            &host,
            &context,
            "release-ui",
            "plugins.release",
            json!({"instance":ui_instance.instance.identity})
        )
        .await
        .status,
        OperationStatus::Succeeded
    );
    let binding=query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.read","version":1},"instance":native_instance.instance.identity})).await;
    // A read roundtrip establishes that the backend received the accepted call;
    // finish is an explicit fixture control that completes the original request.
    query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":binding,"arguments":{"action":"finish"}}),
    )
    .await;
    let completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let current = host
                .get_operation(&context, &record.operation.operation_id)
                .await
                .unwrap()
                .unwrap();
            if current.status.is_terminal() {
                break current;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed.status, OperationStatus::Succeeded);
    assert_eq!(completed.operation.caller.id, view.view.as_str());
    assert_eq!(completed.operation.principal(), context.principal());
    assert_eq!(
        run(
            &host,
            &context,
            "release-native",
            "plugins.release",
            json!({"instance":native_instance.instance.identity})
        )
        .await
        .status,
        OperationStatus::Succeeded
    );
}

#[tokio::test]
async fn ephemeral_controls_share_host_and_view_authority_without_recording_answers() {
    use rho_plugin_protocol::{PluginViewConnection, PluginViewMessage};
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let native = fixture::package(&temp.path().join("native"), "1", false);
    let ui_path = temp.path().join("ui");
    ui_package(&ui_path);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(ui_path.join("plugin.json")).unwrap()).unwrap();
    manifest["requires"] =
        json!([{"capability":{"id":"fixture.answer","version":2},"scopes":["plugins.run"]}]);
    fs::write(
        ui_path.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let ui = rho_plugins::snapshot_directory(&ui_path, None, "ui-web").unwrap();
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&native).unwrap();
    repo.import(&ui).unwrap();
    let host = Arc::new(NextHost::open_project(&db, &project).await.unwrap());
    let context = NextHost::local_context();
    let native_instance = observation(
        &run(
            &host,
            &context,
            "control-native",
            "plugins.activate",
            activation(&native, "native"),
        )
        .await,
    );
    let ui_instance = observation(&run(&host,&context,"control-ui","plugins.activate",json!({"revision":ui.revision.id,"artifact":ui.artifacts[0].id,"target":"ui-web","alias":"ui","configuration":{}})).await);
    let view = run(&host,&context,"control-view","views.open",json!({"instance":ui_instance.instance.identity,"contribution":"view","window":"window-a","configuration":{},"state":{"text":""}})).await.output.unwrap();
    let connection: PluginViewConnection = serde_json::from_value(
        query(
            &host,
            &context,
            "views.connection",
            json!({"view":view["view"]}),
        )
        .await,
    )
    .unwrap();
    let binding = query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.answer","version":2},"instance":native_instance.instance.identity})).await;
    let secret = "transient-only-Ω-42197";
    let request = |version, args: Value| {
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new("fixture.answer", version).unwrap(),
            arguments: json!({"binding":binding,"arguments":args}),
        })
    };
    assert!(!format!("{:?}", request(2, json!({"value":secret}))).contains(secret));
    let counts = || {
        let connection = rusqlite::Connection::open(&db).unwrap();
        [
            "operations",
            "operation_events",
            "domain_facts",
            "outbox",
            "operation_commit_candidates",
            "operation_uncommitted_evidence",
        ]
        .map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        })
    };
    let before = counts();
    let outbox = host.outbox(&context, 0, 100).await.unwrap();
    let read_binding = query(&host,&context,"plugins.resolve",json!({"capability":{"id":"fixture.read","version":1},"instance":native_instance.instance.identity})).await;
    let held_host = host.clone();
    let held_request = request(2,json!({"value":secret,"action":"hold"}));
    let held = tokio::spawn(async move { held_host.dispatch(&NextHost::local_context(), held_request).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(20));
        loop {
            interval.tick().await;
            if query(&host,&context,"fixture.read",json!({"binding":read_binding,"arguments":{"action":"control_pending"}})).await["pending"] == 1 { break; }
        }
    }).await.unwrap();
    held.abort();
    assert!(held.await.unwrap_err().is_cancelled());
    assert_eq!(query(&host,&context,"plugins.instance",json!({"instance":native_instance.instance.identity})).await["retained_calls"],1,
        "Caller disconnect must not drop the dispatched control's provider lease");
    assert_eq!(host.dispatch(&context,request(2,json!({"value":secret,"action":"finish"}))).await.unwrap(),json!({"submitted":true}));
    for action in ["answer", "resource_put"] {
        assert_eq!(
            host.dispatch(
                &context,
                request(2, json!({"value":secret,"action":action}))
            )
            .await
            .unwrap(),
            json!({"submitted":true})
        );
    }
    for action in ["reject", "bad_output"] {
        let error = host
            .dispatch(
                &context,
                request(2, json!({"value":secret,"action":action})),
            )
            .await
            .unwrap_err();
        assert!(!format!("{error:?}").contains(secret));
    }
    let invalid = host
        .dispatch(&context, request(2, json!({"value":{"invalid":secret}})))
        .await
        .unwrap_err();
    assert!(!format!("{invalid:?}").contains(secret));
    assert!(
        host.dispatch(&context, request(1, json!({"value":secret})))
            .await
            .is_err()
    );
    let mut stranger = context.clone();
    stranger.caller.id = "another-principal".into();
    let mut denied = context.clone();
    denied.scopes.remove("plugins.run");
    for caller in [&stranger, &denied] {
        assert!(
            host.dispatch(caller, request(2, json!({"value":secret})))
                .await
                .is_err()
        );
    }
    // Neither a Query nor a new Operation is an alternate way to send a control.
    assert!(
        host.query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("fixture.answer", 2).unwrap(),
                arguments: json!({"binding":binding,"arguments":{"value":secret}})
            }
        )
        .await
        .is_err()
    );
    let mut invoke = invocation(
        "must-not-record-control",
        "fixture.answer",
        json!({"binding":binding,"arguments":{"value":secret}}),
    );
    invoke.capability.version = 2;
    assert!(host.invoke(&context, invoke).await.is_err());
    let message = |sequence, capability: &str| {
        serde_json::from_value::<PluginViewMessage>(json!({
        "protocol_version":1,"connection":connection.connection,"view":view["view"],"sequence":sequence,"request":format!("answer-{sequence}"),
        "body":{"type":"control","capability":{"id":capability,"version":2},"arguments":{"binding":binding,"arguments":{"value":secret}}}
    })).unwrap()
    };
    assert_eq!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(1, "fixture.answer")
        )
        .await
        .unwrap(),
        json!({"submitted":true})
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(2, "undeclared.answer")
        )
        .await
        .is_err()
    );
    assert!(
        host.dispatch_plugin_view(
            &context,
            "wrong-window",
            &connection.call_token,
            message(3, "fixture.answer")
        )
        .await
        .is_err()
    );
    assert_eq!(
        counts(),
        before,
        "Controls cannot create receipts, results, recovery candidates or events"
    );
    assert_eq!(
        json!(host.outbox(&context, 0, 100).await.unwrap()),
        json!(outbox)
    );
    assert_eq!(
        query(
            &host,
            &context,
            "resources.list",
            json!({"owner":native_instance.instance.identity,"limit":10})
        )
        .await["total"],
        0
    );
    run(
        &host,
        &context,
        "close-control-view",
        "views.close",
        json!({"view":view["view"]}),
    )
    .await;
    for (id, instance) in [
        ("control-release-ui", ui_instance),
        ("control-release-native", native_instance),
    ] {
        let released = run(
            &host,
            &context,
            id,
            "plugins.release",
            json!({"instance":instance.instance.identity}),
        )
        .await;
        assert_eq!(released.status, OperationStatus::Succeeded);
    }
    assert!(
        host.dispatch(&context, request(2, json!({"value":secret})))
            .await
            .is_err()
    );
    host.drain().await;
    drop(host);
    // SQLite and retained repository diagnostics must not contain the answer.
    for path in [&db, &db.with_extension("sqlite-wal")] {
        if let Ok(bytes) = fs::read(path) {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|part| part == secret.as_bytes())
            );
        }
    }
    assert!(
        !serde_json::to_string(&repo.recorded_instances(None, 100).unwrap())
            .unwrap()
            .contains(secret)
    );
}
