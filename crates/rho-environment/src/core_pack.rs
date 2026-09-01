use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

use rho_protocol::{AuthorityDigest, RuntimeRealizationId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_PACK_FILES: usize = 1_000;
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub enum CoreSupportPackError {
    #[error("Core Support Pack I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Core Support Pack JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Core Support Pack path is invalid: {0}")]
    InvalidPath(String),
    #[error("Core Support Pack manifest is invalid: {0}")]
    InvalidManifest(String),
    #[error("Core Support Pack bytes do not match {0}")]
    DigestMismatch(String),
    #[error("Core Support Pack is missing: {0}")]
    Missing(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreSupportPackageV1 {
    pub name: String,
    pub version: String,
    pub relative_path: String,
    pub digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreSupportPackManifestV1 {
    pub schema_version: u16,
    pub pack_id: String,
    pub runtime_id: RuntimeRealizationId,
    pub packages: Vec<CoreSupportPackageV1>,
    pub created_at: String,
}

impl CoreSupportPackManifestV1 {
    pub fn new(
        runtime_id: RuntimeRealizationId,
        mut packages: Vec<CoreSupportPackageV1>,
        created_at: String,
    ) -> Result<Self, CoreSupportPackError> {
        packages.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.version.cmp(&right.version))
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        let mut candidate = Self {
            schema_version: 1,
            pack_id: String::new(),
            runtime_id,
            packages,
            created_at,
        };
        candidate.validate_without_identity()?;
        let digest = digest_json(&candidate)?;
        candidate.pack_id = format!(
            "core_pack_{}",
            digest.as_str().trim_start_matches("sha256:")
        );
        candidate.validate()?;
        Ok(candidate)
    }

    pub fn validate(&self) -> Result<(), CoreSupportPackError> {
        self.validate_without_identity()?;
        let mut candidate = self.clone();
        candidate.pack_id.clear();
        let expected = digest_json(&candidate)?;
        if self.pack_id
            != format!(
                "core_pack_{}",
                expected.as_str().trim_start_matches("sha256:")
            )
        {
            return Err(CoreSupportPackError::InvalidManifest(
                "pack identity does not match canonical manifest".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_without_identity(&self) -> Result<(), CoreSupportPackError> {
        if self.schema_version != 1
            || self.packages.is_empty()
            || self.packages.len() > MAX_PACK_FILES
        {
            return Err(CoreSupportPackError::InvalidManifest(
                "schema or package count is invalid".to_string(),
            ));
        }
        let mut identities = std::collections::BTreeSet::new();
        for package in &self.packages {
            validate_token("package name", &package.name)?;
            validate_token("package version", &package.version)?;
            validate_relative(&package.relative_path)?;
            if !identities.insert((package.name.clone(), package.relative_path.clone())) {
                return Err(CoreSupportPackError::InvalidManifest(
                    "package identity is duplicated".to_string(),
                ));
            }
        }
        validate_token("created_at", &self.created_at)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreSupportPackActivationV1 {
    pub schema_version: u16,
    pub runtime_id: RuntimeRealizationId,
    pub pack_id: String,
    pub manifest_digest: AuthorityDigest,
}

#[derive(Debug, Clone)]
pub struct CoreSupportPackStore {
    runtime_id: RuntimeRealizationId,
    base: PathBuf,
    staging: PathBuf,
    packs: PathBuf,
    active: PathBuf,
}

impl CoreSupportPackStore {
    pub fn open(
        rho_home: impl AsRef<Path>,
        runtime_id: RuntimeRealizationId,
    ) -> Result<Self, CoreSupportPackError> {
        let rho_home = rho_home.as_ref();
        if !rho_home.is_absolute() {
            return Err(CoreSupportPackError::InvalidPath(
                "Rho home must be absolute".to_string(),
            ));
        }
        let rho_home = fs::canonicalize(rho_home)?;
        ensure_existing_path_not_symlinked(&rho_home)?;
        let base = rho_home
            .join("environment")
            .join("core")
            .join(runtime_id.as_str());
        let staging = base.join("staging");
        let packs = base.join("packs");
        fs::create_dir_all(&staging)?;
        fs::create_dir_all(&packs)?;
        ensure_existing_path_not_symlinked(&base)?;
        Ok(Self {
            runtime_id,
            active: base.join("active.json"),
            base,
            staging,
            packs,
        })
    }

    pub fn staging_path(&self, staging_id: &str) -> Result<PathBuf, CoreSupportPackError> {
        validate_token("staging id", staging_id)?;
        Ok(self.staging.join(staging_id))
    }

    pub fn commit_staged_pack(
        &self,
        staging_path: impl AsRef<Path>,
        manifest: &CoreSupportPackManifestV1,
    ) -> Result<PathBuf, CoreSupportPackError> {
        manifest.validate()?;
        if manifest.runtime_id != self.runtime_id {
            return Err(CoreSupportPackError::InvalidManifest(
                "manifest belongs to another Runtime realization".to_string(),
            ));
        }
        let staging_path = staging_path.as_ref();
        if staging_path.parent() != Some(self.staging.as_path()) {
            return Err(CoreSupportPackError::InvalidPath(
                "staging directory is outside this Runtime pack store".to_string(),
            ));
        }
        ensure_existing_path_not_symlinked(staging_path)?;
        verify_package_bytes(staging_path, manifest)?;
        let manifest_bytes = serde_json::to_vec(manifest)?;
        if manifest_bytes.len() > MAX_MANIFEST_BYTES {
            return Err(CoreSupportPackError::InvalidManifest(
                "manifest exceeds byte bound".to_string(),
            ));
        }
        fs::write(staging_path.join("manifest.json"), &manifest_bytes)?;
        let target = self.packs.join(&manifest.pack_id);
        if target.exists() {
            let existing = self.read_manifest(&manifest.pack_id)?;
            if &existing != manifest {
                return Err(CoreSupportPackError::InvalidManifest(
                    "immutable pack identity already has different content".to_string(),
                ));
            }
            verify_package_bytes(&target, manifest)?;
            return Ok(target);
        }
        fs::rename(staging_path, &target)?;
        verify_package_bytes(&target, manifest)?;
        Ok(target)
    }

    pub fn activate(
        &self,
        pack_id: &str,
    ) -> Result<CoreSupportPackActivationV1, CoreSupportPackError> {
        validate_token("pack id", pack_id)?;
        let manifest = self.read_manifest(pack_id)?;
        verify_package_bytes(&self.packs.join(pack_id), &manifest)?;
        let activation = CoreSupportPackActivationV1 {
            schema_version: 1,
            runtime_id: self.runtime_id.clone(),
            pack_id: pack_id.to_string(),
            manifest_digest: digest_json(&manifest)?,
        };
        let bytes = serde_json::to_vec(&activation)?;
        let temporary = self.base.join(format!("active.tmp.{}", std::process::id()));
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &self.active)?;
        Ok(activation)
    }

    pub fn active(&self) -> Result<Option<CoreSupportPackActivationV1>, CoreSupportPackError> {
        if !self.active.exists() {
            return Ok(None);
        }
        ensure_regular_file(&self.active)?;
        let activation: CoreSupportPackActivationV1 =
            serde_json::from_slice(&fs::read(&self.active)?)?;
        if activation.runtime_id != self.runtime_id {
            return Err(CoreSupportPackError::InvalidManifest(
                "active pointer belongs to another Runtime realization".to_string(),
            ));
        }
        let manifest = self.read_manifest(&activation.pack_id)?;
        verify_package_bytes(&self.packs.join(&activation.pack_id), &manifest)?;
        if digest_json(&manifest)? != activation.manifest_digest {
            return Err(CoreSupportPackError::DigestMismatch(
                "active manifest".to_string(),
            ));
        }
        Ok(Some(activation))
    }

    pub fn read_manifest(
        &self,
        pack_id: &str,
    ) -> Result<CoreSupportPackManifestV1, CoreSupportPackError> {
        validate_token("pack id", pack_id)?;
        let path = self.packs.join(pack_id).join("manifest.json");
        if !path.is_file() {
            return Err(CoreSupportPackError::Missing(pack_id.to_string()));
        }
        ensure_regular_file(&path)?;
        let bytes = fs::read(path)?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(CoreSupportPackError::InvalidManifest(
                "manifest exceeds byte bound".to_string(),
            ));
        }
        let manifest: CoreSupportPackManifestV1 = serde_json::from_slice(&bytes)?;
        manifest.validate()?;
        Ok(manifest)
    }
}

fn verify_package_bytes(
    root: &Path,
    manifest: &CoreSupportPackManifestV1,
) -> Result<(), CoreSupportPackError> {
    for package in &manifest.packages {
        let path = root.join(&package.relative_path);
        ensure_regular_file(&path)?;
        let digest = digest_file(&path)?;
        if digest != package.digest {
            return Err(CoreSupportPackError::DigestMismatch(
                package.relative_path.clone(),
            ));
        }
    }
    Ok(())
}

fn digest_file(path: &Path) -> Result<AuthorityDigest, CoreSupportPackError> {
    let bytes = fs::read(path)?;
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| CoreSupportPackError::InvalidManifest(error.to_string()))
}

fn digest_json(value: &impl Serialize) -> Result<AuthorityDigest, CoreSupportPackError> {
    let bytes = serde_json::to_vec(value)?;
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| CoreSupportPackError::InvalidManifest(error.to_string()))
}

fn validate_relative(path: &str) -> Result<(), CoreSupportPackError> {
    let path_value = Path::new(path);
    if path.is_empty()
        || path.len() > 4_096
        || path.chars().any(char::is_control)
        || path_value.is_absolute()
        || path_value.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreSupportPackError::InvalidPath(path.to_string()));
    }
    Ok(())
}

fn validate_token(label: &str, value: &str) -> Result<(), CoreSupportPackError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        return Err(CoreSupportPackError::InvalidManifest(format!(
            "{label} is invalid"
        )));
    }
    Ok(())
}

fn ensure_existing_path_not_symlinked(path: &Path) -> Result<(), CoreSupportPackError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if current.exists() && fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(CoreSupportPackError::InvalidPath(format!(
                "{} is a symbolic link",
                current.display()
            )));
        }
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> Result<(), CoreSupportPackError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| CoreSupportPackError::Missing(path.display().to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreSupportPackError::InvalidPath(
            path.display().to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn stage(
        store: &CoreSupportPackStore,
        id: &str,
        contents: &[u8],
    ) -> (PathBuf, CoreSupportPackManifestV1) {
        let staging = store.staging_path(id).unwrap();
        fs::create_dir_all(staging.join("library/rho.bridge")).unwrap();
        let relative = "library/rho.bridge/DESCRIPTION";
        fs::write(staging.join(relative), contents).unwrap();
        let manifest = CoreSupportPackManifestV1::new(
            store.runtime_id.clone(),
            vec![CoreSupportPackageV1 {
                name: "rho.bridge".to_string(),
                version: "0.1.0".to_string(),
                relative_path: relative.to_string(),
                digest: digest_file(&staging.join(relative)).unwrap(),
            }],
            "2026-09-01T12:00:00Z".to_string(),
        )
        .unwrap();
        (staging, manifest)
    }

    #[test]
    fn immutable_packs_activate_and_roll_back_by_pointer() {
        let directory = tempdir().unwrap();
        let store = CoreSupportPackStore::open(
            directory.path(),
            RuntimeRealizationId::new("runtime_realization_core_test").unwrap(),
        )
        .unwrap();
        let (first_stage, first) = stage(&store, "first", b"Version: 1\n");
        store.commit_staged_pack(&first_stage, &first).unwrap();
        store.activate(&first.pack_id).unwrap();
        assert_eq!(store.active().unwrap().unwrap().pack_id, first.pack_id);

        let (second_stage, second) = stage(&store, "second", b"Version: 2\n");
        store.commit_staged_pack(&second_stage, &second).unwrap();
        store.activate(&second.pack_id).unwrap();
        assert_eq!(store.active().unwrap().unwrap().pack_id, second.pack_id);

        store.activate(&first.pack_id).unwrap();
        assert_eq!(store.active().unwrap().unwrap().pack_id, first.pack_id);
    }

    #[test]
    fn tampered_staging_never_changes_active_pack() {
        let directory = tempdir().unwrap();
        let store = CoreSupportPackStore::open(
            directory.path(),
            RuntimeRealizationId::new("runtime_realization_core_tamper").unwrap(),
        )
        .unwrap();
        let (first_stage, first) = stage(&store, "first", b"Version: 1\n");
        store.commit_staged_pack(&first_stage, &first).unwrap();
        store.activate(&first.pack_id).unwrap();

        let (tampered_stage, tampered) = stage(&store, "tampered", b"Version: 2\n");
        fs::write(
            tampered_stage.join("library/rho.bridge/DESCRIPTION"),
            b"tampered",
        )
        .unwrap();
        assert!(
            store
                .commit_staged_pack(&tampered_stage, &tampered)
                .is_err()
        );
        assert_eq!(store.active().unwrap().unwrap().pack_id, first.pack_id);
    }
}
