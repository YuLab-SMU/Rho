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
pub struct AgentConfiguration {
    /// Existing Kimi Code state directory, used for discovery, new sessions and
    /// exact-project resume. Contains a path only; credentials stay native.
    #[serde(default)]
    #[schemars(length(min = 1, max = 4096))]
    pub kimi_home: Option<String>,
}
impl AgentConfiguration {
    pub fn native_options(&self) -> Result<rho_agent_client::NativeAgentOptions, String> {
        let kimi_home = self
            .kimi_home
            .as_ref()
            .map(|value| -> Result<std::path::PathBuf, String> {
                let path = std::path::Path::new(value);
                if value.len() > 4096 || !path.is_absolute() || !path.is_dir() {
                    return Err(
                        "Agent kimi_home must name an existing absolute native directory".into(),
                    );
                }
                path.canonicalize()
                    .map_err(|_| "Agent kimi_home is unavailable".into())
            })
            .transpose()?;
        Ok(rho_agent_client::NativeAgentOptions { kimi_home })
    }
}

#[cfg(test)]
mod configuration_tests {
    use super::*;
    #[test]
    fn native_configuration_accepts_only_an_existing_absolute_directory() {
        let parse = |value| serde_json::from_value::<AgentConfiguration>(value);
        assert!(
            parse(serde_json::json!({}))
                .unwrap()
                .native_options()
                .unwrap()
                .kimi_home
                .is_none()
        );
        assert!(parse(serde_json::json!({"environment":{"API_KEY":"not-a-path"}})).is_err());
        assert!(
            parse(serde_json::json!({"kimi_home":"relative"}))
                .unwrap()
                .native_options()
                .is_err()
        );
        let dir = tempfile::tempdir().unwrap();
        let config = parse(serde_json::json!({"kimi_home":dir.path()})).unwrap();
        assert_eq!(
            config.native_options().unwrap().kimi_home.unwrap(),
            dir.path().canonicalize().unwrap()
        );
        let file = dir.path().join("file");
        std::fs::write(&file, "native config stays here").unwrap();
        assert!(
            parse(serde_json::json!({"kimi_home":file}))
                .unwrap()
                .native_options()
                .is_err()
        );
    }
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CredentialRequest {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HandoffSource {
    pub source: rho_agent_api::ProjectAgentTaskRef,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HandoffTarget {
    pub target: rho_agent_api::ProjectAgentTaskRef,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AppendHandoff {
    #[schemars(length(min = 1, max = 160))]
    pub request_id: String,
    pub source: rho_agent_api::ProjectAgentTaskRef,
    #[schemars(length(min = 1, max = 160))]
    pub source_revision: String,
    pub target: rho_agent_api::ProjectAgentTaskRef,
    pub target_draft_version: u64,
    pub target_control_generation: Option<u64>,
    #[schemars(length(min = 1, max = 16384))]
    pub body: String,
    #[schemars(length(max = 16))]
    pub context: Vec<rho_agent_api::AgentContextSelection>,
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
    #[schemars(length(max = 32768))]
    pub text: String,
    /// Exact user-selected contributed references. Resolved before admission;
    /// retained content is reused for every observation of the original request.
    #[serde(default)]
    #[schemars(length(max = 16))]
    pub sources: Vec<rho_agent_api::AgentContextSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 16))]
    pub assets: Option<Vec<String>>,
    #[serde(default)]
    pub continuation: Option<rho_agent_api::component::ComponentContinuation>,
    /// Optional exact R provider/session selection, supplied by the caller.
    /// Explain is read-only; Run authorizes execution in this selected session.
    #[serde(default)]
    pub r: Option<rho_plugin_sdk::protocol::ProviderBinding>,
    #[serde(default)]
    pub mode: Option<RunMode>,
    /// Exact configured workspace tools, captured from installed manifests at Send.
    #[serde(default)]
    #[schemars(length(max = 16))]
    pub tools: Vec<rho_agent_api::AgentNativeToolSelection>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelRun {
    #[schemars(length(min = 1, max = 160))]
    pub run_id: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelReconcile {
    #[schemars(length(min = 1, max = 160))]
    pub run_id: String,
    pub conversation_version: u64,
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
    pub tools: Vec<rho_agent_api::AgentNativeToolSelection>,
    pub operation: rho_plugin_sdk::protocol::OperationId,
    pub request: rho_plugin_sdk::protocol::RequestId,
    pub binding: rho_plugin_sdk::protocol::ProviderBinding,
    pub r: Option<rho_plugin_sdk::protocol::ProviderBinding>,
}
