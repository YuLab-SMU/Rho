use crate::OperationId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProtectionStatus {
    pub latest_checkpoint_id: Option<OperationId>,
    pub saved_at_ms: Option<i64>,
    pub saved_objects: Option<u32>,
    pub skipped_objects: Option<u32>,
    pub activity_since_copy: bool,
    pub capture_available: bool,
    pub last_error: Option<String>,
    pub automatic_pending: bool,
}
