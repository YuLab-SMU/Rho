//! Disposable real-R acceptance. Never attaches to or restarts a user's Host.
use rho_contract::*;
use rho_host::{ArkConfig, NextHost};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

fn setting(name: &str) -> PathBuf {
    std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} is required for this explicit real-R test"))
}
fn config(root: &Path) -> ArkConfig {
    ArkConfig {
        executable: setting("RHO_ARK"),
        r_home: setting("RHO_R_HOME"),
        project_root: root.into(),
        data_root: root.join("runtime"),
        execution_timeout: Duration::from_secs(30),
        library_path: None,
        checkpoint_helper_path: Some(setting("RHO_CHECKPOINT_HELPER")),
    }
}
async fn invoke(host: &NextHost, id: &str, capability: &str, arguments: Value) -> OperationRecord {
    host.invoke(
        &NextHost::local_context(),
        Invocation {
            client_request_id: id.into(),
            capability: CapabilityRef::new(capability, 1).unwrap(),
            arguments,
            preconditions: vec![],
        },
    )
    .await
    .unwrap()
}
async fn succeeded(
    host: &NextHost,
    id: &str,
    capability: &str,
    arguments: Value,
) -> OperationRecord {
    let result = invoke(host, id, capability, arguments).await;
    assert_eq!(
        result.status,
        OperationStatus::Succeeded,
        "{id}: {result:?}"
    );
    result
}
async fn instance(host: &NextHost, id: &str) -> WorkspaceInstance {
    let result = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("runtime.instance", 1).unwrap(),
                arguments: json!({"workspace_instance_id":id}),
            },
        )
        .await
        .unwrap();
    serde_json::from_value(result.data.unwrap()).unwrap()
}
async fn run(host: &NextHost, id: &str, target: &str, code: &str) {
    let native = instance(host, target).await.native_session_id.unwrap();
    let result = host
        .invoke(
            &NextHost::local_context(),
            Invocation {
                client_request_id: id.into(),
                capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
                arguments: json!({"workspace_instance_id":target,"code":code}),
                preconditions: vec![Precondition {
                    kind: "workspace.session".into(),
                    subject: "active".into(),
                    expected: json!(native),
                }],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result.status,
        OperationStatus::Succeeded,
        "{id}: {result:?}"
    );
}
async fn stop(host: &NextHost, id: &str, target: &str, discard: bool) -> WorkspaceInstance {
    let native = instance(host, target).await.native_session_id.unwrap();
    let result = succeeded(host, id, "runtime.stop_instance", json!({"workspace_instance_id":target,"expected_native_session_id":native,"discard_unsaved_objects":discard})).await;
    serde_json::from_value(result.output.unwrap()).unwrap()
}
fn process_record(root: &Path, id: &str) -> RuntimeProcessIdentity {
    let store = rho_host::ApplicationStore::open(&root.join("records.studio.sqlite")).unwrap();
    let scope = format!("project:{}", root.canonicalize().unwrap().to_string_lossy());
    serde_json::from_value(store.runtime_instance(&scope, id).unwrap().value["process"].clone())
        .unwrap()
}

#[tokio::test]
#[ignore = "requires RHO_ARK, RHO_R_HOME and a prepared matching RHO_CHECKPOINT_HELPER"]
async fn real_instances_restore_and_clean_restart_without_cross_session_effects() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let database = root.join("records.sqlite");
    let host = Arc::new(NextHost::open_ark(&database, config(&root)).await.unwrap());
    let original = instance(&host, "main").await;
    assert_eq!(original.state, RuntimeInstanceState::Ready, "{original:?}");
    assert!(original.protection.capture_available);
    let created = succeeded(
        &host,
        "scratch",
        "runtime.create_instance",
        json!({"name":"Scratch","binding":original.binding,"start":true}),
    )
    .await;
    let scratch: WorkspaceInstance = serde_json::from_value(created.output.unwrap()).unwrap();
    assert_ne!(scratch.native_session_id, original.native_session_id);

    run(
        &host,
        "seed-main",
        "main",
        "keep <- c(2L, 4L, 6L); frame <- data.frame(id=1:3, label=c('甲','乙','丙'))",
    )
    .await;
    run(
        &host,
        "seed-scratch",
        &scratch.workspace_instance_id,
        "keep <- 99L",
    )
    .await;
    let slow_host = host.clone();
    let slow = tokio::spawn(async move {
        run(
            &slow_host,
            "slow-main",
            "main",
            "Sys.sleep(1.5); finished <- TRUE",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = host
                .query_snapshot(
                    &NextHost::local_context(),
                    QueryRequest {
                        capability: CapabilityRef::new("workspace.console_state", 1).unwrap(),
                        arguments: json!({"workspace_instance_id":"main"}),
                    },
                )
                .await
                .unwrap();
            if state
                .data
                .as_ref()
                .is_some_and(|data| !data["current"].is_null())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Main must hold its execution lane before testing Scratch");
    tokio::time::timeout(
        Duration::from_secs(1),
        run(
            &host,
            "fast-scratch",
            &scratch.workspace_instance_id,
            "stopifnot(identical(keep, 99L))",
        ),
    )
    .await
    .expect("Scratch must not wait for Main's native execution lane");
    slow.await.unwrap();

    let checkpoint = succeeded(&host, "save-main", "workspace.checkpoint_capture", json!({"workspace_instance_id":"main","expected_session":original.native_session_id,"automatic":false,"max_bytes":67108864,"max_seconds":10})).await;
    let manifest: CheckpointManifest = serde_json::from_value(checkpoint.output.unwrap()).unwrap();
    assert_eq!(manifest.workspace_instance_id, "main");
    assert_eq!(
        manifest.report.coverage,
        CheckpointCoverage::CompleteEligibleGraph
    );
    assert!(
        manifest
            .report
            .saved_names
            .iter()
            .any(|name| name == "frame")
    );
    assert_eq!(manifest.runtime_binding, Some(original.binding.clone()));

    let stopped = stop(&host, "stop-main", "main", false).await;
    assert_eq!(stopped.state, RuntimeInstanceState::Stopped);
    assert!(stopped.native_session_id.is_none());
    assert_eq!(
        instance(&host, &scratch.workspace_instance_id)
            .await
            .native_session_id,
        scratch.native_session_id
    );
    let archive = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("workspace.checkpoints", 1).unwrap(),
                arguments: json!({"workspace_instance_id":"main","limit":20}),
            },
        )
        .await
        .unwrap();
    let archive: CheckpointList = serde_json::from_value(archive.data.unwrap()).unwrap();
    assert!(!archive.native_capture_available);
    assert!(
        archive
            .entries
            .iter()
            .any(|entry| entry.manifest.checkpoint_id == manifest.checkpoint_id && entry.available)
    );
    succeeded(&host, "continue-main", "runtime.continue_instance", json!({"workspace_instance_id":"main","expected_continuation_lineage_id":stopped.continuation_lineage_id})).await;
    let resumed = instance(&host, "main").await;
    assert_ne!(resumed.native_session_id, original.native_session_id);
    assert_eq!(resumed.binding, original.binding);
    run(&host, "verify-restored", "main", "stopifnot(identical(keep,c(2L,4L,6L)), identical(frame$label,c('甲','乙','丙')), isTRUE(finished))").await;
    run(
        &host,
        "verify-scratch",
        &scratch.workspace_instance_id,
        "stopifnot(identical(keep,99L), !exists('frame',inherits=FALSE))",
    )
    .await;

    succeeded(&host, "clean-main", "runtime.restart_instance", json!({"workspace_instance_id":"main","expected_native_session_id":resumed.native_session_id,"clean":true,"discard_unsaved_objects":false})).await;
    let clean = instance(&host, "main").await;
    assert_ne!(
        clean.continuation_lineage_id,
        resumed.continuation_lineage_id
    );
    let snapshot = host.query_snapshot(&NextHost::local_context(), QueryRequest { capability: CapabilityRef::new("workspace.snapshot", 1).unwrap(), arguments: json!({"workspace_instance_id":"main","expected_session":clean.native_session_id,"limit":20}) }).await.unwrap();
    assert_eq!(snapshot.data.unwrap()["total_bindings"], 0);
    let process = process_record(&root, "main");
    host.drain().await;
    drop(host);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if rho_r_runtime::recorded_process_alive(&process)
                .await
                .unwrap()
                == Some(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("The disposable Host's owned R process must terminate before reopening");

    let reopened = NextHost::open_ark(&database, config(&root)).await.unwrap();
    let continued = instance(&reopened, "main").await;
    assert_eq!(
        continued.state,
        RuntimeInstanceState::Ready,
        "{continued:?}"
    );
    assert_eq!(
        continued.continuation_lineage_id,
        clean.continuation_lineage_id
    );
    run(
        &reopened,
        "clean-remains-empty",
        "main",
        "stopifnot(!exists('keep',inherits=FALSE), !exists('frame',inherits=FALSE))",
    )
    .await;
    assert_eq!(
        instance(&reopened, &scratch.workspace_instance_id)
            .await
            .state,
        RuntimeInstanceState::Stopped
    );
    stop(&reopened, "finish", "main", true).await;
    reopened.drain().await;
}

#[tokio::test]
#[ignore = "requires matching helpers for two genuinely different R installations: RHO_* and RHO_ALT_* variables"]
async fn real_instances_can_bind_two_distinct_r_versions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let host = NextHost::open_ark(root.join("records.sqlite"), config(root))
        .await
        .unwrap();
    let main = instance(&host, "main").await;
    let alternative = setting("RHO_ALT_R_HOME");
    let binding = RuntimeLaunchBinding {
        r_executable: alternative
            .join("bin")
            .join(if cfg!(windows) { "R.exe" } else { "R" })
            .to_string_lossy()
            .into_owned(),
        ark_executable: setting("RHO_ALT_ARK").to_string_lossy().into_owned(),
        environment_realization_id: None,
        library_path: None,
        checkpoint_helper_path: Some(
            setting("RHO_ALT_CHECKPOINT_HELPER")
                .to_string_lossy()
                .into_owned(),
        ),
    };
    let record = succeeded(
        &host,
        "second-version",
        "runtime.create_instance",
        json!({"name":"Other R","binding":binding,"start":true}),
    )
    .await;
    let other: WorkspaceInstance = serde_json::from_value(record.output.unwrap()).unwrap();
    assert_ne!(
        main.installation.as_ref().unwrap().r_version,
        other.installation.as_ref().unwrap().r_version,
        "This test requires genuinely different R versions"
    );
    run(&host, "version-main", "main", "only_main <- TRUE").await;
    run(
        &host,
        "version-other",
        &other.workspace_instance_id,
        "stopifnot(!exists('only_main',inherits=FALSE)); only_other <- TRUE",
    )
    .await;
    stop(&host, "stop-other", &other.workspace_instance_id, false).await;
    run(
        &host,
        "main-survives",
        "main",
        "stopifnot(isTRUE(only_main), !exists('only_other',inherits=FALSE))",
    )
    .await;
    stop(&host, "stop-main", "main", false).await;
    host.drain().await;
}
