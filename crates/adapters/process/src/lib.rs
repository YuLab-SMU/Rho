#![forbid(unsafe_code)]
mod recovery;
use async_trait::async_trait;
pub use recovery::{current_process_session_id, inspect_process_marker, inspect_process_marker_in_session};
use rho_contract::Operation;
use rho_execution::{ProcessExecutor, ProcessReconciliation, RunLocalArguments};
use rho_operation::HandlerError;
pub use rho_process_engine::{ProcessOptions, ProcessReport, ProcessTermination, run_command};
use std::{io, path::{Path, PathBuf}, time::Duration};
use tokio::{process::Command, sync::watch};

pub struct LocalProcessExecutor {
    root: PathBuf,
    identity: String,
}
impl LocalProcessExecutor {
    pub fn new(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref().canonicalize()?;
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process root must be a directory",
            ));
        }
        let identity = root
            .to_str()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "process root must be UTF-8")
            })?
            .into();
        Ok(Self { root, identity })
    }
}
#[async_trait]
impl ProcessExecutor for LocalProcessExecutor {
    fn root(&self) -> &str {
        &self.identity
    }
    async fn reconcile(&self, source: &Operation) -> Result<ProcessReconciliation, HandlerError> {
        if self
            .root
            .canonicalize()
            .map_err(|error| HandlerError::before_effect(error.to_string()))?
            != self.root
        {
            return Err(HandlerError::before_effect("process project root changed"));
        }
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
        if self
            .root
            .canonicalize()
            .map_err(|e| HandlerError::before_effect(e.to_string()))?
            != self.root
        {
            return Err(HandlerError::before_effect("process project root changed"));
        }
        let mut command = Command::new(&args.program);
        command
            .args(&args.args)
            .current_dir(&self.root)
            .env("RHO_OPERATION_ID", operation.operation_id.as_str());
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy().to_ascii_uppercase();
            if key.contains("TOKEN")
                || key.contains("SECRET")
                || key.contains("PASSWORD")
                || key.ends_with("KEY")
            {
                command.env_remove(name);
            }
        }
        run_command(
            command,
            ProcessOptions {
                timeout: Duration::from_millis(args.timeout_ms),
                output_limit_bytes: args.output_limit_bytes,
                stdin: args.stdin.as_ref().map(|input| input.as_bytes().to_vec()),
            },
            cancellation,
        )
        .await
        .map_err(|e| HandlerError::before_effect(e.to_string()))
    }
}
