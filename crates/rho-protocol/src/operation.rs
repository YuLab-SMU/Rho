use serde::{Deserialize, Serialize};

use crate::{
    ids::{CausationId, CorrelationId, OperationId, TraceId},
    revisions::ExpectedRevisions,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Causality {
    pub correlation_id: CorrelationId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<CausationId>,
    pub trace_id: TraceId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperationContext {
    pub operation_id: OperationId,
    pub expected_revisions: ExpectedRevisions,
    pub causality: Causality,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum OperationOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperationResult {
    pub operation_id: OperationId,
    pub outcome: OperationOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
