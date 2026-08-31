use std::collections::BTreeSet;

use rho_protocol::{
    ExecutionTerminalOutcome, KernelInstanceId, ProjectRevision, RevisionError, RevisionStamp,
    RevisionTransition, StateRevision, WorkspaceId, WorkspaceRevision,
    terminal_execution_revision_transition,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRevisionTracker {
    current: RevisionStamp,
    seen_terminal_events: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceTerminalOutcome {
    Advanced(RevisionTransition),
    Duplicate(RevisionStamp),
}

impl WorkspaceRevisionTracker {
    pub fn new(
        workspace_id: WorkspaceId,
        kernel_instance_id: KernelInstanceId,
        state_revision: StateRevision,
        project_revision: ProjectRevision,
    ) -> Self {
        Self {
            current: RevisionStamp {
                workspace_id,
                kernel_instance_id,
                state_revision,
                project_revision,
            },
            seen_terminal_events: BTreeSet::new(),
        }
    }

    pub fn current(&self) -> &RevisionStamp {
        &self.current
    }

    pub fn observe(
        &self,
        observed_kernel: &KernelInstanceId,
    ) -> Result<RevisionTransition, RevisionError> {
        WorkspaceRevision {
            workspace_id: self.current.workspace_id.clone(),
            kernel_instance_id: self.current.kernel_instance_id.clone(),
            state_revision: self.current.state_revision,
        }
        .observe_with_kernel(observed_kernel, self.current.project_revision)
    }

    pub fn record_terminal_execution(
        &mut self,
        terminal_event_id: impl Into<String>,
        outcome: ExecutionTerminalOutcome,
        arbitrary_evaluation_admitted: bool,
    ) -> Result<WorkspaceTerminalOutcome, RevisionError> {
        let terminal_event_id = terminal_event_id.into();
        if !self.seen_terminal_events.insert(terminal_event_id) {
            return Ok(WorkspaceTerminalOutcome::Duplicate(self.current.clone()));
        }
        let transition = terminal_execution_revision_transition(
            self.current.clone(),
            outcome,
            arbitrary_evaluation_admitted,
        )?;
        self.current = transition.after.clone();
        Ok(WorkspaceTerminalOutcome::Advanced(transition))
    }

    pub fn restart_kernel(&mut self, kernel_instance_id: KernelInstanceId) -> RevisionTransition {
        let before = self.current.clone();
        self.current.kernel_instance_id = kernel_instance_id;
        self.current.state_revision = StateRevision(self.current.state_revision.0 + 1);
        RevisionTransition {
            before,
            after: self.current.clone(),
        }
    }
}
