use rho_protocol::*;
use rho_runner::artifacts::*;

fn descriptor(bytes: &[u8]) -> RemoteBlobDescriptor {
    RemoteBlobDescriptor {
        digest: digest(bytes),
        byte_size: bytes.len() as u64,
        media_type: "application/octet-stream".to_string(),
    }
}

fn manifest(
    job: &str,
    execution: &str,
    direction: TransferDirection,
    blobs: Vec<RemoteBlobDescriptor>,
) -> RemoteCasManifest {
    RemoteCasManifest {
        protocol_version: REMOTE_CAS_PROTOCOL_VERSION,
        job_id: job.to_string(),
        execution_id: ExecutionId::new(execution).unwrap(),
        direction,
        blobs,
    }
}

fn lease(manifest: &RemoteCasManifest, expiry: u64) -> RemoteCasLease {
    RemoteCasLease {
        lease_id: format!("lease_{}", manifest.job_id),
        job_id: manifest.job_id.clone(),
        execution_id: manifest.execution_id.clone(),
        direction: manifest.direction,
        allowed_digests: manifest
            .blobs
            .iter()
            .map(|blob| blob.digest.clone())
            .collect(),
        expires_at_ms: expiry,
    }
}

#[test]
fn artifacts_negotiate_missing_chunk_verify_fsync_commit_and_read_end_to_end() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = vec![42_u8; REMOTE_CAS_CHUNK_BYTES + 17];
    let blob = descriptor(&bytes);
    let upload_manifest = manifest(
        "job_transfer",
        "execution_transfer",
        TransferDirection::UploadInput,
        vec![blob.clone()],
    );
    let upload_lease = lease(&upload_manifest, 2000);
    let mut server = RemoteCasServer::open(temp.path(), RemoteCasQuota::default()).unwrap();
    let negotiation = server
        .negotiate(&upload_manifest, &upload_lease, 1000)
        .unwrap();
    assert_eq!(negotiation.missing[0].next_offset, 0);
    let mut offset = 0;
    for chunk_bytes in bytes.chunks(REMOTE_CAS_CHUNK_BYTES) {
        let outcome = server
            .write_chunk(
                &upload_lease,
                &RemoteCasChunk {
                    digest: blob.digest.clone(),
                    offset,
                    bytes: chunk_bytes.to_vec(),
                    chunk_digest: digest(chunk_bytes),
                },
                1000,
            )
            .unwrap();
        offset = match outcome {
            ChunkWriteOutcome::Advanced(cursor) => cursor.next_offset,
            ChunkWriteOutcome::Duplicate(_) => panic!("first write cannot duplicate"),
        };
    }
    server
        .finalize_upload(&upload_lease, &blob.digest, 1000)
        .unwrap();
    let present = server
        .negotiate(&upload_manifest, &upload_lease, 1000)
        .unwrap();
    assert_eq!(present.already_present, vec![blob.digest.clone()]);
    assert!(present.missing.is_empty());

    let download_manifest = manifest(
        "job_transfer",
        "execution_transfer",
        TransferDirection::DownloadOutput,
        vec![blob.clone()],
    );
    let download_lease = lease(&download_manifest, 2000);
    let first = server
        .read_chunk(&download_lease, &blob.digest, 0, 1000)
        .unwrap();
    assert_eq!(first.chunk_digest, digest(&first.bytes));
    assert_eq!(first.bytes, bytes[..REMOTE_CAS_CHUNK_BYTES]);
}

#[test]
fn artifacts_resume_after_disconnect_retransmits_only_missing_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = vec![7_u8; REMOTE_CAS_CHUNK_BYTES + 10];
    let blob = descriptor(&bytes);
    let manifest = manifest(
        "job_resume",
        "execution_resume",
        TransferDirection::UploadInput,
        vec![blob.clone()],
    );
    let lease = lease(&manifest, 2000);
    {
        let mut server = RemoteCasServer::open(temp.path(), RemoteCasQuota::default()).unwrap();
        server.negotiate(&manifest, &lease, 1000).unwrap();
        let first = &bytes[..REMOTE_CAS_CHUNK_BYTES];
        server
            .write_chunk(
                &lease,
                &RemoteCasChunk {
                    digest: blob.digest.clone(),
                    offset: 0,
                    bytes: first.to_vec(),
                    chunk_digest: digest(first),
                },
                1000,
            )
            .unwrap();
        // Drop simulates disconnect/runner restart; partial file remains durable.
    }
    let mut restarted = RemoteCasServer::open(temp.path(), RemoteCasQuota::default()).unwrap();
    let negotiation = restarted.negotiate(&manifest, &lease, 1000).unwrap();
    assert_eq!(
        negotiation.missing[0].next_offset,
        REMOTE_CAS_CHUNK_BYTES as u64
    );
    let remaining = &bytes[REMOTE_CAS_CHUNK_BYTES..];
    restarted
        .write_chunk(
            &lease,
            &RemoteCasChunk {
                digest: blob.digest.clone(),
                offset: REMOTE_CAS_CHUNK_BYTES as u64,
                bytes: remaining.to_vec(),
                chunk_digest: digest(remaining),
            },
            1000,
        )
        .unwrap();
    restarted
        .finalize_upload(&lease, &blob.digest, 1000)
        .unwrap();
}

#[test]
fn artifacts_corrupt_truncated_reordered_and_conflicting_duplicate_chunks_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"abcdefgh";
    let blob = descriptor(bytes);
    let manifest = manifest(
        "job_bad_chunks",
        "execution_bad_chunks",
        TransferDirection::UploadInput,
        vec![blob.clone()],
    );
    let lease = lease(&manifest, 2000);
    let mut server = RemoteCasServer::open(temp.path(), RemoteCasQuota::default()).unwrap();
    server.negotiate(&manifest, &lease, 1000).unwrap();
    assert_eq!(
        server
            .write_chunk(
                &lease,
                &RemoteCasChunk {
                    digest: blob.digest.clone(),
                    offset: 0,
                    bytes: b"abcd".to_vec(),
                    chunk_digest: digest(b"wrong"),
                },
                1000,
            )
            .unwrap_err(),
        RemoteCasError::CorruptChunk
    );
    assert_eq!(
        server
            .write_chunk(
                &lease,
                &RemoteCasChunk {
                    digest: blob.digest.clone(),
                    offset: 4,
                    bytes: b"efgh".to_vec(),
                    chunk_digest: digest(b"efgh"),
                },
                1000,
            )
            .unwrap_err(),
        RemoteCasError::ReorderedChunk
    );
    server
        .write_chunk(
            &lease,
            &RemoteCasChunk {
                digest: blob.digest.clone(),
                offset: 0,
                bytes: b"abcd".to_vec(),
                chunk_digest: digest(b"abcd"),
            },
            1000,
        )
        .unwrap();
    assert!(matches!(
        server
            .write_chunk(
                &lease,
                &RemoteCasChunk {
                    digest: blob.digest.clone(),
                    offset: 0,
                    bytes: b"abcd".to_vec(),
                    chunk_digest: digest(b"abcd"),
                },
                1000,
            )
            .unwrap(),
        ChunkWriteOutcome::Duplicate(_)
    ));
    assert_eq!(
        server
            .write_chunk(
                &lease,
                &RemoteCasChunk {
                    digest: blob.digest.clone(),
                    offset: 0,
                    bytes: b"xxxx".to_vec(),
                    chunk_digest: digest(b"xxxx"),
                },
                1000,
            )
            .unwrap_err(),
        RemoteCasError::ReorderedChunk
    );
    assert_eq!(
        server
            .finalize_upload(&lease, &blob.digest, 1000)
            .unwrap_err(),
        RemoteCasError::Truncated
    );
}

#[test]
fn artifacts_lease_prevents_blob_enumeration_wrong_job_direction_digest_and_expiry() {
    let temp = tempfile::tempdir().unwrap();
    let blob = descriptor(b"allowed");
    let manifest = manifest(
        "job_scope",
        "execution_scope",
        TransferDirection::UploadInput,
        vec![blob.clone()],
    );
    let mut lease = lease(&manifest, 2000);
    let mut server = RemoteCasServer::open(temp.path(), RemoteCasQuota::default()).unwrap();
    lease.job_id = "other_job".to_string();
    assert!(server.negotiate(&manifest, &lease, 1000).is_err());
    lease = self::lease(&manifest, 500);
    assert!(server.negotiate(&manifest, &lease, 1000).is_err());
    lease = self::lease(&manifest, 2000);
    lease.allowed_digests.push(digest(b"unlisted"));
    assert!(server.negotiate(&manifest, &lease, 1000).is_err());
    let download = RemoteCasLease {
        direction: TransferDirection::DownloadOutput,
        ..self::lease(&manifest, 2000)
    };
    assert!(
        server
            .write_chunk(
                &download,
                &RemoteCasChunk {
                    digest: blob.digest,
                    offset: 0,
                    bytes: b"allowed".to_vec(),
                    chunk_digest: digest(b"allowed"),
                },
                1000,
            )
            .is_err()
    );
}

#[test]
fn artifacts_bandwidth_storage_concurrency_quota_and_partial_cleanup_are_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let blob = descriptor(b"quota");
    let manifest = manifest(
        "job_quota",
        "execution_quota",
        TransferDirection::UploadInput,
        vec![blob.clone()],
    );
    let lease = lease(&manifest, 2000);
    let mut server = RemoteCasServer::open(
        temp.path(),
        RemoteCasQuota {
            max_concurrent_transfers: 1,
            max_storage_bytes: 2,
            max_bandwidth_bytes: 2,
        },
    )
    .unwrap();
    server.negotiate(&manifest, &lease, 1000).unwrap();
    assert_eq!(
        server
            .write_chunk(
                &lease,
                &RemoteCasChunk {
                    digest: blob.digest,
                    offset: 0,
                    bytes: b"quota".to_vec(),
                    chunk_digest: digest(b"quota"),
                },
                1000,
            )
            .unwrap_err(),
        RemoteCasError::QuotaExceeded
    );
    assert_eq!(server.cleanup_partial("job_quota").unwrap(), 1);
}

#[test]
fn artifacts_boundary_never_enumerates_unlisted_blobs_or_syncs_mutable_project() {
    let (_, does_not_own) = artifacts_boundary();
    assert!(does_not_own.contains(&"blob_enumeration"));
    assert!(does_not_own.contains(&"mutable_project_sync"));
    assert!(does_not_own.contains(&"unverified_bytes_use"));
}
