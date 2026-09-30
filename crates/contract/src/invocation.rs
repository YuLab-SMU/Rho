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
