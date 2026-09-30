use rho_contract::{
    CapabilityKind, CapabilityRef, Operation, OperationId, OperationStatus, QueryRequest,
    QueryStatus, TargetRef,
};
use rho_host::NextHost;
use rho_operation::OperationJournal;
use rho_sqlite::SqliteOperationJournal;
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::Path};

async fn query(observer: &rho_host::QueryObserver, id: &str, args: Value) -> Value {
    let result = observer
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new(id, 1).unwrap(),
                arguments: args,
            },
        )
        .await
        .unwrap();
    assert_eq!(result.status, QueryStatus::Ready);
    result.data.unwrap()
}
fn record(root: &Path, id: &str) -> Operation {
    Operation { admission: None,
        operation_id: OperationId::new(id).unwrap(),
        client_request_id: id.into(),
        caller: NextHost::local_context().caller,
        principal: None,
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        domain: "workspace".into(),
        target: TargetRef {
            kind: "workspace".into(),
            identity: "original-native-session".into(),
        },
        normalized_arguments: json!({"code":"original caller action"}),
        invocation_digest: "sha256:fixture".into(),
        idempotency_scope: Some(root.canonicalize().unwrap().to_string_lossy().into()),
        preconditions: vec![],
        potential_effects: BTreeSet::new(),
        correlation_id: id.into(),
        causation_id: None,
        trace_parent: None,
        accepted_at_ms: 1,
    }
}

#[tokio::test]
async fn fresh_project_observation_creates_no_journal_store_or_project_lease() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("analysis.R"), "evidence <- 42\n").unwrap();
    let database = dir.path().join("absent/state.sqlite");
    let observer = NextHost::open_query_observer(&database, Some(&root)).unwrap();
    assert!(
        observer
            .capabilities()
            .iter()
            .all(|d| d.kind == CapabilityKind::Query)
    );
    assert!(observer.capabilities().iter().all(|d| d.capability.id.starts_with("host.")));
    for id in ["project.read_text", "output.read_text", "workspace.snapshot", "plugins.list"] {
        assert!(observer.query_snapshot(&NextHost::local_context(), QueryRequest {
            capability: CapabilityRef::new(id, 1).unwrap(), arguments: json!({})
        }).await.is_err(), "{id}");
    }
    let overview = query(&observer, "host.overview", json!({})).await;
    assert_eq!(overview["modules"].as_array().unwrap().len(), 1);
    assert_eq!(overview["modules"][0]["module"], "host");
    assert_eq!(overview["modules"][0]["available"], true);
    assert!(!database.exists());
    assert!(!database.parent().unwrap().exists());
    assert!(!root.join(".rho").exists());
    assert!(
        observer
            .query_snapshot(
                &NextHost::local_context(),
                QueryRequest {
                    capability: CapabilityRef::new("workspace.list_objects", 1).unwrap(),
                    arguments: json!({"expected_session":"not-connected"})
                }
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn observer_coexists_with_active_project_owner_without_taking_its_lease() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("analysis.R"), "native work remains owned\n").unwrap();
    let database = dir.path().join("state/next.sqlite");
    let host = NextHost::open_plugin_workspace(&database, &root).await.unwrap();
    let before = fs::read(&database).unwrap();
    let lock_before = fs::read(root.join(".rho/next-host.lock")).unwrap();
    let observer = NextHost::open_query_observer(&database, Some(&root)).unwrap();
    assert!(
        query(&observer, "operation.list_recent", json!({"limit":10})).await["operations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read(&database).unwrap(), before);
    assert_eq!(
        fs::read(root.join(".rho/next-host.lock")).unwrap(),
        lock_before
    );
    assert!(
        NextHost::open_plugin_workspace(dir.path().join("different.sqlite"), &root)
            .await
            .is_err()
    );
    drop(observer);
    let still_live = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("plugins.list", 1).unwrap(),
                arguments: json!({"limit":10}),
            },
        )
        .await
        .unwrap();
    assert_eq!(still_live.status, QueryStatus::Ready);
}

#[tokio::test]
async fn orphan_accepted_and_running_records_are_observed_without_recovery_or_database_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    fs::create_dir(&root).unwrap();
    let database = dir.path().join("state/next.sqlite");
    let journal = SqliteOperationJournal::open(&database).unwrap();
    let accepted = record(&root, "accepted-original");
    let running = record(&root, "running-original");
    journal.admit(&accepted).await.unwrap();
    journal.admit(&running).await.unwrap();
    journal
        .mark_running(&running.operation_id, 2)
        .await
        .unwrap();
    journal.stage_commit(&running.operation_id, &rho_operation::CommitPlan::succeeded(json!({"answer":42})), 3).await.unwrap();
    drop(journal);
    let before = fs::read(&database).unwrap();
    let observer = NextHost::open_query_observer(&database, Some(&root)).unwrap();
    assert!(!observer.capabilities().iter().any(|d| d.capability.id == "operation.reconcile_commit"));
    for (original, status) in [
        (&accepted, OperationStatus::Accepted),
        (&running, OperationStatus::Running),
    ] {
        let result: rho_contract::OperationGetResult = serde_json::from_value(
            query(
                &observer,
                "operation.get",
                json!({"operation_id":original.operation_id}),
            )
            .await,
        )
        .unwrap();
        let observed = result
            .record
            .expect("The exact principal/project operation must remain visible");
        assert_eq!(observed.operation.operation_id, original.operation_id);
        assert_eq!(
            observed.operation.idempotency_scope,
            original.idempotency_scope
        );
        assert_eq!(observed.operation.principal(), original.principal());
        assert_eq!(observed.status, status);
        let commit = query(&observer, "operation.commit_status", json!({"operation_id":original.operation_id})).await;
        assert_eq!(commit["phase"], if status == OperationStatus::Running { "durable" } else { "awaiting_result" });
    }
    query(&observer, "host.overview", json!({})).await;
    drop(observer);
    assert_eq!(fs::read(&database).unwrap(), before);
    let reader = SqliteOperationJournal::open_read_only(&database).unwrap();
    assert_eq!(
        reader
            .get(&accepted.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Accepted
    );
    assert_eq!(
        reader
            .get(&running.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Running
    );
    assert!(!root.join(".rho").exists());
}

#[tokio::test]
async fn retired_scientific_store_paths_are_never_opened_or_advertised() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    fs::create_dir(&root).unwrap();
    let database = dir.path().join("state/next.sqlite");
    let journal = SqliteOperationJournal::open(&database).unwrap();
    let operation = record(&root, "original");
    journal.admit(&operation).await.unwrap();
    drop(journal);
    // Deliberately invalid native store paths: journal observation must not inspect them.
    for name in ["runtime", "environment"] {
        fs::write(database.parent().unwrap().join(name), "untouched scientific material").unwrap();
    }
    let before = fs::read(&database).unwrap();
    let observer = NextHost::open_query_observer(&database, Some(&root)).unwrap();
    assert!(observer.capabilities().iter().all(|d|
        d.capability.id.starts_with("host.") || d.capability.id.starts_with("operation.")));
    assert_eq!(query(&observer, "operation.get", json!({"operation_id":operation.operation_id})).await["record"]["operation"]["operation_id"], "original");
    assert_eq!(fs::read(&database).unwrap(), before);
    for name in ["runtime", "environment"] {
        assert_eq!(fs::read_to_string(database.parent().unwrap().join(name)).unwrap(), "untouched scientific material");
    }
}

#[tokio::test]
async fn observer_preserves_project_and_principal_visibility_without_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    let other = dir.path().join("other");
    fs::create_dir(&root).unwrap(); fs::create_dir(&other).unwrap();
    let database = dir.path().join("state/next.sqlite");
    let journal = SqliteOperationJournal::open(&database).unwrap();
    let operation = record(&root, "private-original");
    journal.admit(&operation).await.unwrap(); drop(journal);
    let before = fs::read(&database).unwrap();
    let observer = NextHost::open_query_observer(&database, Some(&root)).unwrap();
    let other_project = NextHost::open_query_observer(&database, Some(&other)).unwrap();
    let request = QueryRequest { capability: CapabilityRef::new("operation.get", 1).unwrap(),
        arguments: json!({"operation_id":operation.operation_id}) };
    let mut denied = NextHost::local_context(); denied.caller.id = "another-user".into();
    for (source, context) in [(&observer, denied), (&other_project, NextHost::local_context())] {
        let result = source.query_snapshot(&context, request.clone()).await.unwrap();
        assert!(result.data.unwrap()["record"].is_null());
    }
    assert_eq!(fs::read(&database).unwrap(), before);
    assert!(!root.join(".rho").exists()); assert!(!other.join(".rho").exists());
}
