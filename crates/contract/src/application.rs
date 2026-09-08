//! Application state has local versions, never scientific revision numbers.
use crate::{CallerIdentity, OperationId, OperationRecord};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationWindowRef {
    pub window_id: String,
    pub incarnation: String,
}

/// A bridge credential is returned only to the registering Studio connection.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationBridgeSession {
    pub window: ApplicationWindowRef,
    pub bridge_token: String,
}
impl std::fmt::Debug for ApplicationBridgeSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApplicationBridgeSession")
            .field("window", &self.window)
            .finish_non_exhaustive()
    }
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
pub struct ApplicationDocumentRef {
    pub document_id: String,
    pub document_version: String,
    pub selection_version: String,
}

/// Synced draft owned by one window. Text preserves its BOM and line endings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationDocument {
    pub document_id: String,
    pub version: String,
    pub path: Option<String>,
    pub text: String,
    pub base_text: Option<String>,
    pub base_hash: Option<String>,
    pub selection: ApplicationSelection,
    pub readonly_reason: Option<String>,
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
#[serde(rename_all = "snake_case")]
pub enum ApplicationViewType {
    Files,
    Editor,
    Document,
    Console,
    Objects,
    Viewer,
    Packages,
    Plots,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationView {
    pub view_id: String,
    pub view_type: ApplicationViewType,
    pub document_id: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationObjectSelection {
    pub name: String,
    pub object_ref: Option<String>,
    pub native_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationPackageSelection {
    pub package: String,
    pub copy_id: String,
    pub observation_id: String,
    pub native_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationPlotSelection {
    pub operation_id: OperationId,
    pub sequence: u64,
}

/// Compact context; document bodies are independently versioned resources.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationContextState {
    pub version: String,
    pub label: String,
    pub active_document_id: Option<String>,
    pub native_session_id: Option<String>,
    pub views: Vec<ApplicationView>,
    pub selected_object: Option<ApplicationObjectSelection>,
    pub selected_package: Option<ApplicationPackageSelection>,
    pub selected_plot: Option<ApplicationPlotSelection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationWindowSummary {
    pub window: ApplicationWindowRef,
    pub label: String,
    pub online: bool,
    pub renewed_at_ms: u64,
    pub lease_expires_at_ms: u64,
    pub synced_at_ms: Option<u64>,
    pub context_version: String,
    pub document_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationWindowsArguments {
    pub after_window_id: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationWindows {
    pub windows: Vec<ApplicationWindowSummary>,
    pub next_after_window_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationContextArguments {
    pub window: ApplicationWindowRef,
    #[serde(default)]
    pub allow_offline: bool,
    pub after_document_id: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationContext {
    pub window: ApplicationWindowSummary,
    /// "live_bridge" or "synced_history"; neither is a scientific snapshot.
    pub source: String,
    pub context: ApplicationContextState,
    pub current_document: Option<ApplicationDocumentSummary>,
    pub documents: Vec<ApplicationDocumentSummary>,
    pub next_after_document_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationReadDocumentArguments {
    pub window: ApplicationWindowRef,
    pub document: ApplicationDocumentRef,
    pub expected_sha256: String,
    #[serde(default)]
    pub content: ApplicationDocumentContent,
    #[serde(default)]
    pub offset_utf8: usize,
    pub limit_bytes: Option<usize>,
    #[serde(default)]
    pub allow_offline: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationDocumentPage {
    pub window: ApplicationWindowRef,
    pub document: ApplicationDocumentSummary,
    pub source: String,
    pub content: ApplicationDocumentContent,
    pub content_sha256: String,
    pub text: String,
    pub offset_utf8: usize,
    pub next_offset_utf8: Option<usize>,
    pub synced_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationDocumentContent {
    #[default]
    Draft,
    Base,
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
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApplicationAction {
    OpenView {
        view_type: ApplicationViewType,
        view_id: Option<String>,
        expected_context_version: String,
    },
    ActivateView {
        view_id: String,
        expected_context_version: String,
    },
    CloseView {
        view_id: String,
        expected_context_version: String,
    },
    OpenDocument {
        path: String,
        expected_context_version: String,
    },
    CreateDocument {
        path: Option<String>,
        text: String,
        expected_context_version: String,
    },
    SetSelection {
        document: ApplicationDocumentRef,
        anchor: u32,
        head: u32,
    },
    EditDocument {
        document: ApplicationDocumentRef,
        edits: Vec<ApplicationTextEdit>,
    },
    SelectObject {
        selection: ApplicationObjectSelection,
        expected_context_version: String,
    },
    SelectPackage {
        selection: ApplicationPackageSelection,
        expected_context_version: String,
    },
    SelectPlot {
        selection: ApplicationPlotSelection,
        expected_context_version: String,
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
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationCommandRequest {
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub action: ApplicationAction,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationCommandStatusArguments {
    pub window: ApplicationWindowRef,
    pub request_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationCommandState {
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
pub enum ApplicationExecutionStep {
    Save,
    Run,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationDocumentUpdate {
    pub expected_version: Option<String>,
    pub expected_selection_version: Option<String>,
    pub document: ApplicationDocument,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationContextUpdate {
    pub expected_version: String,
    pub context: ApplicationContextState,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationChanges {
    pub context: Option<ApplicationContextUpdate>,
    #[serde(default)]
    pub documents: Vec<ApplicationDocumentUpdate>,
    #[serde(default)]
    pub removed_documents: Vec<ApplicationDocumentRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationSyncReceipt {
    pub sync_id: String,
    pub synced_at_ms: u64,
    pub context_version: String,
    pub document_versions: Vec<ApplicationDocumentRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationLocalOutcome {
    Applied,
    Rejected,
    LocallyAppliedUnsynced,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationCommandCompletion {
    pub request_id: String,
    pub claim_id: String,
    pub outcome: ApplicationLocalOutcome,
    pub changes: ApplicationChanges,
    pub diagnostic: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationCommandGrant {
    pub request: ApplicationCommandRequest,
    pub claim_id: String,
    pub capture: Option<ApplicationCaptureSummary>,
    /// Bound to this exact request, window incarnation, capture and original actor.
    pub execution_ref: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationBridgeRegistration {
    pub session: ApplicationBridgeSession,
    pub context: ApplicationContextState,
    pub documents: Vec<ApplicationDocumentSummary>,
    pub heartbeat_interval_ms: u64,
    pub offline_after_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApplicationBridgeRequest {
    Register {
        window_id: String,
        incarnation: String,
        label: String,
        previous_session: Option<ApplicationBridgeSession>,
    },
    Renew {
        session: ApplicationBridgeSession,
    },
    Sync {
        session: ApplicationBridgeSession,
        sync_id: String,
        changes: ApplicationChanges,
    },
    Claim {
        session: ApplicationBridgeSession,
        claim_request_id: String,
    },
    Complete {
        session: ApplicationBridgeSession,
        completion: ApplicationCommandCompletion,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ApplicationBridgeReply {
    Registered(ApplicationBridgeRegistration),
    Renewed(ApplicationWindowSummary),
    Synced(ApplicationSyncReceipt),
    Claimed(Option<ApplicationCommandGrant>),
    Completed(ApplicationCommandReceipt),
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationExecuteRequest {
    pub session: ApplicationBridgeSession,
    pub request_id: String,
    pub execution_ref: String,
    pub step: ApplicationExecutionStep,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ApplicationExecuteReply {
    pub receipt: ApplicationCommandReceipt,
    pub operation: Option<OperationRecord>,
}

/// Application metadata records declarations, not proof of following a method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationMethodResource {
    pub resource_ref: String,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationMethodBinding {
    pub binding_id: String,
    pub version: String,
    pub working_directory: String,
    pub external_goal_ref: Option<String>,
    pub external_task_ref: Option<String>,
    pub external_actor_ref: Option<String>,
    pub skill_ref: String,
    pub source_ref: String,
    pub resources: Vec<ApplicationMethodResource>,
    pub modules: Vec<String>,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub required_capabilities: Vec<crate::CapabilityRef>,
    pub target: Option<crate::TargetRef>,
    pub excluded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ApplicationSkillReadReceipt {
    pub working_directory: String,
    pub skill_ref: String,
    pub source_ref: String,
    pub resource_ref: String,
    pub sha256: String,
    pub external_task_ref: Option<String>,
    pub observed_at_ms: u64,
}
