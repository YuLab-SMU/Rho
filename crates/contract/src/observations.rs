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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub struct MediaReference {
    pub operation_id: OperationId,
    pub sequence: u64,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub display_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputEvent {
    pub operation_id: OperationId,
    pub sequence: u64,
    pub kind: String,
    pub text: Option<String>,
    pub media: Option<MediaReference>,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputEvents {
    pub operation_id: OperationId,
    pub events: Vec<OutputEvent>,
    pub next_sequence: u64,
    pub has_more: bool,
    pub truncated: bool,
    pub gap: bool,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OutputEventsArguments {
    pub operation_id: OperationId,
    #[serde(default)]
    pub after_sequence: u64,
    #[serde(default = "event_limit")]
    pub limit: u32,
}
fn event_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadOutputArguments {
    pub reference: MediaReference,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "output_limit")]
    pub limit_bytes: u32,
}
fn output_limit() -> u32 {
    65536
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputPage {
    pub reference: MediaReference,
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub has_more: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ProcessObservation {
    pub pid: u32,
    pub role: String,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct RuntimeStatus {
    pub session_id: String,
    pub state: String,
    pub observed_at_ms: i64,
    pub processes: Vec<ProcessObservation>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MediaSummary {
    pub reference: MediaReference,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MediaPage {
    pub operation_id: OperationId,
    pub media: Vec<MediaSummary>,
    pub next_sequence: u64,
    pub has_more: bool,
    pub gap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SearchFilesArguments {
    #[serde(default)]
    pub continuation: Option<crate::SearchFilesCursor>,
    pub text: String,
    #[serde(default)]
    pub show_hidden: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct FileSearchResult {
    pub continuation: Option<crate::SearchFilesCursor>,
    pub entries: Vec<crate::DirectoryEntry>,
    pub scanned_entries: u32,
    pub scanned_directories: u32,
    pub truncated: bool,
    pub notices: Vec<String>,
}
