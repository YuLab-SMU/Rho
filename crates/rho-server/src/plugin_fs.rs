//! Broker-owned, bounded project file reads for workspace plugins.
//!
//! This module returns bytes only. It never lists directories, follows links,
//! exposes file handles, writes, watches, maps, parses, executes, or accepts a
//! plugin-selected project root.

use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Component, Path};
use std::time::UNIX_EPOCH;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAX_PLUGIN_FILE_READ_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectFsReadRequest {
    pub project_relative_path: String,
    pub max_bytes: u64,
    pub expected_project_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectFsReadResult {
    pub project_relative_path: String,
    pub media_type: String,
    pub content_encoding: String,
    pub content: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectFsReadErrorCode {
    InvalidProject,
    InvalidPath,
    ReservedPath,
    StaleProject,
    SymlinkOrReparse,
    NestedRepository,
    NotRegularFile,
    OutsideProject,
    TooLarge,
    FileChanged,
    IoFailed,
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[error("project file read failed: {code:?}")]
pub struct ProjectFsReadError {
    pub code: ProjectFsReadErrorCode,
}

impl ProjectFsReadError {
    fn new(code: ProjectFsReadErrorCode) -> Self {
        Self { code }
    }
}

pub fn read_project_file(
    trusted_project_root: &Path,
    current_project_revision: u64,
    request: &ProjectFsReadRequest,
) -> Result<ProjectFsReadResult, ProjectFsReadError> {
    read_project_file_with_hook(
        trusted_project_root,
        current_project_revision,
        request,
        || {},
    )
}

fn read_project_file_with_hook(
    trusted_project_root: &Path,
    current_project_revision: u64,
    request: &ProjectFsReadRequest,
    after_open: impl FnOnce(),
) -> Result<ProjectFsReadResult, ProjectFsReadError> {
    if request.expected_project_revision != current_project_revision {
        return Err(ProjectFsReadError::new(
            ProjectFsReadErrorCode::StaleProject,
        ));
    }
    if request.max_bytes == 0 || request.max_bytes > MAX_PLUGIN_FILE_READ_BYTES {
        return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::TooLarge));
    }
    let components = validate_relative_path(&request.project_relative_path)?;
    if reserved_path(&components) {
        return Err(ProjectFsReadError::new(
            ProjectFsReadErrorCode::ReservedPath,
        ));
    }

    let root_metadata = fs::symlink_metadata(trusted_project_root)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidProject))?;
    if !root_metadata.is_dir() || is_link_or_reparse(&root_metadata) {
        return Err(ProjectFsReadError::new(
            ProjectFsReadErrorCode::InvalidProject,
        ));
    }
    let root_identity = path_identity(
        trusted_project_root,
        &root_metadata,
        ProjectFsReadErrorCode::InvalidProject,
    )?;
    let canonical_root = fs::canonicalize(trusted_project_root)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidProject))?;
    let normalized_root =
        rho_store::normalize_project_root(trusted_project_root.to_string_lossy().as_ref());
    if normalized_root
        != rho_store::normalize_project_root(canonical_root.to_string_lossy().as_ref())
    {
        return Err(ProjectFsReadError::new(
            ProjectFsReadErrorCode::InvalidProject,
        ));
    }

    let mut current = trusted_project_root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?;
        if is_link_or_reparse(&metadata) {
            return Err(ProjectFsReadError::new(
                ProjectFsReadErrorCode::SymlinkOrReparse,
            ));
        }
        let final_component = index + 1 == components.len();
        if final_component {
            if !metadata.is_file() {
                return Err(ProjectFsReadError::new(
                    ProjectFsReadErrorCode::NotRegularFile,
                ));
            }
        } else {
            if !metadata.is_dir() {
                return Err(ProjectFsReadError::new(
                    ProjectFsReadErrorCode::NotRegularFile,
                ));
            }
            if fs::symlink_metadata(current.join(".git")).is_ok() {
                return Err(ProjectFsReadError::new(
                    ProjectFsReadErrorCode::NestedRepository,
                ));
            }
        }
    }

    let before_path_metadata = fs::symlink_metadata(&current)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?;
    let before_file_identity = path_identity(
        &current,
        &before_path_metadata,
        ProjectFsReadErrorCode::IoFailed,
    )?;
    let canonical_file = fs::canonicalize(&current)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(ProjectFsReadError::new(
            ProjectFsReadErrorCode::OutsideProject,
        ));
    }

    let mut file = File::open(&current)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?;
    if opened_file_identity(
        &file,
        &file
            .metadata()
            .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?,
        ProjectFsReadErrorCode::IoFailed,
    )? != before_file_identity
    {
        return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::FileChanged));
    }
    after_open();
    let mut bytes = Vec::with_capacity(request.max_bytes.min(64 * 1024) as usize);
    file.by_ref()
        .take(request.max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?;
    if bytes.len() as u64 > request.max_bytes {
        return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::TooLarge));
    }

    let after_file_metadata = file
        .metadata()
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::IoFailed))?;
    let after_path_metadata = fs::symlink_metadata(&current)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::FileChanged))?;
    let after_root_metadata = fs::symlink_metadata(trusted_project_root)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::FileChanged))?;
    let after_canonical_root = fs::canonicalize(trusted_project_root)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::FileChanged))?;
    let after_canonical_file = fs::canonicalize(&current)
        .map_err(|_| ProjectFsReadError::new(ProjectFsReadErrorCode::FileChanged))?;
    if opened_file_identity(
        &file,
        &after_file_metadata,
        ProjectFsReadErrorCode::FileChanged,
    )? != before_file_identity
        || path_identity(
            &current,
            &after_path_metadata,
            ProjectFsReadErrorCode::FileChanged,
        )? != before_file_identity
        || path_identity(
            trusted_project_root,
            &after_root_metadata,
            ProjectFsReadErrorCode::FileChanged,
        )? != root_identity
        || after_canonical_root != canonical_root
        || after_canonical_file != canonical_file
        || !after_canonical_file.starts_with(&after_canonical_root)
    {
        return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::FileChanged));
    }

    let sha256 = hex_encode(&Sha256::digest(&bytes));
    Ok(ProjectFsReadResult {
        project_relative_path: request.project_relative_path.clone(),
        media_type: media_type(&current).to_string(),
        content_encoding: "base64".to_string(),
        content: BASE64_STANDARD.encode(&bytes),
        size_bytes: bytes.len() as u64,
        sha256,
    })
}

fn validate_relative_path(value: &str) -> Result<Vec<String>, ProjectFsReadError> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
    {
        return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidPath));
    }
    let path = Path::new(value);
    let mut normalized = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidPath));
        };
        let Some(component) = component.to_str() else {
            return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidPath));
        };
        if component.is_empty() || component == "." || component == ".." {
            return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidPath));
        }
        normalized.push(component.to_string());
    }
    if normalized.is_empty() || normalized.join("/") != value {
        return Err(ProjectFsReadError::new(ProjectFsReadErrorCode::InvalidPath));
    }
    Ok(normalized)
}

fn reserved_path(components: &[String]) -> bool {
    let lower = components
        .iter()
        .map(|component| component.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let first = lower.first().map(String::as_str).unwrap_or_default();
    let last = lower.last().map(String::as_str).unwrap_or_default();
    matches!(
        first,
        ".git" | ".rho" | ".ssh" | ".gnupg" | ".aws" | ".azure"
    ) || last == ".env"
        || last.starts_with(".env.")
        || last == ".renviron"
        || matches!(
            last,
            "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa" | "known_hosts" | "authorized_keys"
        )
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| last.ends_with(suffix))
        || lower.windows(2).any(|pair| {
            matches!(
                (pair[0].as_str(), pair[1].as_str()),
                ("library", "keychains")
                    | ("microsoft", "credentials")
                    | ("microsoft", "protect")
                    | (".config", "gcloud")
            )
        })
}

fn is_link_or_reparse(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified_nanos: Option<u128>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: Option<u32>,
    #[cfg(windows)]
    index: Option<u64>,
}

fn metadata_identity(metadata: &Metadata) -> FileIdentity {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        len: metadata.len(),
        modified_nanos: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(windows)]
        volume: None,
        #[cfg(windows)]
        index: None,
    }
}

#[cfg(not(windows))]
fn path_identity(
    _path: &Path,
    metadata: &Metadata,
    _error_code: ProjectFsReadErrorCode,
) -> Result<FileIdentity, ProjectFsReadError> {
    Ok(metadata_identity(metadata))
}

#[cfg(windows)]
fn path_identity(
    path: &Path,
    metadata: &Metadata,
    error_code: ProjectFsReadErrorCode,
) -> Result<FileIdentity, ProjectFsReadError> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
    };

    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| ProjectFsReadError::new(error_code))?;
    opened_file_identity(&file, metadata, error_code)
}

#[cfg(not(windows))]
fn opened_file_identity(
    _file: &File,
    metadata: &Metadata,
    _error_code: ProjectFsReadErrorCode,
) -> Result<FileIdentity, ProjectFsReadError> {
    Ok(metadata_identity(metadata))
}

#[cfg(windows)]
fn opened_file_identity(
    file: &File,
    metadata: &Metadata,
    error_code: ProjectFsReadErrorCode,
) -> Result<FileIdentity, ProjectFsReadError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a live Windows handle for the duration of the call,
    // and `information` is a valid writable output buffer of the exact API type.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) };
    if succeeded == 0 {
        return Err(ProjectFsReadError::new(error_code));
    }
    let mut identity = metadata_identity(metadata);
    identity.volume = Some(information.dwVolumeSerialNumber);
    identity.index =
        Some((u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow));
    Ok(identity)
}

fn media_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("csv") => "text/csv",
        Some("tsv") => "text/tab-separated-values",
        Some("json") => "application/json",
        Some("r") => "text/x-r",
        Some("rmd") => "text/x-r-markdown",
        Some("qmd") | Some("md") => "text/markdown",
        Some("txt") | Some("log") => "text/plain",
        _ => "application/octet-stream",
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request(path: &str, max_bytes: u64) -> ProjectFsReadRequest {
        ProjectFsReadRequest {
            project_relative_path: path.to_string(),
            max_bytes,
            expected_project_revision: 7,
        }
    }

    #[test]
    fn reads_unicode_space_path_at_exact_boundary() {
        let directory = tempdir().unwrap();
        let nested = directory.path().join("data set/研究");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("输入.csv"), b"abcde").unwrap();
        let root = directory.path().canonicalize().unwrap();
        let result = read_project_file(&root, 7, &request("data set/研究/输入.csv", 5)).unwrap();
        assert_eq!(result.size_bytes, 5);
        assert_eq!(result.content, "YWJjZGU=");
        assert_eq!(result.media_type, "text/csv");
        assert!(!result.content.contains("abcde"));
    }

    #[test]
    fn just_over_boundary_returns_no_prefix() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("data.bin"), b"abcdef").unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = read_project_file(&root, 7, &request("data.bin", 5)).unwrap_err();
        assert_eq!(error.code, ProjectFsReadErrorCode::TooLarge);
    }

    #[test]
    fn rejects_invalid_reserved_and_non_regular_paths() {
        let directory = tempdir().unwrap();
        fs::create_dir_all(directory.path().join("data")).unwrap();
        fs::write(directory.path().join(".env"), b"secret").unwrap();
        fs::create_dir_all(directory.path().join(".rho")).unwrap();
        fs::write(directory.path().join(".rho/config.json"), b"{}").unwrap();
        let root = directory.path().canonicalize().unwrap();
        for path in [
            "",
            "/tmp/x",
            "C:/x",
            "data\\x",
            "data//x",
            "data/../x",
            "data/./x",
            "data\0x",
        ] {
            assert_eq!(
                read_project_file(&root, 7, &request(path, 10))
                    .unwrap_err()
                    .code,
                ProjectFsReadErrorCode::InvalidPath
            );
        }
        for path in [".env", ".rho/config.json"] {
            assert_eq!(
                read_project_file(&root, 7, &request(path, 10))
                    .unwrap_err()
                    .code,
                ProjectFsReadErrorCode::ReservedPath
            );
        }
        assert_eq!(
            read_project_file(&root, 7, &request("data", 10))
                .unwrap_err()
                .code,
            ProjectFsReadErrorCode::NotRegularFile
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_nested_repository() {
        use std::os::unix::fs::symlink;
        let project = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            project.path().join("linked.txt"),
        )
        .unwrap();
        let root = project.path().canonicalize().unwrap();
        assert_eq!(
            read_project_file(&root, 7, &request("linked.txt", 100))
                .unwrap_err()
                .code,
            ProjectFsReadErrorCode::SymlinkOrReparse
        );
        fs::create_dir_all(project.path().join("nested/.git")).unwrap();
        fs::write(project.path().join("nested/data.txt"), b"data").unwrap();
        assert_eq!(
            read_project_file(&root, 7, &request("nested/data.txt", 100))
                .unwrap_err()
                .code,
            ProjectFsReadErrorCode::NestedRepository
        );
    }

    #[test]
    fn stale_revision_and_file_change_fail_closed() {
        let directory = tempdir().unwrap();
        let file = directory.path().join("data.txt");
        fs::write(&file, b"before").unwrap();
        let root = directory.path().canonicalize().unwrap();
        assert_eq!(
            read_project_file(&root, 8, &request("data.txt", 100))
                .unwrap_err()
                .code,
            ProjectFsReadErrorCode::StaleProject
        );
        let error = read_project_file_with_hook(&root, 7, &request("data.txt", 100), || {
            fs::write(&file, b"changed-content").unwrap()
        })
        .unwrap_err();
        assert_eq!(error.code, ProjectFsReadErrorCode::FileChanged);
    }

    #[cfg(unix)]
    #[test]
    fn root_replacement_fails_after_open() {
        let parent = tempdir().unwrap();
        let root = parent.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("data.txt"), b"before").unwrap();
        let root = root.canonicalize().unwrap();
        let moved = parent.path().join("moved");
        let error = read_project_file_with_hook(&root, 7, &request("data.txt", 100), || {
            fs::rename(&root, &moved).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("data.txt"), b"replacement").unwrap();
        })
        .unwrap_err();
        assert_eq!(error.code, ProjectFsReadErrorCode::FileChanged);
    }

    #[test]
    fn identical_paths_are_project_isolated() {
        let project_a = tempdir().unwrap();
        let project_b = tempdir().unwrap();
        fs::write(project_a.path().join("data.txt"), b"A").unwrap();
        fs::write(project_b.path().join("data.txt"), b"B").unwrap();
        let root_a = project_a.path().canonicalize().unwrap();
        let root_b = project_b.path().canonicalize().unwrap();
        let a = read_project_file(&root_a, 7, &request("data.txt", 1)).unwrap();
        let b = read_project_file(&root_b, 7, &request("data.txt", 1)).unwrap();
        assert_eq!(a.content, "QQ==");
        assert_eq!(b.content, "Qg==");
    }
}
