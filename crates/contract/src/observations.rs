pub use rho_r_api::observations::*;
use crate::{CapabilityRef, OperationId, OperationStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OperationSummary {
    pub cursor: u64,
    pub operation_id: OperationId,
    pub client_request_id: String,
    pub capability: CapabilityRef,
    pub status: OperationStatus,
    pub accepted_at_ms: i64,
    pub updated_at_ms: i64,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct RecentOperations {
    pub operations: Vec<OperationSummary>,
    pub next_cursor: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RecentOperationsArguments {
    pub before_cursor: Option<u64>,
    pub client_request_id: Option<String>,
    pub operation_id: Option<OperationId>,
    #[serde(default = "recent_limit")]
    pub limit: u32,
}
fn recent_limit() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OperationEventsCheckpointArguments {}

/// An event position within the visible journal, not a scientific state version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct OperationEventsCheckpoint {
    pub sequence: u64,
}

pub use rho_files_api::directory::*;
