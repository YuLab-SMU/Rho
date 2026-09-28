//! Transitional conversions to the package-owned Agent task state machine.
use crate::{ApplicationError, ApplicationScope};
pub use rho_agent_owner::*;

impl From<AgentTaskError> for ApplicationError {
    fn from(error: AgentTaskError) -> Self {
        match error {
            AgentTaskError::InvalidInput(message) => Self::InvalidInput(message),
            AgentTaskError::NotFound => Self::NotFound,
            AgentTaskError::Conflict => Self::Conflict,
            AgentTaskError::RequestConflict => Self::RequestConflict,
            AgentTaskError::Budget(message) => Self::Budget(message),
            AgentTaskError::Storage(message) => Self::Storage(message),
        }
    }
}
impl From<&ApplicationScope> for AgentTaskScope {
    fn from(scope: &ApplicationScope) -> Self {
        Self { project: scope.project.clone(), principal: scope.principal.clone() }
    }
}
impl From<&AgentTaskScope> for ApplicationScope {
    fn from(scope: &AgentTaskScope) -> Self {
        Self { project: scope.project.clone(), principal: scope.principal.clone() }
    }
}
