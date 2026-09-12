//! Component assistant application records. No engine types or scientific state machine.
use crate::{
    AgentContextSelection, ApplicationDocumentRef, ApplicationWindowRef, MediaReference,
    OperationId,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentAgentProfile {
    Objects,
    Packages,
    Plots,
    Documents,
    Workspace,
    Project,
    Environment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentAgentMode {
    Explain,
    Edit,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentSession {
    pub workspace_instance_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentDocumentGrant {
    pub document: ApplicationDocumentRef,
    pub allow_save: bool,
    /// Exact project-relative destination; Save As cannot expand this scope.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentFileGrant {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentGrant {
    pub mode: ComponentAgentMode,
    pub session: Option<ComponentAgentSession>,
    pub documents: Vec<ComponentDocumentGrant>,
    pub files: Vec<ComponentFileGrant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentModelProtocol {
    Anthropic,
    OpenaiCompletions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComponentCredentialRef {
    Environment { name: String },
    Session { key_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentModelConnection {
    pub protocol: ComponentModelProtocol,
    pub base_url: String,
    pub model: String,
    pub credential: ComponentCredentialRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentModelSettings {
    pub version: u64,
    pub enabled: bool,
    pub connection: Option<ComponentModelConnection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentAgentConversation {
    pub conversation_id: String,
    pub version: u64,
    /// User draft CAS is independent of streaming run/event updates.
    pub draft_version: u64,
    pub controller: ApplicationWindowRef,
    pub profile: ComponentAgentProfile,
    pub draft: String,
    pub active_run_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentStart {
    pub request_id: String,
    pub conversation_id: String,
    pub conversation_version: u64,
    pub window: ApplicationWindowRef,
    pub model_settings_version: u64,
    pub text: String,
    pub grant: ComponentAgentGrant,
    pub sources: Vec<AgentContextSelection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentAgentRunState {
    Queued,
    Running,
    WaitingForR,
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentAgentBudget {
    pub model_calls: u32,
    pub tool_calls: u32,
    pub context_bytes: u32,
    pub tool_result_bytes: u32,
    pub output_tokens: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentAgentRun {
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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentSourceObservation {
    pub capability: String,
    pub target: crate::TargetRef,
    pub source: String,
    pub observed_at_ms: i64,
    pub status: crate::QueryStatus,
    pub completeness: crate::ObservationCompleteness,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentAgentContext {
    pub sources: Vec<ComponentSourceSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentSourcePreviewRequest {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub session: Option<ComponentAgentSession>,
    pub selection: AgentContextSelection,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentSourcePreview {
    pub snapshot: Option<ComponentSourceSnapshot>,
    pub image_base64: Option<String>,
    pub image_mime_type: Option<String>,
    pub observations: Vec<ComponentSourceObservation>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentToolPhase {
    Intent,
    Accepted,
    Resolved,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComponentAgentEvidence {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComponentAgentEventContent {
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentAgentEvent {
    pub run_id: String,
    pub sequence: u64,
    pub created_at_ms: u64,
    pub content: ComponentAgentEventContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentAgentEventPage {
    pub events: Vec<ComponentAgentEvent>,
    pub cursor: u64,
    pub history_gap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentsQuery {
    pub project_root: String,
    pub query: ComponentAgentQuery,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComponentAgentQuery {
    Diagnostics,
    Diagnostic {
        request_id: String,
    },
    Settings,
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentsCommand {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub command: ComponentAgentCommand,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComponentAgentCommand {
    StopTest {
        request_id: String,
    },
    Create {
        conversation_id: String,
        profile: ComponentAgentProfile,
    },
    SaveDraft {
        draft: ComponentAgentDraftUpdate,
    },
    Start {
        request: ComponentAgentStart,
    },
    Stop {
        run_id: String,
    },
    Configure {
        settings: ComponentModelSettings,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentDraftUpdate {
    pub conversation_id: String,
    pub draft_version: u64,
    pub text: String,
}

/// A separate transient endpoint prevents credentials entering pending command/draft records.
#[derive(Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentSessionCredential {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentModelTestKind {
    Connection,
    Images,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentModelTestState {
    Queued,
    Running,
    Passed,
    Failed,
    Interrupted,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentModelTestRequest {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub model_settings_version: u64,
    pub kind: ComponentModelTestKind,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentSourceSearch {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub session: Option<ComponentAgentSession>,
    pub source: String,
    pub text: String,
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ComponentSourceSearchResult {
    pub items: Vec<crate::AgentContextItem>,
    pub notices: Vec<String>,
}
