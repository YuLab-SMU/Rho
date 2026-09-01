//! Asynchronous single-connection execution for durable Store repositories.
//!
//! [`StoreExecutor`] initializes through [`Store::open`](crate::Store::open)
//! and then transfers that exact configured connection to one
//! `tokio-rusqlite` worker. Repository calls are serialized on the worker and
//! never execute SQLite work on a Tokio request thread.

use std::fmt;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{MigrationOutcome, Store, StoreError};

#[derive(Debug, Error)]
pub enum StoreExecutorError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("Store initialization task failed: {0}")]
    Initialization(String),
    #[error("Store worker failed: {0}")]
    Worker(String),
}

impl StoreExecutorError {
    pub fn migration_outcome(&self) -> Option<&MigrationOutcome> {
        match self {
            Self::Store(error) => error.migration_outcome(),
            Self::Initialization(_) | Self::Worker(_) => None,
        }
    }
}

/// Failure from an application service executed on the Store worker.
///
/// Domain errors remain typed instead of being flattened into a worker error;
/// transport failures are kept separate so callers can preserve truthful
/// failure and recovery behavior.
#[derive(Debug)]
pub enum StoreExecutorOperationError<E> {
    Operation(E),
    Worker(String),
}

impl<E: fmt::Display> fmt::Display for StoreExecutorOperationError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Operation(error) => error.fmt(formatter),
            Self::Worker(message) => write!(formatter, "Store worker failed: {message}"),
        }
    }
}

impl<E> std::error::Error for StoreExecutorOperationError<E>
where
    E: std::error::Error + 'static,
{
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Operation(error) => Some(error),
            Self::Worker(_) => None,
        }
    }
}

/// Cloneable asynchronous handle to one serialized SQLite connection worker.
#[derive(Clone, Debug)]
pub struct StoreExecutor {
    connection: tokio_rusqlite::Connection,
    migration_outcome: MigrationOutcome,
    agent_turn_events: tokio::sync::broadcast::Sender<crate::AgentTurnEventFrame>,
}

impl StoreExecutor {
    /// Open and migrate a Store without blocking the calling Tokio worker,
    /// then move the configured connection onto its dedicated worker thread.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StoreExecutorError> {
        let path = PathBuf::from(path.as_ref());
        let store = tokio::task::spawn_blocking(move || Store::open(path))
            .await
            .map_err(|error| StoreExecutorError::Initialization(error.to_string()))??;
        let Store {
            connection,
            migration_outcome,
        } = store;
        let (agent_turn_events, _) = tokio::sync::broadcast::channel(256);
        Ok(Self {
            connection: (*connection).into(),
            migration_outcome,
            agent_turn_events,
        })
    }

    pub fn migration_outcome(&self) -> &MigrationOutcome {
        &self.migration_outcome
    }

    /// Live notification channel for durable Agent turn mutations. Lagging
    /// subscribers must refetch canonical state from the repository.
    pub fn agent_turn_events(&self) -> tokio::sync::broadcast::Sender<crate::AgentTurnEventFrame> {
        self.agent_turn_events.clone()
    }

    /// Publish a previously committed Agent turn event as a live projection.
    ///
    /// This is intentionally best-effort: callers invoke it only after their
    /// transaction/service write succeeds, and a projection lookup or channel
    /// failure must never reverse that authoritative success.
    pub async fn publish_agent_turn_event(&self, event_id: i64) {
        let projection = self
            .call(move |connection| {
                let store = Store::borrowed(connection);
                let Some(event) = store.get_agent_turn_event(event_id)? else {
                    return Ok(None);
                };
                let Some(project_root) = store.agent_turn_project_root(&event.turn_id)? else {
                    return Ok(None);
                };
                Ok(Some((project_root, event)))
            })
            .await;
        if let Ok(Some((project_root, event))) = projection {
            let _ = self
                .agent_turn_events
                .send(crate::AgentTurnEventFrame::from_event(project_root, event));
        }
    }

    pub(crate) async fn call<R, F>(&self, operation: F) -> Result<R, StoreExecutorError>
    where
        R: Send + 'static,
        F: FnOnce(&mut rusqlite::Connection) -> Result<R, StoreError> + Send + 'static,
    {
        self.connection
            .call(operation)
            .await
            .map_err(|error| match error {
                tokio_rusqlite::Error::Error(error) => StoreExecutorError::Store(error),
                other => StoreExecutorError::Worker(other.to_string()),
            })
    }

    /// Run one application service against the worker's existing configured
    /// Store connection. The borrowed Store cannot escape because results must
    /// be `'static`; all SQLite work remains serialized on the same worker.
    pub async fn run_service<R, E, F>(
        &self,
        operation: F,
    ) -> Result<R, StoreExecutorOperationError<E>>
    where
        R: Send + 'static,
        E: Send + 'static,
        F: FnOnce(&mut Store<&mut rusqlite::Connection>) -> Result<R, E> + Send + 'static,
    {
        self.connection
            .call(move |connection| {
                let mut store = Store::borrowed(connection);
                operation(&mut store)
            })
            .await
            .map_err(|error| match error {
                tokio_rusqlite::Error::Error(error) => {
                    StoreExecutorOperationError::Operation(error)
                }
                tokio_rusqlite::Error::ConnectionClosed => {
                    StoreExecutorOperationError::Worker("connection closed".to_string())
                }
                tokio_rusqlite::Error::Close((_, error)) => {
                    StoreExecutorOperationError::Worker(error.to_string())
                }
                _ => StoreExecutorOperationError::Worker(
                    "unknown Store worker transport failure".to_string(),
                ),
            })
    }

    #[cfg(test)]
    async fn test_call<R, F>(&self, operation: F) -> Result<R, StoreExecutorError>
    where
        R: Send + 'static,
        F: FnOnce(&mut rusqlite::Connection) -> Result<R, StoreError> + Send + 'static,
    {
        self.call(operation).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;
    use crate::MigrationStatus;

    #[derive(Debug, Error)]
    enum TestServiceError {
        #[error("injected service rejection")]
        Injected,
        #[error(transparent)]
        Store(#[from] StoreError),
    }

    #[tokio::test]
    async fn executor_preserves_fresh_open_contract_and_reopens() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let executor = StoreExecutor::open(&database).await.unwrap();
        assert_eq!(
            executor.migration_outcome().status,
            MigrationStatus::BootstrappedCurrent
        );
        executor
            .test_call(|connection| {
                connection.execute(
                    "INSERT INTO events(event_id, timestamp, kind, payload) VALUES('event:1', '2026-08-31T00:00:00Z', 'test', '{}')",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        drop(executor);

        let reopened = StoreExecutor::open(&database).await.unwrap();
        assert_eq!(
            reopened.migration_outcome().status,
            MigrationStatus::OpenedCurrent
        );
        let count = reopened
            .test_call(|connection| {
                connection
                    .query_row("SELECT COUNT(*) FROM events", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .map_err(StoreError::from)
            })
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn executor_serializes_one_worker_without_blocking_tokio_progress() {
        let directory = TempDir::new().unwrap();
        let executor = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));

        let spawn_slow_call = |executor: StoreExecutor| {
            let active = active.clone();
            let maximum = maximum.clone();
            tokio::spawn(async move {
                executor
                    .test_call(move |_connection| {
                        let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(running, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(format!("{:?}", std::thread::current().id()))
                    })
                    .await
                    .unwrap()
            })
        };
        let first = spawn_slow_call(executor.clone());
        let second = spawn_slow_call(executor.clone());

        tokio::time::timeout(Duration::from_millis(50), async {
            tokio::time::sleep(Duration::from_millis(10)).await;
        })
        .await
        .expect("a slow SQLite call blocked Tokio progress");

        let first_thread = first.await.unwrap();
        let second_thread = second.await.unwrap();
        assert_eq!(first_thread, second_thread);
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn executor_survives_call_failure_and_cancelled_waiter() {
        let directory = TempDir::new().unwrap();
        let executor = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap();
        let error = executor
            .test_call(|connection| {
                connection.query_row("SELECT value FROM missing_table", [], |row| {
                    row.get::<_, String>(0)
                })?;
                Ok(())
            })
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            StoreExecutorError::Store(StoreError::Sqlite(_))
        ));

        let cancelled_executor = executor.clone();
        let waiter = tokio::spawn(async move {
            cancelled_executor
                .test_call(|_connection| {
                    std::thread::sleep(Duration::from_millis(50));
                    Ok(())
                })
                .await
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        waiter.abort();

        let value = executor
            .test_call(|connection| {
                connection
                    .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                    .map_err(StoreError::from)
            })
            .await
            .unwrap();
        assert_eq!(value, 1);
    }

    #[tokio::test]
    async fn executor_service_preserves_operation_errors_and_recovers_on_same_store() {
        let directory = TempDir::new().unwrap();
        let executor = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap();

        let error = executor
            .run_service(|_store| Err::<(), _>(TestServiceError::Injected))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            StoreExecutorOperationError::Operation(TestServiceError::Injected)
        ));

        let project_root = executor
            .run_service(|store| -> Result<_, TestServiceError> {
                store.set_project_root(Some("D:\\projects\\A\\"))?;
                Ok(store.active_project_root()?.unwrap())
            })
            .await
            .unwrap();
        assert_eq!(project_root, "D:/projects/A");
    }

    #[tokio::test]
    async fn executor_reports_reset_required_without_rewriting_schema() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO metadata(key, value) VALUES('schema_version', '6');",
            )
            .unwrap();
        drop(connection);

        let error = StoreExecutor::open(&database).await.unwrap_err();
        let outcome = error.migration_outcome().unwrap();
        assert_eq!(outcome.status, MigrationStatus::Rejected);
        assert_eq!(outcome.from_schema_version, Some(6));
        assert_eq!(
            outcome.reason_code.as_deref(),
            Some("store_schema_reset_required")
        );

        let verification = rusqlite::Connection::open(&database).unwrap();
        let schema_version: String = verification
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema_version, "6");
    }
}
