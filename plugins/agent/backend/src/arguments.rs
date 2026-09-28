//! Inputs omit caller identities and paths. Plaintext key input belongs only to
//! the ephemeral Control, never an Operation, configuration or task record.
use rho_agent_api::{AgentDraftContent, ComponentAgentProfile, component::ComponentAgentGrant};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CredentialRequest {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
}

// Deliberately no Debug: diagnostics must not expose credential material.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StoreCredential {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
    #[schemars(length(min = 1, max = 16384))]
    pub value: String,
}

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
