#![cfg(unix)]

use std::{
    fs,
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    },
};

use rho_artifact_store::{collection::*, *};
use rho_protocol::*;

fn revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_collect").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_collect").unwrap(),
        state_revision: StateRevision(9),
        project_revision: ProjectRevision(4),
    }
}

fn expected(path: &str, required: bool) -> ExpectedOutput {
    ExpectedOutput {
        artifact_id: None,
        path_hint: path.to_string(),
        required,
    }
}

fn open_store(config: ArtifactStoreConfig) -> (tempfile::TempDir, ArtifactStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = ArtifactStore::open(temp.path(), config).unwrap();
    (temp, store)
}

#[test]
fn collection_seals_terminal_staging_commits_cas_mime_digest_and_unique_provenance() {
    let staging = tempfile::tempdir().unwrap();
    fs::write(staging.path().join("result.json"), b"{\"ok\":true}").unwrap();
    let sealed = seal_output_staging(staging.path(), true).unwrap();
    let (_cas_root, mut store) = open_store(ArtifactStoreConfig::default());
    let mut collector = ArtifactOutputCollector::new();
    let execution_id = ExecutionId::new("execution_collection_success").unwrap();
    let report = collector.collect(
        &mut store,
        execution_id.clone(),
        true,
        &sealed,
        &[expected("result.json", true)],
        revision(),
        Vec::new(),
        Some(
            ArtifactDigest::new(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap(),
        ),
    );
    assert_eq!(report.status, CollectionStatus::Complete);
    assert!(report.product_succeeded);
    assert_eq!(report.committed.len(), 1);
    assert_eq!(report.committed[0].handle.media_type, "application/json");
    assert!(
        report.committed[0]
            .handle
            .digest
            .as_str()
            .starts_with("sha256:")
    );
    assert_eq!(collector.provenance_edges().len(), 1);

    let duplicate = collector.collect(
        &mut store,
        execution_id,
        true,
        &sealed,
        &[expected("result.json", true)],
        revision(),
        Vec::new(),
        None,
    );
    assert_eq!(duplicate.status, CollectionStatus::Complete);
    assert!(duplicate.committed[0].deduplicated);
    assert_eq!(collector.provenance_edges().len(), 1);
}

#[test]
fn collection_running_process_cannot_seal_or_collect() {
    let staging = tempfile::tempdir().unwrap();
    fs::write(staging.path().join("result"), b"still changing").unwrap();
    assert!(matches!(
        seal_output_staging(staging.path(), false),
        Err(OutputCollectionError::ProcessStillRunning)
    ));
}

#[test]
fn collection_missing_required_and_extra_suspicious_outputs_fail_without_fabricated_artifact() {
    let staging = tempfile::tempdir().unwrap();
    fs::write(staging.path().join("unexpected.sh"), b"malicious").unwrap();
    let sealed = seal_output_staging(staging.path(), true).unwrap();
    let (_cas_root, mut store) = open_store(ArtifactStoreConfig::default());
    let report = ArtifactOutputCollector::new().collect(
        &mut store,
        ExecutionId::new("execution_collection_missing").unwrap(),
        true,
        &sealed,
        &[expected("required.csv", true)],
        revision(),
        Vec::new(),
        None,
    );
    assert_eq!(report.status, CollectionStatus::Failed);
    assert!(!report.product_succeeded);
    assert_eq!(report.missing_required, vec!["required.csv"]);
    assert_eq!(report.suspicious_extra, vec!["unexpected.sh"]);
    assert!(report.committed.is_empty());
}

#[test]
fn collection_rejects_traversal_links_hardlinks_fifo_socket_and_file_count() {
    let staging = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink(outside.path(), staging.path().join("link")).unwrap();
    assert!(matches!(
        seal_output_staging(staging.path(), true),
        Err(OutputCollectionError::UnsafeFile)
    ));
    fs::remove_file(staging.path().join("link")).unwrap();
    fs::hard_link(outside.path(), staging.path().join("hard")).unwrap();
    assert!(matches!(
        seal_output_staging(staging.path(), true),
        Err(OutputCollectionError::UnsafeFile)
    ));
    fs::remove_file(staging.path().join("hard")).unwrap();
    let fifo = staging.path().join("fifo");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    assert!(matches!(
        seal_output_staging(staging.path(), true),
        Err(OutputCollectionError::UnsafeFile)
    ));
    fs::remove_file(fifo).unwrap();
    let socket = staging.path().join("socket");
    let _listener = UnixListener::bind(&socket).unwrap();
    assert!(matches!(
        seal_output_staging(staging.path(), true),
        Err(OutputCollectionError::UnsafeFile)
    ));

    let many = tempfile::tempdir().unwrap();
    for index in 0..=MAX_COLLECTED_OUTPUT_FILES {
        fs::write(many.path().join(format!("file_{index}")), b"x").unwrap();
    }
    assert!(matches!(
        seal_output_staging(many.path(), true),
        Err(OutputCollectionError::Bounds)
    ));
}

#[test]
fn collection_changed_after_seal_is_rejected_and_no_artifact_record_is_created() {
    let staging = tempfile::tempdir().unwrap();
    let path = staging.path().join("result.txt");
    fs::write(&path, b"sealed").unwrap();
    let sealed = seal_output_staging(staging.path(), true).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, b"changed").unwrap();
    let (_cas_root, mut store) = open_store(ArtifactStoreConfig::default());
    let report = ArtifactOutputCollector::new().collect(
        &mut store,
        ExecutionId::new("execution_collection_changed").unwrap(),
        true,
        &sealed,
        &[expected("result.txt", true)],
        revision(),
        Vec::new(),
        None,
    );
    assert_eq!(report.status, CollectionStatus::Failed);
    assert!(!report.product_succeeded);
    assert!(report.error_codes[0].contains("changed_after_seal"));
    assert!(report.committed.is_empty());
}

#[test]
fn collection_cas_quota_failure_after_first_output_is_partial_reconcile_not_success() {
    let staging = tempfile::tempdir().unwrap();
    fs::write(staging.path().join("a.txt"), b"1234").unwrap();
    fs::write(staging.path().join("b.txt"), b"5678").unwrap();
    let sealed = seal_output_staging(staging.path(), true).unwrap();
    let (_cas_root, mut store) = open_store(ArtifactStoreConfig {
        max_artifact_bytes: 10,
        max_total_bytes: 6,
    });
    let report = ArtifactOutputCollector::new().collect(
        &mut store,
        ExecutionId::new("execution_collection_partial").unwrap(),
        true,
        &sealed,
        &[expected("a.txt", true), expected("b.txt", true)],
        revision(),
        Vec::new(),
        None,
    );
    assert_eq!(report.status, CollectionStatus::PartialReconcile);
    assert_eq!(report.committed.len(), 1);
    assert!(!report.product_succeeded);
    assert!(report.reconcile_id.is_some());
}

#[test]
fn collection_process_success_is_separate_from_product_success() {
    let staging = tempfile::tempdir().unwrap();
    fs::write(staging.path().join("optional.txt"), b"optional").unwrap();
    let sealed = seal_output_staging(staging.path(), true).unwrap();
    let (_cas_root, mut store) = open_store(ArtifactStoreConfig::default());
    let failed_process = ArtifactOutputCollector::new().collect(
        &mut store,
        ExecutionId::new("execution_collection_process_failed").unwrap(),
        false,
        &sealed,
        &[expected("optional.txt", false)],
        revision(),
        Vec::new(),
        None,
    );
    assert!(!failed_process.product_succeeded);
    assert_eq!(failed_process.error_codes, vec!["process_not_succeeded"]);
}

#[test]
fn collection_boundary_never_uses_executor_path_as_identity_or_overwrites_project_cas_metadata() {
    let (_, does_not_own) = collection_boundary();
    assert!(does_not_own.contains(&"running_process_collect"));
    assert!(does_not_own.contains(&"executor_path_identity"));
    assert!(does_not_own.contains(&"project_overwrite"));
    assert!(does_not_own.contains(&"cas_metadata_overwrite"));
    assert!(does_not_own.contains(&"process_success_as_product_success"));
}
