use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::receipt::validate_identity;
use crate::{OperationJournal, RemoteHelperOperation, RemoteHelperRequest, ToolchainError};

const REMOTE_OPERATION_MIRROR_SCHEMA: u16 = 1;
const MAX_REMOTE_OPERATION_MIRROR_BYTES: usize = 3 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteOperationMirrorStatus {
    Prepared,
    Dispatching,
    Uncertain,
    Succeeded,
    Failed,
}

impl RemoteOperationMirrorStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

/// Local durable authority for one mutating request sent to a remote Helper.
///
/// The mirror deliberately stores the request digest rather than the request
/// payload so command environments are not copied into another durable file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteOperationMirror {
    pub schema_version: u16,
    pub operation_id: String,
    pub request_id: String,
    pub operation: RemoteHelperOperation,
    pub status: RemoteOperationMirrorStatus,
    pub local_project_root: PathBuf,
    pub remote_project_root: String,
    pub rho_toml_sha256: String,
    pub target_id: String,
    pub target_registry_sha256: String,
    pub request_sha256: String,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub partial_effects_possible: bool,
    pub remote_status: Option<String>,
    pub remote_journal: Option<OperationJournal>,
    pub error: Option<String>,
}

impl RemoteOperationMirror {
    fn new(
        local_project_root: PathBuf,
        operation_id: &str,
        request: &RemoteHelperRequest,
    ) -> Result<Self, ToolchainError> {
        validate_identity(operation_id)?;
        validate_identity(&request.request_id)?;
        crate::validate_target_id(&request.target_id)?;
        if !request.operation.is_effect() {
            return Err(ToolchainError::InvalidJournal(
                "only remote effect requests have an operation mirror".to_string(),
            ));
        }
        if request
            .payload
            .get("operation_id")
            .and_then(serde_json::Value::as_str)
            != Some(operation_id)
        {
            return Err(ToolchainError::InvalidJournal(
                "remote request and mirror operation identities differ".to_string(),
            ));
        }
        let request_bytes = serde_json::to_vec(request)?;
        let now = Utc::now().to_rfc3339();
        let mirror = Self {
            schema_version: REMOTE_OPERATION_MIRROR_SCHEMA,
            operation_id: operation_id.to_string(),
            request_id: request.request_id.clone(),
            operation: request.operation,
            status: RemoteOperationMirrorStatus::Prepared,
            local_project_root,
            remote_project_root: request.project_root.clone(),
            rho_toml_sha256: request.rho_toml_sha256.clone(),
            target_id: request.target_id.clone(),
            target_registry_sha256: request.target_registry_sha256.clone(),
            request_sha256: format!("{:x}", Sha256::digest(request_bytes)),
            created_at: now.clone(),
            updated_at: now,
            finished_at: None,
            partial_effects_possible: false,
            remote_status: None,
            remote_journal: None,
            error: None,
        };
        mirror.validate()?;
        Ok(mirror)
    }

    fn validate(&self) -> Result<(), ToolchainError> {
        if self.schema_version != REMOTE_OPERATION_MIRROR_SCHEMA {
            return Err(ToolchainError::InvalidJournal(
                "unsupported remote operation mirror schema".to_string(),
            ));
        }
        validate_identity(&self.operation_id)?;
        validate_identity(&self.request_id)?;
        crate::validate_target_id(&self.target_id)?;
        if !self.operation.is_effect() {
            return Err(ToolchainError::InvalidJournal(
                "remote operation mirror is not an effect".to_string(),
            ));
        }
        if !self.local_project_root.is_absolute()
            || self.remote_project_root.trim() != self.remote_project_root
            || self.remote_project_root.is_empty()
        {
            return Err(ToolchainError::InvalidJournal(
                "remote operation mirror project identity is invalid".to_string(),
            ));
        }
        for (label, digest) in [
            ("rho.toml", &self.rho_toml_sha256),
            ("target registry", &self.target_registry_sha256),
            ("request", &self.request_sha256),
        ] {
            if !valid_sha256(digest) {
                return Err(ToolchainError::InvalidJournal(format!(
                    "remote operation mirror {label} digest is invalid"
                )));
            }
        }
        if self.status.is_terminal() != self.finished_at.is_some() {
            return Err(ToolchainError::InvalidJournal(
                "remote operation mirror terminal timestamp is inconsistent".to_string(),
            ));
        }
        if self.status == RemoteOperationMirrorStatus::Uncertain
            && (!self.partial_effects_possible || self.error.is_none())
        {
            return Err(ToolchainError::InvalidJournal(
                "uncertain remote operation mirror must preserve uncertainty detail".to_string(),
            ));
        }
        if self.status == RemoteOperationMirrorStatus::Succeeded
            && (self.error.is_some() || self.partial_effects_possible)
        {
            return Err(ToolchainError::InvalidJournal(
                "successful remote operation mirror contains failure state".to_string(),
            ));
        }
        if let Some(journal) = &self.remote_journal
            && journal.operation_id != self.operation_id
        {
            return Err(ToolchainError::InvalidJournal(
                "remote journal identity differs from its local mirror".to_string(),
            ));
        }
        Ok(())
    }

    fn immutable_identity_matches(&self, other: &Self) -> bool {
        self.schema_version == other.schema_version
            && self.operation_id == other.operation_id
            && self.request_id == other.request_id
            && self.operation == other.operation
            && self.local_project_root == other.local_project_root
            && self.remote_project_root == other.remote_project_root
            && self.rho_toml_sha256 == other.rho_toml_sha256
            && self.target_id == other.target_id
            && self.target_registry_sha256 == other.target_registry_sha256
            && self.request_sha256 == other.request_sha256
            && self.created_at == other.created_at
    }
}

pub fn remote_operation_mirror_path(
    project_root: &Path,
    operation_id: &str,
) -> Result<PathBuf, ToolchainError> {
    validate_identity(operation_id)?;
    let project_root = project_root.canonicalize()?;
    Ok(project_root
        .join(".rho")
        .join("toolchain")
        .join("remote-operations")
        .join(operation_id)
        .join("mirror.json"))
}

pub fn create_remote_operation_mirror(
    project_root: &Path,
    operation_id: &str,
    request: &RemoteHelperRequest,
) -> Result<RemoteOperationMirror, ToolchainError> {
    let path = remote_operation_mirror_path(project_root, operation_id)?;
    ensure_safe_parent(
        &project_root.canonicalize()?,
        path.parent().expect("mirror path has a parent"),
    )?;
    if path.exists() {
        return Err(ToolchainError::InvalidJournal(format!(
            "remote operation identity already exists: {operation_id}"
        )));
    }
    let mirror = RemoteOperationMirror::new(project_root.canonicalize()?, operation_id, request)?;
    persist(&path, &mirror, false)?;
    Ok(mirror)
}

pub fn read_remote_operation_mirror(
    project_root: &Path,
    operation_id: &str,
) -> Result<RemoteOperationMirror, ToolchainError> {
    let path = remote_operation_mirror_path(project_root, operation_id)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ToolchainError::InvalidJournal(
            "remote operation mirror is not a regular file".to_string(),
        ));
    }
    if metadata.len() > MAX_REMOTE_OPERATION_MIRROR_BYTES as u64 {
        return Err(ToolchainError::InvalidJournal(
            "remote operation mirror exceeds the byte bound".to_string(),
        ));
    }
    let mirror: RemoteOperationMirror = serde_json::from_slice(&fs::read(path)?)?;
    mirror.validate()?;
    if mirror.local_project_root != project_root.canonicalize()? {
        return Err(ToolchainError::InvalidJournal(
            "remote operation mirror belongs to another project".to_string(),
        ));
    }
    Ok(mirror)
}

pub fn update_remote_operation_mirror(
    project_root: &Path,
    mirror: &RemoteOperationMirror,
) -> Result<(), ToolchainError> {
    mirror.validate()?;
    let path = remote_operation_mirror_path(project_root, &mirror.operation_id)?;
    let current = read_remote_operation_mirror(project_root, &mirror.operation_id)?;
    if !current.immutable_identity_matches(mirror) {
        return Err(ToolchainError::InvalidJournal(
            "remote operation mirror immutable identity changed".to_string(),
        ));
    }
    let allowed = current.status == mirror.status
        || matches!(
            (current.status, mirror.status),
            (
                RemoteOperationMirrorStatus::Prepared,
                RemoteOperationMirrorStatus::Dispatching | RemoteOperationMirrorStatus::Failed
            ) | (
                RemoteOperationMirrorStatus::Dispatching,
                RemoteOperationMirrorStatus::Uncertain
                    | RemoteOperationMirrorStatus::Succeeded
                    | RemoteOperationMirrorStatus::Failed
            ) | (
                RemoteOperationMirrorStatus::Uncertain,
                RemoteOperationMirrorStatus::Succeeded | RemoteOperationMirrorStatus::Failed
            )
        );
    if !allowed {
        return Err(ToolchainError::InvalidJournal(format!(
            "invalid remote operation mirror transition from {:?} to {:?}",
            current.status, mirror.status
        )));
    }
    persist(&path, mirror, true)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_safe_parent(project_root: &Path, parent: &Path) -> Result<(), ToolchainError> {
    let mut current = project_root.to_path_buf();
    for component in parent
        .strip_prefix(project_root)
        .map_err(|_| ToolchainError::PathContainment(parent.to_path_buf()))?
    {
        current.push(component);
        if current.exists() {
            if fs::symlink_metadata(&current)?.file_type().is_symlink() {
                return Err(ToolchainError::SymbolicLink(current));
            }
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(())
}

fn persist(
    path: &Path,
    mirror: &RemoteOperationMirror,
    replace: bool,
) -> Result<(), ToolchainError> {
    let bytes = serde_json::to_vec_pretty(mirror)?;
    if bytes.len() > MAX_REMOTE_OPERATION_MIRROR_BYTES {
        return Err(ToolchainError::InvalidJournal(
            "remote operation mirror exceeds the byte bound".to_string(),
        ));
    }
    let temporary = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        if !replace && path.exists() {
            return Err(ToolchainError::InvalidJournal(format!(
                "remote operation identity already exists: {}",
                mirror.operation_id
            )));
        }
        #[cfg(windows)]
        if replace && path.exists() {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            OpenOptions::new().read(true).open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RemoteHelperRequest;
    use tempfile::tempdir;

    fn request() -> RemoteHelperRequest {
        RemoteHelperRequest {
            protocol: 1,
            request_id: "request-001".to_string(),
            target_id: "lab".to_string(),
            project_root: "/remote/project".to_string(),
            rho_toml_sha256: "a".repeat(64),
            target_registry_sha256: "b".repeat(64),
            operation: RemoteHelperOperation::Run,
            payload: serde_json::json!({"operation_id": "run-001"}),
        }
    }

    #[test]
    fn local_mirror_is_durable_before_remote_dispatch() {
        let root = tempdir().unwrap();
        let mirror = create_remote_operation_mirror(root.path(), "run-001", &request()).unwrap();
        assert_eq!(mirror.status, RemoteOperationMirrorStatus::Prepared);
        assert!(
            remote_operation_mirror_path(root.path(), "run-001")
                .unwrap()
                .is_file()
        );
        assert_eq!(
            read_remote_operation_mirror(root.path(), "run-001").unwrap(),
            mirror
        );
        assert!(create_remote_operation_mirror(root.path(), "run-001", &request()).is_err());
    }

    #[test]
    fn mirror_updates_preserve_identity_and_terminal_truth() {
        let root = tempdir().unwrap();
        let mut mirror =
            create_remote_operation_mirror(root.path(), "run-001", &request()).unwrap();
        mirror.status = RemoteOperationMirrorStatus::Dispatching;
        mirror.updated_at = Utc::now().to_rfc3339();
        update_remote_operation_mirror(root.path(), &mirror).unwrap();
        mirror.status = RemoteOperationMirrorStatus::Failed;
        mirror.finished_at = Some(Utc::now().to_rfc3339());
        mirror.updated_at = mirror.finished_at.clone().unwrap();
        mirror.error = Some("remote command failed".to_string());
        update_remote_operation_mirror(root.path(), &mirror).unwrap();
        assert_eq!(
            read_remote_operation_mirror(root.path(), "run-001")
                .unwrap()
                .status,
            RemoteOperationMirrorStatus::Failed
        );

        let mut rewritten = mirror;
        rewritten.request_sha256 = "c".repeat(64);
        assert!(update_remote_operation_mirror(root.path(), &rewritten).is_err());
    }
}
