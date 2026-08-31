use std::{
    collections::BTreeSet,
    path::{Component, Path},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{ArtifactDigest, ProjectRevision, versioning::CANONICAL_SCHEMA_VERSION};

pub const MAX_PATCH_BYTES: usize = 512 * 1024;
pub const MAX_PATCH_OPERATIONS: usize = 256;
pub const MAX_PATCH_TOTAL_STAGED_BYTES: u64 = 128 * 1024 * 1024;
pub const MAX_PATCH_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_PATCH_PATH_DEPTH: usize = 32;
pub const MAX_PATCH_HUNKS: u32 = 4096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PatchPathSemantics {
    CaseSensitive,
    CaseInsensitive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StagedBlobRef {
    pub relative_path: String,
    pub digest: ArtifactDigest,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PatchOperation {
    Create {
        path: String,
        staged: StagedBlobRef,
        mode: u32,
        hunk_count: u32,
    },
    Replace {
        path: String,
        base_digest: ArtifactDigest,
        staged: StagedBlobRef,
        mode: u32,
        hunk_count: u32,
    },
    Delete {
        path: String,
        base_digest: ArtifactDigest,
    },
    Rename {
        from: String,
        to: String,
        base_digest: ArtifactDigest,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CanonicalProjectPatch {
    pub schema_version: u16,
    pub patch_id: String,
    pub base_project_revision: ProjectRevision,
    pub staging_root_digest: ArtifactDigest,
    pub path_semantics: PatchPathSemantics,
    pub operations: Vec<PatchOperation>,
}

pub fn decode_canonical_patch(bytes: &[u8]) -> Result<CanonicalProjectPatch, PatchValidationError> {
    if bytes.len() > MAX_PATCH_BYTES {
        return Err(PatchValidationError::PatchBytes);
    }
    let patch: CanonicalProjectPatch =
        serde_json::from_slice(bytes).map_err(|_| PatchValidationError::Encoding)?;
    patch.validate()?;
    Ok(patch)
}

impl CanonicalProjectPatch {
    pub fn new(
        patch_id: impl Into<String>,
        base_project_revision: ProjectRevision,
        staging_root_digest: ArtifactDigest,
        path_semantics: PatchPathSemantics,
        operations: Vec<PatchOperation>,
    ) -> Result<Self, PatchValidationError> {
        let patch = Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            patch_id: patch_id.into(),
            base_project_revision,
            staging_root_digest,
            path_semantics,
            operations,
        };
        patch.validate()?;
        Ok(patch)
    }

    pub fn validate(&self) -> Result<(), PatchValidationError> {
        if self.schema_version != CANONICAL_SCHEMA_VERSION {
            return Err(PatchValidationError::SchemaVersion);
        }
        if self.patch_id.is_empty() || self.patch_id.len() > 256 {
            return Err(PatchValidationError::PatchId);
        }
        if self.operations.is_empty() || self.operations.len() > MAX_PATCH_OPERATIONS {
            return Err(PatchValidationError::OperationCount);
        }
        let encoded = serde_json::to_vec(self).map_err(|_| PatchValidationError::Encoding)?;
        if encoded.len() > MAX_PATCH_BYTES {
            return Err(PatchValidationError::PatchBytes);
        }
        let mut touched = BTreeSet::new();
        let mut total_bytes = 0_u64;
        let mut total_hunks = 0_u32;
        for operation in &self.operations {
            match operation {
                PatchOperation::Create {
                    path,
                    staged,
                    mode,
                    hunk_count,
                } => {
                    validate_path(path)?;
                    validate_staged(staged)?;
                    validate_mode(*mode)?;
                    register_path(&mut touched, path, self.path_semantics)?;
                    total_bytes = total_bytes.saturating_add(staged.byte_size);
                    total_hunks = total_hunks.saturating_add(*hunk_count);
                }
                PatchOperation::Replace {
                    path,
                    staged,
                    mode,
                    hunk_count,
                    ..
                } => {
                    validate_path(path)?;
                    validate_staged(staged)?;
                    validate_mode(*mode)?;
                    register_path(&mut touched, path, self.path_semantics)?;
                    total_bytes = total_bytes.saturating_add(staged.byte_size);
                    total_hunks = total_hunks.saturating_add(*hunk_count);
                }
                PatchOperation::Delete { path, .. } => {
                    validate_path(path)?;
                    register_path(&mut touched, path, self.path_semantics)?;
                }
                PatchOperation::Rename { from, to, .. } => {
                    validate_path(from)?;
                    validate_path(to)?;
                    if from == to {
                        return Err(PatchValidationError::ConflictingPath(from.clone()));
                    }
                    register_path(&mut touched, from, self.path_semantics)?;
                    register_path(&mut touched, to, self.path_semantics)?;
                }
            }
        }
        if total_bytes > MAX_PATCH_TOTAL_STAGED_BYTES {
            return Err(PatchValidationError::TotalBytes);
        }
        if total_hunks > MAX_PATCH_HUNKS {
            return Err(PatchValidationError::HunkCount);
        }
        Ok(())
    }

    pub fn exact_effect_summary(&self) -> PatchEffectSummary {
        let mut creates = 0;
        let mut replaces = 0;
        let mut deletes = 0;
        let mut renames = 0;
        let mut paths = Vec::new();
        let mut staged_bytes = 0;
        for operation in &self.operations {
            match operation {
                PatchOperation::Create { path, staged, .. } => {
                    creates += 1;
                    staged_bytes += staged.byte_size;
                    paths.push(path.clone());
                }
                PatchOperation::Replace { path, staged, .. } => {
                    replaces += 1;
                    staged_bytes += staged.byte_size;
                    paths.push(path.clone());
                }
                PatchOperation::Delete { path, .. } => {
                    deletes += 1;
                    paths.push(path.clone());
                }
                PatchOperation::Rename { from, to, .. } => {
                    renames += 1;
                    paths.push(format!("{from} -> {to}"));
                }
            }
        }
        PatchEffectSummary {
            patch_id: self.patch_id.clone(),
            base_project_revision: self.base_project_revision,
            creates,
            replaces,
            deletes,
            renames,
            staged_bytes,
            paths,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PatchEffectSummary {
    pub patch_id: String,
    pub base_project_revision: ProjectRevision,
    pub creates: usize,
    pub replaces: usize,
    pub deletes: usize,
    pub renames: usize,
    pub staged_bytes: u64,
    pub paths: Vec<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PatchValidationError {
    #[error("unsupported patch schema version")]
    SchemaVersion,
    #[error("patch id is invalid")]
    PatchId,
    #[error("patch operation count is invalid")]
    OperationCount,
    #[error("patch encoded bytes exceed bound")]
    PatchBytes,
    #[error("patch encoding failed")]
    Encoding,
    #[error("patch path is unsafe or non-canonical: {0}")]
    UnsafePath(String),
    #[error("patch path depth exceeds bound: {0}")]
    PathDepth(String),
    #[error("patch path is duplicated or conflicting: {0}")]
    ConflictingPath(String),
    #[error("staged blob reference is invalid")]
    InvalidStagedBlob,
    #[error("staged file exceeds per-file bound")]
    FileBytes,
    #[error("staged files exceed total byte bound")]
    TotalBytes,
    #[error("patch hunk count exceeds bound")]
    HunkCount,
    #[error("patch file mode is unsafe")]
    UnsafeMode,
}

fn validate_path(value: &str) -> Result<(), PatchValidationError> {
    if value.is_empty()
        || value.len() > 4096
        || !value.is_ascii()
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err(PatchValidationError::UnsafePath(
            value.chars().take(128).collect(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PatchValidationError::UnsafePath(value.to_string()));
    }
    if path.components().count() > MAX_PATCH_PATH_DEPTH {
        return Err(PatchValidationError::PathDepth(value.to_string()));
    }
    Ok(())
}

fn validate_staged(staged: &StagedBlobRef) -> Result<(), PatchValidationError> {
    validate_path(&staged.relative_path)?;
    if staged.byte_size > MAX_PATCH_FILE_BYTES {
        return Err(PatchValidationError::FileBytes);
    }
    Ok(())
}

fn validate_mode(mode: u32) -> Result<(), PatchValidationError> {
    if !matches!(mode, 0o600 | 0o644 | 0o755) {
        return Err(PatchValidationError::UnsafeMode);
    }
    Ok(())
}

fn register_path(
    touched: &mut BTreeSet<String>,
    path: &str,
    semantics: PatchPathSemantics,
) -> Result<(), PatchValidationError> {
    let key = match semantics {
        PatchPathSemantics::CaseSensitive => path.to_string(),
        PatchPathSemantics::CaseInsensitive => path.to_ascii_lowercase(),
    };
    if !touched.insert(key) {
        return Err(PatchValidationError::ConflictingPath(path.to_string()));
    }
    Ok(())
}
