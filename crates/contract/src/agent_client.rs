//! External Agent transport state, not scientific operations or model decisions.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    Codex,
    Kimi,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentModel {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LocalAgent {
    pub provider: AgentProvider,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub models: Vec<AgentModel>,
    pub selected_model: Option<String>,
    pub selected_effort: Option<String>,
    pub discovery_ms: u64,
    pub error: Option<String>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct DiscoverAgent {
    pub project_root: String,
    pub provider: AgentProvider,
    pub model: Option<String>,
}
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct ConnectAgent {
    pub request_id: String,
    pub project_root: String,
    pub window: crate::ApplicationWindowRef,
    pub provider: AgentProvider,
    pub model: String,
    pub effort: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentDecisionOption {
    pub id: String,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentDecision {
    pub id: u64,
    pub title: String,
    pub details: String,
    pub options: Vec<AgentDecisionOption>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentMessage {
    pub role: String,
    pub text: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentClientSession {
    pub id: String,
    pub provider: AgentProvider,
    pub native_session_id: String,
    pub project_root: String,
    pub window: crate::ApplicationWindowRef,
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
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentClientAction {
    pub project_root: String,
    pub session_id: String,
    pub window: crate::ApplicationWindowRef,
    pub action: AgentAction,
}
#[derive(Debug, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentAction {
    Read,
    Prompt { text: String, request_id: String },
    Test { request_id: String },
    Interrupt,
    Decision { id: u64, option: String },
    Disconnect,
}
