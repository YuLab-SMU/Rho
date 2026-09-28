#![forbid(unsafe_code)]
//! Agent-owned metadata. The containing plugin supplies its explicit storage path.
//! No scientific journal connection, legacy lookup, runtime startup or replay.
use rusqlite::{Connection, OptionalExtension};
use std::{path::Path, sync::Mutex, time::Duration};
mod credentials;
pub use credentials::CredentialFile;
mod agent_assets;
mod agent_handoffs;
mod agent_tasks;
mod component_agents;
mod native_tools;
mod project_agent_tasks;

pub struct AgentStore(pub(crate) Mutex<Connection>);
impl AgentStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        // Refuse an unrelated database before making any schema changes. The
        // new namespace has no reader for the old Application metadata store.
        let has_tables: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*')", [], |r| r.get(0)
        ).map_err(|e| e.to_string())?;
        let has_identity: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_store_identity')", [], |r| r.get(0)
        ).map_err(|e| e.to_string())?;
        if has_tables && !has_identity {
            return Err("The selected database is not an Agent-owned store".into());
        }
        if has_identity {
            let format: Option<String> = connection
                .query_row(
                    "SELECT value FROM agent_store_identity WHERE key='format'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if format.as_deref() != Some("rho.agent-store.v1") {
                return Err("The Agent store format is unsupported".into());
            }
        } else {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|e| e.to_string())?;
            transaction
                .execute_batch(
                    "CREATE TABLE agent_store_identity(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                INSERT INTO agent_store_identity VALUES('format','rho.agent-store.v1');",
                )
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
        }
        connection
            .execute_batch("PRAGMA synchronous = FULL;")
            .map_err(|e| e.to_string())?;
        agent_tasks::initialize(&connection)?;
        native_tools::initialize(&connection)?;
        component_agents::initialize(&connection)?;
        agent_handoffs::initialize(&connection)?;
        Ok(Self(Mutex::new(connection)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_store_is_reopenable_and_has_only_agent_owned_tables() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent.sqlite");
        drop(AgentStore::open(&path).unwrap());
        let store = AgentStore::open(&path).unwrap();
        let connection = store.0.lock().unwrap();
        let mut query = connection
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let names: Vec<String> = query
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(names.contains(&"agent_tasks".into()));
        assert!(names.contains(&"component_agent_conversations".into()));
        assert!(names.contains(&"agent_handoff_receipts".into()));
        assert!(names.iter().all(|n| n.starts_with("agent_")
            || n.starts_with("component_")
            || n.starts_with("sqlite_")));
    }

    #[test]
    fn unrelated_and_unsupported_stores_are_refused_without_schema_or_data_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("application.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE application_state(value TEXT); INSERT INTO application_state VALUES('preserved');").unwrap();
        assert!(AgentStore::open(&path).is_err());
        let value: String = connection
            .query_row("SELECT value FROM application_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "preserved");
        let count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let path = directory.path().join("newer.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE agent_store_identity(key TEXT,value TEXT); INSERT INTO agent_store_identity VALUES('format','future-format');").unwrap();
        assert!(AgentStore::open(&path).is_err());
        let count: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
