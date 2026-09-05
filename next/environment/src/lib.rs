#![forbid(unsafe_code)]

use async_trait::async_trait;
use rho_next_contract::{
    CallerIdentity, CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef,
    EffectHint, IdempotencyClass, ObservationCompleteness, Operation, OperationOutcome,
    OperationRecord, QuerySnapshot, QueryStatus, RetryClass, TargetRef,
};
use rho_next_operation::{
    Clock, CommitPlan, DomainFactMutation, HandlerError, OperationError, OperationHandler,
    PlannedEvent, QueryHandler, SystemClock, wait_cancellation,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{Mutex, watch};

pub const ENVIRONMENT_READ_SCOPE: &str = "environment.read";
pub const ENVIRONMENT_WRITE_SCOPE: &str = "environment.write";
pub const PLAN_CAPABILITY: &str = "environment.plan";
pub const REALIZE_CAPABILITY: &str = "environment.realize";
pub const VERIFY_CAPABILITY: &str = "environment.verify";
pub const RECONCILE_CAPABILITY: &str = "environment.reconcile";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "manager", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlanArguments {
    Pak { packages: Vec<String> },
    Renv { lockfile: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RealizeArguments {
    pub plan_operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyArguments {
    pub realization_operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReconcileArguments {
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ObserveArguments {
    #[serde(default)]
    pub realization_operation_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    200
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PackageVersion {
    pub name: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SourceDigest {
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EnvironmentPlan {
    pub project_root: String,
    pub manager: String,
    pub lock_path: String,
    pub lock_digest: String,
    pub r_version: String,
    pub platform: String,
    pub packages: Vec<PackageVersion>,
    pub local_sources: Vec<SourceDigest>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NamespaceProbe {
    pub name: String,
    pub version: Option<String>,
    pub library: Option<String>,
    pub loadable: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EnvironmentRealization {
    pub project_root: String,
    pub plan_operation_id: String,
    pub manager: String,
    pub lock_digest: String,
    pub library_path: String,
    pub library_digest: String,
    pub renv_lockfile: String,
    pub r_version: String,
    pub platform: String,
    pub packages: Vec<PackageVersion>,
    pub probes: Vec<NamespaceProbe>,
    pub verified: bool,
    pub restart_required: bool,
    pub activation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Verification {
    pub verified: bool,
    pub library_digest_matches: bool,
    pub probes: Vec<NamespaceProbe>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EnvironmentReconciliation {
    pub source_operation_id: String,
    pub project_root: String,
    pub native_marker: Option<String>,
    pub cleanup_confirmed: bool,
    pub stopped_pids: Vec<u32>,
    pub retained_stage_paths: Vec<String>,
    pub notices: Vec<String>,
}

#[async_trait]
pub trait EnvironmentRuntime: Send + Sync {
    fn root(&self) -> &str;
    async fn observe(&self, library: Option<&str>, limit: usize) -> Result<Value, String>;
    async fn plan(
        &self,
        operation_id: &str,
        args: &PlanArguments,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentPlan, HandlerError>;
    async fn realize(
        &self,
        operation_id: &str,
        plan_id: &str,
        plan: &EnvironmentPlan,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentRealization, HandlerError>;
    async fn verify(
        &self,
        operation_id: &str,
        realization: &EnvironmentRealization,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Verification, HandlerError>;
    async fn reconcile(
        &self,
        operation_id: &str,
    ) -> Result<EnvironmentReconciliation, HandlerError>;
}

/// A read-only projection of existing Operation output, not another plan database.
#[async_trait]
pub trait EnvironmentRecords: Send + Sync {
    async fn get(&self, operation_id: &str) -> Result<Option<OperationRecord>, String>;
}

pub struct EnvironmentOwner {
    pub runtime: Arc<dyn EnvironmentRuntime>,
    records: Arc<dyn EnvironmentRecords>,
    lane: Arc<Mutex<()>>,
    active_library: Option<String>,
    has_workspace: bool,
}
impl EnvironmentOwner {
    pub fn new(
        runtime: Arc<dyn EnvironmentRuntime>,
        records: Arc<dyn EnvironmentRecords>,
        lane: Arc<Mutex<()>>,
        active_library: Option<String>,
        has_workspace: bool,
    ) -> Self {
        Self {
            runtime,
            records,
            lane,
            active_library,
            has_workspace,
        }
    }
    fn target(&self) -> TargetRef {
        TargetRef {
            kind: "environment".into(),
            identity: self.runtime.root().into(),
        }
    }
    async fn output(
        &self,
        id: &str,
        capability: &str,
        caller: Option<&CallerIdentity>,
    ) -> Result<Value, HandlerError> {
        let record = self
            .records
            .get(id)
            .await
            .map_err(HandlerError::before_effect)?
            .ok_or_else(|| HandlerError::before_effect("environment operation was not found"))?;
        if record.status != rho_next_contract::OperationStatus::Succeeded
            || record.operation.capability.id != capability
            || record.operation.idempotency_scope.as_deref() != Some(self.runtime.root())
            || caller.is_some_and(|caller| &record.operation.caller != caller)
        {
            return Err(HandlerError::before_effect(
                "environment reference is not a successful operation in this project/caller scope",
            ));
        }
        record
            .output
            .ok_or_else(|| HandlerError::before_effect("environment operation has no output"))
    }

    async fn recovery_source(
        &self,
        id: &str,
        caller: &CallerIdentity,
    ) -> Result<OperationRecord, HandlerError> {
        let record = self
            .records
            .get(id)
            .await
            .map_err(HandlerError::before_effect)?
            .ok_or_else(|| HandlerError::before_effect("environment operation was not found"))?;
        if !record.status.is_terminal()
            || record.operation.caller != *caller
            || record.operation.idempotency_scope.as_deref() != Some(self.runtime.root())
            || ![PLAN_CAPABILITY, REALIZE_CAPABILITY, VERIFY_CAPABILITY]
                .contains(&record.operation.capability.id.as_str())
        {
            return Err(HandlerError::before_effect(
                "reconciliation requires a terminal Environment operation in this project/caller scope",
            ));
        }
        Ok(record)
    }
}

#[derive(Clone, Copy)]
pub enum EnvironmentAction {
    Plan,
    Realize,
    Verify,
    Reconcile,
}
pub struct EnvironmentHandler {
    owner: Arc<EnvironmentOwner>,
    descriptor: CapabilityDescriptor,
    action: EnvironmentAction,
}
impl EnvironmentHandler {
    pub fn new(owner: Arc<EnvironmentOwner>, action: EnvironmentAction) -> Self {
        let (id, input, output) = match action {
            EnvironmentAction::Plan => (
                PLAN_CAPABILITY,
                schema_for!(PlanArguments).to_value(),
                schema_for!(EnvironmentPlan).to_value(),
            ),
            EnvironmentAction::Realize => (
                REALIZE_CAPABILITY,
                schema_for!(RealizeArguments).to_value(),
                schema_for!(EnvironmentRealization).to_value(),
            ),
            EnvironmentAction::Verify => (
                VERIFY_CAPABILITY,
                schema_for!(VerifyArguments).to_value(),
                schema_for!(Verification).to_value(),
            ),
            EnvironmentAction::Reconcile => (
                RECONCILE_CAPABILITY,
                schema_for!(ReconcileArguments).to_value(),
                schema_for!(EnvironmentReconciliation).to_value(),
            ),
        };
        Self {
            owner,
            action,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Operation,
                capability: CapabilityRef::new(id, 1).unwrap(),
                domain: "environment".into(),
                input_schema: input,
                output_schema: output,
                required_scopes: BTreeSet::from([ENVIRONMENT_WRITE_SCOPE.into()]),
                potential_effects: BTreeSet::from([
                    EffectHint::MaySpawnProcess,
                    EffectHint::NeedsNetwork,
                    EffectHint::ProducesArtifact,
                ]),
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: if matches!(action, EnvironmentAction::Reconcile) {
                    CancellationClass::Unsupported
                } else {
                    CancellationClass::Cooperative
                },
            },
        }
    }
}
#[async_trait]
impl OperationHandler for EnvironmentHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.runtime.root().into())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        match self.action {
            EnvironmentAction::Plan => {
                let args: PlanArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
                match &args {
                    PlanArguments::Pak { packages }
                        if packages.is_empty()
                            || packages.len() > 128
                            || packages.iter().any(|package| {
                                package.is_empty()
                                    || package.len() > 2048
                                    || package.chars().any(char::is_control)
                            }) =>
                    {
                        return Err(invalid(
                            "pak plan requires 1..=128 bounded package references",
                        ));
                    }
                    PlanArguments::Renv { lockfile }
                        if lockfile.is_empty() || lockfile.len() > 1024 =>
                    {
                        return Err(invalid("invalid lockfile path"));
                    }
                    _ => {}
                }
                serde_json::to_value(args).map_err(invalid)
            }
            EnvironmentAction::Realize => serde_json::to_value(
                serde_json::from_value::<RealizeArguments>(value.clone()).map_err(invalid)?,
            )
            .map_err(invalid),
            EnvironmentAction::Verify => serde_json::to_value(
                serde_json::from_value::<VerifyArguments>(value.clone()).map_err(invalid)?,
            )
            .map_err(invalid),
            EnvironmentAction::Reconcile => {
                let args: ReconcileArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                rho_next_contract::OperationId::new(&args.operation_id).map_err(invalid)?;
                serde_json::to_value(args).map_err(invalid)
            }
        }
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(self.owner.target())
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
            lane = self.owner.lane.lock() => lane,
        };
        if !operation.preconditions.is_empty() {
            return Err(HandlerError::before_effect(
                "Environment operations bind their immutable plan/receipt rather than arbitrary preconditions",
            ));
        }
        let parse_error = |error: serde_json::Error| HandlerError::before_effect(error.to_string());
        let mut successful = true;
        let mut recovery = None;
        let output = match self.action {
            EnvironmentAction::Plan => {
                let args = serde_json::from_value(operation.normalized_arguments.clone())
                    .map_err(parse_error)?;
                serde_json::to_value(
                    self.owner
                        .runtime
                        .plan(operation.operation_id.as_str(), &args, cancellation)
                        .await?,
                )
                .map_err(parse_error)?
            }
            EnvironmentAction::Realize => {
                let args: RealizeArguments =
                    serde_json::from_value(operation.normalized_arguments.clone())
                        .map_err(parse_error)?;
                let plan = serde_json::from_value(
                    self.owner
                        .output(
                            &args.plan_operation_id,
                            PLAN_CAPABILITY,
                            Some(&operation.caller),
                        )
                        .await?,
                )
                .map_err(parse_error)?;
                let mut receipt = self
                    .owner
                    .runtime
                    .realize(
                        operation.operation_id.as_str(),
                        &args.plan_operation_id,
                        &plan,
                        cancellation,
                    )
                    .await?;
                receipt.restart_required = self.owner.has_workspace;
                successful = receipt.verified;
                serde_json::to_value(receipt).map_err(parse_error)?
            }
            EnvironmentAction::Verify => {
                let args: VerifyArguments =
                    serde_json::from_value(operation.normalized_arguments.clone())
                        .map_err(parse_error)?;
                let receipt = serde_json::from_value(
                    self.owner
                        .output(
                            &args.realization_operation_id,
                            REALIZE_CAPABILITY,
                            Some(&operation.caller),
                        )
                        .await?,
                )
                .map_err(parse_error)?;
                let report = self
                    .owner
                    .runtime
                    .verify(operation.operation_id.as_str(), &receipt, cancellation)
                    .await?;
                successful = report.verified;
                serde_json::to_value(report).map_err(parse_error)?
            }
            EnvironmentAction::Reconcile => {
                let args: ReconcileArguments =
                    serde_json::from_value(operation.normalized_arguments.clone())
                        .map_err(parse_error)?;
                self.owner
                    .recovery_source(&args.operation_id, &operation.caller)
                    .await?;
                let report = self.owner.runtime.reconcile(&args.operation_id).await?;
                successful = report.cleanup_confirmed;
                if !successful {
                    recovery = Some(json!({"source_operation_id":args.operation_id,
                        "action":"inspect_owner_without_automatic_reexecution"}));
                }
                serde_json::to_value(report).map_err(parse_error)?
            }
        };
        let mut plan = CommitPlan::succeeded(output);
        if !successful {
            plan.outcome = if recovery.is_some() {
                OperationOutcome::Uncertain
            } else {
                OperationOutcome::Failed
            };
            plan.error = Some(
                if recovery.is_some() {
                    "Environment cleanup cannot be confirmed without its native recovery reference"
                } else {
                    "environment verification did not pass"
                }
                .into(),
            );
            plan.recovery = recovery;
        }
        plan.facts.push(DomainFactMutation {domain:"environment".into(),schema:"rho.environment.operation.v1".into(),
            key:operation.operation_id.as_str().into(),value:json!({"operation_id":operation.operation_id,"project_root":self.owner.runtime.root(),"capability":operation.capability})});
        plan.events.push(PlannedEvent {
            kind: "environment.observed".into(),
            payload: json!({"capability":operation.capability,"verified":successful}),
        });
        Ok(plan)
    }
}

pub struct EnvironmentObserveHandler {
    owner: Arc<EnvironmentOwner>,
    descriptor: CapabilityDescriptor,
}
impl EnvironmentObserveHandler {
    pub fn new(owner: Arc<EnvironmentOwner>) -> Self {
        Self {
            owner,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new("environment.observe", 1).unwrap(),
                domain: "environment".into(),
                input_schema: schema_for!(ObserveArguments).to_value(),
                output_schema: schema_for!(QuerySnapshot).to_value(),
                required_scopes: BTreeSet::from([ENVIRONMENT_READ_SCOPE.into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl QueryHandler for EnvironmentObserveHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: ObserveArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        if !(1..=500).contains(&args.limit) {
            return Err(invalid("environment observation limit must be 1..=500"));
        }
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args: ObserveArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        let mut reply = QuerySnapshot {
            target: self.owner.target(),
            source: "R/environment".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Partial,
            data: None,
            notices: Vec::new(),
        };
        let Ok(_lane) = self.owner.lane.try_lock() else {
            reply.notices.push("Project/Workspace is busy.".into());
            return Ok(reply);
        };
        let library = if let Some(id) = &args.realization_operation_id {
            let receipt: EnvironmentRealization = serde_json::from_value(
                self.owner
                    .output(id, REALIZE_CAPABILITY, None)
                    .await
                    .map_err(|e| invalid(e.message))?,
            )
            .map_err(invalid)?;
            Some(receipt.library_path)
        } else {
            self.owner.active_library.clone()
        };
        match self
            .owner
            .runtime
            .observe(library.as_deref(), args.limit)
            .await
        {
            Ok(mut data) => {
                data["active_workspace_library"] = json!(self.owner.active_library);
                reply.status = QueryStatus::Ready;
                reply.data = Some(data);
            }
            Err(error) => {
                reply.status = QueryStatus::Unavailable;
                reply.notices.push(error);
            }
        }
        reply.observed_at_ms = SystemClock.now_ms()?;
        Ok(reply)
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
