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
pub struct CredentialStatus {
    pub settings_version: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoveCredential {
    pub settings_version: u64,
    #[schemars(length(min = 1, max = 160))]
    pub key_id: String,
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

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TestModel {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
    pub model_settings_version: u64,
    pub kind: rho_agent_api::ComponentModelTestKind,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelDiagnostic {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StopModelDiagnostic {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
    pub expected_version: u64,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    Explain,
    Run,
}
impl From<RunMode> for rho_agent_api::component::ComponentAgentMode {
    fn from(mode: RunMode) -> Self {
        match mode {
            RunMode::Explain => Self::Explain,
            RunMode::Run => Self::Run,
        }
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunModel {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    pub conversation_version: u64,
    pub model_settings_version: u64,
    #[schemars(length(min = 1, max = 32768))]
    pub text: String,
    /// Optional exact R provider/session selection, supplied by the caller.
    /// Explain is read-only; Run authorizes execution in this selected session.
    #[serde(default)]
    pub r: Option<rho_plugin_sdk::protocol::ProviderBinding>,
    #[serde(default)]
    pub mode: Option<RunMode>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelRun {
    #[schemars(length(min = 1, max = 160))]
    pub run_id: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelEvents {
    #[schemars(length(min = 1, max = 160))]
    pub run_id: String,
    pub after: u64,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelHistory {
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    #[schemars(length(min = 1, max = 160))]
    pub before: Option<String>,
    #[schemars(range(min = 1, max = 20))]
    pub limit: u32,
}

#[derive(Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelHistoryPage {
    pub conversation_id: String,
    pub runs: Vec<rho_agent_api::component::ComponentAgentRunSummary>,
    pub next: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelTool {
    #[schemars(length(min = 1, max = 160))]
    pub run_id: String,
    #[schemars(length(min = 1, max = 160))]
    pub receipt_id: String,
}

/// Read-only projection of the original admission; no caller can supply it.
#[derive(Serialize, JsonSchema)]
pub struct ModelAdmission {
    pub operation: rho_plugin_sdk::protocol::OperationId,
    pub request: rho_plugin_sdk::protocol::RequestId,
    pub binding: rho_plugin_sdk::protocol::ProviderBinding,
    pub r: Option<rho_plugin_sdk::protocol::ProviderBinding>,
}
