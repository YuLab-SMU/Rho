//! Disposable projects use the ordinary Host and native backend protocol. These
//! cases never borrow the user's running Host, scientific owners or R session.
#[path = "fixtures/plugins.rs"]
mod fixture;
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol as p;
use rho_plugins::{PluginRepository, repository_path};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc, time::Duration};

fn invoke(id: &str, capability: &str, arguments: Value) -> Invocation {
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
async fn succeeded(
    host: &NextHost,
    context: &CallContext,
    invocation: Invocation,
) -> OperationRecord {
    let result = host.invoke(context, invocation).await.unwrap();
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    result
}
fn selection(package: &p::PluginArchive, configuration: Value) -> Value {
    json!({"name":"临时后端测试 Ω","instances":{"subject":{"plugin":package.revision.manifest.id,"revision":package.revision.id,"artifact":package.artifacts[0].id,"configuration":configuration,"dependencies":{}}}})
}
async fn setup(temp: &Path, package: &p::PluginArchive) -> (Arc<NextHost>, CallContext) {
    fs::create_dir(temp.join("analysis")).unwrap();
    let db = temp.join("state/operations.sqlite");
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(package)
        .unwrap();
    (
        Arc::new(
            NextHost::open_plugin_workspace(db, temp.join("analysis"))
                .await
                .unwrap(),
        ),
        NextHost::local_context(),
    )
}
async fn binding(
    host: &NextHost,
    context: &CallContext,
    instance: &Value,
    capability: &str,
) -> Value {
    query(
        host,
        context,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":capability,"version":1}}),
    )
    .await
}
async fn settled(host: &NextHost, context: &CallContext, id: &OperationId) -> OperationRecord {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let r = host.get_operation(context, id).await.unwrap().unwrap();
            if r.status.is_terminal() && host.is_idle() {
                return r;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
async fn pending(host: &NextHost, context: &CallContext, read: &Value) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if query(
                host,
                context,
                "fixture.read",
                json!({"binding":read,"arguments":{"action":"pending_count"}}),
            )
            .await["operations"]
                == 1
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
fn decode(value: &Value) -> p::PluginTestProjectObservation {
    serde_json::from_value(value.clone()).unwrap()
}

#[tokio::test]
async fn disposable_lifecycle_preserves_analysis_original_work_and_recovery_after_stop() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("external-source");
    fixture::package(&source, "1", false);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(source.join("plugin.json")).unwrap()).unwrap();
    manifest["source"]["files"]
        .as_array_mut()
        .unwrap()
        .push(json!("view.html"));
    manifest["views"] = json!([{"id":"view","title":"Test view","entrypoint":"dist/index.html","state_schema":{},"configuration_schema":{},"resource_kinds":[]}]);
    fs::write(source.join("view.html"), "<!doctype html><p>Test view</p>").unwrap();
    fs::copy(source.join("view.html"), source.join("dist/index.html")).unwrap();
    fs::write(
        source.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let package =
        rho_plugins::snapshot_directory(&source, None, &rho_plugins::backend_target()).unwrap();
    let (host, context) = setup(temp.path(), &package).await;
    let original=succeeded(&host,&context,invoke("analysis","plugins.activate",json!({"revision":package.revision.id,"artifact":package.artifacts[0].id,"target":rho_plugins::backend_target(),"alias":"analysis","configuration":{"label":"analysis"}}))).await.output.unwrap()["instance"]["identity"].clone();
    let original_read = binding(&host, &context, &original, "fixture.read").await;
    let original_run = binding(&host, &context, &original, "fixture.run").await;
    let accepted = host
        .invoke_accepted(
            &context,
            invoke(
                "analysis-running",
                "fixture.run",
                json!({"binding":original_run,"arguments":{"action":"hold"}}),
            ),
        )
        .await
        .unwrap();
    pending(&host, &context, &original_read).await;
    let create = invoke(
        "create-once",
        "plugins.test_create",
        selection(&package, json!({"label":"test"})),
    );
    let created = succeeded(&host, &context, create.clone()).await;
    let observation = decode(created.output.as_ref().unwrap());
    let test = &observation.project;
    assert_eq!(test.state, p::PluginTestProjectState::Ready);
    assert!(observation.observed_in_this_host);
    assert_eq!(
        test.source_operation_id.as_str(),
        created.operation.operation_id.as_str()
    );
    assert_ne!(Path::new(&test.directory), temp.path().join("analysis"));
    assert_eq!(
        succeeded(&host, &context, create)
            .await
            .operation
            .operation_id,
        created.operation.operation_id
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.test_projects",
            json!({"limit":100})
        )
        .await["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let child = host.plugin_test_host(&context, &test.id).unwrap();
    assert!(
        !child
            .capabilities()
            .iter()
            .any(|d| d.capability.id == "plugins.test_create"),
        "disposable projects cannot recursively host disposable projects"
    );
    let identity = json!(test.instances.values().next().unwrap());
    assert_ne!(identity["instance"], original["instance"]);
    let read = binding(&child, &context, &identity, "fixture.read").await;
    let run = binding(&child, &context, &identity, "fixture.run").await;
    assert_eq!(
        query(
            &child,
            &context,
            "fixture.read",
            json!({"binding":read,"arguments":{"action":"environment"}})
        )
        .await["environment"]["project_root"],
        test.directory
    );
    assert!(
        child
            .get_operation(&context, &accepted.operation.operation_id)
            .await
            .unwrap()
            .is_none()
    );
    let activation =
        OperationId::new(test.activation_operations.values().next().unwrap().as_str()).unwrap();
    assert!(
        host.get_operation(&context, &activation)
            .await
            .unwrap()
            .is_none()
    );
    let stop_args = json!({"id":test.id,"expected_version":test.version});
    let borrowed = host
        .invoke(
            &context,
            invoke("borrowed-stop", "plugins.test_stop", stop_args.clone()),
        )
        .await
        .unwrap();
    assert_eq!(borrowed.status, OperationStatus::Failed);
    let work = child
        .invoke_accepted(
            &context,
            invoke(
                "test-running",
                "fixture.run",
                json!({"binding":run,"arguments":{"action":"hold"}}),
            ),
        )
        .await
        .unwrap();
    pending(&child, &context, &read).await;
    drop(child);
    let busy = host
        .invoke(
            &context,
            invoke("busy-stop", "plugins.test_stop", stop_args.clone()),
        )
        .await
        .unwrap();
    assert_eq!(busy.status, OperationStatus::Failed);
    assert_eq!(
        decode(
            &query(
                &host,
                &context,
                "plugins.test_project",
                json!({"id":test.id})
            )
            .await
        )
        .project
        .version,
        test.version
    );
    let child = host.plugin_test_host(&context, &test.id).unwrap();
    query(
        &child,
        &context,
        "fixture.read",
        json!({"binding":read,"arguments":{"action":"finish"}}),
    )
    .await;
    let completed = settled(&child, &context, &work.operation.operation_id).await;
    assert_eq!(completed.status, OperationStatus::Succeeded);
    let view = succeeded(&child,&context,invoke("open-test-view","views.open",json!({"instance":identity,"contribution":"view","window":"test-window","configuration":{},"state":{"draft":"keep me"}}))).await.output.unwrap();
    drop(child);
    let open_view = host
        .invoke(
            &context,
            invoke("view-stop", "plugins.test_stop", stop_args.clone()),
        )
        .await
        .unwrap();
    assert_eq!(open_view.status, OperationStatus::Failed);
    let child = host.plugin_test_host(&context, &test.id).unwrap();
    succeeded(&child,&context,invoke("close-test-view","views.close",json!({"view":view["view"],"mode":{"kind":"retain_acknowledged","expected_version":view["state_version"]}}))).await;
    drop(child);
    // Native release can succeed while the parent catalog fails to record it.
    // Keep the sealed original Host and its pins so explicit recovery remains possible.
    let catalog = rusqlite::Connection::open(
        repository_path(&temp.path().join("state/operations.sqlite")).join("catalog-v1.sqlite3"),
    )
    .unwrap();
    catalog.execute_batch("CREATE TRIGGER fail_test_stop BEFORE UPDATE ON plugin_test_projects WHEN json_extract(NEW.document,'$.state')='stopped' BEGIN SELECT RAISE(ABORT,'fixture stop record failure'); END;").unwrap();
    let uncertain = host
        .invoke(
            &context,
            invoke("stop-storage-failure", "plugins.test_stop", stop_args),
        )
        .await
        .unwrap();
    assert_eq!(uncertain.status, OperationStatus::Uncertain);
    let release_id = uncertain.recovery.as_ref().unwrap()["releases"][0]["operation_id"]
        .as_str()
        .unwrap();
    let release = query(
        &host,
        &context,
        "plugins.test_operation",
        json!({"id":test.id,"operation_id":release_id}),
    )
    .await;
    assert_eq!(release["record"]["status"], "succeeded");
    assert_eq!(
        release["record"]["operation"]["causation_id"],
        uncertain.operation.operation_id.as_str()
    );
    let retained = decode(
        &query(
            &host,
            &context,
            "plugins.test_project",
            json!({"id":test.id}),
        )
        .await,
    );
    assert_eq!(retained.project.state, p::PluginTestProjectState::Stopping);
    assert!(retained.observed_in_this_host);
    let child_database = Path::new(&test.directory)
        .parent()
        .unwrap()
        .join("data/operations.sqlite");
    assert!(matches!(
        NextHost::open_plugin_workspace(&child_database, &test.directory).await,
        Err(OperationError::ProjectBusy(_))
    ));
    assert!(host.plugin_test_host(&context, &test.id).is_err());
    assert!(
        PluginRepository::open(&repository_path(
            &temp.path().join("state/operations.sqlite")
        ))
        .unwrap()
        .references(&package.revision.id)
        .unwrap()
        .contains(&format!("test_project:{}", test.id))
    );
    catalog
        .execute_batch("DROP TRIGGER fail_test_stop")
        .unwrap();
    let stopping = invoke(
        "stop-once",
        "plugins.test_stop",
        json!({"id":test.id,"expected_version":retained.project.version}),
    );
    let stopped = succeeded(&host, &context, stopping.clone()).await;
    let observation = decode(stopped.output.as_ref().unwrap());
    assert_eq!(
        observation.project.state,
        p::PluginTestProjectState::Stopped
    );
    assert!(!observation.observed_in_this_host);
    assert_eq!(
        succeeded(&host, &context, stopping)
            .await
            .operation
            .operation_id,
        stopped.operation.operation_id
    );
    assert!(host.plugin_test_host(&context, &test.id).is_err());
    // Native project and journal leases are released only after confirmed stop.
    let lease_probe = NextHost::open_plugin_workspace(&child_database, &test.directory)
        .await
        .unwrap();
    lease_probe.drain().await;
    drop(lease_probe);
    let original_child = query(
        &host,
        &context,
        "plugins.test_operation",
        json!({"id":test.id,"operation_id":work.operation.operation_id}),
    )
    .await;
    assert_eq!(original_child["record"]["status"], "succeeded");
    assert!(
        query(
            &host,
            &context,
            "plugins.test_operation",
            json!({"id":test.id,"operation_id":accepted.operation.operation_id})
        )
        .await["record"]
            .is_null()
    );
    assert!(
        Path::new(&test.directory)
            .parent()
            .unwrap()
            .join("data/operations.sqlite")
            .is_file()
    );
    assert!(
        !PluginRepository::open(&repository_path(
            &temp.path().join("state/operations.sqlite")
        ))
        .unwrap()
        .references(&package.revision.id)
        .unwrap()
        .iter()
        .any(|r| r.starts_with("test_project:"))
    );
    // Test stop neither cancels nor rebinds the already accepted analysis.
    assert!(
        !host
            .get_operation(&context, &accepted.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status
            .is_terminal()
    );
    query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":original_read,"arguments":{"action":"finish"}}),
    )
    .await;
    let completed = settled(&host, &context, &accepted.operation.operation_id).await;
    assert_eq!(completed.output.unwrap()["label"], "analysis");
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_plugin_workspace(
        temp.path().join("state/operations.sqlite"),
        temp.path().join("analysis"),
    )
    .await
    .unwrap();
    let retained = decode(
        &query(
            &reopened,
            &context,
            "plugins.test_project",
            json!({"id":test.id}),
        )
        .await,
    );
    assert_eq!(retained.project.state, p::PluginTestProjectState::Stopped);
    assert!(!retained.observed_in_this_host);
    assert_eq!(
        query(
            &reopened,
            &context,
            "plugins.test_operation",
            json!({"id":test.id,"operation_id":activation})
        )
        .await["record"]["status"],
        "succeeded"
    );
    assert_eq!(
        query(
            &reopened,
            &context,
            "plugins.instances",
            json!({"limit":100})
        )
        .await["instances"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["observed_in_this_host"] == true)
            .count(),
        0
    );
    reopened.drain().await;
}

#[tokio::test]
async fn activation_receipt_survives_catalog_write_failure_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture::package(&temp.path().join("source"), "1", false);
    let (host, context) = setup(temp.path(), &package).await;
    let database = temp.path().join("state/operations.sqlite");
    let catalog =
        rusqlite::Connection::open(repository_path(&database).join("catalog-v1.sqlite3")).unwrap();
    catalog.execute_batch("CREATE TRIGGER fail_activation_metadata BEFORE UPDATE ON plugin_test_projects BEGIN SELECT RAISE(ABORT,'fixture lifecycle write failure'); END;").unwrap();
    let request = invoke(
        "create-lost-metadata",
        "plugins.test_create",
        selection(&package, json!({"label":"original test"})),
    );
    let created = host.invoke(&context, request.clone()).await.unwrap();
    assert_eq!(created.status, OperationStatus::Uncertain);
    let recovery = created.recovery.as_ref().unwrap();
    let id: p::TestProjectId = serde_json::from_value(recovery["test_project"].clone()).unwrap();
    let activation = recovery["activation_operations"]["subject"]
        .as_str()
        .unwrap();
    let retained = decode(&query(&host, &context, "plugins.test_project", json!({"id":id})).await);
    assert_eq!(retained.project.state, p::PluginTestProjectState::Preparing);
    assert_eq!(retained.project.version, 0);
    assert!(retained.project.activation_operations.is_empty());
    assert!(retained.observed_in_this_host);
    assert!(host.plugin_test_host(&context, &id).is_err());
    let original = query(
        &host,
        &context,
        "plugins.test_operation",
        json!({"id":id,"operation_id":activation}),
    )
    .await;
    assert_eq!(original["record"]["status"], "succeeded");
    assert_eq!(
        original["record"]["operation"]["causation_id"],
        created.operation.operation_id.as_str()
    );
    assert_eq!(
        host.invoke(&context, request)
            .await
            .unwrap()
            .operation
            .operation_id,
        created.operation.operation_id
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.test_projects",
            json!({"limit":100})
        )
        .await["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        PluginRepository::open(&repository_path(&database))
            .unwrap()
            .references(&package.revision.id)
            .unwrap()
            .iter()
            .any(|r| r.starts_with("test_project:"))
    );
    catalog
        .execute_batch("DROP TRIGGER fail_activation_metadata")
        .unwrap();
    let stopped = succeeded(
        &host,
        &context,
        invoke(
            "stop-original-test",
            "plugins.test_stop",
            json!({"id":id,"expected_version":0}),
        ),
    )
    .await;
    assert_eq!(
        decode(stopped.output.as_ref().unwrap()).project.state,
        p::PluginTestProjectState::Stopped
    );
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_plugin_workspace(&database, temp.path().join("analysis"))
        .await
        .unwrap();
    let parent = reopened
        .get_operation(&context, &created.operation.operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parent.status, OperationStatus::Uncertain);
    assert_eq!(
        parent.recovery.as_ref().unwrap()["activation_operations"]["subject"],
        activation
    );
    assert_eq!(
        query(
            &reopened,
            &context,
            "plugins.test_operation",
            json!({"id":id,"operation_id":activation})
        )
        .await["record"]["status"],
        "succeeded"
    );
    reopened.drain().await;
}

#[tokio::test]
async fn failures_retain_original_activation_and_do_not_invent_cleanup_on_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture::package(&temp.path().join("source"), "1", false);
    let (host, context) = setup(temp.path(), &package).await;
    let created = host
        .invoke(
            &context,
            invoke(
                "failed-create",
                "plugins.test_create",
                selection(&package, json!({"mode":"init_fail"})),
            ),
        )
        .await
        .unwrap();
    assert_eq!(created.status, OperationStatus::Failed);
    let failed = decode(created.output.as_ref().unwrap());
    assert_eq!(failed.project.state, p::PluginTestProjectState::Failed);
    assert!(failed.observed_in_this_host);
    assert_eq!(failed.project.activation_operations.len(), 1);
    let test = &failed.project;
    let activation = test.activation_operations.values().next().unwrap();
    let original = query(
        &host,
        &context,
        "plugins.test_operation",
        json!({"id":test.id,"operation_id":activation}),
    )
    .await;
    assert_ne!(original["record"]["status"], "succeeded");
    let stopping = host
        .invoke(
            &context,
            invoke(
                "failed-stop",
                "plugins.test_stop",
                json!({"id":test.id,"expected_version":test.version}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(stopping.status, OperationStatus::Uncertain);
    let current = decode(
        &query(
            &host,
            &context,
            "plugins.test_project",
            json!({"id":test.id}),
        )
        .await,
    );
    assert_eq!(current.project.state, p::PluginTestProjectState::Failed);
    assert!(current.project.diagnostic.is_some());
    assert!(
        host.plugin_test_host(&context, &test.id).is_err(),
        "partial stop fences new work"
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.test_operation",
            json!({"id":test.id,"operation_id":activation})
        )
        .await["record"]["operation"]["operation_id"],
        activation.as_str()
    );
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_plugin_workspace(
        temp.path().join("state/operations.sqlite"),
        temp.path().join("analysis"),
    )
    .await
    .unwrap();
    let current = decode(
        &query(
            &reopened,
            &context,
            "plugins.test_project",
            json!({"id":test.id}),
        )
        .await,
    );
    assert_eq!(current.project.state, p::PluginTestProjectState::Failed);
    assert!(!current.observed_in_this_host);
    let refusal = reopened
        .invoke(
            &context,
            invoke(
                "historical-stop",
                "plugins.test_stop",
                json!({"id":test.id,"expected_version":current.project.version}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(refusal.status, OperationStatus::Failed);
    let mut foreign = context.clone();
    foreign.caller.id = "another-user".into();
    assert!(
        reopened
            .query_snapshot(
                &foreign,
                QueryRequest {
                    capability: CapabilityRef::new("plugins.test_operation", 1).unwrap(),
                    arguments: json!({"id":test.id,"operation_id":activation})
                }
            )
            .await
            .is_err()
    );
    assert_eq!(
        query(
            &reopened,
            &foreign,
            "plugins.test_projects",
            json!({"limit":100})
        )
        .await["projects"],
        json!([])
    );
    assert!(
        PluginRepository::open(&repository_path(
            &temp.path().join("state/operations.sqlite")
        ))
        .unwrap()
        .remove(&package.revision.id)
        .is_err()
    );
    reopened.drain().await;
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_grants_and_symlink_storage_never_borrow_existing_project_or_start_backend() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fixture::package(&source, "1", false);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(source.join("plugin.json")).unwrap()).unwrap();
    manifest["requires"]
        .as_array_mut()
        .unwrap()
        .push(json!({"capability":{"id":"operation.get","version":1},"scopes":["operation.read"]}));
    fs::write(
        source.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let package =
        rho_plugins::snapshot_directory(&source, None, &rho_plugins::backend_target()).unwrap();
    let (host, context) = setup(temp.path(), &package).await;
    let args = selection(&package, json!({}));
    let mut restricted = context.clone();
    restricted.scopes.remove("plugins.write");
    assert!(matches!(
        host.invoke(
            &restricted,
            invoke("no-write", "plugins.test_create", args.clone())
        )
        .await,
        Err(OperationError::AccessDenied { .. })
    ));
    let mut narrower = context.clone();
    narrower.scopes.remove("operation.read");
    assert!(matches!(
        host.invoke(
            &narrower,
            invoke("missing-plugin-grant", "plugins.test_create", args.clone())
        )
        .await,
        Err(OperationError::AccessDenied { .. })
    ));
    let mut forged = args.clone();
    forged["project_root"] = json!(temp.path().join("analysis"));
    assert!(
        host.invoke(
            &context,
            invoke("forged-path", "plugins.test_create", forged)
        )
        .await
        .is_err()
    );
    let mut invalid = args.clone();
    invalid["instances"]["subject"]["artifact"] = json!(format!("sha256:{}", "f".repeat(64)));
    assert!(
        host.invoke(
            &context,
            invoke("wrong-artifact", "plugins.test_create", invalid)
        )
        .await
        .is_err()
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.test_projects",
            json!({"limit":100})
        )
        .await["projects"],
        json!([])
    );
    let repository = repository_path(&temp.path().join("state/operations.sqlite"));
    symlink(
        temp.path().join("analysis"),
        repository.join("test-projects-v1"),
    )
    .unwrap();
    let result = host
        .invoke(
            &context,
            invoke("symlink-create", "plugins.test_create", args),
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed);
    let failed = decode(result.output.as_ref().unwrap());
    assert!(!failed.observed_in_this_host);
    assert!(failed.project.activation_operations.is_empty());
    assert!(
        !temp
            .path()
            .join("analysis")
            .join(failed.project.id.as_str())
            .exists()
    );
    let stopped = succeeded(
        &host,
        &context,
        invoke(
            "end-unstarted",
            "plugins.test_stop",
            json!({"id":failed.project.id,"expected_version":failed.project.version}),
        ),
    )
    .await;
    assert_eq!(
        decode(stopped.output.as_ref().unwrap()).project.state,
        p::PluginTestProjectState::Stopped
    );
    assert!(
        PluginRepository::open(&repository)
            .unwrap()
            .references(&package.revision.id)
            .unwrap()
            .is_empty()
    );
    host.drain().await;
}

#[tokio::test]
async fn concurrent_test_creation_cannot_exceed_native_project_quota() {
    let temp = tempfile::tempdir().unwrap();
    let package = fixture::package(&temp.path().join("source"), "1", false);
    let (host, context) = setup(temp.path(), &package).await;
    let mut tasks = vec![];
    for index in 0..5 {
        let host = host.clone();
        let context = context.clone();
        let arguments = selection(&package, json!({}));
        tasks.push(tokio::spawn(async move {
            host.invoke(
                &context,
                invoke(&format!("create-{index}"), "plugins.test_create", arguments),
            )
            .await
        }));
    }
    let mut successes = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(result) if result.status == OperationStatus::Succeeded => successes += 1,
            Ok(result) => assert_eq!(result.status, OperationStatus::Failed, "{result:?}"),
            Err(error) => assert!(
                matches!(error, OperationError::BudgetExceeded(_)),
                "{error:?}"
            ),
        }
    }
    assert_eq!(successes, 4);
    let page: p::PluginTestProjectPage = serde_json::from_value(
        query(
            &host,
            &context,
            "plugins.test_projects",
            json!({"limit":100}),
        )
        .await,
    )
    .unwrap();
    assert_eq!(
        page.projects
            .iter()
            .filter(|p| p.observed_in_this_host)
            .count(),
        4
    );
    for observation in page.projects {
        let test = observation.project;
        let result = succeeded(
            &host,
            &context,
            invoke(
                &format!("stop-{}", test.id),
                "plugins.test_stop",
                json!({"id":test.id,"expected_version":test.version}),
            ),
        )
        .await;
        assert_eq!(
            decode(result.output.as_ref().unwrap()).project.state,
            p::PluginTestProjectState::Stopped
        );
    }
    host.drain().await;
}
