//! Captured built-in Agent task records. These carry references; native owners retain scientific truth.
pub use crate::component_boundary::*;
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentAgentMode {
    Explain,
    Edit,
    Run,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentPermissionState {
    Pending,
    Allowed,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentPermission {
    pub decision_id: String,
    pub receipt_id: String,
    pub action_digest: String,
    pub tool: String,
    pub title: String,
    pub details: String,
    pub authorization: ComponentTaskAuthorization,
    pub policy: ComponentPermissionPolicy,
    pub state: ComponentPermissionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentSession {
    pub workspace_instance_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentDocumentGrant {
    pub document: ApplicationDocumentRef,
    pub allow_save: bool,
    /// Exact project-relative destination; Save As cannot expand this scope.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentFileGrant {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentGrant {
    /// Absent only in already recorded requests using the former work modes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub permission_policy: Option<ComponentPermissionPolicy>,
    pub mode: ComponentAgentMode,
    pub session: Option<ComponentAgentSession>,
    pub documents: Vec<ComponentDocumentGrant>,
    pub files: Vec<ComponentFileGrant>,
}

impl ComponentAgentGrant {
    pub fn allows_edit(&self) -> bool {
        self.permission_policy.is_some() || self.mode != ComponentAgentMode::Explain
    }
    pub fn allows_execution(&self) -> bool {
        self.session.is_some()
            && (self.permission_policy.is_some() || self.mode == ComponentAgentMode::Run)
    }
    pub fn allows_save(&self, document: &ComponentDocumentGrant) -> bool {
        document.path.is_some() && (self.permission_policy.is_some() || document.allow_save)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentConversation {
    pub conversation_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub archived: bool,
    pub version: u64,
    /// User draft CAS is independent of streaming run/event updates.
    pub draft_version: u64,
    pub controller: ApplicationWindowRef,
    pub profile: ComponentAgentProfile,
    pub draft: String,
    #[serde(default)]
    pub draft_content: AgentDraftContent,
    #[serde(default)]
    #[ts(optional)]
    pub draft_grant: Option<ComponentAgentGrant>,
    pub active_run_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentStart {
    /// Immutable user-uploaded attachment references; bytes stay in Application asset storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub assets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continuation: Option<ComponentContinuation>,
    pub request_id: String,
    pub conversation_id: String,
    pub conversation_version: u64,
    pub window: ApplicationWindowRef,
    pub model_settings_version: u64,
    pub text: String,
    pub grant: ComponentAgentGrant,
    pub sources: Vec<AgentContextSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentContinuation {
    pub run_id: String,
    pub recovery_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentAgentRunState {
    Queued,
    Running,
    WaitingForR,
    WaitingForPermission,
    NeedsInput,
    Stopping,
    Completed,
    Stopped,
    Failed,
    Interrupted,
}
impl ComponentAgentRunState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Stopped | Self::Failed | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentRun {
    #[serde(default)]
    pub document_grants: Vec<ComponentDocumentGrant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub task_intent: Option<ComponentAgentTaskIntent>,
    #[serde(default)]
    pub permissions: Vec<ComponentAgentPermission>,
    pub run_id: String,
    pub request: ComponentAgentStart,
    pub profile: ComponentAgentProfile,
    pub state: ComponentAgentRunState,
    /// Fixed configuration for this run. Contains references, never credentials.
    pub model: ComponentModelConnection,
    pub budget: ComponentAgentBudget,
    pub model_calls: u32,
    pub tool_calls: u32,
    pub tool_result_bytes: u32,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub event_cursor: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub reason: Option<String>,
    pub context: Option<ComponentAgentContext>,
    pub document_versions: Option<std::collections::BTreeMap<String, ApplicationDocumentRef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recovery: Option<ComponentAgentRecovery>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentRecoveryState {
    Confirmed,
    NotSubmitted,
    ReadInterrupted,
    Pending,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentRecoveredOperation {
    pub operation_id: OperationId,
    pub status: OperationStatus,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentRecoveredTool {
    pub receipt_id: String,
    pub state: ComponentRecoveryState,
    pub application_request_id: Option<String>,
    pub application_state: Option<ApplicationCommandState>,
    pub operations: Vec<ComponentRecoveredOperation>,
    pub documents: Vec<ApplicationDocumentRef>,
    pub note: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentRecovery {
    pub version: u64,
    pub digest: String,
    pub checked_at_ms: u64,
    pub unresolved_mutations: u32,
    pub tools: Vec<ComponentRecoveredTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentSourceObservation {
    pub capability: String,
    pub target: TargetRef,
    pub source: String,
    pub observed_at_ms: i64,
    pub status: QueryStatus,
    pub completeness: ObservationCompleteness,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentSourceSnapshot {
    pub selection: AgentContextSelection,
    pub title: String,
    pub description: String,
    pub text: String,
    pub native_data: serde_json::Value,
    pub truncated: bool,
    pub observations: Vec<ComponentSourceObservation>,
    pub evidence: Vec<ComponentAgentEvidence>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub history: Option<serde_json::Value>,
    pub sources: Vec<ComponentSourceSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentSourcePreviewRequest {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub session: Option<ComponentAgentSession>,
    pub selection: AgentContextSelection,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentSourcePreview {
    pub snapshot: Option<ComponentSourceSnapshot>,
    pub image_base64: Option<String>,
    pub image_mime_type: Option<String>,
    pub observations: Vec<ComponentSourceObservation>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentToolPhase {
    Intent,
    Accepted,
    Resolved,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComponentAgentEvidence {
    Attachment {
        conversation_id: String,
        asset: AgentAsset,
    },
    Operation {
        operation_id: OperationId,
    },
    Media {
        reference: MediaReference,
    },
    Document {
        document: ApplicationDocumentRef,
    },
    File {
        path: String,
        sha256: String,
    },
    Observation {
        capability: String,
        reference: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentToolReceipt {
    pub receipt_id: String,
    pub run_id: String,
    pub model_call: u32,
    pub tool_call_id: String,
    pub capability: String,
    pub arguments_digest: String,
    pub action_digest: String,
    pub client_request_id: String,
    pub mutation: bool,
    pub phase: ComponentToolPhase,
    pub operation_id: Option<OperationId>,
    pub application_request_id: Option<String>,
    pub result: Option<serde_json::Value>,
    pub evidence: Vec<ComponentAgentEvidence>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComponentAgentEventContent {
    Diagnostic {
        diagnostic: Diagnostic,
    },
    Recovery {
        version: u64,
    },
    Text {
        text: String,
    },
    State {
        state: ComponentAgentRunState,
        reason: Option<String>,
    },
    Tool {
        receipt_id: String,
        phase: ComponentToolPhase,
    },
    Evidence {
        reference: ComponentAgentEvidence,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentEvent {
    pub run_id: String,
    pub sequence: u64,
    pub created_at_ms: u64,
    pub content: ComponentAgentEventContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentEventPage {
    pub events: Vec<ComponentAgentEvent>,
    pub cursor: u64,
    pub history_gap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentsQuery {
    pub project_root: String,
    pub query: ComponentAgentQuery,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComponentAgentQuery {
    Assets {
        conversation_id: String,
    },
    Runs {
        conversation_id: String,
        before: Option<String>,
        limit: u32,
    },
    Diagnostics,
    Diagnostic {
        request_id: String,
    },
    Settings,
    CredentialStatus,
    Conversations {
        after: Option<String>,
        limit: u32,
    },
    Conversation {
        conversation_id: String,
    },
    Run {
        run_id: String,
    },
    Request {
        request_id: String,
    },
    Tools {
        run_id: String,
    },
    Events {
        run_id: String,
        after: u64,
        limit: u32,
    },
}

/// Bounded history navigation; full request/context and native receipts remain on Run/Tools.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentRunSummary {
    pub run_id: String,
    pub request_id: String,
    pub conversation_id: String,
    pub profile: ComponentAgentProfile,
    pub state: ComponentAgentRunState,
    pub text_excerpt: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub reason: Option<String>,
    pub continuation_run_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentsCommand {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub command: ComponentAgentCommand,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComponentAgentCommand {
    AddAsset {
        conversation_id: String,
        asset_id: String,
        name: String,
        mime_type: String,
        data: String,
    },
    RemoveAsset {
        conversation_id: String,
        asset_id: String,
        draft_version: u64,
    },
    Rename {
        conversation_id: String,
        expected_version: u64,
        title: String,
    },
    Archive {
        conversation_id: String,
        expected_version: u64,
        archived: bool,
    },
    Reconcile {
        run_id: String,
    },
    TakeControl {
        conversation_id: String,
        expected_version: u64,
    },
    StopTest {
        request_id: String,
    },
    Decision {
        run_id: String,
        decision_id: String,
        allow: bool,
    },
    Create {
        conversation_id: String,
        profile: ComponentAgentProfile,
    },
    SaveDraft {
        draft: ComponentAgentDraftUpdate,
    },
    Start {
        request: Box<ComponentAgentStart>,
    },
    Stop {
        run_id: String,
    },
    Configure {
        settings: ComponentModelSettings,
    },
    RemoveCredential {
        settings_version: u64,
        key_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentDraftUpdate {
    pub conversation_id: String,
    pub draft_version: u64,
    pub text: String,
    #[serde(default)]
    #[ts(optional)]
    pub content: Option<AgentDraftContent>,
    #[serde(default)]
    #[ts(optional)]
    pub grant: Option<ComponentAgentGrant>,
}

/// A separate endpoint prevents plaintext entering pending command/draft records.
#[derive(Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentLocalCredential {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentSubmissionState {
    Rejected,
    Accepted,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentRequestFailure {
    pub error: String,
    pub diagnostic: Diagnostic,
    pub submission: ComponentSubmissionState,
    pub request_id: Option<String>,
    /// Present only when the active diagnostic belongs to the same visible scope.
    pub existing_request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentModelTestRequest {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub model_settings_version: u64,
    pub kind: ComponentModelTestKind,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentModelDiagnostic {
    pub request_id: String,
    pub version: u64,
    pub window: ApplicationWindowRef,
    pub model_settings_version: u64,
    pub connection_digest: String,
    pub model: ComponentModelConnection,
    pub kind: ComponentModelTestKind,
    pub state: ComponentModelTestState,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub detail: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentSourceSearch {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub session: Option<ComponentAgentSession>,
    pub source: String,
    pub text: String,
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentSourceSearchResult {
    pub items: Vec<AgentContextItem>,
    pub notices: Vec<String>,
}

/// Reads uploaded user data from its conversation owner; never a scientific output reference.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadComponentAgentAsset {
    pub project_root: String,
    pub conversation_id: String,
    pub asset_id: String,
}
