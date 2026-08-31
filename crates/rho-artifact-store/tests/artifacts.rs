use rho_artifact_store::*;
use rho_protocol::*;
use serde_json::to_string;

fn open(config: ArtifactStoreConfig) -> (tempfile::TempDir, ArtifactStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = ArtifactStore::open(temp.path(), config).unwrap();
    (temp, store)
}

fn revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_artifact").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_artifact").unwrap(),
        state_revision: StateRevision(2),
        project_revision: ProjectRevision(3),
    }
}

fn commit_request(bytes: &[u8], execution: &str) -> ArtifactCommitRequest {
    ArtifactCommitRequest {
        bytes: bytes.to_vec(),
        media_type: Some(sniff_media_type(bytes).to_string()),
        execution_id: Some(ExecutionId::new(execution).unwrap()),
        revision: revision(),
        inputs: Vec::new(),
        environment_digest: None,
    }
}

#[test]
fn artifact_store_writes_content_addressed_bytes_under_project_root() {
    let (temp, mut store) = open(ArtifactStoreConfig::default());
    let handle = store.put_bytes(b"hello artifact").unwrap();
    assert_eq!(handle.digest, digest_bytes(b"hello artifact").unwrap());
    assert!(handle.broker_handle_id.contains(handle.digest.as_str()));
    assert!(
        !to_string(&handle)
            .unwrap()
            .contains(temp.path().to_string_lossy().as_ref())
    );
    assert_eq!(store.read_by_handle(&handle).unwrap(), b"hello artifact");
}

#[test]
fn artifact_store_rejects_project_escape_and_symlink_escape() {
    let (temp, mut store) = open(ArtifactStoreConfig::default());
    let outside = tempfile::NamedTempFile::new().unwrap();
    assert!(matches!(
        store.ingest_project_file(outside.path()),
        Err(ArtifactStoreError::PathEscapesProject)
    ));

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let link = temp.path().join("escape_link");
        symlink(outside.path(), &link).unwrap();
        assert!(matches!(
            store.ingest_project_file(&link),
            Err(ArtifactStoreError::PathEscapesProject)
        ));
    }
}

#[test]
fn artifact_store_enforces_per_artifact_and_total_quotas() {
    let (_temp, mut per_artifact) = open(ArtifactStoreConfig {
        max_artifact_bytes: 4,
        max_total_bytes: 100,
    });
    assert!(matches!(
        per_artifact.put_bytes(b"12345"),
        Err(ArtifactStoreError::ArtifactTooLarge { .. })
    ));

    let (_temp, mut total) = open(ArtifactStoreConfig {
        max_artifact_bytes: 10,
        max_total_bytes: 6,
    });
    total.put_bytes(b"1234").unwrap();
    assert!(matches!(
        total.put_bytes(b"5678"),
        Err(ArtifactStoreError::TotalQuotaExceeded { .. })
    ));
}

#[test]
fn artifact_store_sniffs_mime_and_generates_bounded_preview() {
    assert_eq!(sniff_media_type(b"\x89PNG\r\n\x1a\nrest"), "image/png");
    assert_eq!(sniff_media_type(b"{\"x\":1}"), "application/json");
    let preview = preview_for(
        "a".repeat(MAX_PREVIEW_BYTES + 10).as_bytes(),
        "text/plain; charset=utf-8",
    );
    assert!(preview.truncated);
    assert_eq!(preview.text.unwrap().len(), MAX_PREVIEW_BYTES);
}

#[test]
fn artifact_semantic_event_references_digest_not_inline_bytes() {
    let (_temp, mut store) = open(ArtifactStoreConfig::default());
    let secret_bytes = b"CANARY_RAW_BYTES_SHOULD_NOT_APPEAR";
    let handle = store.put_bytes(secret_bytes).unwrap();
    let event = store.semantic_artifact_event(&handle, revision());
    let encoded = serde_json::to_string(&event).unwrap();
    assert!(encoded.contains(handle.digest.as_str()));
    assert!(!encoded.contains("CANARY_RAW_BYTES_SHOULD_NOT_APPEAR"));
}

#[test]
fn artifact_tombstone_and_reclaim_remove_bytes_but_retain_live_artifacts() {
    let (_temp, mut store) = open(ArtifactStoreConfig::default());
    let dead = store.put_bytes(b"dead artifact").unwrap();
    let live = store.put_bytes(b"live artifact").unwrap();
    store.tombstone(&dead.digest, "user deleted output");
    assert!(matches!(
        store.read_by_handle(&dead),
        Err(ArtifactStoreError::Tombstoned(_))
    ));
    let report = store.reclaim().unwrap();
    assert!(report.removed.contains(&dead.digest));
    assert!(report.retained_live.contains(&live.digest));
    assert_eq!(store.read_by_handle(&live).unwrap(), b"live artifact");
}

#[test]
fn artifact_same_bytes_dedupe_but_distinct_metadata_can_create_distinct_logical_artifacts() {
    let (_temp, mut store) = open(ArtifactStoreConfig::default());
    let first = store
        .commit(commit_request(b"same bytes", "execution_same_one"))
        .unwrap();
    let second = store
        .commit(commit_request(b"same bytes", "execution_same_two"))
        .unwrap();
    assert_eq!(first.handle.digest, second.handle.digest);
    assert_ne!(first.handle.artifact_id, second.handle.artifact_id);
    assert!(second.deduped_existing_blob);
    assert_ne!(
        first.manifest.producer.execution_id,
        second.manifest.producer.execution_id
    );
}

#[test]
fn artifact_fault_after_rename_creates_orphan_and_missing_blob_is_corrupt() {
    let (_temp, mut store) = open(ArtifactStoreConfig::default());
    let digest = digest_bytes(b"orphan after rename").unwrap();
    assert!(matches!(
        store.commit_with_fault(
            commit_request(b"orphan after rename", "execution_orphan"),
            Some(ArtifactFaultPoint::AfterRename),
        ),
        Err(ArtifactStoreError::FaultInjected(
            ArtifactFaultPoint::AfterRename
        ))
    ));
    let scan = store.scan_reconcile().unwrap();
    assert!(scan.orphan_blobs.contains(&digest));

    let commit = store
        .commit(commit_request(b"corrupt missing", "execution_corrupt"))
        .unwrap();
    store.remove_blob_for_test(&commit.handle.digest).unwrap();
    let scan = store.scan_reconcile().unwrap();
    assert!(scan.corrupt_manifests.contains(&commit.handle.artifact_id));
}

#[test]
fn artifact_fault_injection_covers_write_fsync_hash_rename_and_metadata_commit() {
    for fault in [
        ArtifactFaultPoint::BeforeWrite,
        ArtifactFaultPoint::AfterTempWrite,
        ArtifactFaultPoint::AfterFsync,
        ArtifactFaultPoint::AfterHash,
        ArtifactFaultPoint::AfterRename,
        ArtifactFaultPoint::BeforeMetadataCommit,
        ArtifactFaultPoint::AfterMetadataCommit,
    ] {
        let (_temp, mut store) = open(ArtifactStoreConfig::default());
        assert!(matches!(
            store.commit_with_fault(
                commit_request(format!("fault {fault:?}").as_bytes(), "execution_fault"),
                Some(fault),
            ),
            Err(ArtifactStoreError::FaultInjected(point)) if point == fault
        ));
    }
}

#[test]
fn artifact_garbage_collection_is_bounded() {
    let (_temp, mut store) = open(ArtifactStoreConfig::default());
    let first = digest_bytes(b"orphan one").unwrap();
    let second = digest_bytes(b"orphan two").unwrap();
    for (bytes, execution) in [
        (b"orphan one".as_slice(), "execution_orphan_one"),
        (b"orphan two".as_slice(), "execution_orphan_two"),
    ] {
        let _ = store.commit_with_fault(
            commit_request(bytes, execution),
            Some(ArtifactFaultPoint::AfterRename),
        );
    }
    let report = store.garbage_collect_orphans(1).unwrap();
    assert_eq!(report.removed.len(), 1);
    let scan = store.scan_reconcile().unwrap();
    assert_eq!(scan.orphan_blobs.len(), 1);
    assert!(scan.orphan_blobs.contains(&first) || scan.orphan_blobs.contains(&second));
}

#[test]
fn artifact_lineage_dag_rejects_self_unknown_relation_and_cycle() {
    let (_temp, mut store) = open(ArtifactStoreConfig::default());
    let a = store
        .commit(commit_request(b"artifact a", "execution_a"))
        .unwrap();
    let b = store
        .commit(commit_request(b"artifact b", "execution_b"))
        .unwrap();
    let c = store
        .commit(commit_request(b"artifact c", "execution_c"))
        .unwrap();

    assert!(matches!(
        store.add_lineage_edge(
            a.handle.artifact_id.clone(),
            a.handle.artifact_id.clone(),
            ArtifactEdgeKind::DerivedFrom,
        ),
        Err(ArtifactStoreError::Lineage(LineageError::SelfEdge))
    ));
    assert!(matches!(
        store.add_lineage_edge_by_relation(
            a.handle.artifact_id.clone(),
            b.handle.artifact_id.clone(),
            "unknown_relation",
        ),
        Err(ArtifactStoreError::Lineage(LineageError::UnknownRelation(
            _
        )))
    ));

    store
        .add_lineage_edge(
            a.handle.artifact_id.clone(),
            b.handle.artifact_id.clone(),
            ArtifactEdgeKind::DerivedFrom,
        )
        .unwrap();
    store
        .add_lineage_edge(
            b.handle.artifact_id.clone(),
            c.handle.artifact_id.clone(),
            ArtifactEdgeKind::DerivedFrom,
        )
        .unwrap();
    assert!(matches!(
        store.add_lineage_edge(
            c.handle.artifact_id.clone(),
            a.handle.artifact_id.clone(),
            ArtifactEdgeKind::DerivedFrom,
        ),
        Err(ArtifactStoreError::Lineage(LineageError::Cycle))
    ));
}

#[test]
fn artifact_ui_contract_has_no_raw_path_surface() {
    let source = ui_artifact_contract_source();
    assert!(source.contains("ArtifactHandle"));
    assert!(!source.contains("PathBuf"));
    assert!(!source.contains("raw_path"));
}
