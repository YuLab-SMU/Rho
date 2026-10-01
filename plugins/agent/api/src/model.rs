//! Public model configuration and captured Agent execution input.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
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

/// Approval policy is independent of the work selected by the Agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentPermissionPolicy {
    Ask,
    AutoApproval,
    FullAccess,
}

/// The executing Agent interprets the user's request; no review model is called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentTaskAuthorization {
    UserRequest,
    Additional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentRequestedAction {
    Create,
    Edit,
    Save,
    Execute,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentIntentAction {
    pub action: ComponentRequestedAction,
    /// None denotes execution in the run's already bound R session.
    pub document_id: Option<String>,
    /// An exact project-relative destination, including a not-yet-created file.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentAgentTaskIntent {
    pub request_id: String,
    pub request_excerpt: String,
    pub actions: Vec<ComponentIntentAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentModelProtocol {
    Anthropic,
    OpenaiCompletions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ComponentCredentialRef {
    Environment {
        name: String,
    },
    /// Retained references from Hosts that used memory-only credentials.
    Session {
        key_id: String,
    },
    /// Immutable version in the user-local Rho configuration file.
    LocalFile {
        key_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentModelConnection {
    pub protocol: ComponentModelProtocol,
    pub base_url: String,
    pub model: String,
    pub credential: ComponentCredentialRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComponentModelSettings {
    pub version: u64,
    pub enabled: bool,
    pub connection: Option<ComponentModelConnection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentAgentBudget {
    pub model_calls: u32,
    pub tool_calls: u32,
    pub context_bytes: u32,
    pub tool_result_bytes: u32,
    pub output_tokens: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentCredentialStatus {
    pub credential: Option<ComponentCredentialRef>,
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentModelTestKind {
    Connection,
    Images,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ComponentModelTestState {
    Queued,
    Running,
    Passed,
    Failed,
    Interrupted,
}

/// Data captured by the task owner before entering a model engine. No live owner
/// record, tool credentials or scientific operation flow is exposed to the engine.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentModelRun {
    pub run_id: String,
    pub profile: ComponentAgentProfile,
    pub model: ComponentModelConnection,
    pub budget: ComponentAgentBudget,
    pub created_at_ms: u64,
    pub text: String,
    pub permission_policy: Option<ComponentPermissionPolicy>,
    pub task_intent: Option<ComponentAgentTaskIntent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ComponentToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}
