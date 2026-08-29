use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{ExactVersion, ToolchainError};

pub const MAX_RIG_INVENTORY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RigInstallation {
    pub name: String,
    pub default: bool,
    pub version: ExactVersion,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub path: PathBuf,
    pub binary: PathBuf,
}

impl RigInstallation {
    pub fn rscript(&self) -> Result<PathBuf, ToolchainError> {
        let parent = self
            .binary
            .parent()
            .ok_or_else(|| ToolchainError::MissingRscript(self.binary.clone()))?;
        let file_name = if cfg!(windows) {
            "Rscript.exe"
        } else {
            "Rscript"
        };
        let path = parent.join(file_name);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| ToolchainError::MissingRscript(path.clone()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ToolchainError::MissingRscript(path));
        }
        Ok(path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RigInventory {
    pub installations: Vec<RigInstallation>,
}

pub fn parse_rig_inventory(source: &[u8]) -> Result<RigInventory, ToolchainError> {
    if source.len() > MAX_RIG_INVENTORY_BYTES {
        return Err(ToolchainError::InvalidRigInventory(format!(
            "inventory exceeds {MAX_RIG_INVENTORY_BYTES} bytes"
        )));
    }
    let installations: Vec<RigInstallation> = serde_json::from_slice(source)
        .map_err(|error| ToolchainError::InvalidRigInventory(error.to_string()))?;
    if installations.len() > 256 {
        return Err(ToolchainError::InvalidRigInventory(
            "inventory contains more than 256 installations".to_string(),
        ));
    }
    for installation in &installations {
        if installation.name.trim() != installation.name
            || installation.name.is_empty()
            || installation.name.len() > 128
            || installation.aliases.len() > 32
            || !installation.path.is_absolute()
            || !installation.binary.is_absolute()
        {
            return Err(ToolchainError::InvalidRigInventory(
                "installation identity or path is invalid".to_string(),
            ));
        }
    }
    Ok(RigInventory { installations })
}

pub fn resolve_r_installation<'a>(
    inventory: &'a RigInventory,
    version: &ExactVersion,
) -> Result<&'a RigInstallation, ToolchainError> {
    let matches = inventory
        .installations
        .iter()
        .filter(|installation| &installation.version == version)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Err(ToolchainError::RInstallationMissing(version.to_string())),
        [installation] => Ok(*installation),
        _ => Err(ToolchainError::AmbiguousRInstallation(version.to_string())),
    }
}

pub(crate) fn rig_inventory_command(rig: &Path, project_root: &Path) -> crate::CommandSpec {
    crate::CommandSpec {
        program: rig.to_path_buf(),
        args: vec!["list".to_string(), "--json".to_string()],
        cwd: project_root.to_path_buf(),
        env: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn resolves_exact_r_and_uses_the_adjacent_rscript() {
        let root = tempdir().unwrap();
        let bin = root.path().join("Resources");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("R"), b"").unwrap();
        fs::write(
            bin.join(if cfg!(windows) {
                "Rscript.exe"
            } else {
                "Rscript"
            }),
            b"",
        )
        .unwrap();
        let source = serde_json::to_vec(&serde_json::json!([{
            "name": "4.5-arm64",
            "default": true,
            "version": "4.5.2",
            "aliases": ["release"],
            "path": root.path(),
            "binary": bin.join("R")
        }]))
        .unwrap();
        let inventory = parse_rig_inventory(&source).unwrap();
        let selected =
            resolve_r_installation(&inventory, &ExactVersion::parse("4.5.2").unwrap()).unwrap();
        assert_eq!(selected.rscript().unwrap().parent(), Some(bin.as_path()));
        assert_eq!(selected.version.to_string(), "4.5.2");
    }

    #[test]
    fn symbolic_aliases_never_satisfy_an_inexact_config_version() {
        let source = br#"[{"name":"4.5-arm64","default":true,"version":"4.5.2","aliases":["release"],"path":"/R/4.5","binary":"/R/4.5/R"}]"#;
        let inventory = parse_rig_inventory(source).unwrap();
        assert!(ExactVersion::parse("release").is_err());
        assert!(
            resolve_r_installation(&inventory, &ExactVersion::parse("4.5.1").unwrap()).is_err()
        );
    }
}
