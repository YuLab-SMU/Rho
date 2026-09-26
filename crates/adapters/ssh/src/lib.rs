//! Retiring core edge; all native SSH/Slurm behavior belongs to the plugin owner.
#![forbid(unsafe_code)]
use async_trait::async_trait;
pub use rho_contract::RemoteTarget as SshConfig;
use rho_contract::{Operation, TargetRef};
use rho_execution::{
    RunLocalArguments,
    remote::{RemoteExecutionReport, RemoteExecutor},
    slurm::{
        SlurmCancellation, SlurmJobRef, SlurmLookup, SlurmObservation, SlurmRuntime,
        SlurmSubmitArguments,
    },
};
use rho_operation::HandlerError;
use rho_remote_owner::{RemoteOwnerError, SshRemoteOwner};
use std::path::Path;
use tokio::sync::watch;

pub struct SshRemote {
    owner: SshRemoteOwner,
}
impl SshRemote {
    pub fn new(local_project: &Path, config: SshConfig) -> Result<Self, String> {
        Ok(Self {
            owner: SshRemoteOwner::new(local_project, config)?,
        })
    }
    pub fn has_slurm(&self) -> bool {
        self.owner.has_slurm()
    }
    fn reference(&self) -> TargetRef {
        TargetRef {
            kind: "remote".into(),
            identity: self.owner.reference(),
        }
    }
}
fn adapt(error: RemoteOwnerError) -> HandlerError {
    if error.possible_effect {
        HandlerError::after_possible_effect(error.message, error.recovery)
    } else {
        HandlerError::before_effect(error.message)
    }
}
#[async_trait]
impl RemoteExecutor for SshRemote {
    fn target(&self) -> TargetRef {
        self.reference()
    }
    fn scope(&self) -> &str {
        self.owner.scope()
    }
    async fn execute(
        &self,
        operation: &Operation,
        args: &RunLocalArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<RemoteExecutionReport, HandlerError> {
        self.owner
            .execute(&operation.operation_id, args, cancellation)
            .await
            .map_err(adapt)
    }
}
#[async_trait]
impl SlurmRuntime for SshRemote {
    fn target(&self) -> TargetRef {
        self.reference()
    }
    fn scope(&self) -> &str {
        self.owner.scope()
    }
    async fn submit(
        &self,
        operation: &Operation,
        args: &SlurmSubmitArguments,
    ) -> Result<SlurmJobRef, HandlerError> {
        self.owner
            .submit(&operation.operation_id, args)
            .await
            .map_err(adapt)
    }
    async fn find(&self, source: &Operation) -> Result<SlurmLookup, String> {
        self.owner.find(&source.operation_id).await
    }
    async fn request_cancel(
        &self,
        source: &Operation,
        observed: &SlurmObservation,
    ) -> Result<SlurmCancellation, HandlerError> {
        self.owner
            .request_cancel(&source.operation_id, observed)
            .await
            .map_err(adapt)
    }
}
