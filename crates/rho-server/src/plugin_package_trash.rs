//! Broker-owned recoverable moves for project-local plugin packages.
//!
//! This module owns only exact, same-filesystem rename/restore evidence. It
//! does not update SQLite, delete recursively, activate code, or expose paths
//! to guest code.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rho_extension_runtime::{
    PackageDigest, PluginId, snapshot_workspace_plugin_cache_directory,
    snapshot_workspace_plugin_package,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PLUGIN_TRASH_DIRECTORY: &str = ".rho/plugin-trash";
const PURGE_MARKER_SUFFIX: &str = ".json";
const MAX_PURGE_ENTRIES: usize = 4096;
const MAX_PURGE_DEPTH: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginPackageOwnershipOutcome {
    Moved,
    AlreadyMoved,
    Restored,
    AlreadyRestored,
    Purged,
    AlreadyPurged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginPackageMoveEvidence {
    pub outcome: PluginPackageOwnershipOutcome,
    pub plugin_id: String,
    pub package_digest: String,
    pub directory_name: String,
    pub trash_key: String,
}

#[derive(Debug, Error)]
pub enum PluginPackageTrashError {
    #[error("plugin package move identity is invalid: {0}")]
    InvalidIdentity(String),
    #[error("plugin package ownership is unsafe: {0}")]
    UnsafeOwnership(String),
    #[error("plugin package rename failed: {0}")]
    RenameFailed(String),
    #[error("plugin package exact validation failed: {0}")]
    ValidationFailed(String),
    #[error("plugin package exact purge failed: {0}")]
    DeleteFailed(String),
    #[cfg(test)]
    #[error("injected plugin package move failure: {0:?}")]
    Injected(TrashFailurePoint),
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashFailurePoint {
    BeforeRename,
    AfterRename,
    BeforePurgeRename,
    AfterPurgeRename,
    MidPurgeDelete,
    AfterPurgeDelete,
}

#[derive(Debug, Clone)]
pub struct PluginPackageTrash {
    gate: Arc<Mutex<()>>,
    #[cfg(test)]
    failure: Option<TrashFailurePoint>,
}

impl Default for PluginPackageTrash {
    fn default() -> Self {
        Self {
            gate: Arc::new(Mutex::new(())),
            #[cfg(test)]
            failure: None,
        }
    }
}

impl PluginPackageTrash {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn move_exact(
        &self,
        project_root: &Path,
        directory_name: &str,
        plugin_id: &str,
        expected_digest: &str,
        trash_key: &str,
    ) -> Result<PluginPackageMoveEvidence, PluginPackageTrashError> {
        let identity =
            ValidatedMoveIdentity::new(directory_name, plugin_id, expected_digest, trash_key)?;
        let _gate = self
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let roots = ProjectTrashRoots::open(project_root, true)?;
        let source = roots.plugins.join(&identity.directory_name);
        let target = roots.trash.join(&identity.trash_key);
        match (source.exists(), target.exists()) {
            (true, false) => {
                let snapshot = snapshot_workspace_plugin_package(
                    project_root,
                    identity.plugin_id.as_str(),
                    &identity.digest,
                )
                .map_err(|error| PluginPackageTrashError::ValidationFailed(error.to_string()))?;
                if snapshot.manifest.id != identity.plugin_id {
                    return Err(PluginPackageTrashError::ValidationFailed(
                        "source plugin ID changed before move".to_string(),
                    ));
                }
                let discovered = rho_extension_runtime::discover_workspace_plugins(project_root)
                    .map_err(|error| PluginPackageTrashError::ValidationFailed(error.to_string()))?
                    .and_then(|report| {
                        report
                            .plugins
                            .into_iter()
                            .find(|plugin| plugin.manifest.id == identity.plugin_id)
                    })
                    .ok_or_else(|| {
                        PluginPackageTrashError::ValidationFailed(
                            "source plugin disappeared before move".to_string(),
                        )
                    })?;
                if discovered.directory != identity.directory_name
                    || discovered.digest != identity.digest
                {
                    return Err(PluginPackageTrashError::ValidationFailed(
                        "source directory or digest changed before move".to_string(),
                    ));
                }
                #[cfg(test)]
                if self.failure == Some(TrashFailurePoint::BeforeRename) {
                    return Err(PluginPackageTrashError::Injected(
                        TrashFailurePoint::BeforeRename,
                    ));
                }
                fs::rename(&source, &target).map_err(|error| {
                    PluginPackageTrashError::RenameFailed(format!(
                        "moving exact package into trash failed: {error}"
                    ))
                })?;
                sync_directory(&roots.plugins)?;
                sync_directory(&roots.trash)?;
                #[cfg(test)]
                if self.failure == Some(TrashFailurePoint::AfterRename) {
                    return Err(PluginPackageTrashError::Injected(
                        TrashFailurePoint::AfterRename,
                    ));
                }
                validate_exact_directory(&target, &identity)?;
                Ok(identity.evidence(PluginPackageOwnershipOutcome::Moved))
            }
            (false, true) => {
                validate_exact_directory(&target, &identity)?;
                Ok(identity.evidence(PluginPackageOwnershipOutcome::AlreadyMoved))
            }
            (true, true) => Err(PluginPackageTrashError::UnsafeOwnership(
                "source and trash both exist for one package".to_string(),
            )),
            (false, false) => Err(PluginPackageTrashError::UnsafeOwnership(
                "neither source nor trash owns the exact package".to_string(),
            )),
        }
    }

    pub fn restore_exact(
        &self,
        project_root: &Path,
        directory_name: &str,
        plugin_id: &str,
        expected_digest: &str,
        trash_key: &str,
    ) -> Result<PluginPackageMoveEvidence, PluginPackageTrashError> {
        let identity =
            ValidatedMoveIdentity::new(directory_name, plugin_id, expected_digest, trash_key)?;
        let _gate = self
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let roots = ProjectTrashRoots::open(project_root, false)?;
        let source = roots.plugins.join(&identity.directory_name);
        let target = roots.trash.join(&identity.trash_key);
        match (source.exists(), target.exists()) {
            (false, true) => {
                validate_exact_directory(&target, &identity)?;
                #[cfg(test)]
                if self.failure == Some(TrashFailurePoint::BeforeRename) {
                    return Err(PluginPackageTrashError::Injected(
                        TrashFailurePoint::BeforeRename,
                    ));
                }
                fs::rename(&target, &source).map_err(|error| {
                    PluginPackageTrashError::RenameFailed(format!(
                        "restoring exact package from trash failed: {error}"
                    ))
                })?;
                sync_directory(&roots.trash)?;
                sync_directory(&roots.plugins)?;
                #[cfg(test)]
                if self.failure == Some(TrashFailurePoint::AfterRename) {
                    return Err(PluginPackageTrashError::Injected(
                        TrashFailurePoint::AfterRename,
                    ));
                }
                let snapshot = snapshot_workspace_plugin_package(
                    project_root,
                    identity.plugin_id.as_str(),
                    &identity.digest,
                )
                .map_err(|error| PluginPackageTrashError::ValidationFailed(error.to_string()))?;
                if snapshot.digest != identity.digest {
                    return Err(PluginPackageTrashError::ValidationFailed(
                        "restored package digest changed".to_string(),
                    ));
                }
                Ok(identity.evidence(PluginPackageOwnershipOutcome::Restored))
            }
            (true, false) => {
                let snapshot = snapshot_workspace_plugin_package(
                    project_root,
                    identity.plugin_id.as_str(),
                    &identity.digest,
                )
                .map_err(|error| PluginPackageTrashError::ValidationFailed(error.to_string()))?;
                if snapshot.digest != identity.digest {
                    return Err(PluginPackageTrashError::ValidationFailed(
                        "already-restored package digest changed".to_string(),
                    ));
                }
                Ok(identity.evidence(PluginPackageOwnershipOutcome::AlreadyRestored))
            }
            (true, true) => Err(PluginPackageTrashError::UnsafeOwnership(
                "restore source and trash target both exist".to_string(),
            )),
            (false, false) => Err(PluginPackageTrashError::UnsafeOwnership(
                "restore package is missing from source and trash".to_string(),
            )),
        }
    }

    pub fn purge_exact(
        &self,
        project_root: &Path,
        directory_name: &str,
        plugin_id: &str,
        expected_digest: &str,
        trash_key: &str,
    ) -> Result<PluginPackageMoveEvidence, PluginPackageTrashError> {
        let identity =
            ValidatedMoveIdentity::new(directory_name, plugin_id, expected_digest, trash_key)?;
        let _gate = self
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let roots = ProjectTrashRoots::open(project_root, false)?;
        let source = roots.plugins.join(&identity.directory_name);
        if source.exists() {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge refuses a package present in discovery".to_string(),
            ));
        }
        let target = roots.trash.join(&identity.trash_key);
        let purge_key = identity.purge_key();
        let purging = roots.trash.join(&purge_key);
        let marker = roots
            .trash
            .join(format!("{purge_key}{PURGE_MARKER_SUFFIX}"));
        let marker_evidence = PurgeMarker::from_identity(&identity);

        match (target.exists(), purging.exists()) {
            (true, true) => {
                return Err(PluginPackageTrashError::UnsafeOwnership(
                    "trash and purging directories both own one package".to_string(),
                ));
            }
            (true, false) => {
                validate_exact_directory(&target, &identity)?;
                ensure_purge_marker(&roots.trash, &marker, &marker_evidence)?;
                #[cfg(test)]
                if self.failure == Some(TrashFailurePoint::BeforePurgeRename) {
                    return Err(PluginPackageTrashError::Injected(
                        TrashFailurePoint::BeforePurgeRename,
                    ));
                }
                fs::rename(&target, &purging).map_err(|error| {
                    PluginPackageTrashError::RenameFailed(format!(
                        "quarantining exact plugin trash failed: {error}"
                    ))
                })?;
                sync_directory(&roots.trash)?;
                #[cfg(test)]
                if self.failure == Some(TrashFailurePoint::AfterPurgeRename) {
                    return Err(PluginPackageTrashError::Injected(
                        TrashFailurePoint::AfterPurgeRename,
                    ));
                }
            }
            (false, true) => {
                validate_purge_marker(&marker, &marker_evidence)?;
            }
            (false, false) => {
                if marker.exists() {
                    validate_purge_marker(&marker, &marker_evidence)?;
                    return Ok(identity.evidence(PluginPackageOwnershipOutcome::AlreadyPurged));
                }
                return Err(PluginPackageTrashError::UnsafeOwnership(
                    "purged package has no exact retained marker".to_string(),
                ));
            }
        }

        validate_purge_marker(&marker, &marker_evidence)?;
        let mut entry_count = 0usize;
        validate_bounded_purge_tree(&purging, 0, &mut entry_count)?;
        let mut removed = 0usize;
        let inject_mid = {
            #[cfg(test)]
            {
                self.failure == Some(TrashFailurePoint::MidPurgeDelete)
            }
            #[cfg(not(test))]
            {
                false
            }
        };
        remove_bounded_purge_tree(&purging, 0, &mut removed, inject_mid)?;
        sync_directory(&roots.trash)?;
        #[cfg(test)]
        if self.failure == Some(TrashFailurePoint::AfterPurgeDelete) {
            return Err(PluginPackageTrashError::Injected(
                TrashFailurePoint::AfterPurgeDelete,
            ));
        }
        validate_purge_marker(&marker, &marker_evidence)?;
        Ok(identity.evidence(PluginPackageOwnershipOutcome::Purged))
    }
}

struct ValidatedMoveIdentity {
    directory_name: String,
    plugin_id: PluginId,
    digest: PackageDigest,
    trash_key: String,
}

impl ValidatedMoveIdentity {
    fn new(
        directory_name: &str,
        plugin_id: &str,
        expected_digest: &str,
        trash_key: &str,
    ) -> Result<Self, PluginPackageTrashError> {
        Ok(Self {
            directory_name: validate_component(directory_name, "plugin directory")?,
            plugin_id: PluginId::new(plugin_id.to_string())
                .map_err(|error| PluginPackageTrashError::InvalidIdentity(error.to_string()))?,
            digest: PackageDigest::parse(expected_digest.to_string())
                .map_err(|error| PluginPackageTrashError::InvalidIdentity(error.to_string()))?,
            trash_key: validate_component(trash_key, "trash key")?,
        })
    }

    fn evidence(&self, outcome: PluginPackageOwnershipOutcome) -> PluginPackageMoveEvidence {
        PluginPackageMoveEvidence {
            outcome,
            plugin_id: self.plugin_id.to_string(),
            package_digest: self.digest.to_string(),
            directory_name: self.directory_name.clone(),
            trash_key: self.trash_key.clone(),
        }
    }

    fn purge_key(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.trash_key.as_bytes());
        hasher.update([0]);
        hasher.update(self.plugin_id.as_str().as_bytes());
        hasher.update([0]);
        hasher.update(self.digest.as_str().as_bytes());
        format!("purging.{:x}", hasher.finalize())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PurgeMarker {
    schema_version: u32,
    plugin_id: String,
    package_digest: String,
    directory_name: String,
    trash_key: String,
}

impl PurgeMarker {
    fn from_identity(identity: &ValidatedMoveIdentity) -> Self {
        Self {
            schema_version: 1,
            plugin_id: identity.plugin_id.to_string(),
            package_digest: identity.digest.to_string(),
            directory_name: identity.directory_name.clone(),
            trash_key: identity.trash_key.clone(),
        }
    }
}

struct ProjectTrashRoots {
    plugins: PathBuf,
    trash: PathBuf,
}

impl ProjectTrashRoots {
    fn open(project_root: &Path, create_trash: bool) -> Result<Self, PluginPackageTrashError> {
        let project = real_directory(project_root, "project root")?;
        let rho = real_directory(&project_root.join(".rho"), ".rho root")?;
        let plugins = real_directory(&project_root.join(".rho/plugins"), "plugins root")?;
        if !rho.starts_with(&project) || !plugins.starts_with(&rho) {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "plugin roots escape the canonical project".to_string(),
            ));
        }
        let trash_path = project_root.join(PLUGIN_TRASH_DIRECTORY);
        if create_trash && !trash_path.exists() {
            fs::create_dir(&trash_path).map_err(|error| {
                PluginPackageTrashError::RenameFailed(format!(
                    "creating project plugin trash failed: {error}"
                ))
            })?;
            sync_directory(&rho)?;
        }
        let trash = real_directory(&trash_path, "plugin trash root")?;
        if !trash.starts_with(&rho) {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "plugin trash escapes the canonical project".to_string(),
            ));
        }
        Ok(Self { plugins, trash })
    }
}

fn validate_exact_directory(
    directory: &Path,
    identity: &ValidatedMoveIdentity,
) -> Result<(), PluginPackageTrashError> {
    let snapshot =
        snapshot_workspace_plugin_cache_directory(directory, &identity.plugin_id, &identity.digest)
            .map_err(|error| PluginPackageTrashError::ValidationFailed(error.to_string()))?;
    if snapshot.digest != identity.digest {
        return Err(PluginPackageTrashError::ValidationFailed(
            "package digest changed during ownership validation".to_string(),
        ));
    }
    Ok(())
}

fn ensure_purge_marker(
    trash_root: &Path,
    marker_path: &Path,
    evidence: &PurgeMarker,
) -> Result<(), PluginPackageTrashError> {
    if marker_path.exists() {
        return validate_purge_marker(marker_path, evidence);
    }
    let temp_path = marker_path.with_extension("json.tmp");
    if temp_path.exists() {
        let metadata = fs::symlink_metadata(&temp_path).map_err(|error| {
            PluginPackageTrashError::UnsafeOwnership(format!(
                "cannot inspect purge marker temporary file: {error}"
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || is_reparse(&metadata) {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge marker temporary path is not a regular file".to_string(),
            ));
        }
        fs::remove_file(&temp_path).map_err(|error| {
            PluginPackageTrashError::DeleteFailed(format!(
                "removing incomplete purge marker failed: {error}"
            ))
        })?;
    }
    let bytes = serde_json::to_vec(evidence)
        .map_err(|error| PluginPackageTrashError::ValidationFailed(error.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| {
            PluginPackageTrashError::RenameFailed(format!(
                "creating purge marker temporary file failed: {error}"
            ))
        })?;
    file.write_all(&bytes).map_err(|error| {
        PluginPackageTrashError::RenameFailed(format!("writing purge marker failed: {error}"))
    })?;
    file.sync_all().map_err(|error| {
        PluginPackageTrashError::RenameFailed(format!("syncing purge marker failed: {error}"))
    })?;
    fs::rename(&temp_path, marker_path).map_err(|error| {
        PluginPackageTrashError::RenameFailed(format!("publishing purge marker failed: {error}"))
    })?;
    sync_directory(trash_root)?;
    validate_purge_marker(marker_path, evidence)
}

fn validate_purge_marker(
    marker_path: &Path,
    evidence: &PurgeMarker,
) -> Result<(), PluginPackageTrashError> {
    let metadata = fs::symlink_metadata(marker_path).map_err(|error| {
        PluginPackageTrashError::UnsafeOwnership(format!(
            "cannot inspect exact purge marker: {error}"
        ))
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || is_reparse(&metadata)
        || metadata.len() > 4096
    {
        return Err(PluginPackageTrashError::UnsafeOwnership(
            "exact purge marker is not a bounded regular file".to_string(),
        ));
    }
    let actual: PurgeMarker = serde_json::from_slice(&fs::read(marker_path).map_err(|error| {
        PluginPackageTrashError::ValidationFailed(format!(
            "reading exact purge marker failed: {error}"
        ))
    })?)
    .map_err(|error| {
        PluginPackageTrashError::ValidationFailed(format!(
            "decoding exact purge marker failed: {error}"
        ))
    })?;
    if &actual != evidence {
        return Err(PluginPackageTrashError::UnsafeOwnership(
            "exact purge marker identity changed".to_string(),
        ));
    }
    Ok(())
}

fn validate_bounded_purge_tree(
    directory: &Path,
    depth: usize,
    count: &mut usize,
) -> Result<(), PluginPackageTrashError> {
    if depth > MAX_PURGE_DEPTH {
        return Err(PluginPackageTrashError::UnsafeOwnership(
            "purge tree exceeds its depth budget".to_string(),
        ));
    }
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        PluginPackageTrashError::UnsafeOwnership(format!("cannot inspect purge directory: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse(&metadata) {
        return Err(PluginPackageTrashError::UnsafeOwnership(
            "purge target must remain a real directory".to_string(),
        ));
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| PluginPackageTrashError::DeleteFailed(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginPackageTrashError::DeleteFailed(error.to_string()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        *count = count.checked_add(1).ok_or_else(|| {
            PluginPackageTrashError::UnsafeOwnership("purge entry count overflow".to_string())
        })?;
        if *count > MAX_PURGE_ENTRIES {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge tree exceeds its entry budget".to_string(),
            ));
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            PluginPackageTrashError::UnsafeOwnership(format!("cannot inspect purge entry: {error}"))
        })?;
        if metadata.file_type().is_symlink() || is_reparse(&metadata) {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge tree contains a link or reparse point".to_string(),
            ));
        }
        if metadata.is_dir() {
            validate_bounded_purge_tree(&path, depth + 1, count)?;
        } else if !metadata.is_file() {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge tree contains a non-file entry".to_string(),
            ));
        }
    }
    Ok(())
}

fn remove_bounded_purge_tree(
    directory: &Path,
    depth: usize,
    removed: &mut usize,
    inject_mid: bool,
) -> Result<(), PluginPackageTrashError> {
    if depth > MAX_PURGE_DEPTH {
        return Err(PluginPackageTrashError::UnsafeOwnership(
            "purge deletion exceeds its depth budget".to_string(),
        ));
    }
    let directory_metadata = fs::symlink_metadata(directory).map_err(|error| {
        PluginPackageTrashError::UnsafeOwnership(format!(
            "cannot revalidate purge directory: {error}"
        ))
    })?;
    if directory_metadata.file_type().is_symlink()
        || !directory_metadata.is_dir()
        || is_reparse(&directory_metadata)
    {
        return Err(PluginPackageTrashError::UnsafeOwnership(
            "purge deletion target is not a real directory".to_string(),
        ));
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| PluginPackageTrashError::DeleteFailed(error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginPackageTrashError::DeleteFailed(error.to_string()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            PluginPackageTrashError::UnsafeOwnership(format!(
                "cannot revalidate purge entry: {error}"
            ))
        })?;
        if metadata.file_type().is_symlink() || is_reparse(&metadata) {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge deletion encountered a link or reparse point".to_string(),
            ));
        }
        if metadata.is_dir() {
            remove_bounded_purge_tree(&path, depth + 1, removed, inject_mid)?;
        } else if metadata.is_file() {
            fs::remove_file(&path)
                .map_err(|error| PluginPackageTrashError::DeleteFailed(error.to_string()))?;
        } else {
            return Err(PluginPackageTrashError::UnsafeOwnership(
                "purge deletion encountered a non-file entry".to_string(),
            ));
        }
        *removed += 1;
        if inject_mid && *removed == 1 {
            #[cfg(test)]
            return Err(PluginPackageTrashError::Injected(
                TrashFailurePoint::MidPurgeDelete,
            ));
            #[cfg(not(test))]
            unreachable!();
        }
    }
    fs::remove_dir(directory)
        .map_err(|error| PluginPackageTrashError::DeleteFailed(error.to_string()))?;
    Ok(())
}

fn validate_component(value: &str, label: &str) -> Result<String, PluginPackageTrashError> {
    let value = value.trim();
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 128
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.contains(['/', '\\', ':'])
    {
        return Err(PluginPackageTrashError::InvalidIdentity(format!(
            "invalid {label}"
        )));
    }
    Ok(value.to_string())
}

fn real_directory(path: &Path, label: &str) -> Result<PathBuf, PluginPackageTrashError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        PluginPackageTrashError::UnsafeOwnership(format!("cannot inspect {label}: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse(&metadata) {
        return Err(PluginPackageTrashError::UnsafeOwnership(format!(
            "{label} must be a real directory"
        )));
    }
    fs::canonicalize(path).map_err(|error| {
        PluginPackageTrashError::UnsafeOwnership(format!("cannot canonicalize {label}: {error}"))
    })
}

fn sync_directory(path: &Path) -> Result<(), PluginPackageTrashError> {
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| PluginPackageTrashError::RenameFailed(error.to_string()))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin(project: &Path, directory: &str, plugin_id: &str) -> String {
        let root = project.join(".rho/plugins").join(directory);
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/plugin.wasm"), b"\0asm").unwrap();
        fs::write(
            root.join("rho-plugin.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "id": plugin_id,
                "name": plugin_id,
                "version": "1.0.0",
                "apiVersion": "^1.0",
                "runtime": {"kind":"wasm","entry":"dist/plugin.wasm","scope":"project"}
            }))
            .unwrap(),
        )
        .unwrap();
        rho_extension_runtime::discover_workspace_plugins(project)
            .unwrap()
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id.as_str() == plugin_id)
            .unwrap()
            .digest
            .to_string()
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, String) {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let digest = write_plugin(&project, "example", "org.example.plugin");
        (temporary, project, digest)
    }

    fn with_failure(point: TrashFailurePoint) -> PluginPackageTrash {
        PluginPackageTrash {
            gate: Arc::new(Mutex::new(())),
            failure: Some(point),
        }
    }

    fn move_for_purge(project: &Path, digest: &str, trash_key: &str) {
        PluginPackageTrash::new()
            .move_exact(project, "example", "org.example.plugin", digest, trash_key)
            .unwrap();
    }

    #[test]
    fn move_restore_and_replays_are_exact_and_idempotent() {
        let (_temporary, project, digest) = fixture();
        let trash = PluginPackageTrash::new();
        let moved = trash
            .move_exact(
                &project,
                "example",
                "org.example.plugin",
                &digest,
                "trash.move-a",
            )
            .unwrap();
        assert_eq!(moved.outcome, PluginPackageOwnershipOutcome::Moved);
        assert_eq!(
            trash
                .move_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.move-a"
                )
                .unwrap()
                .outcome,
            PluginPackageOwnershipOutcome::AlreadyMoved
        );
        assert_eq!(
            trash
                .restore_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.move-a"
                )
                .unwrap()
                .outcome,
            PluginPackageOwnershipOutcome::Restored
        );
        assert_eq!(
            trash
                .restore_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.move-a"
                )
                .unwrap()
                .outcome,
            PluginPackageOwnershipOutcome::AlreadyRestored
        );
    }

    #[test]
    fn injected_before_and_after_rename_recover_exactly() {
        for point in [
            TrashFailurePoint::BeforeRename,
            TrashFailurePoint::AfterRename,
        ] {
            let (_temporary, project, digest) = fixture();
            assert!(matches!(
                with_failure(point).move_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.injected"
                ),
                Err(PluginPackageTrashError::Injected(actual)) if actual == point
            ));
            let recovered = PluginPackageTrash::new()
                .move_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.injected",
                )
                .unwrap();
            assert_eq!(
                recovered.outcome,
                if point == TrashFailurePoint::BeforeRename {
                    PluginPackageOwnershipOutcome::Moved
                } else {
                    PluginPackageOwnershipOutcome::AlreadyMoved
                }
            );
        }
    }

    #[test]
    fn wrong_identity_collision_and_two_projects_fail_closed() {
        let (_temporary, project, digest) = fixture();
        let trash = PluginPackageTrash::new();
        assert!(
            trash
                .move_exact(
                    &project,
                    "../example",
                    "org.example.plugin",
                    &digest,
                    "trash.a"
                )
                .is_err()
        );
        assert!(
            trash
                .move_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &"f".repeat(64),
                    "trash.a"
                )
                .is_err()
        );
        fs::create_dir_all(project.join(PLUGIN_TRASH_DIRECTORY).join("trash.collision")).unwrap();
        assert!(
            trash
                .move_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.collision"
                )
                .is_err()
        );

        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(other.path().join(".rho/plugins")).unwrap();
        assert!(
            trash
                .restore_exact(
                    other.path(),
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.a"
                )
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_trash_root_and_restore_collision_are_rejected() {
        let (_temporary, project, digest) = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), project.join(PLUGIN_TRASH_DIRECTORY)).unwrap();
        assert!(
            PluginPackageTrash::new()
                .move_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.link"
                )
                .is_err()
        );

        fs::remove_file(project.join(PLUGIN_TRASH_DIRECTORY)).unwrap();
        let trash = PluginPackageTrash::new();
        trash
            .move_exact(
                &project,
                "example",
                "org.example.plugin",
                &digest,
                "trash.restore",
            )
            .unwrap();
        fs::create_dir_all(project.join(".rho/plugins/example")).unwrap();
        assert!(
            trash
                .restore_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.restore"
                )
                .is_err()
        );
    }

    #[test]
    fn exact_purge_is_bounded_idempotent_and_preserves_siblings() {
        let (_temporary, project, digest) = fixture();
        move_for_purge(&project, &digest, "trash.purge");
        fs::write(
            project.join(PLUGIN_TRASH_DIRECTORY).join("keep.txt"),
            b"keep",
        )
        .unwrap();
        let trash = PluginPackageTrash::new();
        let purged = trash
            .purge_exact(
                &project,
                "example",
                "org.example.plugin",
                &digest,
                "trash.purge",
            )
            .unwrap();
        assert_eq!(purged.outcome, PluginPackageOwnershipOutcome::Purged);
        assert!(
            project
                .join(PLUGIN_TRASH_DIRECTORY)
                .join("keep.txt")
                .is_file()
        );
        assert!(!project.join(".rho/plugins/example").exists());
        assert_eq!(
            trash
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.purge",
                )
                .unwrap()
                .outcome,
            PluginPackageOwnershipOutcome::AlreadyPurged
        );
    }

    #[test]
    fn purge_interruptions_recover_from_exact_marker_and_ownership() {
        for point in [
            TrashFailurePoint::BeforePurgeRename,
            TrashFailurePoint::AfterPurgeRename,
            TrashFailurePoint::MidPurgeDelete,
            TrashFailurePoint::AfterPurgeDelete,
        ] {
            let (_temporary, project, digest) = fixture();
            move_for_purge(&project, &digest, "trash.interrupted");
            assert!(matches!(
                with_failure(point).purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.interrupted",
                ),
                Err(PluginPackageTrashError::Injected(actual)) if actual == point
            ));
            let recovered = PluginPackageTrash::new()
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.interrupted",
                )
                .unwrap();
            assert_eq!(
                recovered.outcome,
                if point == TrashFailurePoint::AfterPurgeDelete {
                    PluginPackageOwnershipOutcome::AlreadyPurged
                } else {
                    PluginPackageOwnershipOutcome::Purged
                }
            );
        }
    }

    #[test]
    fn purge_rejects_discovery_collision_wrong_identity_and_foreign_project() {
        let (_temporary, project, digest) = fixture();
        move_for_purge(&project, &digest, "trash.identity");
        assert!(
            PluginPackageTrash::new()
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &"f".repeat(64),
                    "trash.identity",
                )
                .is_err()
        );
        PluginPackageTrash::new()
            .restore_exact(
                &project,
                "example",
                "org.example.plugin",
                &digest,
                "trash.identity",
            )
            .unwrap();
        assert!(
            PluginPackageTrash::new()
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.identity",
                )
                .is_err()
        );

        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(other.path().join(".rho/plugins")).unwrap();
        fs::create_dir_all(other.path().join(PLUGIN_TRASH_DIRECTORY)).unwrap();
        assert!(
            PluginPackageTrash::new()
                .purge_exact(
                    other.path(),
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.identity",
                )
                .is_err()
        );
        assert!(project.join(".rho/plugins/example").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn purge_rejects_link_marker_tampering_and_overdeep_partial_tree() {
        let (_temporary, project, digest) = fixture();
        move_for_purge(&project, &digest, "trash.tamper");
        let target = project.join(PLUGIN_TRASH_DIRECTORY).join("trash.tamper");
        std::os::unix::fs::symlink("rho-plugin.json", target.join("linked.json")).unwrap();
        assert!(
            PluginPackageTrash::new()
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.tamper",
                )
                .is_err()
        );
        fs::remove_file(target.join("linked.json")).unwrap();
        assert!(matches!(
            with_failure(TrashFailurePoint::AfterPurgeRename).purge_exact(
                &project,
                "example",
                "org.example.plugin",
                &digest,
                "trash.tamper",
            ),
            Err(PluginPackageTrashError::Injected(
                TrashFailurePoint::AfterPurgeRename
            ))
        ));
        let trash_root = project.join(PLUGIN_TRASH_DIRECTORY);
        let marker = fs::read_dir(&trash_root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|value| value == "json"))
            .unwrap();
        fs::write(&marker, b"{}").unwrap();
        assert!(
            PluginPackageTrash::new()
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.tamper",
                )
                .is_err()
        );

        let (_temporary, project, digest) = fixture();
        move_for_purge(&project, &digest, "trash.deep");
        assert!(matches!(
            with_failure(TrashFailurePoint::AfterPurgeRename).purge_exact(
                &project,
                "example",
                "org.example.plugin",
                &digest,
                "trash.deep",
            ),
            Err(PluginPackageTrashError::Injected(
                TrashFailurePoint::AfterPurgeRename
            ))
        ));
        let purging = fs::read_dir(project.join(PLUGIN_TRASH_DIRECTORY))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
            .unwrap();
        let mut nested = purging;
        for index in 0..=MAX_PURGE_DEPTH {
            nested = nested.join(format!("depth-{index}"));
            fs::create_dir(&nested).unwrap();
        }
        assert!(
            PluginPackageTrash::new()
                .purge_exact(
                    &project,
                    "example",
                    "org.example.plugin",
                    &digest,
                    "trash.deep",
                )
                .is_err()
        );
    }
}
