use crate::{CapabilityDescriptor, CapabilityKind, CapabilityRef, ContractError, QuerySnapshot};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const SUMMARY_BYTES: usize = 16 * 1024;
pub const CATALOG_BYTES: usize = 64 * 1024;
pub const DESCRIPTION_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilityExample {
    /// Domain arguments. Operation callers also supply their own request ID.
    pub arguments: Value,
    pub result_explanation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilityPrecondition {
    pub parameter: String,
    pub requirement: String,
    pub read_from: Option<CapabilityRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilityDocumentation {
    pub summary: String,
    pub purpose: String,
    pub when_to_use: Vec<String>,
    pub limitations: Vec<String>,
    pub owner: String,
    pub effects: String,
    pub retry_rule: String,
    pub cancellation_rule: String,
    pub preconditions: Vec<CapabilityPrecondition>,
    pub examples: Vec<CapabilityExample>,
    pub related_capabilities: Vec<CapabilityRef>,
    pub related_skills: Vec<String>,
    pub position_units: Vec<String>,
}

impl CapabilityDocumentation {
    pub fn validate(&self) -> Result<(), ContractError> {
        for (field, value) in [
            ("documentation.summary", &self.summary),
            ("documentation.purpose", &self.purpose),
            ("documentation.owner", &self.owner),
            ("documentation.effects", &self.effects),
            ("documentation.retry_rule", &self.retry_rule),
            ("documentation.cancellation_rule", &self.cancellation_rule),
        ] {
            if value.trim().is_empty() || value.len() > 16 * 1024 {
                return Err(ContractError::InvalidText {
                    field,
                    maximum: 16 * 1024,
                });
            }
        }
        if self.examples.is_empty() || self.when_to_use.is_empty() || self.limitations.is_empty() {
            return Err(ContractError::InvalidText {
                field: "documentation.examples/when_to_use/limitations",
                maximum: DESCRIPTION_BYTES,
            });
        }
        for reference in &self.related_capabilities {
            reference.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct NextRead {
    pub purpose: String,
    pub capability: CapabilityRef,
    pub arguments: Value,
    pub missing_identity_fields: Vec<String>,
}
impl NextRead {
    pub fn query(id: &str, purpose: impl Into<String>, arguments: Value) -> Self {
        Self {
            purpose: purpose.into(),
            capability: CapabilityRef::new(id, 1).expect("static capability"),
            arguments,
            missing_identity_fields: vec![],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    Busy,
    StaleSession,
    ObservationExpired,
    ContentChanged,
    BudgetExceeded,
    Unavailable,
    InvalidInput,
    AccessDenied,
    IdempotencyConflict,
    NotFound,
    ExecutionFailed,
    Cancelled,
    OutcomeUncertain,
    ContractViolation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticContinuation {
    ReadAgain,
    RefreshObservation,
    InspectOriginal,
    CorrectInput,
    None,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub message: String,
    pub continuation: DiagnosticContinuation,
    pub next_reads: Vec<NextRead>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct HostCatalogArguments {
    #[serde(default)]
    pub module: Option<String>,
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "catalog_limit")]
    #[schemars(range(min = 1, max = 50))]
    pub limit: u32,
}
fn catalog_limit() -> u32 {
    20
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct HostDescribeArguments {
    #[serde(default)]
    pub capability: Option<CapabilityRef>,
    #[serde(default)]
    pub module: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilitySummary {
    pub capability: CapabilityRef,
    pub kind: CapabilityKind,
    pub module: String,
    pub summary: String,
    pub describe: NextRead,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct HostCatalog {
    pub entries: Vec<CapabilitySummary>,
    pub total: u32,
    pub next_cursor: Option<String>,
    pub utf8_bytes: u32,
    pub limit_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ModuleAvailability {
    pub module: String,
    pub available: bool,
    pub reasons: Vec<String>,
    pub catalog: NextRead,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct HostOverview {
    pub project_root: Option<String>,
    pub targets: Vec<crate::TargetRef>,
    pub modules: Vec<ModuleAvailability>,
    /// Each component retains its own source, time and completeness.
    pub observations: Vec<OverviewObservation>,
    pub atomic_snapshot: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
pub struct Observed<T> {
    pub source: String,
    pub observed_at_ms: i64,
    pub status: crate::QueryStatus,
    pub completeness: crate::ObservationCompleteness,
    pub data: Option<T>,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(tag = "module", content = "observation", rename_all = "snake_case")]
pub enum OverviewObservation {
    Session(Observed<crate::RuntimeStatus>),
    Console(Observed<ConsoleOverview>),
    Operations(Observed<crate::RecentOperations>),
    Application(Observed<crate::ApplicationWindows>),
    Environment(Observed<crate::EnvironmentObservation>),
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
pub struct ConsoleOverview {
    pub session_id: String,
    pub current_operation: Option<crate::OperationId>,
    pub queued_count: u32,
    pub pause: Option<crate::QueuePause>,
    pub input: Option<crate::InputRequest>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostDescription {
    Capability {
        descriptor: Box<CapabilityDescriptor>,
    },
    Module {
        module: ModuleAvailability,
        capabilities: Vec<CapabilitySummary>,
    },
}

/// Embed payload definitions at the envelope root, preserving local schema refs.
pub fn payload_envelope(mut envelope: Value, field: &str, mut payload: Value) -> Value {
    if let Some(definitions) = payload.as_object_mut().and_then(|v| v.remove("$defs")) {
        let target = envelope
            .as_object_mut()
            .expect("schema object")
            .entry("$defs")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .expect("definitions");
        for (name, definition) in definitions.as_object().expect("definitions") {
            if let Some(previous) = target.get(name) {
                assert_eq!(previous, definition, "schema definition collision: {name}");
            }
            target.insert(name.clone(), definition.clone());
        }
    }
    envelope["properties"][field] = json!({"anyOf":[payload,{"type":"null"}]});
    envelope
}
pub fn query_result_schema(payload: Value) -> Value {
    payload_envelope(schema_for!(QuerySnapshot).to_value(), "data", payload)
}
pub fn operation_result_schema(payload: Value, recovery: Value) -> Value {
    payload_envelope(
        payload_envelope(
            schema_for!(crate::OperationRecord).to_value(),
            "output",
            payload,
        ),
        "recovery",
        recovery,
    )
}
