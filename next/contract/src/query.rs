use crate::{CapabilityRef, ContractError, MAX_ARGUMENT_BYTES, ObservationCompleteness, TargetRef};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryRequest {
    pub capability: CapabilityRef,
    #[serde(default = "empty_arguments")]
    pub arguments: Value,
}
fn empty_arguments() -> Value {
    serde_json::json!({})
}

impl QueryRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.capability.validate()?;
        if serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > MAX_ARGUMENT_BYTES) {
            return Err(ContractError::ArgumentsTooLarge);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryStatus {
    Ready,
    Busy,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QuerySnapshot {
    pub target: TargetRef,
    pub source: String,
    pub observed_at_ms: i64,
    pub status: QueryStatus,
    pub completeness: ObservationCompleteness,
    pub data: Option<Value>,
    pub notices: Vec<String>,
}
