//! Scientific work is read from its existing Operation owner.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentScientificWork {
    pub task_id: String,
    pub attributable: bool,
    pub operations: Vec<crate::OperationSummary>,
    pub has_more: bool,
}
