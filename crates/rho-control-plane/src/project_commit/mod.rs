use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use rho_protocol::{
    ArtifactDigest, CanonicalProjectPatch, PatchOperation, ProjectRevision, RevisionStamp,
    RevisionTransition, SemanticEventPayload,
};
use rho_sandbox::{
    snapshot::{ProjectSnapshotDelta, SnapshotFileChangeKind},
    staging::{SealedStagedBlob, StagingArea, StagingError},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug)]
pub struct PreparedProjectPatch<'a> {
    pub patch: &'a CanonicalProjectPatch,
    pub staging: &'a StagingArea,
    pub sealed: BTreeMap<String, &'a SealedStagedBlob>,
}

#[derive(Debug)]
pub struct StagedProjectPatch {
    pub patch: CanonicalProjectPatch,
    pub staging: StagingArea,
    pub sealed: BTreeMap<String, SealedStagedBlob>,
}

impl StagedProjectPatch {
    pub fn prepared(&self) -> PreparedProjectPatch<'_> {
        PreparedProjectPatch {
            patch: &self.patch,
            staging: &self.staging,
            sealed: self
                .sealed
                .iter()
                .map(|(path, sealed)| (path.clone(), sealed))
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectCommitProvenance {
    pub patch_digest: ArtifactDigest,
    pub base_project_revision: ProjectRevision,
    pub applied_project_revision: ProjectRevision,
    pub applied_paths: Vec<String>,
}

// Commit outcomes cross the durable boundary infrequently; keeping the
// complete committed evidence inline avoids a second allocation and preserves
// one ownership unit for revision, event, and provenance truth.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ProjectCommitOutcome {
    Committed {
        transition: RevisionTransition,
        event: SemanticEventPayload,
        provenance: ProjectCommitProvenance,
    },
    ReconcileRequired {
        patch_digest: ArtifactDigest,
        applied_paths: Vec<String>,
        pending_paths: Vec<String>,
        journal_id: String,
        reason_code: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectCommitFault {
    BeforeTempWrite,
    AfterOperation(usize),
    BeforeRevisionCommit,
    DiskFull,
}

#[derive(Debug, Error)]
pub enum ProjectCommitError {
    #[error("project patch is stale: expected {expected:?}, current {current:?}")]
    StaleRevision {
        expected: ProjectRevision,
        current: ProjectRevision,
    },
    #[error("project path is unsafe")]
    UnsafePath,
    #[error("project path state conflicts with patch base digest: {0}")]
    BaseDigestConflict(String),
    #[error("project file is a link or special file: {0}")]
    UnsafeFile(String),
    #[error("sealed staging bytes are missing for {0}")]
    MissingStagedBlob(String),
    #[error("staging verification failed: {0}")]
    Staging(#[from] StagingError),
    #[error("project commit IO failed")]
    Io(#[from] std::io::Error),
    #[error("project commit serialization failed")]
    Serialization(#[from] serde_json::Error),
    #[error("project disk is full")]
    DiskFull,
}

#[derive(Debug, Clone)]
pub struct ProjectCommitState {
    pub revision: RevisionStamp,
    pub last_applied_patch_digest: Option<ArtifactDigest>,
}

pub struct ProjectCommitter {
    project_root: PathBuf,
    state: ProjectCommitState,
}

impl ProjectCommitter {
    pub fn open(
        project_root: impl AsRef<Path>,
        revision: RevisionStamp,
    ) -> Result<Self, ProjectCommitError> {
        let project_root = project_root.as_ref().canonicalize()?;
        Ok(Self {
            project_root,
            state: ProjectCommitState {
                revision,
                last_applied_patch_digest: None,
            },
        })
    }

    pub fn state(&self) -> &ProjectCommitState {
        &self.state
    }

    /// Commit a well-formed requested patch. Rho validates execution identity
    /// and integrity but does not make a permission decision.
    pub fn commit(
        &mut self,
        prepared: &PreparedProjectPatch<'_>,
    ) -> Result<ProjectCommitOutcome, ProjectCommitError> {
        let digest = self.validated_patch_digest(prepared)?;
        self.commit_validated(prepared, digest, None)
    }

    pub fn commit_with_fault(
        &mut self,
        prepared: &PreparedProjectPatch<'_>,
        fault: Option<ProjectCommitFault>,
    ) -> Result<ProjectCommitOutcome, ProjectCommitError> {
        let digest = self.validated_patch_digest(prepared)?;
        self.commit_validated(prepared, digest, fault)
    }

    fn validated_patch_digest(
        &self,
        prepared: &PreparedProjectPatch<'_>,
    ) -> Result<ArtifactDigest, ProjectCommitError> {
        prepared
            .patch
            .validate()
            .map_err(|_| ProjectCommitError::UnsafePath)?;
        if prepared.patch.base_project_revision != self.state.revision.project_revision {
            return Err(ProjectCommitError::StaleRevision {
                expected: prepared.patch.base_project_revision,
                current: self.state.revision.project_revision,
            });
        }
        patch_digest(prepared.patch)
    }

    fn commit_validated(
        &mut self,
        prepared: &PreparedProjectPatch<'_>,
        digest: ArtifactDigest,
        fault: Option<ProjectCommitFault>,
    ) -> Result<ProjectCommitOutcome, ProjectCommitError> {
        self.validate_bases(prepared.patch)?;
        if fault == Some(ProjectCommitFault::DiskFull) {
            return Err(ProjectCommitError::DiskFull);
        }
        let journal_id = format!("journal_{}", prepared.patch.patch_id);
        let mut journal = CommitJournal {
            journal_id: journal_id.clone(),
            patch_digest: digest.clone(),
            base_project_revision: prepared.patch.base_project_revision,
            operations: prepared.patch.operations.clone(),
            applied_paths: Vec::new(),
        };
        let journal_path = self.write_journal(&journal)?;
        for (index, operation) in prepared.patch.operations.iter().enumerate() {
            self.validate_operation_base(operation)?;
            if fault == Some(ProjectCommitFault::BeforeTempWrite) {
                return Ok(reconcile_outcome(
                    &journal,
                    prepared.patch,
                    "fault_before_temp_write",
                ));
            }
            self.apply_operation(operation, prepared)?;
            journal
                .applied_paths
                .extend(operation_paths(operation).into_iter().map(str::to_string));
            self.write_journal_at(&journal_path, &journal)?;
            if fault == Some(ProjectCommitFault::AfterOperation(index)) {
                return Ok(reconcile_outcome(
                    &journal,
                    prepared.patch,
                    "fault_after_partial_operation",
                ));
            }
        }
        if prepared
            .patch
            .operations
            .iter()
            .any(|operation| !self.operation_is_applied(operation).unwrap_or(false))
        {
            return Ok(reconcile_outcome(
                &journal,
                prepared.patch,
                "external_watcher_conflict_after_apply",
            ));
        }
        if fault == Some(ProjectCommitFault::BeforeRevisionCommit) {
            return Ok(reconcile_outcome(
                &journal,
                prepared.patch,
                "files_applied_revision_pending",
            ));
        }
        let outcome = self.commit_revision(digest, journal.applied_paths.clone());
        fs::remove_file(&journal_path)?;
        sync_directory(journal_path.parent().unwrap_or(&self.project_root))?;
        Ok(outcome)
    }

    pub fn reconcile_journal(
        &mut self,
        journal_id: &str,
    ) -> Result<ProjectCommitOutcome, ProjectCommitError> {
        let path = self.journal_directory().join(format!("{journal_id}.json"));
        let journal: CommitJournal = serde_json::from_slice(&fs::read(&path)?)?;
        if journal.base_project_revision != self.state.revision.project_revision {
            return Err(ProjectCommitError::StaleRevision {
                expected: journal.base_project_revision,
                current: self.state.revision.project_revision,
            });
        }
        let mut exact_applied = Vec::new();
        let mut pending = Vec::new();
        for operation in &journal.operations {
            let applied = self.operation_is_applied(operation)?;
            for path in operation_paths(operation) {
                if applied {
                    exact_applied.push(path.to_string());
                } else {
                    pending.push(path.to_string());
                }
            }
        }
        exact_applied.sort();
        exact_applied.dedup();
        pending.sort();
        pending.dedup();
        if pending.is_empty() {
            let outcome = self.commit_revision(journal.patch_digest.clone(), exact_applied);
            fs::remove_file(path)?;
            return Ok(outcome);
        }
        Ok(ProjectCommitOutcome::ReconcileRequired {
            patch_digest: journal.patch_digest,
            applied_paths: exact_applied,
            pending_paths: pending,
            journal_id: journal.journal_id,
            reason_code: "partial_multi_file_commit".to_string(),
        })
    }

    fn validate_bases(&self, patch: &CanonicalProjectPatch) -> Result<(), ProjectCommitError> {
        for operation in &patch.operations {
            self.validate_operation_base(operation)?;
        }
        Ok(())
    }

    fn validate_operation_base(
        &self,
        operation: &PatchOperation,
    ) -> Result<(), ProjectCommitError> {
        match operation {
            PatchOperation::Create { path, .. } => {
                let absolute = self.absolute(path)?;
                if absolute.exists() {
                    return Err(ProjectCommitError::BaseDigestConflict(path.clone()));
                }
            }
            PatchOperation::Replace {
                path, base_digest, ..
            }
            | PatchOperation::Delete { path, base_digest }
            | PatchOperation::Rename {
                from: path,
                base_digest,
                ..
            } => {
                let actual = self.file_digest(path)?;
                if &actual != base_digest {
                    return Err(ProjectCommitError::BaseDigestConflict(path.clone()));
                }
            }
        }
        Ok(())
    }

    fn apply_operation(
        &self,
        operation: &PatchOperation,
        prepared: &PreparedProjectPatch<'_>,
    ) -> Result<(), ProjectCommitError> {
        match operation {
            PatchOperation::Create {
                path, staged, mode, ..
            }
            | PatchOperation::Replace {
                path, staged, mode, ..
            } => {
                let sealed = prepared.sealed.get(&staged.relative_path).ok_or_else(|| {
                    ProjectCommitError::MissingStagedBlob(staged.relative_path.clone())
                })?;
                if sealed.reference() != staged {
                    return Err(ProjectCommitError::MissingStagedBlob(
                        staged.relative_path.clone(),
                    ));
                }
                let bytes = prepared.staging.read_verified(sealed)?;
                self.atomic_write(path, &bytes, *mode)?;
            }
            PatchOperation::Delete { path, .. } => {
                let absolute = self.absolute(path)?;
                fs::remove_file(&absolute)?;
                sync_directory(absolute.parent().unwrap_or(&self.project_root))?;
            }
            PatchOperation::Rename { from, to, .. } => {
                let source = self.absolute(from)?;
                let destination = self.absolute(to)?;
                if destination.exists() {
                    return Err(ProjectCommitError::BaseDigestConflict(to.clone()));
                }
                let parent = destination.parent().ok_or(ProjectCommitError::UnsafePath)?;
                fs::create_dir_all(parent)?;
                ensure_contained(&self.project_root, parent)?;
                fs::rename(&source, &destination)?;
                sync_directory(source.parent().unwrap_or(&self.project_root))?;
                sync_directory(parent)?;
            }
        }
        Ok(())
    }

    fn atomic_write(
        &self,
        relative: &str,
        bytes: &[u8],
        mode: u32,
    ) -> Result<(), ProjectCommitError> {
        let destination = self.absolute(relative)?;
        let parent = destination.parent().ok_or(ProjectCommitError::UnsafePath)?;
        fs::create_dir_all(parent)?;
        ensure_contained(&self.project_root, parent)?;
        let temp = parent.join(format!(
            ".rho-commit-{}",
            rho_protocol::EventId::generate().as_str()
        ));
        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        set_mode(&temp, mode)?;
        fs::rename(&temp, &destination)?;
        sync_directory(parent)?;
        Ok(())
    }

    fn file_digest(&self, relative: &str) -> Result<ArtifactDigest, ProjectCommitError> {
        let absolute = self.absolute(relative)?;
        let metadata = fs::symlink_metadata(&absolute)?;
        validate_regular(&metadata, relative)?;
        let bytes = fs::read(absolute)?;
        ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
            .map_err(|_| ProjectCommitError::BaseDigestConflict(relative.to_string()))
    }

    fn operation_is_applied(&self, operation: &PatchOperation) -> Result<bool, ProjectCommitError> {
        Ok(match operation {
            PatchOperation::Create { path, staged, .. }
            | PatchOperation::Replace { path, staged, .. } => {
                self.file_digest(path).ok().as_ref() == Some(&staged.digest)
            }
            PatchOperation::Delete { path, .. } => !self.absolute(path)?.exists(),
            PatchOperation::Rename {
                from,
                to,
                base_digest,
            } => {
                !self.absolute(from)?.exists()
                    && self.file_digest(to).ok().as_ref() == Some(base_digest)
            }
        })
    }

    fn absolute(&self, relative: &str) -> Result<PathBuf, ProjectCommitError> {
        let path = Path::new(relative);
        if path.is_absolute()
            || relative.contains('\\')
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(ProjectCommitError::UnsafePath);
        }
        let absolute = self.project_root.join(path);
        if let Some(parent) = absolute.parent() {
            let existing = nearest_existing(parent);
            ensure_contained(&self.project_root, &existing)?;
        }
        Ok(absolute)
    }

    fn commit_revision(
        &mut self,
        digest: ArtifactDigest,
        mut applied_paths: Vec<String>,
    ) -> ProjectCommitOutcome {
        applied_paths.sort();
        applied_paths.dedup();
        let before = self.state.revision.clone();
        let after = RevisionStamp {
            project_revision: ProjectRevision(before.project_revision.0.saturating_add(1)),
            ..before.clone()
        };
        let transition = RevisionTransition {
            before: before.clone(),
            after: after.clone(),
        };
        self.state.revision = after.clone();
        self.state.last_applied_patch_digest = Some(digest.clone());
        ProjectCommitOutcome::Committed {
            event: SemanticEventPayload::RevisionAdvanced {
                transition: transition.clone(),
            },
            provenance: ProjectCommitProvenance {
                patch_digest: digest,
                base_project_revision: before.project_revision,
                applied_project_revision: after.project_revision,
                applied_paths,
            },
            transition,
        }
    }

    fn journal_directory(&self) -> PathBuf {
        self.project_root.join(".rho/commit-journal")
    }

    fn write_journal(&self, journal: &CommitJournal) -> Result<PathBuf, ProjectCommitError> {
        let directory = self.journal_directory();
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{}.json", journal.journal_id));
        self.write_journal_at(&path, journal)?;
        Ok(path)
    }

    fn write_journal_at(
        &self,
        path: &Path,
        journal: &CommitJournal,
    ) -> Result<(), ProjectCommitError> {
        let temp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(journal)?;
        {
            let mut file = File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(temp, path)?;
        sync_directory(path.parent().unwrap_or(&self.project_root))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommitJournal {
    journal_id: String,
    patch_digest: ArtifactDigest,
    base_project_revision: ProjectRevision,
    operations: Vec<PatchOperation>,
    applied_paths: Vec<String>,
}

fn reconcile_outcome(
    journal: &CommitJournal,
    patch: &CanonicalProjectPatch,
    reason_code: &str,
) -> ProjectCommitOutcome {
    let applied = journal
        .applied_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut pending_paths = patch
        .operations
        .iter()
        .flat_map(operation_paths)
        .filter(|path| !applied.contains(*path))
        .map(str::to_string)
        .collect::<Vec<_>>();
    pending_paths.sort();
    pending_paths.dedup();
    ProjectCommitOutcome::ReconcileRequired {
        patch_digest: journal.patch_digest.clone(),
        applied_paths: journal.applied_paths.clone(),
        pending_paths,
        journal_id: journal.journal_id.clone(),
        reason_code: reason_code.to_string(),
    }
}

pub fn stage_snapshot_delta(
    delta: &ProjectSnapshotDelta,
    staging_root: impl AsRef<Path>,
    patch_id: impl Into<String>,
) -> Result<StagedProjectPatch, ProjectCommitError> {
    if delta.changes.is_empty() {
        return Err(ProjectCommitError::UnsafePath);
    }
    let mut staging = StagingArea::open(staging_root, rho_protocol::MAX_PATCH_FILE_BYTES)?;
    let mut sealed = BTreeMap::new();
    let mut operations = Vec::with_capacity(delta.changes.len());
    for change in &delta.changes {
        let operation = match change.kind {
            SnapshotFileChangeKind::Create | SnapshotFileChangeKind::Replace => {
                let bytes = change.bytes.as_deref().ok_or_else(|| {
                    ProjectCommitError::MissingStagedBlob(change.relative_path.clone())
                })?;
                let staged = staging.write_and_seal(&change.relative_path, bytes)?;
                if change.after_sha256.as_deref() != Some(staged.reference().digest.as_str()) {
                    return Err(ProjectCommitError::MissingStagedBlob(
                        change.relative_path.clone(),
                    ));
                }
                let reference = staged.reference().clone();
                sealed.insert(change.relative_path.clone(), staged);
                let mode = change.mode.ok_or(ProjectCommitError::UnsafePath)?;
                if change.kind == SnapshotFileChangeKind::Create {
                    PatchOperation::Create {
                        path: change.relative_path.clone(),
                        staged: reference,
                        mode,
                        hunk_count: 1,
                    }
                } else {
                    PatchOperation::Replace {
                        path: change.relative_path.clone(),
                        base_digest: ArtifactDigest::new(
                            change
                                .before_sha256
                                .clone()
                                .ok_or(ProjectCommitError::UnsafePath)?,
                        )
                        .map_err(|_| ProjectCommitError::UnsafePath)?,
                        staged: reference,
                        mode,
                        hunk_count: 1,
                    }
                }
            }
            SnapshotFileChangeKind::Delete => PatchOperation::Delete {
                path: change.relative_path.clone(),
                base_digest: ArtifactDigest::new(
                    change
                        .before_sha256
                        .clone()
                        .ok_or(ProjectCommitError::UnsafePath)?,
                )
                .map_err(|_| ProjectCommitError::UnsafePath)?,
            },
        };
        operations.push(operation);
    }
    let staging_root_digest = staging.staging_root_digest()?;
    let patch = CanonicalProjectPatch::new(
        patch_id,
        delta.base_project_revision,
        staging_root_digest,
        if cfg!(windows) {
            rho_protocol::PatchPathSemantics::CaseInsensitive
        } else {
            rho_protocol::PatchPathSemantics::CaseSensitive
        },
        operations,
    )
    .map_err(|_| ProjectCommitError::UnsafePath)?;
    Ok(StagedProjectPatch {
        patch,
        staging,
        sealed,
    })
}

pub fn patch_digest(patch: &CanonicalProjectPatch) -> Result<ArtifactDigest, ProjectCommitError> {
    let bytes = serde_json::to_vec(patch)?;
    ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|_| ProjectCommitError::UnsafePath)
}

fn operation_paths(operation: &PatchOperation) -> Vec<&str> {
    match operation {
        PatchOperation::Create { path, .. }
        | PatchOperation::Replace { path, .. }
        | PatchOperation::Delete { path, .. } => vec![path],
        PatchOperation::Rename { from, to, .. } => vec![from, to],
    }
}

fn ensure_contained(root: &Path, path: &Path) -> Result<(), ProjectCommitError> {
    let path = path.canonicalize()?;
    if path.starts_with(root) {
        Ok(())
    } else {
        Err(ProjectCommitError::UnsafePath)
    }
}

fn nearest_existing(path: &Path) -> PathBuf {
    let mut current = path;
    while !current.exists() {
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    current.to_path_buf()
}

fn validate_regular(metadata: &fs::Metadata, path: &str) -> Result<(), ProjectCommitError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ProjectCommitError::UnsafeFile(path.to_string()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(ProjectCommitError::UnsafeFile(path.to_string()));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(path: &Path, _mode: u32) -> Result<(), std::io::Error> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

fn sync_directory(path: &Path) -> Result<(), std::io::Error> {
    File::open(path)?.sync_all()
}

pub fn project_commit_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "revision_validation",
            "requested_project_commit",
            "journaled_commit",
            "project_revision_provenance",
        ],
        &[
            "cross_file_atomicity_claim",
            "shell_patch",
            "provider_direct_write",
            "stale_overwrite",
        ],
    )
}
