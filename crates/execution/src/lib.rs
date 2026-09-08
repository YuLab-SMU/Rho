#![forbid(unsafe_code)]

pub mod remote;
pub mod slurm;
use async_trait::async_trait;
use rho_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef, EffectHint,
    EffectObservation, IdempotencyClass, LocalProcessRecovery, ObservationCompleteness, Operation,
    OperationId, OperationOutcome, ProcessReconcileRecovery, RetryClass, TargetRef,
};
use rho_operation::{
    Clock, CommitPlan, HandlerError, OperationError, OperationHandler, OperationRecords,
    PlannedEvent, SystemClock, wait_cancellation,
};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{Mutex, watch};

pub const RUN_LOCAL_SCOPE: &str = "process.run_local";
pub use rho_contract::{
    NativeProcessIdentity, OutputCapture, ProcessReconciliation, ProcessReport, ProcessTermination,
    ReconcileProcessArguments, RunLocalArguments,
};
#[async_trait]
pub trait ProcessExecutor: Send + Sync {
    fn root(&self) -> &str;
    async fn run(
        &self,
        operation: &Operation,
        args: &RunLocalArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<ProcessReport, HandlerError>;
    async fn reconcile(&self, source: &Operation) -> Result<ProcessReconciliation, HandlerError>;
}

pub struct ReconcileProcessHandler {
    executor: Arc<dyn ProcessExecutor>,
    records: Arc<dyn OperationRecords>,
    lane: Arc<Mutex<()>>,
    descriptor: CapabilityDescriptor,
}
impl ReconcileProcessHandler {
    pub fn new(
        executor: Arc<dyn ProcessExecutor>,
        records: Arc<dyn OperationRecords>,
        lane: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            executor,
            records,
            lane,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Operation,
                capability: CapabilityRef::new("process.reconcile", 1).unwrap(),
                documentation: crate::documentation("process.reconcile"),
                recovery_schema: schema_for!(Option<ProcessReconcileRecovery>).to_value(),
                domain: "execution".into(),
                input_schema: schema_for!(ReconcileProcessArguments).to_value(),
                output_schema: schema_for!(ProcessReconciliation).to_value(),
                required_scopes: BTreeSet::from([RUN_LOCAL_SCOPE.into()]),
                potential_effects: BTreeSet::from([EffectHint::MaySpawnProcess]),
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl OperationHandler for ReconcileProcessHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.executor.root().into())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: ReconcileProcessArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        OperationId::new(&args.operation_id).map_err(invalid)?;
        serde_json::to_value(args).map_err(invalid)
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(TargetRef {
            kind: "local_process".into(),
            identity: self.executor.root().into(),
        })
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        if !operation.preconditions.is_empty() {
            return Err(HandlerError::before_effect(
                "process reconciliation uses its source Operation, not arbitrary preconditions",
            ));
        }
        let args: ReconcileProcessArguments =
            serde_json::from_value(operation.normalized_arguments.clone())
                .map_err(|error| HandlerError::before_effect(error.to_string()))?;
        let source = self
            .records
            .get(&args.operation_id)
            .await
            .map_err(HandlerError::before_effect)?
            .ok_or_else(|| HandlerError::before_effect("source Operation was not found"))?;
        if !source.status.is_terminal()
            || source.operation.principal() != operation.principal()
            || source.operation.idempotency_scope.as_deref() != Some(self.executor.root())
            || source.operation.capability != CapabilityRef::new("process.run_local", 1).unwrap()
        {
            return Err(HandlerError::before_effect(
                "reconciliation requires a terminal process.run_local Operation in this project/caller scope",
            ));
        }
        // Reject a live source immediately, before waiting behind its runtime
        // lane. Terminal source records cannot become live again.
        let _lane = self.lane.lock().await;
        let report = self.executor.reconcile(&source.operation).await?;
        if report.source_operation_id != source.operation.operation_id.as_str()
            || report.no_matching_processes_observed != report.remaining.is_empty()
        {
            return Err(HandlerError::after_possible_effect(
                "inconsistent native reconciliation report",
                Some(json!(ProcessReconcileRecovery {
                    source_operation_id: args.operation_id.clone(),
                    action: None
                })),
            ));
        }
        let mut plan = CommitPlan::succeeded(
            serde_json::to_value(&report)
                .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?,
        );
        if !report.no_matching_processes_observed {
            plan.outcome = OperationOutcome::Uncertain;
            plan.error = Some("tagged processes remain after bounded reconciliation".into());
            plan.recovery = Some(json!(ProcessReconcileRecovery {
                source_operation_id: args.operation_id.clone(),
                action: Some("reconcile_again_without_reexecuting_source".into())
            }));
        }
        plan.effect_observations.push(EffectObservation {
            kind: "tagged_process_reconciliation".into(), source: "os/sysinfo".into(),
            detail: json!({"source_operation_id":args.operation_id,"signalled":report.signalled,"remaining":report.remaining}),
            observed_at_ms: SystemClock.now_ms().map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?,
            completeness: report.completeness,
        });
        plan.events.push(PlannedEvent {
            kind: "execution.processes_reconciled".into(),
            payload: json!(ProcessReconcileRecovery {
                source_operation_id: args.operation_id.clone(),
                action: None
            }),
        });
        Ok(plan)
    }
}
pub struct RunLocalHandler {
    executor: Arc<dyn ProcessExecutor>,
    lane: Arc<Mutex<()>>,
    descriptor: CapabilityDescriptor,
}
impl RunLocalHandler {
    pub fn new(executor: Arc<dyn ProcessExecutor>, lane: Arc<Mutex<()>>) -> Self {
        Self {
            executor,
            lane,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Operation,
                capability: CapabilityRef::new("process.run_local", 1).unwrap(),
                documentation: crate::documentation("process.run_local"),
                recovery_schema: schema_for!(Option<LocalProcessRecovery>).to_value(),
                domain: "execution".into(),
                input_schema: schema_for!(RunLocalArguments).to_value(),
                output_schema: schema_for!(ProcessReport).to_value(),
                required_scopes: BTreeSet::from([RUN_LOCAL_SCOPE.into()]),
                potential_effects: BTreeSet::from([
                    EffectHint::MaySpawnProcess,
                    EffectHint::MayWriteProject,
                    EffectHint::NeedsNetwork,
                    EffectHint::UsesSecret,
                    EffectHint::ProducesArtifact,
                ]),
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: CancellationClass::Cooperative,
            },
        }
    }
}
#[async_trait]
impl OperationHandler for RunLocalHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.executor.root().into())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        normalize_run_arguments(value)
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(TargetRef {
            kind: "local_process".into(),
            identity: self.executor.root().into(),
        })
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        self.execute_controlled(operation, watch::channel(false).1)
            .await
    }
    async fn execute_controlled(
        &self,
        operation: &Operation,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        let _lane = tokio::select! {
            biased;
            _ = wait_cancellation(&mut cancellation) => return Ok(CommitPlan::cancelled_before_start()),
            lane = self.lane.lock() => lane,
        };
        if !operation.preconditions.is_empty() {
            return Err(HandlerError::before_effect(
                "local process preconditions are not registered",
            ));
        }
        if *cancellation.borrow() {
            return Ok(CommitPlan::cancelled_before_start());
        }
        let args = serde_json::from_value(operation.normalized_arguments.clone())
            .map_err(|e: serde_json::Error| HandlerError::before_effect(e.to_string()))?;
        let report = self.executor.run(operation, &args, cancellation).await?;
        let outcome = match report.termination {
            ProcessTermination::Cancelled => OperationOutcome::Cancelled,
            ProcessTermination::Uncertain => OperationOutcome::Uncertain,
            ProcessTermination::TimedOut => OperationOutcome::Failed,
            ProcessTermination::Exited if report.exit_code == Some(0) => {
                OperationOutcome::Succeeded
            }
            ProcessTermination::Exited => OperationOutcome::Failed,
        };
        let mut plan = CommitPlan::succeeded(
            serde_json::to_value(&report)
                .map_err(|e| HandlerError::after_possible_effect(e.to_string(), None))?,
        );
        plan.outcome = outcome;
        if outcome == OperationOutcome::Failed {
            plan.error = Some(format!(
                "process {:?}, exit code {:?}",
                report.termination, report.exit_code
            ));
        }
        if outcome == OperationOutcome::Uncertain {
            plan.recovery = Some(json!(LocalProcessRecovery {
                source_operation_id: operation.operation_id.as_str().into(),
                pid: report.pid,
                root: self.executor.root().into(),
                action: "inspect_process_and_outputs_before_retry".into()
            }));
        }
        plan.effect_observations.push(EffectObservation {
            kind: "local_process".into(),
            source: "os".into(),
            detail: json!({"pid":report.pid,"exit_code":report.exit_code,
                "exit_signal":report.exit_signal,"termination":report.termination,
                "supervision":report.supervision,"sandboxed":false}),
            observed_at_ms: SystemClock
                .now_ms()
                .map_err(|e| HandlerError::after_possible_effect(e.to_string(), None))?,
            completeness: ObservationCompleteness::Partial,
        });
        plan.events.push(PlannedEvent {
            kind: "execution.process_observed".into(),
            payload: json!({"pid":report.pid,"termination":report.termination}),
        });
        Ok(plan)
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}

pub fn normalize_run_arguments(value: &Value) -> Result<Value, OperationError> {
    let args: RunLocalArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
    if args.program.is_empty()
        || args.program.len() > 4096
        || args.program.contains('\0')
        || args.args.len() > 256
        || args.args.iter().any(|arg| arg.contains('\0'))
        || args
            .stdin
            .as_ref()
            .is_some_and(|input| input.len() > 128 * 1024)
        || !(1..=3_600_000).contains(&args.timeout_ms)
        || !(1..=131072).contains(&args.output_limit_bytes)
    {
        return Err(invalid("process arguments exceed their declared bounds"));
    }
    serde_json::to_value(args).map_err(invalid)
}

fn documentation(id: &str) -> rho_contract::CapabilityDocumentation {
    let mut documentation = rho_contract::builtin_documentation(id);
    let condition = match id {
        "process.reconcile" => Some((
            "operation_id",
            "Use the original terminal process.run_local OperationId from this project/caller. Saved PID values never authorize signals: the native owner rechecks same-user process lifetime and original Operation tag before signalling.",
            "operation.list_recent",
        )),
        "process.run_remote" | "slurm.submit" => Some((
            "configured remote target",
            "The Host selects the SSH host alias, canonical remote project root and optional Slurm cluster. Arguments cannot override this target. Authentication/transport availability is established by actual native execution, never inferred from configuration.",
            "host.overview",
        )),
        "slurm.snapshot" | "slurm.reconcile" | "slurm.request_cancel" => Some((
            "submission_operation_id",
            "Use the original slurm.submit operation in this configured target and caller scope. Native evidence binds host_alias, cluster, job_id, operation_marker and project_root. Cancellation requires exactly one current matching job; a submission response loss never authorizes resubmission.",
            "operation.list_recent",
        )),
        _ => None,
    };
    if let Some((parameter, requirement, read)) = condition {
        documentation
            .preconditions
            .push(rho_contract::CapabilityPrecondition {
                parameter: parameter.into(),
                requirement: requirement.into(),
                read_from: Some(CapabilityRef::new(read, 1).unwrap()),
            });
    }
    if id.starts_with("slurm.") {
        documentation.limitations.push("Scheduler observations are bounded by accounting_lookback_days. An empty/ambiguous lookup and a missing post-cancellation observation retain uncertainty. request_sent records a cancellation request, not confirmed terminal cancellation; inspect the native state separately.".into());
    }
    if id == "process.run_remote" {
        documentation.limitations.push("SSH transport termination is not proof that the remote process ended. Recovery retains the original operation and configured target; no automatic remote replay is available.".into());
    }
    if matches!(
        id,
        "process.reconcile" | "slurm.submit" | "slurm.reconcile" | "slurm.request_cancel"
    ) {
        documentation.cancellation_rule = "This operation does not support Operation cancellation. Cancelling a transport wait does not stop the native action. Scheduler job cancellation is a separate slurm.request_cancel operation, whose receipt must be followed by a native job observation.".into();
    }
    documentation.related_capabilities = if id.starts_with("slurm.") {
        vec!["operation.list_recent", "slurm.snapshot"]
    } else {
        vec!["operation.list_recent"]
    }
    .into_iter()
    .map(|id| CapabilityRef::new(id, 1).unwrap())
    .collect();
    documentation
}
