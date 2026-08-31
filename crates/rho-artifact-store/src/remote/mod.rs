use std::collections::BTreeMap;

use rho_protocol::{
    ArtifactDigest, ArtifactRef, ExecutionId, MAX_REMOTE_CAS_BLOB_BYTES, REMOTE_CAS_CHUNK_BYTES,
    RemoteBlobDescriptor, RemoteCasChunk, RemoteCasLease, RemoteCasManifest, RemoteCasResumeCursor,
    RevisionStamp,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{ArtifactCommitRequest, ArtifactHandle, ArtifactStore, ArtifactStoreError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteNegotiation {
    pub missing: Vec<RemoteCasResumeCursor>,
    pub already_present: Vec<ArtifactDigest>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RemoteTransferPortError {
    #[error("remote transfer disconnected")]
    Disconnected,
    #[error("remote transfer was rejected")]
    Rejected,
    #[error("remote transfer quota exceeded")]
    Quota,
}

pub trait RemoteCasTransferPort {
    fn negotiate(
        &mut self,
        manifest: &RemoteCasManifest,
        lease: &RemoteCasLease,
        now_ms: u64,
    ) -> Result<RemoteNegotiation, RemoteTransferPortError>;
    fn upload_chunk(
        &mut self,
        lease: &RemoteCasLease,
        chunk: RemoteCasChunk,
        now_ms: u64,
    ) -> Result<RemoteCasResumeCursor, RemoteTransferPortError>;
    fn finalize_upload(
        &mut self,
        lease: &RemoteCasLease,
        digest: &ArtifactDigest,
        now_ms: u64,
    ) -> Result<(), RemoteTransferPortError>;
    fn download_chunk(
        &mut self,
        lease: &RemoteCasLease,
        digest: &ArtifactDigest,
        offset: u64,
        now_ms: u64,
    ) -> Result<RemoteCasChunk, RemoteTransferPortError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteUploadReport {
    pub uploaded_digests: Vec<ArtifactDigest>,
    pub already_present: Vec<ArtifactDigest>,
    pub resumed_from: BTreeMap<ArtifactDigest, u64>,
    pub transmitted_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteDownloadReport {
    pub handle: ArtifactHandle,
    pub received_bytes: u64,
    pub resumed_from: u64,
}

#[derive(Debug, Error)]
pub enum RemoteCasClientError {
    #[error("local artifact is unavailable")]
    LocalArtifact,
    #[error("remote transfer error: {0}")]
    Transfer(#[from] RemoteTransferPortError),
    #[error("remote chunk offset/checksum/digest is invalid")]
    CorruptTransfer,
    #[error("remote output is truncated")]
    Truncated,
    #[error("local CAS commit failed: {0}")]
    LocalCommit(#[from] ArtifactStoreError),
}

#[derive(Debug, Default)]
pub struct RemoteCasClient {
    partial_downloads: BTreeMap<ArtifactDigest, Vec<u8>>,
}

impl RemoteCasClient {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upload_inputs(
        &mut self,
        store: &ArtifactStore,
        execution_id: ExecutionId,
        job_id: impl Into<String>,
        inputs: &[(&ArtifactHandle, RemoteBlobDescriptor)],
        lease: &RemoteCasLease,
        now_ms: u64,
        port: &mut impl RemoteCasTransferPort,
    ) -> Result<RemoteUploadReport, RemoteCasClientError> {
        let manifest = RemoteCasManifest {
            protocol_version: rho_protocol::REMOTE_CAS_PROTOCOL_VERSION,
            job_id: job_id.into(),
            execution_id,
            direction: rho_protocol::TransferDirection::UploadInput,
            blobs: inputs
                .iter()
                .map(|(_, descriptor)| descriptor.clone())
                .collect(),
        };
        let negotiation = port.negotiate(&manifest, lease, now_ms)?;
        let missing = negotiation
            .missing
            .iter()
            .map(|cursor| (cursor.digest.clone(), cursor.next_offset))
            .collect::<BTreeMap<_, _>>();
        let mut uploaded_digests = Vec::new();
        let mut transmitted_bytes = 0_u64;
        for (handle, descriptor) in inputs {
            let Some(start) = missing.get(&descriptor.digest).copied() else {
                continue;
            };
            let bytes = store
                .read_by_handle(handle)
                .map_err(|_| RemoteCasClientError::LocalArtifact)?;
            if bytes.len() as u64 != descriptor.byte_size
                || digest(&bytes) != descriptor.digest
                || descriptor.byte_size > MAX_REMOTE_CAS_BLOB_BYTES
                || start > descriptor.byte_size
            {
                return Err(RemoteCasClientError::LocalArtifact);
            }
            let mut offset = start;
            while offset < bytes.len() as u64 {
                let end = (offset as usize + REMOTE_CAS_CHUNK_BYTES).min(bytes.len());
                let chunk_bytes = bytes[offset as usize..end].to_vec();
                let cursor = port.upload_chunk(
                    lease,
                    RemoteCasChunk {
                        digest: descriptor.digest.clone(),
                        offset,
                        chunk_digest: digest(&chunk_bytes),
                        bytes: chunk_bytes.clone(),
                    },
                    now_ms,
                )?;
                if cursor.next_offset != end as u64 {
                    return Err(RemoteCasClientError::CorruptTransfer);
                }
                transmitted_bytes += chunk_bytes.len() as u64;
                offset = cursor.next_offset;
            }
            port.finalize_upload(lease, &descriptor.digest, now_ms)?;
            uploaded_digests.push(descriptor.digest.clone());
        }
        Ok(RemoteUploadReport {
            uploaded_digests,
            already_present: negotiation.already_present,
            resumed_from: missing,
            transmitted_bytes,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn download_output(
        &mut self,
        store: &mut ArtifactStore,
        descriptor: &RemoteBlobDescriptor,
        lease: &RemoteCasLease,
        revision: RevisionStamp,
        inputs: Vec<ArtifactRef>,
        environment_digest: Option<ArtifactDigest>,
        now_ms: u64,
        port: &mut impl RemoteCasTransferPort,
    ) -> Result<RemoteDownloadReport, RemoteCasClientError> {
        let partial = self
            .partial_downloads
            .entry(descriptor.digest.clone())
            .or_default();
        let resumed_from = partial.len() as u64;
        while (partial.len() as u64) < descriptor.byte_size {
            let expected_offset = partial.len() as u64;
            let chunk = port.download_chunk(lease, &descriptor.digest, expected_offset, now_ms)?;
            if chunk.digest != descriptor.digest
                || chunk.offset != expected_offset
                || chunk.bytes.is_empty()
                || chunk.bytes.len() > REMOTE_CAS_CHUNK_BYTES
                || digest(&chunk.bytes) != chunk.chunk_digest
                || expected_offset + chunk.bytes.len() as u64 > descriptor.byte_size
            {
                return Err(RemoteCasClientError::CorruptTransfer);
            }
            partial.extend_from_slice(&chunk.bytes);
        }
        if partial.len() as u64 != descriptor.byte_size || digest(partial) != descriptor.digest {
            return Err(RemoteCasClientError::CorruptTransfer);
        }
        let bytes = self
            .partial_downloads
            .remove(&descriptor.digest)
            .ok_or(RemoteCasClientError::Truncated)?;
        let commit = store.commit(ArtifactCommitRequest {
            bytes,
            media_type: Some(descriptor.media_type.clone()),
            execution_id: Some(lease.execution_id.clone()),
            revision,
            inputs,
            environment_digest,
        })?;
        Ok(RemoteDownloadReport {
            handle: commit.handle,
            received_bytes: descriptor.byte_size,
            resumed_from,
        })
    }

    pub fn partial_cursor(&self, digest: &ArtifactDigest) -> Option<u64> {
        self.partial_downloads
            .get(digest)
            .map(|bytes| bytes.len() as u64)
    }
}

fn digest(bytes: &[u8]) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("sha256 digest")
}

pub fn remote_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "missing_digest_upload",
            "chunk_resume",
            "end_to_end_digest",
            "local_cas_commit",
        ],
        &[
            "whole_project_sync",
            "remote_blob_enumeration",
            "unverified_output_commit",
            "mutable_path_identity",
        ],
    )
}
