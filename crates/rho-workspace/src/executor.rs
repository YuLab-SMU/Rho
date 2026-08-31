use rho_control_plane::{BrokerLease, lease_matches_request};
use rho_protocol::{
    DestinationClass, ExecutionId, ExecutionTerminalOutcome, JobId, KernelInstanceId, OperationId,
    ProjectId, ProjectRevision, RevisionError, RevisionStamp, RevisionTransition, StateRevision,
    WorkspaceId,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{WorkspaceRevisionTracker, WorkspaceTerminalOutcome};

pub const MAX_WORKSPACE_STDOUT_BYTES: usize = 64 * 1024;
pub const MAX_WORKSPACE_CONDITIONS: usize = 128;
pub const MAX_WORKSPACE_OBJECTS: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEffectKind {
    Observation,
    Mutation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceBridgeRequest {
    pub project_id: ProjectId,
    pub workspace_id: WorkspaceId,
    pub kernel_instance_id: KernelInstanceId,
    pub expected_revisions: rho_protocol::ExpectedRevisions,
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub now_ms: u64,
    pub effect: WorkspaceEffectKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SimulatedRResult {
    pub terminal: ExecutionTerminalOutcome,
    pub stdout: String,
    pub conditions: Vec<String>,
    pub objects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NormalizedWorkspaceOutput {
    pub stdout: String,
    pub conditions: Vec<String>,
    pub objects: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceExecutionObservation {
    pub execution_id: ExecutionId,
    pub terminal: ExecutionTerminalOutcome,
    pub revision_transition: RevisionTransition,
    pub output: NormalizedWorkspaceOutput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceStatus {
    pub busy: bool,
    pub active_job_id: Option<JobId>,
    pub state_revision: StateRevision,
    pub project_revision: ProjectRevision,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum WorkspaceExecutorError {
    #[error("workspace executor is busy with {0}")]
    Busy(JobId),
    #[error("Broker lease is missing, expired, forged, reused, or bound to different effect")]
    InvalidLease,
    #[error("request workspace/kernel does not match live Workspace")]
    WrongWorkspace,
    #[error("revision error: {0}")]
    Revision(#[from] RevisionError),
    #[error("broker lease error: {0}")]
    Broker(#[from] rho_control_plane::BrokerError),
}

#[derive(Debug, Clone)]
pub struct WorkspaceExecutor {
    project_id: ProjectId,
    tracker: WorkspaceRevisionTracker,
    active_job_id: Option<JobId>,
}

impl WorkspaceExecutor {
    pub fn new(project_id: ProjectId, initial: RevisionStamp) -> Self {
        Self {
            project_id,
            tracker: WorkspaceRevisionTracker::new(
                initial.workspace_id,
                initial.kernel_instance_id,
                initial.state_revision,
                initial.project_revision,
            ),
            active_job_id: None,
        }
    }

    pub fn execute(
        &mut self,
        request: WorkspaceBridgeRequest,
        lease: &BrokerLease,
        normalized_arguments: &serde_json::Value,
        simulated: SimulatedRResult,
    ) -> Result<WorkspaceExecutionObservation, WorkspaceExecutorError> {
        if let Some(job_id) = &self.active_job_id {
            return Err(WorkspaceExecutorError::Busy(job_id.clone()));
        }
        self.verify_request(&request, lease, normalized_arguments)?;
        let job_id = JobId::new(format!("job_{}", request.execution_id.as_str()))
            .unwrap_or_else(|_| JobId::generate());
        self.active_job_id = Some(job_id);
        let output =
            normalize_workspace_output(simulated.stdout, simulated.conditions, simulated.objects);
        let transition = match request.effect {
            WorkspaceEffectKind::Observation => {
                self.tracker.observe(&request.kernel_instance_id)?
            }
            WorkspaceEffectKind::Mutation => match self.tracker.record_terminal_execution(
                format!("terminal_{}", request.execution_id.as_str()),
                simulated.terminal,
                true,
            )? {
                WorkspaceTerminalOutcome::Advanced(transition) => transition,
                WorkspaceTerminalOutcome::Duplicate(stamp) => RevisionTransition {
                    before: stamp.clone(),
                    after: stamp,
                },
            },
        };
        self.active_job_id = None;
        Ok(WorkspaceExecutionObservation {
            execution_id: request.execution_id,
            terminal: simulated.terminal,
            revision_transition: transition,
            output,
        })
    }

    pub fn simulate_busy(&mut self, job_id: JobId) {
        self.active_job_id = Some(job_id);
    }

    pub fn status(&self) -> WorkspaceStatus {
        WorkspaceStatus {
            busy: self.active_job_id.is_some(),
            active_job_id: self.active_job_id.clone(),
            state_revision: self.tracker.current().state_revision,
            project_revision: self.tracker.current().project_revision,
            message: if self.active_job_id.is_some() {
                "Workspace evaluation running; only bounded status and stream reads are available"
                    .to_string()
            } else {
                "Workspace ready".to_string()
            },
        }
    }

    pub fn current_revision(&self) -> &RevisionStamp {
        self.tracker.current()
    }

    fn verify_request(
        &self,
        request: &WorkspaceBridgeRequest,
        lease: &BrokerLease,
        normalized_arguments: &serde_json::Value,
    ) -> Result<(), WorkspaceExecutorError> {
        if request.project_id != self.project_id
            || request.workspace_id != self.tracker.current().workspace_id
            || request.kernel_instance_id != self.tracker.current().kernel_instance_id
        {
            return Err(WorkspaceExecutorError::WrongWorkspace);
        }
        if lease.operation_id() != &request.operation_id {
            return Err(WorkspaceExecutorError::InvalidLease);
        }
        let valid = lease_matches_request(
            lease,
            normalized_arguments,
            &request.expected_revisions,
            DestinationClass::LocalWorkspace,
            request.now_ms,
        )?;
        if !valid {
            return Err(WorkspaceExecutorError::InvalidLease);
        }
        Ok(())
    }
}

pub fn normalize_workspace_output(
    stdout: String,
    mut conditions: Vec<String>,
    mut objects: Vec<String>,
) -> NormalizedWorkspaceOutput {
    let mut truncated = false;
    let stdout = if stdout.len() > MAX_WORKSPACE_STDOUT_BYTES {
        truncated = true;
        stdout[..MAX_WORKSPACE_STDOUT_BYTES].to_string()
    } else {
        stdout
    };
    if conditions.len() > MAX_WORKSPACE_CONDITIONS {
        truncated = true;
        conditions.truncate(MAX_WORKSPACE_CONDITIONS);
    }
    if objects.len() > MAX_WORKSPACE_OBJECTS {
        truncated = true;
        objects.truncate(MAX_WORKSPACE_OBJECTS);
    }
    NormalizedWorkspaceOutput {
        stdout,
        conditions,
        objects,
        truncated,
    }
}

pub fn direct_validated_bridge_fixture() -> SimulatedRResult {
    SimulatedRResult {
        terminal: ExecutionTerminalOutcome::Succeeded,
        stdout: "mean expression: 4.2".to_string(),
        conditions: vec!["message: fitted sample-adjusted model".to_string()],
        objects: vec!["de_result:data.frame[25x7]".to_string()],
    }
}
