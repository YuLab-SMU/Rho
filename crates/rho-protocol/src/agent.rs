use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ids::{CapabilityId, ProviderId, SessionId, TurnId, WorkspaceId},
    revisions::ExpectedRevisions,
    taxonomy::{DataEgressPosture, PermissionPosture},
    versioning::CANONICAL_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentProviderSnapshot {
    pub provider_id: ProviderId,
    pub provider_version: String,
    pub capability_ids: Vec<CapabilityId>,
    pub supports_resume: bool,
    pub supports_cancel: bool,
    pub max_payload_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogicalAgentSession {
    pub session_id: SessionId,
    pub workspace_id: WorkspaceId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnRequest {
    pub schema_version: u16,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub goal: String,
    pub expected_revisions: ExpectedRevisions,
    pub permission_posture: PermissionPosture,
    pub data_egress: DataEgressPosture,
    pub provider_snapshot: AgentProviderSnapshot,
}

impl TurnRequest {
    pub fn new(
        session_id: SessionId,
        turn_id: TurnId,
        goal: impl Into<String>,
        expected_revisions: ExpectedRevisions,
        provider_snapshot: AgentProviderSnapshot,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            session_id,
            turn_id,
            goal: goal.into(),
            expected_revisions,
            permission_posture: PermissionPosture::AskBeforeChanges,
            data_egress: DataEgressPosture::ConfiguredProviderOnly,
            provider_snapshot,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentProviderRequest {
    Initialize { client_capabilities: Vec<String> },
    CreateSession { session: LogicalAgentSession },
    ResumeSession { session: LogicalAgentSession },
    CloseSession { session_id: SessionId },
    Prompt { request: TurnRequest },
    Cancel { turn_id: TurnId },
    UpdateConfig { validated_config: Value },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventType {
    MessageDelta,
    MessageCompleted,
    PlanReplaced,
    PlanStepTransition,
    CapabilityRequested,
    ProviderPermissionHint,
    UsageUpdated,
    SessionChanged,
    TurnCompleted,
    TurnFailed,
    ProviderDiagnostic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentProviderEvent {
    pub schema_version: u16,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub event_type: AgentEventType,
    pub payload: Value,
}

impl AgentProviderEvent {
    pub fn new(session_id: SessionId, event_type: AgentEventType, payload: Value) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            session_id,
            turn_id: None,
            event_type,
            payload,
        }
    }
}
