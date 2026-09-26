use async_trait::async_trait;
use rho_contract::{
    CallerIdentity, CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef,
    EffectHint, IdempotencyClass, NextRead, ObservationCompleteness, Operation, OperationOutcome,
    OperationRecord, QuerySnapshot, QueryStatus, RetryClass, SlurmCancelRecovery,
    SlurmReconcileRecovery, SlurmSubmissionRecovery, TargetRef,
};
use rho_operation::{
    Clock, CommitPlan, HandlerError, OperationError, OperationHandler, OperationRecords,
    PlannedEvent, QueryHandler, SystemClock,
};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::Mutex;

pub const SLURM_READ_SCOPE: &str = "slurm.read";
pub const SLURM_WRITE_SCOPE: &str = "slurm.write";
pub const SUBMIT_CAPABILITY: &str = "slurm.submit";
pub use rho_contract::{
    SlurmCancellation, SlurmJobRef, SlurmLookup, SlurmObservation, SlurmSourceArguments,
    SlurmSubmitArguments,
};
pub use rho_contract::{safe_name, terminal_state};
#[async_trait]
pub trait SlurmRuntime: Send + Sync {
    fn target(&self) -> TargetRef;
    fn scope(&self) -> &str;
    async fn submit(
        &self,
        operation: &Operation,
        args: &SlurmSubmitArguments,
    ) -> Result<SlurmJobRef, HandlerError>;
    async fn find(&self, source: &Operation) -> Result<SlurmLookup, String>;
    async fn request_cancel(
        &self,
        source: &Operation,
        observed: &SlurmObservation,
    ) -> Result<SlurmCancellation, HandlerError>;
}
pub struct SlurmOwner {
    runtime: Arc<dyn SlurmRuntime>,
    records: Arc<dyn OperationRecords>,
    lane: Mutex<()>,
}
impl SlurmOwner {
    pub fn new(runtime: Arc<dyn SlurmRuntime>, records: Arc<dyn OperationRecords>) -> Self {
        Self {
            runtime,
            records,
            lane: Mutex::new(()),
        }
    }
    async fn source(
        &self,
        id: &str,
        principal: &CallerIdentity,
    ) -> Result<OperationRecord, HandlerError> {
        let source = self
            .records
            .get(id)
            .await
            .map_err(HandlerError::before_effect)?
            .ok_or_else(|| {
                HandlerError::before_effect(
                    "Slurm submission was not found in this target/caller scope",
                )
            })?;
        if source.operation.capability != CapabilityRef::new(SUBMIT_CAPABILITY, 1).unwrap()
            || source.operation.idempotency_scope.as_deref() != Some(self.runtime.scope())
            || principal != source.operation.principal()
        {
            return Err(HandlerError::before_effect(
                "Slurm submission was not found in this target/caller scope",
            ));
        }
        Ok(source)
    }
}
#[derive(Clone, Copy)]
pub enum SlurmAction {
    Submit,
    Reconcile,
    RequestCancel,
}
pub struct SlurmHandler {
    owner: Arc<SlurmOwner>,
    action: SlurmAction,
    descriptor: CapabilityDescriptor,
}
impl SlurmHandler {
    pub fn new(owner: Arc<SlurmOwner>, action: SlurmAction) -> Self {
        let (name, input, output) = match action {
            SlurmAction::Submit => (
                SUBMIT_CAPABILITY,
                schema_for!(SlurmSubmitArguments).to_value(),
                schema_for!(SlurmJobRef).to_value(),
            ),
            SlurmAction::Reconcile => (
                "slurm.reconcile",
                schema_for!(SlurmSourceArguments).to_value(),
                schema_for!(SlurmLookup).to_value(),
            ),
            SlurmAction::RequestCancel => (
                "slurm.request_cancel",
                schema_for!(SlurmSourceArguments).to_value(),
                schema_for!(SlurmCancellation).to_value(),
            ),
        };
        Self {
            owner,
            action,
            descriptor: CapabilityDescriptor {
                capability: CapabilityRef::new(name, 1).unwrap(),
                documentation: crate::documentation(name),
                recovery_schema: match action {
                    SlurmAction::Submit => schema_for!(Option<SlurmSubmissionRecovery>).to_value(),
                    SlurmAction::Reconcile => {
                        schema_for!(Option<SlurmReconcileRecovery>).to_value()
                    }
                    SlurmAction::RequestCancel => {
                        schema_for!(Option<SlurmCancelRecovery>).to_value()
                    }
                },
                kind: CapabilityKind::Operation,
                domain: "execution".into(),
                input_schema: input,
                output_schema: output,
                required_scopes: BTreeSet::from([SLURM_WRITE_SCOPE.into()]),
                potential_effects: BTreeSet::from([
                    EffectHint::MaySpawnProcess,
                    EffectHint::NeedsNetwork,
                    EffectHint::ProducesArtifact,
                ]),
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl OperationHandler for SlurmHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.runtime.scope().into())
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(self.owner.runtime.target())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        if matches!(self.action, SlurmAction::Submit) {
            let args: SlurmSubmitArguments =
                serde_json::from_value(value.clone()).map_err(invalid)?;
            args.validate().map_err(invalid)?;
            serde_json::to_value(args).map_err(invalid)
        } else {
            normalize_source(value)
        }
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        if !operation.preconditions.is_empty() {
            return Err(HandlerError::before_effect(
                "Slurm operations use their native source reference, not arbitrary preconditions",
            ));
        }
        let source = if matches!(self.action, SlurmAction::Submit) {
            None
        } else {
            let args: SlurmSourceArguments =
                serde_json::from_value(operation.normalized_arguments.clone()).map_err(before)?;
            let source = self
                .owner
                .source(&args.submission_operation_id, operation.principal())
                .await?;
            if !source.status.is_terminal() {
                return Err(HandlerError::before_effect(
                    "submission is still active; query it before reconciliation or job cancellation",
                ));
            }
            Some(source)
        };
        let _lane = self.owner.lane.lock().await;
        let mut unresolved = None;
        let output = match self.action {
            SlurmAction::Submit => {
                let args = serde_json::from_value(operation.normalized_arguments.clone())
                    .map_err(before)?;
                serde_json::to_value(self.owner.runtime.submit(operation, &args).await?)
                    .map_err(after)?
            }
            SlurmAction::Reconcile | SlurmAction::RequestCancel => {
                let source = source.as_ref().unwrap();
                let lookup = self
                    .owner
                    .runtime
                    .find(&source.operation)
                    .await
                    .map_err(|error| {
                        HandlerError::after_possible_effect(
                            error,
                            Some(json!(SlurmReconcileRecovery::LookupUnavailable {
                                source_operation_id: source.operation.operation_id.as_str().into(),
                                automatic_reexecution: false
                            })),
                        )
                    })?;
                if lookup.jobs.len() != 1 {
                    unresolved = Some(source.operation.operation_id.clone());
                    // Cancel cannot guess a job from an absent or ambiguous lookup.
                    if matches!(self.action, SlurmAction::RequestCancel) {
                        return Err(HandlerError::after_possible_effect(
                            "exactly one native job must match before cancellation",
                            Some(json!(SlurmCancelRecovery::Ambiguous {
                                source_operation_id: source.operation.operation_id.as_str().into(),
                                lookup
                            })),
                        ));
                    }
                }
                if matches!(self.action, SlurmAction::RequestCancel) {
                    serde_json::to_value(
                        self.owner
                            .runtime
                            .request_cancel(&source.operation, &lookup.jobs[0])
                            .await?,
                    )
                    .map_err(after)?
                } else {
                    serde_json::to_value(lookup).map_err(after)?
                }
            }
        };
        let mut plan = CommitPlan::succeeded(output);
        if let Some(id) = unresolved {
            plan.outcome = OperationOutcome::Uncertain;
            plan.error = Some(
                "no unique scheduler job was observed; submission must not be replayed".into(),
            );
            plan.recovery = Some(json!(SlurmReconcileRecovery::Unresolved {
                source_operation_id: id.as_str().into(),
                action: "query_scheduler_without_resubmitting".into()
            }));
        }
        plan.events.push(PlannedEvent {
            kind: "execution.slurm_observed".into(),
            payload: json!({"capability":operation.capability}),
        });
        Ok(plan)
    }
}
pub struct SlurmQueryHandler {
    owner: Arc<SlurmOwner>,
    descriptor: CapabilityDescriptor,
}
impl SlurmQueryHandler {
    pub fn new(owner: Arc<SlurmOwner>) -> Self {
        Self {
            owner,
            descriptor: CapabilityDescriptor {
                capability: CapabilityRef::new("slurm.snapshot", 1).unwrap(),
                documentation: crate::documentation("slurm.snapshot"),
                recovery_schema: serde_json::json!({"type":"null"}),
                kind: CapabilityKind::Query,
                domain: "execution".into(),
                input_schema: schema_for!(SlurmSourceArguments).to_value(),
                output_schema: schema_for!(SlurmLookup).to_value(),
                required_scopes: BTreeSet::from([SLURM_READ_SCOPE.into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl QueryHandler for SlurmQueryHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        normalize_source(value)
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid(
            "Slurm observations require an authenticated caller",
        ))
    }
    async fn query_for(
        &self,
        context: &rho_contract::CallContext,
        value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let args: SlurmSourceArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        let source = self
            .owner
            .source(&args.submission_operation_id, context.principal())
            .await
            .map_err(|error| invalid(error.message))?;
        let mut snapshot = QuerySnapshot {
            next_reads: vec![NextRead::query(
                "operation.list_recent",
                "Read the original submission result and recovery markers without resubmitting.",
                json!({"operation_id":args.submission_operation_id,"limit":1}),
            )],
            diagnostics: Vec::new(),
            target: self.owner.runtime.target(),
            source: "slurm".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Partial,
            data: None,
            notices: Vec::new(),
        };
        if !source.status.is_terminal() {
            snapshot.diagnostics.push(OperationError::ProjectBusy("The original Slurm submission is still active; no second job is submitted by this read.".into()).diagnostic());
            return Ok(snapshot);
        }
        let Ok(_lane) = self.owner.lane.try_lock() else {
            snapshot.diagnostics.push(
                OperationError::ProjectBusy("The configured scheduler lane is busy.".into())
                    .diagnostic(),
            );
            return Ok(snapshot);
        };
        match self.owner.runtime.find(&source.operation).await {
            Ok(lookup) => {
                if lookup.jobs.len() != 1 {
                    snapshot.notices.push("No unique native job is observed within the stated accounting lookback. Absence or ambiguity does not establish that submission failed; preserve the original submission identity.".into());
                }
                snapshot.status = QueryStatus::Ready;
                snapshot.data = Some(serde_json::to_value(lookup).map_err(invalid)?);
            }
            Err(error) => {
                snapshot.status = QueryStatus::Unavailable;
                snapshot
                    .diagnostics
                    .push(OperationError::Unavailable(error.clone()).diagnostic());
                snapshot.notices.push(error);
            }
        }
        snapshot.observed_at_ms = SystemClock.now_ms()?;
        Ok(snapshot)
    }
}
fn normalize_source(value: &Value) -> Result<Value, OperationError> {
    let args: SlurmSourceArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
    args.source_id().map_err(invalid)?;
    serde_json::to_value(args).map_err(invalid)
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
fn before(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::before_effect(error.to_string())
}
fn after(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::after_possible_effect(error.to_string(), None)
}

#[cfg(test)]
mod tests;
