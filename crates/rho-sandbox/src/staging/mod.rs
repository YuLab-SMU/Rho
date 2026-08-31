use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use rho_protocol::{ArtifactDigest, StagedBlobRef};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StagingError {
    #[error("staging path is unsafe")]
    UnsafePath,
    #[error("staging path escapes sandbox")]
    PathEscape,
    #[error("staging entry is a link or special file")]
    UnsafeFileType,
    #[error("staging file exceeds bound")]
    FileTooLarge,
    #[error("staging file changed after hash/close")]
    ChangedAfterSeal,
    #[error("staging IO failed")]
    Io(#[from] std::io::Error),
    #[error("staging digest is invalid")]
    Digest,
}

#[derive(Debug, Clone)]
struct FileIdentity {
    metadata: Metadata,
}

#[derive(Debug, Clone)]
pub struct SealedStagedBlob {
    reference: StagedBlobRef,
    identity: FileIdentity,
}

impl SealedStagedBlob {
    pub fn reference(&self) -> &StagedBlobRef {
        &self.reference
    }
}

#[derive(Debug, Clone)]
pub struct StagingArea {
    root: PathBuf,
    max_file_bytes: u64,
    sealed: BTreeMap<String, SealedStagedBlob>,
}

impl StagingArea {
    pub fn open(root: impl AsRef<Path>, max_file_bytes: u64) -> Result<Self, StagingError> {
        fs::create_dir_all(root.as_ref())?;
        let root = root.as_ref().canonicalize()?;
        Ok(Self {
            root,
            max_file_bytes,
            sealed: BTreeMap::new(),
        })
    }

    pub fn write_and_seal(
        &mut self,
        relative_path: &str,
        bytes: &[u8],
    ) -> Result<SealedStagedBlob, StagingError> {
        if bytes.len() as u64 > self.max_file_bytes {
            return Err(StagingError::FileTooLarge);
        }
        let relative = safe_relative(relative_path)?;
        let final_path = self.root.join(&relative);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)?;
            ensure_contained(&self.root, parent)?;
        }
        let temp = self
            .root
            .join(format!(".stage-tmp-{}", Uuid::now_v7().simple()));
        {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temp, &final_path)?;
        self.seal(relative_path)
    }

    pub fn seal(&mut self, relative_path: &str) -> Result<SealedStagedBlob, StagingError> {
        let relative = safe_relative(relative_path)?;
        let path = self.root.join(&relative);
        ensure_contained(&self.root, path.parent().unwrap_or(&self.root))?;
        let before = fs::symlink_metadata(&path)?;
        validate_regular(&before)?;
        if before.len() > self.max_file_bytes {
            return Err(StagingError::FileTooLarge);
        }
        let file = File::open(&path)?;
        let opened = file.metadata()?;
        if !same_identity(&before, &opened) {
            return Err(StagingError::ChangedAfterSeal);
        }
        let mut bytes = Vec::with_capacity(opened.len() as usize);
        file.take(self.max_file_bytes.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > self.max_file_bytes {
            return Err(StagingError::FileTooLarge);
        }
        let after = fs::symlink_metadata(&path)?;
        if !same_identity(&opened, &after)
            || opened.len() != after.len()
            || opened.modified().ok() != after.modified().ok()
        {
            return Err(StagingError::ChangedAfterSeal);
        }
        let digest = ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes)))
            .map_err(|_| StagingError::Digest)?;
        let reference = StagedBlobRef {
            relative_path: relative_path.to_string(),
            digest,
            byte_size: bytes.len() as u64,
        };
        let sealed = SealedStagedBlob {
            reference,
            identity: FileIdentity { metadata: after },
        };
        self.sealed
            .insert(relative_path.to_string(), sealed.clone());
        Ok(sealed)
    }

    pub fn read_verified(&self, sealed: &SealedStagedBlob) -> Result<Vec<u8>, StagingError> {
        let relative = safe_relative(&sealed.reference.relative_path)?;
        let path = self.root.join(relative);
        let metadata = fs::symlink_metadata(&path)?;
        validate_regular(&metadata)?;
        if !same_identity(&sealed.identity.metadata, &metadata)
            || sealed.identity.metadata.len() != metadata.len()
            || sealed.identity.metadata.modified().ok() != metadata.modified().ok()
        {
            return Err(StagingError::ChangedAfterSeal);
        }
        let bytes = fs::read(&path)?;
        let digest = ArtifactDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes)))
            .map_err(|_| StagingError::Digest)?;
        if digest != sealed.reference.digest || bytes.len() as u64 != sealed.reference.byte_size {
            return Err(StagingError::ChangedAfterSeal);
        }
        Ok(bytes)
    }

    pub fn staging_root_digest(&self) -> Result<ArtifactDigest, StagingError> {
        let mut hasher = Sha256::new();
        for (path, sealed) in &self.sealed {
            hasher.update(path.as_bytes());
            hasher.update(sealed.reference.digest.as_str().as_bytes());
            hasher.update(sealed.reference.byte_size.to_be_bytes());
        }
        ArtifactDigest::new(format!("sha256:{:x}", hasher.finalize()))
            .map_err(|_| StagingError::Digest)
    }
}

fn safe_relative(value: &str) -> Result<PathBuf, StagingError> {
    if value.is_empty() || !value.is_ascii() || value.contains('\\') {
        return Err(StagingError::UnsafePath);
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(StagingError::UnsafePath);
    }
    Ok(path.to_path_buf())
}

fn ensure_contained(root: &Path, parent: &Path) -> Result<(), StagingError> {
    let parent = parent.canonicalize()?;
    if parent.starts_with(root) {
        Ok(())
    } else {
        Err(StagingError::PathEscape)
    }
}

fn validate_regular(metadata: &Metadata) -> Result<(), StagingError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StagingError::UnsafeFileType);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(StagingError::UnsafeFileType);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino() && left.file_type() == right.file_type()
}

#[cfg(windows)]
fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    left.file_index() == right.file_index()
        && left.volume_serial_number() == right.volume_serial_number()
}

#[cfg(not(any(unix, windows)))]
fn same_identity(_left: &Metadata, _right: &Metadata) -> bool {
    false
}

pub fn staging_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "sandbox_staged_bytes",
            "hash_close_verify",
            "patch_blob_ref",
        ],
        &[
            "live_project_commit",
            "open_mutable_handle",
            "host_absolute_path",
            "shell_command",
        ],
    )
}
