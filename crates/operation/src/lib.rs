#![forbid(unsafe_code)]

mod recent;
pub use recent::{RecentOperationsHandler, validate_recent_arguments};
mod checkpoint;
pub use checkpoint::OperationEventsCheckpointHandler;
mod commit_contract;
mod evidence;
pub use evidence::{OperationEvidenceHandler, evidence_sha256};
mod navigation;
mod query;
mod record;
mod schema;
pub use query::{QueryGateway, QueryHandler};
pub use record::OperationGetHandler;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use rho_contract::{
    CallContext, CallerIdentity, CancellationClass, CapabilityDescriptor, CapabilityKind,
    CapabilityRef, ContractError, EffectObservation, Invocation, Operation, OperationEventRecord,
    OperationId, OperationOutcome, OperationRecord, OutboxRecord, TargetRef,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum OperationError {
    #[error("contract error: {0}")]
    Contract(String),
    #[error("capability is not registered: {0}")]
    UnknownCapability(String),
    #[error("capability is already registered: {0}")]
    DuplicateCapability(String),
    #[error("caller lacks required scopes for {capability}: {missing:?}")]
    AccessDenied {
        capability: String,
        missing: Vec<String>,
    },
    #[error("capability input is invalid: {0}")]
    InvalidInput(String),
    #[error("capability target could not be resolved: {0}")]
    TargetResolution(String),
    #[error("idempotency conflict: caller and client_request_id were reused with different input")]
    IdempotencyConflict,
    #[error("operation was not found: {0}")]
    NotFound(String),
    #[error("operation lifecycle conflict: {0}")]
    LifecycleConflict(String),
    #[error("operation storage failed: {0}")]
    Storage(String),
    #[error(
        "operation {operation_id:?} has an uncommitted result: {detail}; query the original request before retrying"
    )]
    CommitPending {
        operation_id: OperationId,
        detail: String,
    },
    #[error("cancellation is unsupported for capability {0}")]
    CancellationUnsupported(String),
    #[error("another Rho Next host already owns this database")]
    HostBusy,
    #[error(
        "another Rho Next host already owns project {0}; connect to that Host instead of starting another database/runtime"
    )]
    ProjectBusy(String),
    #[error("native session is stale: {0}")]
    StaleSession(String),
    #[error("observation has expired: {0}")]
    ObservationExpired(String),
    #[error("observed content changed: {0}")]
    ContentChanged(String),
    #[error("observation budget exhausted: {0}")]
    BudgetExceeded(String),
    #[error("capability is unavailable: {0}")]
    Unavailable(String),
}

impl OperationError {
    pub fn diagnostic(&self) -> rho_contract::Diagnostic {
        use rho_contract::{DiagnosticCode as Code, DiagnosticContinuation as Continue};
        let (code, continuation) = match self {
            Self::HostBusy | Self::ProjectBusy(_) => (Code::Busy, Continue::ReadAgain),
            Self::StaleSession(_) => (Code::StaleSession, Continue::RefreshObservation),
            Self::ObservationExpired(_) => (Code::ObservationExpired, Continue::RefreshObservation),
            Self::ContentChanged(_) => (Code::ContentChanged, Continue::RefreshObservation),
            Self::BudgetExceeded(_) => (Code::BudgetExceeded, Continue::CorrectInput),
            Self::Unavailable(_) | Self::UnknownCapability(_) | Self::TargetResolution(_) => {
                (Code::Unavailable, Continue::None)
            }
            Self::AccessDenied { .. } => (Code::AccessDenied, Continue::None),
            Self::IdempotencyConflict => (Code::IdempotencyConflict, Continue::InspectOriginal),
            Self::NotFound(_) => (Code::NotFound, Continue::CorrectInput),
            Self::InvalidInput(_) | Self::CancellationUnsupported(_) => {
                (Code::InvalidInput, Continue::CorrectInput)
            }
            Self::Contract(_) | Self::DuplicateCapability(_) => {
                (Code::ContractViolation, Continue::None)
            }
            Self::CommitPending { .. } | Self::Storage(_) | Self::LifecycleConflict(_) => {
                (Code::OutcomeUncertain, Continue::InspectOriginal)
            }
        };
        // Context-free errors cannot promise that a read capability is registered
        // or permission-visible. Gateways attach available identity-bound reads.
        let next_reads = vec![];
        rho_contract::Diagnostic {
            code,
            message: self.to_string(),
            continuation,
            next_reads,
        }
    }
}

impl From<ContractError> for OperationError {
    fn from(value: ContractError) -> Self {
        Self::Contract(value.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectBoundary {
    NotStarted,
    MayHaveOccurred,
}

#[derive(Debug, Clone)]
pub struct HandlerError {
    pub message: String,
    pub effect_boundary: EffectBoundary,
    pub recovery: Option<Value>,
    /// Owner confirmation: no execution started, or the runtime actually stopped.
    /// A cancellation request alone must never set this field.
    pub cancellation_confirmed: bool,
}

impl HandlerError {
    pub fn before_effect(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            effect_boundary: EffectBoundary::NotStarted,
            recovery: None,
            cancellation_confirmed: false,
        }
    }

    pub fn after_possible_effect(message: impl Into<String>, recovery: Option<Value>) -> Self {
        Self {
            message: message.into(),
            effect_boundary: EffectBoundary::MayHaveOccurred,
            recovery,
            cancellation_confirmed: false,
        }
    }

    pub fn cancelled(message: impl Into<String>, recovery: Option<Value>) -> Self {
        Self {
            message: message.into(),
            effect_boundary: EffectBoundary::MayHaveOccurred,
            recovery,
            cancellation_confirmed: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DomainFactMutation {
    pub domain: String,
    pub schema: String,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone)]
pub struct CommitPlan {
    pub outcome: OperationOutcome,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub recovery: Option<Value>,
    pub facts: Vec<DomainFactMutation>,
    pub effect_observations: Vec<EffectObservation>,
    pub events: Vec<PlannedEvent>,
    /// Raw fault evidence is written atomically with this terminal commit in the
    /// same journal. Normal domain outputs are never duplicated here.
    pub uncommitted_evidence: Option<UncommittedEvidence>,
}
#[derive(Clone)]
pub struct UncommittedEvidence {
    pub reference: rho_contract::OperationEvidenceReference,
    pub bytes: Arc<[u8]>,
}
impl std::fmt::Debug for UncommittedEvidence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UncommittedEvidence")
            .field("reference", &self.reference)
            .finish_non_exhaustive()
    }
}

impl CommitPlan {
    pub fn inline_document(&self) -> Value {
        json!({"outcome":self.outcome,"output":self.output,"error":self.error,"recovery":self.recovery,"facts":self.facts,"effect_observations":self.effect_observations,"events":self.events})
    }
    pub fn cancelled_before_start() -> Self {
        let mut plan = Self::succeeded(Value::Null);
        plan.outcome = OperationOutcome::Cancelled;
        plan.output = None;
        plan
    }

    pub fn succeeded(output: Value) -> Self {
        Self {
            outcome: OperationOutcome::Succeeded,
            output: Some(output),
            error: None,
            recovery: None,
            facts: Vec::new(),
            effect_observations: Vec::new(),
            events: Vec::new(),
            uncommitted_evidence: None,
        }
    }

    pub fn from_handler_error(error: HandlerError) -> Self {
        let outcome = if error.cancellation_confirmed {
            OperationOutcome::Cancelled
        } else {
            match error.effect_boundary {
                EffectBoundary::NotStarted => OperationOutcome::Failed,
                EffectBoundary::MayHaveOccurred => OperationOutcome::Uncertain,
            }
        };
        Self {
            outcome,
            output: None,
            error: Some(error.message),
            recovery: error.recovery.or_else(|| {
                (outcome == OperationOutcome::Uncertain).then(|| {
                    serde_json::to_value(rho_contract::ObserveOwnerRecovery::default())
                        .expect("fixed recovery DTO")
                })
            }),
            facts: Vec::new(),
            effect_observations: Vec::new(),
            events: Vec::new(),
            uncommitted_evidence: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlannedEvent {
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredDomainFact {
    pub domain: String,
    pub schema: String,
    pub key: String,
    pub value: Value,
    pub source_operation_id: OperationId,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Admission {
    New(OperationRecord),
    Existing(OperationRecord),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CancellationRequestOutcome {
    pub accepted: bool,
    pub operation: OperationRecord,
}

/// A closed request channel is not a cancellation request.
pub async fn wait_cancellation(receiver: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[async_trait]
pub trait OperationHandler: Send + Sync {
    fn admitted(&self, _operation: &Operation) -> Result<(), HandlerError> {
        Ok(())
    }
    fn cancel_pending(&self, _operation: &Operation) -> bool {
        false
    }
    async fn acquire_execution(
        &self,
        _operation: &Operation,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(()))
    }
    fn descriptor(&self) -> &CapabilityDescriptor;
    fn idempotency_scope(&self) -> Option<String> {
        None
    }

    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError>;

    fn resolve_target(&self, arguments: &Value) -> Result<TargetRef, OperationError>;

    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError>;

    async fn execute_controlled(
        &self,
        operation: &Operation,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        self.execute(operation).await
    }
}

/// Domain-owned execution qualification outlives the final journal commit.
pub trait ExecutionLease: Send + Sync {
    fn completed(&mut self, _result: &Result<OperationRecord, OperationError>) {}
}
impl ExecutionLease for () {}

#[async_trait]
pub trait OperationJournal: Send + Sync {
    async fn events_checkpoint(
        &self,
        scope: &str,
        principal: &CallerIdentity,
    ) -> Result<rho_contract::OperationEventsCheckpoint, OperationError>;

    async fn list_recent(
        &self,
        _scope: &str,
        _caller: &rho_contract::CallerIdentity,
        _args: &rho_contract::RecentOperationsArguments,
    ) -> Result<rho_contract::RecentOperations, OperationError> {
        Err(OperationError::InvalidInput(
            "operation summaries are unavailable".into(),
        ))
    }
    async fn admit(&self, operation: &Operation) -> Result<Admission, OperationError>;

    async fn mark_running(
        &self,
        operation_id: &OperationId,
        at_ms: i64,
    ) -> Result<OperationRecord, OperationError>;

    async fn commit(
        &self,
        operation_id: &OperationId,
        plan: &CommitPlan,
        at_ms: i64,
    ) -> Result<OperationRecord, OperationError>;

    async fn get(
        &self,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError>;
    async fn get_request(
        &self,
        caller: &CallerIdentity,
        principal: &CallerIdentity,
        project: Option<&str>,
        client_request_id: &str,
    ) -> Result<Option<OperationRecord>, OperationError>;
    async fn read_evidence(
        &self,
        arguments: &rho_contract::OperationReadEvidenceArguments,
    ) -> Result<rho_contract::OperationEvidencePage, OperationError>;

    async fn request_cancellation(
        &self,
        operation_id: &OperationId,
        at_ms: i64,
    ) -> Result<CancellationRequestOutcome, OperationError>;

    async fn recover_incomplete(&self, at_ms: i64) -> Result<Vec<OperationRecord>, OperationError>;

    async fn events(
        &self,
        operation_id: &OperationId,
    ) -> Result<Vec<OperationEventRecord>, OperationError>;

    async fn outbox(
        &self,
        scope: Option<&str>,
        caller: &CallerIdentity,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, OperationError>;

    async fn facts_for_operation(
        &self,
        operation_id: &OperationId,
    ) -> Result<Vec<StoredDomainFact>, OperationError>;
    async fn successful_outputs(
        &self,
        scope: &str,
        capability: &rho_contract::CapabilityRef,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<OperationOutputPage, OperationError>;
}

#[derive(Debug, Clone)]
pub struct OperationOutputPage {
    pub outputs: Vec<Value>,
    pub next_id: Option<String>,
}

/// Narrow read-only access to an existing Operation, used by domain references.
/// Domains still enforce their own caller, target and outcome requirements.
#[async_trait]
pub trait OperationRecords: Send + Sync {
    async fn get(&self, operation_id: &str) -> Result<Option<OperationRecord>, String>;
    async fn successful_outputs(
        &self,
        scope: &str,
        capability: &rho_contract::CapabilityRef,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<OperationOutputPage, String>;
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> Result<i64, OperationError>;
}

#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> Result<i64, OperationError> {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| OperationError::Storage(error.to_string()))?;
        i64::try_from(duration.as_millis())
            .map_err(|_| OperationError::Storage("system clock exceeds INT64".to_string()))
    }
}

pub trait OperationIdGenerator: Send + Sync {
    fn next_id(&self) -> Result<OperationId, OperationError>;
}

#[derive(Debug, Default)]
pub struct UuidOperationIdGenerator;

impl OperationIdGenerator for UuidOperationIdGenerator {
    fn next_id(&self) -> Result<OperationId, OperationError> {
        OperationId::new(format!("op_{}", Uuid::new_v4().simple())).map_err(Into::into)
    }
}

#[derive(Default)]
pub struct CapabilityRegistry {
    handlers: BTreeMap<CapabilityRef, Arc<dyn OperationHandler>>,
    queries: BTreeMap<CapabilityRef, Arc<dyn QueryHandler>>,
    schemas: BTreeMap<CapabilityRef, schema::CapabilitySchemas>,
    descriptors: BTreeMap<CapabilityRef, CapabilityDescriptor>,
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register_control(
        &mut self,
        descriptor: CapabilityDescriptor,
    ) -> Result<(), OperationError> {
        descriptor.validate()?;
        if descriptor.kind != CapabilityKind::Control {
            return Err(OperationError::Contract(
                "control metadata requires Control kind".into(),
            ));
        }
        let capability = descriptor.capability.clone();
        if self.schemas.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
        self.schemas.insert(
            capability.clone(),
            schema::CapabilitySchemas::new(&descriptor)?,
        );
        self.descriptors
            .insert(capability.clone(), descriptor.clone());
        Ok(())
    }

    pub fn register(&mut self, handler: Arc<dyn OperationHandler>) -> Result<(), OperationError> {
        handler.descriptor().validate()?;
        if handler.descriptor().kind != CapabilityKind::Operation {
            return Err(OperationError::Contract(
                "operation handler requires an Operation descriptor".into(),
            ));
        }
        let capability = handler.descriptor().capability.clone();
        if self.schemas.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
        let mut descriptor = handler.descriptor().clone();
        descriptor.recovery_schema =
            rho_contract::operation_recovery_schema(descriptor.recovery_schema);
        let schemas = schema::CapabilitySchemas::new(&descriptor)?;
        for example in &descriptor.documentation.examples {
            let normalized = handler
                .normalize_arguments(&example.arguments)
                .map_err(|e| {
                    OperationError::Contract(format!(
                        "{} example normalization failed: {e}",
                        capability.display_key()
                    ))
                })?;
            schemas.input(&normalized).map_err(|e| {
                OperationError::Contract(format!(
                    "{} normalized example violates its input schema: {e}",
                    capability.display_key()
                ))
            })?;
        }
        self.schemas.insert(capability.clone(), schemas);
        self.descriptors.insert(capability.clone(), descriptor);
        self.handlers.insert(capability, handler);
        Ok(())
    }

    pub fn register_query(&mut self, handler: Arc<dyn QueryHandler>) -> Result<(), OperationError> {
        let descriptor = handler.descriptor();
        descriptor.validate()?;
        if descriptor.kind != CapabilityKind::Query || !descriptor.potential_effects.is_empty() {
            return Err(OperationError::Contract(
                "query descriptors must be reads without declared effects".into(),
            ));
        }
        let capability = descriptor.capability.clone();
        if self.schemas.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
        let schemas = schema::CapabilitySchemas::new(handler.descriptor())?;
        for example in &descriptor.documentation.examples {
            let normalized = handler
                .normalize_arguments(&example.arguments)
                .map_err(|e| {
                    OperationError::Contract(format!(
                        "{} example normalization failed: {e}",
                        capability.display_key()
                    ))
                })?;
            schemas.input(&normalized).map_err(|e| {
                OperationError::Contract(format!(
                    "{} normalized example violates its input schema: {e}",
                    capability.display_key()
                ))
            })?;
        }
        self.schemas.insert(capability.clone(), schemas);
        self.descriptors
            .insert(capability.clone(), descriptor.clone());
        self.queries.insert(capability, handler);
        Ok(())
    }

    pub fn query_handler(
        &self,
        capability: &CapabilityRef,
    ) -> Result<Arc<dyn QueryHandler>, OperationError> {
        self.queries
            .get(capability)
            .cloned()
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))
    }

    pub fn handler(
        &self,
        capability: &CapabilityRef,
    ) -> Result<Arc<dyn OperationHandler>, OperationError> {
        self.handlers
            .get(capability)
            .cloned()
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))
    }

    pub fn descriptors(&self) -> Vec<CapabilityDescriptor> {
        self.descriptors.values().cloned().collect()
    }
    pub fn descriptor(&self, capability: &CapabilityRef) -> Option<&CapabilityDescriptor> {
        self.descriptors.get(capability)
    }
    pub fn validate_control_input(
        &self,
        context: &CallContext,
        capability: &CapabilityRef,
        arguments: &Value,
    ) -> Result<(), OperationError> {
        context.validate()?;
        let descriptor = self
            .descriptors
            .get(capability)
            .filter(|d| d.kind == CapabilityKind::Control)
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))?;
        let missing = descriptor
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: capability.display_key(),
                missing,
            });
        }
        self.schemas
            .get(capability)
            .expect("registered schema")
            .input(arguments)
    }
    pub fn validate_control_output(
        &self,
        capability: &CapabilityRef,
        output: &Value,
    ) -> Result<(), OperationError> {
        if !self
            .descriptors
            .get(capability)
            .is_some_and(|d| d.kind == CapabilityKind::Control)
        {
            return Err(OperationError::UnknownCapability(capability.display_key()));
        }
        self.schemas
            .get(capability)
            .expect("registered schema")
            .output(output)
    }

    pub fn validate_links(&mut self) -> Result<(), OperationError> {
        let kinds = self
            .descriptors
            .iter()
            .map(|(reference, d)| (reference.clone(), d.kind))
            .collect::<BTreeMap<_, _>>();
        for descriptor in self.descriptors.values_mut() {
            for related in &descriptor.documentation.related_capabilities {
                if !kinds.contains_key(related) {
                    return Err(OperationError::Contract(format!(
                        "{} links to unregistered {}",
                        descriptor.capability.display_key(),
                        related.display_key()
                    )));
                }
            }
            for condition in &mut descriptor.documentation.preconditions {
                if let Some(reference) = condition.read_from.as_ref() {
                    reference.validate()?;
                    match kinds.get(reference) {
                        Some(CapabilityKind::Query) => (),
                        Some(_) => {
                            return Err(OperationError::Contract(format!(
                                "precondition read_from must be read-only: {}",
                                reference.display_key()
                            )));
                        }
                        None => {
                            condition.requirement.push_str(&format!(" The reading source {} is unavailable in this Host configuration; discovery does not start that owner or a runtime.", reference.display_key()));
                            condition.read_from = None;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn validate_query_result(
        &self,
        capability: &CapabilityRef,
        snapshot: &rho_contract::QuerySnapshot,
    ) -> Result<(), OperationError> {
        let schemas = self
            .schemas
            .get(capability)
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))?;
        if let Some(data) = &snapshot.data {
            schemas.output(data)?;
        } else if snapshot.status == rho_contract::QueryStatus::Ready {
            schemas.output(&Value::Null)?;
        }
        self.validate_reads(&snapshot.next_reads)?;
        for diagnostic in &snapshot.diagnostics {
            self.validate_reads(&diagnostic.next_reads)?;
        }
        Ok(())
    }
    fn validate_reads(&self, reads: &[rho_contract::NextRead]) -> Result<(), OperationError> {
        for read in reads {
            let descriptor = self.descriptors.get(&read.capability).ok_or_else(|| {
                OperationError::Contract(format!(
                    "next read is not registered: {}",
                    read.capability.display_key()
                ))
            })?;
            if descriptor.kind != CapabilityKind::Query {
                return Err(OperationError::Contract(
                    "next_reads may only identify read-only queries".into(),
                ));
            }
            self.schemas
                .get(&read.capability)
                .expect("registered schema")
                .read(read)?;
        }
        Ok(())
    }
    fn filter_reads(&self, context: &CallContext, reads: &mut Vec<rho_contract::NextRead>) {
        reads.retain(|read| {
            self.descriptors
                .get(&read.capability)
                .is_none_or(|d| d.required_scopes.is_subset(&context.scopes))
        });
    }
    pub fn prepare_query_result(
        &self,
        context: &CallContext,
        capability: &CapabilityRef,
        snapshot: &mut rho_contract::QuerySnapshot,
    ) -> Result<(), OperationError> {
        if capability.id == "operation.get" {
            if let Some(data) = snapshot.data.as_ref() {
                let mut result: rho_contract::OperationGetResult =
                    serde_json::from_value(data.clone())
                        .map_err(|e| OperationError::Contract(e.to_string()))?;
                if let Some(record) = &mut result.record {
                    self.decorate_record(context, record)?;
                }
                if let Some(contract) = &mut result.output_contract {
                    if result
                        .record
                        .as_ref()
                        .is_none_or(|record| record.operation.capability != contract.capability)
                    {
                        return Err(OperationError::Contract("record query schema association does not match the original capability".into()));
                    }
                    let visible = self.descriptors.get(&contract.capability).is_some_and(|d| {
                        d.kind == CapabilityKind::Operation
                            && d.required_scopes.is_subset(&context.scopes)
                    });
                    contract.describe = if visible {
                        self.read_link(context, "host.describe", "Read the exact capability contract associated with this original result", json!({"capability":contract.capability}))?
                    } else {
                        None
                    };
                }
                snapshot.data = Some(
                    serde_json::to_value(result)
                        .map_err(|e| OperationError::Contract(e.to_string()))?,
                );
            }
        }
        self.filter_reads(context, &mut snapshot.next_reads);
        for diagnostic in &mut snapshot.diagnostics {
            self.filter_reads(context, &mut diagnostic.next_reads);
        }
        self.validate_query_result(capability, snapshot)
    }
}

pub struct OperationGateway {
    admission: tokio::sync::Mutex<()>,
    registry: Arc<CapabilityRegistry>,
    journal: Arc<dyn OperationJournal>,
    clock: Arc<dyn Clock>,
    id_generator: Arc<dyn OperationIdGenerator>,
    active: Arc<Mutex<BTreeMap<OperationId, tokio::sync::watch::Sender<bool>>>>,
    project_scope: Option<String>,
}

struct ActiveOperation {
    id: OperationId,
    active: Arc<Mutex<BTreeMap<OperationId, tokio::sync::watch::Sender<bool>>>>,
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
    }
}

impl OperationGateway {
    pub fn new(
        registry: Arc<CapabilityRegistry>,
        journal: Arc<dyn OperationJournal>,
        clock: Arc<dyn Clock>,
        id_generator: Arc<dyn OperationIdGenerator>,
    ) -> Self {
        Self {
            registry,
            journal,
            clock,
            id_generator,
            admission: tokio::sync::Mutex::new(()),
            active: Arc::new(Mutex::new(BTreeMap::new())),
            project_scope: None,
        }
    }

    /// Bind project visibility at composition time, never from caller arguments.
    pub fn with_project_scope(mut self, project: Option<String>) -> Self {
        self.project_scope = project;
        self
    }

    pub async fn invoke(
        &self,
        context: &CallContext,
        invocation: Invocation,
    ) -> Result<OperationRecord, OperationError> {
        self.invoke_notifying(context, invocation, None).await
    }

    pub async fn invoke_notifying(
        &self,
        context: &CallContext,
        invocation: Invocation,
        mut accepted: Option<tokio::sync::oneshot::Sender<OperationRecord>>,
    ) -> Result<OperationRecord, OperationError> {
        context.validate()?;
        invocation.validate()?;
        let handler = self.registry.handler(&invocation.capability)?;
        let descriptor = handler.descriptor();
        let missing = descriptor
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: descriptor.capability.display_key(),
                missing,
            });
        }

        let schemas = self
            .registry
            .schemas
            .get(&invocation.capability)
            .expect("registered schema");
        schemas.input(&invocation.arguments)?;
        let normalized_arguments = handler.normalize_arguments(&invocation.arguments)?;
        schemas.input(&normalized_arguments)?;
        Invocation {
            arguments: normalized_arguments.clone(),
            ..invocation.clone()
        }
        .validate()?;
        let target = handler.resolve_target(&normalized_arguments)?;
        target.validate()?;
        let idempotency_scope = handler.idempotency_scope();
        let invocation_digest = invocation_digest(
            &invocation.capability,
            &normalized_arguments,
            &invocation.preconditions,
            idempotency_scope.as_deref(),
            context
                .principal
                .as_ref()
                .filter(|principal| *principal != &context.caller),
        )?;
        let operation_id = self.id_generator.next_id()?;
        let accepted_at_ms = self.clock.now_ms()?;
        let correlation_id = context
            .correlation_id
            .clone()
            .unwrap_or_else(|| operation_id.as_str().to_string());
        let operation = Operation {
            operation_id: operation_id.clone(),
            client_request_id: invocation.client_request_id,
            caller: context.caller.clone(),
            principal: context.principal.clone(),
            capability: invocation.capability,
            domain: descriptor.domain.clone(),
            target,
            normalized_arguments,
            invocation_digest,
            idempotency_scope,
            preconditions: invocation.preconditions,
            potential_effects: descriptor.potential_effects.clone(),
            correlation_id,
            causation_id: context.causation_id.clone(),
            trace_parent: context.trace_parent.clone(),
            accepted_at_ms,
        };

        let admission_lock = self.admission.lock().await;
        let admitted_record = match self.journal.admit(&operation).await? {
            Admission::Existing(existing) => {
                let existing = self.registry.public_record(context, existing);
                info!(
                    operation_id = existing.operation.operation_id.as_str(),
                    capability = existing.operation.capability.id,
                    "returned existing idempotent operation"
                );
                if let Some(sender) = accepted.take() {
                    let _ = sender.send(existing.clone());
                }
                return Ok(existing);
            }
            Admission::New(record) => record,
        };
        let admission_result = handler.admitted(&operation);

        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(operation_id.clone(), cancel);
        let _active = ActiveOperation {
            id: operation_id.clone(),
            active: self.active.clone(),
        };
        drop(admission_lock);
        if let Err(error) = admission_result {
            return self
                .commit_result(&operation, CommitPlan::from_handler_error(error), false)
                .await
                .map(|record| self.registry.public_record(context, record));
        }
        if let Some(sender) = accepted.take() {
            let admitted_record = self.registry.public_record(context, admitted_record);
            let _ = sender.send(admitted_record);
        }
        let mut lease = match handler
            .acquire_execution(&operation, cancelled.clone())
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                return self
                    .commit_result(&operation, CommitPlan::from_handler_error(error), false)
                    .await
                    .map(|record| self.registry.public_record(context, record));
            }
        };
        self.journal
            .mark_running(&operation_id, self.clock.now_ms()?)
            .await?;
        info!(
            operation_id = operation_id.as_str(),
            capability = operation.capability.id,
            "operation started"
        );

        let plan = match handler.execute_controlled(&operation, cancelled).await {
            Ok(plan) => plan,
            Err(error) => {
                if error.effect_boundary == EffectBoundary::MayHaveOccurred {
                    warn!(
                        operation_id = operation_id.as_str(),
                        "operation result is uncertain after a possible external effect"
                    );
                }
                CommitPlan::from_handler_error(error)
            }
        };
        let result = self.commit_result(&operation, plan, true).await;
        lease.completed(&result);
        result.map(|record| self.registry.public_record(context, record))
    }
    async fn commit_result(
        &self,
        operation: &Operation,
        plan: CommitPlan,
        execution_started: bool,
    ) -> Result<OperationRecord, OperationError> {
        let plan = self
            .registry
            .checked_plan(operation, plan, execution_started)?;
        let record = self
            .journal
            .commit(&operation.operation_id, &plan, self.clock.now_ms()?)
            .await
            .map_err(|error| OperationError::CommitPending {
                operation_id: operation.operation_id.clone(),
                detail: error.to_string(),
            })?;
        Ok(record)
    }

    pub fn registry_descriptors(&self) -> Vec<CapabilityDescriptor> {
        self.registry.descriptors()
    }
    pub fn diagnostic(
        &self,
        context: &CallContext,
        error: &OperationError,
    ) -> rho_contract::Diagnostic {
        let mut diagnostic = error.diagnostic();
        if let OperationError::CommitPending { operation_id, .. } = error {
            if let Ok(Some(read)) = self.registry.read_link(
                context,
                "operation.get",
                "Inspect the original operation and retained evidence without replaying it",
                json!({"operation_id":operation_id}),
            ) {
                diagnostic.next_reads.push(read);
            }
        }
        diagnostic
    }

    pub async fn get_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        require_read_scope(context)?;
        self.owner_record(context, operation_id).await
    }
    /// Trusted owner/control lookup. Public record reads use get_operation;
    /// cancellation and stdin retain their own native authority requirements.
    pub async fn owner_record(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        let record = record::visible_record(
            self.journal.as_ref(),
            context,
            operation_id,
            self.project_scope.as_deref(),
        )
        .await?;
        Ok(record.map(|record| self.registry.public_record(context, record)))
    }

    pub async fn get_request_operation(
        &self,
        context: &CallContext,
        request_id: &str,
    ) -> Result<Option<OperationRecord>, OperationError> {
        require_read_scope(context)?;
        self.owner_request_record(context, request_id).await
    }
    /// Resolve a trusted owner's original submission using its exact caller key.
    /// This is not a public read port and does not broaden another actor's scope.
    pub async fn owner_request_record(
        &self,
        context: &CallContext,
        request_id: &str,
    ) -> Result<Option<OperationRecord>, OperationError> {
        context.validate()?;
        let args = rho_contract::RecentOperationsArguments {
            limit: 1,
            before_cursor: None,
            client_request_id: Some(request_id.into()),
            operation_id: None,
        };
        crate::recent::validate_recent_arguments(&args)?;
        let record = self
            .journal
            .get_request(
                &context.caller,
                context.principal(),
                self.project_scope.as_deref(),
                request_id,
            )
            .await?;
        Ok(record.map(|record| self.registry.public_record(context, record)))
    }

    pub async fn request_cancellation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        self.request_cancellation_conditional(context, operation_id, false)
            .await
    }
    pub async fn request_cancellation_conditional(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
        only_if_pending: bool,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        let _admission = self.admission.lock().await;
        let operation = self
            .owner_record(context, operation_id)
            .await?
            .ok_or_else(|| OperationError::NotFound(operation_id.as_str().to_string()))?;
        let handler = self.registry.handler(&operation.operation.capability)?;
        let missing = handler
            .descriptor()
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: operation.operation.capability.display_key(),
                missing,
            });
        }
        if handler.descriptor().cancellation == CancellationClass::Unsupported {
            return Err(OperationError::CancellationUnsupported(
                operation.operation.capability.display_key(),
            ));
        }
        if only_if_pending && !handler.cancel_pending(&operation.operation) {
            return Err(OperationError::InvalidInput("The run has started or ended. Refresh its state; use Interrupt explicitly for a running operation.".into()));
        }
        let mut outcome = self
            .journal
            .request_cancellation(operation_id, self.clock.now_ms()?)
            .await?;
        if outcome.accepted
            && let Some(sender) = self
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(operation_id)
        {
            sender.send_replace(true);
        }
        outcome.operation = self.registry.public_record(context, outcome.operation);
        Ok(outcome)
    }

    pub async fn recover_incomplete(&self) -> Result<Vec<OperationRecord>, OperationError> {
        self.journal.recover_incomplete(self.clock.now_ms()?).await
    }

    pub async fn events(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Vec<OperationEventRecord>, OperationError> {
        self.require_visible(context, operation_id).await?;
        self.journal.events(operation_id).await
    }

    pub async fn outbox(
        &self,
        context: &CallContext,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, OperationError> {
        require_read_scope(context)?;
        self.journal
            .outbox(
                self.project_scope.as_deref(),
                context.principal(),
                after_sequence,
                limit,
            )
            .await
    }

    pub async fn facts_for_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Vec<StoredDomainFact>, OperationError> {
        self.require_visible(context, operation_id).await?;
        self.journal.facts_for_operation(operation_id).await
    }

    async fn require_visible(
        &self,
        context: &CallContext,
        id: &OperationId,
    ) -> Result<(), OperationError> {
        require_read_scope(context)?;
        self.owner_record(context, id)
            .await?
            .ok_or_else(|| OperationError::NotFound(id.as_str().into()))?;
        Ok(())
    }
}
fn require_read_scope(context: &CallContext) -> Result<(), OperationError> {
    context.validate()?;
    if !context.scopes.contains("operation.read") {
        return Err(OperationError::AccessDenied {
            capability: "operation.read".into(),
            missing: vec!["operation.read".into()],
        });
    }
    Ok(())
}

fn invocation_digest(
    capability: &CapabilityRef,
    normalized_arguments: &Value,
    preconditions: &[rho_contract::Precondition],
    scope: Option<&str>,
    principal: Option<&rho_contract::CallerIdentity>,
) -> Result<String, OperationError> {
    let mut document = json!({
        "capability": capability,
        "arguments": normalized_arguments,
        "preconditions": preconditions,
    });
    if let Some(scope) = scope {
        document["scope"] = json!(scope);
    }
    if let Some(principal) = principal {
        document["principal"] = json!(principal);
    }
    document.sort_all_objects();
    let bytes = serde_json::to_vec(&document)
        .map_err(|error| OperationError::InvalidInput(error.to_string()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn registry_rejects_duplicate_capability_owner() {
        struct Noop {
            descriptor: CapabilityDescriptor,
        }

        #[async_trait]
        impl OperationHandler for Noop {
            fn descriptor(&self) -> &CapabilityDescriptor {
                &self.descriptor
            }

            fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
                Ok(arguments.clone())
            }

            fn resolve_target(&self, _arguments: &Value) -> Result<TargetRef, OperationError> {
                Ok(TargetRef {
                    kind: "test".to_string(),
                    identity: "test".to_string(),
                })
            }

            async fn execute(&self, _operation: &Operation) -> Result<CommitPlan, HandlerError> {
                Ok(CommitPlan::succeeded(json!({})))
            }
        }

        let descriptor = CapabilityDescriptor {
            kind: CapabilityKind::Operation,
            capability: CapabilityRef::new("test.noop", 1).unwrap(),
            documentation: rho_contract::builtin_documentation("host.overview"),
            recovery_schema: serde_json::json!({"type":"null"}),
            domain: "test".to_string(),
            input_schema: json!({}),
            output_schema: json!({}),
            required_scopes: BTreeSet::new(),
            potential_effects: BTreeSet::new(),
            idempotency: rho_contract::IdempotencyClass::CallerScoped,
            retry: rho_contract::RetryClass::Never,
            cancellation: CancellationClass::Unsupported,
        };
        let mut registry = CapabilityRegistry::new();
        registry
            .register(Arc::new(Noop {
                descriptor: descriptor.clone(),
            }))
            .unwrap();
        let error = registry
            .register(Arc::new(Noop { descriptor }))
            .unwrap_err();
        assert!(matches!(error, OperationError::DuplicateCapability(_)));
    }
}

#[cfg(test)]
mod contract_tests;
