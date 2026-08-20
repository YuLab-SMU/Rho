//! Broker-owned workspace plugin discovery (Phase 2, P2-0).
//!
//! Discovery only produces bounded, disabled metadata. It never executes code,
//! never loads an entry point, and never grants authority. The discovery root
//! is the canonical normalized `<project-root>/.rho/plugins/`; every referenced
//! file must be a regular file contained inside its plugin directory with no
//! symlink, junction, absolute-path, parent-traversal, device, or
//! case-collision escape.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::digest::PackageDigest;
use crate::manifest::{
    MAX_MANIFEST_BYTES, MAX_PACKAGE_AGGREGATE_BYTES, MAX_PACKAGE_DEPTH, MAX_PACKAGE_FILE_BYTES,
    MAX_PACKAGE_FILES, MAX_RELATIVE_PATH_BYTES, WorkspacePluginManifest,
};
use crate::{ExtensionError, PluginId};

/// The relative entry directory under the project root.
pub const PLUGINS_DIR: &str = ".rho/plugins";
/// The manifest file name inside each plugin directory.
pub const MANIFEST_NAME: &str = "rho-plugin.json";

/// A discovered-but-disabled plugin package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredPlugin {
    /// The plugin directory name (a single path component).
    pub directory: String,
    /// Validated manifest.
    pub manifest: WorkspacePluginManifest,
    /// Host-computed package digest.
    pub digest: PackageDigest,
}

/// Discovery outcome. All plugins are disabled regardless of whether any
/// individual package failed validation; failures are reported, never executed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryReport {
    pub plugins: Vec<DiscoveredPlugin>,
    pub failures: Vec<DiscoveryFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryFailure {
    pub path: String,
    pub reason: String,
}

/// One immutable, bounded file captured from an exact plugin package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePluginPackageFile {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

/// A read-only package snapshot whose inventory recomputes to `digest`.
///
/// This is trusted-host evidence, not a guest capability. It contains no
/// absolute source path and cannot mutate either the project or a cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePluginPackageSnapshot {
    pub manifest: WorkspacePluginManifest,
    pub digest: PackageDigest,
    pub files: Vec<WorkspacePluginPackageFile>,
    pub aggregate_bytes: usize,
}

impl WorkspacePluginPackageSnapshot {
    pub fn file_bytes(&self, relative_path: &str) -> Option<&[u8]> {
        let relative_path = normalize_manifest_relative(relative_path);
        self.files
            .binary_search_by(|file| file.relative_path.as_str().cmp(&relative_path))
            .ok()
            .map(|index| self.files[index].bytes.as_slice())
    }
}

/// Revalidate and snapshot one exact package from a project discovery root.
///
/// Discovery is repeated after the bounded read so root/package replacement
/// cannot silently change the identity accepted by the caller.
pub fn snapshot_workspace_plugin_package(
    project_root: &Path,
    plugin_id: &str,
    expected_digest: &PackageDigest,
) -> Result<WorkspacePluginPackageSnapshot, ExtensionError> {
    let plugin_id = PluginId::new(plugin_id.to_string())?;
    let discovered = find_exact_discovered_plugin(project_root, &plugin_id, expected_digest)?;
    let package_directory = project_root.join(PLUGINS_DIR).join(&discovered.directory);
    let snapshot =
        snapshot_workspace_plugin_cache_directory(&package_directory, &plugin_id, expected_digest)?;
    let revalidated = find_exact_discovered_plugin(project_root, &plugin_id, expected_digest)?;
    if revalidated.directory != discovered.directory
        || revalidated.manifest != snapshot.manifest
        || revalidated.digest != snapshot.digest
    {
        return Err(ExtensionError::InvalidPackageTree {
            reason: "plugin package changed while its exact snapshot was read".to_string(),
        });
    }
    Ok(snapshot)
}

/// Validate and read back an app-controlled cached package directory.
///
/// The caller owns containment of `package_directory`; this function proves
/// only that the directory itself is real, bounded, symlink-free, manifest
/// compatible, and hashes to the exact expected package identity.
pub fn snapshot_workspace_plugin_cache_directory(
    package_directory: &Path,
    expected_plugin_id: &PluginId,
    expected_digest: &PackageDigest,
) -> Result<WorkspacePluginPackageSnapshot, ExtensionError> {
    let metadata = fs::symlink_metadata(package_directory).map_err(|error| {
        ExtensionError::InvalidPackageTree {
            reason: format!(
                "cannot stat package directory {}: {error}",
                package_directory.display()
            ),
        }
    })?;
    if is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(ExtensionError::InvalidPackageTree {
            reason: "package snapshot root must be a real directory".to_string(),
        });
    }
    let package_directory = fs::canonicalize(package_directory).map_err(|error| {
        ExtensionError::InvalidPackageTree {
            reason: format!("cannot canonicalize package snapshot root: {error}"),
        }
    })?;
    let manifest_path = package_directory.join(MANIFEST_NAME);
    let manifest_metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
        ExtensionError::InvalidPackageTree {
            reason: format!("cached package manifest is missing: {error}"),
        }
    })?;
    if is_link_or_reparse(&manifest_metadata) || !manifest_metadata.is_file() {
        return Err(ExtensionError::InvalidPackageTree {
            reason: "cached package manifest must be a regular file".to_string(),
        });
    }
    if manifest_metadata.len() as usize > MAX_MANIFEST_BYTES {
        return Err(ExtensionError::ManifestTooLarge {
            actual_bytes: manifest_metadata.len() as usize,
            maximum_bytes: MAX_MANIFEST_BYTES,
        });
    }
    let manifest_bytes = read_bounded_file(&manifest_path, MAX_MANIFEST_BYTES)
        .map_err(|reason| ExtensionError::InvalidPackageTree { reason })?;
    let manifest = WorkspacePluginManifest::parse(&manifest_bytes)?;
    if &manifest.id != expected_plugin_id {
        return Err(ExtensionError::InvalidPackageTree {
            reason: "package manifest plugin ID does not match expected identity".to_string(),
        });
    }
    validate_manifest_paths(&package_directory, &manifest)
        .map_err(|reason| ExtensionError::InvalidPackageTree { reason })?;
    let inventory = collect_package_inventory(&package_directory, &manifest.manifest_entry_keys())
        .map_err(|reason| ExtensionError::InvalidPackageTree { reason })?;
    let digest_entries = inventory
        .iter()
        .map(|(path, bytes)| (path.as_slice(), bytes.as_slice()))
        .collect::<Vec<_>>();
    let digest = PackageDigest::from_inventory(&digest_entries);
    if &digest != expected_digest {
        return Err(ExtensionError::InvalidPackageTree {
            reason: "package snapshot digest does not match expected identity".to_string(),
        });
    }
    let aggregate_bytes = inventory.values().map(Vec::len).sum();
    let files = inventory
        .into_iter()
        .map(|(relative_path, bytes)| WorkspacePluginPackageFile {
            relative_path: String::from_utf8(relative_path)
                .expect("package inventory paths were already validated as UTF-8"),
            bytes,
        })
        .collect();
    Ok(WorkspacePluginPackageSnapshot {
        manifest,
        digest,
        files,
        aggregate_bytes,
    })
}

fn find_exact_discovered_plugin(
    project_root: &Path,
    plugin_id: &PluginId,
    expected_digest: &PackageDigest,
) -> Result<DiscoveredPlugin, ExtensionError> {
    let report = discover_workspace_plugins(project_root)?.ok_or_else(|| {
        ExtensionError::DiscoveryFailure {
            reason: "project has no workspace plugin discovery root".to_string(),
        }
    })?;
    let plugin = report
        .plugins
        .into_iter()
        .find(|plugin| &plugin.manifest.id == plugin_id)
        .ok_or_else(|| ExtensionError::DiscoveryFailure {
            reason: format!("workspace plugin {plugin_id} was not discovered"),
        })?;
    if &plugin.digest != expected_digest {
        return Err(ExtensionError::InvalidPackageTree {
            reason: "discovered package digest does not match expected identity".to_string(),
        });
    }
    Ok(plugin)
}

/// Discover all plugins under `project_root/.rho/plugins`.
///
/// Returns `Ok(None)` when the plugins directory does not exist (an empty,
/// normal project). Returns a failure-bearing report when the directory exists
/// but contains packages that cannot be validated. No code is executed in any
/// path.
pub fn discover_workspace_plugins(
    project_root: &Path,
) -> Result<Option<DiscoveryReport>, ExtensionError> {
    let plugins_dir = project_root.join(PLUGINS_DIR);
    let plugins_metadata = match fs::symlink_metadata(&plugins_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ExtensionError::DiscoveryFailure {
                reason: format!("cannot stat {}: {error}", plugins_dir.display()),
            });
        }
    };

    let rho_dir = project_root.join(".rho");
    let rho_metadata =
        fs::symlink_metadata(&rho_dir).map_err(|error| ExtensionError::DiscoveryFailure {
            reason: format!("cannot stat {}: {error}", rho_dir.display()),
        })?;
    if is_link_or_reparse(&rho_metadata) || !rho_metadata.is_dir() {
        return Err(ExtensionError::DiscoveryFailure {
            reason: ".rho must be a real directory, not a symlink or reparse point".to_string(),
        });
    }
    if is_link_or_reparse(&plugins_metadata) || !plugins_metadata.is_dir() {
        return Err(ExtensionError::DiscoveryFailure {
            reason: ".rho/plugins must be a real directory, not a symlink or reparse point"
                .to_string(),
        });
    }

    // The plugins root itself must be a real directory, not a symlink.
    let plugins_dir =
        fs::canonicalize(&plugins_dir).map_err(|error| ExtensionError::DiscoveryFailure {
            reason: format!("cannot canonicalize {}: {error}", plugins_dir.display()),
        })?;

    let project_root =
        fs::canonicalize(project_root).map_err(|error| ExtensionError::DiscoveryFailure {
            reason: format!("cannot canonicalize {}: {error}", project_root.display()),
        })?;

    // The plugins dir must still be inside the (canonical) project root.
    if !plugins_dir.starts_with(&project_root) {
        return Err(ExtensionError::DiscoveryFailure {
            reason: "plugins directory escapes project root".to_string(),
        });
    }

    let mut directories: Vec<PathBuf> = Vec::new();
    for entry in read_dir_entries(&plugins_dir)? {
        let file_type = entry
            .file_type()
            .map_err(|error| ExtensionError::DiscoveryFailure {
                reason: format!("cannot stat {}: {error}", entry.path().display()),
            })?;
        let metadata = entry
            .metadata()
            .map_err(|error| ExtensionError::DiscoveryFailure {
                reason: format!("cannot stat {}: {error}", entry.path().display()),
            })?;
        if file_type.is_symlink() || is_link_or_reparse(&metadata) {
            // A symlinked plugin directory escapes the plugins root; fail closed
            // rather than silently skipping it.
            return Err(ExtensionError::DiscoveryFailure {
                reason: format!(
                    "plugin entry must not be a symlink: {}",
                    entry.path().display()
                ),
            });
        }
        if file_type.is_dir() {
            directories.push(entry.path());
        }
    }
    directories.sort();

    if directories.is_empty() {
        return Ok(Some(DiscoveryReport {
            plugins: Vec::new(),
            failures: Vec::new(),
        }));
    }

    let mut report = DiscoveryReport {
        plugins: Vec::new(),
        failures: Vec::new(),
    };
    let mut seen_ids: BTreeMap<PluginId, String> = BTreeMap::new();

    for directory in directories {
        let directory_name = match directory.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => {
                report.failures.push(DiscoveryFailure {
                    path: directory.display().to_string(),
                    reason: "non-UTF-8 plugin directory name".to_string(),
                });
                continue;
            }
        };

        match discover_one(&plugins_dir, &directory, &directory_name) {
            Ok(plugin) => {
                if let Some(existing_dir) =
                    seen_ids.insert(plugin.manifest.id.clone(), directory_name.clone())
                {
                    report.failures.push(DiscoveryFailure {
                        path: directory.display().to_string(),
                        reason: format!(
                            "duplicate plugin id {} already provided by {}",
                            plugin.manifest.id, existing_dir
                        ),
                    });
                    // Keep the first provider; report the duplicate as failed.
                } else {
                    report.plugins.push(plugin);
                }
            }
            Err(failure) => report.failures.push(failure),
        }
    }

    Ok(Some(report))
}

fn discover_one(
    plugins_dir: &Path,
    directory: &Path,
    directory_name: &str,
) -> Result<DiscoveredPlugin, DiscoveryFailure> {
    // The directory entry under plugins/ must be a real directory, not a
    // symlink or junction (canonicalize would follow a symlink and could escape).
    let real_directory = match fs::canonicalize(directory) {
        Ok(path) => path,
        Err(error) => {
            return Err(DiscoveryFailure {
                path: directory.display().to_string(),
                reason: format!("cannot canonicalize plugin directory: {error}"),
            });
        }
    };

    if !real_directory.starts_with(plugins_dir) {
        return Err(DiscoveryFailure {
            path: directory.display().to_string(),
            reason: "plugin directory escapes plugins root".to_string(),
        });
    }

    // Verify the directory is not itself a symlink (canonicalize followed it).
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(DiscoveryFailure {
                path: directory.display().to_string(),
                reason: format!("cannot stat plugin directory: {error}"),
            });
        }
    };
    if is_link_or_reparse(&metadata) {
        return Err(DiscoveryFailure {
            path: directory.display().to_string(),
            reason: "plugin directory must not be a symlink".to_string(),
        });
    }

    let manifest_path = directory.join(MANIFEST_NAME);
    let manifest_metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(DiscoveryFailure {
                path: manifest_path.display().to_string(),
                reason: format!("missing manifest: {error}"),
            });
        }
    };
    if is_link_or_reparse(&manifest_metadata) || !manifest_metadata.is_file() {
        return Err(DiscoveryFailure {
            path: manifest_path.display().to_string(),
            reason: "manifest must be a regular file, not a symlink".to_string(),
        });
    }
    if manifest_metadata.len() as usize > MAX_MANIFEST_BYTES {
        return Err(DiscoveryFailure {
            path: manifest_path.display().to_string(),
            reason: format!("manifest exceeds {MAX_MANIFEST_BYTES} bytes"),
        });
    }

    let manifest_bytes = match read_bounded_file(&manifest_path, MAX_MANIFEST_BYTES) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(DiscoveryFailure {
                path: manifest_path.display().to_string(),
                reason: format!("cannot read bounded manifest: {error}"),
            });
        }
    };

    let manifest = match WorkspacePluginManifest::parse(&manifest_bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            return Err(DiscoveryFailure {
                path: manifest_path.display().to_string(),
                reason: error.to_string(),
            });
        }
    };

    if let Err(reason) = validate_manifest_paths(&real_directory, &manifest) {
        return Err(DiscoveryFailure {
            path: directory.display().to_string(),
            reason,
        });
    }

    // Build the canonical package inventory and digest. The digest covers the
    // manifest plus every regular file reachable inside the (non-symlink)
    // directory, with explicit bounds.
    let inventory =
        match collect_package_inventory(&real_directory, &manifest.manifest_entry_keys()) {
            Ok(inventory) => inventory,
            Err(reason) => {
                return Err(DiscoveryFailure {
                    path: directory.display().to_string(),
                    reason,
                });
            }
        };

    let digest_entries: Vec<(&[u8], &[u8])> = inventory
        .iter()
        .map(|(path, bytes)| (path.as_slice(), bytes.as_slice()))
        .collect();
    let digest = PackageDigest::from_inventory(&digest_entries);

    Ok(DiscoveredPlugin {
        directory: directory_name.to_string(),
        manifest,
        digest,
    })
}

impl WorkspacePluginManifest {
    /// The manifest-relative entry keys that discovery must include in the
    /// digest-directed inventory (the entry path plus any skill-pack paths).
    fn manifest_entry_keys(&self) -> Vec<String> {
        let mut keys = Vec::new();
        keys.push(self.runtime.entry.clone());
        for provide in &self.provides {
            if let Some(path) = &provide.path {
                keys.push(path.clone());
            }
        }
        for contribution in &self.contributions {
            if let Some(path) = &contribution.skill_path {
                keys.push(path.clone());
            }
        }
        keys.sort();
        keys.dedup();
        keys
    }
}

/// Recursively collect a bounded, symlink-safe file inventory.
///
/// The returned `BTreeMap` is keyed by the normalized relative path and thus
/// already sorted. Directories are traversed depth-first; any symlink or
/// non-regular file encountered is an error (fail closed), not skipped.
fn collect_package_inventory(
    directory: &Path,
    entry_keys: &[String],
) -> Result<BTreeMap<Vec<u8>, Vec<u8>>, String> {
    let mut inventory: BTreeMap<Vec<u8>, Vec<u8>> = BTreeMap::new();
    let mut aggregate_bytes: usize = 0;

    walk(
        directory,
        directory,
        0,
        &mut inventory,
        &mut aggregate_bytes,
    )?;

    for entry_key in entry_keys {
        let normalized = normalize_manifest_relative(entry_key);
        let direct_file = inventory.contains_key(normalized.as_bytes());
        let directory_prefix = format!("{normalized}/");
        let populated_directory = inventory
            .keys()
            .any(|path| path.starts_with(directory_prefix.as_bytes()));
        if !direct_file && !populated_directory {
            return Err(format!("declared package path does not exist: {entry_key}"));
        }
    }

    Ok(inventory)
}

fn validate_manifest_paths(
    directory: &Path,
    manifest: &WorkspacePluginManifest,
) -> Result<(), String> {
    let entry_path = directory.join(normalize_manifest_relative(&manifest.runtime.entry));
    let entry_metadata = fs::symlink_metadata(&entry_path)
        .map_err(|error| format!("runtime entry is missing: {error}"))?;
    if is_link_or_reparse(&entry_metadata) || !entry_metadata.is_file() {
        return Err("runtime entry must be a regular non-symlink file".to_string());
    }

    for path in manifest
        .provides
        .iter()
        .filter_map(|provide| provide.path.as_deref())
    {
        let asset_path = directory.join(normalize_manifest_relative(path));
        let metadata = fs::symlink_metadata(&asset_path)
            .map_err(|error| format!("declared package path is missing: {path}: {error}"))?;
        if is_link_or_reparse(&metadata) {
            return Err(format!(
                "declared package path must not be a symlink: {path}"
            ));
        }
        if manifest.schema_version >= 2 && !metadata.is_file() {
            return Err(format!(
                "Manifest V2 declared package path must be a regular file: {path}"
            ));
        }
        let canonical = fs::canonicalize(&asset_path)
            .map_err(|error| format!("cannot canonicalize declared path {path}: {error}"))?;
        if !canonical.starts_with(directory) {
            return Err(format!("declared package path escapes plugin root: {path}"));
        }
    }
    for path in manifest
        .contributions
        .iter()
        .filter_map(|contribution| contribution.skill_path.as_deref())
    {
        let asset_path = directory.join(normalize_manifest_relative(path));
        let metadata = fs::symlink_metadata(&asset_path)
            .map_err(|error| format!("declared Skill path is missing: {path}: {error}"))?;
        if is_link_or_reparse(&metadata) || !metadata.is_file() {
            return Err(format!(
                "declared Skill path must be a regular non-symlink file: {path}"
            ));
        }
        let canonical = fs::canonicalize(&asset_path)
            .map_err(|error| format!("cannot canonicalize Skill path {path}: {error}"))?;
        if !canonical.starts_with(directory) {
            return Err(format!("declared Skill path escapes plugin root: {path}"));
        }
    }
    Ok(())
}

fn walk(
    root: &Path,
    current: &Path,
    depth: usize,
    inventory: &mut BTreeMap<Vec<u8>, Vec<u8>>,
    aggregate_bytes: &mut usize,
) -> Result<(), String> {
    if depth > MAX_PACKAGE_DEPTH {
        return Err(format!("package depth exceeds {MAX_PACKAGE_DEPTH}"));
    }

    let mut entries: Vec<PathBuf> = Vec::new();
    for entry in read_dir_entries(current).map_err(|e| e.to_string())? {
        entries.push(entry.path());
    }
    entries.sort();

    for path in entries {
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if is_link_or_reparse(&metadata) {
            return Err(format!("symlink is not allowed: {}", path.display()));
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|_| format!("path escapes package root: {}", path.display()))?;
        let normalized = normalize_relative(relative)?;

        if metadata.is_dir() {
            // Directories contribute structure only; recurse.
            walk(root, &path, depth + 1, inventory, aggregate_bytes)?;
            continue;
        }

        if !metadata.is_file() {
            return Err(format!("unexpected non-regular file: {}", path.display()));
        }

        if normalized.len() > MAX_RELATIVE_PATH_BYTES {
            return Err(format!("path exceeds {MAX_RELATIVE_PATH_BYTES} bytes"));
        }

        if metadata.len() > MAX_PACKAGE_FILE_BYTES as u64 {
            return Err(format!(
                "file exceeds {MAX_PACKAGE_FILE_BYTES} bytes: {}",
                path.display()
            ));
        }
        if inventory.len() + 1 > MAX_PACKAGE_FILES {
            return Err(format!("package file count exceeds {MAX_PACKAGE_FILES}"));
        }

        // Case-collision guard: two paths that differ only by case should be
        // treated as a collision on case-insensitive filesystems.
        let lower = normalized.to_ascii_lowercase();
        if inventory
            .keys()
            .any(|existing| existing.to_ascii_lowercase() == lower)
            && !inventory.contains_key(&normalized)
        {
            // Already present under identical lowercased key but different case.
            return Err(format!(
                "case-collision for path: {}",
                String::from_utf8_lossy(&normalized)
            ));
        }

        let file = fs::File::open(&path).map_err(|e| e.to_string())?;
        let opened_metadata = file.metadata().map_err(|e| e.to_string())?;
        if !opened_metadata.is_file() {
            return Err(format!(
                "file changed type during discovery: {}",
                path.display()
            ));
        }
        let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if !canonical.starts_with(root) {
            return Err(format!(
                "file escaped package root during discovery: {}",
                path.display()
            ));
        }
        let mut content = Vec::new();
        file.take((MAX_PACKAGE_FILE_BYTES + 1) as u64)
            .read_to_end(&mut content)
            .map_err(|e| e.to_string())?;
        if content.len() > MAX_PACKAGE_FILE_BYTES {
            return Err(format!(
                "file exceeds {MAX_PACKAGE_FILE_BYTES} bytes: {}",
                path.display()
            ));
        }
        *aggregate_bytes = aggregate_bytes
            .checked_add(content.len())
            .ok_or_else(|| "aggregate byte overflow".to_string())?;
        if *aggregate_bytes > MAX_PACKAGE_AGGREGATE_BYTES {
            return Err(format!(
                "aggregate package exceeds {MAX_PACKAGE_AGGREGATE_BYTES} bytes"
            ));
        }
        inventory.insert(normalized, content);
    }

    Ok(())
}

fn normalize_relative(path: &Path) -> Result<Vec<u8>, String> {
    let value = path
        .to_str()
        .ok_or_else(|| format!("non-UTF-8 package path: {}", path.display()))?;
    Ok(value.replace('\\', "/").into_bytes())
}

fn normalize_manifest_relative(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn read_bounded_file(path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("opened path is not a regular file".to_string());
    }
    let mut bytes = Vec::new();
    file.take((maximum_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > maximum_bytes {
        return Err(format!("file exceeds {maximum_bytes} bytes"));
    }
    Ok(bytes)
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn read_dir_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, ExtensionError> {
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|error| ExtensionError::DiscoveryFailure {
        reason: format!("cannot read {}: {error}", dir.display()),
    })?;
    for entry in read_dir {
        match entry {
            Ok(entry) => entries.push(entry),
            Err(error) => {
                return Err(ExtensionError::DiscoveryFailure {
                    reason: format!("cannot read entry in {}: {error}", dir.display()),
                });
            }
        }
    }
    Ok(entries)
}
