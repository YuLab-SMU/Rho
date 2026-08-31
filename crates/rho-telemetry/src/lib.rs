#![forbid(unsafe_code)]
//! Privacy-preserving structured telemetry for canonical turns.
//!
//! IDs are copied from canonical event causality; telemetry never creates an
//! alternate correlation or trace identity. Payload text, project content,
//! credentials, and private model reasoning are not accepted as attributes.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::mpsc::{SyncSender, TrySendError, sync_channel},
    thread,
};

use rho_protocol::{CausationId, CorrelationId, EventEnvelopeMetadata, TraceId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_TELEMETRY_QUEUE_CAPACITY: usize = 1024;
pub const MAX_ATTRIBUTE_VALUE_BYTES: usize = 256;
pub const MAX_DISTINCT_VALUES_PER_KEY: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SpanName {
    RhoTurn,
    AgentPrompt,
    GenaiChat,
    Capability,
    Execution,
    ArtifactCommit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum MetricName {
    FirstActivityMs,
    ModelFirstTokenMs,
    ApprovalWaitMs,
    QueueWaitMs,
    CancelLatencyMs,
    StaleRequests,
    HotDrops,
    CasRecoveryCount,
    ProviderLatencyMs,
    RhoOverheadMs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TelemetryCausality {
    pub correlation_id: CorrelationId,
    pub trace_id: TraceId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<CausationId>,
}

impl From<&EventEnvelopeMetadata> for TelemetryCausality {
    fn from(metadata: &EventEnvelopeMetadata) -> Self {
        Self {
            correlation_id: metadata.correlation_id.clone(),
            trace_id: metadata.trace_id.clone(),
            causation_id: metadata.causation_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpanRecord {
    pub name: SpanName,
    pub causality: TelemetryCausality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<SpanName>,
    pub duration_ms: u64,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetricRecord {
    pub name: MetricName,
    pub causality: TelemetryCausality,
    pub value: u64,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TelemetryRecord {
    Span(SpanRecord),
    Metric(MetricRecord),
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TelemetryError {
    #[error("telemetry attribute {0} is not allowlisted")]
    AttributeNotAllowed(String),
    #[error("telemetry attribute {0} exceeds byte bound")]
    AttributeTooLarge(String),
    #[error("telemetry attribute {0} exceeded cardinality budget")]
    CardinalityExceeded(String),
    #[error("telemetry queue is full")]
    QueueFull,
    #[error("telemetry exporter is unavailable")]
    ExporterUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TelemetryBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> TelemetryBoundary {
    TelemetryBoundary {
        owns: &[
            "structured_spans",
            "ux_metrics",
            "attribute_allowlist",
            "nonblocking_export_queue",
        ],
        does_not_own: &[
            "prompt_text",
            "project_content",
            "secret_material",
            "private_reasoning",
            "canonical_id_generation",
            "effect_admission",
        ],
    }
}

#[derive(Debug, Default)]
pub struct AttributePolicy {
    cardinality: BTreeMap<String, BTreeSet<String>>,
}

impl AttributePolicy {
    pub fn validate(
        &mut self,
        attributes: BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, TelemetryError> {
        const ALLOWED: [&str; 10] = [
            "provider_family",
            "capability_id",
            "executor_kind",
            "outcome",
            "reason_code",
            "destination_class",
            "effect_class",
            "retry_class",
            "recovery_kind",
            "status",
        ];
        for (key, value) in &attributes {
            if !ALLOWED.contains(&key.as_str()) {
                return Err(TelemetryError::AttributeNotAllowed(key.clone()));
            }
            if value.len() > MAX_ATTRIBUTE_VALUE_BYTES {
                return Err(TelemetryError::AttributeTooLarge(key.clone()));
            }
            if contains_sensitive_shape(value) {
                return Err(TelemetryError::AttributeNotAllowed(key.clone()));
            }
            let values = self.cardinality.entry(key.clone()).or_default();
            if !values.contains(value) && values.len() >= MAX_DISTINCT_VALUES_PER_KEY {
                return Err(TelemetryError::CardinalityExceeded(key.clone()));
            }
            values.insert(value.clone());
        }
        Ok(attributes)
    }
}

pub trait TelemetryExporter: Send + 'static {
    fn export(&mut self, record: TelemetryRecord);
}

#[derive(Debug)]
pub struct TelemetryRecorder {
    sender: SyncSender<TelemetryRecord>,
    policy: AttributePolicy,
    dropped: u64,
}

impl TelemetryRecorder {
    pub fn start(
        capacity: usize,
        mut exporter: impl TelemetryExporter,
    ) -> (Self, thread::JoinHandle<()>) {
        let (sender, receiver) = sync_channel(capacity.max(1));
        let worker = thread::spawn(move || {
            while let Ok(record) = receiver.recv() {
                exporter.export(record);
            }
        });
        (
            Self {
                sender,
                policy: AttributePolicy::default(),
                dropped: 0,
            },
            worker,
        )
    }

    pub fn record_span(
        &mut self,
        name: SpanName,
        metadata: &EventEnvelopeMetadata,
        parent: Option<SpanName>,
        duration_ms: u64,
        attributes: BTreeMap<String, String>,
    ) -> Result<(), TelemetryError> {
        let attributes = self.policy.validate(attributes)?;
        self.try_export(TelemetryRecord::Span(SpanRecord {
            name,
            causality: metadata.into(),
            parent,
            duration_ms,
            attributes,
        }))
    }

    pub fn record_metric(
        &mut self,
        name: MetricName,
        metadata: &EventEnvelopeMetadata,
        value: u64,
        attributes: BTreeMap<String, String>,
    ) -> Result<(), TelemetryError> {
        let attributes = self.policy.validate(attributes)?;
        self.try_export(TelemetryRecord::Metric(MetricRecord {
            name,
            causality: metadata.into(),
            value,
            attributes,
        }))
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped
    }

    fn try_export(&mut self, record: TelemetryRecord) -> Result<(), TelemetryError> {
        match self.sender.try_send(record) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.dropped += 1;
                Err(TelemetryError::QueueFull)
            }
            Err(TrySendError::Disconnected(_)) => {
                self.dropped += 1;
                Err(TelemetryError::ExporterUnavailable)
            }
        }
    }
}

pub fn canonical_span_parent(name: SpanName) -> Option<SpanName> {
    match name {
        SpanName::RhoTurn => None,
        SpanName::AgentPrompt => Some(SpanName::RhoTurn),
        SpanName::GenaiChat => Some(SpanName::AgentPrompt),
        SpanName::Capability => Some(SpanName::RhoTurn),
        SpanName::Execution => Some(SpanName::Capability),
        SpanName::ArtifactCommit => Some(SpanName::Execution),
    }
}

fn contains_sensitive_shape(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    [
        "canary_secret",
        "private_thinking",
        "chain_of_thought",
        "authorization:",
        "bearer ",
        "-----begin private key-----",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}
