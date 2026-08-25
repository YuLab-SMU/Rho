//! Asynchronous reproducibility audit service.

use std::panic::{AssertUnwindSafe, catch_unwind};

use thiserror::Error;

use crate::{AuditLimits, AuditResponse, AuditScope, StoreExecutor, StoreExecutorOperationError};

const UNEXPECTED_AUDIT_MESSAGE: &str =
    "The project reproducibility check failed unexpectedly. Try the check again.";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuditRepositoryError {
    #[error("{UNEXPECTED_AUDIT_MESSAGE}")]
    Unexpected,
    #[error("Store worker failed: {0}")]
    Worker(String),
}

#[derive(Clone, Debug)]
pub struct AuditRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn audit_repository(&self) -> AuditRepository {
        AuditRepository {
            executor: self.clone(),
        }
    }
}

fn contain_audit_panic<T>(operation: impl FnOnce() -> T) -> Result<T, AuditRepositoryError> {
    catch_unwind(AssertUnwindSafe(operation)).map_err(|_| AuditRepositoryError::Unexpected)
}

impl AuditRepository {
    pub async fn audit_reproducibility(
        &self,
        scope: AuditScope,
        project_root: String,
        reference_snapshot_id: Option<String>,
        limits: AuditLimits,
    ) -> Result<AuditResponse, AuditRepositoryError> {
        self.executor
            .run_service(move |store| {
                contain_audit_panic(|| {
                    store.audit_reproducibility(
                        scope,
                        &project_root,
                        reference_snapshot_id.as_deref(),
                        &limits,
                    )
                })
            })
            .await
            .map_err(|error| match error {
                StoreExecutorOperationError::Operation(error) => error,
                StoreExecutorOperationError::Worker(message) => {
                    AuditRepositoryError::Worker(message)
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn contained_panic_preserves_worker_and_stable_recovery_message() {
        let directory = tempdir().unwrap();
        let executor = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap();
        let error = executor
            .run_service(|_| {
                contain_audit_panic(|| -> AuditResponse { panic!("injected audit panic") })
            })
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            StoreExecutorOperationError::Operation(AuditRepositoryError::Unexpected)
        ));
        assert_eq!(
            error.to_string(),
            "The project reproducibility check failed unexpectedly. Try the check again."
        );

        let response = executor
            .audit_repository()
            .audit_reproducibility(
                AuditScope::Project,
                directory.path().to_string_lossy().into_owned(),
                None,
                AuditLimits::default(),
            )
            .await
            .unwrap();
        assert_eq!(response.schema_version, 1);
        assert_eq!(response.scope, "project");
    }
}
