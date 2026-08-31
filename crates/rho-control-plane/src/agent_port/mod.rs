//! Provider-neutral admission port used by autonomous Agent turns.

use rho_protocol::{
    BrokerDecisionKind, CapabilityId, ExpectedRevisions, OperationId, OperationOutcome,
    RevisionStamp,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentEffectRequest {
    pub capability_id: CapabilityId,
    pub operation_id: OperationId,
    pub normalized_arguments: Value,
    pub depends_on: ExpectedRevisions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEffectAdmission {
    pub operation_id: OperationId,
    pub decision: BrokerDecisionKind,
    pub reason_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEffectTerminal {
    pub operation_id: OperationId,
    pub outcome: OperationOutcome,
    pub revision: RevisionStamp,
}

pub trait AgentEffectPort {
    fn current_revision(&self) -> RevisionStamp;
    fn request_effect(&mut self, request: AgentEffectRequest) -> AgentEffectAdmission;
    fn observe_terminal(&self, operation_id: &OperationId) -> Option<AgentEffectTerminal>;
}

pub fn agent_port_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["revision_read", "broker_admission", "terminal_observation"],
        &[
            "provider_prompt_format",
            "execution_retry_policy",
            "workspace_mutation",
            "direct_store_append",
        ],
    )
}
