//! Explicit native recovery acceptance, using only public/plugin crates. Core
//! publication and original-operation authorization belong to the RPC owner and
//! are outside this native test.
use rho_plugin_protocol::{
    ArtifactId, InstanceRef, PluginId, PluginInstanceId, PrincipalId, ProjectId, RevisionId,
};
use rho_r_api::*;
use rho_r_engine::{ArkConfig, ArkRuntime, recovery::*};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::watch;

fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn scope(root: &Path, instance: &str) -> RecoveryScope {
    RecoveryScope {
        project: ProjectId::new("disposable-project").unwrap(),
        project_root: root.into(),
        principal: PrincipalId::new("recovery-test").unwrap(),
        provider: InstanceRef {
            plugin: PluginId::new("org.example.recovery").unwrap(),
            instance: PluginInstanceId::new(instance).unwrap(),
            revision: RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            artifact: ArtifactId::new(format!("sha256:{}", "b".repeat(64))).unwrap(),
        },
    }
}
fn config(root: &Path, data: &Path) -> ArkConfig {
    let existing = |key| {
        PathBuf::from(std::env::var_os(key).expect(key))
            .canonicalize()
            .unwrap()
    };
    ArkConfig {
        checkpoint_helper_path: Some(existing("RHO_CHECKPOINT_HELPER")),
        executable: existing("RHO_ARK"),
        r_home: existing("RHO_R_HOME"),
        project_root: root.into(),
        data_root: data.into(),
        execution_timeout: Duration::from_secs(60),
        library_path: None,
    }
}
fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(message.into()) }
}
async fn execute(
    runtime: &ArkRuntime,
    operation: &str,
    code: &str,
) -> Result<serde_json::Value, String> {
    let report = runtime
        .execute(
            &id(operation),
            &RunRArguments {
                code: code.into(),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.message)?;
    require(
        report.outcome == rho_plugin_protocol::PluginOutcome::Succeeded,
        &format!("Native run failed: {report:?}"),
    )?;
    Ok(report.value)
}

async fn roundtrip(
    root: &Path,
    first_data: &Path,
    second_data: &Path,
    source: &ArkRuntime,
    candidate: &ArkRuntime,
) -> Result<(), String> {
    execute(source, "create-original-graph", "shared <- new.env(parent=emptyenv()); shared$value <- 42L; 中文 <- shared; alias <- shared; safe <- list(1:3)").await?;
    let archive = RecoveryArchive::create(first_data, scope(root, "source-instance"))?;
    let mut args: CheckpointCaptureArguments = serde_json::from_value(serde_json::json!({
        "expected_session":source.session_id(), "include_names":["中文", "alias", "safe"], "max_seconds":30,
    })).map_err(|e| e.to_string())?;
    args.expected_session = "wrong-session".into();
    require(
        source
            .capture_recovery(
                &archive,
                &id("wrong-session"),
                &args,
                watch::channel(false).1,
            )
            .await
            .is_err(),
        "Wrong session was admitted",
    )?;
    args.expected_session = source.session_id().into();
    require(
        source
            .capture_recovery(
                &archive,
                &id("cancelled-before-capture"),
                &args,
                watch::channel(true).1,
            )
            .await
            .is_err(),
        "Pre-start cancellation was ignored",
    )?;
    let captured = source
        .capture_recovery(
            &archive,
            &id("original-capture"),
            &args,
            watch::channel(false).1,
        )
        .await
        .map_err(|e| e.message)?;
    let original = captured.verify()?;
    let mut exhausted = args.clone();
    exhausted.max_seconds = 0.000000001;
    let failed = source
        .capture_recovery(
            &archive,
            &id("capture-budget-exhausted"),
            &exhausted,
            watch::channel(false).1,
        )
        .await;
    let error = match failed {
        Err(error) => error,
        Ok(_) => {
            return Err("An exhausted native capture budget produced a completed artifact".into());
        }
    };
    require(
        error
            .recovery
            .as_ref()
            .is_some_and(|recovery| recovery["operation_id"] == "capture-budget-exhausted"),
        "Failed capture lost its original recovery identity",
    )?;
    require(
        archive
            .acquire(&id("capture-budget-exhausted"))?
            .capture()
            .is_err(),
        "Failed capture was promoted to complete native evidence",
    )?;
    require(
        original
            .artifact
            .report
            .saved_names
            .iter()
            .any(|name| name == "中文"),
        "Unicode binding was not retained",
    )?;
    let mut sha = Sha256::new();
    let mut offset = 0;
    while offset < original.artifact.byte_size {
        let bytes = captured.read(offset, MAX_RECOVERY_READ)?;
        offset += bytes.len() as u64;
        sha.update(bytes);
    }
    require(
        format!("sha256:{:x}", sha.finalize()) == original.artifact.sha256,
        "Chunk transport changed payload bytes",
    )?;
    let restored = candidate
        .restore_recovery(
            &id("explicit-restore"),
            captured.clone(),
            watch::channel(false).1,
        )
        .await
        .map_err(|e| e.message)?;
    require(
        restored.restored_names == original.artifact.report.saved_names,
        "Restored binding identities differ",
    )?;
    let value = execute(
        candidate,
        "verify-restored-graph",
        "identical(中文, alias) && 中文$value == 42L && identical(safe, list(1:3))",
    )
    .await?;
    require(
        value == true,
        "Cross-binding alias or graph content changed",
    )?;
    execute(candidate, "change-candidate", "alias$value <- 99L").await?;
    let rejected = candidate
        .restore_recovery(
            &id("refuse-nonempty"),
            captured.clone(),
            watch::channel(false).1,
        )
        .await;
    require(rejected.is_err(), "Nonempty candidate was overwritten")?;
    require(
        execute(
            candidate,
            "verify-refused-restore",
            "identical(中文, alias) && 中文$value == 99L",
        )
        .await?
            == true,
        "Refused restore changed the existing candidate graph",
    )?;
    require(
        execute(source, "verify-source-isolation", "中文$value == 42L").await? == true,
        "Candidate changes reached the source session",
    )?;
    // This is native adoption only; no test claims that it committed an Operation.
    let replacement = RecoveryArchive::create(second_data, scope(root, "replacement-instance"))?;
    let adopted = replacement.adopt(&id("explicit-adoption"), &captured)?;
    require(
        adopted.verify()?.artifact == original.artifact,
        "Adoption changed captured evidence",
    )?;
    captured.record_control(&id("pin-evidence"), RecoveryControl::Pin { pinned: true })?;
    captured.record_control(&id("delete-evidence"), RecoveryControl::Delete)?;
    require(
        captured.verify().is_ok(),
        "Native control evidence applied itself as scientific truth",
    )?;
    drop(captured);
    let reopened = RecoveryArchive::open(first_data, scope(root, "source-instance"))?
        .ok_or("Original archive disappeared")?;
    let lease = reopened.acquire(&id("original-capture"))?;
    require(
        lease.verify()? == original,
        "Read-only reopening changed original evidence",
    )?;
    // Simulate the owner's already-qualified succeeded deletion; the native layer
    // neither queries a journal nor decides whether that operation was authorized.
    lease.remove_payload_after_commit(&id("delete-evidence"))?;
    require(
        lease.capture()? == original,
        "Deletion removed original metadata",
    )?;
    require(
        lease.verify().is_err(),
        "Deletion did not remove original bytes",
    )?;
    require(
        adopted.verify()?.artifact == original.artifact,
        "Deleting the source damaged the adopted payload",
    )?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicit RHO_ARK, RHO_R_HOME and verified RHO_CHECKPOINT_HELPER"]
async fn ordinary_recovery_native_roundtrip_preserves_aliases_and_original_evidence() {
    let project = tempfile::tempdir().unwrap();
    let root = project.path().canonicalize().unwrap();
    let first = root.join("first-provider");
    let second = root.join("second-provider");
    std::fs::create_dir(&first).unwrap();
    std::fs::create_dir(&second).unwrap();
    let source = Arc::new(ArkRuntime::launch(config(&root, &first)).await.unwrap());
    let candidate = ArkRuntime::launch(config(&root, &second)).await;
    let (result, candidate_stopped) = match candidate {
        Ok(candidate) => {
            let result = roundtrip(&root, &first, &second, &source, &candidate).await;
            let stopped = candidate.shutdown().await;
            (result, stopped)
        }
        Err(error) => (Err(error), Ok(())),
    };
    let source_stopped = source.shutdown().await;
    if result.is_err() || candidate_stopped.is_err() || source_stopped.is_err() {
        eprintln!(
            "Retained failed native recovery fixture: {}",
            project.keep().display()
        );
    }
    candidate_stopped.unwrap();
    source_stopped.unwrap();
    result.unwrap();
}
