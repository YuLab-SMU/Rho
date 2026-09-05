use crate::{ProcessReport, RunLocalArguments, normalize_run_arguments};
use async_trait::async_trait;
use rho_next_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef, EffectHint,
    EffectObservation, IdempotencyClass, ObservationCompleteness, Operation, OperationOutcome,
    RetryClass, TargetRef,
};
use rho_next_operation::{
    Clock, CommitPlan, HandlerError, OperationError, OperationHandler, PlannedEvent, SystemClock,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::watch;

pub const REMOTE_EXECUTE_SCOPE: &str = "remote.execute";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RemoteTarget {
    pub host_alias: String,
    pub project_root: String,
    pub slurm_cluster: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RemoteExecutionReport {
    pub target: RemoteTarget,
    pub transport: ProcessReport,
    pub remote_exit_code: Option<i32>,
    pub outcome: OperationOutcome,
    pub notice: String,
}
#[async_trait]
pub trait RemoteExecutor: Send + Sync {
    fn target(&self) -> TargetRef;
    fn scope(&self) -> &str;
    async fn execute(
        &self,
        operation: &Operation,
        args: &RunLocalArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<RemoteExecutionReport, HandlerError>;
}
pub struct RemoteRunHandler {
    runtime: Arc<dyn RemoteExecutor>,
    descriptor: CapabilityDescriptor,
}
impl RemoteRunHandler {
    pub fn new(runtime: Arc<dyn RemoteExecutor>) -> Self {
        Self {
            runtime,
            descriptor: CapabilityDescriptor {
                capability: CapabilityRef::new("process.run_remote", 1).unwrap(),
                kind: CapabilityKind::Operation,
                domain: "execution".into(),
                input_schema: schema_for!(RunLocalArguments).to_value(),
                output_schema: schema_for!(RemoteExecutionReport).to_value(),
                required_scopes: BTreeSet::from([REMOTE_EXECUTE_SCOPE.into()]),
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
impl OperationHandler for RemoteRunHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.runtime.scope().into())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let value = normalize_run_arguments(value)?;
        if value["program"]
            .as_str()
            .is_some_and(|program| program.starts_with('-'))
        {
            return Err(OperationError::InvalidInput(
                "remote program cannot start with '-' (use an explicit path)".into(),
            ));
        }
        Ok(value)
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(self.runtime.target())
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        self.execute_controlled(operation, watch::channel(false).1)
            .await
    }
    async fn execute_controlled(
        &self,
        operation: &Operation,
        cancellation: watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        if !operation.preconditions.is_empty() {
            return Err(HandlerError::before_effect(
                "remote execution has no registered arbitrary preconditions",
            ));
        }
        let args = serde_json::from_value(operation.normalized_arguments.clone())
            .map_err(|error: serde_json::Error| HandlerError::before_effect(error.to_string()))?;
        let report = self.runtime.execute(operation, &args, cancellation).await?;
        let mut plan = CommitPlan::succeeded(
            serde_json::to_value(&report)
                .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?,
        );
        plan.outcome = report.outcome;
        if report.outcome == OperationOutcome::Uncertain {
            plan.error = Some(report.notice.clone());
            plan.recovery = Some(
                json!({"target":report.target,"source_operation_id":operation.operation_id,"action":"observe_remote_owner_before_retry","automatic_reexecution":false}),
            );
        } else if report.outcome == OperationOutcome::Failed {
            plan.error = Some(format!("remote exit code {:?}", report.remote_exit_code));
        }
        plan.effect_observations.push(EffectObservation { kind: "remote_execution".into(), source: "ssh".into(),
            detail: json!({"target":report.target,"remote_exit_code":report.remote_exit_code,"transport_termination":report.transport.termination}),
            observed_at_ms: SystemClock.now_ms().map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?, completeness: ObservationCompleteness::Partial });
        plan.events.push(PlannedEvent {
            kind: "execution.remote_observed".into(),
            payload: json!({"target":report.target}),
        });
        Ok(plan)
    }
}
