#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

use rho_artifact_store::*;
use rho_protocol::*;

fn revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_cas_fault").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_cas_fault").unwrap(),
        state_revision: StateRevision(2),
        project_revision: ProjectRevision(3),
    }
}

fn request(bytes: &[u8], label: &str) -> ArtifactCommitRequest {
    ArtifactCommitRequest {
        bytes: bytes.to_vec(),
        media_type: Some(sniff_media_type(bytes).to_string()),
        execution_id: Some(ExecutionId::new(format!("execution_cas_fault_{label}")).unwrap()),
        revision: revision(),
        inputs: Vec::new(),
        environment_digest: None,
    }
}

fn blob_path(root: &std::path::Path, digest: &ArtifactDigest) -> std::path::PathBuf {
    let hex = digest.as_str().trim_start_matches("sha256:");
    root.join(".rho/artifacts/cas").join(&hex[..2]).join(hex)
}

#[test]
fn fault_cas_lifecycle_matrix_classifies_temp_orphan_and_committed_truth_after_restart() {
    for point in [
        ArtifactFaultPoint::BeforeWrite,
        ArtifactFaultPoint::AfterTempWrite,
        ArtifactFaultPoint::AfterFsync,
        ArtifactFaultPoint::AfterHash,
        ArtifactFaultPoint::AfterRename,
        ArtifactFaultPoint::BeforeMetadataCommit,
        ArtifactFaultPoint::AfterMetadataCommit,
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut store = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
        let bytes = format!("fault-point-{point:?}").into_bytes();
        assert!(matches!(
            store.commit_with_fault(request(&bytes, "matrix"), Some(point)),
            Err(ArtifactStoreError::FaultInjected(observed)) if observed == point
        ));
        drop(store);
        let reopened = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
        let health = reopened.verify_health().unwrap();
        match point {
            ArtifactFaultPoint::BeforeWrite => {
                assert_eq!(health.class, ArtifactHealthClass::Healthy)
            }
            ArtifactFaultPoint::AfterTempWrite
            | ArtifactFaultPoint::AfterFsync
            | ArtifactFaultPoint::AfterHash => {
                assert_eq!(health.class, ArtifactHealthClass::ReclaimOrphans);
                assert!(!health.scan.partial_temp_files.is_empty());
            }
            ArtifactFaultPoint::AfterRename | ArtifactFaultPoint::BeforeMetadataCommit => {
                assert_eq!(health.class, ArtifactHealthClass::ReclaimOrphans);
                assert_eq!(
                    health.scan.orphan_blobs,
                    vec![digest_bytes(&bytes).unwrap()]
                );
            }
            ArtifactFaultPoint::AfterMetadataCommit => {
                assert_eq!(health.class, ArtifactHealthClass::Healthy);
                assert_eq!(reopened.manifest_count(), 1);
            }
        }
    }
}

#[test]
fn fault_cas_missing_and_corrupt_blob_block_only_affected_artifact() {
    let root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
    let commit = store
        .commit(request(b"CANARY_ARTIFACT_BYTES", "corrupt"))
        .unwrap();
    fs::write(blob_path(root.path(), &commit.handle.digest), b"corrupt").unwrap();
    let health = store.verify_health().unwrap();
    assert_eq!(health.class, ArtifactHealthClass::BlockedCorrupt);
    assert!(health.scan.corrupt_blobs.contains(&commit.handle.digest));
    let diagnostic = serde_json::to_string(&health).unwrap();
    assert!(!diagnostic.contains("CANARY_ARTIFACT_BYTES"));

    let other = store
        .commit(request(b"other healthy bytes", "healthy"))
        .unwrap();
    assert_eq!(
        store.read_by_handle(&other.handle).unwrap(),
        b"other healthy bytes"
    );
    fs::remove_file(blob_path(root.path(), &other.handle.digest)).unwrap();
    let health = store.verify_health().unwrap();
    assert!(
        health
            .scan
            .corrupt_manifests
            .contains(&other.handle.artifact_id)
    );
}

#[test]
fn fault_cas_manifest_corruption_is_stable_blocked_classification_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
    let commit = store
        .commit(request(b"manifest bytes", "manifest"))
        .unwrap();
    drop(store);
    fs::write(
        root.path()
            .join(".rho/artifacts/manifests")
            .join(format!("{}.json", commit.handle.artifact_id.as_str())),
        b"CANARY_SENSITIVE_MANIFEST not json",
    )
    .unwrap();
    let reopened = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
    let health = reopened.verify_health().unwrap();
    assert_eq!(health.class, ArtifactHealthClass::BlockedCorrupt);
    assert_eq!(health.reason_code, "artifact_manifest_metadata_corrupt");
    assert!(
        !serde_json::to_string(&health)
            .unwrap()
            .contains("CANARY_SENSITIVE_MANIFEST")
    );
}

#[test]
fn fault_cas_disk_full_permission_and_duplicate_recovery_never_claim_false_success() {
    let root = tempfile::tempdir().unwrap();
    let mut quota = ArtifactStore::open(
        root.path(),
        ArtifactStoreConfig {
            max_artifact_bytes: 100,
            max_total_bytes: 2,
        },
    )
    .unwrap();
    assert!(matches!(
        quota.commit(request(b"too large for total", "full")),
        Err(ArtifactStoreError::TotalQuotaExceeded { .. })
    ));
    assert_eq!(
        quota.verify_health().unwrap().class,
        ArtifactHealthClass::Healthy
    );

    let root = tempfile::tempdir().unwrap();
    let manifest_root = root.path().join(".rho/artifacts/manifests");
    let mut store = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
    fs::set_permissions(&manifest_root, fs::Permissions::from_mode(0o500)).unwrap();
    assert!(store.commit(request(b"permission", "permission")).is_err());
    fs::set_permissions(&manifest_root, fs::Permissions::from_mode(0o700)).unwrap();
    let health = store.verify_health().unwrap();
    assert_eq!(health.class, ArtifactHealthClass::ReclaimOrphans);

    let first = store.commit(request(b"dedupe", "dedupe_one")).unwrap();
    let second = store.commit(request(b"dedupe", "dedupe_two")).unwrap();
    assert_eq!(first.handle.digest, second.handle.digest);
    assert!(second.deduped_existing_blob);
    drop(store);
    let reopened = ArtifactStore::open(root.path(), ArtifactStoreConfig::default()).unwrap();
    assert_eq!(reopened.manifest_count(), 2);
}

#[test]
fn fault_cas_large_scan_is_bounded_and_bounded_gc_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(
        root.path(),
        ArtifactStoreConfig {
            max_artifact_bytes: 1024,
            max_total_bytes: 1024 * 1024,
        },
    )
    .unwrap();
    for index in 0..500 {
        store
            .commit(request(
                format!("artifact-{index}").as_bytes(),
                &format!("large_{index}"),
            ))
            .unwrap();
    }
    let started = Instant::now();
    assert_eq!(
        store.verify_health().unwrap().class,
        ArtifactHealthClass::Healthy
    );
    assert!(started.elapsed() < Duration::from_secs(10));

    // Produce one orphan at the post-rename durability point.
    let _ = store.commit_with_fault(
        request(b"orphan-large", "orphan"),
        Some(ArtifactFaultPoint::AfterRename),
    );
    assert_eq!(store.garbage_collect_orphans(1).unwrap().removed.len(), 1);
    assert!(store.garbage_collect_orphans(1).unwrap().removed.is_empty());
}
