use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ToolchainError;

pub const TARGET_REGISTRY_FILE: &str = "targets.yaml";
pub const LOCAL_TARGET_ID: &str = "local";
const MAX_TARGET_REGISTRY_BYTES: usize = 256 * 1024;
const MAX_TARGETS: usize = 128;
const MAX_CAPABILITIES: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputeHost {
    Local,
    Ssh {
        host: String,
        #[serde(default)]
        username: Option<String>,
        #[serde(default = "default_ssh_port")]
        port: u16,
        host_fingerprint: String,
        remote_root: String,
        #[serde(default)]
        identity_file: Option<String>,
    },
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComputeIsolation {
    Native,
    Docker {
        #[serde(default = "default_docker_engine")]
        engine: String,
        image: String,
        #[serde(default = "default_container_r_library")]
        r_library: String,
        #[serde(default = "default_container_python_environment")]
        python_environment: String,
    },
    Conda {
        environment: String,
        explicit_spec_sha256: String,
    },
}

fn default_docker_engine() -> String {
    "docker".to_string()
}

fn default_container_r_library() -> String {
    "/opt/rho/renv/library".to_string()
}

fn default_container_python_environment() -> String {
    "/opt/rho/.venv".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputeTarget {
    pub host: ComputeHost,
    pub isolation: ComputeIsolation,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl ComputeTarget {
    pub fn local_native() -> Self {
        Self {
            host: ComputeHost::Local,
            isolation: ComputeIsolation::Native,
            capabilities: vec!["cpu".to_string()],
        }
    }

    pub fn host_kind(&self) -> &'static str {
        match self.host {
            ComputeHost::Local => "local",
            ComputeHost::Ssh { .. } => "ssh",
        }
    }

    pub fn isolation_kind(&self) -> &'static str {
        match self.isolation {
            ComputeIsolation::Native => "native",
            ComputeIsolation::Docker { .. } => "docker",
            ComputeIsolation::Conda { .. } => "conda",
        }
    }

    fn validate(&self, target_id: &str) -> Result<(), ToolchainError> {
        validate_target_id(target_id)?;
        validate_capabilities(&self.capabilities)?;
        match &self.host {
            ComputeHost::Local => {}
            ComputeHost::Ssh {
                host,
                username,
                port,
                host_fingerprint,
                remote_root,
                identity_file,
            } => {
                validate_token("SSH host", host, 255)?;
                if let Some(username) = username {
                    validate_token("SSH username", username, 128)?;
                }
                if *port == 0 {
                    return Err(ToolchainError::InvalidTarget(
                        "SSH port must be positive".to_string(),
                    ));
                }
                if !host_fingerprint.starts_with("SHA256:")
                    || host_fingerprint.len() < "SHA256:".len() + 32
                    || host_fingerprint.chars().any(char::is_whitespace)
                {
                    return Err(ToolchainError::InvalidTarget(
                        "SSH target requires a pinned SHA256 host fingerprint".to_string(),
                    ));
                }
                if remote_root.trim() != remote_root
                    || remote_root.is_empty()
                    || remote_root.len() > 1024
                    || remote_root.chars().any(char::is_control)
                {
                    return Err(ToolchainError::InvalidTarget(
                        "SSH remote_root is invalid".to_string(),
                    ));
                }
                if let Some(identity_file) = identity_file {
                    let path = Path::new(identity_file);
                    if !path.is_absolute()
                        || identity_file.len() > 1024
                        || identity_file.chars().any(char::is_control)
                        || path
                            .components()
                            .any(|component| component == std::path::Component::ParentDir)
                    {
                        return Err(ToolchainError::InvalidTarget(
                            "SSH identity_file must be an absolute normalized path".to_string(),
                        ));
                    }
                }
            }
        }
        match &self.isolation {
            ComputeIsolation::Native => {}
            ComputeIsolation::Docker {
                engine,
                image,
                r_library,
                python_environment,
            } => {
                if !matches!(engine.as_str(), "docker" | "podman") {
                    return Err(ToolchainError::InvalidTarget(
                        "container engine must be docker or podman".to_string(),
                    ));
                }
                let Some((name, digest)) = image.rsplit_once("@sha256:") else {
                    return Err(ToolchainError::InvalidTarget(
                        "container image must use an immutable @sha256 digest".to_string(),
                    ));
                };
                if name.is_empty()
                    || digest.len() != 64
                    || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(ToolchainError::InvalidTarget(
                        "container image digest is invalid".to_string(),
                    ));
                }
                for (label, path) in [
                    ("container r_library", r_library),
                    ("container python_environment", python_environment),
                ] {
                    if !path.starts_with('/')
                        || path.len() > 1024
                        || path.split('/').any(|segment| segment == "..")
                        || path.chars().any(char::is_control)
                    {
                        return Err(ToolchainError::InvalidTarget(format!(
                            "{label} must be an absolute normalized container path"
                        )));
                    }
                }
            }
            ComputeIsolation::Conda {
                environment,
                explicit_spec_sha256,
            } => {
                validate_token("Conda environment", environment, 256)?;
                if explicit_spec_sha256.len() != 64
                    || !explicit_spec_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(ToolchainError::InvalidTarget(
                        "Conda target requires an exact explicit-spec SHA-256".to_string(),
                    ));
                }
            }
        }
        if target_id == LOCAL_TARGET_ID
            && (!matches!(self.host, ComputeHost::Local)
                || !matches!(self.isolation, ComputeIsolation::Native))
        {
            return Err(ToolchainError::InvalidTarget(
                "the built-in local target must remain local/native".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetRegistryFile {
    schema: u16,
    #[serde(default)]
    targets: BTreeMap<String, ComputeTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRegistry {
    pub targets: BTreeMap<String, ComputeTarget>,
}

impl TargetRegistry {
    pub fn local_only() -> Self {
        Self {
            targets: BTreeMap::from([(LOCAL_TARGET_ID.to_string(), ComputeTarget::local_native())]),
        }
    }

    pub fn resolve(&self, target_id: &str) -> Result<&ComputeTarget, ToolchainError> {
        validate_target_id(target_id)?;
        self.targets
            .get(target_id)
            .ok_or_else(|| ToolchainError::TargetNotFound(target_id.to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRegistryDocument {
    pub rho_home: PathBuf,
    pub path: PathBuf,
    pub sha256: Option<String>,
    pub registry: TargetRegistry,
}

pub fn load_target_registry(rho_home: &Path) -> Result<TargetRegistryDocument, ToolchainError> {
    if !rho_home.is_absolute() {
        return Err(ToolchainError::InvalidTarget(
            "Rho home must be an absolute path".to_string(),
        ));
    }
    let path = rho_home.join(TARGET_REGISTRY_FILE);
    if !path.exists() {
        return Ok(TargetRegistryDocument {
            rho_home: rho_home.to_path_buf(),
            path,
            sha256: None,
            registry: TargetRegistry::local_only(),
        });
    }
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Err(ToolchainError::SymbolicLink(path));
    }
    if !metadata.is_file() {
        return Err(ToolchainError::InvalidTarget(
            "targets.yaml is not a regular file".to_string(),
        ));
    }
    let bytes = fs::read(&path)?;
    if bytes.len() > MAX_TARGET_REGISTRY_BYTES {
        return Err(ToolchainError::InvalidTarget(format!(
            "targets.yaml exceeds {MAX_TARGET_REGISTRY_BYTES} bytes"
        )));
    }
    let file: TargetRegistryFile = serde_norway::from_slice(&bytes)
        .map_err(|error| ToolchainError::InvalidTarget(error.to_string()))?;
    if file.schema != 1 {
        return Err(ToolchainError::InvalidTarget(format!(
            "unsupported targets.yaml schema {}",
            file.schema
        )));
    }
    if file.targets.len() > MAX_TARGETS {
        return Err(ToolchainError::InvalidTarget(format!(
            "targets.yaml exceeds {MAX_TARGETS} targets"
        )));
    }
    let mut targets = file.targets;
    targets
        .entry(LOCAL_TARGET_ID.to_string())
        .or_insert_with(ComputeTarget::local_native);
    for (id, target) in &targets {
        target.validate(id)?;
    }
    Ok(TargetRegistryDocument {
        rho_home: rho_home.to_path_buf(),
        path,
        sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
        registry: TargetRegistry { targets },
    })
}

pub fn validate_compute_target(
    target_id: &str,
    target: &ComputeTarget,
) -> Result<(), ToolchainError> {
    target.validate(target_id)
}

pub fn validate_target_id(value: &str) -> Result<(), ToolchainError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ToolchainError::InvalidTarget(format!(
            "invalid target id {value:?}"
        )));
    }
    Ok(())
}

fn validate_capabilities(values: &[String]) -> Result<(), ToolchainError> {
    if values.len() > MAX_CAPABILITIES {
        return Err(ToolchainError::InvalidTarget(
            "target has too many capabilities".to_string(),
        ));
    }
    let mut seen = BTreeSet::new();
    for value in values {
        validate_token("target capability", value, 128)?;
        if !seen.insert(value) {
            return Err(ToolchainError::InvalidTarget(
                "target capabilities contain duplicates".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_token(label: &str, value: &str, maximum: usize) -> Result<(), ToolchainError> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(ToolchainError::InvalidTarget(format!("{label} is invalid")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn missing_registry_still_provides_immutable_local_native() {
        let root = tempdir().unwrap();
        let document = load_target_registry(root.path()).unwrap();
        assert!(document.sha256.is_none());
        let local = document.registry.resolve("local").unwrap();
        assert_eq!(local.host_kind(), "local");
        assert_eq!(local.isolation_kind(), "native");
    }

    #[test]
    fn registry_composes_host_and_isolation_without_credentials() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("targets.yaml"),
            r#"schema: 1
targets:
  lab-gpu:
    host:
      kind: ssh
      host: gnode01
      username: scientist
      port: 22
      host_fingerprint: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDE
      remote_root: /data/projects
      identity_file: /home/scientist/.ssh/rho_lab
    isolation:
      kind: docker
      engine: docker
      image: registry.example/rho@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    capabilities: [cpu, gpu]
"#,
        )
        .unwrap();
        let document = load_target_registry(root.path()).unwrap();
        let target = document.registry.resolve("lab-gpu").unwrap();
        assert_eq!(target.host_kind(), "ssh");
        assert_eq!(target.isolation_kind(), "docker");
        assert!(matches!(
            &target.host,
            ComputeHost::Ssh { identity_file: Some(path), .. }
                if path == "/home/scientist/.ssh/rho_lab"
        ));
        assert!(document.registry.resolve("local").is_ok());
    }

    #[test]
    fn mutable_container_tags_and_local_override_are_rejected() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("targets.yaml"),
            "schema: 1\ntargets:\n  local:\n    host:\n      kind: local\n    isolation:\n      kind: docker\n      image: rho:latest\n",
        )
        .unwrap();
        assert!(load_target_registry(root.path()).is_err());
    }
}
