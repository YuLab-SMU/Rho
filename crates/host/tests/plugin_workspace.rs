//! The generic Host composition is the prerequisite for disposable backend-test
//! projects. These fixtures do not implement Studio's project-creation UI.
#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::{HostProfile, NextHost, OperationError, RuntimeConfiguration};
use rho_plugin_protocol::PluginArchive;
use rho_plugins::{PluginRepository, backend_target, repository_path};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path, sync::Arc};

async fn query(host: &NextHost, context: &CallContext, id: &str, arguments: Value) -> Value {
    host.query_snapshot(
        context,
        QueryRequest {
            capability: CapabilityRef::new(id, 1).unwrap(),
            arguments,
        },
    )
    .await
    .unwrap()
    .data
    .unwrap()
}
fn invocation(id: &str, capability: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
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
async fn activate(
    host: &NextHost,
    context: &CallContext,
    package: &PluginArchive,
    alias: &str,
) -> Value {
    run(
        host,
        context,
        "activate",
        "plugins.activate",
        json!({
            "revision":package.revision.id,"artifact":package.artifacts[0].id,
            "target":backend_target(),"alias":alias,"configuration":{"label":alias}
        }),
    )
    .await
    .output
    .unwrap()["instance"]["identity"]
        .clone()
}
async fn binding(host: &NextHost, context: &CallContext, instance: &Value, id: &str) -> Value {
    query(
        host,
        context,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":id,"version":1}}),
    )
    .await
}
fn generic_capabilities(host: &NextHost) -> BTreeSet<String> {
    let ids = host
        .capabilities()
        .into_iter()
        .map(|descriptor| descriptor.capability.id)
        .collect::<BTreeSet<_>>();
    assert!(
        ids.iter().all(|id| [
            "host.",
            "plugins.",
            "views.",
            "windows.",
            "scenarios.",
            "documents.",
            "resources.",
            "operation."
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix))
            || id == "workspace.paths"),
        "{ids:?}"
    );
    for id in [
        "plugins.list",
        "plugins.activate",
        "plugins.build",
        "plugins.preview",
        "operation.get",
        "operation.list_recent",
        "windows.layout",
        "workspace.paths",
    ] {
        assert!(ids.contains(id), "{id}");
    }
    ids
}
fn no_scientific_stores(root: &Path) {
    for path in [
        "runtime",
        "environment",
        "records.studio.sqlite",
        "runtime-preferences.sqlite",
    ] {
        assert!(
            !root.join(path).exists(),
            "unexpected scientific store: {path}"
        );
    }
}

#[tokio::test]
async fn empty_plugin_workspace_retains_canonical_scope_and_native_lease_without_scientific_owners()
{
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let database = temp.path().join("state/records.sqlite");
    let profile = HostProfile {
        database: database.clone(),
        runtime: RuntimeConfiguration::Plugins,
        remote: None,
        host_skills: None,
    };
    assert_eq!(profile.runtime_name(), "plugins");
    let host = profile.open(&project).await.unwrap();
    let context = NextHost::local_context();
    let baseline = generic_capabilities(&host);
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.list",
            json!({"after":null,"limit":100})
        )
        .await["total"],
        0
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.instances",
            json!({"after":null,"limit":100})
        )
        .await["total"],
        0
    );
    assert_eq!(
        query(
            &host,
            &context,
            "operation.list_recent",
            json!({"limit":100})
        )
        .await["operations"],
        json!([])
    );
    let paths = query(&host, &context, "workspace.paths", json!({})).await;
    assert_eq!(
        paths["project_root"],
        project.canonicalize().unwrap().to_str().unwrap()
    );
    assert!(
        paths["protected_paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str().unwrap().ends_with(".rho/next-host.lock"))
    );
    assert!(matches!(
        NextHost::open_plugin_workspace(temp.path().join("other.sqlite"), &project).await,
        Err(OperationError::ProjectBusy(_))
    ));
    let denied = host
        .query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("project.read", 1).unwrap(),
                arguments: json!({}),
            },
        )
        .await;
    assert!(
        denied.is_err(),
        "the core must not construct a Files/Git owner"
    );
    no_scientific_stores(database.parent().unwrap());
    host.drain().await;
    drop(host);
    let reopened = profile
        .for_new_project()
        .open_deferred(&project)
        .await
        .unwrap();
    assert_eq!(generic_capabilities(&reopened), baseline);
    assert_eq!(
        query(
            &reopened,
            &context,
            "plugins.list",
            json!({"after":null,"limit":100})
        )
        .await["total"],
        0
    );
    no_scientific_stores(database.parent().unwrap());
    reopened.drain().await;
}

#[tokio::test]
async fn independent_backend_projects_preserve_running_work_and_empty_catalog_history() {
    let temp = tempfile::tempdir().unwrap();
    let current = temp.path().join("current");
    let test = temp.path().join("test");
    fs::create_dir(&current).unwrap();
    fs::create_dir(&test).unwrap();
    let current_db = temp.path().join("current-state/records.sqlite");
    let test_db = temp.path().join("test-state/records.sqlite");
    let package = fixture::package(&temp.path().join("external-source"), "1", false);
    for database in [&current_db, &test_db] {
        PluginRepository::open(&repository_path(database))
            .unwrap()
            .import(&package)
            .unwrap();
    }
    let context = NextHost::local_context();
    let original = Arc::new(
        NextHost::open_plugin_workspace(&current_db, &current)
            .await
            .unwrap(),
    );
    let original_instance = activate(&original, &context, &package, "analysis").await;
    let original_read = binding(&original, &context, &original_instance, "fixture.read").await;
    let original_run = binding(&original, &context, &original_instance, "fixture.run").await;
    let accepted: OperationRecord = serde_json::from_value(
        original
            .dispatch(
                &context,
                HostRequest::Invoke(InvokeRequest {
                    invocation: invocation(
                        "continue-analysis",
                        "fixture.run",
                        json!({"binding":original_run,"arguments":{"action":"hold"}}),
                    ),
                    return_after_acceptance: Some(true),
                }),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if query(
                &original,
                &context,
                "fixture.read",
                json!({"binding":original_read,"arguments":{"action":"pending_count"}}),
            )
            .await["operations"]
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Opening the second Host observes its own package inventory without an
    // implicit activation, provider fallback or attachment to the first backend.
    let testing = NextHost::open_plugin_workspace(&test_db, &test)
        .await
        .unwrap();
    let baseline = generic_capabilities(&testing);
    assert_eq!(
        query(
            &testing,
            &context,
            "plugins.instances",
            json!({"after":null,"limit":100})
        )
        .await["total"],
        0
    );
    let test_instance = activate(&testing, &context, &package, "backend-test").await;
    assert_ne!(test_instance["instance"], original_instance["instance"]);
    let test_read = binding(&testing, &context, &test_instance, "fixture.read").await;
    let test_run = binding(&testing, &context, &test_instance, "fixture.run").await;
    for (host, read, root) in [
        (&*original, &original_read, &current),
        (&testing, &test_read, &test),
    ] {
        let environment = query(
            host,
            &context,
            "fixture.read",
            json!({"binding":read,"arguments":{"action":"environment"}}),
        )
        .await;
        assert_eq!(
            environment["environment"]["project_root"],
            root.canonicalize().unwrap().to_str().unwrap()
        );
    }
    assert!(
        testing
            .query_snapshot(
                &context,
                QueryRequest {
                    capability: CapabilityRef::new("fixture.read", 1).unwrap(),
                    arguments: json!({"binding":original_read,"arguments":{}})
                }
            )
            .await
            .is_err()
    );
    let tested = run(
        &testing,
        &context,
        "test-only",
        "fixture.run",
        json!({"binding":test_run,"arguments":{"action":"commit","text":"测试 Ω"}}),
    )
    .await;
    assert_eq!(tested.output.as_ref().unwrap()["label"], "backend-test");
    assert_eq!(
        query(
            &original,
            &context,
            "fixture.read",
            json!({"binding":original_read,"arguments":{"action":"pending_count"}})
        )
        .await["operations"],
        1
    );
    assert!(
        !original
            .get_operation(&context, &accepted.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status
            .is_terminal()
    );
    run(
        &testing,
        &context,
        "release-test",
        "plugins.release",
        json!({"instance":test_instance}),
    )
    .await;
    run(
        &testing,
        &context,
        "remove-test-source",
        "plugins.remove",
        json!({"revision":package.revision.id}),
    )
    .await;
    assert_eq!(generic_capabilities(&testing), baseline);
    assert_eq!(
        query(
            &testing,
            &context,
            "plugins.list",
            json!({"after":null,"limit":100})
        )
        .await["total"],
        0
    );
    testing.drain().await;
    drop(testing);
    let reopened = NextHost::open_plugin_workspace(&test_db, &test)
        .await
        .unwrap();
    assert_eq!(generic_capabilities(&reopened), baseline);
    assert_eq!(
        query(
            &reopened,
            &context,
            "plugins.list",
            json!({"after":null,"limit":100})
        )
        .await["total"],
        0,
        "removed packages must not be reinstalled"
    );
    let historical = query(
        &reopened,
        &context,
        "operation.get",
        json!({"operation_id":tested.operation.operation_id}),
    )
    .await;
    assert_eq!(historical["record"]["status"], "succeeded");
    assert_eq!(historical["record"]["output"]["label"], "backend-test");
    let mut foreign = context.clone();
    foreign.caller.id = "other-user".into();
    assert!(
        reopened
            .get_operation(&foreign, &tested.operation.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        reopened
            .get_operation(&context, &accepted.operation.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    no_scientific_stores(test_db.parent().unwrap());
    reopened.drain().await;
    query(
        &original,
        &context,
        "fixture.read",
        json!({"binding":original_read,"arguments":{"action":"finish"}}),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if original
                .get_operation(&context, &accepted.operation.operation_id)
                .await
                .unwrap()
                .unwrap()
                .status
                == OperationStatus::Succeeded
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        query(
            &original,
            &context,
            "fixture.read",
            json!({"binding":original_read,"arguments":{"action":"cancellation_state"}})
        )
        .await["invocations"],
        1
    );
    original.drain().await;
}
