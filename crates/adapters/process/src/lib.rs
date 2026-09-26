#![forbid(unsafe_code)]
use async_trait::async_trait;
pub use recovery::{
    current_process_session_id, inspect_process_marker, inspect_process_marker_in_session,
};
use rho_contract::Operation;
use rho_execution::{ProcessExecutor, ProcessReconciliation, RunLocalArguments};
use rho_operation::HandlerError;
pub use rho_process_engine::{ProcessOptions, ProcessReport, ProcessTermination, run_command};
use rho_process_owner::{LocalProcessOwner, recovery};
use std::{io, path::Path};
use tokio::sync::watch;

pub struct LocalProcessExecutor {
    owner: LocalProcessOwner,
}
impl LocalProcessExecutor {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        Ok(Self {
            owner: LocalProcessOwner::new(root)?,
        })
    }
}
#[async_trait]
impl ProcessExecutor for LocalProcessExecutor {
    fn root(&self) -> &str {
        self.owner.root()
    }
    async fn reconcile(&self, source: &Operation) -> Result<ProcessReconciliation, HandlerError> {
        self.owner
            .check_root()
            .map_err(|error| HandlerError::before_effect(error.to_string()))?;
        let operation_id = source.operation_id.as_str().to_owned();
        let recovery_id = operation_id.clone();
        tokio::task::spawn_blocking(move || recovery::reconcile_tagged(&operation_id))
            .await
            .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?
            .map_err(|error| {
                HandlerError::after_possible_effect(
                    error,
                    Some(serde_json::json!(rho_contract::ProcessReconcileRecovery {
                        source_operation_id: recovery_id,
                        action: Some("inspect_tagged_processes_without_reexecution".into())
                    })),
                )
            })
    }
    async fn run(
        &self,
        operation: &Operation,
        args: &RunLocalArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<ProcessReport, HandlerError> {
        self.owner
            .run(&operation.operation_id, args, cancellation)
            .await
            .map_err(|error| HandlerError::before_effect(error.to_string()))
    }
}
