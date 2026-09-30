use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

use rho_operation::OperationError;

/// Cooperative ownership of one canonical project, independent of journal path.
/// This is an OS lock, not a PID record, project revision or sandbox. Keep the
/// inode in place after release; file existence says nothing about ownership.
pub(crate) struct ProjectLease {
    root: PathBuf,
    path: PathBuf,
    _file: File,
}

impl ProjectLease {
    pub(crate) fn acquire(root: &Path) -> Result<Self, OperationError> {
        let root = root.canonicalize().map_err(storage)?;
        if !root.is_dir() || root.to_str().is_none() {
            return Err(OperationError::TargetResolution(
                "project must be an existing UTF-8 directory".into(),
            ));
        }
        let directory = root.join(".rho");
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(storage(error)),
        }
        let metadata = fs::symlink_metadata(&directory).map_err(storage)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(OperationError::TargetResolution(
                "project .rho must be a real directory, not a link or file".into(),
            ));
        }
        let path = directory.join("next-host.lock");
        match fs::symlink_metadata(&path) {
            Ok(metadata) => check_lock_file(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(storage(error)),
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(storage)?;
        check_lock_file(&file.metadata().map_err(storage)?)?;
        // Recheck the path after opening. This is cooperative app ownership,
        // not a guarantee against malicious same-user filesystem replacement.
        check_lock_file(&fs::symlink_metadata(&path).map_err(storage)?)?;
        if path.canonicalize().map_err(storage)? != path {
            return Err(OperationError::TargetResolution(
                "project ownership path changed or traverses a symbolic link".into(),
            ));
        }
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(OperationError::ProjectBusy(
                    root.to_string_lossy().into_owned(),
                ));
            }
            Err(error) => return Err(storage(error)),
        }
        Ok(Self {
            root,
            path,
            _file: file,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ProjectLease {
    fn drop(&mut self) {
        // The last scientific owner is gone. A duplicated descriptor (including
        // one briefly inherited by a concurrently starting child) must not extend
        // ownership until its close. Accepted tasks retain this lease through Arc.
        if let Err(error) = self._file.unlock() {
            eprintln!(
                "project ownership unlock failed for {}: {error}",
                self.root.display()
            );
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn last_owner_releases_the_lock_despite_a_duplicated_descriptor() {
        let temporary = tempfile::tempdir().unwrap();
        let lease = Arc::new(ProjectLease::acquire(temporary.path()).unwrap());
        let accepted_work = lease.clone();
        let inherited = lease._file.try_clone().unwrap();
        drop(lease);
        assert!(matches!(
            ProjectLease::acquire(temporary.path()),
            Err(OperationError::ProjectBusy(_))
        ));
        drop(accepted_work);
        let replacement = ProjectLease::acquire(temporary.path()).unwrap();
        drop(inherited);
        assert!(matches!(
            ProjectLease::acquire(temporary.path()),
            Err(OperationError::ProjectBusy(_))
        ));
        drop(replacement);
        assert!(ProjectLease::acquire(temporary.path()).is_ok());
    }
}

fn check_lock_file(metadata: &fs::Metadata) -> Result<(), OperationError> {
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 0 {
        return Err(OperationError::TargetResolution(
            ".rho/next-host.lock must be an empty regular file; existing data was not changed"
                .into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(OperationError::TargetResolution(
                "project lock must not be a hard link".into(),
            ));
        }
    }
    Ok(())
}

fn storage(error: impl std::fmt::Display) -> OperationError {
    OperationError::Storage(format!("project ownership: {error}"))
}
