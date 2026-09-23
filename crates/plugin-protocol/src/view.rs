//! Isolated view lifecycle and the public browser channel. State belongs to one
//! exact source revision; closing a view never requests backend cancellation.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OpenPluginView {
    pub instance: InstanceRef,
    pub contribution: ContributionId,
    pub window: WindowId,
    pub configuration: Value,
    pub state: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewArguments {
    pub view: ViewInstanceId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdatePluginView {
    pub view: ViewInstanceId,
    /// An owner-specific state version, never a global scientific revision.
    pub expected_version: u32,
    pub state: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewRecord {
    pub view: ViewInstanceId,
    pub instance: InstanceRef,
    pub project: ProjectId,
    pub principal: PrincipalId,
    pub contribution: ContributionId,
    pub window: WindowId,
    pub configuration: Value,
    pub state: Value,
    pub state_version: u32,
    pub closed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewConnection {
    pub view: PluginViewRecord,
    pub connection: ConnectionId,
    pub next_sequence: u32,
    /// Short-lived asset authority for this view's exact immutable artifact only.
    pub asset_token: String,
    /// Retained by the containing shell. Never sent to the iframe or stored in
    /// Operation records, scenarios, view state or source packages.
    pub call_token: String,
    pub entrypoint: PackagePath,
    pub grants: Vec<CapabilityRequirement>,
}

/// Every request crosses the containing shell's scoped Host port. No browser
/// credential, project root or user identity is accepted from the iframe.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginViewRequest {
    Query {
        capability: CapabilityKey,
        arguments: Value,
    },
    Invoke {
        request_id: RequestId,
        capability: CapabilityKey,
        arguments: Value,
        preconditions: Vec<Value>,
    },
    GetOperation {
        operation_id: String,
    },
    Cancel {
        operation_id: String,
    },
    SetState {
        expected_version: u32,
        state: Value,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewMessage {
    pub protocol_version: u32,
    pub connection: ConnectionId,
    pub view: ViewInstanceId,
    pub sequence: u32,
    pub request: RequestId,
    pub body: PluginViewRequest,
}
