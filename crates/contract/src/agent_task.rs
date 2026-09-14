//! Persistent application tasks and bounded native observations. Not scientific truth.
use crate::{AgentDecision, AgentModel, AgentProvider, ApplicationWindowRef};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentPermissionMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct AgentNativeCapabilities {
    pub resume: bool,
    pub history: String,
    pub images: bool,
    pub embedded_context: bool,
    pub modes: Vec<AgentPermissionMode>,
    pub current_mode: Option<String>,
    pub models: Vec<AgentModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTask {
    pub task_id: String,
    pub project_root: String,
    pub provider: AgentProvider,
    pub native_session_id: Option<String>,
    pub title: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub archived: bool,
    pub model: String,
    pub effort: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentAttachment {
    pub generation: u64,
    pub controller: ApplicationWindowRef,
    pub connection_id: Option<String>,
    pub state: String,
    pub capabilities: AgentNativeCapabilities,
    pub decisions: Vec<AgentDecision>,
    pub error: Option<String>,
    pub control_frozen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentContextSelection {
    pub source: String,
    pub label: String,
    /// Owner-specific reference/observation, validated by the registered source.
    pub reference: serde_json::Value,
    pub inclusion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentContextSource {
    pub id: String,
    pub name: String,
    pub plugin: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentContextItem {
    pub title: String,
    pub description: String,
    pub kind: String,
    pub selection: AgentContextSelection,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentContextPreview {
    pub selection: AgentContextSelection,
    pub title: String,
    pub description: String,
    pub text: String,
    pub native_data: serde_json::Value,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub image_base64: Option<String>,
    pub image_mime_type: Option<String>,
    pub inclusions: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentAsset {
    pub asset_id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentDraftContent {
    pub text: String,
    #[serde(default)]
    pub assets: Vec<String>,
    #[serde(default)]
    pub context: Vec<AgentContextSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTaskDraft {
    pub version: u64,
    pub content: AgentDraftContent,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentCommandReceipt {
    pub request_id: String,
    pub task_id: String,
    pub command: String,
    pub input_digest: String,
    pub request_digest: String,
    pub input_assets: Vec<String>,
    pub input_context: Vec<AgentContextSelection>,
    /// Recovery material retained until native completion is confirmed.
    pub submitted_draft: Option<AgentDraftContent>,
    pub status: String,
    pub native_session_id: Option<String>,
    pub native_turn_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub error: Option<String>,
    pub submitted_draft_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTaskEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage: Option<crate::AgentUsageObservation>,
    pub sequence: u64,
    pub event_id: String,
    pub request_id: Option<String>,
    pub generation: u64,
    pub native_session_id: String,
    pub native_turn_id: Option<String>,
    pub native_item_id: Option<String>,
    pub kind: String,
    pub role: Option<String>,
    pub text: String,
    pub status: Option<String>,
    /// native_history or observation; never re-sent as model memory.
    pub source: String,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTaskSummary {
    /// Orders this task's application observations, not scientific state.
    pub observation_version: u64,
    pub history_generation: u64,
    pub task: AgentTask,
    pub attachment: AgentAttachment,
    pub draft_version: u64,
    pub has_draft: bool,
    pub event_cursor: u64,
    pub history_gap: bool,
    pub unconfirmed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTaskDetail {
    pub summary: AgentTaskSummary,
    pub draft: AgentTaskDraft,
    pub assets: Vec<AgentAsset>,
    pub receipts: Vec<AgentCommandReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTaskEventPage {
    pub task_id: String,
    pub history_generation: u64,
    pub events: Vec<AgentTaskEvent>,
    pub next_cursor: u64,
    pub has_more: bool,
    pub history_gap: bool,
    pub oldest_cursor: u64,
    pub durable_cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentNativeHistoryPage {
    pub task_id: String,
    pub events: Vec<AgentTaskEvent>,
    pub next_cursor: Option<String>,
    pub source: String,
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentTasksQuery {
    pub project_root: String,
    pub query: AgentTaskQuery,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTaskQuery {
    ScientificWork { task_id: String, limit: u32 },
    ProjectList {
        archived: Option<bool>,
        before: Option<String>,
        limit: u32,
    },
    ContextSources,
    ContextSearch {
        window: ApplicationWindowRef,
        source: Option<String>,
        text: String,
        limit: u32,
    },
    ContextPreview {
        window: ApplicationWindowRef,
        selection: AgentContextSelection,
    },
    NativeHistory {
        task_id: String,
        cursor: Option<String>,
        limit: u32,
    },
    List {
        archived: Option<bool>,
        before: Option<String>,
        limit: u32,
    },
    Get {
        task_id: String,
    },
    Events {
        task_id: String,
        after: Option<u64>,
        before: Option<u64>,
        limit: u32,
    },
    Receipt {
        request_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentTaskQueryResult {
    ScientificWork { work: crate::AgentScientificWork },
    ProjectList { page: crate::ProjectAgentTaskPage },
    ContextSources {
        sources: Vec<AgentContextSource>,
    },
    ContextItems {
        items: Vec<AgentContextItem>,
        notices: Vec<String>,
    },
    ContextPreview {
        preview: AgentContextPreview,
    },
    NativeHistory {
        page: AgentNativeHistoryPage,
    },
    List {
        tasks: Vec<AgentTaskSummary>,
        attention: Vec<AgentTaskSummary>,
        next: Option<String>,
        running: u32,
        permissions: u32,
    },
    Detail {
        detail: Box<AgentTaskDetail>,
    },
    Events {
        page: AgentTaskEventPage,
    },
    Receipt {
        receipt: Option<AgentCommandReceipt>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentTasksCommand {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub command: AgentTaskCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentTaskControl {
    pub task_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTaskCommand {
    Create {
        provider: AgentProvider,
        model: String,
        effort: Option<String>,
    },
    SaveDraft {
        control: AgentTaskControl,
        version: u64,
        content: AgentDraftContent,
    },
    Rename {
        control: AgentTaskControl,
        title: String,
    },
    Archive {
        control: AgentTaskControl,
        archived: bool,
    },
    Connect {
        control: AgentTaskControl,
    },
    Resume {
        control: AgentTaskControl,
    },
    Disconnect {
        control: AgentTaskControl,
    },
    TakeOver {
        control: AgentTaskControl,
        stop: bool,
    },
    Send {
        control: AgentTaskControl,
        draft_version: u64,
    },
    Configure {
        control: AgentTaskControl,
        model: String,
        effort: Option<String>,
        mode: Option<String>,
    },
    Stop {
        control: AgentTaskControl,
    },
    Decision {
        control: AgentTaskControl,
        decision_id: u64,
        option_id: String,
    },
    AddAsset {
        control: AgentTaskControl,
        name: String,
        mime_type: String,
        data: String,
    },
    RemoveAsset {
        control: AgentTaskControl,
        asset_id: String,
        draft_version: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentTaskCommandResult {
    pub receipt: AgentCommandReceipt,
    pub detail: AgentTaskDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TestAgent {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub provider: AgentProvider,
    pub model: String,
    pub effort: Option<String>,
    #[serde(default)]
    pub observe_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentDiagnostic {
    pub request_id: String,
    pub provider: AgentProvider,
    pub model: String,
    pub state: String,
    pub elapsed_ms: Option<u64>,
    pub response: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadAgentAsset {
    pub project_root: String,
    pub task_id: String,
    pub asset_id: String,
}
