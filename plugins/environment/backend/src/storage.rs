//! One cooperating backend owns a native material directory at a time. The lock
//! is not a journal, sandbox or proof that previous native work has stopped.
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub struct MaterialLease {
    root: PathBuf,
    path: PathBuf,
    file: File,
    #[cfg(unix)]
    directory_identity: (u64, u64),
}
impl MaterialLease {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        if !root.is_absolute() || !root.is_dir() || root.canonicalize().map_err(error)? != root {
            return Err(
                "Environment material storage must be an existing normalized directory".into(),
            );
        }
        let path = root.join(".rho-environment-owner.lock");
        match fs::symlink_metadata(&path) {
            Ok(metadata) => valid_file(&metadata)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e)),
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(error)?;
        valid_file(&file.metadata().map_err(error)?)?;
        file.try_lock().map_err(|e| {
            format!("Environment material storage is already owned or unavailable: {e}")
        })?;
        let lease = Self {
            root: root.into(),
            path,
            file,
            #[cfg(unix)]
            directory_identity: {
                use std::os::unix::fs::MetadataExt;
                let metadata = fs::metadata(root).map_err(error)?;
                (metadata.dev(), metadata.ino())
            },
        };
        lease.check()?;
        Ok(lease)
    }
    pub fn check(&self) -> Result<(), String> {
        if self.root.canonicalize().map_err(error)? != self.root
            || self.path.canonicalize().map_err(error)? != self.path
        {
            return Err("Environment material storage identity changed".into());
        }
        let current = fs::symlink_metadata(&self.path).map_err(error)?;
        valid_file(&current)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let directory = fs::metadata(&self.root).map_err(error)?;
            if (directory.dev(), directory.ino()) != self.directory_identity {
                return Err("Environment material directory was replaced".into());
            }
            let owned = self.file.metadata().map_err(error)?;
            if current.dev() != owned.dev() || current.ino() != owned.ino() {
                return Err("Environment material lock was replaced".into());
            }
        }
        Ok(())
    }
}
impl Drop for MaterialLease {
    fn drop(&mut self) {
        if let Err(e) = self.file.unlock() {
            eprintln!("Environment storage unlock failed: {e}");
        }
    }
}
fn valid_file(metadata: &fs::Metadata) -> Result<(), String> {
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 0 {
        return Err("Environment ownership lock must be an empty regular file; existing bytes were preserved".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("Environment ownership lock cannot be a hard link".into());
        }
    }
    Ok(())
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_requires_owner_release_and_preserves_existing_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let lease = MaterialLease::acquire(&root).unwrap();
        assert!(MaterialLease::acquire(&root).is_err());
        let duplicate = lease.file.try_clone().unwrap();
        drop(lease);
        let replacement = MaterialLease::acquire(&root).unwrap();
        drop(duplicate);
        assert!(MaterialLease::acquire(&root).is_err());
        drop(replacement);
        let path = root.join(".rho-environment-owner.lock");
        fs::write(&path, b"existing user data").unwrap();
        assert!(MaterialLease::acquire(&root).is_err());
        assert_eq!(fs::read(path).unwrap(), b"existing user data");
    }
    #[cfg(unix)]
    #[test]
    fn replaced_inode_and_link_are_not_the_owned_lock() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let lease = MaterialLease::acquire(&root).unwrap();
        fs::rename(&lease.path, root.join("old-lock")).unwrap();
        fs::write(&lease.path, b"").unwrap();
        assert!(lease.check().is_err());
        drop(lease);
        let path = root.join(".rho-environment-owner.lock");
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.join("old-lock"), &path).unwrap();
        assert!(MaterialLease::acquire(&root).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn moving_the_lock_cannot_adopt_another_material_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().canonicalize().unwrap();
        let root = base.join("materials");
        fs::create_dir(&root).unwrap();
        let lease = MaterialLease::acquire(&root).unwrap();
        fs::rename(&root, base.join("previous")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::rename(
            base.join("previous/.rho-environment-owner.lock"),
            &lease.path,
        )
        .unwrap();
        assert!(
            lease
                .check()
                .unwrap_err()
                .contains("directory was replaced")
        );
    }
}
