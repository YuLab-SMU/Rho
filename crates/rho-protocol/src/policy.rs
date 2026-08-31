use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    events::Actor,
    ids::{CapabilityId, OperationId, ProviderId, WorkspaceId},
    operation::OperationContext,
    taxonomy::{BrokerDecisionKind, DataClass, DestinationClass, PermissionPosture},
    versioning::CANONICAL_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyInput {
    pub schema_version: u16,
    pub subject: Actor,
    pub operation: OperationContext,
    pub capability_id: CapabilityId,
    pub arguments: Value,
    pub workspace_id: WorkspaceId,
    pub permission_posture: PermissionPosture,
    pub data_class: DataClass,
    pub destination: DestinationClass,
    pub provider: ProviderCapabilitySnapshot,
}

impl PolicyInput {
    pub fn new(
        subject: Actor,
        operation: OperationContext,
        capability_id: CapabilityId,
        arguments: Value,
        workspace_id: WorkspaceId,
        provider: ProviderCapabilitySnapshot,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            subject,
            operation,
            capability_id,
            arguments,
            workspace_id,
            permission_posture: PermissionPosture::AskBeforeChanges,
            data_class: DataClass::ProjectConfidential,
            destination: DestinationClass::LocalWorkspace,
            provider,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCapabilitySnapshot {
    pub provider_id: ProviderId,
    pub snapshot_digest: String,
    pub capability_ids: Vec<CapabilityId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyDecision {
    pub schema_version: u16,
    pub operation_id: OperationId,
    pub decision: BrokerDecisionKind,
    pub reason_code: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_user_facts: Vec<String>,
}

impl PolicyDecision {
    pub fn new(
        operation_id: OperationId,
        decision: BrokerDecisionKind,
        reason_code: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            operation_id,
            decision,
            reason_code: reason_code.into(),
            required_user_facts: Vec::new(),
        }
    }
}
