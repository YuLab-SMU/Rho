//! Native task inputs contain no caller identity, project path or attachment bytes.
//! The ordinary backend supplies the authenticated caller and original Operation.
use rho_agent_api::{
    AgentDraftContent, AgentNativeToolSelection, AgentProvider, AgentTaskCommand, AgentTaskControl,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// Keep one declaration for the no-binary wire variants and their exact conversion
// into the existing owner's commands. AddAsset belongs to ephemeral Control only.
macro_rules! native_commands {
    ($($variant:ident { $($field:ident: $ty:ty),* $(,)? }),* $(,)?) => {
        #[derive(Clone, Serialize, Deserialize, JsonSchema)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        pub enum NativeCommand { $($variant { $($field: $ty),* }),* }
        impl From<NativeCommand> for AgentTaskCommand {
            fn from(command: NativeCommand) -> Self {
                match command {
                    $(NativeCommand::$variant { $($field),* } => Self::$variant { $($field),* }),*
                }
            }
        }
    };
}
native_commands! {
    Create { provider: AgentProvider, model: String, effort: Option<String> },
    SaveDraft { control: AgentTaskControl, version: u64, content: AgentDraftContent },
    Rename { control: AgentTaskControl, title: String },
    Archive { control: AgentTaskControl, archived: bool },
    Connect { control: AgentTaskControl },
    Resume { control: AgentTaskControl },
    Disconnect { control: AgentTaskControl },
    TakeOver { control: AgentTaskControl, stop: bool },
    Send { control: AgentTaskControl, draft_version: u64 },
    Configure { control: AgentTaskControl, model: String, effort: Option<String>, mode: Option<String> },
    Stop { control: AgentTaskControl },
    Decision { control: AgentTaskControl, decision_id: u64, option_id: String },
    RemoveAsset { control: AgentTaskControl, asset_id: String, draft_version: u64 },
}
/// Explicit discovery may start a short-lived local CLI, but never a model turn.
/// The native instance supplies the project directory; callers cannot select it.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DiscoverNative {
    pub provider: AgentProvider,
    #[schemars(length(min = 1, max = 512))]
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AgentViewConfiguration {
    /// Offered exact tools, selected explicitly in the composer before Send.
    #[serde(default)]
    #[schemars(length(max = 16))]
    pub tools: Vec<AgentNativeToolSelection>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeAction {
    #[schemars(length(min = 36, max = 36))]
    pub request_id: String,
    pub command: NativeCommand,
    /// Only Send accepts explicit tool selections. Descriptors and scopes are
    /// captured from exact plugin manifests or native Host contracts by the backend.
    #[serde(default)]
    #[schemars(length(max = 16))]
    pub tools: Vec<AgentNativeToolSelection>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeTask {
    #[schemars(length(min = 1, max = 160))]
    pub task_id: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeReceipt {
    #[schemars(length(min = 36, max = 36))]
    pub request_id: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeToolReceipt {
    #[schemars(length(min = 36, max = 36))]
    pub send_request: String,
    #[schemars(length(min = 36, max = 36))]
    pub tool_request: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeEvents {
    #[schemars(length(min = 1, max = 160))]
    pub task_id: String,
    pub after: Option<u64>,
    pub before: Option<u64>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeHistory {
    #[schemars(length(min = 1, max = 160))]
    pub task_id: String,
    #[schemars(length(max = 4096))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}
/// This input must be contributed exclusively as Control, never an Operation.
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NativeUpload {
    #[schemars(length(min = 36, max = 36))]
    pub request_id: String,
    pub control: AgentTaskControl,
    #[schemars(length(min = 1, max = 240))]
    pub name: String,
    #[schemars(length(min = 1, max = 128))]
    pub mime_type: String,
    // A bounded single-frame upload only. Full 8 MiB assets need the existing
    // controlled resource channel; do not raise the RPC control frame limit.
    #[schemars(length(max = 524288))]
    pub data: String,
}
