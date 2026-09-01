use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use rho_protocol::{
    ArtifactDigest, ExecutionSpec, MAX_REMOTE_CAS_BLOB_BYTES, MAX_REMOTE_CAS_BLOBS,
    REMOTE_CAS_CHUNK_BYTES, REMOTE_CAS_PROTOCOL_VERSION, RemoteBlobDescriptor, RemoteCasChunk,
    RemoteCasLease, RemoteCasManifest, RemoteCasResumeCursor, RunnerStagingManifestV1,
    TransferDirection,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCasQuota {
    pub max_concurrent_transfers: usize,
    pub max_storage_bytes: u64,
    pub max_bandwidth_bytes: u64,
}

impl Default for RemoteCasQuota {
    fn default() -> Self {
        Self {
            max_concurrent_transfers: 4,
            max_storage_bytes: 4 * 1024 * 1024 * 1024,
            max_bandwidth_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCasNegotiation {
    pub missing: Vec<RemoteCasResumeCursor>,
    pub already_present: Vec<ArtifactDigest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkWriteOutcome {
    Advanced(RemoteCasResumeCursor),
    Duplicate(RemoteCasResumeCursor),
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RemoteCasError {
    #[error("remote CAS manifest is invalid")]
    InvalidManifest,
    #[error("remote CAS lease is invalid, expired, wrong direction/job, or overbroad")]
    InvalidLease,
    #[error("remote CAS quota exceeded")]
    QuotaExceeded,
    #[error("remote CAS chunk is corrupt")]
    CorruptChunk,
    #[error("remote CAS chunk is reordered or conflicts with resume cursor")]
    ReorderedChunk,
    #[error("remote CAS transfer is truncated")]
    Truncated,
    #[error("remote CAS final digest is corrupt")]
    CorruptBlob,
    #[error("remote CAS blob is unavailable or not authorized")]
    BlobUnavailable,
    #[error("remote CAS IO failed")]
    Io,
}

#[derive(Debug, Clone)]
struct ActiveTransfer {
    descriptor: RemoteBlobDescriptor,
    temp_path: PathBuf,
}

pub struct RemoteCasServer {
    root: PathBuf,
    quota: RemoteCasQuota,
    active: BTreeMap<(String, ArtifactDigest), ActiveTransfer>,
    transferred_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerStagingOutcome {
    Created,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerStagedExecution {
    pub root: PathBuf,
    pub manifest_digest: ArtifactDigest,
    pub outcome: RunnerStagingOutcome,
}

#[derive(Debug, Error)]
pub enum RunnerStagingError {
    #[error("Runner staging manifest does not match the ExecutionSpec")]
    Manifest,
    #[error("Runner staging lease is invalid or overbroad")]
    Lease,
    #[error("Runner staging CAS blob is unavailable or corrupt")]
    Blob,
    #[error("Runner staging directory conflicts with another immutable execution")]
    Conflict,
    #[error("Runner staging IO failed")]
    Io,
}

pub struct RunnerInputStager {
    root: PathBuf,
}

impl RunnerInputStager {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, RunnerStagingError> {
        fs::create_dir_all(root.as_ref()).map_err(|_| RunnerStagingError::Io)?;
        let root = root
            .as_ref()
            .canonicalize()
            .map_err(|_| RunnerStagingError::Io)?;
        Ok(Self { root })
    }

    pub fn stage(
        &self,
        spec: &ExecutionSpec,
        manifest: &RunnerStagingManifestV1,
        lease: &RemoteCasLease,
        now_ms: u64,
        cas: &RemoteCasServer,
    ) -> Result<RunnerStagedExecution, RunnerStagingError> {
        manifest
            .validate_against(spec, &BTreeSet::new())
            .map_err(|_| RunnerStagingError::Manifest)?;
        let required_digests = manifest
            .input_blobs
            .iter()
            .map(|blob| blob.digest.clone())
            .chain(std::iter::once(manifest.environment_blob.digest.clone()))
            .collect::<BTreeSet<_>>();
        let leased_digests = lease
            .allowed_digests
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        if lease.execution_id != spec.execution_id
            || lease.direction != TransferDirection::UploadInput
            || now_ms > lease.expires_at_ms
            || required_digests != leased_digests
            || required_digests.len() != lease.allowed_digests.len()
        {
            return Err(RunnerStagingError::Lease);
        }
        let manifest_bytes =
            serde_json::to_vec(manifest).map_err(|_| RunnerStagingError::Manifest)?;
        let manifest_digest = manifest
            .digest()
            .map_err(|_| RunnerStagingError::Manifest)?;
        let final_root = self.root.join(spec.execution_id.as_str());
        if final_root.exists() {
            let existing = fs::read(final_root.join("staging-manifest.json"))
                .map_err(|_| RunnerStagingError::Conflict)?;
            return if existing == manifest_bytes {
                Ok(RunnerStagedExecution {
                    root: final_root,
                    manifest_digest,
                    outcome: RunnerStagingOutcome::Existing,
                })
            } else {
                Err(RunnerStagingError::Conflict)
            };
        }
        let temporary_root = self
            .root
            .join(format!(".{}.partial", spec.execution_id.as_str()));
        if temporary_root.exists() {
            fs::remove_dir_all(&temporary_root).map_err(|_| RunnerStagingError::Io)?;
        }
        fs::create_dir_all(temporary_root.join("inputs")).map_err(|_| RunnerStagingError::Io)?;
        fs::create_dir_all(temporary_root.join("environment"))
            .map_err(|_| RunnerStagingError::Io)?;
        for blob in &manifest.input_blobs {
            stage_verified_blob(
                cas,
                lease,
                blob,
                now_ms,
                &temporary_root
                    .join("inputs")
                    .join(digest_filename(&blob.digest)),
            )?;
        }
        stage_verified_blob(
            cas,
            lease,
            &manifest.environment_blob,
            now_ms,
            &temporary_root
                .join("environment")
                .join(digest_filename(&manifest.environment_blob.digest)),
        )?;
        let manifest_path = temporary_root.join("staging-manifest.json");
        {
            let mut file = File::create(&manifest_path).map_err(|_| RunnerStagingError::Io)?;
            file.write_all(&manifest_bytes)
                .map_err(|_| RunnerStagingError::Io)?;
            file.sync_all().map_err(|_| RunnerStagingError::Io)?;
        }
        let mut permissions = fs::metadata(&manifest_path)
            .map_err(|_| RunnerStagingError::Io)?
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&manifest_path, permissions).map_err(|_| RunnerStagingError::Io)?;
        File::open(&temporary_root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| RunnerStagingError::Io)?;
        fs::rename(&temporary_root, &final_root).map_err(|_| RunnerStagingError::Io)?;
        File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| RunnerStagingError::Io)?;
        Ok(RunnerStagedExecution {
            root: final_root,
            manifest_digest,
            outcome: RunnerStagingOutcome::Created,
        })
    }
}

fn stage_verified_blob(
    cas: &RemoteCasServer,
    lease: &RemoteCasLease,
    descriptor: &RemoteBlobDescriptor,
    now_ms: u64,
    destination: &Path,
) -> Result<(), RunnerStagingError> {
    let source = cas
        .verified_blob_path(lease, descriptor, now_ms)
        .map_err(|_| RunnerStagingError::Blob)?;
    fs::copy(source, destination).map_err(|_| RunnerStagingError::Io)?;
    if !verify_file(destination, descriptor).map_err(|_| RunnerStagingError::Blob)? {
        return Err(RunnerStagingError::Blob);
    }
    let mut permissions = fs::metadata(destination)
        .map_err(|_| RunnerStagingError::Io)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(destination, permissions).map_err(|_| RunnerStagingError::Io)
}

fn digest_filename(digest: &ArtifactDigest) -> &str {
    digest.as_str().trim_start_matches("sha256:")
}

impl RemoteCasServer {
    pub fn open(root: impl AsRef<Path>, quota: RemoteCasQuota) -> Result<Self, RemoteCasError> {
        fs::create_dir_all(root.as_ref()).map_err(|_| RemoteCasError::Io)?;
        let root = root
            .as_ref()
            .canonicalize()
            .map_err(|_| RemoteCasError::Io)?;
        fs::create_dir_all(root.join("blobs")).map_err(|_| RemoteCasError::Io)?;
        fs::create_dir_all(root.join("partial")).map_err(|_| RemoteCasError::Io)?;
        Ok(Self {
            root,
            quota,
            active: BTreeMap::new(),
            transferred_bytes: 0,
        })
    }

    pub fn negotiate(
        &mut self,
        manifest: &RemoteCasManifest,
        lease: &RemoteCasLease,
        now_ms: u64,
    ) -> Result<RemoteCasNegotiation, RemoteCasError> {
        validate_manifest_lease(manifest, lease, now_ms)?;
        if self.active.len() >= self.quota.max_concurrent_transfers {
            return Err(RemoteCasError::QuotaExceeded);
        }
        let mut missing = Vec::new();
        let mut already_present = Vec::new();
        for descriptor in &manifest.blobs {
            let final_path = self.blob_path(&descriptor.digest);
            if final_path.exists() && verify_file(&final_path, descriptor)? {
                already_present.push(descriptor.digest.clone());
                continue;
            }
            let temp_path = self.partial_path(&manifest.job_id, &descriptor.digest);
            let next_offset = fs::metadata(&temp_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            if next_offset > descriptor.byte_size {
                fs::remove_file(&temp_path).map_err(|_| RemoteCasError::Io)?;
                return Err(RemoteCasError::CorruptBlob);
            }
            self.active.insert(
                (manifest.job_id.clone(), descriptor.digest.clone()),
                ActiveTransfer {
                    descriptor: descriptor.clone(),
                    temp_path,
                },
            );
            missing.push(RemoteCasResumeCursor {
                digest: descriptor.digest.clone(),
                next_offset,
            });
        }
        Ok(RemoteCasNegotiation {
            missing,
            already_present,
        })
    }

    pub fn write_chunk(
        &mut self,
        lease: &RemoteCasLease,
        chunk: &RemoteCasChunk,
        now_ms: u64,
    ) -> Result<ChunkWriteOutcome, RemoteCasError> {
        validate_lease_for_digest(lease, &chunk.digest, TransferDirection::UploadInput, now_ms)?;
        if chunk.bytes.is_empty() || chunk.bytes.len() > REMOTE_CAS_CHUNK_BYTES {
            return Err(RemoteCasError::CorruptChunk);
        }
        if digest(&chunk.bytes) != chunk.chunk_digest {
            return Err(RemoteCasError::CorruptChunk);
        }
        let transfer = self
            .active
            .get(&(lease.job_id.clone(), chunk.digest.clone()))
            .ok_or(RemoteCasError::InvalidLease)?;
        let current = fs::metadata(&transfer.temp_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if chunk.offset < current {
            let mut file = File::open(&transfer.temp_path).map_err(|_| RemoteCasError::Io)?;
            file.seek(SeekFrom::Start(chunk.offset))
                .map_err(|_| RemoteCasError::Io)?;
            let mut existing = vec![0; chunk.bytes.len()];
            file.read_exact(&mut existing)
                .map_err(|_| RemoteCasError::ReorderedChunk)?;
            if existing == chunk.bytes {
                return Ok(ChunkWriteOutcome::Duplicate(RemoteCasResumeCursor {
                    digest: chunk.digest.clone(),
                    next_offset: current,
                }));
            }
            return Err(RemoteCasError::ReorderedChunk);
        }
        if chunk.offset != current
            || current.saturating_add(chunk.bytes.len() as u64) > transfer.descriptor.byte_size
        {
            return Err(RemoteCasError::ReorderedChunk);
        }
        if self
            .transferred_bytes
            .saturating_add(chunk.bytes.len() as u64)
            > self.quota.max_bandwidth_bytes
            || directory_bytes(&self.root).saturating_add(chunk.bytes.len() as u64)
                > self.quota.max_storage_bytes
        {
            return Err(RemoteCasError::QuotaExceeded);
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&transfer.temp_path)
            .map_err(|_| RemoteCasError::Io)?;
        file.write_all(&chunk.bytes)
            .map_err(|_| RemoteCasError::Io)?;
        file.sync_data().map_err(|_| RemoteCasError::Io)?;
        self.transferred_bytes += chunk.bytes.len() as u64;
        Ok(ChunkWriteOutcome::Advanced(RemoteCasResumeCursor {
            digest: chunk.digest.clone(),
            next_offset: current + chunk.bytes.len() as u64,
        }))
    }

    pub fn finalize_upload(
        &mut self,
        lease: &RemoteCasLease,
        digest_value: &ArtifactDigest,
        now_ms: u64,
    ) -> Result<PathBuf, RemoteCasError> {
        validate_lease_for_digest(lease, digest_value, TransferDirection::UploadInput, now_ms)?;
        let transfer = self
            .active
            .remove(&(lease.job_id.clone(), digest_value.clone()))
            .ok_or(RemoteCasError::InvalidLease)?;
        let size = fs::metadata(&transfer.temp_path)
            .map_err(|_| RemoteCasError::Truncated)?
            .len();
        if size != transfer.descriptor.byte_size {
            self.active
                .insert((lease.job_id.clone(), digest_value.clone()), transfer);
            return Err(RemoteCasError::Truncated);
        }
        if !verify_file(&transfer.temp_path, &transfer.descriptor)? {
            return Err(RemoteCasError::CorruptBlob);
        }
        let final_path = self.blob_path(digest_value);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(|_| RemoteCasError::Io)?;
        }
        if final_path.exists() {
            fs::remove_file(&transfer.temp_path).map_err(|_| RemoteCasError::Io)?;
        } else {
            fs::rename(&transfer.temp_path, &final_path).map_err(|_| RemoteCasError::Io)?;
            File::open(final_path.parent().unwrap_or(&self.root))
                .and_then(|directory| directory.sync_all())
                .map_err(|_| RemoteCasError::Io)?;
        }
        Ok(final_path)
    }

    pub fn read_chunk(
        &self,
        lease: &RemoteCasLease,
        digest_value: &ArtifactDigest,
        offset: u64,
        now_ms: u64,
    ) -> Result<RemoteCasChunk, RemoteCasError> {
        validate_lease_for_digest(
            lease,
            digest_value,
            TransferDirection::DownloadOutput,
            now_ms,
        )?;
        let path = self.blob_path(digest_value);
        let mut file = File::open(path).map_err(|_| RemoteCasError::BlobUnavailable)?;
        let size = file.metadata().map_err(|_| RemoteCasError::Io)?.len();
        if offset >= size {
            return Err(RemoteCasError::Truncated);
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| RemoteCasError::Io)?;
        let mut bytes = vec![0; REMOTE_CAS_CHUNK_BYTES.min((size - offset) as usize)];
        file.read_exact(&mut bytes)
            .map_err(|_| RemoteCasError::Io)?;
        Ok(RemoteCasChunk {
            digest: digest_value.clone(),
            offset,
            chunk_digest: digest(&bytes),
            bytes,
        })
    }

    pub fn verified_blob_path(
        &self,
        lease: &RemoteCasLease,
        descriptor: &RemoteBlobDescriptor,
        now_ms: u64,
    ) -> Result<PathBuf, RemoteCasError> {
        validate_lease_for_digest(
            lease,
            &descriptor.digest,
            TransferDirection::UploadInput,
            now_ms,
        )?;
        let path = self.blob_path(&descriptor.digest);
        if !path.exists() || !verify_file(&path, descriptor)? {
            return Err(RemoteCasError::BlobUnavailable);
        }
        Ok(path)
    }

    pub fn cleanup_partial(&mut self, job_id: &str) -> Result<usize, RemoteCasError> {
        let keys = self
            .active
            .keys()
            .filter(|(job, _)| job == job_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut removed = 0;
        for key in keys {
            if let Some(transfer) = self.active.remove(&key) {
                if transfer.temp_path.exists() {
                    fs::remove_file(transfer.temp_path).map_err(|_| RemoteCasError::Io)?;
                }
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn blob_path(&self, digest: &ArtifactDigest) -> PathBuf {
        let hex = digest.as_str().trim_start_matches("sha256:");
        self.root.join("blobs").join(&hex[..2]).join(hex)
    }

    fn partial_path(&self, job_id: &str, digest: &ArtifactDigest) -> PathBuf {
        let safe_job = job_id
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .collect::<String>();
        self.root.join("partial").join(format!(
            "{}_{}",
            safe_job,
            digest.as_str().trim_start_matches("sha256:")
        ))
    }
}

fn validate_manifest_lease(
    manifest: &RemoteCasManifest,
    lease: &RemoteCasLease,
    now_ms: u64,
) -> Result<(), RemoteCasError> {
    if manifest.protocol_version != REMOTE_CAS_PROTOCOL_VERSION
        || manifest.blobs.is_empty()
        || manifest.blobs.len() > MAX_REMOTE_CAS_BLOBS
        || manifest.job_id.is_empty()
        || manifest.job_id != lease.job_id
        || manifest.execution_id != lease.execution_id
        || manifest.direction != lease.direction
        || now_ms > lease.expires_at_ms
    {
        return Err(RemoteCasError::InvalidManifest);
    }
    let manifest_digests = manifest
        .blobs
        .iter()
        .map(|blob| blob.digest.clone())
        .collect::<BTreeSet<_>>();
    let lease_digests = lease
        .allowed_digests
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if manifest_digests != lease_digests
        || manifest_digests.len() != manifest.blobs.len()
        || manifest
            .blobs
            .iter()
            .any(|blob| blob.byte_size > MAX_REMOTE_CAS_BLOB_BYTES)
    {
        return Err(RemoteCasError::InvalidLease);
    }
    Ok(())
}

fn validate_lease_for_digest(
    lease: &RemoteCasLease,
    digest: &ArtifactDigest,
    direction: TransferDirection,
    now_ms: u64,
) -> Result<(), RemoteCasError> {
    if lease.direction != direction
        || now_ms > lease.expires_at_ms
        || !lease.allowed_digests.contains(digest)
        || lease.job_id.is_empty()
    {
        return Err(RemoteCasError::InvalidLease);
    }
    Ok(())
}

fn verify_file(path: &Path, descriptor: &RemoteBlobDescriptor) -> Result<bool, RemoteCasError> {
    let bytes = fs::read(path).map_err(|_| RemoteCasError::Io)?;
    Ok(bytes.len() as u64 == descriptor.byte_size && digest(&bytes) == descriptor.digest)
}

pub fn digest(bytes: &[u8]) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("sha256 digest")
}

fn directory_bytes(root: &Path) -> u64 {
    fn visit(path: &Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                visit(&entry.path(), total);
            } else if metadata.is_file() {
                *total = total.saturating_add(metadata.len());
            }
        }
    }
    let mut total = 0;
    visit(root, &mut total);
    total
}

pub fn artifacts_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "missing_digest_negotiation",
            "chunk_checksum",
            "resume_cursor",
            "atomic_remote_cas",
            "transfer_lease",
        ],
        &[
            "blob_enumeration",
            "mutable_project_sync",
            "unverified_bytes_use",
            "unbounded_transfer",
        ],
    )
}
