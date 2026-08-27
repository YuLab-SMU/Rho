//! Asynchronous single-connection execution for durable Store repositories.
//!
//! [`StoreExecutor`] initializes through [`Store::open`](crate::Store::open)
//! and then transfers that exact configured connection to one
//! `tokio-rusqlite` worker. Repository calls are serialized on the worker and
//! never execute SQLite work on a Tokio request thread.

use std::fmt;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{
    EvidenceClaim, EvidenceClaimDraft, EvidenceClaimReview, EvidenceEntry, EvidenceEntryDraft,
    MigrationOutcome, Store, StoreError, query::required_project_root,
};

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

    /// Live projection channel for Agent turn mutations. Producers send after
    /// the durable write succeeds; subscribers must tolerate lag and refetch
    /// canonical state via the detail queries when they fall behind.
    pub fn agent_turn_events(&self) -> tokio::sync::broadcast::Sender<crate::AgentTurnEventFrame> {
        self.agent_turn_events.clone()
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

    pub async fn create_evidence_entry(
        &self,
        mut draft: EvidenceEntryDraft,
    ) -> Result<EvidenceEntry, StoreExecutorError> {
        draft.project_root = required_project_root(&draft.project_root)?;
        self.call(move |connection| Store::borrowed(connection).create_evidence_entry(&draft))
            .await
    }

    pub async fn list_evidence_entries(
        &self,
        project_root: String,
        limit: Option<usize>,
        search: Option<String>,
    ) -> Result<Vec<EvidenceEntry>, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).list_evidence_entries(
                &project_root,
                limit,
                search.as_deref(),
            )
        })
        .await
    }

    pub async fn get_evidence_entry(
        &self,
        project_root: String,
        id: i64,
    ) -> Result<Option<EvidenceEntry>, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).get_evidence_entry(&project_root, id)
        })
        .await
    }

    pub async fn delete_evidence_entry(
        &self,
        project_root: String,
        id: i64,
    ) -> Result<bool, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.call(move |connection| {
            Store::borrowed(connection).delete_evidence_entry(&project_root, id)
        })
        .await
    }

    pub async fn set_evidence_citation(
        &self,
        project_root: String,
        id: i64,
        citation_json: String,
    ) -> Result<bool, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).set_evidence_citation(&project_root, id, &citation_json)
        })
        .await
    }

    pub async fn create_evidence_claim(
        &self,
        draft: EvidenceClaimDraft,
    ) -> Result<EvidenceClaim, StoreExecutorError> {
        self.call(move |connection| Store::borrowed(connection).create_evidence_claim(&draft))
            .await
    }

    pub async fn list_evidence_claims(
        &self,
        project_root: String,
        limit: Option<usize>,
    ) -> Result<Vec<EvidenceClaim>, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).list_evidence_claims(&project_root, limit)
        })
        .await
    }

    pub async fn get_evidence_claim(
        &self,
        project_root: String,
        claim_id: String,
    ) -> Result<Option<EvidenceClaim>, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).get_evidence_claim(&project_root, &claim_id)
        })
        .await
    }

    pub async fn review_evidence_claim(
        &self,
        project_root: String,
        claim_id: String,
        source_anchor_resolved: Option<bool>,
    ) -> Result<EvidenceClaimReview, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).review_evidence_claim(
                &project_root,
                &claim_id,
                source_anchor_resolved,
            )
        })
        .await
    }

    pub async fn delete_evidence_claim(
        &self,
        project_root: String,
        claim_id: String,
    ) -> Result<bool, StoreExecutorError> {
        self.call(move |connection| {
            Store::borrowed(connection).delete_evidence_claim(&project_root, &claim_id)
        })
        .await
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
    use crate::{ClaimReviewStatus, MigrationStatus};

    #[derive(Debug, Error)]
    enum TestServiceError {
        #[error("injected service rejection")]
        Injected,
        #[error(transparent)]
        Store(#[from] StoreError),
    }

    fn entry_draft(project_root: &str, title: &str) -> EvidenceEntryDraft {
        EvidenceEntryDraft {
            project_root: project_root.to_string(),
            title: title.to_string(),
            notes: "Inspectable notes".to_string(),
            doi: None,
            run_id: None,
            artifact_id: None,
        }
    }

    fn source_claim(project_root: &str, evidence_ids: Vec<i64>) -> EvidenceClaimDraft {
        EvidenceClaimDraft {
            project_root: project_root.to_string(),
            kind: "result".to_string(),
            summary: "A bounded scientific statement".to_string(),
            anchor_kind: "source_range".to_string(),
            source_path: Some("reports/result.R".to_string()),
            start_line: Some(1),
            start_column: Some(1),
            end_line: Some(1),
            end_column: Some(10),
            source_sha256: Some("a".repeat(64)),
            source_excerpt: Some("result".to_string()),
            artifact_id: None,
            evidence_ids,
        }
    }

    #[tokio::test]
    async fn executor_preserves_open_contract_and_reopens_durable_evidence() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let executor = StoreExecutor::open(&database).await.unwrap();
        assert_eq!(
            executor.migration_outcome().status,
            MigrationStatus::BootstrappedCurrent
        );

        let entry = executor
            .create_evidence_entry(entry_draft("D:/projects/A", "Durable entry"))
            .await
            .unwrap();
        let claim = executor
            .create_evidence_claim(source_claim("D:/projects/A", vec![entry.id]))
            .await
            .unwrap();
        drop(executor);

        let reopened = StoreExecutor::open(&database).await.unwrap();
        assert_eq!(
            reopened.migration_outcome().status,
            MigrationStatus::OpenedCurrent
        );
        assert_eq!(
            reopened
                .list_evidence_entries("D:/projects/A".to_string(), None, None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            reopened
                .review_evidence_claim("D:/projects/A".to_string(), claim.claim_id, Some(true),)
                .await
                .unwrap()
                .status,
            ClaimReviewStatus::Linked
        );
    }

    #[tokio::test]
    async fn executor_rejects_cross_project_links_without_partial_writes() {
        let directory = TempDir::new().unwrap();
        let executor = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap();
        let foreign = executor
            .create_evidence_entry(entry_draft("D:/projects/B", "Foreign"))
            .await
            .unwrap();

        let error = executor
            .create_evidence_claim(source_claim("D:/projects/A", vec![foreign.id]))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            StoreExecutorError::Store(StoreError::Validation(_))
        ));
        assert!(
            executor
                .list_evidence_claims("D:/projects/A".to_string(), None)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            executor
                .list_evidence_entries("D:/projects/B".to_string(), None, None)
                .await
                .unwrap()
                .len(),
            1
        );
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

        executor
            .create_evidence_entry(entry_draft("D:/projects/A", "Recovered"))
            .await
            .unwrap();
        assert_eq!(
            executor
                .list_evidence_entries("D:/projects/A".to_string(), None, None)
                .await
                .unwrap()
                .len(),
            1
        );
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
    async fn executor_reports_migration_rejection_without_rewriting_schema() {
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
            Some("unsupported_schema_version")
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
