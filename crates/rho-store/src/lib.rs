use std::path::Path;

use chrono::Utc;
use rho_protocol::{Envelope, WorkspaceIdentity};
use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported schema version: {0}")]
    SchemaVersion(i64),
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> Result<(), StoreError> {
        self.connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                timestamp TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                terminal_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS workspace_identity (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                payload TEXT NOT NULL
            );
            ",
        )?;

        let current: Option<i64> = self
            .connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse().ok());

        match current {
            None => {
                self.connection.execute(
                    "INSERT INTO metadata(key, value) VALUES('schema_version', ?1)",
                    [SCHEMA_VERSION.to_string()],
                )?;
            }
            Some(SCHEMA_VERSION) => {}
            Some(other) => return Err(StoreError::SchemaVersion(other)),
        }
        Ok(())
    }

    pub fn append_event(&mut self, event: &Envelope) -> Result<i64, StoreError> {
        let payload = serde_json::to_string(&event.payload)?;
        let kind = serde_json::to_string(&event.kind)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO events(event_id, timestamp, kind, payload) VALUES(?1, ?2, ?3, ?4)",
            params![event.id, event.timestamp, kind, payload],
        )?;
        let seq = transaction.last_insert_rowid();
        transaction.commit()?;
        Ok(seq)
    }

    pub fn save_identity(&mut self, identity: &WorkspaceIdentity) -> Result<(), StoreError> {
        let payload = serde_json::to_string(identity)?;
        self.connection.execute(
            "INSERT INTO workspace_identity(singleton, payload) VALUES(1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload",
            [payload],
        )?;
        Ok(())
    }

    pub fn load_identity(&self) -> Result<Option<WorkspaceIdentity>, StoreError> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM workspace_identity WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn event_count(&self) -> Result<u64, StoreError> {
        self.connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .map_err(StoreError::from)
    }

    pub fn begin_run(&mut self, run_id: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO runs(run_id, status, started_at) VALUES(?1, 'running', ?2)",
            params![run_id, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn finish_run(&mut self, run_id: &str, status: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE runs SET status = ?2, finished_at = ?3 WHERE run_id = ?1",
            params![run_id, status, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn recover_incomplete_runs(&mut self) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE runs
             SET status = 'interrupted', finished_at = ?1,
                 terminal_reason = 'broker_restart'
             WHERE status = 'running'",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_protocol::{MessageKind, WorkspaceIdentity};
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn persists_identity_and_events() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let identity = WorkspaceIdentity::new("ws_test");
        store.save_identity(&identity).unwrap();
        assert_eq!(store.load_identity().unwrap(), Some(identity));

        let event = Envelope::new(MessageKind::Event, json!({"kind": "test"}));
        assert_eq!(store.append_event(&event).unwrap(), 1);
        assert_eq!(store.event_count().unwrap(), 1);
    }

    #[test]
    fn recovers_running_runs() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        store.begin_run("run_1").unwrap();
        assert_eq!(store.recover_incomplete_runs().unwrap(), 1);
        assert_eq!(store.recover_incomplete_runs().unwrap(), 0);
    }
}
