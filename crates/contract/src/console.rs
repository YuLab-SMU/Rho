use crate::{Invocation, OperationId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
pub struct InvokeRequest {
    #[serde(flatten)]
    pub invocation: Invocation,
    #[serde(default)]
    #[ts(optional)]
    pub return_after_acceptance: Option<bool>,
}
impl From<Invocation> for InvokeRequest {
    fn from(invocation: Invocation) -> Self {
        Self {
            invocation,
            return_after_acceptance: None,
        }
    }
}
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
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct RunRArguments {
    #[schemars(length(min = 1))]
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<RunSource>,
}

#[derive(Debug, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CancelOperation {
    pub operation_id: OperationId,
    #[serde(default)]
    #[ts(optional)]
    pub only_if_pending: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CancellationRequestOutcome {
    /// Acceptance of the request is not confirmation that native work stopped.
    pub accepted: bool,
    pub operation: crate::OperationRecord,
}
