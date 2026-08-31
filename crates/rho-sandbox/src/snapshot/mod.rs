use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    io::Read,
    path::{Component, Path, PathBuf},
};

use rho_protocol::ProjectRevision;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const DEFAULT_MAX_SNAPSHOT_FILES: usize = 10_000;
pub const DEFAULT_MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
pub const DEFAULT_MAX_SNAPSHOT_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const DEFAULT_MAX_PATH_DEPTH: usize = 64;
pub const IGNORE_POLICY_FILE: &str = ".rhoignore";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_path_depth: usize,
}

impl Default for SnapshotLimits {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_MAX_SNAPSHOT_FILES,
            max_total_bytes: DEFAULT_MAX_SNAPSHOT_BYTES,
            max_file_bytes: DEFAULT_MAX_SNAPSHOT_FILE_BYTES,
            max_path_depth: DEFAULT_MAX_PATH_DEPTH,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotManifestEntry {
    pub relative_path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub mode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSnapshotManifest {
    pub snapshot_id: String,
    pub project_revision: ProjectRevision,
    pub policy_digest: String,
    pub content_digest: String,
    pub files: Vec<SnapshotManifestEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ProjectSnapshot {
    manifest: ProjectSnapshotManifest,
    bytes: BTreeMap<String, Vec<u8>>,
}

impl ProjectSnapshot {
    pub fn manifest(&self) -> &ProjectSnapshotManifest {
        &self.manifest
    }

    pub fn read(&self, relative_path: &str) -> Option<&[u8]> {
        self.bytes.get(relative_path).map(Vec::as_slice)
    }

    pub fn contains_host_path(&self, host_path: &Path) -> bool {
        let encoded = serde_json::to_string(&self.manifest).unwrap_or_default();
        encoded.contains(host_path.to_string_lossy().as_ref())
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    #[error("project snapshot root is unavailable")]
    RootUnavailable,
    #[error("project snapshot encountered an unsafe relative path: {0}")]
    UnsafePath(String),
    #[error("project snapshot rejects symbolic links: {0}")]
    SymbolicLink(String),
    #[error("project snapshot rejects hard links: {0}")]
    HardLink(String),
    #[error("project snapshot rejects special files: {0}")]
    SpecialFile(String),
    #[error("project snapshot file changed during descriptor-relative read: {0}")]
    RaceDetected(String),
    #[error("project snapshot permission/read error at bounded relative path: {0}")]
    ReadFailed(String),
    #[error("project snapshot file count exceeds {0}")]
    FileCountExceeded(usize),
    #[error("project snapshot total bytes exceed {0}")]
    TotalBytesExceeded(u64),
    #[error("project snapshot file exceeds {limit} bytes: {path}")]
    FileBytesExceeded { path: String, limit: u64 },
    #[error("project snapshot path depth exceeds {0}")]
    PathDepthExceeded(usize),
    #[error("project snapshot ignore policy changed during traversal")]
    IgnorePolicyRace,
    #[error("hard-link containment guarantee is unavailable on this platform")]
    UnsupportedHardLinkGuarantee,
}

pub trait SnapshotRaceHook {
    fn after_metadata(&mut self, relative_path: &str);
}

impl<F> SnapshotRaceHook for F
where
    F: FnMut(&str),
{
    fn after_metadata(&mut self, relative_path: &str) {
        self(relative_path);
    }
}

struct NoopHook;
impl SnapshotRaceHook for NoopHook {
    fn after_metadata(&mut self, _relative_path: &str) {}
}

pub fn build_project_snapshot(
    project_root: impl AsRef<Path>,
    project_revision: ProjectRevision,
    limits: SnapshotLimits,
) -> Result<ProjectSnapshot, SnapshotError> {
    build_project_snapshot_with_hook(project_root, project_revision, limits, &mut NoopHook)
}

pub fn build_project_snapshot_with_hook(
    project_root: impl AsRef<Path>,
    project_revision: ProjectRevision,
    limits: SnapshotLimits,
    hook: &mut impl SnapshotRaceHook,
) -> Result<ProjectSnapshot, SnapshotError> {
    let root = project_root
        .as_ref()
        .canonicalize()
        .map_err(|_| SnapshotError::RootUnavailable)?;
    let (ignore_policy, ignore_metadata) = freeze_ignore_policy(&root)?;
    let mut relative_files = Vec::new();
    walk_directory(
        &root,
        Path::new(""),
        &limits,
        &ignore_policy,
        &mut relative_files,
    )?;
    relative_files.sort();
    if relative_files.len() > limits.max_files {
        return Err(SnapshotError::FileCountExceeded(limits.max_files));
    }

    let mut manifest_entries = Vec::with_capacity(relative_files.len());
    let mut bytes = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for relative in relative_files {
        let relative_text = normalized_relative(&relative)?;
        let absolute = root.join(&relative);
        let before = fs::symlink_metadata(&absolute)
            .map_err(|_| SnapshotError::ReadFailed(relative_text.clone()))?;
        validate_regular_file(&before, &relative_text)?;
        if before.len() > limits.max_file_bytes {
            return Err(SnapshotError::FileBytesExceeded {
                path: relative_text,
                limit: limits.max_file_bytes,
            });
        }
        hook.after_metadata(&relative_text);
        let file =
            File::open(&absolute).map_err(|_| SnapshotError::ReadFailed(relative_text.clone()))?;
        let opened = file
            .metadata()
            .map_err(|_| SnapshotError::ReadFailed(relative_text.clone()))?;
        if !same_file_identity(&before, &opened) {
            return Err(SnapshotError::RaceDetected(relative_text));
        }
        let mut file_bytes = Vec::with_capacity(opened.len() as usize);
        file.take(limits.max_file_bytes.saturating_add(1))
            .read_to_end(&mut file_bytes)
            .map_err(|_| SnapshotError::ReadFailed(relative_text.clone()))?;
        if file_bytes.len() as u64 > limits.max_file_bytes {
            return Err(SnapshotError::FileBytesExceeded {
                path: relative_text,
                limit: limits.max_file_bytes,
            });
        }
        let after = fs::symlink_metadata(&absolute)
            .map_err(|_| SnapshotError::RaceDetected(relative_text.clone()))?;
        if !same_file_identity(&opened, &after)
            || opened.len() != after.len()
            || opened.modified().ok() != after.modified().ok()
        {
            return Err(SnapshotError::RaceDetected(relative_text));
        }
        total_bytes = total_bytes.saturating_add(file_bytes.len() as u64);
        if total_bytes > limits.max_total_bytes {
            return Err(SnapshotError::TotalBytesExceeded(limits.max_total_bytes));
        }
        let digest = sha256(&file_bytes);
        manifest_entries.push(SnapshotManifestEntry {
            relative_path: relative_text.clone(),
            sha256: digest,
            byte_size: file_bytes.len() as u64,
            mode: file_mode(&opened),
        });
        bytes.insert(relative_text, file_bytes);
    }
    verify_ignore_policy(&root, ignore_metadata.as_ref())?;
    let policy_digest = sha256(&ignore_policy.raw);
    let content_digest = manifest_digest(&manifest_entries, project_revision, &policy_digest);
    Ok(ProjectSnapshot {
        manifest: ProjectSnapshotManifest {
            snapshot_id: format!("snapshot_{}", Uuid::now_v7().simple()),
            project_revision,
            policy_digest,
            content_digest,
            files: manifest_entries,
            total_bytes,
        },
        bytes,
    })
}

#[derive(Debug, Clone)]
struct FrozenIgnorePolicy {
    raw: Vec<u8>,
    exact: BTreeSet<String>,
    prefixes: Vec<String>,
    suffixes: Vec<String>,
}

impl FrozenIgnorePolicy {
    fn ignored(&self, relative: &str) -> bool {
        relative == ".rho"
            || relative.starts_with(".rho/")
            || self.exact.contains(relative)
            || self
                .prefixes
                .iter()
                .any(|prefix| relative.starts_with(prefix))
            || self
                .suffixes
                .iter()
                .any(|suffix| relative.ends_with(suffix))
    }
}

fn freeze_ignore_policy(
    root: &Path,
) -> Result<(FrozenIgnorePolicy, Option<Metadata>), SnapshotError> {
    let path = root.join(IGNORE_POLICY_FILE);
    let (raw, metadata) = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(SnapshotError::SymbolicLink(IGNORE_POLICY_FILE.to_string()));
            }
            let raw = fs::read(&path)
                .map_err(|_| SnapshotError::ReadFailed(IGNORE_POLICY_FILE.to_string()))?;
            (raw, Some(metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
        Err(_) => return Err(SnapshotError::ReadFailed(IGNORE_POLICY_FILE.to_string())),
    };
    let mut exact = BTreeSet::new();
    let mut prefixes = Vec::new();
    let mut suffixes = Vec::new();
    for line in String::from_utf8_lossy(&raw).lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let canonical = line.trim_start_matches("./").replace('\\', "/");
        if let Some(suffix) = canonical.strip_prefix('*') {
            suffixes.push(suffix.to_string());
        } else if canonical.ends_with('/') {
            prefixes.push(canonical);
        } else {
            exact.insert(canonical);
        }
    }
    Ok((
        FrozenIgnorePolicy {
            raw,
            exact,
            prefixes,
            suffixes,
        },
        metadata,
    ))
}

fn verify_ignore_policy(root: &Path, before: Option<&Metadata>) -> Result<(), SnapshotError> {
    let path = root.join(IGNORE_POLICY_FILE);
    match (before, fs::symlink_metadata(path)) {
        (None, Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        (Some(before), Ok(after))
            if same_file_identity(before, &after)
                && before.len() == after.len()
                && before.modified().ok() == after.modified().ok() =>
        {
            Ok(())
        }
        _ => Err(SnapshotError::IgnorePolicyRace),
    }
}

fn walk_directory(
    root: &Path,
    relative_directory: &Path,
    limits: &SnapshotLimits,
    ignore: &FrozenIgnorePolicy,
    output: &mut Vec<PathBuf>,
) -> Result<(), SnapshotError> {
    let directory = root.join(relative_directory);
    let mut entries = fs::read_dir(&directory)
        .map_err(|_| SnapshotError::ReadFailed(display_relative(relative_directory)))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| SnapshotError::ReadFailed(display_relative(relative_directory)))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let relative = relative_directory.join(entry.file_name());
        let relative_text = normalized_relative(&relative)?;
        if relative.components().count() > limits.max_path_depth {
            return Err(SnapshotError::PathDepthExceeded(limits.max_path_depth));
        }
        if ignore.ignored(&relative_text) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| SnapshotError::ReadFailed(relative_text.clone()))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(SnapshotError::SymbolicLink(relative_text));
        }
        if file_type.is_dir() {
            walk_directory(root, &relative, limits, ignore, output)?;
        } else if file_type.is_file() {
            validate_regular_file(&metadata, &relative_text)?;
            output.push(relative);
            if output.len() > limits.max_files {
                return Err(SnapshotError::FileCountExceeded(limits.max_files));
            }
        } else {
            return Err(SnapshotError::SpecialFile(relative_text));
        }
    }
    Ok(())
}

fn normalized_relative(path: &Path) -> Result<String, SnapshotError> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(SnapshotError::UnsafePath(display_relative(path)));
    }
    Ok(path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn display_relative(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        ".".to_string()
    } else {
        value.chars().take(256).collect()
    }
}

fn validate_regular_file(metadata: &Metadata, relative: &str) -> Result<(), SnapshotError> {
    if !metadata.file_type().is_file() {
        return Err(SnapshotError::SpecialFile(relative.to_string()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(SnapshotError::HardLink(relative.to_string()));
        }
    }
    #[cfg(not(unix))]
    {
        return Err(SnapshotError::UnsupportedHardLinkGuarantee);
    }
    Ok(())
}

#[cfg(unix)]
fn same_file_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino() && left.file_type() == right.file_type()
}

#[cfg(windows)]
fn same_file_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.file_index() == right.file_index()
        && left.volume_serial_number() == right.volume_serial_number()
        && left.file_type() == right.file_type()
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(_left: &Metadata, _right: &Metadata) -> bool {
    false
}

#[cfg(unix)]
fn file_mode(metadata: &Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn file_mode(metadata: &Metadata) -> u32 {
    if metadata.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn manifest_digest(
    entries: &[SnapshotManifestEntry],
    revision: ProjectRevision,
    policy_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(revision.0.to_be_bytes());
    hasher.update(tree_digest(entries, policy_digest).as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

fn tree_digest(entries: &[SnapshotManifestEntry], policy_digest: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(policy_digest.as_bytes());
    for entry in entries {
        hasher.update(entry.relative_path.as_bytes());
        hasher.update(entry.sha256.as_bytes());
        hasher.update(entry.byte_size.to_be_bytes());
        hasher.update(entry.mode.to_be_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

#[derive(Debug, Clone)]
pub struct ProjectRevisionWatcher {
    last_tree_digest: String,
    revision: ProjectRevision,
    limits: SnapshotLimits,
}

impl ProjectRevisionWatcher {
    pub fn from_snapshot(snapshot: &ProjectSnapshot, limits: SnapshotLimits) -> Self {
        Self {
            last_tree_digest: tree_digest(
                &snapshot.manifest.files,
                &snapshot.manifest.policy_digest,
            ),
            revision: snapshot.manifest.project_revision,
            limits,
        }
    }

    pub fn detect_external_mutation(
        &mut self,
        project_root: impl AsRef<Path>,
    ) -> Result<ProjectRevision, SnapshotError> {
        let candidate = build_project_snapshot(project_root, self.revision, self.limits.clone())?;
        let candidate_tree =
            tree_digest(&candidate.manifest.files, &candidate.manifest.policy_digest);
        if candidate_tree != self.last_tree_digest {
            self.revision = ProjectRevision(self.revision.0.saturating_add(1));
            self.last_tree_digest = candidate_tree;
        }
        Ok(self.revision)
    }

    pub fn is_stale(&self, snapshot: &ProjectSnapshot) -> bool {
        snapshot.manifest.project_revision != self.revision
    }
}

pub fn snapshot_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "immutable_bytes",
            "relative_manifest",
            "revision_digest",
            "race_detection",
        ],
        &[
            "live_authoritative_mount",
            "absolute_host_path",
            "symlink_follow",
            "hardlink_follow",
            "ignore_policy_mutation",
        ],
    )
}
