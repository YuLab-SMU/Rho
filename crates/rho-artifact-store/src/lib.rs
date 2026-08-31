#![forbid(unsafe_code)]
//! Content-addressed artifact and output store.
//!
//! The store owns bytes, previews, tombstones, and reclaim policy. UI and
//! semantic events receive digest-addressed handles, never raw filesystem paths.

pub mod collection;
pub mod remote;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

use rho_protocol::{
    ArtifactDigest, ArtifactEdge, ArtifactEdgeKind, ArtifactId, ArtifactManifest, ArtifactProducer,
    ArtifactRef, ExecutionId, RevisionStamp, SemanticEventPayload,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const DEFAULT_MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
pub const DEFAULT_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_PREVIEW_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactStoreBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> ArtifactStoreBoundary {
    ArtifactStoreBoundary {
        owns: &[
            "content_addressed_blobs",
            "artifact_manifest",
            "provenance_edges",
            "orphan_and_corrupt_reconciliation",
        ],
        does_not_own: &[
            "workspace_execution",
            "broker_authority",
            "ui_identity_paths",
            "provider_runtime",
        ],
    }
}

#[derive(Debug, Error)]
pub enum ArtifactStoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("path escapes project artifact store")]
    PathEscapesProject,
    #[error("artifact is too large: {actual} > {limit}")]
    ArtifactTooLarge { actual: u64, limit: u64 },
    #[error("project artifact quota exceeded: {actual} > {limit}")]
    TotalQuotaExceeded { actual: u64, limit: u64 },
    #[error("digest error: {0}")]
    Digest(#[from] rho_protocol::DigestError),
    #[error("artifact {0} is missing")]
    MissingArtifact(ArtifactDigest),
    #[error("artifact {0} is tombstoned")]
    Tombstoned(ArtifactDigest),
    #[error("fault injected at {0:?}")]
    FaultInjected(ArtifactFaultPoint),
    #[error("manifest validation failed: {0}")]
    InvalidManifest(String),
    #[error("lineage error: {0}")]
    Lineage(#[from] LineageError),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactStoreConfig {
    pub max_artifact_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for ArtifactStoreConfig {
    fn default() -> Self {
        Self {
            max_artifact_bytes: DEFAULT_MAX_ARTIFACT_BYTES,
            max_total_bytes: DEFAULT_MAX_TOTAL_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactPreview {
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactHandle {
    pub artifact_id: ArtifactId,
    pub digest: ArtifactDigest,
    pub byte_size: u64,
    pub media_type: String,
    pub preview: ArtifactPreview,
    pub broker_handle_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TombstoneRecord {
    pub digest: ArtifactDigest,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReclaimReport {
    pub removed: Vec<ArtifactDigest>,
    pub retained_live: Vec<ArtifactDigest>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactFaultPoint {
    BeforeWrite,
    AfterTempWrite,
    AfterFsync,
    AfterHash,
    AfterRename,
    BeforeMetadataCommit,
    AfterMetadataCommit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactCommitRequest {
    pub bytes: Vec<u8>,
    pub media_type: Option<String>,
    pub execution_id: Option<ExecutionId>,
    pub revision: RevisionStamp,
    #[serde(default)]
    pub inputs: Vec<ArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_digest: Option<ArtifactDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactCommit {
    pub handle: ArtifactHandle,
    pub manifest: ArtifactManifest,
    pub deduped_existing_blob: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ArtifactScanReport {
    pub orphan_blobs: Vec<ArtifactDigest>,
    pub partial_temp_files: Vec<String>,
    pub corrupt_blobs: Vec<ArtifactDigest>,
    pub corrupt_manifests: Vec<ArtifactId>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactHealthClass {
    Healthy,
    ReclaimOrphans,
    MissingBlob,
    BlockedCorrupt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactHealthReport {
    pub class: ArtifactHealthClass,
    pub reason_code: String,
    pub safe_action: String,
    pub scan: ArtifactScanReport,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LineageError {
    #[error("artifact edge cannot point to itself")]
    SelfEdge,
    #[error("unknown artifact relation {0}")]
    UnknownRelation(String),
    #[error("artifact edge references an unknown artifact")]
    UnknownArtifact,
    #[error("artifact edge would introduce a cycle")]
    Cycle,
}

#[derive(Debug, Clone)]
pub struct ArtifactStore {
    project_root: PathBuf,
    cas_root: PathBuf,
    manifest_root: PathBuf,
    config: ArtifactStoreConfig,
    handles: BTreeMap<ArtifactDigest, ArtifactHandle>,
    manifests: BTreeMap<ArtifactId, ArtifactManifest>,
    lineage_edges: Vec<ArtifactEdge>,
    live: BTreeSet<ArtifactDigest>,
    tombstones: BTreeMap<ArtifactDigest, TombstoneRecord>,
    metadata_corrupt: Vec<String>,
}

impl ArtifactStore {
    pub fn open(
        project_root: impl AsRef<Path>,
        config: ArtifactStoreConfig,
    ) -> Result<Self, ArtifactStoreError> {
        let project_root = canonical_existing(project_root.as_ref())?;
        let artifact_root = project_root.join(".rho").join("artifacts");
        let cas_root = artifact_root.join("cas");
        let manifest_root = artifact_root.join("manifests");
        fs::create_dir_all(&cas_root)?;
        fs::create_dir_all(&manifest_root)?;
        let cas_root = canonical_existing(&cas_root)?;
        let manifest_root = canonical_existing(&manifest_root)?;
        ensure_contained(&project_root, &cas_root)?;
        ensure_contained(&project_root, &manifest_root)?;
        let (manifests, handles, live, metadata_corrupt) =
            load_persisted_manifests(&cas_root, &manifest_root)?;
        Ok(Self {
            project_root,
            cas_root,
            manifest_root,
            config,
            handles,
            manifests,
            lineage_edges: Vec::new(),
            live,
            tombstones: BTreeMap::new(),
            metadata_corrupt,
        })
    }

    pub fn put_bytes(&mut self, bytes: &[u8]) -> Result<ArtifactHandle, ArtifactStoreError> {
        let size = bytes.len() as u64;
        if size > self.config.max_artifact_bytes {
            return Err(ArtifactStoreError::ArtifactTooLarge {
                actual: size,
                limit: self.config.max_artifact_bytes,
            });
        }
        let projected_total = self.total_bytes()? + size;
        if projected_total > self.config.max_total_bytes {
            return Err(ArtifactStoreError::TotalQuotaExceeded {
                actual: projected_total,
                limit: self.config.max_total_bytes,
            });
        }
        let digest = digest_bytes(bytes)?;
        if self.tombstones.contains_key(&digest) {
            return Err(ArtifactStoreError::Tombstoned(digest));
        }
        let path = self.path_for_digest(&digest);
        if !path.exists() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, bytes)?;
        }
        let media_type = sniff_media_type(bytes).to_string();
        let handle = ArtifactHandle {
            artifact_id: ArtifactId::new(format!("artifact_{}", &digest.as_str()[7..19])).unwrap(),
            digest: digest.clone(),
            byte_size: size,
            media_type: media_type.clone(),
            preview: preview_for(bytes, &media_type),
            broker_handle_id: format!("artifact-handle:{}", digest.as_str()),
        };
        self.live.insert(digest.clone());
        self.handles.insert(digest, handle.clone());
        Ok(handle)
    }

    pub fn commit(
        &mut self,
        request: ArtifactCommitRequest,
    ) -> Result<ArtifactCommit, ArtifactStoreError> {
        self.commit_with_fault(request, None)
    }

    pub fn commit_with_fault(
        &mut self,
        request: ArtifactCommitRequest,
        fault: Option<ArtifactFaultPoint>,
    ) -> Result<ArtifactCommit, ArtifactStoreError> {
        inject_fault(fault, ArtifactFaultPoint::BeforeWrite)?;
        let size = request.bytes.len() as u64;
        if size > self.config.max_artifact_bytes {
            return Err(ArtifactStoreError::ArtifactTooLarge {
                actual: size,
                limit: self.config.max_artifact_bytes,
            });
        }
        let (digest, deduped_existing_blob) =
            self.write_blob_transactionally(&request.bytes, fault)?;
        let media_type = request
            .media_type
            .clone()
            .unwrap_or_else(|| sniff_media_type(&request.bytes).to_string());
        validate_artifact_manifest_input(&request.bytes, &digest, &media_type)?;
        inject_fault(fault, ArtifactFaultPoint::BeforeMetadataCommit)?;
        let artifact_id = ArtifactId::generate();
        let mut manifest = ArtifactManifest::new(
            artifact_id.clone(),
            digest.clone(),
            size,
            media_type.clone(),
            ArtifactProducer {
                run_id: None,
                execution_id: request.execution_id,
                job_id: None,
            },
            request.revision,
        );
        manifest.inputs = request.inputs;
        manifest.environment_digest = request.environment_digest;
        let handle = ArtifactHandle {
            artifact_id: artifact_id.clone(),
            digest: digest.clone(),
            byte_size: size,
            media_type: media_type.clone(),
            preview: preview_for(&request.bytes, &media_type),
            broker_handle_id: format!("artifact-handle:{}:{}", artifact_id, digest.as_str()),
        };
        self.persist_manifest(&manifest)?;
        self.manifests.insert(artifact_id, manifest.clone());
        self.handles.insert(digest.clone(), handle.clone());
        self.live.insert(digest);
        inject_fault(fault, ArtifactFaultPoint::AfterMetadataCommit)?;
        Ok(ArtifactCommit {
            handle,
            manifest,
            deduped_existing_blob,
        })
    }

    pub fn manifest(&self, artifact_id: &ArtifactId) -> Option<&ArtifactManifest> {
        self.manifests.get(artifact_id)
    }

    pub fn manifest_count(&self) -> usize {
        self.manifests.len()
    }

    pub fn scan_reconcile(&self) -> Result<ArtifactScanReport, ArtifactStoreError> {
        let mut root_entries = fs::read_dir(&self.cas_root)?.collect::<Result<Vec<_>, _>>()?;
        root_entries.sort_by_key(|entry| entry.file_name());
        let manifest_digests = self
            .manifests
            .values()
            .map(|manifest| manifest.digest.clone())
            .collect::<BTreeSet<_>>();
        let mut report = ArtifactScanReport {
            partial_temp_files: root_entries
                .into_iter()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .chars()
                        .take(128)
                        .collect()
                })
                .collect(),
            ..ArtifactScanReport::default()
        };
        for digest in self.cas_digests()? {
            let path = self.path_for_digest(&digest);
            let bytes = fs::read(&path)?;
            if digest_bytes(&bytes)? != digest {
                report.corrupt_blobs.push(digest.clone());
            }
            if !manifest_digests.contains(&digest) {
                report.orphan_blobs.push(digest);
            }
        }
        for (artifact_id, manifest) in &self.manifests {
            let path = self.path_for_digest(&manifest.digest);
            if !path.exists() || report.corrupt_blobs.contains(&manifest.digest) {
                report.corrupt_manifests.push(artifact_id.clone());
            }
        }
        Ok(report)
    }

    pub fn verify_health(&self) -> Result<ArtifactHealthReport, ArtifactStoreError> {
        let scan = self.scan_reconcile()?;
        let (class, reason_code, safe_action) = if !self.metadata_corrupt.is_empty() {
            (
                ArtifactHealthClass::BlockedCorrupt,
                "artifact_manifest_metadata_corrupt",
                "block affected metadata; preserve files for operator recovery",
            )
        } else if !scan.corrupt_blobs.is_empty() {
            (
                ArtifactHealthClass::BlockedCorrupt,
                "cas_digest_corruption",
                "block affected artifacts; retain bytes for operator recovery",
            )
        } else if !scan.corrupt_manifests.is_empty() {
            (
                ArtifactHealthClass::MissingBlob,
                "manifest_blob_missing",
                "mark artifact unavailable and reconcile producer execution",
            )
        } else if !scan.orphan_blobs.is_empty() || !scan.partial_temp_files.is_empty() {
            (
                ArtifactHealthClass::ReclaimOrphans,
                "orphan_blob_reclaimable",
                "bounded garbage collection may reclaim unreferenced blobs",
            )
        } else {
            (
                ArtifactHealthClass::Healthy,
                "artifact_store_verified",
                "continue",
            )
        };
        Ok(ArtifactHealthReport {
            class,
            reason_code: reason_code.to_string(),
            safe_action: safe_action.to_string(),
            scan,
        })
    }

    pub fn garbage_collect_orphans(
        &mut self,
        max_remove: usize,
    ) -> Result<ReclaimReport, ArtifactStoreError> {
        let report = self.scan_reconcile()?;
        let mut removed = Vec::new();
        for digest in report.orphan_blobs.into_iter().take(max_remove) {
            let path = self.path_for_digest(&digest);
            if path.exists() {
                fs::remove_file(path)?;
            }
            removed.push(digest);
        }
        let remaining = max_remove.saturating_sub(removed.len());
        for name in report.partial_temp_files.into_iter().take(remaining) {
            let path = self.cas_root.join(name);
            if path.parent() == Some(self.cas_root.as_path()) && path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(ReclaimReport {
            removed,
            retained_live: self.live.iter().cloned().collect(),
        })
    }

    pub fn remove_blob_for_test(&self, digest: &ArtifactDigest) -> Result<(), ArtifactStoreError> {
        let path = self.path_for_digest(digest);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    pub fn add_lineage_edge_by_relation(
        &mut self,
        from: ArtifactId,
        to: ArtifactId,
        relation: &str,
    ) -> Result<(), ArtifactStoreError> {
        let kind = match relation {
            "used" => ArtifactEdgeKind::Used,
            "generated_by" => ArtifactEdgeKind::GeneratedBy,
            "derived_from" => ArtifactEdgeKind::DerivedFrom,
            "rendered_from" => ArtifactEdgeKind::RenderedFrom,
            "supersedes" => ArtifactEdgeKind::Supersedes,
            other => return Err(LineageError::UnknownRelation(other.to_string()).into()),
        };
        self.add_lineage_edge(from, to, kind)
    }

    pub fn add_lineage_edge(
        &mut self,
        from: ArtifactId,
        to: ArtifactId,
        kind: ArtifactEdgeKind,
    ) -> Result<(), ArtifactStoreError> {
        if from == to {
            return Err(LineageError::SelfEdge.into());
        }
        if !self.manifests.contains_key(&from) || !self.manifests.contains_key(&to) {
            return Err(LineageError::UnknownArtifact.into());
        }
        if self.reaches(&to, &from) {
            return Err(LineageError::Cycle.into());
        }
        self.lineage_edges.push(ArtifactEdge { from, to, kind });
        Ok(())
    }

    pub fn lineage_edges(&self) -> &[ArtifactEdge] {
        &self.lineage_edges
    }

    pub fn ingest_project_file(
        &mut self,
        path: impl AsRef<Path>,
    ) -> Result<ArtifactHandle, ArtifactStoreError> {
        let path = canonical_existing(path.as_ref())?;
        ensure_contained(&self.project_root, &path)?;
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(ArtifactStoreError::PathEscapesProject);
        }
        let bytes = fs::read(path)?;
        self.put_bytes(&bytes)
    }

    pub fn read_by_handle(&self, handle: &ArtifactHandle) -> Result<Vec<u8>, ArtifactStoreError> {
        if self.tombstones.contains_key(&handle.digest) {
            return Err(ArtifactStoreError::Tombstoned(handle.digest.clone()));
        }
        let path = self.path_for_digest(&handle.digest);
        if !path.exists() {
            return Err(ArtifactStoreError::MissingArtifact(handle.digest.clone()));
        }
        Ok(fs::read(path)?)
    }

    pub fn tombstone(
        &mut self,
        digest: &ArtifactDigest,
        reason: impl Into<String>,
    ) -> TombstoneRecord {
        self.live.remove(digest);
        let record = TombstoneRecord {
            digest: digest.clone(),
            reason: reason.into(),
        };
        self.tombstones.insert(digest.clone(), record.clone());
        record
    }

    pub fn reclaim(&mut self) -> Result<ReclaimReport, ArtifactStoreError> {
        let mut removed = Vec::new();
        for digest in self.tombstones.keys().cloned().collect::<Vec<_>>() {
            let path = self.path_for_digest(&digest);
            if path.exists() {
                fs::remove_file(path)?;
            }
            removed.push(digest);
        }
        let retained_live = self.live.iter().cloned().collect();
        Ok(ReclaimReport {
            removed,
            retained_live,
        })
    }

    pub fn semantic_artifact_event(
        &self,
        handle: &ArtifactHandle,
        revision: RevisionStamp,
    ) -> SemanticEventPayload {
        SemanticEventPayload::ArtifactCommitted {
            artifact_id: handle.artifact_id.clone(),
            digest: handle.digest.clone(),
            revision,
        }
    }

    pub fn contains_path_for_test(&self, path: impl AsRef<Path>) -> bool {
        canonical_existing(path.as_ref())
            .and_then(|path| ensure_contained(&self.project_root, &path).map(|_| path))
            .is_ok()
    }

    fn persist_manifest(&self, manifest: &ArtifactManifest) -> Result<(), ArtifactStoreError> {
        let path = self
            .manifest_root
            .join(format!("{}.json", manifest.artifact_id.as_str()));
        let temp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(manifest)
            .map_err(|error| ArtifactStoreError::InvalidManifest(error.to_string()))?;
        {
            let mut file = File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temp, &path)?;
        File::open(&self.manifest_root)?.sync_all()?;
        Ok(())
    }

    fn write_blob_transactionally(
        &self,
        bytes: &[u8],
        fault: Option<ArtifactFaultPoint>,
    ) -> Result<(ArtifactDigest, bool), ArtifactStoreError> {
        let size = bytes.len() as u64;
        let temp_path = self
            .cas_root
            .join(format!(".tmp-{}", ArtifactId::generate()));
        {
            let mut file = File::create(&temp_path)?;
            file.write_all(bytes)?;
            inject_fault(fault, ArtifactFaultPoint::AfterTempWrite)?;
            file.sync_all()?;
        }
        inject_fault(fault, ArtifactFaultPoint::AfterFsync)?;
        let digest = digest_bytes(bytes)?;
        inject_fault(fault, ArtifactFaultPoint::AfterHash)?;
        let final_path = self.path_for_digest(&digest);
        let deduped_existing_blob = final_path.exists();
        let projected_total = self.total_bytes()? + if deduped_existing_blob { 0 } else { size };
        if projected_total > self.config.max_total_bytes {
            let _ = fs::remove_file(&temp_path);
            return Err(ArtifactStoreError::TotalQuotaExceeded {
                actual: projected_total,
                limit: self.config.max_total_bytes,
            });
        }
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if deduped_existing_blob {
            fs::remove_file(&temp_path)?;
        } else {
            fs::rename(&temp_path, &final_path)?;
            if let Some(parent) = final_path.parent() {
                let _ = File::open(parent).and_then(|dir| dir.sync_all());
            }
        }
        inject_fault(fault, ArtifactFaultPoint::AfterRename)?;
        Ok((digest, deduped_existing_blob))
    }

    fn cas_digests(&self) -> Result<Vec<ArtifactDigest>, ArtifactStoreError> {
        let mut digests = Vec::new();
        if !self.cas_root.exists() {
            return Ok(digests);
        }
        for entry in fs::read_dir(&self.cas_root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                for file in fs::read_dir(entry.path())? {
                    let file = file?;
                    if file.file_type()?.is_file()
                        && let Some(name) = file.file_name().to_str()
                        && let Ok(digest) = ArtifactDigest::new(format!("sha256:{name}"))
                    {
                        digests.push(digest);
                    }
                }
            }
        }
        Ok(digests)
    }

    fn reaches(&self, from: &ArtifactId, target: &ArtifactId) -> bool {
        let mut stack = vec![from.clone()];
        let mut seen = BTreeSet::new();
        while let Some(current) = stack.pop() {
            if &current == target {
                return true;
            }
            if !seen.insert(current.clone()) {
                continue;
            }
            for edge in &self.lineage_edges {
                if edge.from == current {
                    stack.push(edge.to.clone());
                }
            }
        }
        false
    }

    fn path_for_digest(&self, digest: &ArtifactDigest) -> PathBuf {
        let hex = digest
            .as_str()
            .strip_prefix("sha256:")
            .unwrap_or(digest.as_str());
        self.cas_root.join(&hex[0..2]).join(hex)
    }

    fn total_bytes(&self) -> Result<u64, ArtifactStoreError> {
        let mut total = 0;
        if !self.cas_root.exists() {
            return Ok(0);
        }
        for entry in fs::read_dir(&self.cas_root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                for file in fs::read_dir(entry.path())? {
                    let file = file?;
                    if file.file_type()?.is_file() {
                        total += file.metadata()?.len();
                    }
                }
            }
        }
        Ok(total)
    }
}

type PersistedManifestState = (
    BTreeMap<ArtifactId, ArtifactManifest>,
    BTreeMap<ArtifactDigest, ArtifactHandle>,
    BTreeSet<ArtifactDigest>,
    Vec<String>,
);

fn load_persisted_manifests(
    cas_root: &Path,
    manifest_root: &Path,
) -> Result<PersistedManifestState, ArtifactStoreError> {
    let mut manifests = BTreeMap::new();
    let mut handles = BTreeMap::new();
    let mut live = BTreeSet::new();
    let mut corrupt = Vec::new();
    let mut entries = fs::read_dir(manifest_root)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !entry.file_type()?.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let bytes = fs::read(entry.path())?;
        let Ok(manifest) = serde_json::from_slice::<ArtifactManifest>(&bytes) else {
            corrupt.push(name);
            continue;
        };
        if name != format!("{}.json", manifest.artifact_id.as_str()) {
            corrupt.push(name);
            continue;
        }
        let hex = manifest
            .digest
            .as_str()
            .strip_prefix("sha256:")
            .unwrap_or("");
        let blob_path = if hex.len() >= 2 {
            cas_root.join(&hex[..2]).join(hex)
        } else {
            cas_root.join("invalid")
        };
        if let Ok(blob) = fs::read(&blob_path) {
            handles.insert(
                manifest.digest.clone(),
                ArtifactHandle {
                    artifact_id: manifest.artifact_id.clone(),
                    digest: manifest.digest.clone(),
                    byte_size: manifest.byte_size,
                    media_type: manifest.media_type.clone(),
                    preview: preview_for(&blob, &manifest.media_type),
                    broker_handle_id: format!(
                        "artifact-handle:{}:{}",
                        manifest.artifact_id,
                        manifest.digest.as_str()
                    ),
                },
            );
        }
        live.insert(manifest.digest.clone());
        manifests.insert(manifest.artifact_id.clone(), manifest);
    }
    Ok((manifests, handles, live, corrupt))
}

fn inject_fault(
    fault: Option<ArtifactFaultPoint>,
    point: ArtifactFaultPoint,
) -> Result<(), ArtifactStoreError> {
    if fault == Some(point) {
        Err(ArtifactStoreError::FaultInjected(point))
    } else {
        Ok(())
    }
}

pub fn validate_artifact_manifest_input(
    bytes: &[u8],
    digest: &ArtifactDigest,
    media_type: &str,
) -> Result<(), ArtifactStoreError> {
    if &digest_bytes(bytes)? != digest {
        return Err(ArtifactStoreError::InvalidManifest(
            "digest does not match bytes".to_string(),
        ));
    }
    let sniffed = sniff_media_type(bytes);
    if media_type != sniffed {
        return Err(ArtifactStoreError::InvalidManifest(format!(
            "media type {media_type} does not match sniffed {sniffed}"
        )));
    }
    Ok(())
}

pub fn digest_bytes(bytes: &[u8]) -> Result<ArtifactDigest, ArtifactStoreError> {
    let digest = Sha256::digest(bytes);
    Ok(ArtifactDigest::new(format!("sha256:{digest:x}"))?)
}

pub fn sniff_media_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"%PDF-") {
        "application/pdf"
    } else if bytes.first().is_some_and(|b| *b == b'{' || *b == b'[') {
        "application/json"
    } else if bytes
        .iter()
        .all(|b| *b == b'\n' || *b == b'\r' || *b == b'\t' || (0x20..=0x7e).contains(b))
    {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

pub fn preview_for(bytes: &[u8], media_type: &str) -> ArtifactPreview {
    let text = if media_type.starts_with("text/") || media_type == "application/json" {
        Some(String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_PREVIEW_BYTES)]).to_string())
    } else {
        None
    };
    ArtifactPreview {
        media_type: media_type.to_string(),
        text,
        truncated: bytes.len() > MAX_PREVIEW_BYTES,
    }
}

fn canonical_existing(path: &Path) -> Result<PathBuf, ArtifactStoreError> {
    Ok(path.canonicalize()?)
}

fn ensure_contained(project_root: &Path, path: &Path) -> Result<(), ArtifactStoreError> {
    if path.starts_with(project_root) {
        Ok(())
    } else {
        Err(ArtifactStoreError::PathEscapesProject)
    }
}

pub fn ui_artifact_contract_source() -> &'static str {
    "UI receives ArtifactHandle { digest, media_type, byte_size, preview, broker_handle_id } and never a raw path"
}
