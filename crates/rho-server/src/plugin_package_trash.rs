//! Broker-owned recoverable moves for project-local plugin packages.
//!
//! This module owns only exact, same-filesystem rename/restore evidence. It
//! does not update SQLite, delete recursively, activate code, or expose paths
//! to guest code.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rho_extension_runtime::{
    PackageDigest, PluginId, snapshot_workspace_plugin_cache_directory,
    snapshot_workspace_plugin_package,
};
use thiserror::Error;

pub const PLUGIN_TRASH_DIRECTORY: &str = ".rho/plugin-trash";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginPackageOwnershipOutcome {
    Moved,
    AlreadyMoved,
    Restored,
    AlreadyRestored,
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
    #[cfg(test)]
    #[error("injected plugin package move failure: {0:?}")]
    Injected(TrashFailurePoint),
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashFailurePoint {
    BeforeRename,
    AfterRename,
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
}
