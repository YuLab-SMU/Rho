//! Current Host Agent admission requests. Public transport DTOs are owned by the plugin.
use crate::AgentProvider;
use serde::Deserialize;
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SetupAgent {
    pub project_root: String,
    pub provider: AgentProvider,
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
