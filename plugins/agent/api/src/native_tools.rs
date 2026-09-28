//! Captured native Host and ordinary-plugin tools. These records describe original work and do
//! not grant authority to dispatch it again after a connection or process loss.
use crate::{AgentNativeToolRequest, AgentNativeToolTarget};
use rho_plugin_protocol::{OperationId, RequestId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentNativeToolSelection {
    pub name: String,
    pub target: AgentNativeToolTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentNativeToolKind {
    Query,
    Operation,
}

/// Descriptions, schemas and scopes are captured from the selected immutable
/// plugin manifest or native Host contract, never supplied by model tool arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentNativeToolGrant {
    pub selection: AgentNativeToolSelection,
    pub kind: AgentNativeToolKind,
    pub description: String,
    pub input_schema: Value,
    pub required_scopes: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentNativeToolInvocation {
    /// Explicit original Send identity prevents a stale native tool call from
    /// becoming new work merely because the same connection has another turn.
    pub send_request: String,
    pub tool_request: String,
    pub tool: String,
    pub arguments: Value,
    #[serde(default)]
    pub preconditions: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentNativeToolPhase {
    Prepared,
    Resolved,
    Uncertain,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentNativeToolReceipt {
    pub task_id: String,
    pub invocation: AgentNativeToolInvocation,
    pub request: RequestId,
    pub native_request: AgentNativeToolRequest,
    pub kind: AgentNativeToolKind,
    pub phase: AgentNativeToolPhase,
    pub operation: Option<OperationId>,
    pub result: Option<Value>,
    pub failed: bool,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
