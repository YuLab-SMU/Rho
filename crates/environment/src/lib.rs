#![forbid(unsafe_code)]

mod retention;
use async_trait::async_trait;
pub use retention::*;
use rho_contract::{
    CallerIdentity, CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef,
    EffectHint, IdempotencyClass, NextRead, ObservationCompleteness, Operation, OperationOutcome,
    OperationRecord, QuerySnapshot, QueryStatus, RetryClass, TargetRef,
};
use rho_operation::{
    Clock, CommitPlan, DomainFactMutation, HandlerError, OperationError, OperationHandler,
    OperationRecords, PlannedEvent, QueryHandler, SystemClock, wait_cancellation,
};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{Mutex, watch};

pub const ENVIRONMENT_READ_SCOPE: &str = "environment.read";
pub const ENVIRONMENT_WRITE_SCOPE: &str = "environment.write";
pub const PLAN_CAPABILITY: &str = "environment.plan";
pub const REALIZE_CAPABILITY: &str = "environment.realize";
pub const VERIFY_CAPABILITY: &str = "environment.verify";
pub const RECONCILE_CAPABILITY: &str = "environment.reconcile";

pub use rho_contract::{
    EnvironmentMaterialRecovery, EnvironmentObservation, EnvironmentPlan, EnvironmentRealization,
    EnvironmentRealizeRecovery, EnvironmentReconcileRecovery, EnvironmentReconciliation,
    EnvironmentRuntimeRecovery, EnvironmentStageRecovery, InstalledEnvironmentPackage,
    NamespaceProbe, ObserveArguments, PackageVersion, PlanArguments, RealizeArguments,
    ReconcileArguments, SourceDigest, Verification, VerifyArguments,
};

#[async_trait]
pub trait EnvironmentRuntime: Send + Sync {
    fn root(&self) -> &str;
    async fn observe(
        &self,
        library: Option<&str>,
        limit: usize,
    ) -> Result<EnvironmentObservation, String>;
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
    async fn material_state(
        &self,
        source_id: &str,
        kind: MaterialKind,
        cleanup_id: Option<&str>,
    ) -> Result<MaterialState, String>;
    async fn change_material(
        &self,
        source_id: &str,
        kind: MaterialKind,
        cleanup_id: &str,
        action: MaterialAction,
        expected_fingerprint: &str,
    ) -> Result<MaterialChange, HandlerError>;
}

pub struct EnvironmentOwner {
    pub runtime: Arc<dyn EnvironmentRuntime>,
    records: Arc<dyn OperationRecords>,
    lane: Arc<Mutex<()>>,
    active_library: Option<String>,
    has_workspace: bool,
    usage: Option<Arc<dyn EnvironmentUsage>>,
}
impl EnvironmentOwner {
    pub fn new(
        runtime: Arc<dyn EnvironmentRuntime>,
        records: Arc<dyn OperationRecords>,
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
            usage: None,
        }
    }
    pub fn with_usage(mut self, usage: Option<Arc<dyn EnvironmentUsage>>) -> Self {
        self.usage = usage;
        self
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
        if record.status != rho_contract::OperationStatus::Succeeded
            || record.operation.capability.id != capability
            || record.operation.idempotency_scope.as_deref() != Some(self.runtime.root())
            || caller.is_some_and(|caller| record.operation.principal() != caller)
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
            || record.operation.principal() != caller
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
                documentation: documentation(id),
                recovery_schema: match action {
                    EnvironmentAction::Plan | EnvironmentAction::Verify => {
                        schema_for!(Option<EnvironmentRuntimeRecovery>).to_value()
                    }
                    EnvironmentAction::Realize => {
                        schema_for!(Option<EnvironmentRealizeRecovery>).to_value()
                    }
                    EnvironmentAction::Reconcile => {
                        schema_for!(Option<EnvironmentReconcileRecovery>).to_value()
                    }
                },
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
            EnvironmentAction::Realize => {
                let args: RealizeArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                rho_contract::OperationId::new(&args.plan_operation_id).map_err(invalid)?;
                serde_json::to_value(args).map_err(invalid)
            }
            EnvironmentAction::Verify => {
                let args: VerifyArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                rho_contract::OperationId::new(&args.realization_operation_id).map_err(invalid)?;
                serde_json::to_value(args).map_err(invalid)
            }
            EnvironmentAction::Reconcile => {
                let args: ReconcileArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                rho_contract::OperationId::new(&args.operation_id).map_err(invalid)?;
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
                            Some(operation.principal()),
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
                            Some(operation.principal()),
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
                    .recovery_source(&args.operation_id, operation.principal())
                    .await?;
                let report = self.owner.runtime.reconcile(&args.operation_id).await?;
                successful = report.cleanup_confirmed;
                if !successful {
                    recovery = Some(json!(EnvironmentReconcileRecovery {
                        source_operation_id: args.operation_id,
                        process_tree_marker: report.native_marker.clone(),
                        action: "inspect_owner_without_automatic_reexecution".into(),
                    }));
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
                documentation: documentation("environment.observe"),
                recovery_schema: serde_json::json!({"type":"null"}),
                domain: "environment".into(),
                input_schema: schema_for!(ObserveArguments).to_value(),
                output_schema: schema_for!(EnvironmentObservation).to_value(),
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
        if let Some(id) = &args.realization_operation_id {
            rho_contract::OperationId::new(id).map_err(invalid)?;
        }
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args: ObserveArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        let mut reply = QuerySnapshot {
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
            target: self.owner.target(),
            source: "environment/cached-native-configuration-and-filesystem".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Partial,
            data: None,
            notices: Vec::new(),
        };
        let Ok(_lane) = self.owner.lane.try_lock() else {
            reply.notices.push("Project/Workspace is busy.".into());
            reply.diagnostics.push(
                OperationError::ProjectBusy("Project/Workspace is busy.".into()).diagnostic(),
            );
            return Ok(reply);
        };
        let library = if let Some(id) = &args.realization_operation_id {
            reply.next_reads.push(NextRead::query(
                "operation.list_recent",
                "Read the original realization record and recovery identity.",
                json!({"operation_id":id,"limit":1}),
            ));
            reply.next_reads.push(NextRead::query(
                "environment.retention",
                "Inspect material and its current cleanup fingerprint.",
                json!({"operation_id":id}),
            ));
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
                data.active_workspace_library = self.owner.active_library.clone();
                reply.observed_at_ms = data.inventory_observed_at_ms;
                reply.notices.extend(data.notices.clone());
                reply.status = QueryStatus::Ready;
                reply.data = Some(serde_json::to_value(data).map_err(invalid)?);
            }
            Err(error) => {
                reply.status = QueryStatus::Unavailable;
                reply
                    .diagnostics
                    .push(OperationError::Unavailable(error.clone()).diagnostic());
                reply.notices.push(error);
            }
        }
        Ok(reply)
    }
}
fn documentation(id: &str) -> rho_contract::CapabilityDocumentation {
    use rho_contract::CapabilityPrecondition;
    let mut documentation = rho_contract::builtin_documentation(id);
    let precondition = match id {
        REALIZE_CAPABILITY => Some((
            "plan_operation_id",
            "Reference a succeeded environment.plan operation in this project and caller scope. Its lock_digest, local source digests and selected R version/platform must still match native bytes and configuration.",
        )),
        VERIFY_CAPABILITY => Some((
            "realization_operation_id",
            "Reference a succeeded environment.realize operation in this project and caller scope. Verification uses its exact library_path and library_digest; it executes native namespace probes.",
        )),
        RECONCILE_CAPABILITY => Some((
            "operation_id",
            "Reference the original terminal environment.plan, realize or verify operation in this project and caller scope. Its durable native marker is required to confirm cleanup; reconciliation never reruns the original action.",
        )),
        "environment.cleanup" => Some((
            "operation_id and expected_fingerprint",
            "Use the original failed/cancelled plan or realization and material.stage.fingerprint from environment.retention. Successful/live/uncertain/referenced material is protected.",
        )),
        "environment.restore_cleanup" | "environment.purge_cleanup" => Some((
            "cleanup_operation_id and expected_fingerprint",
            "Use the original environment.cleanup identity and material.trash.fingerprint from environment.cleanup_status. Native state is checked again immediately before the requested change.",
        )),
        _ => None,
    };
    if let Some((parameter, requirement)) = precondition {
        let read = match id {
            "environment.cleanup" => "environment.retention",
            "environment.restore_cleanup" | "environment.purge_cleanup" => {
                "environment.cleanup_status"
            }
            _ => "operation.list_recent",
        };
        documentation.preconditions.push(CapabilityPrecondition {
            parameter: parameter.into(),
            requirement: requirement.into(),
            read_from: Some(CapabilityRef::new(read, 1).unwrap()),
        });
    }
    if id == "environment.observe" {
        documentation.purpose = "Read established native configuration and current bounded filesystem DESCRIPTION metadata. configuration_observed_at_ms/source identify the cached runtime/tool facts; inventory_observed_at_ms identifies package metadata. This query never starts R, loads a namespace, tests loadability, or refreshes native configuration.".into();
        documentation.limitations.push("Cached renv_available/pak_available describe the stated startup or operation probe, not current loadability. Missing startup evidence is Unavailable; changes to native configuration require an explicit lifecycle or Environment operation.".into());
    }
    if matches!(
        id,
        "environment.cleanup" | "environment.restore_cleanup" | "environment.purge_cleanup"
    ) {
        for example in &mut documentation.examples {
            example.arguments["expected_fingerprint"] = json!(format!("sha256:{}", "0".repeat(64)));
        }
    }
    if matches!(
        id,
        RECONCILE_CAPABILITY
            | "environment.cleanup"
            | "environment.restore_cleanup"
            | "environment.purge_cleanup"
    ) {
        documentation.cancellation_rule = "This operation does not support cancellation. Cancelling a transport wait neither undoes filesystem changes nor stops native reconciliation; inspect the original operation until its owner reports an outcome.".into();
    }
    documentation.related_capabilities = match id {
        PLAN_CAPABILITY => vec!["operation.list_recent", REALIZE_CAPABILITY],
        REALIZE_CAPABILITY => vec![
            "operation.list_recent",
            VERIFY_CAPABILITY,
            "environment.observe",
            "environment.retention",
        ],
        VERIFY_CAPABILITY | RECONCILE_CAPABILITY => {
            vec!["operation.list_recent", "environment.observe"]
        }
        "environment.cleanup" | "environment.restore_cleanup" | "environment.purge_cleanup" => {
            vec!["environment.cleanup_status", "operation.list_recent"]
        }
        _ => vec!["operation.list_recent"],
    }
    .into_iter()
    .map(|id| CapabilityRef::new(id, 1).unwrap())
    .collect();
    documentation
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
