use rho_contract::{CapabilityRef, Invocation, OperationStatus, QueryRequest, QueryStatus};
use rho_host::{ArkConfig, NextHost, REnvironmentConfig};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn invocation(id: &str, capability: &str, mut args: Value) -> Invocation {
    if capability.starts_with("workspace.") {
        args["workspace_instance_id"] = json!("main");
    }
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments: args,
        preconditions: Vec::new(),
    }
}
async fn invoke(
    host: &NextHost,
    id: &str,
    capability: &str,
    args: Value,
) -> rho_contract::OperationRecord {
    host.invoke(&NextHost::local_context(), invocation(id, capability, args))
        .await
        .unwrap()
}
async fn observe(host: &NextHost, args: Value) -> Value {
    let reply = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new("environment.observe", 1).unwrap(),
                arguments: args,
            },
        )
        .await
        .unwrap();
    assert_eq!(reply.status, QueryStatus::Ready, "{reply:?}");
    reply.data.unwrap()
}
async fn material_view(host: &NextHost, capability: &str, args: Value) -> Value {
    let result = host
        .query_snapshot(
            &NextHost::local_context(),
            QueryRequest {
                capability: CapabilityRef::new(capability, 1).unwrap(),
                arguments: args,
            },
        )
        .await
        .unwrap();
    assert_eq!(result.status, QueryStatus::Ready, "{result:?}");
    result.data.unwrap()
}
fn copy_fixture(project: &Path) {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rhonextfixture");
    std::fs::create_dir_all(project.join("pkg/R")).unwrap();
    for file in ["DESCRIPTION", "NAMESPACE", "R/answer.R"] {
        std::fs::copy(source.join(file), project.join("pkg").join(file)).unwrap();
    }
}
fn ark_config(project: &Path, data: &Path, r_home: &Path) -> ArkConfig {
    ArkConfig {
        executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK required")),
        r_home: r_home.into(),
        project_root: project.into(),
        data_root: data.join("runtime"),
        execution_timeout: Duration::from_secs(30),
        library_path: None,
        checkpoint_helper_path: None,
    }
}

#[tokio::test]
#[ignore = "requires real R, pak, renv, ps, jsonlite and Ark; cancels an actual package installation"]
async fn real_environment_cancellation_stops_installer_and_retains_staging() {
    use std::sync::Arc;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, BufReader},
        net::TcpListener,
    };
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    copy_fixture(&project);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    // R CMD INSTALL tests loading this namespace in a descendant R process.
    // Signal readiness from that actual child, then block until it is killed.
    std::fs::write(
        project.join("pkg/R/load.R"),
        format!(
            r#"
.onLoad <- function(libname, pkgname) {{
  con <- socketConnection(host = "127.0.0.1", port = {}, open = "w", blocking = TRUE)
  writeLines(Sys.getenv("RHO_OPERATION_ID"), con)
  flush(con)
  Sys.sleep(60)
  close(con)
}}
"#,
            listener.local_addr().unwrap().port()
        ),
    )
    .unwrap();
    let r_home = PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME required"));
    let host = Arc::new(
        NextHost::open_environment(
            directory.path().join("state/next.sqlite"),
            REnvironmentConfig {
                rscript: r_home.join("bin").join(if cfg!(windows) {
                    "Rscript.exe"
                } else {
                    "Rscript"
                }),
                project_root: project.clone(),
                data_root: directory.path().join("state/environment"),
                timeout: Duration::from_secs(90),
            },
        )
        .await
        .unwrap(),
    );
    let plan = invoke(
        &host,
        "plan",
        "environment.plan",
        json!({"manager":"pak","packages":["local::pkg"]}),
    )
    .await;
    assert_eq!(plan.status, OperationStatus::Succeeded, "{plan:?}");
    let args = json!({"plan_operation_id":plan.operation.operation_id});
    let owner = host.clone();
    let input = args.clone();
    let task = tokio::spawn(async move {
        invoke(&owner, "cancel-install", "environment.realize", input).await
    });
    let (socket, _) = tokio::time::timeout(Duration::from_secs(45), listener.accept())
        .await
        .expect("installer did not signal readiness")
        .unwrap();
    let mut socket = BufReader::new(socket);
    let mut id = String::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut id))
        .await
        .unwrap()
        .unwrap();
    let id = rho_contract::OperationId::new(id.trim()).unwrap();
    let requested = host
        .request_cancellation(&NextHost::local_context(), &id)
        .await
        .unwrap();
    assert!(requested.accepted);
    let result = tokio::time::timeout(Duration::from_secs(15), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status, OperationStatus::Cancelled, "{result:?}");
    assert!(
        result.output.is_none(),
        "a cancelled install cannot be activated"
    );
    let recovery = result.recovery.as_ref().unwrap();
    assert!(Path::new(recovery["stage"].as_str().unwrap()).is_dir());
    assert_eq!(recovery["runtime"]["process"]["termination"], "cancelled");
    assert_eq!(
        invoke(&host, "cancel-install", "environment.realize", args).await,
        result
    );
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut rest))
        .await
        .expect("installer child survived cancellation")
        .unwrap();
    assert!(rest.is_empty());
    let data = directory.path().join("state");
    let database = data.join("next.sqlite");
    let stage = PathBuf::from(recovery["stage"].as_str().unwrap());
    let library = stage.join("library");
    drop(host);
    let host = NextHost::open_ark(&database, ark_config(&project, &data, &r_home))
        .await
        .unwrap();
    let library_text = serde_json::to_string(&library.to_string_lossy()).unwrap();
    let selected = invoke(
        &host,
        "use-partial-library",
        "workspace.run_r",
        json!({"code":format!(".libPaths(c({library_text}, .libPaths())); TRUE")}),
    )
    .await;
    assert_eq!(selected.status, OperationStatus::Succeeded);
    let protected = material_view(&host, "environment.retention", json!({"operation_id":id})).await;
    assert_eq!(
        protected["can_quarantine"], false,
        "live library was not protected: {protected}"
    );
    assert!(
        protected["retained_reasons"]
            .to_string()
            .contains("references"),
        "{protected}"
    );
    let reset = invoke(
        &host,
        "reset-library",
        "workspace.run_r",
        json!({"code":format!(".libPaths(setdiff(.libPaths(), {library_text})); TRUE")}),
    )
    .await;
    assert_eq!(reset.status, OperationStatus::Succeeded);
    let history = host
        .outbox(&NextHost::local_context(), 0, 1000)
        .await
        .unwrap();
    let preview = material_view(&host, "environment.retention", json!({"operation_id":id})).await;
    assert_eq!(preview["can_quarantine"], true, "{preview}");
    assert_eq!(
        host.outbox(&NextHost::local_context(), 0, 1000)
            .await
            .unwrap(),
        history
    );
    let stale_fingerprint = preview["material"]["stage"]["fingerprint"].clone();
    std::fs::write(
        stage.join("changed-after-preview"),
        b"retained until explicit cleanup",
    )
    .unwrap();
    let stale = invoke(
        &host,
        "stale-cleanup",
        "environment.cleanup",
        json!({"operation_id":id,"expected_fingerprint":stale_fingerprint}),
    )
    .await;
    assert_eq!(stale.status, OperationStatus::Failed);
    assert!(stage.exists());
    let outside = directory.path().join("outside.txt");
    std::fs::write(&outside, b"must survive collection").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, stage.join("outside-link")).unwrap();
    let preview = material_view(&host, "environment.retention", json!({"operation_id":id})).await;
    let cleaned = invoke(&host, "quarantine", "environment.cleanup", json!({"operation_id":id,"expected_fingerprint":preview["material"]["stage"]["fingerprint"]})).await;
    assert_eq!(cleaned.status, OperationStatus::Succeeded, "{cleaned:?}");
    assert!(!stage.exists());
    let cleanup_id = cleaned.operation.operation_id;
    let trashed = material_view(
        &host,
        "environment.cleanup_status",
        json!({"cleanup_operation_id":cleanup_id}),
    )
    .await;
    assert_eq!(trashed["can_restore"], true, "{trashed}");
    let restored = invoke(&host, "restore", "environment.restore_cleanup", json!({"cleanup_operation_id":cleanup_id,"expected_fingerprint":trashed["material"]["trash"]["fingerprint"]})).await;
    assert_eq!(restored.status, OperationStatus::Succeeded, "{restored:?}");
    assert!(stage.exists());
    let preview = material_view(&host, "environment.retention", json!({"operation_id":id})).await;
    // Lose the commit after a real directory rename; recovery must use the
    // existing Operation identity and filesystem, not replay the mutation.
    let fault = rusqlite::Connection::open(&database).unwrap();
    fault
        .execute_batch(
            "CREATE TRIGGER fail_material_commit BEFORE UPDATE ON operations
        WHEN NEW.capability_id = 'environment.cleanup' AND NEW.status = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'injected material commit failure'); END;",
        )
        .unwrap();
    let failed = host.invoke(&NextHost::local_context(), invocation("lost-cleanup-commit", "environment.cleanup",
        json!({"operation_id":id,"expected_fingerprint":preview["material"]["stage"]["fingerprint"]}))).await.unwrap_err();
    let lost_id = match failed {
        rho_operation::OperationError::CommitPending { operation_id, .. } => operation_id,
        other => panic!("{other:?}"),
    };
    assert!(!stage.exists());
    fault
        .execute_batch("DROP TRIGGER fail_material_commit;")
        .unwrap();
    drop(fault);
    drop(host);
    let host = NextHost::open_environment(
        &database,
        REnvironmentConfig {
            rscript: r_home.join("bin").join(if cfg!(windows) {
                "Rscript.exe"
            } else {
                "Rscript"
            }),
            project_root: project,
            data_root: data.join("environment"),
            timeout: Duration::from_secs(90),
        },
    )
    .await
    .unwrap();
    let uncertain_cleanup = host
        .get_operation(&NextHost::local_context(), &lost_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(uncertain_cleanup.status, OperationStatus::Uncertain);
    let state = material_view(
        &host,
        "environment.cleanup_status",
        json!({"cleanup_operation_id":lost_id}),
    )
    .await;
    assert_eq!(state["can_purge"], true, "{state}");
    let request = json!({"cleanup_operation_id":lost_id,"expected_fingerprint":state["material"]["trash"]["fingerprint"]});
    let purged = invoke(&host, "purge", "environment.purge_cleanup", request.clone()).await;
    assert_eq!(purged.status, OperationStatus::Succeeded, "{purged:?}");
    assert_eq!(purged.output.as_ref().unwrap()["recoverable"], false);
    assert_eq!(
        invoke(&host, "purge", "environment.purge_cleanup", request).await,
        purged
    );
    assert_eq!(std::fs::read(&outside).unwrap(), b"must survive collection");
    assert_eq!(
        host.get_operation(&NextHost::local_context(), &lost_id)
            .await
            .unwrap()
            .unwrap(),
        uncertain_cleanup
    );
    assert_eq!(
        host.get_operation(&NextHost::local_context(), &id)
            .await
            .unwrap()
            .unwrap(),
        result
    );
    assert_eq!(
        material_view(
            &host,
            "environment.cleanup_status",
            json!({"cleanup_operation_id":lost_id})
        )
        .await["material"]["native_marker_present"],
        true
    );
}

#[tokio::test]
#[ignore = "requires real R, pak, renv, ps, jsonlite and Ark; installs only into temporary libraries"]
async fn real_environment_plan_realize_verify_restore_and_restart_binding() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    copy_fixture(&project);
    let data = directory.path().join("state");
    let database = data.join("next.sqlite");
    let r_home = PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME required"));
    let rscript = r_home.join("bin").join(if cfg!(windows) {
        "Rscript.exe"
    } else {
        "Rscript"
    });
    let host = NextHost::open_environment(
        &database,
        REnvironmentConfig {
            rscript,
            project_root: project.clone(),
            data_root: data.join("environment"),
            timeout: Duration::from_secs(90),
        },
    )
    .await
    .unwrap();
    let native_before = observe(&host, json!({"limit":500})).await;
    let plan = invoke(
        &host,
        "plan",
        "environment.plan",
        json!({"manager":"pak","packages":["local::pkg"]}),
    )
    .await;
    assert_eq!(plan.status, OperationStatus::Succeeded, "{plan:?}");
    assert_eq!(
        plan.output.as_ref().unwrap()["packages"][0]["name"],
        "rhonextfixture"
    );
    let plan_id = plan.operation.operation_id.as_str();
    let request = json!({"plan_operation_id":plan_id});
    let realized = invoke(&host, "realize", "environment.realize", request.clone()).await;
    assert_eq!(realized.status, OperationStatus::Succeeded, "{realized:?}");
    let receipt = realized.output.as_ref().unwrap();
    let keep_success = material_view(
        &host,
        "environment.retention",
        json!({"operation_id":realized.operation.operation_id}),
    )
    .await;
    assert_eq!(keep_success["can_quarantine"], false);
    assert_eq!(receipt["verified"], true);
    assert_eq!(receipt["restart_required"], false);
    assert_eq!(receipt["activation"], "available_not_active");
    let realization_id = realized.operation.operation_id.as_str().to_string();
    let library = PathBuf::from(receipt["library_path"].as_str().unwrap());
    assert!(library.starts_with(data.join("environment").canonicalize().unwrap()));
    assert_eq!(
        invoke(&host, "realize", "environment.realize", request).await,
        realized
    );
    let verification = invoke(
        &host,
        "verify",
        "environment.verify",
        json!({"realization_operation_id":realization_id}),
    )
    .await;
    assert_eq!(
        verification.status,
        OperationStatus::Succeeded,
        "{verification:?}"
    );
    let observed = observe(&host, json!({"realization_operation_id":realization_id})).await;
    assert_eq!(observed["packages"][0]["name"], "rhonextfixture");
    let native_after = observe(&host, json!({"limit":500})).await;
    assert_eq!(
        native_before["packages"], native_after["packages"],
        "user library inventory changed"
    );
    assert_eq!(
        native_before["library_paths"],
        native_after["library_paths"]
    );

    let lockfile = PathBuf::from(receipt["renv_lockfile"].as_str().unwrap());
    std::fs::copy(lockfile, project.join("renv.lock")).unwrap();
    let original_lock = std::fs::read(project.join("renv.lock")).unwrap();
    let renv_plan = invoke(
        &host,
        "renv-plan",
        "environment.plan",
        json!({"manager":"renv","lockfile":"renv.lock"}),
    )
    .await;
    assert_eq!(
        renv_plan.status,
        OperationStatus::Succeeded,
        "{renv_plan:?}"
    );
    let restored = invoke(
        &host,
        "renv-realize",
        "environment.realize",
        json!({"plan_operation_id":renv_plan.operation.operation_id}),
    )
    .await;
    assert_eq!(restored.status, OperationStatus::Succeeded, "{restored:?}");
    assert_eq!(
        std::fs::read(project.join("renv.lock")).unwrap(),
        original_lock,
        "restore changed authoritative lockfile"
    );

    std::fs::write(
        project.join("pkg/R/answer.R"),
        "fixture_answer <- function() 43L\n",
    )
    .unwrap();
    let stale = invoke(
        &host,
        "changed-source",
        "environment.realize",
        json!({"plan_operation_id":plan_id}),
    )
    .await;
    assert_eq!(stale.status, OperationStatus::Failed, "{stale:?}");
    assert!(stale.error.unwrap().contains("source changed"));
    std::fs::write(
        project.join("pkg/R/answer.R"),
        "fixture_answer <- function() 42L\n",
    )
    .unwrap();
    let owned_lock = PathBuf::from(plan.output.as_ref().unwrap()["lock_path"].as_str().unwrap());
    std::fs::write(&owned_lock, b"{}").unwrap();
    let changed_lock = invoke(
        &host,
        "changed-lock",
        "environment.realize",
        json!({"plan_operation_id":plan_id}),
    )
    .await;
    assert_eq!(changed_lock.status, OperationStatus::Failed);
    assert!(changed_lock.error.unwrap().contains("lockfile changed"));
    drop(host);

    let bound = NextHost::open_ark_with_environment(
        &database,
        ark_config(&project, &data, &r_home),
        Some(&realization_id),
    )
    .await
    .unwrap();
    let answer = invoke(
        &bound,
        "use-environment",
        "workspace.run_r",
        json!({"code":"rhonextfixture::fixture_answer()"}),
    )
    .await;
    assert_eq!(answer.status, OperationStatus::Succeeded, "{answer:?}");
    assert_eq!(answer.output.as_ref().unwrap()["value"], 42);
    let active = observe(&bound, json!({})).await;
    assert_eq!(active["active_workspace_library"], receipt["library_path"]);
    let another = invoke(
        &bound,
        "while-bound",
        "environment.realize",
        json!({"plan_operation_id":renv_plan.operation.operation_id}),
    )
    .await;
    assert_eq!(another.status, OperationStatus::Succeeded, "{another:?}");
    assert_eq!(another.output.as_ref().unwrap()["restart_required"], true);
    assert_eq!(
        observe(&bound, json!({})).await["active_workspace_library"],
        receipt["library_path"]
    );
    let description = library.join("rhonextfixture/DESCRIPTION");
    let original = std::fs::read_to_string(&description).unwrap();
    std::fs::write(
        &description,
        original.replace("Version: 0.1.0", "Version: 9.9.9"),
    )
    .unwrap();
    let tampered = invoke(
        &bound,
        "verify-tampered",
        "environment.verify",
        json!({"realization_operation_id":realization_id}),
    )
    .await;
    assert_eq!(tampered.status, OperationStatus::Failed);
    assert_eq!(
        tampered.output.as_ref().unwrap()["library_digest_matches"],
        false
    );
    drop(bound);
    assert!(
        NextHost::open_ark_with_environment(
            &database,
            ark_config(&project, &data, &r_home),
            Some(&realization_id)
        )
        .await
        .is_err()
    );
}
