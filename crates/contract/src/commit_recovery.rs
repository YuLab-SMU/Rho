use crate::{OperationId, OperationStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Digest of the exact, validated result retained by the original journal.
/// The reference is an identity check; callers never supply a replacement plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationCommitReference {
    pub operation_id: OperationId,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum OperationCommitPhase {
    AwaitingResult,
    Volatile,
    Durable,
    Committed,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationCommitStatus {
    pub operation_id: OperationId,
    pub operation_status: OperationStatus,
    pub phase: OperationCommitPhase,
    pub reference: Option<OperationCommitReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileOperationCommit {
    pub reference: OperationCommitReference,
}
