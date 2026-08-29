use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use semver::Version;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

use crate::ToolchainError;

pub const TOOLCHAIN_CONFIG_FILE: &str = "rho.toml";
pub const MAX_TOOLCHAIN_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExactVersion(Version);

impl ExactVersion {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ToolchainError> {
        let value = value.as_ref();
        let parsed = Version::from_str(value)
            .map_err(|_| ToolchainError::InvalidVersion(value.to_string()))?;
        if !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed.to_string() != value {
            return Err(ToolchainError::InvalidVersion(value.to_string()));
        }
        Ok(Self(parsed))
    }
}

impl fmt::Display for ExactVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Serialize for ExactVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ExactVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonVersion(String);

impl PythonVersion {
    pub fn parse(value: impl AsRef<str>) -> Result<Self, ToolchainError> {
        let value = value.as_ref();
        if value.is_empty()
            || value.len() > 64
            || !value.as_bytes()[0].is_ascii_alphanumeric()
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-')
            })
        {
            return Err(ToolchainError::InvalidVersion(value.to_string()));
        }
        Ok(Self(value.to_string()))
    }
}

impl fmt::Display for PythonVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for PythonVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PythonVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RToolchainConfig {
    pub version: ExactVersion,
    pub manager: String,
    pub environment: String,
    pub lockfile: String,
    pub installer: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonToolchainConfig {
    pub version: PythonVersion,
    pub manager: String,
    pub project: String,
    pub lockfile: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeToolchainConfig {
    #[serde(default)]
    pub r: Option<RToolchainConfig>,
    #[serde(default)]
    pub python: Option<PythonToolchainConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolchainConfig {
    pub schema: u16,
    pub runtime: RuntimeToolchainConfig,
}

impl ToolchainConfig {
    pub fn validate(&self) -> Result<(), ToolchainError> {
        if self.schema != 1 {
            return Err(ToolchainError::InvalidConfig(format!(
                "unsupported schema {}; expected 1",
                self.schema
            )));
        }
        if self.runtime.r.is_none() && self.runtime.python.is_none() {
            return Err(ToolchainError::InvalidConfig(
                "rho.toml must configure at least one runtime".to_string(),
            ));
        }
        if let Some(r) = &self.runtime.r {
            if r.manager != "rig" || r.environment != "renv" || r.installer != "pak" {
                return Err(ToolchainError::InvalidConfig(
                    "R runtime currently requires rig + renv + pak".to_string(),
                ));
            }
            validate_relative_path("runtime.r.lockfile", &r.lockfile)?;
        }
        if let Some(python) = &self.runtime.python {
            if python.manager != "uv" {
                return Err(ToolchainError::InvalidConfig(
                    "Python runtime currently requires uv".to_string(),
                ));
            }
            validate_relative_path("runtime.python.project", &python.project)?;
            validate_relative_path("runtime.python.lockfile", &python.lockfile)?;
        }
        Ok(())
    }
}

fn validate_relative_path(label: &str, value: &str) -> Result<(), ToolchainError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err(ToolchainError::InvalidConfig(format!(
            "{label} must be a safe project-relative path"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolchainConfigDocument {
    pub project_root: PathBuf,
    pub path: PathBuf,
    pub sha256: String,
    pub config: ToolchainConfig,
}

impl ToolchainConfigDocument {
    pub fn resolve_project_path(&self, value: &str) -> Result<PathBuf, ToolchainError> {
        validate_relative_path("configured path", value)?;
        let candidate = self.project_root.join(value);
        if let Ok(resolved) = candidate.canonicalize() {
            if !resolved.starts_with(&self.project_root) {
                return Err(ToolchainError::PathContainment(resolved));
            }
            Ok(resolved)
        } else {
            Ok(candidate)
        }
    }
}

pub fn load_toolchain_config(
    project_root: &Path,
) -> Result<ToolchainConfigDocument, ToolchainError> {
    let project_root = project_root.canonicalize()?;
    if !project_root.is_dir() {
        return Err(ToolchainError::PathContainment(project_root));
    }
    let path = project_root.join(TOOLCHAIN_CONFIG_FILE);
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ToolchainError::MissingConfig(path.clone())
        } else {
            ToolchainError::Io(error)
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(ToolchainError::SymbolicLink(path));
    }
    if !metadata.is_file() {
        return Err(ToolchainError::InvalidConfig(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let actual = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if actual > MAX_TOOLCHAIN_CONFIG_BYTES {
        return Err(ToolchainError::ConfigTooLarge {
            limit: MAX_TOOLCHAIN_CONFIG_BYTES,
            actual,
        });
    }
    let bytes = fs::read(&path)?;
    if bytes.len() > MAX_TOOLCHAIN_CONFIG_BYTES {
        return Err(ToolchainError::ConfigTooLarge {
            limit: MAX_TOOLCHAIN_CONFIG_BYTES,
            actual: bytes.len(),
        });
    }
    let source = std::str::from_utf8(&bytes)
        .map_err(|error| ToolchainError::InvalidConfig(error.to_string()))?;
    let config: ToolchainConfig =
        toml::from_str(source).map_err(|error| ToolchainError::InvalidConfig(error.to_string()))?;
    config.validate()?;
    Ok(ToolchainConfigDocument {
        project_root,
        path,
        sha256: hex_sha256(&bytes),
        config,
    })
}

pub(crate) fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    const READY: &str = r#"schema = 1
[runtime.r]
version = "4.5.2"
manager = "rig"
environment = "renv"
lockfile = "renv.lock"
installer = "pak"
[runtime.python]
version = "3.12"
manager = "uv"
project = "pyproject.toml"
lockfile = "uv.lock"
"#;

    #[test]
    fn strict_config_matches_the_canonical_cross_runtime_schema() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("rho.toml"), READY).unwrap();
        let document = load_toolchain_config(root.path()).unwrap();
        assert_eq!(
            document.config.runtime.r.unwrap().version.to_string(),
            "4.5.2"
        );
        assert_eq!(
            document.config.runtime.python.unwrap().version.to_string(),
            "3.12"
        );

        fs::write(
            root.path().join("rho.toml"),
            READY.replace("version = \"4.5.2\"", "version = \"release\""),
        )
        .unwrap();
        assert!(load_toolchain_config(root.path()).is_err());

        fs::write(
            root.path().join("rho.toml"),
            READY.replace("lockfile = \"uv.lock\"", "lockfile = \"../uv.lock\""),
        )
        .unwrap();
        assert!(load_toolchain_config(root.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn config_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = root.path().join("outside.toml");
        fs::write(&outside, READY).unwrap();
        symlink(&outside, root.path().join("rho.toml")).unwrap();
        assert!(matches!(
            load_toolchain_config(root.path()),
            Err(ToolchainError::SymbolicLink(_))
        ));
    }
}
