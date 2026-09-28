//! Errors returned by the task owner or by its injected native owner ports.
use rho_agent_api::component::Diagnostic;
use thiserror::Error;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ComponentTaskError {
    #[error("invalid Agent model task: {0}")]
    InvalidInput(String),
    #[error("the Agent model task is unavailable to this principal")]
    NotFound,
    #[error("the originating controller is offline")]
    Offline,
    #[error("the originating controller incarnation changed")]
    IncarnationChanged,
    #[error("the task changed; retained input was not overwritten")]
    Conflict,
    #[error("this request ID was already used with different input")]
    RequestConflict,
    #[error("the native controller credential does not match")]
    InvalidBridge,
    #[error("Agent task budget exhausted: {0}")]
    Budget(String),
    #[error("{message}")]
    Busy {
        message: String,
        request_id: Option<String>,
    },
    #[error("{}", .0.message)]
    Diagnostic(Box<Diagnostic>),
    #[error("Agent task storage failed: {0}")]
    Storage(String),
    #[error("the original caller lacks required native scopes: {missing:?}")]
    AccessDenied { missing: Vec<String> },
}
impl From<crate::AgentTaskError> for ComponentTaskError {
    fn from(error: crate::AgentTaskError) -> Self {
        use crate::AgentTaskError as E;
        match error {
            E::InvalidInput(v) => Self::InvalidInput(v),
            E::NotFound => Self::NotFound,
            E::Conflict => Self::Conflict,
            E::RequestConflict => Self::RequestConflict,
            E::Budget(v) => Self::Budget(v),
            E::Storage(v) => Self::Storage(v),
        }
    }
}
