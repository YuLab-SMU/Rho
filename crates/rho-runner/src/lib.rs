#![forbid(unsafe_code)]
//! Minimal authenticated structured-spec runner.
//!
//! The runner owns process/journal/artifact handoff only. It has no Agent,
//! Provider protocol, policy authority, UI, interactive Workspace, or updater.

pub mod artifacts;
pub mod journal;
pub mod process;
pub mod protocol;
pub mod slurm;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

use rho_protocol::{ExecutionSpec, ExecutorKind, NetworkPolicy, OperationId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use journal::{RunnerJobRecord, RunnerJobState, RunnerJournal, RunnerJournalError};
use process::{ApprovedRunnerLaunch, RunnerProcessObservation, RunnerProcessPort};
use protocol::{
    AuthenticatedRunnerRequest, RunnerCapabilities, RunnerRequest, RunnerResponse, capabilities,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovedRunnerCommand {
    pub command_id: String,
    pub executable: PathBuf,
    pub executable_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerDeploymentProfile {
    pub profile_id: String,
    pub working_root: PathBuf,
    pub output_root: PathBuf,
    pub commands: BTreeMap<String, ApprovedRunnerCommand>,
    pub resource_profile: String,
    pub allowed_executors: BTreeSet<ExecutorKind>,
}

#[derive(Debug, Error)]
pub enum RunnerCoreError {
    #[error("runner request id was reused with a different request")]
    RequestConflict,
    #[error(
        "runner ExecutionSpec is malformed, unsupported, or not admitted by deployment profile"
    )]
    SpecRejected,
    #[error("runner command profile or executable digest is invalid")]
    CommandRejected,
    #[error("runner operation is unknown")]
    UnknownOperation,
    #[error("runner journal error: {0}")]
    Journal(#[from] RunnerJournalError),
    #[error("runner process failed")]
    Process,
}

pub struct RunnerCore<P> {
    profile: RunnerDeploymentProfile,
    journal: RunnerJournal,
    process: P,
    requests: BTreeMap<String, (String, RunnerResponse)>,
}

impl<P: RunnerProcessPort> RunnerCore<P> {
    pub fn open(
        profile: RunnerDeploymentProfile,
        journal_path: impl AsRef<std::path::Path>,
        process: P,
    ) -> Result<Self, RunnerCoreError> {
        fs::create_dir_all(&profile.working_root).map_err(|_| RunnerCoreError::CommandRejected)?;
        fs::create_dir_all(&profile.output_root).map_err(|_| RunnerCoreError::CommandRejected)?;
        let working_root = profile
            .working_root
            .canonicalize()
            .map_err(|_| RunnerCoreError::CommandRejected)?;
        let output_root = profile
            .output_root
            .canonicalize()
            .map_err(|_| RunnerCoreError::CommandRejected)?;
        if working_root == output_root {
            return Err(RunnerCoreError::CommandRejected);
        }
        for (id, command) in &profile.commands {
            if id != &command.command_id
                || id.is_empty()
                || command.executable_sha256 != executable_digest(&command.executable)?
                || is_shell(&command.executable)
            {
                return Err(RunnerCoreError::CommandRejected);
            }
        }
        Ok(Self {
            profile,
            journal: RunnerJournal::open(journal_path)?,
            process,
            requests: BTreeMap::new(),
        })
    }

    pub fn handle(
        &mut self,
        envelope: AuthenticatedRunnerRequest,
    ) -> Result<RunnerResponse, RunnerCoreError> {
        let fingerprint = format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(&envelope.request).unwrap_or_default())
        );
        if let Some((existing_fingerprint, response)) = self.requests.get(&envelope.request_id) {
            return if existing_fingerprint == &fingerprint {
                Ok(response.clone())
            } else {
                Err(RunnerCoreError::RequestConflict)
            };
        }
        let response = self.dispatch(envelope.request)?;
        self.requests
            .insert(envelope.request_id, (fingerprint, response.clone()));
        Ok(response)
    }

    fn dispatch(&mut self, request: RunnerRequest) -> Result<RunnerResponse, RunnerCoreError> {
        match request {
            RunnerRequest::Handshake { client_version } => {
                if client_version != protocol::RUNNER_PROTOCOL_VERSION {
                    return Ok(RunnerResponse::Rejected {
                        reason_code: "unsupported_runner_protocol".to_string(),
                    });
                }
                Ok(RunnerResponse::Handshake {
                    capabilities: capabilities(self.profile.resource_profile.clone()),
                })
            }
            RunnerRequest::Prepare { spec } => self.prepare(*spec),
            RunnerRequest::Submit { operation_id } => self.submit(&operation_id),
            RunnerRequest::Status { execution_id } | RunnerRequest::Reconcile { execution_id } => {
                self.status(&execution_id)
            }
            RunnerRequest::Cancel { execution_id } => self.cancel(&execution_id),
            RunnerRequest::Collect { execution_id } => {
                let record = self
                    .journal
                    .by_execution(&execution_id)
                    .ok_or(RunnerCoreError::UnknownOperation)?;
                Ok(RunnerResponse::Status {
                    execution_id,
                    state: format!("{:?}", record.state).to_ascii_lowercase(),
                    reason_code: if record.state == RunnerJobState::Succeeded {
                        "terminal_ready_for_artifact_collection"
                    } else {
                        "collection_requires_terminal_process"
                    }
                    .to_string(),
                })
            }
        }
    }

    fn prepare(&mut self, spec: ExecutionSpec) -> Result<RunnerResponse, RunnerCoreError> {
        spec.validate(&BTreeSet::new())
            .map_err(|_| RunnerCoreError::SpecRejected)?;
        if !self.profile.allowed_executors.contains(&spec.executor)
            || spec.argv.is_empty()
            || matches!(spec.network, NetworkPolicy::UnrestrictedWithApproval)
        {
            return Err(RunnerCoreError::SpecRejected);
        }
        let command_id = &spec.argv[0];
        let command = self
            .profile
            .commands
            .get(command_id)
            .ok_or(RunnerCoreError::CommandRejected)?;
        if spec.argv.iter().any(|arg| arg == "-c" || arg == "/C") {
            return Err(RunnerCoreError::CommandRejected);
        }
        let digest = spec
            .digest(&BTreeSet::new())
            .map_err(|_| RunnerCoreError::SpecRejected)?;
        let job_id = format!("remote_job_{}", spec.operation_id.as_str());
        let record = RunnerJobRecord {
            execution_id: spec.execution_id.clone(),
            operation_id: spec.operation_id.clone(),
            spec_digest: digest.as_str().to_string(),
            command_id: command_id.clone(),
            argv: spec.argv.iter().skip(1).cloned().collect(),
            remote_job_id: job_id,
            state: RunnerJobState::Prepared,
            process_handle: None,
            terminal_reason_code: None,
            artifact_manifest_digests: Vec::new(),
        };
        let (record, _) = self.journal.prepare(record)?;
        // Re-check the profile command after all untrusted spec validation.
        if executable_digest(&command.executable)? != command.executable_sha256 {
            return Err(RunnerCoreError::CommandRejected);
        }
        Ok(RunnerResponse::Prepared {
            execution_id: record.execution_id,
            operation_id: record.operation_id,
            spec_digest: record.spec_digest,
        })
    }

    fn submit(&mut self, operation_id: &OperationId) -> Result<RunnerResponse, RunnerCoreError> {
        let existing = self
            .journal
            .by_operation(operation_id)
            .cloned()
            .ok_or(RunnerCoreError::UnknownOperation)?;
        if existing.state != RunnerJobState::Prepared {
            return Ok(RunnerResponse::Job {
                execution_id: existing.execution_id,
                job_id: existing.remote_job_id,
                state: format!("{:?}", existing.state).to_ascii_lowercase(),
                duplicate: true,
            });
        }
        // The exact validated command ID and argv are recovered from the durable
        // prepare journal, never reconstructed from Agent text.
        let command = self
            .profile
            .commands
            .get(&existing.command_id)
            .ok_or(RunnerCoreError::CommandRejected)?;
        let launch = ApprovedRunnerLaunch {
            execution_id: existing.execution_id.clone(),
            executable: command.executable.display().to_string(),
            argv: existing.argv.clone(),
            working_directory: self.profile.working_root.display().to_string(),
            environment: BTreeMap::from([
                (
                    "HOME".to_string(),
                    self.profile.output_root.display().to_string(),
                ),
                (
                    "TMPDIR".to_string(),
                    self.profile.output_root.display().to_string(),
                ),
                ("R_ENVIRON_USER".to_string(), "/dev/null".to_string()),
                ("R_PROFILE_USER".to_string(), "/dev/null".to_string()),
            ]),
        };
        let handle = self
            .process
            .spawn(&launch)
            .map_err(|_| RunnerCoreError::Process)?;
        let record = self.journal.update(operation_id, |record| {
            record.state = RunnerJobState::Submitted;
            record.process_handle = Some(handle.clone());
        })?;
        Ok(RunnerResponse::Job {
            execution_id: record.execution_id,
            job_id: record.remote_job_id,
            state: "submitted".to_string(),
            duplicate: false,
        })
    }

    fn status(
        &mut self,
        execution_id: &rho_protocol::ExecutionId,
    ) -> Result<RunnerResponse, RunnerCoreError> {
        let record = self
            .journal
            .by_execution(execution_id)
            .cloned()
            .ok_or(RunnerCoreError::UnknownOperation)?;
        if matches!(
            record.state,
            RunnerJobState::Succeeded | RunnerJobState::Failed | RunnerJobState::Cancelled
        ) {
            return Ok(RunnerResponse::Status {
                execution_id: record.execution_id,
                state: format!("{:?}", record.state).to_ascii_lowercase(),
                reason_code: record
                    .terminal_reason_code
                    .unwrap_or_else(|| "durable_terminal".to_string()),
            });
        }
        let Some(handle) = record.process_handle else {
            return Ok(RunnerResponse::Status {
                execution_id: execution_id.clone(),
                state: "prepared".to_string(),
                reason_code: "never_submitted".to_string(),
            });
        };
        let observation = self
            .process
            .observe(&handle)
            .unwrap_or(RunnerProcessObservation::Unknown);
        let (state, reason) = match observation {
            RunnerProcessObservation::Running => (RunnerJobState::Running, "process_running"),
            RunnerProcessObservation::ExitedSuccess => {
                (RunnerJobState::Succeeded, "process_exit_success")
            }
            RunnerProcessObservation::ExitedFailure => {
                (RunnerJobState::Failed, "process_exit_failure")
            }
            RunnerProcessObservation::Missing
            | RunnerProcessObservation::IdentityMismatch
            | RunnerProcessObservation::Unknown => (
                RunnerJobState::Uncertain,
                "process_truth_requires_reconcile",
            ),
        };
        let operation_id = record.operation_id.clone();
        let record = self.journal.update(&operation_id, |record| {
            record.state = state;
            if matches!(
                state,
                RunnerJobState::Succeeded
                    | RunnerJobState::Failed
                    | RunnerJobState::Cancelled
                    | RunnerJobState::Uncertain
            ) {
                record.terminal_reason_code = Some(reason.to_string());
            }
        })?;
        Ok(RunnerResponse::Status {
            execution_id: record.execution_id,
            state: format!("{:?}", record.state).to_ascii_lowercase(),
            reason_code: reason.to_string(),
        })
    }

    fn cancel(
        &mut self,
        execution_id: &rho_protocol::ExecutionId,
    ) -> Result<RunnerResponse, RunnerCoreError> {
        let record = self
            .journal
            .by_execution(execution_id)
            .cloned()
            .ok_or(RunnerCoreError::UnknownOperation)?;
        if matches!(
            record.state,
            RunnerJobState::Succeeded | RunnerJobState::Failed | RunnerJobState::Cancelled
        ) {
            return Ok(RunnerResponse::Status {
                execution_id: execution_id.clone(),
                state: format!("{:?}", record.state).to_ascii_lowercase(),
                reason_code: "already_terminal".to_string(),
            });
        }
        let confirmed = record
            .process_handle
            .as_ref()
            .is_some_and(|handle| self.process.cancel(handle).unwrap_or(false));
        let operation_id = record.operation_id.clone();
        let record = self.journal.update(&operation_id, |record| {
            record.state = if confirmed {
                RunnerJobState::Cancelled
            } else {
                RunnerJobState::Uncertain
            };
            record.terminal_reason_code = Some(
                if confirmed {
                    "process_tree_confirmed_cancelled"
                } else {
                    "cancel_unconfirmed_reconcile"
                }
                .to_string(),
            );
        })?;
        Ok(RunnerResponse::Status {
            execution_id: record.execution_id,
            state: format!("{:?}", record.state).to_ascii_lowercase(),
            reason_code: record.terminal_reason_code.unwrap_or_default(),
        })
    }

    pub fn journal(&self) -> &RunnerJournal {
        &self.journal
    }
}

pub fn executable_digest(path: &std::path::Path) -> Result<String, RunnerCoreError> {
    let bytes = fs::read(path).map_err(|_| RunnerCoreError::CommandRejected)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn is_shell(path: &std::path::Path) -> bool {
    matches!(
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "sh" | "bash" | "zsh" | "cmd" | "cmd.exe" | "powershell" | "pwsh"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> RunnerBoundary {
    RunnerBoundary {
        owns: &[
            "authenticated_protocol",
            "runner_journal",
            "structured_spec_execution",
            "bounded_process",
            "remote_artifact_handoff",
        ],
        does_not_own: &[
            "acp_transport",
            "agent_plan",
            "broker_policy",
            "desktop_projection",
            "interactive_workspace",
            "self_update_protocol",
        ],
    }
}

pub fn accepts_only_structured_spec(spec: &ExecutionSpec) -> bool {
    spec.validate(&BTreeSet::new()).is_ok()
        && !spec.argv.is_empty()
        && !matches!(spec.network, NetworkPolicy::UnrestrictedWithApproval)
        && !spec
            .argv
            .iter()
            .any(|argument| argument == "-c" || argument == "/C")
}

pub fn runner_capabilities(profile: &RunnerDeploymentProfile) -> RunnerCapabilities {
    capabilities(profile.resource_profile.clone())
}
