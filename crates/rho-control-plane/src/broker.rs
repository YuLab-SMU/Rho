use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{
    Actor, ActorKind, BrokerDecisionKind, Causality, CorrelationId, DestinationClass,
    EventEnvelopeMetadata, EventId, ExpectedRevisions, OperationContext, OperationId,
    PolicyDecision, SemanticEvent, SemanticEventPayload, StreamId, StreamSeq, TraceId,
};
use rho_store::{AppendOutcome, SemanticStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    CapabilityRegistry, CapabilityRegistryError, PolicyDecisionReport, PolicyEvaluationContext,
    evaluate_policy,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovalBinding {
    pub approval_id: String,
    pub operation_id: OperationId,
    pub capability_id: rho_protocol::CapabilityId,
    pub normalized_args_hash: String,
    pub expected_revisions: ExpectedRevisions,
    pub destination: DestinationClass,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerLease {
    lease_id: String,
    operation_id: OperationId,
    normalized_args_hash: String,
    expected_revisions: ExpectedRevisions,
    destination: DestinationClass,
    expires_at_ms: u64,
}

impl BrokerLease {
    pub fn opaque_id(&self) -> &str {
        &self.lease_id
    }

    pub fn operation_id(&self) -> &OperationId {
        &self.operation_id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdmissionRequest {
    pub context: PolicyEvaluationContext,
    #[serde(default)]
    pub normalized_arguments: Value,
    pub now_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DurableIntentOutcome {
    Appended,
    Duplicate { existing_event_id: String },
}

pub trait DurableIntentRecorder {
    fn append_broker_intent(
        &mut self,
        expected_next_seq: StreamSeq,
        event: &SemanticEvent,
    ) -> Result<DurableIntentOutcome, BrokerError>;
}

impl DurableIntentRecorder for SemanticStore {
    fn append_broker_intent(
        &mut self,
        expected_next_seq: StreamSeq,
        event: &SemanticEvent,
    ) -> Result<DurableIntentOutcome, BrokerError> {
        match self.append_semantic_event(expected_next_seq, event)? {
            AppendOutcome::Appended { .. } => Ok(DurableIntentOutcome::Appended),
            AppendOutcome::DuplicateOperation {
                existing_event_id, ..
            } => Ok(DurableIntentOutcome::Duplicate { existing_event_id }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerAdmissionOutcome {
    Allowed {
        decision: PolicyDecision,
        durable_event_id: String,
        lease: BrokerLease,
    },
    Ask {
        decision: PolicyDecision,
        durable_event_id: String,
        approval_binding: ApprovalBinding,
    },
    Denied {
        decision: PolicyDecision,
        durable_event_id: String,
    },
    Duplicate {
        operation_id: OperationId,
        durable_event_id: String,
    },
}

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error("capability registry error: {0}")]
    Capability(#[from] CapabilityRegistryError),
    #[error("store append error: {0}")]
    Store(#[from] rho_store::SemanticAppendError),
    #[error("event validation error: {0}")]
    Event(#[from] rho_protocol::EventValidationError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("approval binding {0} not found")]
    ApprovalNotFound(String),
    #[error("approval binding {0} has already been used")]
    ApprovalAlreadyUsed(String),
    #[error("approval binding {0} is expired")]
    ApprovalExpired(String),
    #[error("approval binding {0} does not match exact arguments/revision/destination")]
    ApprovalMismatch(String),
    #[error("executor call missing Broker-issued lease")]
    MissingLease,
}

#[derive(Debug)]
pub struct BrokerAdmission {
    registry: CapabilityRegistry,
    stream_id: StreamId,
    next_stream_seq: u64,
    operation_results: BTreeMap<OperationId, BrokerAdmissionOutcome>,
    approval_bindings: BTreeMap<String, ApprovalBinding>,
    used_approvals: BTreeSet<String>,
}

impl BrokerAdmission {
    pub fn new(registry: CapabilityRegistry, stream_id: StreamId) -> Self {
        Self {
            registry,
            stream_id,
            next_stream_seq: 0,
            operation_results: BTreeMap::new(),
            approval_bindings: BTreeMap::new(),
            used_approvals: BTreeSet::new(),
        }
    }

    pub fn admit(
        &mut self,
        store: &mut impl DurableIntentRecorder,
        mut request: AdmissionRequest,
    ) -> Result<BrokerAdmissionOutcome, BrokerError> {
        if request.normalized_arguments.is_null() {
            request.normalized_arguments = request.context.input.arguments.clone();
        }
        let operation_id = request.context.input.operation.operation_id.clone();
        if let Some(previous) = self.operation_results.get(&operation_id) {
            return Ok(match previous {
                BrokerAdmissionOutcome::Allowed {
                    durable_event_id, ..
                }
                | BrokerAdmissionOutcome::Ask {
                    durable_event_id, ..
                }
                | BrokerAdmissionOutcome::Denied {
                    durable_event_id, ..
                } => BrokerAdmissionOutcome::Duplicate {
                    operation_id,
                    durable_event_id: durable_event_id.clone(),
                },
                BrokerAdmissionOutcome::Duplicate {
                    durable_event_id, ..
                } => BrokerAdmissionOutcome::Duplicate {
                    operation_id,
                    durable_event_id: durable_event_id.clone(),
                },
            });
        }
        self.registry.validate_arguments(
            &request.context.input.capability_id,
            &request.normalized_arguments,
        )?;
        let policy = evaluate_policy(&self.registry, &request.context);
        let event = self.policy_event(&request, &policy)?;
        let durable_event_id = event.metadata.event_id.as_str().to_string();
        let append = store.append_broker_intent(StreamSeq(self.next_stream_seq), &event)?;
        if let DurableIntentOutcome::Appended = append {
            self.next_stream_seq += 1;
        }
        let outcome = match policy.decision.decision {
            BrokerDecisionKind::Allow => BrokerAdmissionOutcome::Allowed {
                decision: policy.decision.clone(),
                durable_event_id,
                lease: self.lease_for(&request, request.now_ms + 60_000)?,
            },
            BrokerDecisionKind::Ask => {
                let binding = self.approval_binding(&request, request.now_ms + 60_000)?;
                self.approval_bindings
                    .insert(binding.approval_id.clone(), binding.clone());
                BrokerAdmissionOutcome::Ask {
                    decision: policy.decision.clone(),
                    durable_event_id,
                    approval_binding: binding,
                }
            }
            BrokerDecisionKind::Deny => BrokerAdmissionOutcome::Denied {
                decision: policy.decision.clone(),
                durable_event_id,
            },
        };
        self.operation_results.insert(operation_id, outcome.clone());
        Ok(outcome)
    }

    pub fn lease_from_approval(
        &mut self,
        approval_id: &str,
        normalized_arguments: &Value,
        expected_revisions: &ExpectedRevisions,
        destination: DestinationClass,
        now_ms: u64,
    ) -> Result<BrokerLease, BrokerError> {
        let binding = self
            .approval_bindings
            .get(approval_id)
            .ok_or_else(|| BrokerError::ApprovalNotFound(approval_id.to_string()))?;
        if self.used_approvals.contains(approval_id) {
            return Err(BrokerError::ApprovalAlreadyUsed(approval_id.to_string()));
        }
        if now_ms > binding.expires_at_ms {
            return Err(BrokerError::ApprovalExpired(approval_id.to_string()));
        }
        if binding.normalized_args_hash != hash_args(normalized_arguments)?
            || &binding.expected_revisions != expected_revisions
            || binding.destination != destination
        {
            return Err(BrokerError::ApprovalMismatch(approval_id.to_string()));
        }
        self.used_approvals.insert(approval_id.to_string());
        Ok(BrokerLease {
            lease_id: format!("lease_{}", approval_id),
            operation_id: binding.operation_id.clone(),
            normalized_args_hash: binding.normalized_args_hash.clone(),
            expected_revisions: binding.expected_revisions.clone(),
            destination: binding.destination,
            expires_at_ms: binding.expires_at_ms,
        })
    }

    pub fn require_lease(lease: Option<&BrokerLease>) -> Result<&BrokerLease, BrokerError> {
        lease.ok_or(BrokerError::MissingLease)
    }

    fn policy_event(
        &self,
        request: &AdmissionRequest,
        report: &PolicyDecisionReport,
    ) -> Result<SemanticEvent, BrokerError> {
        let operation = &request.context.input.operation;
        let mut metadata = EventEnvelopeMetadata::new(
            EventId::new(format!("event_{}_policy", operation.operation_id.as_str())).unwrap(),
            self.stream_id.clone(),
            StreamSeq(self.next_stream_seq),
            Actor {
                kind: ActorKind::Broker,
                id: "broker".to_string(),
            },
            operation.causality.correlation_id.clone(),
            operation.causality.trace_id.clone(),
        );
        metadata.operation_id = Some(operation.operation_id.clone());
        metadata.workspace_id = Some(request.context.expected_revisions.workspace_id.clone());
        metadata.kernel_instance_id = Some(
            request
                .context
                .expected_revisions
                .kernel_instance_id
                .clone(),
        );
        metadata.state_revision_before = Some(request.context.expected_revisions.state_revision);
        metadata.project_revision_before =
            Some(request.context.expected_revisions.project_revision);
        SemanticEvent::new(
            metadata,
            SemanticEventPayload::PolicyDecisionRecorded {
                decision_id: format!("decision_{}", operation.operation_id.as_str()),
                decision: report.decision.reason_code.clone(),
            },
        )
        .map_err(BrokerError::Event)
    }

    fn lease_for(
        &self,
        request: &AdmissionRequest,
        expires_at_ms: u64,
    ) -> Result<BrokerLease, BrokerError> {
        Ok(BrokerLease {
            lease_id: format!(
                "lease_{}",
                request.context.input.operation.operation_id.as_str()
            ),
            operation_id: request.context.input.operation.operation_id.clone(),
            normalized_args_hash: hash_args(&request.normalized_arguments)?,
            expected_revisions: request.context.expected_revisions.clone(),
            destination: request.context.input.destination,
            expires_at_ms,
        })
    }

    fn approval_binding(
        &self,
        request: &AdmissionRequest,
        expires_at_ms: u64,
    ) -> Result<ApprovalBinding, BrokerError> {
        Ok(ApprovalBinding {
            approval_id: format!(
                "approval_{}",
                request.context.input.operation.operation_id.as_str()
            ),
            operation_id: request.context.input.operation.operation_id.clone(),
            capability_id: request.context.input.capability_id.clone(),
            normalized_args_hash: hash_args(&request.normalized_arguments)?,
            expected_revisions: request.context.expected_revisions.clone(),
            destination: request.context.input.destination,
            expires_at_ms,
        })
    }
}

pub fn hash_args(value: &Value) -> Result<String, BrokerError> {
    let bytes = serde_json::to_vec(value)?;
    let digest = Sha256::digest(&bytes);
    Ok(format!("sha256:{digest:x}"))
}

pub fn broker_operation_context(operation_id: OperationId) -> OperationContext {
    OperationContext {
        operation_id,
        expected_revisions: ExpectedRevisions {
            workspace_id: rho_protocol::WorkspaceId::new("workspace_broker").unwrap(),
            kernel_instance_id: rho_protocol::KernelInstanceId::new("kernel_broker").unwrap(),
            state_revision: rho_protocol::StateRevision(1),
            project_revision: rho_protocol::ProjectRevision(1),
        },
        causality: Causality {
            correlation_id: CorrelationId::new("correlation_broker").unwrap(),
            causation_id: None,
            trace_id: TraceId::new("trace_broker").unwrap(),
        },
    }
}

pub fn lease_matches_request(
    lease: &BrokerLease,
    args: &Value,
    expected: &ExpectedRevisions,
    destination: DestinationClass,
    now_ms: u64,
) -> Result<bool, BrokerError> {
    Ok(lease.normalized_args_hash == hash_args(args)?
        && &lease.expected_revisions == expected
        && lease.destination == destination
        && now_ms <= lease.expires_at_ms)
}

pub fn broker_source_declares_unique_ingress() -> &'static str {
    "all authoritative effects enter through BrokerAdmission::admit and BrokerLease"
}
