use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::ids::{KernelInstanceId, WorkspaceId};

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Default,
)]
pub struct StateRevision(pub u64);

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Default,
)]
pub struct ProjectRevision(pub u64);

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Default,
)]
pub struct StreamSeq(pub u64);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum StreamSeqError {
    #[error("stream sequence overflow")]
    Overflow,
}

impl StreamSeq {
    pub fn next(self) -> Result<Self, StreamSeqError> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(StreamSeqError::Overflow)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevisionStamp {
    pub workspace_id: WorkspaceId,
    pub kernel_instance_id: KernelInstanceId,
    pub state_revision: StateRevision,
    pub project_revision: ProjectRevision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpectedRevisions {
    pub workspace_id: WorkspaceId,
    pub kernel_instance_id: KernelInstanceId,
    pub state_revision: StateRevision,
    pub project_revision: ProjectRevision,
}

impl From<RevisionStamp> for ExpectedRevisions {
    fn from(value: RevisionStamp) -> Self {
        Self {
            workspace_id: value.workspace_id,
            kernel_instance_id: value.kernel_instance_id,
            state_revision: value.state_revision,
            project_revision: value.project_revision,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RevisionTransition {
    pub before: RevisionStamp,
    pub after: RevisionStamp,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RevisionError {
    #[error("observation came from stale kernel: expected {expected}, actual {actual}")]
    StaleKernel {
        expected: KernelInstanceId,
        actual: KernelInstanceId,
    },
    #[error("workspace identity changed during revision transition")]
    IdentityMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceRevision {
    pub workspace_id: WorkspaceId,
    pub kernel_instance_id: KernelInstanceId,
    pub state_revision: StateRevision,
}

impl WorkspaceRevision {
    pub fn observe_with_kernel(
        &self,
        observed_kernel: &KernelInstanceId,
        project_revision: ProjectRevision,
    ) -> Result<RevisionTransition, RevisionError> {
        if observed_kernel != &self.kernel_instance_id {
            return Err(RevisionError::StaleKernel {
                expected: self.kernel_instance_id.clone(),
                actual: observed_kernel.clone(),
            });
        }
        let stamp = RevisionStamp {
            workspace_id: self.workspace_id.clone(),
            kernel_instance_id: self.kernel_instance_id.clone(),
            state_revision: self.state_revision,
            project_revision,
        };
        Ok(RevisionTransition {
            before: stamp.clone(),
            after: stamp,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTerminalOutcome {
    Succeeded,
    Failed,
    Uncertain,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointRestoreStrategy {
    Exact,
    Partial,
    RestartRequired,
    NonReversible,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CheckpointDescriptor {
    pub checkpoint_id: String,
    pub scope: String,
    pub source_revision: RevisionStamp,
    pub environment_ref: String,
    pub code_ref: String,
    pub restore_strategy: CheckpointRestoreStrategy,
}

pub fn terminal_execution_revision_transition(
    before: RevisionStamp,
    outcome: ExecutionTerminalOutcome,
    arbitrary_evaluation_admitted: bool,
) -> Result<RevisionTransition, RevisionError> {
    let advance_state =
        arbitrary_evaluation_admitted || matches!(outcome, ExecutionTerminalOutcome::Uncertain);
    let after = RevisionStamp {
        workspace_id: before.workspace_id.clone(),
        kernel_instance_id: before.kernel_instance_id.clone(),
        state_revision: if advance_state {
            StateRevision(before.state_revision.0 + 1)
        } else {
            before.state_revision
        },
        project_revision: before.project_revision,
    };
    if before.workspace_id != after.workspace_id
        || before.kernel_instance_id != after.kernel_instance_id
    {
        return Err(RevisionError::IdentityMismatch);
    }
    Ok(RevisionTransition { before, after })
}
