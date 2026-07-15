use rho_protocol::{ExpectedWorkspace, OperationClass, StaleWorkspace, WorkspaceIdentity};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOrigin {
    User,
    Agent,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRequest {
    pub execution_id: String,
    pub origin: ExecutionOrigin,
    pub operation_class: OperationClass,
    pub expected: ExpectedWorkspace,
    pub code: String,
}

impl ExecutionRequest {
    pub fn new(
        origin: ExecutionOrigin,
        operation_class: OperationClass,
        expected: ExpectedWorkspace,
        code: impl Into<String>,
    ) -> Self {
        Self {
            execution_id: format!("exec_{}", Uuid::new_v4()),
            origin,
            operation_class,
            expected,
            code: code.into(),
        }
    }
}

pub struct BrokerState {
    identity: WorkspaceIdentity,
}

impl BrokerState {
    pub fn new(workspace_id: impl Into<String>) -> Self {
        Self {
            identity: WorkspaceIdentity::new(workspace_id),
        }
    }

    pub fn identity(&self) -> &WorkspaceIdentity {
        &self.identity
    }

    pub fn authorize(&self, request: &ExecutionRequest) -> Result<(), StaleWorkspace> {
        self.identity.check(&request.expected)
    }

    pub fn complete(&mut self, request: &ExecutionRequest) {
        self.identity.apply(request.operation_class);
    }

    pub fn kernel_restarted(&mut self) {
        self.identity.restart_kernel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_stale_agent_request() {
        let mut broker = BrokerState::new("ws_test");
        let initial = broker.identity().clone();
        let user_request = ExecutionRequest::new(
            ExecutionOrigin::User,
            OperationClass::StateCapable,
            ExpectedWorkspace::default(),
            "x <- 1",
        );
        broker.complete(&user_request);

        let agent_request = ExecutionRequest::new(
            ExecutionOrigin::Agent,
            OperationClass::Probe,
            ExpectedWorkspace {
                kernel_instance_id: Some(initial.kernel_instance_id),
                state_revision: Some(initial.state_revision),
                project_revision: None,
            },
            "inspect x",
        );
        assert!(matches!(
            broker.authorize(&agent_request),
            Err(StaleWorkspace::State { .. })
        ));
    }
}
