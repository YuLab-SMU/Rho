use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{ToolchainConfigDocument, ToolchainError};

const MAX_RECEIPT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentReceiptMode {
    Run,
    Live,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RLibraryLayers {
    pub system: Vec<PathBuf>,
    pub user: Vec<PathBuf>,
    pub project: PathBuf,
    pub effective: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct REnvironmentReceipt {
    pub requested_version: String,
    pub resolved_version: String,
    pub installation: PathBuf,
    pub rscript: PathBuf,
    pub renv_lock_sha256: String,
    pub library_layers: RLibraryLayers,
    pub packages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonEnvironmentReceipt {
    pub requested_version: String,
    pub resolved_version: String,
    pub executable: PathBuf,
    pub venv: PathBuf,
    pub site_packages: Vec<PathBuf>,
    pub pyproject_sha256: String,
    pub uv_lock_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentReceipt {
    pub schema_version: u16,
    pub execution_id: String,
    pub mode: EnvironmentReceiptMode,
    pub project_root: PathBuf,
    pub rho_toml_sha256: String,
    pub created_at: String,
    pub operating_system: String,
    pub architecture: String,
    pub system_requirements: Vec<String>,
    pub r: Option<REnvironmentReceipt>,
    pub python: Option<PythonEnvironmentReceipt>,
}

impl EnvironmentReceipt {
    pub fn validate(&self, config: &ToolchainConfigDocument) -> Result<(), ToolchainError> {
        validate_identity(&self.execution_id)?;
        if self.schema_version != 1 {
            return Err(ToolchainError::InvalidReceipt(
                "unsupported environment receipt schema".to_string(),
            ));
        }
        if self.project_root != config.project_root || self.rho_toml_sha256 != config.sha256 {
            return Err(ToolchainError::InvalidReceipt(
                "receipt project or rho.toml identity changed".to_string(),
            ));
        }
        match (&config.config.runtime.r, &self.r) {
            (Some(expected), Some(actual))
                if actual.requested_version == expected.version.to_string()
                    && actual.resolved_version == expected.version.to_string()
                    && actual
                        .library_layers
                        .project
                        .starts_with(&config.project_root)
                    && valid_sha256(&actual.renv_lock_sha256) => {}
            (None, None) => {}
            _ => {
                return Err(ToolchainError::InvalidReceipt(
                    "R environment does not match rho.toml".to_string(),
                ));
            }
        }
        let expected_python_venv = config
            .config
            .runtime
            .python
            .as_ref()
            .map(|python| {
                config
                    .resolve_project_path(&python.project)
                    .map(|project| project.parent().unwrap().join(".venv"))
            })
            .transpose()?;
        match (&config.config.runtime.python, &self.python) {
            (Some(expected), Some(actual))
                if actual.requested_version == expected.version.to_string()
                    && python_version_matches(
                        &actual.resolved_version,
                        &actual.requested_version,
                    )
                    && Some(&actual.venv) == expected_python_venv.as_ref()
                    && valid_sha256(&actual.pyproject_sha256)
                    && valid_sha256(&actual.uv_lock_sha256) => {}
            (None, None) => {}
            _ => {
                return Err(ToolchainError::InvalidReceipt(
                    "Python environment does not match rho.toml".to_string(),
                ));
            }
        }
        if self.r.is_none() && self.python.is_none() {
            return Err(ToolchainError::InvalidReceipt(
                "receipt contains no runtime environment".to_string(),
            ));
        }
        Ok(())
    }
}

pub fn environment_receipt_path(
    project_root: &Path,
    execution_id: &str,
    mode: EnvironmentReceiptMode,
) -> Result<PathBuf, ToolchainError> {
    validate_identity(execution_id)?;
    let lane = match mode {
        EnvironmentReceiptMode::Run => "runs",
        EnvironmentReceiptMode::Live => "live",
    };
    Ok(project_root
        .join(".rho")
        .join(lane)
        .join(execution_id)
        .join("environment.json"))
}

pub fn write_environment_receipt(
    config: &ToolchainConfigDocument,
    receipt: &EnvironmentReceipt,
) -> Result<PathBuf, ToolchainError> {
    receipt.validate(config)?;
    let path = environment_receipt_path(&config.project_root, &receipt.execution_id, receipt.mode)?;
    ensure_safe_parent(&config.project_root, path.parent().unwrap())?;
    let bytes = serde_json::to_vec_pretty(receipt)?;
    if bytes.len() > MAX_RECEIPT_BYTES {
        return Err(ToolchainError::InvalidReceipt(
            "environment receipt exceeds the byte bound".to_string(),
        ));
    }
    atomic_write(&path, &bytes)?;
    Ok(path)
}

pub fn read_and_validate_environment_receipt(
    config: &ToolchainConfigDocument,
    execution_id: &str,
    mode: EnvironmentReceiptMode,
) -> Result<EnvironmentReceipt, ToolchainError> {
    let path = environment_receipt_path(&config.project_root, execution_id, mode)?;
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ToolchainError::InvalidReceipt(
            "environment.json is not a regular project file".to_string(),
        ));
    }
    let bytes = fs::read(&path)?;
    if bytes.len() > MAX_RECEIPT_BYTES {
        return Err(ToolchainError::InvalidReceipt(
            "environment receipt exceeds the byte bound".to_string(),
        ));
    }
    let receipt: EnvironmentReceipt = serde_json::from_slice(&bytes)?;
    receipt.validate(config)?;
    Ok(receipt)
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

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ToolchainError> {
    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    fs::write(&temporary, bytes)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

pub(crate) fn validate_identity(value: &str) -> Result<(), ToolchainError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ToolchainError::InvalidIdentity(value.to_string()));
    }
    Ok(())
}

fn python_version_matches(actual: &str, requested: &str) -> bool {
    actual == requested
        || actual
            .strip_prefix(requested)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::load_toolchain_config;

    #[test]
    fn run_receipt_records_and_revalidates_every_environment_layer() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.r]\nversion = \"4.5.2\"\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n",
        )
        .unwrap();
        let config = load_toolchain_config(root.path()).unwrap();
        let receipt = EnvironmentReceipt {
            schema_version: 1,
            execution_id: "run-001".to_string(),
            mode: EnvironmentReceiptMode::Run,
            project_root: config.project_root.clone(),
            rho_toml_sha256: config.sha256.clone(),
            created_at: "2026-09-01T00:00:00Z".to_string(),
            operating_system: "macos".to_string(),
            architecture: "aarch64".to_string(),
            system_requirements: vec!["libcurl".to_string()],
            r: Some(REnvironmentReceipt {
                requested_version: "4.5.2".to_string(),
                resolved_version: "4.5.2".to_string(),
                installation: PathBuf::from("/R/4.5.2"),
                rscript: PathBuf::from("/R/4.5.2/Rscript"),
                renv_lock_sha256: "a".repeat(64),
                library_layers: RLibraryLayers {
                    system: vec![PathBuf::from("/R/library")],
                    user: vec![PathBuf::from("/user/library")],
                    project: config.project_root.join("renv/library"),
                    effective: vec![config.project_root.join("renv/library")],
                },
                packages: vec!["jsonlite@2.0.0".to_string()],
            }),
            python: Some(PythonEnvironmentReceipt {
                requested_version: "3.12".to_string(),
                resolved_version: "3.12.12".to_string(),
                executable: config.project_root.join(".venv/bin/python"),
                venv: config.project_root.join(".venv"),
                site_packages: vec![
                    config
                        .project_root
                        .join(".venv/lib/python3.12/site-packages"),
                ],
                pyproject_sha256: "b".repeat(64),
                uv_lock_sha256: "c".repeat(64),
            }),
        };
        let path = write_environment_receipt(&config, &receipt).unwrap();
        assert!(path.ends_with(".rho/runs/run-001/environment.json"));
        assert_eq!(
            read_and_validate_environment_receipt(&config, "run-001", EnvironmentReceiptMode::Run,)
                .unwrap(),
            receipt
        );

        fs::write(
            root.path().join("rho.toml"),
            "schema = 1\n[runtime.r]\nversion = \"4.5.3\"\nmanager = \"rig\"\nenvironment = \"renv\"\nlockfile = \"renv.lock\"\ninstaller = \"pak\"\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n",
        )
        .unwrap();
        let changed = load_toolchain_config(root.path()).unwrap();
        assert!(read_and_validate_environment_receipt(
            &changed,
            "run-001",
            EnvironmentReceiptMode::Run,
        )
        .is_err());
    }
}
