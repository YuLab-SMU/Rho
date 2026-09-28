#![forbid(unsafe_code)]
//! Public Agent transport observations and task contracts. These values confer no scientific or
//! application authority. Native missing observations remain unknown.
mod tasks;
pub use tasks::*;
mod project_tasks;
pub use project_tasks::*;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Correlation identity supplied by the Agent owner after admission. This value
/// is not an authorization credential and cannot grant access to a Host window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentControllerRef {
    pub window_id: String,
    pub incarnation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    Codex,
    Kimi,
    Deepseek,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentModel {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct LocalAgent {
    pub provider: AgentProvider,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub models: Vec<AgentModel>,
    pub selected_model: Option<String>,
    pub selected_effort: Option<String>,
    pub discovery_ms: u64,
    pub error: Option<String>,
    pub setup_required: bool,
    pub capabilities: AgentNativeCapabilities,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentDecisionOption {
    pub id: String,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentDecision {
    pub id: u64,
    pub title: String,
    pub details: String,
    pub options: Vec<AgentDecisionOption>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentMessage {
    pub role: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentClientSession {
    pub id: String,
    pub provider: AgentProvider,
    pub native_session_id: String,
    pub project_root: String,
    pub window: AgentControllerRef,
    pub model: String,
    pub effort: Option<String>,
    pub state: String,
    pub messages: Vec<AgentMessage>,
    pub activity: Vec<String>,
    pub decisions: Vec<AgentDecision>,
    pub error: Option<String>,
    pub truncated: bool,
    pub elapsed_ms: Option<u64>,
    pub last_request_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentPermissionMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentNativeCapabilities {
    pub resume: bool,
    pub history: String,
    pub images: bool,
    pub embedded_context: bool,
    pub modes: Vec<AgentPermissionMode>,
    pub current_mode: Option<String>,
    pub models: Vec<AgentModel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct AgentUsageObservation {
    pub source: String,
    /// session_total, turn_total, or context_window. Totals replace, never add.
    pub scope: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub context_used: Option<u64>,
    pub context_capacity: Option<u64>,
}

mod model;
pub use model::*;
