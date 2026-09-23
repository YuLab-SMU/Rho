use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use crate::OperationId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RunSource {
    pub view_id: String,
    pub label: String,
    pub kind: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct QueuedRun {
    pub operation_id: OperationId,
    pub source: Option<RunSource>,
    pub summary: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct QueuePause {
    pub id: String,
    pub operation_id: Option<OperationId>,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct ConsoleState {
    pub session_id: String,
    pub current: Option<QueuedRun>,
    pub pending: Vec<QueuedRun>,
    pub pause: Option<QueuePause>,
    pub input: Option<InputRequest>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct InputRequest {
    pub session_id: String,
    pub operation_id: OperationId,
    pub request_id: String,
    pub prompt: String,
    pub password: bool,
    pub submitted: bool,
}
// Deliberately not Debug: the answer must never become a diagnostic or journal value.
#[derive(Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RespondInput {
    pub session_id: String,
    pub operation_id: OperationId,
    pub request_id: String,
    pub reply_id: String,
    pub value: String,
}
impl std::fmt::Debug for RespondInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RespondInput [redacted]")
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CheckCodeArguments {
    pub code: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
pub struct CodeCompleteness {
    pub status: String,
    pub indent: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct QueueControlArguments {
    pub session_id: String,
    pub pause_id: Option<String>,
    /// Optional atomic resume fence: the failed pause and every queued/current run
    /// must belong to this explicit set. It cannot authorize resuming hidden work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub only_operation_ids: Option<Vec<OperationId>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RunROutputMode {
    Console,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct RunRArguments {
    #[schemars(length(min = 1))]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<RunROutputMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<RunSource>,
}
