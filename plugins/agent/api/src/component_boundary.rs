//! Agent-owned captures of admitted calls and native owner receipts.
//! These observations are not dispatch ports or caller authority. Native dispatch
//! and receipt verification stay with the containing owner; no private core types
//! are imported. Unknown document actions are refused by task admission.
pub use crate::AgentControllerRef as ApplicationWindowRef;
pub use rho_plugin_protocol::{OperationId, PluginRequest, ProviderBinding, RequestId};
pub use rho_r_api::{ExecuteR, MediaReference};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct CapabilityRef {
    pub id: String,
    pub version: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct Precondition {
    pub kind: String,
    pub subject: String,
    pub expected: Value,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct TargetRef {
    pub kind: String,
    pub identity: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum ObservationCompleteness {
    Complete,
    Partial,
    Unknown,
}

#[derive(JsonSchema, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct QueryRequest {
    pub capability: CapabilityRef,
    #[serde(default = "empty_arguments")]
    pub arguments: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[derive(ts_rs::TS)]
pub enum QueryStatus {
    Ready,
    Busy,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct NextRead {
    pub purpose: String,
    pub capability: CapabilityRef,
    pub arguments: Value,
    pub missing_identity_fields: Vec<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub message: String,
    pub continuation: DiagnosticContinuation,
    pub next_reads: Vec<NextRead>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationSelection {
    /// Offsets in the normalized editor document: zero-based UTF-16, excluding BOM.
    pub anchor: u32,
    pub head: u32,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct ApplicationDocumentRef {
    pub document_id: String,
    pub document_version: String,
    pub selection_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationDocumentSummary {
    pub document: ApplicationDocumentRef,
    pub path: Option<String>,
    pub sha256: String,
    pub base_hash: Option<String>,
    pub base_text_present: bool,
    pub utf8_bytes: usize,
    pub dirty: bool,
    pub selection: ApplicationSelection,
    pub readonly_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationTextEdit {
    /// Zero-based UTF-16 offsets in normalized editor content, excluding BOM.
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationCommandRequest {
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub action: ApplicationAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub execution_target: Option<ApplicationExecutionTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationExecutionTarget {
    pub workspace_instance_id: String,
    pub native_session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationCommandState {
    Cancelled,
    Pending,
    Claimed,
    Applied,
    AwaitingExecution,
    LocallyAppliedUnsynced,
    Failed,
    Expired,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationStepState {
    NotSubmitted,
    Submitting,
    Accepted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationStepReceipt {
    pub state: ApplicationStepState,
    pub client_request_id: String,
    pub operation_id: Option<OperationId>,
    pub error: Option<String>,
    #[serde(default)]
    pub verification: Option<ApplicationSaveVerification>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationSaveVerification {
    pub path: String,
    pub sha256: String,
    pub source: String,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationCaptureSummary {
    pub document: ApplicationDocumentRef,
    pub path: Option<String>,
    pub base_hash: Option<String>,
    pub sha256: String,
    pub utf8_bytes: usize,
    pub run_sha256: Option<String>,
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_instance_id: Option<String>,
    pub selection: ApplicationSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationCommandReceipt {
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub actor: CallerIdentity,
    pub state: ApplicationCommandState,
    pub created_at_ms: u64,
    pub claim_expires_at_ms: u64,
    pub claimed_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub context_version: Option<String>,
    pub capture: Option<ApplicationCaptureSummary>,
    pub save: Option<ApplicationStepReceipt>,
    pub run: Option<ApplicationStepReceipt>,
    pub diagnostic: Option<String>,
    /// Versions acknowledged by this exact local command, independent of later edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub applied_documents: Option<Vec<ApplicationDocumentRef>>,
    /// Exact acknowledged snapshots. Use sha256 to read this document version;
    /// neither document_version nor the saved base_hash is the draft checksum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub applied_document_summaries: Option<Vec<ApplicationDocumentSummary>>,
    /// The resident editor acknowledged the successful save; a changed draft is not adopted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub save_synchronized: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApplicationAction {
    OpenDocument {
        path: String,
        expected_context_version: String,
    },
    CreateDocument {
        path: Option<String>,
        text: String,
        expected_context_version: String,
    },
    EditDocument {
        document: ApplicationDocumentRef,
        edits: Vec<ApplicationTextEdit>,
    },
    Save {
        document: ApplicationDocumentRef,
        target_path: Option<String>,
    },
    RunSelection {
        document: ApplicationDocumentRef,
    },
    RunFile {
        document: ApplicationDocumentRef,
        target_path: Option<String>,
    },
    /// Unknown native actions can be observed as unsupported, never admitted.
    #[serde(other)]
    Unsupported,
}
fn empty_arguments() -> Value {
    serde_json::json!({})
}
fn text(value: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > maximum
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err("Invalid captured call text".into());
    }
    Ok(())
}
fn token(value: &str) -> Result<(), String> {
    text(value, 160)?;
    if !value
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b".-_:/".contains(&c))
    {
        return Err("Invalid captured call identity".into());
    }
    Ok(())
}
impl CapabilityRef {
    pub fn new(id: impl Into<String>, version: u16) -> Result<Self, String> {
        let reference = Self {
            id: id.into(),
            version,
        };
        reference.validate()?;
        Ok(reference)
    }
    pub fn validate(&self) -> Result<(), String> {
        token(&self.id)?;
        if self.version == 0 {
            return Err("Capability version must be positive".into());
        }
        Ok(())
    }
}
impl Invocation {
    pub fn validate(&self) -> Result<(), String> {
        token(&self.client_request_id)?;
        self.capability.validate()?;
        if serde_json::to_vec(self).map_or(true, |b| b.len() > 256 * 1024)
            || self.preconditions.len() > 32
        {
            return Err("Captured invocation exceeds its bounds".into());
        }
        for p in &self.preconditions {
            token(&p.kind)?;
            text(&p.subject, 4096)?;
        }
        Ok(())
    }
}
