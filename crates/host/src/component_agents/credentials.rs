//! User-local model credentials. The application database holds immutable references only.
use fs4::FileExt;
use rho_application::{ApplicationError, ApplicationScope, ComponentModelKey};
use rho_contract::ComponentCredentialRef;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) struct CredentialFile {
    path: Option<PathBuf>,
}
#[derive(Default, Serialize, Deserialize)]
struct StoredCredentials {
    version: u32,
    entries: BTreeMap<String, StoredKey>,
}
#[derive(Serialize, Deserialize)]
struct StoredKey {
    project: String,
    principal: String,
    key: String,
}

fn storage(_: impl std::fmt::Display) -> ApplicationError {
    // Do not include JSON parse fragments, credential bytes, or platform paths in diagnostics.
    ApplicationError::Storage("The local model credential file could not be accessed".into())
}
fn unavailable() -> ApplicationError {
    ApplicationError::InvalidInput(
        "The saved model API key is unavailable; enter a key in Rho settings".into(),
    )
}
impl CredentialFile {
    pub(super) fn user_config() -> Self {
        let base = if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA").map(PathBuf::from)
        } else if cfg!(target_os = "macos") {
            std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Application Support"))
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        };
        Self {
            path: base
                .filter(|p| p.is_absolute())
                .map(|p| p.join("rho/model-credentials.json")),
        }
    }
    #[cfg(test)]
    pub(super) fn at(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }
    fn path(&self) -> Result<&Path, ApplicationError> {
        self.path.as_deref().ok_or_else(|| {
            ApplicationError::InvalidInput("The user configuration directory is unavailable".into())
        })
    }
    fn open_lock(&self, create: bool) -> Result<Option<File>, ApplicationError> {
        let path = self.path()?;
        let directory = path.parent().ok_or_else(unavailable)?;
        if !create {
            match fs::metadata(path) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(storage(error)),
            }
        }
        fs::create_dir_all(directory).map_err(storage)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(path.with_extension("lock")).map_err(storage)?;
        FileExt::lock(&lock).map_err(storage)?;
        Ok(Some(lock))
    }
    fn read(&self) -> Result<StoredCredentials, ApplicationError> {
        let file = match File::open(self.path()?) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoredCredentials {
                    version: 1,
                    entries: BTreeMap::new(),
                });
            }
            Err(error) => return Err(storage(error)),
        };
        let mut bytes = Vec::new();
        file.take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(storage)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(storage("credential file exceeds limit"));
        }
        let stored: StoredCredentials = serde_json::from_slice(&bytes).map_err(storage)?;
        if stored.version != 1 {
            return Err(storage("unsupported credential version"));
        }
        Ok(stored)
    }
    fn write(&self, stored: &StoredCredentials) -> Result<(), ApplicationError> {
        if serde_json::to_vec(stored).map_err(storage)?.len() > 4 * 1024 * 1024 {
            return Err(ApplicationError::Budget(
                "The local model credential configuration exceeds 4 MiB".into(),
            ));
        }
        let path = self.path()?;
        let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp).map_err(storage)?;
            serde_json::to_writer_pretty(&mut file, stored).map_err(storage)?;
            file.write_all(b"\n").map_err(storage)?;
            file.sync_all().map_err(storage)?;
            drop(file);
            fs::rename(&temp, path).map_err(storage)?;
            #[cfg(unix)]
            File::open(path.parent().ok_or_else(unavailable)?)
                .and_then(|f| f.sync_all())
                .map_err(storage)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    pub(super) fn put(
        &self,
        scope: &ApplicationScope,
        value: String,
    ) -> Result<ComponentCredentialRef, ApplicationError> {
        let key = ComponentModelKey::new(value)?;
        let _lock = self.open_lock(true)?;
        let mut stored = self.read()?;
        let key_id = uuid::Uuid::new_v4().to_string();
        stored.entries.insert(
            key_id.clone(),
            StoredKey {
                project: scope.project.clone(),
                principal: scope.principal.clone(),
                key: key.expose().into(),
            },
        );
        self.write(&stored)?;
        Ok(ComponentCredentialRef::LocalFile { key_id })
    }
    pub(super) fn key(
        &self,
        scope: &ApplicationScope,
        key_id: &str,
    ) -> Result<ComponentModelKey, ApplicationError> {
        let _lock = self.open_lock(false)?;
        let stored = self.read()?;
        let entry = stored
            .entries
            .get(key_id)
            .filter(|entry| entry.project == scope.project && entry.principal == scope.principal)
            .ok_or_else(unavailable)?;
        ComponentModelKey::new(entry.key.clone())
    }
    pub(super) fn remove(
        &self,
        scope: &ApplicationScope,
        key_id: &str,
    ) -> Result<(), ApplicationError> {
        let Some(_lock) = self.open_lock(false)? else {
            return Ok(());
        };
        let mut stored = self.read()?;
        if let Some(entry) = stored.entries.get(key_id) {
            if entry.project != scope.project || entry.principal != scope.principal {
                return Err(ApplicationError::NotFound);
            }
            stored.entries.remove(key_id);
            self.write(&stored)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(principal: &str) -> ApplicationScope {
        ApplicationScope {
            project: "/study".into(),
            principal: principal.into(),
        }
    }
    #[test]
    fn persisted_keys_survive_reopen_and_replacement_preserves_accepted_reference() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rho/model-credentials.json");
        let file = CredentialFile::at(path.clone());
        let ComponentCredentialRef::LocalFile { key_id: original } =
            file.put(&scope("alice"), "first-key".into()).unwrap()
        else {
            panic!()
        };
        let reopened = CredentialFile::at(path.clone());
        let ComponentCredentialRef::LocalFile {
            key_id: replacement,
        } = reopened.put(&scope("alice"), "second-key".into()).unwrap()
        else {
            panic!()
        };
        assert_ne!(original, replacement);
        assert_eq!(
            reopened.key(&scope("alice"), &original).unwrap().expose(),
            "first-key"
        );
        assert_eq!(
            reopened
                .key(&scope("alice"), &replacement)
                .unwrap()
                .expose(),
            "second-key"
        );
        assert!(reopened.key(&scope("bob"), &replacement).is_err());
        assert!(reopened.remove(&scope("bob"), &replacement).is_err());
        reopened.remove(&scope("alice"), &replacement).unwrap();
        assert!(reopened.key(&scope("alice"), &replacement).is_err());
        assert_eq!(
            reopened.key(&scope("alice"), &original).unwrap().expose(),
            "first-key"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn failed_replace_and_corrupt_configuration_do_not_erase_prior_file_or_echo_secrets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("model-credentials.json");
        let file = CredentialFile::at(path.clone());
        file.put(&scope("alice"), "original-key".into()).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(file.put(&scope("alice"), "invalid key".into()).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, b"secret-corrupt-document").unwrap();
        let error = file.put(&scope("alice"), "new-key".into()).unwrap_err();
        assert!(!error.to_string().contains("secret-corrupt-document"));
        assert_eq!(fs::read(path).unwrap(), b"secret-corrupt-document");
    }
    #[test]
    fn two_connections_serialize_updates_without_losing_a_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("model-credentials.json");
        let workers: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    CredentialFile::at(path)
                        .put(&scope("alice"), format!("key-{i}"))
                        .unwrap()
                })
            })
            .collect();
        let refs: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let stored = CredentialFile::at(path);
        for reference in refs {
            let ComponentCredentialRef::LocalFile { key_id } = reference else {
                panic!()
            };
            assert!(stored.key(&scope("alice"), &key_id).is_ok());
        }
    }
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    #[test]
    fn independent_file_handles_remove_only_the_named_credential_version() {
        let directory = tempfile::tempdir().unwrap();
        let file = CredentialFile::at(directory.path().join("credentials.json"));
        let alice = ApplicationScope {
            project: "/study".into(),
            principal: "alice".into(),
        };
        let bob = ApplicationScope {
            project: "/study".into(),
            principal: "bob".into(),
        };
        let ComponentCredentialRef::LocalFile { key_id: old } =
            file.put(&alice, "old-key".into()).unwrap()
        else {
            panic!()
        };
        let frozen = file.key(&alice, &old).unwrap();
        let ComponentCredentialRef::LocalFile { key_id: abandoned } =
            file.put(&alice, "abandoned-key".into()).unwrap()
        else {
            panic!()
        };
        let ComponentCredentialRef::LocalFile { key_id: other } =
            file.put(&bob, "other-key".into()).unwrap()
        else {
            panic!()
        };
        let ComponentCredentialRef::LocalFile { key_id: current } =
            file.put(&alice, "current-key".into()).unwrap()
        else {
            panic!()
        };
        let independent=CredentialFile::at(directory.path().join("credentials.json"));
        assert_eq!(independent.key(&alice, &old).unwrap().expose(), "old-key");
        assert_eq!(independent.key(&alice, &abandoned).unwrap().expose(), "abandoned-key");
        assert_eq!(file.key(&alice, &current).unwrap().expose(), "current-key");
        assert_eq!(file.key(&bob, &other).unwrap().expose(), "other-key");
        independent.remove(&alice,&current).unwrap();
        assert!(file.key(&alice,&current).is_err());
        assert_eq!(file.key(&alice,&old).unwrap().expose(),"old-key");
        assert_eq!(file.key(&alice,&abandoned).unwrap().expose(),"abandoned-key");
        assert_eq!(file.key(&bob,&other).unwrap().expose(),"other-key");
        assert_eq!(frozen.expose(), "old-key");
    }
}
