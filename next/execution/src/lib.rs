#![forbid(unsafe_code)]

use async_trait::async_trait;
use rho_next_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef, EffectHint,
    EffectObservation, IdempotencyClass, ObservationCompleteness, Operation, OperationId,
    OperationOutcome, RetryClass, TargetRef,
};
use rho_next_operation::{
    Clock, CommitPlan, HandlerError, OperationError, OperationHandler, OperationRecords,
    PlannedEvent, SystemClock, wait_cancellation,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{Mutex, watch};

pub const RUN_LOCAL_SCOPE: &str = "process.run_local";
fn default_timeout() -> u64 {
    60_000
}
fn default_output() -> usize {
    64 * 1024
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RunLocalArguments {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default = "default_timeout")]
    #[schemars(range(min = 1, max = 3600000))]
    pub timeout_ms: u64,
    #[serde(default = "default_output")]
    #[schemars(range(min = 1, max = 131072))]
    pub output_limit_bytes: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputCapture {
    pub bytes: Vec<u8>,
    pub total_bytes: u64,
    pub truncated: bool,
    pub eof: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProcessTermination {
    Exited,
    Cancelled,
    TimedOut,
    Uncertain,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProcessReport {
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
    pub termination: ProcessTermination,
    pub stdout: OutputCapture,
    pub stderr: OutputCapture,
    pub elapsed_ms: u64,
    pub supervision: String,
    pub stdin_error: Option<String>,
    pub cleanup_requested: bool,
    pub cleanup_error: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct NativeProcessIdentity {
    pub pid: u32,
    pub started_at_seconds: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProcessReconciliation {
    pub source_operation_id: String,
    pub observed: Vec<NativeProcessIdentity>,
    pub signalled: Vec<NativeProcessIdentity>,
    pub remaining: Vec<NativeProcessIdentity>,
    pub no_matching_processes_observed: bool,
    pub completeness: ObservationCompleteness,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReconcileProcessArguments {
    /// Original terminal process.run_local Operation, never a caller-supplied PID.
    pub operation_id: String,
}
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
            || source.operation.caller != operation.caller
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
                Some(json!({"source_operation_id":args.operation_id})),
            ));
        }
        let mut plan = CommitPlan::succeeded(
            serde_json::to_value(&report)
                .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?,
        );
        if !report.no_matching_processes_observed {
            plan.outcome = OperationOutcome::Uncertain;
            plan.error = Some("tagged processes remain after bounded reconciliation".into());
            plan.recovery = Some(
                json!({"source_operation_id":args.operation_id,"action":"reconcile_again_without_reexecuting_source"}),
            );
        }
        plan.effect_observations.push(EffectObservation {
            kind: "tagged_process_reconciliation".into(), source: "os/sysinfo".into(),
            detail: json!({"source_operation_id":args.operation_id,"signalled":report.signalled,"remaining":report.remaining}),
            observed_at_ms: SystemClock.now_ms().map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?,
            completeness: report.completeness,
        });
        plan.events.push(PlannedEvent {
            kind: "execution.processes_reconciled".into(),
            payload: json!({"source_operation_id":args.operation_id}),
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
            return Err(invalid(
                "local process arguments exceed their declared bounds",
            ));
        }
        serde_json::to_value(args).map_err(invalid)
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
            plan.recovery = Some(
                json!({"pid":report.pid,"root":self.executor.root(),"action":"inspect_process_and_outputs_before_retry"}),
            );
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
