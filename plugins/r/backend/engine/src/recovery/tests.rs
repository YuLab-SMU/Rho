use super::*;
use rho_plugin_protocol::{ArtifactId, PluginId, PluginInstanceId, RevisionId};
use rho_r_api::{CheckpointCoverage, CheckpointNativeReport, CheckpointSafeOptions};
use std::process::Command;

fn scope(root: &Path) -> RecoveryScope {
    RecoveryScope {
        project: ProjectId::new("project-one").unwrap(),
        project_root: root.into(),
        principal: PrincipalId::new("original-principal").unwrap(),
        provider: InstanceRef {
            plugin: PluginId::new("org.example.runtime").unwrap(),
            instance: PluginInstanceId::new("instance-one").unwrap(),
            revision: RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            artifact: ArtifactId::new(format!("sha256:{}", "b".repeat(64))).unwrap(),
        },
    }
}
fn report() -> CheckpointNativeReport {
    CheckpointNativeReport {
        saved_names: vec!["中文".into()],
        skipped: vec![],
        r_version: "4.5.1".into(),
        platform: "aarch64-apple-darwin20".into(),
        library_paths: vec!["/original/library".into()],
        package_inventory_digest: "inventory".into(),
        working_directory: None,
        safe_options: CheckpointSafeOptions {
            digits: Some(7),
            width: Some(80),
            scipen: None,
            out_dec: Some(".".into()),
            warn: None,
        },
        context_notices: vec![],
        required_core_namespaces: vec![],
        required_class_namespaces: vec![],
        coverage: CheckpointCoverage::CompleteEligibleGraph,
    }
}
fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn capture(archive: &RecoveryArchive, operation: &str, bytes: &[u8]) -> RecoveryLease {
    let lease = archive.begin(&id(operation)).unwrap();
    fs::write(lease.directory.join("payload.staging"), bytes).unwrap();
    lease
        .finish(
            "original-session".into(),
            None,
            report(),
            MAX_RECOVERY_BYTES,
        )
        .unwrap();
    lease
}
fn fixture() -> (tempfile::TempDir, PathBuf, RecoveryArchive) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let archive = RecoveryArchive::create(&root, scope(&root)).unwrap();
    (temp, root, archive)
}

#[test]
fn absent_archives_are_pure_and_only_exact_current_scope_is_accepted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let original = scope(&root);
    assert!(
        RecoveryArchive::open(&root, original.clone())
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::create_dir(root.join("checkpoints")).unwrap(); // Abandoned storage is never read.
    fs::write(
        root.join("checkpoints/manifest.json"),
        b"not current evidence",
    )
    .unwrap();
    assert!(
        RecoveryArchive::open(&root, original.clone())
            .unwrap()
            .is_none()
    );
    let archive = RecoveryArchive::create(&root, original.clone()).unwrap();
    for index in 0..4 {
        let mut changed = original.clone();
        match index {
            0 => changed.project = ProjectId::new("other-project").unwrap(),
            1 => changed.principal = PrincipalId::new("other-principal").unwrap(),
            2 => changed.provider.instance = PluginInstanceId::new("other-instance").unwrap(),
            _ => {
                changed.provider.revision =
                    RevisionId::new(format!("sha256:{}", "c".repeat(64))).unwrap()
            }
        }
        assert!(RecoveryArchive::open(&root, changed.clone()).is_err());
        assert!(RecoveryArchive::create(&root, changed).is_err());
    }
    assert!(archive.acquire(&id("absent")).is_err());
    assert_eq!(fs::read_dir(&archive.root).unwrap().count(), 1);
}

#[test]
fn payload_integrity_bounded_reads_and_immutable_evidence_survive_release() {
    let (_temp, root, archive) = fixture();
    let bytes = vec![42; MAX_RECOVERY_READ as usize + 37];
    let lease = capture(&archive, "capture/original", &bytes);
    let original = lease.verify().unwrap();
    assert_eq!(original.artifact.report.saved_names, vec!["中文"]);
    assert_eq!(
        lease.read(0, MAX_RECOVERY_READ).unwrap(),
        bytes[..MAX_RECOVERY_READ as usize]
    );
    assert_eq!(
        lease
            .read(MAX_RECOVERY_READ as u64, MAX_RECOVERY_READ)
            .unwrap(),
        vec![42; 37]
    );
    assert_eq!(lease.read(bytes.len() as u64, 1).unwrap(), Vec::<u8>::new());
    for (offset, limit) in [
        (0, 0),
        (0, MAX_RECOVERY_READ + 1),
        (bytes.len() as u64 + 1, 1),
    ] {
        assert!(lease.read(offset, limit).is_err());
    }
    assert!(archive.begin(lease.operation_id()).is_err());
    assert!(archive.acquire(lease.operation_id()).is_err());
    let pin = id("original-pin");
    lease
        .record_control(&pin, RecoveryControl::Pin { pinned: true })
        .unwrap();
    assert!(
        lease
            .record_control(&pin, RecoveryControl::Pin { pinned: false })
            .is_err()
    );
    assert!(lease.remove_payload_after_commit(&pin).is_err());
    drop(lease);
    let reopened = RecoveryArchive::open(&root, scope(&root)).unwrap().unwrap();
    let lease = reopened.acquire(&id("capture/original")).unwrap();
    assert_eq!(lease.verify().unwrap(), original);
    assert_eq!(
        lease.control(&pin).unwrap().control,
        RecoveryControl::Pin { pinned: true }
    );
    let path = lease.directory.join("payload.rds");
    let mut damaged = bytes;
    damaged[12] ^= 1;
    fs::write(&path, &damaged).unwrap();
    assert!(lease.verify().unwrap_err().contains("integrity"));
    fs::write(&path, b"shorter").unwrap();
    assert!(lease.read(0, 1).is_err());
    assert!(lease.verify().is_err());
    assert_eq!(lease.capture().unwrap(), original); // Damage never rewrites evidence.
}

#[test]
fn capture_context_is_immutable_bounded_and_does_not_hide_missing_payloads() {
    let (_temp,_root,archive)=fixture();
    let lease=capture(&archive,"context",b"payload");
    assert_eq!(lease.read_context::<serde_json::Value>().unwrap(),None);
    let context=serde_json::json!({"original":"context","libraries_complete":false});
    lease.write_context(&context).unwrap();
    assert_eq!(lease.read_context::<serde_json::Value>().unwrap(),Some(context));
    assert!(lease.write_context(&serde_json::json!({"replaced":true})).is_err());
    assert!(lease.payload_present().unwrap());
    let deletion=id("delete-context-payload");
    lease.record_control(&deletion,RecoveryControl::Delete).unwrap();
    lease.remove_payload_after_commit(&deletion).unwrap();
    assert!(!lease.payload_present().unwrap());
    assert!(lease.read_context::<serde_json::Value>().unwrap().is_some());
    fs::write(lease.directory.join("context.json"),vec![b' ';MAX_METADATA as usize+1]).unwrap();
    assert!(lease.read_context::<serde_json::Value>().is_err());
}

#[test]
fn adoption_has_independent_bytes_and_deletion_keeps_all_original_evidence() {
    let (_temp, root, archive) = fixture();
    let source = capture(&archive, "original", b"one immutable R graph");
    let original = source.verify().unwrap();
    let next = root.join("another-provider");
    fs::create_dir(&next).unwrap();
    let mut other_scope = scope(&root);
    other_scope.provider.instance = PluginInstanceId::new("instance-two").unwrap();
    let next_archive = RecoveryArchive::create(&next, other_scope).unwrap();
    let adopted = next_archive
        .adopt(&id("explicit-reconciliation"), &source)
        .unwrap();
    let copy = adopted.verify().unwrap();
    assert_eq!(copy.artifact, original.artifact);
    assert_eq!(copy.source.unwrap().operation_id, id("original"));
    let delete = id("committed-delete");
    source
        .record_control(&delete, RecoveryControl::Delete)
        .unwrap();
    assert!(source.verify().is_ok()); // Recording evidence does not apply deletion.
    source.remove_payload_after_commit(&delete).unwrap();
    source.remove_payload_after_commit(&delete).unwrap();
    assert!(source.verify().is_err());
    assert_eq!(source.capture().unwrap(), original);
    assert_eq!(source.control(&delete).unwrap().operation_id, delete);
    assert_eq!(adopted.verify().unwrap().artifact, original.artifact);
    assert_eq!(adopted.read(0, 100).unwrap(), b"one immutable R graph");
    let foreign_root = root.join("foreign-provider");
    fs::create_dir(&foreign_root).unwrap();
    let mut foreign = scope(&root);
    foreign.principal = PrincipalId::new("foreign").unwrap();
    let foreign = RecoveryArchive::create(&foreign_root, foreign).unwrap();
    assert!(
        foreign
            .adopt(&id("unauthorized-adoption"), &adopted)
            .is_err()
    );
    assert!(!foreign.directory(&id("unauthorized-adoption")).exists());
}

#[test]
fn incomplete_and_oversized_evidence_is_retained_without_becoming_a_capture() {
    let (_temp, _root, archive) = fixture();
    let lease = archive.begin(&id("partial")).unwrap();
    fs::write(
        lease.directory.join("payload.staging"),
        b"partial original bytes",
    )
    .unwrap();
    assert!(lease.finish("native".into(), None, report(), 4).is_err());
    assert!(lease.capture().is_err());
    assert_eq!(
        fs::read(lease.directory.join("payload.staging")).unwrap(),
        b"partial original bytes"
    );
    assert!(archive.begin(&id("partial")).is_err());
    let lease = capture(&archive, "oversized", b"R graph");
    fs::write(
        lease.directory.join("capture.json"),
        vec![b' '; MAX_METADATA as usize + 1],
    )
    .unwrap();
    assert!(lease.capture().unwrap_err().contains("1 MiB"));
}

#[test]
fn failed_native_capture_keeps_partial_bytes_and_original_cancellation_uncertainty() {
    let (_temp, _root, archive) = fixture();
    let lease = archive.begin(&id("failed-native-capture")).unwrap();
    let before = capture_failure(&lease, "native", NativeError::before_effect("refused by R"));
    assert!(!before.effect_may_have_occurred);
    assert_eq!(
        before.recovery.unwrap()["operation_id"],
        "failed-native-capture"
    );
    fs::write(lease.directory.join("payload.staging"), b"partial graph").unwrap();
    let mut cancelled = NativeError::before_effect("native cancellation");
    cancelled.query_code = Some("checkpoint_cancelled".into());
    cancelled.recovery = Some(serde_json::json!({"original_transport":"retained"}));
    let after = capture_failure(&lease, "native", cancelled);
    assert!(after.effect_may_have_occurred);
    assert_eq!(after.message, "native cancellation");
    assert_eq!(after.query_code.as_deref(), Some("checkpoint_cancelled"));
    assert_eq!(after.recovery.unwrap()["original_transport"], "retained");
    assert_eq!(
        fs::read(lease.directory.join("payload.staging")).unwrap(),
        b"partial graph"
    );
    assert!(lease.capture().is_err());
}

#[test]
fn payload_larger_than_the_generic_resource_limit_is_streamed_with_bounded_reads() {
    let (_temp, _root, archive) = fixture();
    let lease = archive.begin(&id("large-native-graph")).unwrap();
    let size = rho_plugin_protocol::MAX_RESOURCE_BYTES + 17;
    let path = lease.directory.join("payload.staging");
    let mut file = create_file(&path).unwrap();
    // Sparse fixture tests the actual filesystem/digest/read path without a
    // matching allocation or requiring R to construct hundreds of MiB of data.
    file.set_len(size).unwrap();
    file.seek(SeekFrom::Start(size - 4)).unwrap();
    file.write_all(b"tail").unwrap();
    file.sync_all().unwrap();
    let captured = lease
        .finish("native".into(), None, report(), MAX_RECOVERY_BYTES)
        .unwrap();
    assert_eq!(captured.artifact.byte_size, size);
    assert_eq!(lease.verify().unwrap(), captured);
    assert_eq!(lease.read(size - 4, MAX_RECOVERY_READ).unwrap(), b"tail");
    assert_eq!(lease.read(0, 7).unwrap(), vec![0; 7]);
}

#[test]
fn cross_process_lock_is_exclusive_and_process_exit_releases_it_without_deleting_it() {
    let (_temp, root, archive) = fixture();
    let source = capture(&archive, "cross-process", b"R graph");
    let run = |mode: &str| {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recovery::tests::process_lock_probe",
                "--nocapture",
            ])
            .env("RHO_RECOVERY_LOCK_PROBE", &root)
            .env("RHO_RECOVERY_LOCK_MODE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run("busy");
    let lock_path = source.directory.join("lease");
    let inode = FileIdentity::of(&fs::metadata(&lock_path).unwrap());
    drop(source);
    run("exit-without-drop");
    let again = archive.acquire(&id("cross-process")).unwrap();
    assert!(again.verify().is_ok());
    assert!(FileIdentity::of(&fs::metadata(&lock_path).unwrap()) == inode);
}

#[test]
fn process_lock_probe() {
    let Some(root) = std::env::var_os("RHO_RECOVERY_LOCK_PROBE") else {
        return;
    };
    let root = PathBuf::from(root);
    let archive = RecoveryArchive::open(&root, scope(&root)).unwrap().unwrap();
    let lease = archive.acquire(&id("cross-process"));
    if std::env::var("RHO_RECOVERY_LOCK_MODE").unwrap() == "busy" {
        assert!(lease.is_err());
    } else {
        let _lease = lease.unwrap();
        std::process::exit(0); // Demonstrates OS ownership release without a Rust destructor.
    }
}

#[cfg(unix)]
#[test]
fn aliases_replaced_locks_and_replaced_directories_cannot_retarget_owned_evidence() {
    use std::os::unix::fs::symlink;
    let (_temp, root, archive) = fixture();
    let lease = capture(&archive, "original", b"R graph");
    let payload = lease.directory.join("payload.rds");
    let original = lease.directory.join("original.rds");
    fs::rename(&payload, &original).unwrap();
    symlink(&original, &payload).unwrap();
    assert!(lease.verify().is_err());
    fs::remove_file(&payload).unwrap();
    fs::hard_link(&original, &payload).unwrap();
    assert!(lease.verify().is_err());
    fs::remove_file(&payload).unwrap();
    fs::rename(&original, &payload).unwrap();
    assert!(lease.verify().is_ok());
    let lock = lease.directory.join("lease");
    fs::rename(&lock, lease.directory.join("original-lease")).unwrap();
    fs::write(&lock, b"").unwrap();
    assert!(lease.check().is_err());
    assert!(
        lease
            .record_control(&id("changed-lock"), RecoveryControl::Delete)
            .is_err()
    );
    drop(lease);
    let lease = archive.acquire(&id("original")).unwrap();
    let moved = root.join("moved-artifact");
    fs::rename(&lease.directory, &moved).unwrap();
    fs::create_dir(&lease.directory).unwrap();
    fs::copy(moved.join("lease"), lease.directory.join("lease")).unwrap();
    assert!(lease.check().is_err());
    drop(lease);
    fs::rename(&archive.root, root.join("moved-archive")).unwrap();
    fs::create_dir(&archive.root).unwrap();
    fs::copy(
        root.join("moved-archive/scope.json"),
        archive.root.join("scope.json"),
    )
    .unwrap();
    assert!(archive.check().is_err());
}

#[test]
fn capture_request_validation_preserves_large_graph_support_and_utf8_bounds() {
    let mut args: CheckpointCaptureArguments =
        serde_json::from_value(serde_json::json!({"expected_session":"native"})).unwrap();
    assert_eq!(args.max_bytes, 2 * 1024 * 1024 * 1024);
    args.max_bytes = MAX_RECOVERY_BYTES;
    args.max_seconds = 300.0;
    args.validate().unwrap();
    args.max_bytes += 1;
    assert!(args.validate().is_err());
    args.max_bytes = MAX_RECOVERY_BYTES;
    args.max_seconds = f64::NAN;
    assert!(args.validate().is_err());
    args.max_seconds = 1.0;
    args.include_names = Some(vec!["中".repeat(1366)]);
    assert!(args.validate().is_err());
    args.include_names = None;
    args.exclude_patterns = vec!["*".into(); 33];
    assert!(args.validate().is_err());
    args.exclude_patterns.clear();
    args.expected_session = "bad\0target".into();
    assert!(args.validate().is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_recovery_component_is_refused_before_spawning_ark() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executable = root.join("ark");
    fs::write(
        &executable,
        "#!/bin/sh\nprintf 'unexpected launch' > \"$0.launched\"\nexit 73\n",
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let result = ArkRuntime::launch(crate::ArkConfig {
        checkpoint_helper_path: Some(root.join("missing-component")),
        executable: executable.clone(),
        r_home: root.clone(),
        project_root: root.clone(),
        data_root: root.join("native-data"),
        execution_timeout: std::time::Duration::from_secs(10),
        library_path: None,
    })
    .await;
    assert!(result.is_err());
    assert!(!root.join("ark.launched").exists());
    assert!(!root.join("native-data").exists());
}
