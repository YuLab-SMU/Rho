#![forbid(unsafe_code)]

mod recent;
pub use recent::RecentOperationsHandler;
mod query;
pub use query::{QueryGateway, QueryHandler};

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
}

impl CommitPlan {
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
                    json!({
                        "action": "observe_owner_before_any_retry",
                        "automatic_reexecution": false
                    })
                })
            }),
            facts: Vec::new(),
            effect_observations: Vec::new(),
            events: Vec::new(),
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

#[async_trait]
pub trait OperationJournal: Send + Sync {
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
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, handler: Arc<dyn OperationHandler>) -> Result<(), OperationError> {
        handler.descriptor().validate()?;
        if handler.descriptor().kind != CapabilityKind::Operation {
            return Err(OperationError::Contract(
                "operation handler requires an Operation descriptor".into(),
            ));
        }
        let capability = handler.descriptor().capability.clone();
        if self.handlers.contains_key(&capability) || self.queries.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
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
        if self.handlers.contains_key(&capability) || self.queries.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
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
        self.handlers
            .values()
            .map(|handler| handler.descriptor().clone())
            .chain(
                self.queries
                    .values()
                    .map(|handler| handler.descriptor().clone()),
            )
            .collect()
    }
}

pub struct OperationGateway {
    registry: Arc<CapabilityRegistry>,
    journal: Arc<dyn OperationJournal>,
    clock: Arc<dyn Clock>,
    id_generator: Arc<dyn OperationIdGenerator>,
    active: Arc<Mutex<BTreeMap<OperationId, tokio::sync::watch::Sender<bool>>>>,
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
            active: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub async fn invoke(
        &self,
        context: &CallContext,
        invocation: Invocation,
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

        let normalized_arguments = handler.normalize_arguments(&invocation.arguments)?;
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

        match self.journal.admit(&operation).await? {
            Admission::Existing(existing) => {
                info!(
                    operation_id = existing.operation.operation_id.as_str(),
                    capability = existing.operation.capability.id,
                    "returned existing idempotent operation"
                );
                return Ok(existing);
            }
            Admission::New(_) => {}
        }

        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        self.active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(operation_id.clone(), cancel);
        let _active = ActiveOperation {
            id: operation_id.clone(),
            active: self.active.clone(),
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
        self.journal
            .commit(&operation_id, &plan, self.clock.now_ms()?)
            .await
            .map_err(|error| OperationError::CommitPending {
                operation_id,
                detail: error.to_string(),
            })
    }

    pub fn registry_descriptors(&self) -> Vec<CapabilityDescriptor> {
        self.registry.descriptors()
    }

    pub async fn get_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        context.validate()?;
        Ok(self
            .journal
            .get(operation_id)
            .await?
            .filter(|record| record.operation.principal() == context.principal()))
    }

    pub async fn request_cancellation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        let operation = self
            .get_operation(context, operation_id)
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
        let outcome = self
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
        context.validate()?;
        self.journal
            .outbox(context.principal(), after_sequence, limit)
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
        self.get_operation(context, id)
            .await?
            .ok_or_else(|| OperationError::NotFound(id.as_str().into()))?;
        Ok(())
    }
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
