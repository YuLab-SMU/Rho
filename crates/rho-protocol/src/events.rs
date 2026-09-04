use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{
    artifacts::ArtifactDigest,
    ids::{
        ArtifactId, CapabilityId, CausationId, CorrelationId, EventId, ExecutionId, JobId,
        KernelInstanceId, OperationId, ProviderId, RunId, SessionId, StreamId, ToolCallId, TraceId,
        TurnId, WorkspaceId,
    },
    revisions::{
        ExpectedRevisions, ProjectRevision, RevisionStamp, RevisionTransition, StateRevision,
        StreamSeq,
    },
    taxonomy::DataClass,
    versioning::CANONICAL_SCHEMA_VERSION,
};

pub const MAX_SEMANTIC_EVENT_PAYLOAD_BYTES: usize = 512 * 1024;
pub const MAX_HOT_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    User,
    AgentProvider,
    Broker,
    Executor,
    Workspace,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Actor {
    pub kind: ActorKind,
    pub id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EventPriority {
    P0,
    P1,
    P2,
    P3,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EventChannel {
    SemanticDurable,
    HotOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CanonicalEventType {
    MessageDelta,
    MessageCompleted,
    CapabilityRequested,
    ProviderPermissionHint,
    UsageUpdated,
    SessionChanged,
    TurnCompleted,
    TurnFailed,
    ProviderDiagnostic,
    ExecutionStateChanged,
    RevisionAdvanced,
    ArtifactCommitted,
    RecoveryRecorded,
    SecurityViolation,
}

pub const ALL_CANONICAL_EVENT_TYPES: [CanonicalEventType; 14] = [
    CanonicalEventType::MessageDelta,
    CanonicalEventType::MessageCompleted,
    CanonicalEventType::CapabilityRequested,
    CanonicalEventType::ProviderPermissionHint,
    CanonicalEventType::UsageUpdated,
    CanonicalEventType::SessionChanged,
    CanonicalEventType::TurnCompleted,
    CanonicalEventType::TurnFailed,
    CanonicalEventType::ProviderDiagnostic,
    CanonicalEventType::ExecutionStateChanged,
    CanonicalEventType::RevisionAdvanced,
    CanonicalEventType::ArtifactCommitted,
    CanonicalEventType::RecoveryRecorded,
    CanonicalEventType::SecurityViolation,
];

impl CanonicalEventType {
    pub fn registry(self) -> EventRegistryEntry {
        match self {
            Self::MessageDelta => EventRegistryEntry::hot(
                self,
                EventPriority::P3,
                DataClass::ProjectConfidential,
                MAX_HOT_EVENT_PAYLOAD_BYTES,
            ),
            Self::MessageCompleted => EventRegistryEntry::semantic(
                self,
                EventPriority::P1,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::CapabilityRequested => EventRegistryEntry::semantic(
                self,
                EventPriority::P0,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::ProviderPermissionHint => EventRegistryEntry::hot(
                self,
                EventPriority::P2,
                DataClass::ProjectConfidential,
                MAX_HOT_EVENT_PAYLOAD_BYTES,
            ),
            Self::UsageUpdated => EventRegistryEntry::hot(
                self,
                EventPriority::P3,
                DataClass::ProjectInternal,
                MAX_HOT_EVENT_PAYLOAD_BYTES,
            ),
            Self::SessionChanged => EventRegistryEntry::semantic(
                self,
                EventPriority::P1,
                DataClass::ProjectInternal,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::TurnCompleted => EventRegistryEntry::semantic(
                self,
                EventPriority::P1,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::TurnFailed => EventRegistryEntry::semantic(
                self,
                EventPriority::P1,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::ProviderDiagnostic => EventRegistryEntry::hot(
                self,
                EventPriority::P3,
                DataClass::ProjectInternal,
                MAX_HOT_EVENT_PAYLOAD_BYTES,
            ),
            Self::ExecutionStateChanged => EventRegistryEntry::semantic(
                self,
                EventPriority::P0,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::RevisionAdvanced => EventRegistryEntry::semantic(
                self,
                EventPriority::P0,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::ArtifactCommitted => EventRegistryEntry::semantic(
                self,
                EventPriority::P1,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::RecoveryRecorded => EventRegistryEntry::semantic(
                self,
                EventPriority::P0,
                DataClass::ProjectInternal,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
            Self::SecurityViolation => EventRegistryEntry::semantic(
                self,
                EventPriority::P0,
                DataClass::ProjectConfidential,
                MAX_SEMANTIC_EVENT_PAYLOAD_BYTES,
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct EventRegistryEntry {
    pub event_type: CanonicalEventType,
    pub schema_version: u16,
    pub priority: EventPriority,
    pub channel: EventChannel,
    pub minimum_sensitivity: DataClass,
    pub max_payload_bytes: usize,
}

impl EventRegistryEntry {
    const fn semantic(
        event_type: CanonicalEventType,
        priority: EventPriority,
        minimum_sensitivity: DataClass,
        max_payload_bytes: usize,
    ) -> Self {
        Self {
            event_type,
            schema_version: CANONICAL_SCHEMA_VERSION,
            priority,
            channel: EventChannel::SemanticDurable,
            minimum_sensitivity,
            max_payload_bytes,
        }
    }

    const fn hot(
        event_type: CanonicalEventType,
        priority: EventPriority,
        minimum_sensitivity: DataClass,
        max_payload_bytes: usize,
    ) -> Self {
        Self {
            event_type,
            schema_version: CANONICAL_SCHEMA_VERSION,
            priority,
            channel: EventChannel::HotOnly,
            minimum_sensitivity,
            max_payload_bytes,
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EventValidationError {
    #[error("unsupported event schema version {actual}; expected {expected}")]
    UnsupportedSchemaVersion { expected: u16, actual: u16 },
    #[error("event payload type {event_type:?} is not accepted by the {channel:?} API")]
    WrongChannel {
        event_type: CanonicalEventType,
        channel: EventChannel,
    },
    #[error("event payload exceeds limit at {path}: {actual} > {limit}")]
    PayloadTooLarge {
        path: &'static str,
        limit: usize,
        actual: usize,
    },
    #[error("payload kind {payload_type:?} does not match envelope type {event_type:?}")]
    PayloadTypeMismatch {
        event_type: CanonicalEventType,
        payload_type: CanonicalEventType,
    },
    #[error("revision-bearing event is missing workspace/kernel identity")]
    MissingRevisionIdentity,
    #[error("revision-bearing event identity changed between before and after")]
    RevisionIdentityMismatch,
    #[error("revision-bearing event revisions are not monotonic")]
    RevisionNotMonotonic,
    #[error("expected revisions do not match the event workspace/kernel identity")]
    ExpectedRevisionMismatch,
    #[error("raw provider or ACP payload cannot be admitted as SemanticEvent")]
    RawProviderPayloadRejected,
    #[error("event payload could not be decoded: {0}")]
    PayloadDecode(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CanonicalEventEnvelope {
    pub schema_version: u16,
    pub event_id: EventId,
    pub event_type: CanonicalEventType,
    pub priority: EventPriority,
    pub stream_id: StreamId,
    pub stream_seq: StreamSeq,
    pub occurred_at: DateTime<Utc>,
    pub actor: Actor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_instance_id: Option<KernelInstanceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<ExecutionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<JobId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    pub correlation_id: CorrelationId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<CausationId>,
    pub trace_id: TraceId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_revision_before: Option<StateRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_revision_after: Option<StateRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_revision_before: Option<ProjectRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_revision_after: Option<ProjectRevision>,
    pub sensitivity: DataClass,
    pub payload: Value,
}

impl CanonicalEventEnvelope {
    // The canonical identity and ordering fields are intentionally explicit;
    // callers cannot construct an envelope with implicit stream or trace truth.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        event_id: EventId,
        event_type: CanonicalEventType,
        priority: EventPriority,
        stream_id: StreamId,
        stream_seq: StreamSeq,
        actor: Actor,
        correlation_id: CorrelationId,
        trace_id: TraceId,
        payload: Value,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            event_id,
            event_type,
            priority,
            stream_id,
            stream_seq,
            occurred_at: Utc::now(),
            actor,
            workspace_id: None,
            kernel_instance_id: None,
            session_id: None,
            run_id: None,
            turn_id: None,
            tool_call_id: None,
            execution_id: None,
            job_id: None,
            operation_id: None,
            correlation_id,
            causation_id: None,
            trace_id,
            state_revision_before: None,
            state_revision_after: None,
            project_revision_before: None,
            project_revision_after: None,
            sensitivity: DataClass::ProjectConfidential,
            payload,
        }
    }

    pub fn registry_entry(&self) -> EventRegistryEntry {
        self.event_type.registry()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventEnvelopeMetadata {
    pub event_id: EventId,
    pub stream_id: StreamId,
    pub stream_seq: StreamSeq,
    pub occurred_at: DateTime<Utc>,
    pub actor: Actor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_instance_id: Option<KernelInstanceId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<ExecutionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<JobId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    pub correlation_id: CorrelationId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<CausationId>,
    pub trace_id: TraceId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_revision_before: Option<StateRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_revision_after: Option<StateRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_revision_before: Option<ProjectRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_revision_after: Option<ProjectRevision>,
}

impl EventEnvelopeMetadata {
    pub fn new(
        event_id: EventId,
        stream_id: StreamId,
        stream_seq: StreamSeq,
        actor: Actor,
        correlation_id: CorrelationId,
        trace_id: TraceId,
    ) -> Self {
        Self {
            event_id,
            stream_id,
            stream_seq,
            occurred_at: Utc::now(),
            actor,
            workspace_id: None,
            kernel_instance_id: None,
            session_id: None,
            run_id: None,
            turn_id: None,
            tool_call_id: None,
            execution_id: None,
            job_id: None,
            operation_id: None,
            correlation_id,
            causation_id: None,
            trace_id,
            state_revision_before: None,
            state_revision_after: None,
            project_revision_before: None,
            project_revision_after: None,
        }
    }

    pub fn with_revision_transition(mut self, transition: &RevisionTransition) -> Self {
        self.workspace_id = Some(transition.before.workspace_id.clone());
        self.kernel_instance_id = Some(transition.before.kernel_instance_id.clone());
        self.state_revision_before = Some(transition.before.state_revision);
        self.state_revision_after = Some(transition.after.state_revision);
        self.project_revision_before = Some(transition.before.project_revision);
        self.project_revision_after = Some(transition.after.project_revision);
        self
    }

    pub fn with_expected_revisions(mut self, expected: &ExpectedRevisions) -> Self {
        self.workspace_id = Some(expected.workspace_id.clone());
        self.kernel_instance_id = Some(expected.kernel_instance_id.clone());
        self.state_revision_before = Some(expected.state_revision);
        self.project_revision_before = Some(expected.project_revision);
        self
    }
}

mod sealed {
    pub trait Sealed {}
}

pub trait CanonicalPayload: sealed::Sealed + Serialize {
    fn event_type(&self) -> CanonicalEventType;
    fn minimum_sensitivity(&self) -> DataClass;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SemanticEventPayload {
    MessageCompleted {
        turn_id: TurnId,
        visible_text_digest: String,
    },
    CapabilityRequested {
        capability_id: CapabilityId,
        operation_id: OperationId,
        expected_revisions: ExpectedRevisions,
        normalized_arguments: Value,
    },
    SessionChanged {
        session_id: SessionId,
        state: String,
    },
    TurnCompleted {
        turn_id: TurnId,
    },
    TurnFailed {
        turn_id: TurnId,
        reason_code: String,
    },
    ExecutionStateChanged {
        execution_id: ExecutionId,
        state: String,
    },
    RevisionAdvanced {
        transition: RevisionTransition,
    },
    ArtifactCommitted {
        artifact_id: ArtifactId,
        digest: ArtifactDigest,
        revision: RevisionStamp,
    },
    RecoveryRecorded {
        object: String,
        known_truth: String,
    },
    SecurityViolation {
        policy_id: String,
        reason_code: String,
    },
}

impl SemanticEventPayload {
    pub fn event_type(&self) -> CanonicalEventType {
        match self {
            Self::MessageCompleted { .. } => CanonicalEventType::MessageCompleted,
            Self::CapabilityRequested { .. } => CanonicalEventType::CapabilityRequested,
            Self::SessionChanged { .. } => CanonicalEventType::SessionChanged,
            Self::TurnCompleted { .. } => CanonicalEventType::TurnCompleted,
            Self::TurnFailed { .. } => CanonicalEventType::TurnFailed,
            Self::ExecutionStateChanged { .. } => CanonicalEventType::ExecutionStateChanged,
            Self::RevisionAdvanced { .. } => CanonicalEventType::RevisionAdvanced,
            Self::ArtifactCommitted { .. } => CanonicalEventType::ArtifactCommitted,
            Self::RecoveryRecorded { .. } => CanonicalEventType::RecoveryRecorded,
            Self::SecurityViolation { .. } => CanonicalEventType::SecurityViolation,
        }
    }

    pub fn minimum_sensitivity(&self) -> DataClass {
        match self {
            Self::SessionChanged { .. } | Self::RecoveryRecorded { .. } => {
                DataClass::ProjectInternal
            }
            Self::SecurityViolation { .. }
            | Self::CapabilityRequested { .. }
            | Self::MessageCompleted { .. }
            | Self::TurnCompleted { .. }
            | Self::TurnFailed { .. }
            | Self::ExecutionStateChanged { .. }
            | Self::RevisionAdvanced { .. }
            | Self::ArtifactCommitted { .. } => DataClass::ProjectConfidential,
        }
    }

    fn revision_transition(&self) -> Option<&RevisionTransition> {
        match self {
            Self::RevisionAdvanced { transition } => Some(transition),
            _ => None,
        }
    }

    fn expected_revisions(&self) -> Option<&ExpectedRevisions> {
        match self {
            Self::CapabilityRequested {
                expected_revisions, ..
            } => Some(expected_revisions),
            _ => None,
        }
    }
}

impl sealed::Sealed for SemanticEventPayload {}
impl CanonicalPayload for SemanticEventPayload {
    fn event_type(&self) -> CanonicalEventType {
        SemanticEventPayload::event_type(self)
    }

    fn minimum_sensitivity(&self) -> DataClass {
        SemanticEventPayload::minimum_sensitivity(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HotEventPayload {
    MessageDelta {
        turn_id: TurnId,
        cursor: u64,
        text: String,
    },
    ProviderPermissionHint {
        capability_id: CapabilityId,
        hint: String,
    },
    UsageUpdated {
        provider_id: ProviderId,
        input_tokens: u64,
        output_tokens: u64,
    },
    ProviderDiagnostic {
        provider_id: ProviderId,
        code: String,
    },
}

impl HotEventPayload {
    pub fn event_type(&self) -> CanonicalEventType {
        match self {
            Self::MessageDelta { .. } => CanonicalEventType::MessageDelta,
            Self::ProviderPermissionHint { .. } => CanonicalEventType::ProviderPermissionHint,
            Self::UsageUpdated { .. } => CanonicalEventType::UsageUpdated,
            Self::ProviderDiagnostic { .. } => CanonicalEventType::ProviderDiagnostic,
        }
    }

    pub fn minimum_sensitivity(&self) -> DataClass {
        match self {
            Self::UsageUpdated { .. } | Self::ProviderDiagnostic { .. } => {
                DataClass::ProjectInternal
            }
            Self::MessageDelta { .. } | Self::ProviderPermissionHint { .. } => {
                DataClass::ProjectConfidential
            }
        }
    }
}

impl sealed::Sealed for HotEventPayload {}
impl CanonicalPayload for HotEventPayload {
    fn event_type(&self) -> CanonicalEventType {
        HotEventPayload::event_type(self)
    }

    fn minimum_sensitivity(&self) -> DataClass {
        HotEventPayload::minimum_sensitivity(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticEvent {
    pub schema_version: u16,
    pub event_type: CanonicalEventType,
    pub priority: EventPriority,
    pub sensitivity: DataClass,
    pub metadata: EventEnvelopeMetadata,
    pub payload: SemanticEventPayload,
}

impl SemanticEvent {
    pub fn new(
        metadata: EventEnvelopeMetadata,
        payload: SemanticEventPayload,
    ) -> Result<Self, EventValidationError> {
        let event_type = payload.event_type();
        let entry = event_type.registry();
        if entry.channel != EventChannel::SemanticDurable {
            return Err(EventValidationError::WrongChannel {
                event_type,
                channel: EventChannel::SemanticDurable,
            });
        }
        let event = Self {
            schema_version: entry.schema_version,
            event_type,
            priority: entry.priority,
            sensitivity: entry
                .minimum_sensitivity
                .join(payload.minimum_sensitivity()),
            metadata,
            payload,
        };
        event.validate()?;
        Ok(event)
    }

    pub fn validate(&self) -> Result<(), EventValidationError> {
        validate_supported_schema(self.schema_version)?;
        let entry = self.event_type.registry();
        if entry.channel != EventChannel::SemanticDurable {
            return Err(EventValidationError::WrongChannel {
                event_type: self.event_type,
                channel: EventChannel::SemanticDurable,
            });
        }
        if self.payload.event_type() != self.event_type {
            return Err(EventValidationError::PayloadTypeMismatch {
                event_type: self.event_type,
                payload_type: self.payload.event_type(),
            });
        }
        let bytes = encoded_payload_len(&self.payload)?;
        if bytes > entry.max_payload_bytes {
            return Err(EventValidationError::PayloadTooLarge {
                path: "semantic.payload",
                limit: entry.max_payload_bytes,
                actual: bytes,
            });
        }
        if let Some(transition) = self.payload.revision_transition() {
            validate_transition(&self.metadata, transition)?;
        }
        if let Some(expected) = self.payload.expected_revisions() {
            validate_expected(&self.metadata, expected)?;
        }
        Ok(())
    }

    pub fn encoded_payload_len(&self) -> Result<usize, EventValidationError> {
        encoded_payload_len(&self.payload)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HotEvent {
    pub schema_version: u16,
    pub event_type: CanonicalEventType,
    pub priority: EventPriority,
    pub sensitivity: DataClass,
    pub metadata: EventEnvelopeMetadata,
    pub payload: HotEventPayload,
}

impl HotEvent {
    pub fn new(
        metadata: EventEnvelopeMetadata,
        payload: HotEventPayload,
    ) -> Result<Self, EventValidationError> {
        let event_type = payload.event_type();
        let entry = event_type.registry();
        if entry.channel != EventChannel::HotOnly {
            return Err(EventValidationError::WrongChannel {
                event_type,
                channel: EventChannel::HotOnly,
            });
        }
        let event = Self {
            schema_version: entry.schema_version,
            event_type,
            priority: entry.priority,
            sensitivity: entry
                .minimum_sensitivity
                .join(payload.minimum_sensitivity()),
            metadata,
            payload,
        };
        event.validate()?;
        Ok(event)
    }

    pub fn validate(&self) -> Result<(), EventValidationError> {
        validate_supported_schema(self.schema_version)?;
        let entry = self.event_type.registry();
        if entry.channel != EventChannel::HotOnly {
            return Err(EventValidationError::WrongChannel {
                event_type: self.event_type,
                channel: EventChannel::HotOnly,
            });
        }
        if self.payload.event_type() != self.event_type {
            return Err(EventValidationError::PayloadTypeMismatch {
                event_type: self.event_type,
                payload_type: self.payload.event_type(),
            });
        }
        let bytes = encoded_payload_len(&self.payload)?;
        if bytes > entry.max_payload_bytes {
            return Err(EventValidationError::PayloadTooLarge {
                path: "hot.payload",
                limit: entry.max_payload_bytes,
                actual: bytes,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RawProviderPayload {
    pub provider_id: ProviderId,
    pub method: String,
    pub body: Value,
}

impl TryFrom<RawProviderPayload> for SemanticEventPayload {
    type Error = EventValidationError;

    fn try_from(_value: RawProviderPayload) -> Result<Self, Self::Error> {
        Err(EventValidationError::RawProviderPayloadRejected)
    }
}

impl TryFrom<CanonicalEventEnvelope> for SemanticEvent {
    type Error = EventValidationError;

    fn try_from(envelope: CanonicalEventEnvelope) -> Result<Self, Self::Error> {
        validate_supported_schema(envelope.schema_version)?;
        let entry = envelope.event_type.registry();
        if entry.channel != EventChannel::SemanticDurable {
            return Err(EventValidationError::WrongChannel {
                event_type: envelope.event_type,
                channel: EventChannel::SemanticDurable,
            });
        }
        let payload: SemanticEventPayload = serde_json::from_value(envelope.payload)
            .map_err(|error| EventValidationError::PayloadDecode(error.to_string()))?;
        let metadata = EventEnvelopeMetadata {
            event_id: envelope.event_id,
            stream_id: envelope.stream_id,
            stream_seq: envelope.stream_seq,
            occurred_at: envelope.occurred_at,
            actor: envelope.actor,
            workspace_id: envelope.workspace_id,
            kernel_instance_id: envelope.kernel_instance_id,
            session_id: envelope.session_id,
            run_id: envelope.run_id,
            turn_id: envelope.turn_id,
            tool_call_id: envelope.tool_call_id,
            execution_id: envelope.execution_id,
            job_id: envelope.job_id,
            operation_id: envelope.operation_id,
            correlation_id: envelope.correlation_id,
            causation_id: envelope.causation_id,
            trace_id: envelope.trace_id,
            state_revision_before: envelope.state_revision_before,
            state_revision_after: envelope.state_revision_after,
            project_revision_before: envelope.project_revision_before,
            project_revision_after: envelope.project_revision_after,
        };
        let event = Self {
            schema_version: envelope.schema_version,
            event_type: envelope.event_type,
            priority: envelope.priority,
            sensitivity: envelope.sensitivity,
            metadata,
            payload,
        };
        event.validate()?;
        Ok(event)
    }
}

pub fn validate_supported_schema(schema_version: u16) -> Result<(), EventValidationError> {
    if schema_version == CANONICAL_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(EventValidationError::UnsupportedSchemaVersion {
            expected: CANONICAL_SCHEMA_VERSION,
            actual: schema_version,
        })
    }
}

pub fn encoded_payload_len<T: Serialize>(payload: &T) -> Result<usize, EventValidationError> {
    serde_json::to_vec(payload)
        .map(|bytes| bytes.len())
        .map_err(|error| EventValidationError::PayloadDecode(error.to_string()))
}

fn validate_transition(
    metadata: &EventEnvelopeMetadata,
    transition: &RevisionTransition,
) -> Result<(), EventValidationError> {
    if transition.before.workspace_id != transition.after.workspace_id
        || transition.before.kernel_instance_id != transition.after.kernel_instance_id
    {
        return Err(EventValidationError::RevisionIdentityMismatch);
    }
    if transition.after.state_revision < transition.before.state_revision
        || transition.after.project_revision < transition.before.project_revision
    {
        return Err(EventValidationError::RevisionNotMonotonic);
    }
    if metadata.workspace_id.as_ref() != Some(&transition.before.workspace_id)
        || metadata.kernel_instance_id.as_ref() != Some(&transition.before.kernel_instance_id)
        || metadata.state_revision_before != Some(transition.before.state_revision)
        || metadata.state_revision_after != Some(transition.after.state_revision)
        || metadata.project_revision_before != Some(transition.before.project_revision)
        || metadata.project_revision_after != Some(transition.after.project_revision)
    {
        return Err(EventValidationError::MissingRevisionIdentity);
    }
    Ok(())
}

fn validate_expected(
    metadata: &EventEnvelopeMetadata,
    expected: &ExpectedRevisions,
) -> Result<(), EventValidationError> {
    if metadata.workspace_id.as_ref() != Some(&expected.workspace_id)
        || metadata.kernel_instance_id.as_ref() != Some(&expected.kernel_instance_id)
        || metadata.state_revision_before != Some(expected.state_revision)
        || metadata.project_revision_before != Some(expected.project_revision)
    {
        return Err(EventValidationError::ExpectedRevisionMismatch);
    }
    Ok(())
}
