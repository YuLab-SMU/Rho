use thiserror::Error;

/// Project/principal scope supplied by the containing owner after admission.
/// Values are storage partition keys, not credentials or caller assertions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTaskScope {
    pub project: String,
    pub principal: String,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum AgentTaskError {
    #[error("invalid Agent request: {0}")]
    InvalidInput(String),
    #[error("the Agent resource is unavailable to this principal")]
    NotFound,
    #[error("the Agent resource changed; retained input was not overwritten")]
    Conflict,
    #[error("this request ID was already used with different input")]
    RequestConflict,
    #[error("Agent budget exhausted: {0}")]
    Budget(String),
    #[error("Agent storage failed: {0}")]
    Storage(String),
}
