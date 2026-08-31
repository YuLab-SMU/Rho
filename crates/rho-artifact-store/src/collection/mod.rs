use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path, PathBuf},
};

use rho_protocol::{
    ArtifactDigest, ArtifactId, ArtifactRef, ExecutionId, ExpectedOutput, RevisionStamp,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    ArtifactCommitRequest, ArtifactHandle, ArtifactStore, ArtifactStoreError,
    DEFAULT_MAX_ARTIFACT_BYTES,
};

pub const MAX_COLLECTED_OUTPUT_FILES: usize = 256;
pub const MAX_COLLECTED_OUTPUT_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone)]
struct SealedOutputFile {
    relative_path: String,
    digest: ArtifactDigest,
    byte_size: u64,
    metadata: Metadata,
}

#[derive(Debug, Clone)]
pub struct SealedOutputStaging {
    root: PathBuf,
    files: Vec<SealedOutputFile>,
    total_bytes: u64,
}

#[derive(Debug, Error)]
pub enum OutputCollectionError {
    #[error("output staging cannot be sealed while process is running")]
    ProcessStillRunning,
    #[error("output staging path is unsafe")]
    UnsafePath,
    #[error("output staging contains link, hardlink, or special file")]
    UnsafeFile,
    #[error("output staging exceeds file count, file size, or total size bound")]
    Bounds,
    #[error("sealed output changed after process terminal")]
    ChangedAfterSeal,
    #[error("required expected output is missing: {0}")]
    MissingRequired(String),
    #[error("unexpected suspicious output is present: {0}")]
    UnexpectedOutput(String),
    #[error("artifact CAS commit failed: {0}")]
    Artifact(#[from] ArtifactStoreError),
    #[error("output IO failed")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectedOutput {
    pub relative_path: String,
    pub handle: ArtifactHandle,
    pub required: bool,
    pub deduplicated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollectionStatus {
    Complete,
    PartialReconcile,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputCollectionReport {
    pub execution_id: ExecutionId,
    pub process_succeeded: bool,
    pub status: CollectionStatus,
    pub committed: Vec<CollectedOutput>,
    pub missing_required: Vec<String>,
    pub suspicious_extra: Vec<String>,
    pub error_codes: Vec<String>,
    pub product_succeeded: bool,
    pub reconcile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct CollectionProvenanceEdge {
    pub execution_id: ExecutionId,
    pub artifact_id: ArtifactId,
    pub relative_path: String,
}

#[derive(Debug, Default)]
pub struct ArtifactOutputCollector {
    committed: BTreeMap<(ExecutionId, String, ArtifactDigest), CollectedOutput>,
    edges: BTreeSet<CollectionProvenanceEdge>,
}

impl ArtifactOutputCollector {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn collect(
        &mut self,
        store: &mut ArtifactStore,
        execution_id: ExecutionId,
        process_succeeded: bool,
        sealed: &SealedOutputStaging,
        expected: &[ExpectedOutput],
        revision: RevisionStamp,
        inputs: Vec<ArtifactRef>,
        environment_digest: Option<ArtifactDigest>,
    ) -> OutputCollectionReport {
        if !process_succeeded {
            return failed_report(execution_id, false, "process_not_succeeded");
        }
        let mut missing_required = Vec::new();
        let mut matched_paths = BTreeSet::new();
        let mut selected = Vec::new();
        for expectation in expected {
            let matches = sealed
                .files
                .iter()
                .filter(|file| pattern_matches(&file.relative_path, &expectation.path_hint))
                .collect::<Vec<_>>();
            if matches.is_empty() && expectation.required {
                missing_required.push(expectation.path_hint.clone());
            }
            for file in matches {
                matched_paths.insert(file.relative_path.clone());
                selected.push((file, expectation.required));
            }
        }
        let suspicious_extra = sealed
            .files
            .iter()
            .filter(|file| !matched_paths.contains(&file.relative_path))
            .map(|file| file.relative_path.clone())
            .collect::<Vec<_>>();
        if !missing_required.is_empty() || !suspicious_extra.is_empty() {
            return OutputCollectionReport {
                execution_id,
                process_succeeded: true,
                status: CollectionStatus::Failed,
                committed: Vec::new(),
                missing_required,
                suspicious_extra,
                error_codes: vec!["output_manifest_mismatch".to_string()],
                product_succeeded: false,
                reconcile_id: None,
            };
        }
        selected.sort_by_key(|(file, _)| file.relative_path.clone());
        selected.dedup_by_key(|(file, _)| file.relative_path.clone());
        let mut committed = Vec::new();
        let mut error_codes = Vec::new();
        for (file, required) in selected {
            let key = (
                execution_id.clone(),
                file.relative_path.clone(),
                file.digest.clone(),
            );
            if let Some(existing) = self.committed.get(&key) {
                let mut existing = existing.clone();
                existing.deduplicated = true;
                committed.push(existing);
                continue;
            }
            let bytes = match sealed.read_verified(file) {
                Ok(bytes) => bytes,
                Err(_) => {
                    error_codes.push(format!("changed_after_seal:{}", file.relative_path));
                    break;
                }
            };
            let commit = store.commit(ArtifactCommitRequest {
                bytes,
                media_type: None,
                execution_id: Some(execution_id.clone()),
                revision: revision.clone(),
                inputs: inputs.clone(),
                environment_digest: environment_digest.clone(),
            });
            match commit {
                Ok(commit) => {
                    let output = CollectedOutput {
                        relative_path: file.relative_path.clone(),
                        handle: commit.handle,
                        required,
                        deduplicated: commit.deduped_existing_blob,
                    };
                    self.edges.insert(CollectionProvenanceEdge {
                        execution_id: execution_id.clone(),
                        artifact_id: output.handle.artifact_id.clone(),
                        relative_path: output.relative_path.clone(),
                    });
                    self.committed.insert(key, output.clone());
                    committed.push(output);
                }
                Err(error) => {
                    error_codes.push(format!("cas_commit:{}:{error}", file.relative_path));
                    break;
                }
            }
        }
        let required_count = expected.iter().filter(|output| output.required).count();
        let committed_required = committed.iter().filter(|output| output.required).count();
        let complete = error_codes.is_empty() && committed_required >= required_count;
        OutputCollectionReport {
            execution_id: execution_id.clone(),
            process_succeeded: true,
            status: if complete {
                CollectionStatus::Complete
            } else if committed.is_empty() {
                CollectionStatus::Failed
            } else {
                CollectionStatus::PartialReconcile
            },
            committed,
            missing_required: Vec::new(),
            suspicious_extra: Vec::new(),
            error_codes,
            product_succeeded: complete,
            reconcile_id: (!complete)
                .then(|| format!("collect_reconcile_{}", execution_id.as_str())),
        }
    }

    pub fn provenance_edges(&self) -> &BTreeSet<CollectionProvenanceEdge> {
        &self.edges
    }
}

pub fn seal_output_staging(
    root: impl AsRef<Path>,
    process_terminal: bool,
) -> Result<SealedOutputStaging, OutputCollectionError> {
    if !process_terminal {
        return Err(OutputCollectionError::ProcessStillRunning);
    }
    let root = root.as_ref().canonicalize()?;
    let mut paths = Vec::new();
    walk(&root, Path::new(""), &mut paths)?;
    paths.sort();
    if paths.len() > MAX_COLLECTED_OUTPUT_FILES {
        return Err(OutputCollectionError::Bounds);
    }
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    for relative in paths {
        let relative_path = relative_string(&relative)?;
        let absolute = root.join(&relative);
        let before = fs::symlink_metadata(&absolute)?;
        validate_regular(&before)?;
        if before.len() > DEFAULT_MAX_ARTIFACT_BYTES {
            return Err(OutputCollectionError::Bounds);
        }
        let file = File::open(&absolute)?;
        let opened = file.metadata()?;
        if !same_identity(&before, &opened) {
            return Err(OutputCollectionError::ChangedAfterSeal);
        }
        let mut bytes = Vec::with_capacity(opened.len() as usize);
        file.take(DEFAULT_MAX_ARTIFACT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > DEFAULT_MAX_ARTIFACT_BYTES {
            return Err(OutputCollectionError::Bounds);
        }
        let after = fs::symlink_metadata(&absolute)?;
        if !same_identity(&opened, &after)
            || opened.len() != after.len()
            || opened.modified().ok() != after.modified().ok()
        {
            return Err(OutputCollectionError::ChangedAfterSeal);
        }
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > MAX_COLLECTED_OUTPUT_TOTAL_BYTES {
            return Err(OutputCollectionError::Bounds);
        }
        let digest = ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes)))
            .map_err(|_| OutputCollectionError::Bounds)?;
        set_read_only(&absolute)?;
        files.push(SealedOutputFile {
            relative_path,
            digest,
            byte_size: bytes.len() as u64,
            metadata: after,
        });
    }
    Ok(SealedOutputStaging {
        root,
        files,
        total_bytes,
    })
}

impl SealedOutputStaging {
    pub fn total_bytes(&self) -> u64 {
        self.total_bytes
    }

    fn read_verified(&self, file: &SealedOutputFile) -> Result<Vec<u8>, OutputCollectionError> {
        let path = self.root.join(relative_path(&file.relative_path)?);
        let metadata = fs::symlink_metadata(&path)?;
        validate_regular(&metadata)?;
        if !same_identity(&file.metadata, &metadata)
            || metadata.len() != file.byte_size
            || file.metadata.modified().ok() != metadata.modified().ok()
        {
            return Err(OutputCollectionError::ChangedAfterSeal);
        }
        let bytes = fs::read(path)?;
        let digest = ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes)))
            .map_err(|_| OutputCollectionError::Bounds)?;
        if digest != file.digest {
            return Err(OutputCollectionError::ChangedAfterSeal);
        }
        Ok(bytes)
    }
}

fn walk(
    root: &Path,
    relative: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), OutputCollectionError> {
    let mut entries = fs::read_dir(root.join(relative))?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let child = relative.join(entry.file_name());
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(OutputCollectionError::UnsafeFile);
        }
        if metadata.is_dir() {
            walk(root, &child, output)?;
        } else if metadata.is_file() {
            validate_regular(&metadata)?;
            output.push(child);
            if output.len() > MAX_COLLECTED_OUTPUT_FILES {
                return Err(OutputCollectionError::Bounds);
            }
        } else {
            return Err(OutputCollectionError::UnsafeFile);
        }
    }
    Ok(())
}

fn pattern_matches(path: &str, pattern: &str) -> bool {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        path.starts_with(prefix) && path.ends_with(suffix)
    } else {
        path == pattern
    }
}

fn relative_string(path: &Path) -> Result<String, OutputCollectionError> {
    let value = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    relative_path(&value)?;
    Ok(value)
}

fn relative_path(value: &str) -> Result<PathBuf, OutputCollectionError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(OutputCollectionError::UnsafePath);
    }
    Ok(path.to_path_buf())
}

fn validate_regular(metadata: &Metadata) -> Result<(), OutputCollectionError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(OutputCollectionError::UnsafeFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(OutputCollectionError::UnsafeFile);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.file_index() == right.file_index()
        && left.volume_serial_number() == right.volume_serial_number()
}

#[cfg(not(any(unix, windows)))]
fn same_identity(_left: &Metadata, _right: &Metadata) -> bool {
    false
}

fn set_read_only(path: &Path) -> Result<(), std::io::Error> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn failed_report(
    execution_id: ExecutionId,
    process_succeeded: bool,
    code: &str,
) -> OutputCollectionReport {
    OutputCollectionReport {
        execution_id,
        process_succeeded,
        status: CollectionStatus::Failed,
        committed: Vec::new(),
        missing_required: Vec::new(),
        suspicious_extra: Vec::new(),
        error_codes: vec![code.to_string()],
        product_succeeded: false,
        reconcile_id: None,
    }
}

pub fn collection_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "terminal_staging_seal",
            "expected_output_match",
            "cas_commit",
            "provenance_edge",
            "partial_reconcile",
        ],
        &[
            "running_process_collect",
            "executor_path_identity",
            "project_overwrite",
            "cas_metadata_overwrite",
            "process_success_as_product_success",
        ],
    )
}
