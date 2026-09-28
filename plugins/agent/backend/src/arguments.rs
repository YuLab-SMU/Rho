//! Inputs deliberately omit project, principal, controller, paths and credentials.
//! These are supplied by native initialization and the original calling view.
use rho_agent_api::{AgentDraftContent, ComponentAgentProfile, component::ComponentAgentGrant};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskList {
    pub archived: Option<bool>,
    #[schemars(length(max = 512))]
    pub before: Option<String>,
    #[schemars(range(min = 1, max = 20))]
    pub limit: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Conversation {
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateConversation {
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    pub profile: ComponentAgentProfile,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveDraft {
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    pub draft_version: u64,
    pub content: AgentDraftContent,
    pub grant: Option<ComponentAgentGrant>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateConversation {
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    pub expected_version: u64,
    #[schemars(length(min = 1, max = 160))]
    pub title: Option<String>,
    pub archived: Option<bool>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TakeControl {
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    pub expected_version: u64,
}
