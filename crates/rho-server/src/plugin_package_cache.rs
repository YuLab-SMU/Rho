//! Broker-owned immutable cache for exact workspace-plugin packages.
//!
//! The cache has no guest-facing API. It copies one already validated package
//! snapshot into app-local storage, verifies the complete inventory after an
//! atomic rename, and returns only typed evidence plus bounded file bytes.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use rho_extension_runtime::{
    MAX_PACKAGE_AGGREGATE_BYTES, PackageDigest, PluginId, WorkspacePluginPackageSnapshot,
    snapshot_workspace_plugin_cache_directory, snapshot_workspace_plugin_package,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PLUGIN_PACKAGE_CACHE_DIRECTORY: &str = "plugin-package-cache";
pub const MAX_CACHED_PLUGIN_DIGESTS: usize = 3;
pub const MAX_PROJECT_PLUGIN_CACHE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedPluginPackage {
    pub project_cache_key: String,
    pub plugin_id: String,
    pub package_digest: String,
    pub snapshot: WorkspacePluginPackageSnapshot,
}

impl CachedPluginPackage {
    pub fn file_bytes(&self, relative_path: &str) -> Option<&[u8]> {
        self.snapshot.file_bytes(relative_path)
    }
}

#[derive(Debug, Error)]
pub enum PluginPackageCacheError {
    #[error("workspace plugin cache project identity is empty")]
    InvalidProject,
    #[error("workspace plugin cache identity is invalid: {0}")]
    InvalidIdentity(String),
    #[error("workspace plugin source package was rejected: {0}")]
    SourceRejected(String),
    #[error("workspace plugin cache containment was rejected: {0}")]
    UnsafeCache(String),
    #[error("workspace plugin cache bound was exceeded: {0}")]
    BoundExceeded(String),
    #[error("workspace plugin cache write failed: {0}")]
    WriteFailed(String),
    #[error("workspace plugin cache read-back failed: {0}")]
    ReadbackFailed(String),
    #[cfg(test)]
    #[error("injected workspace plugin cache failure: {0:?}")]
    Injected(CacheFailurePoint),
}

#[derive(Debug, Clone, Copy)]
struct CacheLimits {
    digests_per_plugin: usize,
    project_bytes: u64,
}

impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            digests_per_plugin: MAX_CACHED_PLUGIN_DIGESTS,
            project_bytes: MAX_PROJECT_PLUGIN_CACHE_BYTES,
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheFailurePoint {
    AfterFirstFile,
    BeforeRename,
    AfterRename,
}

#[derive(Debug, Clone)]
pub struct PluginPackageCache {
    root: PathBuf,
    limits: CacheLimits,
    gate: Arc<Mutex<()>>,
    #[cfg(test)]
    failure: Option<CacheFailurePoint>,
}

impl PluginPackageCache {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        Self {
            root: app_data_dir.as_ref().join(PLUGIN_PACKAGE_CACHE_DIRECTORY),
            limits: CacheLimits::default(),
            gate: Arc::new(Mutex::new(())),
            #[cfg(test)]
            failure: None,
        }
    }

    /// Copy and verify one exact package from a project discovery root.
    pub fn prepare_exact(
        &self,
        project_root: &Path,
        plugin_id: &str,
        expected_digest: &str,
    ) -> Result<CachedPluginPackage, PluginPackageCacheError> {
        let normalized_project_root = normalize_project_root(project_root)?;
        let plugin_id = PluginId::new(plugin_id.to_string())
            .map_err(|error| PluginPackageCacheError::InvalidIdentity(error.to_string()))?;
        let digest = PackageDigest::parse(expected_digest.to_string())
            .map_err(|error| PluginPackageCacheError::InvalidIdentity(error.to_string()))?;
        let source = snapshot_workspace_plugin_package(project_root, plugin_id.as_str(), &digest)
            .map_err(|error| PluginPackageCacheError::SourceRejected(error.to_string()))?;
        if source.aggregate_bytes > MAX_PACKAGE_AGGREGATE_BYTES {
            return Err(PluginPackageCacheError::BoundExceeded(
                "source snapshot exceeds the package byte bound".to_string(),
            ));
        }
        let _gate = self
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.store_snapshot(&normalized_project_root, &plugin_id, &digest, &source)
    }

    /// Load a previously cached exact package without consulting mutable source
    /// files. Used only by trusted lifecycle recovery.
    pub fn load_exact(
        &self,
        normalized_project_root: &str,
        plugin_id: &str,
        expected_digest: &str,
    ) -> Result<CachedPluginPackage, PluginPackageCacheError> {
        let normalized_project_root = normalize_project_identity(normalized_project_root)?;
        let plugin_id = PluginId::new(plugin_id.to_string())
            .map_err(|error| PluginPackageCacheError::InvalidIdentity(error.to_string()))?;
        let digest = PackageDigest::parse(expected_digest.to_string())
            .map_err(|error| PluginPackageCacheError::InvalidIdentity(error.to_string()))?;
        let _gate = self
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (project_cache_key, project_directory, _plugin_directory, target) =
            self.resolve_directories(&normalized_project_root, &plugin_id, &digest, false)?;
        inspect_project_cache(&project_directory, plugin_id.as_str(), self.limits)?;
        let snapshot = self.read_back(&target, &plugin_id, &digest)?;
        Ok(CachedPluginPackage {
            project_cache_key,
            plugin_id: plugin_id.to_string(),
            package_digest: digest.to_string(),
            snapshot,
        })
    }

    fn store_snapshot(
        &self,
        normalized_project_root: &str,
        plugin_id: &PluginId,
        digest: &PackageDigest,
        source: &WorkspacePluginPackageSnapshot,
    ) -> Result<CachedPluginPackage, PluginPackageCacheError> {
        let (project_cache_key, project_directory, plugin_directory, target) =
            self.resolve_directories(normalized_project_root, plugin_id, digest, true)?;
        let inspection =
            inspect_project_cache(&project_directory, plugin_id.as_str(), self.limits)?;
        if target.exists() {
            let snapshot = self.read_back(&target, plugin_id, digest)?;
            make_tree_read_only(&target)?;
            return Ok(CachedPluginPackage {
                project_cache_key,
                plugin_id: plugin_id.to_string(),
                package_digest: digest.to_string(),
                snapshot,
            });
        }
        if inspection.requested_plugin_digests >= self.limits.digests_per_plugin {
            return Err(PluginPackageCacheError::BoundExceeded(format!(
                "plugin retains {} digests; maximum is {}",
                inspection.requested_plugin_digests, self.limits.digests_per_plugin
            )));
        }
        let source_bytes = u64::try_from(source.aggregate_bytes).map_err(|_| {
            PluginPackageCacheError::BoundExceeded("package size is not representable".to_string())
        })?;
        if inspection
            .total_bytes
            .checked_add(source_bytes)
            .is_none_or(|total| total > self.limits.project_bytes)
        {
            return Err(PluginPackageCacheError::BoundExceeded(format!(
                "project cache would exceed {} bytes",
                self.limits.project_bytes
            )));
        }

        let temporary = plugin_directory.join(format!(
            ".tmp.{}.{}",
            digest.as_str(),
            uuid::Uuid::new_v4().simple()
        ));
        create_private_directory(&temporary)?;
        let write_result = self.write_snapshot(&temporary, source);
        if let Err(error) = write_result {
            cleanup_temporary(&plugin_directory, &temporary);
            return Err(error);
        }
        #[cfg(test)]
        if self.failure == Some(CacheFailurePoint::BeforeRename) {
            cleanup_temporary(&plugin_directory, &temporary);
            return Err(PluginPackageCacheError::Injected(
                CacheFailurePoint::BeforeRename,
            ));
        }
        sync_directory(&temporary)?;
        match fs::rename(&temporary, &target) {
            Ok(()) => {}
            Err(_error) if target.exists() => {
                cleanup_temporary(&plugin_directory, &temporary);
                let snapshot = self.read_back(&target, plugin_id, digest)?;
                make_tree_read_only(&target)?;
                return Ok(CachedPluginPackage {
                    project_cache_key,
                    plugin_id: plugin_id.to_string(),
                    package_digest: digest.to_string(),
                    snapshot,
                });
            }
            Err(error) => {
                cleanup_temporary(&plugin_directory, &temporary);
                return Err(PluginPackageCacheError::WriteFailed(format!(
                    "atomic package publication failed: {error}"
                )));
            }
        }
        sync_directory(&plugin_directory)?;
        #[cfg(test)]
        if self.failure == Some(CacheFailurePoint::AfterRename) {
            return Err(PluginPackageCacheError::Injected(
                CacheFailurePoint::AfterRename,
            ));
        }
        let snapshot = self.read_back(&target, plugin_id, digest)?;
        make_tree_read_only(&target)?;
        Ok(CachedPluginPackage {
            project_cache_key,
            plugin_id: plugin_id.to_string(),
            package_digest: digest.to_string(),
            snapshot,
        })
    }

    fn write_snapshot(
        &self,
        temporary: &Path,
        source: &WorkspacePluginPackageSnapshot,
    ) -> Result<(), PluginPackageCacheError> {
        for file in &source.files {
            let relative = validated_relative_path(&file.relative_path)?;
            let destination = temporary.join(relative);
            let parent = destination.parent().ok_or_else(|| {
                PluginPackageCacheError::UnsafeCache(
                    "package file has no temporary parent".to_string(),
                )
            })?;
            create_private_directory_tree(temporary, parent)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&destination).map_err(|error| {
                PluginPackageCacheError::WriteFailed(format!(
                    "creating cached package file failed: {error}"
                ))
            })?;
            output.write_all(&file.bytes).map_err(|error| {
                PluginPackageCacheError::WriteFailed(format!(
                    "writing cached package file failed: {error}"
                ))
            })?;
            output.sync_all().map_err(|error| {
                PluginPackageCacheError::WriteFailed(format!(
                    "syncing cached package file failed: {error}"
                ))
            })?;
            #[cfg(test)]
            if source
                .files
                .first()
                .is_some_and(|first| std::ptr::eq(first, file))
                && self.failure == Some(CacheFailurePoint::AfterFirstFile)
            {
                return Err(PluginPackageCacheError::Injected(
                    CacheFailurePoint::AfterFirstFile,
                ));
            }
        }
        Ok(())
    }

    fn resolve_directories(
        &self,
        normalized_project_root: &str,
        plugin_id: &PluginId,
        digest: &PackageDigest,
        create: bool,
    ) -> Result<(String, PathBuf, PathBuf, PathBuf), PluginPackageCacheError> {
        if create {
            create_private_directory(&self.root)?;
        }
        ensure_real_directory(&self.root)?;
        let project_cache_key = project_cache_key(normalized_project_root);
        let project_directory = self.root.join(&project_cache_key);
        let plugin_directory = project_directory.join(plugin_id.as_str());
        if create {
            create_private_directory(&project_directory)?;
            create_private_directory(&plugin_directory)?;
        }
        ensure_real_directory(&project_directory)?;
        ensure_real_directory(&plugin_directory)?;
        let target = plugin_directory.join(digest.as_str());
        Ok((
            project_cache_key,
            project_directory,
            plugin_directory,
            target,
        ))
    }

    fn read_back(
        &self,
        target: &Path,
        plugin_id: &PluginId,
        digest: &PackageDigest,
    ) -> Result<WorkspacePluginPackageSnapshot, PluginPackageCacheError> {
        snapshot_workspace_plugin_cache_directory(target, plugin_id, digest)
            .map_err(|error| PluginPackageCacheError::ReadbackFailed(error.to_string()))
    }
}

fn normalize_project_root(project_root: &Path) -> Result<String, PluginPackageCacheError> {
    normalize_project_identity(&rho_store::normalize_project_root(
        project_root.to_string_lossy().as_ref(),
    ))
}

fn normalize_project_identity(value: &str) -> Result<String, PluginPackageCacheError> {
    let value = rho_store::normalize_project_root(value);
    if value.trim().is_empty() {
        Err(PluginPackageCacheError::InvalidProject)
    } else {
        Ok(value)
    }
}

fn project_cache_key(normalized_project_root: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_project_root.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validated_relative_path(value: &str) -> Result<PathBuf, PluginPackageCacheError> {
    if value.is_empty() || value.contains('\\') {
        return Err(PluginPackageCacheError::UnsafeCache(
            "package snapshot path is empty or non-canonical".to_string(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PluginPackageCacheError::UnsafeCache(
            "package snapshot path is not a contained relative path".to_string(),
        ));
    }
    Ok(path.to_path_buf())
}

fn create_private_directory(path: &Path) -> Result<(), PluginPackageCacheError> {
    match fs::create_dir(path) {
        Ok(()) => set_private_directory_permissions(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(PluginPackageCacheError::WriteFailed(format!(
                "creating cache directory {} failed: {error}",
                path.display()
            )));
        }
    }
    ensure_real_directory(path)
}

fn create_private_directory_tree(
    root: &Path,
    destination: &Path,
) -> Result<(), PluginPackageCacheError> {
    let relative = destination.strip_prefix(root).map_err(|_| {
        PluginPackageCacheError::UnsafeCache(
            "cached package parent escaped its temporary root".to_string(),
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(PluginPackageCacheError::UnsafeCache(
                "cached package directory is not canonical".to_string(),
            ));
        };
        current.push(component);
        create_private_directory(&current)?;
    }
    Ok(())
}

fn ensure_real_directory(path: &Path) -> Result<(), PluginPackageCacheError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        PluginPackageCacheError::UnsafeCache(format!(
            "cannot inspect cache directory {}: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || is_reparse(&metadata) {
        return Err(PluginPackageCacheError::UnsafeCache(format!(
            "cache directory {} is not a real directory",
            path.display()
        )));
    }
    Ok(())
}

struct ProjectCacheInspection {
    total_bytes: u64,
    requested_plugin_digests: usize,
}

fn inspect_project_cache(
    project_directory: &Path,
    requested_plugin_id: &str,
    limits: CacheLimits,
) -> Result<ProjectCacheInspection, PluginPackageCacheError> {
    let mut total_bytes = 0u64;
    let mut requested_plugin_digests = 0usize;
    for plugin_entry in read_directory(project_directory)? {
        let plugin_name = plugin_entry.file_name().into_string().map_err(|_| {
            PluginPackageCacheError::UnsafeCache(
                "project cache contains a non-UTF-8 plugin entry".to_string(),
            )
        })?;
        let plugin_id = PluginId::new(plugin_name.clone()).map_err(|_| {
            PluginPackageCacheError::UnsafeCache(
                "project cache contains an invalid plugin directory".to_string(),
            )
        })?;
        ensure_real_directory(&plugin_entry.path())?;
        let mut digest_count = 0usize;
        for digest_entry in read_directory(&plugin_entry.path())? {
            let digest_name = digest_entry.file_name().into_string().map_err(|_| {
                PluginPackageCacheError::UnsafeCache(
                    "plugin cache contains a non-UTF-8 digest entry".to_string(),
                )
            })?;
            let digest = PackageDigest::parse(digest_name).map_err(|_| {
                PluginPackageCacheError::UnsafeCache(
                    "plugin cache contains an unexpected digest entry".to_string(),
                )
            })?;
            ensure_real_directory(&digest_entry.path())?;
            let snapshot = snapshot_workspace_plugin_cache_directory(
                &digest_entry.path(),
                &plugin_id,
                &digest,
            )
            .map_err(|error| PluginPackageCacheError::ReadbackFailed(error.to_string()))?;
            let bytes = u64::try_from(snapshot.aggregate_bytes).map_err(|_| {
                PluginPackageCacheError::BoundExceeded(
                    "cached package size is not representable".to_string(),
                )
            })?;
            total_bytes = total_bytes.checked_add(bytes).ok_or_else(|| {
                PluginPackageCacheError::BoundExceeded(
                    "project cache byte count overflowed".to_string(),
                )
            })?;
            digest_count += 1;
        }
        if plugin_name == requested_plugin_id {
            requested_plugin_digests = digest_count;
        }
        if digest_count > limits.digests_per_plugin {
            return Err(PluginPackageCacheError::BoundExceeded(format!(
                "plugin cache contains {digest_count} digests; maximum is {}",
                limits.digests_per_plugin
            )));
        }
    }
    if total_bytes > limits.project_bytes {
        return Err(PluginPackageCacheError::BoundExceeded(format!(
            "project cache contains {total_bytes} bytes; maximum is {}",
            limits.project_bytes
        )));
    }
    Ok(ProjectCacheInspection {
        total_bytes,
        requested_plugin_digests,
    })
}

fn read_directory(path: &Path) -> Result<Vec<fs::DirEntry>, PluginPackageCacheError> {
    let entries = fs::read_dir(path).map_err(|error| {
        PluginPackageCacheError::UnsafeCache(format!(
            "cannot read cache directory {}: {error}",
            path.display()
        ))
    })?;
    entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(cache_inspection_error)
}

fn cache_inspection_error(error: std::io::Error) -> PluginPackageCacheError {
    PluginPackageCacheError::UnsafeCache(format!("cache inspection failed: {error}"))
}

fn sync_directory(path: &Path) -> Result<(), PluginPackageCacheError> {
    #[cfg(unix)]
    {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                PluginPackageCacheError::WriteFailed(format!(
                    "syncing cache directory {} failed: {error}",
                    path.display()
                ))
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn make_tree_read_only(path: &Path) -> Result<(), PluginPackageCacheError> {
    let mut directories = vec![path.to_path_buf()];
    let mut index = 0usize;
    while index < directories.len() {
        let directory = directories[index].clone();
        index += 1;
        for entry in read_directory(&directory)? {
            let metadata = fs::symlink_metadata(entry.path()).map_err(cache_inspection_error)?;
            if metadata.file_type().is_symlink() || is_reparse(&metadata) {
                return Err(PluginPackageCacheError::UnsafeCache(
                    "cache changed to a link before sealing".to_string(),
                ));
            }
            if metadata.is_dir() {
                directories.push(entry.path());
            } else if metadata.is_file() {
                set_read_only_file_permissions(&entry.path())?;
            } else {
                return Err(PluginPackageCacheError::UnsafeCache(
                    "cache changed to a non-file before sealing".to_string(),
                ));
            }
        }
    }
    for directory in directories.into_iter().rev() {
        set_read_only_directory_permissions(&directory)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), PluginPackageCacheError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        PluginPackageCacheError::WriteFailed(format!(
            "setting private directory permissions failed: {error}"
        ))
    })
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), PluginPackageCacheError> {
    Ok(())
}

#[cfg(unix)]
fn set_read_only_file_permissions(path: &Path) -> Result<(), PluginPackageCacheError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).map_err(|error| {
        PluginPackageCacheError::WriteFailed(format!("sealing cached package file failed: {error}"))
    })
}

#[cfg(not(unix))]
fn set_read_only_file_permissions(path: &Path) -> Result<(), PluginPackageCacheError> {
    let mut permissions = fs::metadata(path)
        .map_err(cache_inspection_error)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|error| {
        PluginPackageCacheError::WriteFailed(format!("sealing cached package file failed: {error}"))
    })
}

#[cfg(unix)]
fn set_read_only_directory_permissions(path: &Path) -> Result<(), PluginPackageCacheError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o500)).map_err(|error| {
        PluginPackageCacheError::WriteFailed(format!(
            "sealing cached package directory failed: {error}"
        ))
    })
}

#[cfg(not(unix))]
fn set_read_only_directory_permissions(_path: &Path) -> Result<(), PluginPackageCacheError> {
    Ok(())
}

fn cleanup_temporary(plugin_directory: &Path, temporary: &Path) {
    let safe = temporary.parent() == Some(plugin_directory)
        && temporary
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".tmp."));
    if safe {
        let _ = fs::remove_dir_all(temporary);
    }
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

    fn write_plugin(project: &Path, id: &str, version: &str, module: &[u8]) -> PackageDigest {
        let plugin = project.join(".rho/plugins").join(id);
        fs::create_dir_all(plugin.join("dist")).unwrap();
        fs::write(plugin.join("dist/plugin.wasm"), module).unwrap();
        fs::write(
            plugin.join("rho-plugin.json"),
            format!(
                r#"{{
                    "schemaVersion": 1,
                    "id": "{id}",
                    "name": "Cache fixture",
                    "version": "{version}",
                    "apiVersion": "^1.0",
                    "runtime": {{"kind":"wasm","entry":"dist/plugin.wasm","scope":"project"}}
                }}"#
            ),
        )
        .unwrap();
        rho_extension_runtime::discover_workspace_plugins(project)
            .unwrap()
            .unwrap()
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id.as_str() == id)
            .unwrap()
            .digest
    }

    fn cache_with_failure(data: &Path, failure: CacheFailurePoint) -> PluginPackageCache {
        PluginPackageCache {
            root: data.join(PLUGIN_PACKAGE_CACHE_DIRECTORY),
            limits: CacheLimits::default(),
            gate: Arc::new(Mutex::new(())),
            failure: Some(failure),
        }
    }

    #[test]
    fn exact_cache_is_idempotent_immutable_and_source_independent() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();
        let digest = write_plugin(&project, "org.example.cache", "1.0.0", b"\0asm");
        let cache = PluginPackageCache::new(&data);
        let first = cache
            .prepare_exact(&project, "org.example.cache", digest.as_str())
            .unwrap();
        let second = cache
            .prepare_exact(&project, "org.example.cache", digest.as_str())
            .unwrap();
        assert_eq!(first.project_cache_key, second.project_cache_key);
        assert_eq!(
            first.file_bytes("dist/plugin.wasm"),
            Some(b"\0asm".as_slice())
        );
        assert_eq!(first.snapshot, second.snapshot);

        fs::write(
            project.join(".rho/plugins/org.example.cache/dist/plugin.wasm"),
            b"changed source",
        )
        .unwrap();
        assert!(
            cache
                .prepare_exact(&project, "org.example.cache", digest.as_str())
                .is_err()
        );
        let loaded = cache
            .load_exact(
                &rho_store::normalize_project_root(project.to_string_lossy().as_ref()),
                "org.example.cache",
                digest.as_str(),
            )
            .unwrap();
        assert_eq!(
            loaded.file_bytes("dist/plugin.wasm"),
            Some(b"\0asm".as_slice())
        );
    }

    #[test]
    fn identical_plugin_identity_is_separated_by_project_hash() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let cache = PluginPackageCache::new(&data);
        let mut keys = Vec::new();
        for project_name in ["project-a", "project-b"] {
            let project = directory.path().join(project_name);
            fs::create_dir_all(&project).unwrap();
            let digest = write_plugin(&project, "org.example.same", "1.0.0", b"same");
            keys.push(
                cache
                    .prepare_exact(&project, "org.example.same", digest.as_str())
                    .unwrap()
                    .project_cache_key,
            );
        }
        assert_ne!(keys[0], keys[1]);
    }

    #[test]
    fn concurrent_exact_prepares_converge_on_one_verified_target() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();
        let digest = write_plugin(&project, "org.example.concurrent", "1.0.0", b"same");
        let cache = Arc::new(PluginPackageCache::new(&data));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let barrier = Arc::clone(&barrier);
                let project = project.clone();
                let digest = digest.to_string();
                std::thread::spawn(move || {
                    barrier.wait();
                    cache
                        .prepare_exact(&project, "org.example.concurrent", &digest)
                        .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let prepared = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(prepared[0].snapshot, prepared[1].snapshot);
        let project_directory = cache.root.join(&prepared[0].project_cache_key);
        let inspection = inspect_project_cache(
            &project_directory,
            "org.example.concurrent",
            CacheLimits::default(),
        )
        .unwrap();
        assert_eq!(inspection.requested_plugin_digests, 1);
    }

    #[test]
    fn unexpected_cache_entries_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();
        let digest = write_plugin(&project, "org.example.unexpected", "1.0.0", b"same");
        let cache = PluginPackageCache::new(&data);
        let prepared = cache
            .prepare_exact(&project, "org.example.unexpected", digest.as_str())
            .unwrap();
        fs::write(
            cache
                .root
                .join(prepared.project_cache_key)
                .join("unexpected"),
            b"not a plugin directory",
        )
        .unwrap();
        assert!(matches!(
            cache.prepare_exact(&project, "org.example.unexpected", digest.as_str()),
            Err(PluginPackageCacheError::UnsafeCache(_))
        ));
    }

    #[test]
    fn injected_write_and_pre_rename_failures_leave_no_partial_target() {
        for failure in [
            CacheFailurePoint::AfterFirstFile,
            CacheFailurePoint::BeforeRename,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let project = directory.path().join("project");
            let data = directory.path().join("data");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(&data).unwrap();
            let digest = write_plugin(&project, "org.example.failure", "1.0.0", b"failure");
            let cache = cache_with_failure(&data, failure);
            assert!(
                matches!(
                    cache.prepare_exact(&project, "org.example.failure", digest.as_str()),
                    Err(PluginPackageCacheError::Injected(point)) if point == failure
                ),
                "failure point {failure:?} did not fire"
            );
            let plugin_directory = cache
                .root
                .join(project_cache_key(&rho_store::normalize_project_root(
                    project.to_string_lossy().as_ref(),
                )))
                .join("org.example.failure");
            assert!(read_directory(&plugin_directory).unwrap().is_empty());
        }
    }

    #[test]
    fn post_rename_interruption_is_recovered_by_exact_readback() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();
        let digest = write_plugin(&project, "org.example.recover", "1.0.0", b"recover");
        let failing = cache_with_failure(&data, CacheFailurePoint::AfterRename);
        assert!(matches!(
            failing.prepare_exact(&project, "org.example.recover", digest.as_str()),
            Err(PluginPackageCacheError::Injected(
                CacheFailurePoint::AfterRename
            ))
        ));
        let recovered = PluginPackageCache::new(&data)
            .prepare_exact(&project, "org.example.recover", digest.as_str())
            .unwrap();
        assert_eq!(
            recovered.file_bytes("dist/plugin.wasm"),
            Some(b"recover".as_slice())
        );
    }

    #[test]
    fn digest_and_project_bounds_refuse_without_evicting() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();
        let cache = PluginPackageCache {
            root: data.join(PLUGIN_PACKAGE_CACHE_DIRECTORY),
            limits: CacheLimits {
                digests_per_plugin: 2,
                project_bytes: 16 * 1024,
            },
            gate: Arc::new(Mutex::new(())),
            failure: None,
        };
        for index in 0..2 {
            let digest = write_plugin(
                &project,
                "org.example.bounds",
                &format!("1.0.{index}"),
                format!("module-{index}").as_bytes(),
            );
            cache
                .prepare_exact(&project, "org.example.bounds", digest.as_str())
                .unwrap();
        }
        let third = write_plugin(&project, "org.example.bounds", "1.0.2", b"module-2");
        assert!(matches!(
            cache.prepare_exact(&project, "org.example.bounds", third.as_str()),
            Err(PluginPackageCacheError::BoundExceeded(_))
        ));

        let large = write_plugin(
            &project,
            "org.example.large",
            "1.0.0",
            &vec![b'x'; 20 * 1024],
        );
        assert!(matches!(
            cache.prepare_exact(&project, "org.example.large", large.as_str()),
            Err(PluginPackageCacheError::BoundExceeded(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cache_root_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let data = directory.path().join("data");
        let outside = directory.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, data.join(PLUGIN_PACKAGE_CACHE_DIRECTORY)).unwrap();
        let digest = write_plugin(&project, "org.example.link", "1.0.0", b"link");
        assert!(matches!(
            PluginPackageCache::new(&data).prepare_exact(
                &project,
                "org.example.link",
                digest.as_str()
            ),
            Err(PluginPackageCacheError::UnsafeCache(_))
        ));
    }
}
