//! Agent-owned credential file. Task metadata contains immutable references only.
//! The containing owner supplies the location; keys never enter package revisions.
use fs4::FileExt;
use rho_agent_api::ComponentCredentialRef;
use rho_agent_owner::{AgentTaskError, AgentTaskScope, ComponentModelKey};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub struct CredentialFile {
    path: PathBuf,
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

fn storage(_: impl std::fmt::Display) -> AgentTaskError {
    // Do not include JSON parse fragments, credential bytes, or platform paths in diagnostics.
    AgentTaskError::Storage("The local model credential file could not be accessed".into())
}
fn unavailable() -> AgentTaskError {
    AgentTaskError::InvalidInput(
        "The saved model API key is unavailable; enter a key in Rho settings".into(),
    )
}
impl CredentialFile {
    /// The containing instance supplies its credential path. No default location,
    /// project discovery, key import or credential lookup happens at construction.
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }
    fn path(&self) -> Result<&Path, AgentTaskError> {
        if !self.path.is_absolute() {
            return Err(AgentTaskError::InvalidInput(
                "The Agent credential path must be absolute".into(),
            ));
        }
        Ok(&self.path)
    }
    fn open_lock(&self, create: bool) -> Result<Option<File>, AgentTaskError> {
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
    fn read(&self) -> Result<StoredCredentials, AgentTaskError> {
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
    fn write(&self, stored: &StoredCredentials) -> Result<(), AgentTaskError> {
        if serde_json::to_vec(stored).map_err(storage)?.len() > 4 * 1024 * 1024 {
            return Err(AgentTaskError::Budget(
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
    pub fn put(
        &self,
        scope: &AgentTaskScope,
        value: String,
    ) -> Result<ComponentCredentialRef, AgentTaskError> {
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
    pub fn key(
        &self,
        scope: &AgentTaskScope,
        key_id: &str,
    ) -> Result<ComponentModelKey, AgentTaskError> {
        let Some(_lock) = self.open_lock(false)? else {
            return Err(unavailable());
        };
        let stored = self.read()?;
        let entry = stored
            .entries
            .get(key_id)
            .filter(|entry| entry.project == scope.project && entry.principal == scope.principal)
            .ok_or_else(unavailable)?;
        ComponentModelKey::new(entry.key.clone()).map_err(Into::into)
    }
    pub fn remove(&self, scope: &AgentTaskScope, key_id: &str) -> Result<(), AgentTaskError> {
        let Some(_lock) = self.open_lock(false)? else {
            return Ok(());
        };
        let mut stored = self.read()?;
        if let Some(entry) = stored.entries.get(key_id) {
            if entry.project != scope.project || entry.principal != scope.principal {
                return Err(AgentTaskError::NotFound);
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
    fn scope(principal: &str) -> AgentTaskScope {
        AgentTaskScope {
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
        let alice = AgentTaskScope {
            project: "/study".into(),
            principal: "alice".into(),
        };
        let bob = AgentTaskScope {
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
        let independent = CredentialFile::at(directory.path().join("credentials.json"));
        assert_eq!(independent.key(&alice, &old).unwrap().expose(), "old-key");
        assert_eq!(
            independent.key(&alice, &abandoned).unwrap().expose(),
            "abandoned-key"
        );
        assert_eq!(file.key(&alice, &current).unwrap().expose(), "current-key");
        assert_eq!(file.key(&bob, &other).unwrap().expose(), "other-key");
        independent.remove(&alice, &current).unwrap();
        assert!(file.key(&alice, &current).is_err());
        assert_eq!(file.key(&alice, &old).unwrap().expose(), "old-key");
        assert_eq!(
            file.key(&alice, &abandoned).unwrap().expose(),
            "abandoned-key"
        );
        assert_eq!(file.key(&bob, &other).unwrap().expose(), "other-key");
        assert_eq!(frozen.expose(), "old-key");
    }
}

#[cfg(test)]
mod location_tests {
    use super::*;
    #[test]
    fn absent_reads_and_removals_do_not_create_a_credential_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("absent");
        let file = CredentialFile::at(root.join("keys.json"));
        let scope = AgentTaskScope {
            project: "/study".into(),
            principal: "alice".into(),
        };
        assert!(file.key(&scope, "missing").is_err());
        file.remove(&scope, "missing").unwrap();
        assert!(!root.exists());
    }
    #[test]
    fn explicit_locations_and_project_scopes_cannot_be_substituted() {
        let directory = tempfile::tempdir().unwrap();
        let file = CredentialFile::at(directory.path().join("keys.json"));
        let alice = AgentTaskScope {
            project: "/study".into(),
            principal: "alice".into(),
        };
        let ComponentCredentialRef::LocalFile { key_id } =
            file.put(&alice, "saved-key".into()).unwrap()
        else {
            panic!()
        };
        let other = AgentTaskScope {
            project: "/other".into(),
            principal: "alice".into(),
        };
        assert!(file.key(&other, &key_id).is_err());
        assert!(file.remove(&other, &key_id).is_err());
        assert_eq!(file.key(&alice, &key_id).unwrap().expose(), "saved-key");
        let relative = CredentialFile::at(PathBuf::from("relative/keys.json"));
        assert!(relative.key(&alice, &key_id).is_err());
        assert!(relative.put(&alice, "new-key".into()).is_err());
        assert!(relative.remove(&alice, &key_id).is_err());
    }
}
