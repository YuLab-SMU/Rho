#![forbid(unsafe_code)]

mod query;
pub use query::*;
mod host;
pub use host::*;

use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
pub const MAX_IDENTIFIER_BYTES: usize = 160;
pub const MAX_PRECONDITIONS: usize = 32;
pub const MAX_SCOPE_COUNT: usize = 64;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ContractError {
    #[error("{field} must contain between 1 and {maximum} bytes")]
    InvalidText { field: &'static str, maximum: usize },
    #[error("{field} contains unsupported characters")]
    InvalidCharacters { field: &'static str },
    #[error("capability version must be positive")]
    InvalidCapabilityVersion,
    #[error("invocation arguments exceed {MAX_ARGUMENT_BYTES} bytes")]
    ArgumentsTooLarge,
    #[error("invocation has more than {MAX_PRECONDITIONS} preconditions")]
    TooManyPreconditions,
    #[error("call context has more than {MAX_SCOPE_COUNT} scopes")]
    TooManyScopes,
    #[error("operation status {0:?} is not terminal")]
    NonTerminalStatus(OperationStatus),
}

fn validate_text(value: &str, field: &'static str, maximum: usize) -> Result<(), ContractError> {
    if value.is_empty() || value.len() > maximum || value.trim() != value {
        return Err(ContractError::InvalidText { field, maximum });
    }
    if value.chars().any(char::is_control) {
        return Err(ContractError::InvalidCharacters { field });
    }
    Ok(())
}

fn validate_token(value: &str, field: &'static str) -> Result<(), ContractError> {
    validate_text(value, field, MAX_IDENTIFIER_BYTES)?;
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':' | '/')
    }) {
        return Err(ContractError::InvalidCharacters { field });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperationId(String);

impl OperationId {
    pub fn new(value: impl Into<String>) -> Result<Self, ContractError> {
        let value = value.into();
        validate_token(&value, "operation_id")?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityRef {
    pub id: String,
    pub version: u16,
}

impl CapabilityRef {
    pub fn new(id: impl Into<String>, version: u16) -> Result<Self, ContractError> {
        let value = Self {
            id: id.into(),
            version,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        validate_token(&self.id, "capability_id")?;
        if self.version == 0 {
            return Err(ContractError::InvalidCapabilityVersion);
        }
        Ok(())
    }

    pub fn display_key(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Precondition {
    pub kind: String,
    pub subject: String,
    pub expected: Value,
}

impl Precondition {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_token(&self.kind, "precondition.kind")?;
        validate_text(&self.subject, "precondition.subject", 4096)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invocation {
    pub client_request_id: String,
    pub capability: CapabilityRef,
    pub arguments: Value,
    #[serde(default)]
    pub preconditions: Vec<Precondition>,
}

impl Invocation {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_token(&self.client_request_id, "client_request_id")?;
        self.capability.validate()?;
        if serde_json::to_vec(self)
            .map(|encoded| encoded.len() > MAX_ARGUMENT_BYTES)
            .unwrap_or(true)
        {
            return Err(ContractError::ArgumentsTooLarge);
        }
        if self.preconditions.len() > MAX_PRECONDITIONS {
            return Err(ContractError::TooManyPreconditions);
        }
        for precondition in &self.preconditions {
            precondition.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallerKind {
    Human,
    Agent,
    System,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallerIdentity {
    pub kind: CallerKind,
    pub id: String,
}

impl CallerIdentity {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_token(&self.id, "caller.id")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallContext {
    pub caller: CallerIdentity,
    #[serde(default)]
    pub scopes: BTreeSet<String>,
    pub connection_id: String,
    pub correlation_id: Option<String>,
    pub causation_id: Option<OperationId>,
    pub trace_parent: Option<String>,
}

impl CallContext {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.caller.validate()?;
        validate_token(&self.connection_id, "connection_id")?;
        if self.scopes.len() > MAX_SCOPE_COUNT {
            return Err(ContractError::TooManyScopes);
        }
        for scope in &self.scopes {
            validate_token(scope, "scope")?;
        }
        if let Some(value) = &self.correlation_id {
            validate_token(value, "correlation_id")?;
        }
        if let Some(value) = &self.causation_id {
            validate_token(value.as_str(), "causation_id")?;
        }
        if let Some(value) = &self.trace_parent {
            validate_text(value, "trace_parent", 512)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TargetRef {
    pub kind: String,
    pub identity: String,
}

impl TargetRef {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_token(&self.kind, "target.kind")?;
        validate_text(&self.identity, "target.identity", 1024)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectHint {
    NeedsNetwork,
    MayWriteProject,
    MayMutateRuntime,
    MaySpawnProcess,
    UsesSecret,
    ProducesArtifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyClass {
    Pure,
    CallerScoped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryClass {
    Safe,
    Never,
    ReconcileFirst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancellationClass {
    Unsupported,
    Cooperative,
    ExternalReconciliation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityDescriptor {
    pub kind: CapabilityKind,
    pub capability: CapabilityRef,
    pub domain: String,
    pub input_schema: Value,
    pub output_schema: Value,
    #[serde(default)]
    pub required_scopes: BTreeSet<String>,
    #[serde(default)]
    pub potential_effects: BTreeSet<EffectHint>,
    pub idempotency: IdempotencyClass,
    pub retry: RetryClass,
    pub cancellation: CancellationClass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    Operation,
    Query,
}

impl CapabilityDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.capability.validate()?;
        validate_token(&self.domain, "capability.domain")?;
        if self.required_scopes.len() > MAX_SCOPE_COUNT {
            return Err(ContractError::TooManyScopes);
        }
        for scope in &self.required_scopes {
            validate_token(scope, "capability.required_scope")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: OperationId,
    pub client_request_id: String,
    pub caller: CallerIdentity,
    pub capability: CapabilityRef,
    pub domain: String,
    pub target: TargetRef,
    pub normalized_arguments: Value,
    pub invocation_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_scope: Option<String>,
    pub preconditions: Vec<Precondition>,
    pub potential_effects: BTreeSet<EffectHint>,
    pub correlation_id: String,
    pub causation_id: Option<OperationId>,
    pub trace_parent: Option<String>,
    pub accepted_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Accepted,
    Running,
    Reconciling,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

impl OperationStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Uncertain
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

impl OperationOutcome {
    pub fn status(self) -> OperationStatus {
        match self {
            Self::Succeeded => OperationStatus::Succeeded,
            Self::Failed => OperationStatus::Failed,
            Self::Cancelled => OperationStatus::Cancelled,
            Self::Uncertain => OperationStatus::Uncertain,
        }
    }

    pub fn from_status(status: OperationStatus) -> Result<Self, ContractError> {
        match status {
            OperationStatus::Succeeded => Ok(Self::Succeeded),
            OperationStatus::Failed => Ok(Self::Failed),
            OperationStatus::Cancelled => Ok(Self::Cancelled),
            OperationStatus::Uncertain => Ok(Self::Uncertain),
            other => Err(ContractError::NonTerminalStatus(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ObservationCompleteness {
    Complete,
    Partial,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectObservation {
    pub kind: String,
    pub source: String,
    pub detail: Value,
    pub observed_at_ms: i64,
    pub completeness: ObservationCompleteness,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationRecord {
    pub operation: Operation,
    pub status: OperationStatus,
    pub outcome: Option<OperationOutcome>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub recovery: Option<Value>,
    pub cancellation_requested: bool,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationEventRecord {
    pub event_id: String,
    pub operation_id: OperationId,
    pub sequence: u64,
    pub kind: String,
    pub payload: Value,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutboxRecord {
    pub sequence: u64,
    pub message_id: String,
    pub operation_id: OperationId,
    pub topic: String,
    pub payload: Value,
    pub created_at_ms: i64,
    pub delivered_at_ms: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_rejects_unbounded_or_ambiguous_identity() {
        let invocation = Invocation {
            client_request_id: " request ".to_string(),
            capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
            arguments: serde_json::json!({"code": "1 + 1"}),
            preconditions: Vec::new(),
        };
        assert!(invocation.validate().is_err());
    }

    #[test]
    fn only_terminal_statuses_convert_to_outcomes() {
        assert_eq!(
            OperationOutcome::from_status(OperationStatus::Uncertain).unwrap(),
            OperationOutcome::Uncertain
        );
        assert!(OperationOutcome::from_status(OperationStatus::Running).is_err());
    }
}
