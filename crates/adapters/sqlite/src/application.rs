use rho_contract::ApplicationState;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{path::Path, sync::Mutex, time::Duration};

/// Local application state, never part of the scientific journal or outbox.
pub struct ApplicationStore(Mutex<Connection>);

impl ApplicationStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        let connection = Connection::open(path).map_err(err)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(err)?;
        connection
            .execute_batch(
                "PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS application_state (
                scope TEXT NOT NULL, key TEXT NOT NULL, version TEXT NOT NULL,
                value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(scope,key));",
            )
            .map_err(err)?;
        Ok(Self(Mutex::new(connection)))
    }

    pub fn read(&self, scope: &str, key: &str) -> Result<ApplicationState, String> {
        validate(scope, key)?;
        let connection = self.0.lock().map_err(err)?;
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT version,value FROM application_state WHERE scope=?1 AND key=?2",
                params![scope, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        match row {
            Some((version, value)) => Ok(ApplicationState {
                key: key.into(),
                version: Some(version),
                value: serde_json::from_str(&value).map_err(err)?,
            }),
            None => Ok(ApplicationState {
                key: key.into(),
                version: None,
                value: serde_json::Value::Null,
            }),
        }
    }

    pub fn write(&self, scope: &str, state: &ApplicationState) -> Result<ApplicationState, String> {
        validate(scope, &state.key)?;
        let value = serde_json::to_string(&state.value).map_err(err)?;
        if value.len() > 2 * 1024 * 1024 {
            return Err("application state exceeds 2 MiB; draft was not saved".into());
        }
        let mut connection = self.0.lock().map_err(err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT version FROM application_state WHERE scope=?1 AND key=?2",
                params![scope, state.key],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if previous != state.version {
            return Err(
                "application state changed in another window; local draft was not overwritten"
                    .into(),
            );
        }
        let version = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO application_state(scope,key,version,value) VALUES(?1,?2,?3,?4)
            ON CONFLICT(scope,key) DO UPDATE SET version=excluded.version,value=excluded.value",
            params![scope, state.key, version, value],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(ApplicationState {
            key: state.key.clone(),
            version: Some(version),
            value: state.value.clone(),
        })
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn validate(scope: &str, key: &str) -> Result<(), String> {
    if scope.len() > 4096
        || key.is_empty()
        || key.len() > 160
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("invalid application state key or scope".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_survive_reopen_and_stale_windows_cannot_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("studio.sqlite");
        let store = ApplicationStore::open(&path).unwrap();
        let initial = store.read("/project", "studio").unwrap();
        let first = store
            .write(
                "/project",
                &ApplicationState {
                    value: serde_json::json!({"text":"中文草稿"}),
                    ..initial.clone()
                },
            )
            .unwrap();
        assert!(store.write("/project", &initial).is_err());
        drop(store);
        let store = ApplicationStore::open(&path).unwrap();
        assert_eq!(store.read("/project", "studio").unwrap().value, first.value);
        assert!(store.read("/other", "studio").unwrap().version.is_none());
    }
}
