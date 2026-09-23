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
