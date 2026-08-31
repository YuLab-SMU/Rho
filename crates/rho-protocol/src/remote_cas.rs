use serde::{Deserialize, Serialize};

use crate::{ArtifactDigest, ExecutionId};

pub const REMOTE_CAS_PROTOCOL_VERSION: u16 = 1;
pub const REMOTE_CAS_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_REMOTE_CAS_BLOBS: usize = 256;
pub const MAX_REMOTE_CAS_BLOB_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    UploadInput,
    DownloadOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteBlobDescriptor {
    pub digest: ArtifactDigest,
    pub byte_size: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteCasManifest {
    pub protocol_version: u16,
    pub job_id: String,
    pub execution_id: ExecutionId,
    pub direction: TransferDirection,
    pub blobs: Vec<RemoteBlobDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteCasLease {
    pub lease_id: String,
    pub job_id: String,
    pub execution_id: ExecutionId,
    pub direction: TransferDirection,
    pub allowed_digests: Vec<ArtifactDigest>,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteCasChunk {
    pub digest: ArtifactDigest,
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub chunk_digest: ArtifactDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteCasResumeCursor {
    pub digest: ArtifactDigest,
    pub next_offset: u64,
}
