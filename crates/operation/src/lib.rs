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
mod registry;
mod registry_snapshot;
pub use registry::{CapabilityRegistry, ContributionBatch, RegistrationRevision};
pub use registry_snapshot::RegistrySnapshot;
pub use query::{QueryGateway, QueryHandler};
pub use record::OperationGetHandler;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use rho_contract::{
    CallContext, CallerIdentity, CancellationClass, CapabilityDescriptor,
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

pub use rho_contract::CancellationRequestOutcome;

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
    /// Bind a concrete owner and perform read-only native preparation before
    /// admission. A returned handler is retained through execution and commit.
    /// Model output cannot change the registered schema, scopes or effect class.
    async fn bind(
        &self,
        _context: &CallContext,
        _arguments: &Value,
        _preconditions: &[rho_contract::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        Ok(None)
    }
    fn execution_context(&self) -> Value {
        Value::Null
    }
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

/// Typed internal selectors for an owner's records, applied before pagination.
#[derive(Debug, Clone)]
pub struct OperationRecordFilter {
    pub capability: CapabilityRef,
    pub secondary_capability: Option<CapabilityRef>,
    pub workspace_instance_id: Option<String>,
    pub continuation_lineage_id: Option<String>,
}

#[async_trait]
pub trait OperationJournal: Send + Sync {
    /// An owner's exact actor filter, in addition to the authenticated principal.
    async fn list_recent_for_caller(&self, _scope: &str, _principal: &CallerIdentity, _caller: &CallerIdentity, _args: &rho_contract::RecentOperationsArguments) -> Result<rho_contract::RecentOperations, OperationError> {
        Err(OperationError::Unavailable("Caller-filtered operation history is unavailable".into()))
    }
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
    /// Owner-specific history filters are applied before pagination and visibility.
    /// This is an internal read port, not a caller-supplied SQL expression.
    async fn list_recent_for_capability(
        &self,
        _scope: &str,
        _caller: &rho_contract::CallerIdentity,
        _args: &rho_contract::RecentOperationsArguments,
        _filter: &OperationRecordFilter,
    ) -> Result<rho_contract::RecentOperations, OperationError> {
        Err(OperationError::Unavailable("filtered operation history is unavailable".into()))
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


pub struct OperationGateway {
    admission: tokio::sync::Mutex<()>,
    registry: Arc<CapabilityRegistry>,
    journal: Arc<dyn OperationJournal>,
    clock: Arc<dyn Clock>,
    id_generator: Arc<dyn OperationIdGenerator>,
    active: Arc<Mutex<BTreeMap<OperationId, ActiveExecution>>>,
    project_scope: Option<String>,
}

struct ActiveExecution {
    cancel: tokio::sync::watch::Sender<bool>,
    handler: Arc<dyn OperationHandler>,
}

struct ActiveOperation {
    id: OperationId,
    active: Arc<Mutex<BTreeMap<OperationId, ActiveExecution>>>,
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
        let registry = self.registry.snapshot();
        invocation.validate()?;
        let request_digest = invocation_digest(
            &invocation.capability,
            &invocation.arguments,
            &invocation.preconditions,
            self.project_scope.as_deref(),
            Some(context.principal()),
        )?;
        if let Some(existing) = self
            .journal
            .get_request(
                &context.caller,
                context.principal(),
                self.project_scope.as_deref(),
                &invocation.client_request_id,
            )
            .await?
            && let Some(admission) = &existing.operation.admission
            && admission.request_digest == request_digest
        {
            let missing = admission
                .descriptor
                .required_scopes
                .difference(&context.scopes)
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                return Err(OperationError::AccessDenied {
                    capability: invocation.capability.display_key(),
                    missing,
                });
            }
            let existing = registry.public_record(context, existing);
            if let Some(sender) = accepted.take() {
                let _ = sender.send(existing.clone());
            }
            return Ok(existing);
        }
        let handler = registry.handler(&invocation.capability)?;
        let descriptor = registry
            .descriptor(&invocation.capability)
            .expect("registered descriptor");
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

        let schemas = registry
            .schemas
            .get(&invocation.capability)
            .expect("registered schema");
        schemas.input(&invocation.arguments)?;
        let handler = handler
            .bind(context, &invocation.arguments, &invocation.preconditions)
            .await?
            .unwrap_or(handler);
        let mut bound_contract = handler.descriptor().clone();
        bound_contract.recovery_schema =
            rho_contract::operation_recovery_schema(bound_contract.recovery_schema);
        if !registry::same_contract(descriptor, &bound_contract) {
            return Err(OperationError::Contract(
                "prepared handler changed its registered contract or authority".into(),
            ));
        }
        let normalized_arguments = handler.normalize_arguments(&invocation.arguments)?;
        schemas.input(&normalized_arguments)?;
        Invocation {
            arguments: normalized_arguments.clone(),
            ..invocation.clone()
        }
        .validate()?;
        let target = handler.resolve_target(&normalized_arguments)?;
        target.validate()?;
        let owner_context = handler.execution_context();
        if serde_json::to_vec(&owner_context)
            .map_or(true, |bytes| bytes.len() > rho_contract::MAX_ARGUMENT_BYTES)
        {
            return Err(OperationError::BudgetExceeded(
                "prepared owner context exceeds the admission limit".into(),
            ));
        }
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
            admission: Some(rho_contract::OperationAdmission {
                request_digest,
                descriptor: descriptor.clone(),
                owner_context,
            }),
        };

        let admission_lock = self.admission.lock().await;
        let admitted_record = match self.journal.admit(&operation).await? {
            Admission::Existing(existing) => {
                let existing = registry.public_record(context, existing);
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
            .insert(
                operation_id.clone(),
                ActiveExecution {
                    cancel,
                    handler: handler.clone(),
                },
            );
        let _active = ActiveOperation {
            id: operation_id.clone(),
            active: self.active.clone(),
        };
        drop(admission_lock);
        if let Err(error) = admission_result {
            return self
                .commit_result(
                    &registry,
                    &operation,
                    CommitPlan::from_handler_error(error),
                    false,
                )
                .await
                .map(|record| registry.public_record(context, record));
        }
        if let Some(sender) = accepted.take() {
            let admitted_record = registry.public_record(context, admitted_record);
            let _ = sender.send(admitted_record);
        }
        let mut lease = match handler
            .acquire_execution(&operation, cancelled.clone())
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                return self
                    .commit_result(
                        &registry,
                        &operation,
                        CommitPlan::from_handler_error(error),
                        false,
                    )
                    .await
                    .map(|record| registry.public_record(context, record));
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
        let result = self.commit_result(&registry, &operation, plan, true).await;
        lease.completed(&result);
        result.map(|record| registry.public_record(context, record))
    }
    async fn commit_result(
        &self,
        registry: &RegistrySnapshot,
        operation: &Operation,
        plan: CommitPlan,
        execution_started: bool,
    ) -> Result<OperationRecord, OperationError> {
        let plan = registry
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
        if let OperationError::CommitPending { operation_id, .. } = error
            && let Ok(Some(read)) = self.registry.read_link(
                context,
                "operation.get",
                "Inspect the original operation and retained evidence without replaying it",
                json!({"operation_id":operation_id}),
            )
        {
            diagnostic.next_reads.push(read);
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
    /// Task owners may find their original operations without changing read authority.
    pub async fn recent_for_caller(&self, context: &CallContext, caller: &CallerIdentity, args: &rho_contract::RecentOperationsArguments) -> Result<rho_contract::RecentOperations, OperationError> {
        require_read_scope(context)?;
        caller.validate()?;
        crate::recent::validate_recent_arguments(args)?;
        let project = self.project_scope.as_deref().ok_or_else(|| OperationError::Unavailable("A project is required for task operation history".into()))?;
        self.journal.list_recent_for_caller(project, context.principal(), caller, args).await
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
        let retained = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(operation_id)
            .map(|active| active.handler.clone());
        let descriptor = retained
            .as_ref()
            .map(|handler| handler.descriptor().clone())
            .or_else(|| {
                operation
                    .operation
                    .admission
                    .as_ref()
                    .map(|admission| admission.descriptor.clone())
            })
            .or_else(|| self.registry.descriptor(&operation.operation.capability))
            .ok_or_else(|| {
                OperationError::UnknownCapability(operation.operation.capability.display_key())
            })?;
        let missing = descriptor
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
        if descriptor.cancellation == CancellationClass::Unsupported {
            return Err(OperationError::CancellationUnsupported(
                operation.operation.capability.display_key(),
            ));
        }
        if only_if_pending
            && !retained
                .as_ref()
                .is_some_and(|handler| handler.cancel_pending(&operation.operation))
        {
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
            sender.cancel.send_replace(true);
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
    use rho_contract::CapabilityKind;
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
