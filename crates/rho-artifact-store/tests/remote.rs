use std::collections::BTreeMap;

use rho_artifact_store::{remote::*, *};
use rho_protocol::*;
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).unwrap()
}

#[derive(Default)]
struct FakePort {
    remote: BTreeMap<ArtifactDigest, Vec<u8>>,
    upload_offsets: BTreeMap<ArtifactDigest, u64>,
    uploaded_bytes: u64,
    disconnect_download_once: bool,
}

impl RemoteCasTransferPort for FakePort {
    fn negotiate(
        &mut self,
        manifest: &RemoteCasManifest,
        _lease: &RemoteCasLease,
        _now_ms: u64,
    ) -> Result<RemoteNegotiation, RemoteTransferPortError> {
        let mut missing = Vec::new();
        let mut already_present = Vec::new();
        for blob in &manifest.blobs {
            if self.remote.get(&blob.digest).is_some_and(|bytes| {
                bytes.len() as u64 == blob.byte_size && digest(bytes) == blob.digest
            }) {
                already_present.push(blob.digest.clone());
            } else {
                missing.push(RemoteCasResumeCursor {
                    digest: blob.digest.clone(),
                    next_offset: self.upload_offsets.get(&blob.digest).copied().unwrap_or(0),
                });
            }
        }
        Ok(RemoteNegotiation {
            missing,
            already_present,
        })
    }

    fn upload_chunk(
        &mut self,
        _lease: &RemoteCasLease,
        chunk: RemoteCasChunk,
        _now_ms: u64,
    ) -> Result<RemoteCasResumeCursor, RemoteTransferPortError> {
        let bytes = self.remote.entry(chunk.digest.clone()).or_default();
        if chunk.offset != bytes.len() as u64 || digest(&chunk.bytes) != chunk.chunk_digest {
            return Err(RemoteTransferPortError::Rejected);
        }
        bytes.extend_from_slice(&chunk.bytes);
        self.uploaded_bytes += chunk.bytes.len() as u64;
        self.upload_offsets
            .insert(chunk.digest.clone(), bytes.len() as u64);
        Ok(RemoteCasResumeCursor {
            digest: chunk.digest,
            next_offset: bytes.len() as u64,
        })
    }

    fn finalize_upload(
        &mut self,
        _lease: &RemoteCasLease,
        digest_value: &ArtifactDigest,
        _now_ms: u64,
    ) -> Result<(), RemoteTransferPortError> {
        if self
            .remote
            .get(digest_value)
            .is_some_and(|bytes| digest(bytes) == *digest_value)
        {
            Ok(())
        } else {
            Err(RemoteTransferPortError::Rejected)
        }
    }

    fn download_chunk(
        &mut self,
        _lease: &RemoteCasLease,
        digest_value: &ArtifactDigest,
        offset: u64,
        _now_ms: u64,
    ) -> Result<RemoteCasChunk, RemoteTransferPortError> {
        if self.disconnect_download_once {
            self.disconnect_download_once = false;
            return Err(RemoteTransferPortError::Disconnected);
        }
        let bytes = self
            .remote
            .get(digest_value)
            .ok_or(RemoteTransferPortError::Rejected)?;
        let end = (offset as usize + REMOTE_CAS_CHUNK_BYTES).min(bytes.len());
        let chunk = bytes[offset as usize..end].to_vec();
        Ok(RemoteCasChunk {
            digest: digest_value.clone(),
            offset,
            chunk_digest: digest(&chunk),
            bytes: chunk,
        })
    }
}

fn revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_remote").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_remote").unwrap(),
        state_revision: StateRevision(2),
        project_revision: ProjectRevision(3),
    }
}

fn lease(direction: TransferDirection, digest: ArtifactDigest) -> RemoteCasLease {
    RemoteCasLease {
        lease_id: "lease_remote".to_string(),
        job_id: "job_remote".to_string(),
        execution_id: ExecutionId::new("execution_remote").unwrap(),
        direction,
        allowed_digests: vec![digest],
        expires_at_ms: 2000,
    }
}

#[test]
fn remote_upload_negotiates_only_missing_digest_and_retries_from_cursor() {
    let cas_root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(cas_root.path(), ArtifactStoreConfig::default()).unwrap();
    let bytes = vec![3_u8; REMOTE_CAS_CHUNK_BYTES + 9];
    let handle = store.put_bytes(&bytes).unwrap();
    let descriptor = RemoteBlobDescriptor {
        digest: handle.digest.clone(),
        byte_size: bytes.len() as u64,
        media_type: "application/octet-stream".to_string(),
    };
    let mut port = FakePort::default();
    let first_chunk = bytes[..REMOTE_CAS_CHUNK_BYTES].to_vec();
    port.remote
        .insert(handle.digest.clone(), first_chunk.clone());
    port.upload_offsets
        .insert(handle.digest.clone(), first_chunk.len() as u64);
    let mut client = RemoteCasClient::new();
    let report = client
        .upload_inputs(
            &store,
            ExecutionId::new("execution_remote").unwrap(),
            "job_remote",
            &[(&handle, descriptor)],
            &lease(TransferDirection::UploadInput, handle.digest.clone()),
            1000,
            &mut port,
        )
        .unwrap();
    assert_eq!(
        report.resumed_from[&handle.digest],
        REMOTE_CAS_CHUNK_BYTES as u64
    );
    assert_eq!(report.transmitted_bytes, 9);
    assert_eq!(port.uploaded_bytes, 9);
    assert_eq!(digest(&port.remote[&handle.digest]), handle.digest);
}

#[test]
fn remote_upload_skips_already_present_blob_without_new_identity() {
    let cas_root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(cas_root.path(), ArtifactStoreConfig::default()).unwrap();
    let bytes = b"already remote".to_vec();
    let handle = store.put_bytes(&bytes).unwrap();
    let descriptor = RemoteBlobDescriptor {
        digest: handle.digest.clone(),
        byte_size: bytes.len() as u64,
        media_type: "text/plain; charset=utf-8".to_string(),
    };
    let mut port = FakePort::default();
    port.remote.insert(handle.digest.clone(), bytes);
    let report = RemoteCasClient::new()
        .upload_inputs(
            &store,
            ExecutionId::new("execution_remote").unwrap(),
            "job_remote",
            &[(&handle, descriptor)],
            &lease(TransferDirection::UploadInput, handle.digest.clone()),
            1000,
            &mut port,
        )
        .unwrap();
    assert!(report.uploaded_digests.is_empty());
    assert_eq!(report.already_present, vec![handle.digest]);
    assert_eq!(report.transmitted_bytes, 0);
}

#[test]
fn remote_download_disconnect_retains_cursor_then_verifies_digest_before_local_cas_commit() {
    let cas_root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(cas_root.path(), ArtifactStoreConfig::default()).unwrap();
    let bytes = vec![5_u8; REMOTE_CAS_CHUNK_BYTES + 7];
    let digest_value = digest(&bytes);
    let descriptor = RemoteBlobDescriptor {
        digest: digest_value.clone(),
        byte_size: bytes.len() as u64,
        media_type: "application/octet-stream".to_string(),
    };
    let mut port = FakePort {
        remote: BTreeMap::from([(digest_value.clone(), bytes)]),
        disconnect_download_once: true,
        ..FakePort::default()
    };
    let mut client = RemoteCasClient::new();
    assert!(matches!(
        client.download_output(
            &mut store,
            &descriptor,
            &lease(TransferDirection::DownloadOutput, digest_value.clone()),
            revision(),
            Vec::new(),
            None,
            1000,
            &mut port,
        ),
        Err(RemoteCasClientError::Transfer(
            RemoteTransferPortError::Disconnected
        ))
    ));
    assert_eq!(client.partial_cursor(&digest_value), Some(0));
    let report = client
        .download_output(
            &mut store,
            &descriptor,
            &lease(TransferDirection::DownloadOutput, digest_value.clone()),
            revision(),
            Vec::new(),
            None,
            1000,
            &mut port,
        )
        .unwrap();
    assert_eq!(report.handle.digest, digest_value);
    assert_eq!(
        store.read_by_handle(&report.handle).unwrap().len() as u64,
        descriptor.byte_size
    );
}

#[test]
fn remote_corrupt_output_never_commits_local_artifact() {
    let cas_root = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(cas_root.path(), ArtifactStoreConfig::default()).unwrap();
    let expected = b"expected";
    let digest_value = digest(expected);
    let descriptor = RemoteBlobDescriptor {
        digest: digest_value.clone(),
        byte_size: expected.len() as u64,
        media_type: "text/plain; charset=utf-8".to_string(),
    };
    let mut port = FakePort {
        remote: BTreeMap::from([(digest_value.clone(), b"corrupt".to_vec())]),
        ..FakePort::default()
    };
    assert!(
        RemoteCasClient::new()
            .download_output(
                &mut store,
                &descriptor,
                &lease(TransferDirection::DownloadOutput, digest_value),
                revision(),
                Vec::new(),
                None,
                1000,
                &mut port,
            )
            .is_err()
    );
}

#[test]
fn remote_boundary_forbids_project_sync_blob_enumeration_and_unverified_commit() {
    let (_, does_not_own) = remote_boundary();
    assert!(does_not_own.contains(&"whole_project_sync"));
    assert!(does_not_own.contains(&"remote_blob_enumeration"));
    assert!(does_not_own.contains(&"unverified_output_commit"));
    assert!(does_not_own.contains(&"mutable_path_identity"));
}
