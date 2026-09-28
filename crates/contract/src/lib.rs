#![forbid(unsafe_code)]
mod agent_client;
pub use agent_client::*;
mod agent_task;
pub use agent_task::*;
pub use rho_agent_api::*;
mod project_agent_task;
pub use project_agent_task::*;
mod agent_handoff;
pub use agent_handoff::*;
mod component_agent;
pub use component_agent::*;

pub mod checkpoints;
pub use checkpoints::*;

mod query;
pub use query::*;
mod commit_recovery;
pub use commit_recovery::*;
mod host;
pub use host::*;
mod workbench;
pub use workbench::*;
mod scientific;
pub use scientific::*;
mod observations;
pub use observations::*;
mod studio;
pub use studio::*;
mod discovery;
pub use discovery::*;
mod capability_docs;
pub use capability_docs::builtin_documentation;
pub mod text;
pub use text::*;
pub mod objects;
pub use objects::*;
pub mod package_index;
pub use package_index::*;
mod package_help;
pub use package_help::*;
pub mod application;
pub use application::*;
pub mod media;
pub use media::*;
pub mod skills;
pub use skills::*;
pub mod environment;
pub use environment::*;
pub mod execution;
pub use execution::*;
pub mod recovery;
pub use recovery::*;
pub mod record_query;
pub use record_query::*;
pub mod operation_evidence;
pub use operation_evidence::*;
pub mod port_controls;
pub use port_controls::*;
pub mod instances;
pub use instances::*;
mod recovery_protection;
pub use recovery_protection::*;
mod annotation;
pub use annotation::*;
mod html_surface;
pub use html_surface::*;

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
    #[error("{0}")]
    PublicProtocol(#[from] rho_plugin_protocol::ProtocolError),
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

pub use rho_plugin_protocol::OperationId;

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
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

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum CallerKind {
    Human,
    Agent,
    System,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct CallerIdentity {
    pub kind: CallerKind,
    pub id: String,
}

impl CallerIdentity {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_token(&self.id, "caller.id")
    }
}

/// Native restrictions inherited from an authenticated view. They are held by
/// the Host while a backend call is pending, never accepted from plugin RPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewCallScope {
    pub window: rho_plugin_protocol::WindowId,
    /// Captured by the native view channel and inherited by backend delegation.
    /// Never accepted from plugin arguments or public backend RPC frames.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<rho_plugin_protocol::PluginViewOrigin>,
    /// Close-time persistence may inspect only the originating view's encoding.
    pub draft_source: Option<rho_plugin_protocol::DraftSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CallContext {
    pub caller: CallerIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_scope: Option<ViewCallScope>,
    /// Authenticated local account behind an actor. Only a trusted edge sets this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal: Option<CallerIdentity>,
    #[serde(default)]
    pub scopes: BTreeSet<String>,
    pub connection_id: String,
    pub correlation_id: Option<String>,
    pub causation_id: Option<OperationId>,
    pub trace_parent: Option<String>,
}

impl CallContext {
    pub fn principal(&self) -> &CallerIdentity {
        self.principal.as_ref().unwrap_or(&self.caller)
    }
    pub fn validate(&self) -> Result<(), ContractError> {
        self.caller.validate()?;
        if let Some(principal) = &self.principal {
            principal.validate()?;
        }
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
#[derive(ts_rs::TS)]
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

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum EffectHint {
    /// Commit an already-executed result to its original Operation journal.
    CommitsOperation,
    /// Consult the plugin's captured contract for its domain-defined effects.
    PluginDefined,
    NeedsNetwork,
    MayWriteProject,
    MayMutateRuntime,
    MaySpawnProcess,
    UsesSecret,
    ProducesArtifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum IdempotencyClass {
    Pure,
    CallerScoped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum RetryClass {
    Safe,
    Never,
    ReconcileFirst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum CancellationClass {
    Unsupported,
    Cooperative,
    ExternalReconciliation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct CapabilityDescriptor {
    pub kind: CapabilityKind,
    pub capability: CapabilityRef,
    pub domain: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub recovery_schema: Value,
    pub documentation: CapabilityDocumentation,
    #[serde(default)]
    pub required_scopes: BTreeSet<String>,
    #[serde(default)]
    pub potential_effects: BTreeSet<EffectHint>,
    pub idempotency: IdempotencyClass,
    pub retry: RetryClass,
    pub cancellation: CancellationClass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum CapabilityKind {
    Operation,
    Query,
    Control,
}

impl CapabilityDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.capability.validate()?;
        self.documentation.validate()?;
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct Operation {
    pub operation_id: OperationId,
    pub client_request_id: String,
    pub caller: CallerIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub principal: Option<CallerIdentity>,
    pub capability: CapabilityRef,
    pub domain: String,
    pub target: TargetRef,
    pub normalized_arguments: Value,
    pub invocation_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub idempotency_scope: Option<String>,
    pub preconditions: Vec<Precondition>,
    pub potential_effects: BTreeSet<EffectHint>,
    pub correlation_id: String,
    pub causation_id: Option<OperationId>,
    pub trace_parent: Option<String>,
    pub accepted_at_ms: i64,
    /// Captured by Operation admission, never accepted from a plugin result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub admission: Option<OperationAdmission>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationAdmission {
    /// Canonical original request before owner preparation/normalization.
    pub request_digest: String,
    /// Exact contract retained after dynamic contribution removal or replacement.
    pub descriptor: CapabilityDescriptor,
    /// Validated owner qualification, captured separately from user arguments.
    pub owner_context: Value,
}
impl Operation {
    /// Preparation may resolve a newer native state while an identical raw
    /// request is racing with admission. The already-admitted operation wins.
    pub fn same_request(&self, other: &Self) -> bool {
        self.caller == other.caller
            && self.principal() == other.principal()
            && self.idempotency_scope == other.idempotency_scope
            && self.client_request_id == other.client_request_id
            && self.capability == other.capability
            && (self.invocation_digest == other.invocation_digest
                || self
                    .admission
                    .as_ref()
                    .zip(other.admission.as_ref())
                    .is_some_and(|(a, b)| a.request_digest == b.request_digest))
    }
    pub fn principal(&self) -> &CallerIdentity {
        self.principal.as_ref().unwrap_or(&self.caller)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
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
#[derive(ts_rs::TS)]
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
#[derive(ts_rs::TS)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct OperationRecord {
    pub operation: Operation,
    pub status: OperationStatus,
    pub outcome: Option<OperationOutcome>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub recovery: Option<Value>,
    pub cancellation_requested: bool,
    pub updated_at_ms: i64,
    /// Read-only navigation derived from this record and visible registered capabilities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_reads: Option<Vec<NextRead>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub diagnostics: Option<Vec<Diagnostic>>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
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

mod console;
pub use console::*;
