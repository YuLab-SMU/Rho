#![forbid(unsafe_code)]
mod directory;
mod storage;
mod text;
pub use directory::{ProjectDirectoryHandler, ProjectSearchHandler};
pub use rho_contract::ProjectStorage;
pub use rho_contract::text::*;
pub use rho_contract::{DirectoryEntry, DirectoryPage, ListDirectoryArguments};
pub use rho_contract::{
    FileObservation, FilePage, GitObservation, GitStatusEntry, ProjectPatchResult, ProjectSnapshot,
};
pub use storage::ProjectStorageHandler;
pub use text::{ProjectReadTextHandler, ProjectSearchTextHandler};
pub use rho_files_api::{ProjectTextError, ProjectRuntime, GitApplyReport, ReadFileArguments,
    ProjectSnapshotArguments, ApplyPatchArguments, PROJECT_READ_SCOPE, PROJECT_WRITE_SCOPE,
    MAX_PROJECT_PATHS, MAX_PATH_BYTES, MAX_PATCH_BYTES, validate_path};

use async_trait::async_trait;
use rho_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef, EffectHint,
    EffectObservation, IdempotencyClass, ObservationCompleteness, Operation, OperationOutcome,
    QuerySnapshot, QueryStatus, RetryClass, TargetRef,
};
use rho_operation::{
    Clock, CommitPlan, DomainFactMutation, HandlerError, OperationError, OperationHandler,
    PlannedEvent, QueryHandler, SystemClock,
};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{Mutex, watch};

pub struct ProjectOwner {
    runtime: Arc<dyn ProjectRuntime>,
    lane: Arc<Mutex<()>>,
}
impl ProjectOwner {
    pub fn new(runtime: Arc<dyn ProjectRuntime>, lane: Arc<Mutex<()>>) -> Self {
        Self { runtime, lane }
    }
    fn target(&self) -> TargetRef {
        TargetRef {
            kind: "project".into(),
            identity: self.runtime.root().into(),
        }
    }
}

fn descriptor(id: &str, kind: CapabilityKind, input: Value, output: Value) -> CapabilityDescriptor {
    let writes = kind == CapabilityKind::Operation;
    CapabilityDescriptor {
        kind,
        capability: CapabilityRef::new(id, 1).unwrap(),
        documentation: rho_contract::builtin_documentation(id),
        recovery_schema: if writes {
            schema_for!(rho_contract::ProjectPatchRecovery).to_value()
        } else {
            serde_json::json!({"type":"null"})
        },
        domain: "project".into(),
        input_schema: input,
        output_schema: output,
        required_scopes: BTreeSet::from([if writes {
            PROJECT_WRITE_SCOPE
        } else {
            PROJECT_READ_SCOPE
        }
        .into()]),
        potential_effects: if writes {
            BTreeSet::from([EffectHint::MayWriteProject, EffectHint::MaySpawnProcess])
        } else {
            BTreeSet::new()
        },
        idempotency: if writes {
            IdempotencyClass::CallerScoped
        } else {
            IdempotencyClass::Pure
        },
        retry: if writes {
            RetryClass::ReconcileFirst
        } else {
            RetryClass::Safe
        },
        cancellation: CancellationClass::Unsupported,
    }
}

pub struct ProjectSnapshotHandler {
    owner: Arc<ProjectOwner>,
    descriptor: CapabilityDescriptor,
}
impl ProjectSnapshotHandler {
    pub fn new(owner: Arc<ProjectOwner>) -> Self {
        Self {
            owner,
            descriptor: descriptor(
                "project.snapshot",
                CapabilityKind::Query,
                schema_for!(ProjectSnapshotArguments).to_value(),
                schema_for!(ProjectSnapshot).to_value(),
            ),
        }
    }
    fn parse(&self, value: &Value) -> Result<ProjectSnapshotArguments, OperationError> {
        let mut args: ProjectSnapshotArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        if args.paths.len() > MAX_PROJECT_PATHS || !(1..=200).contains(&args.limit) {
            return Err(invalid(
                "project snapshot accepts at most 64 paths and a limit of 1..=200",
            ));
        }
        for path in &args.paths {
            validate_path(path).map_err(invalid)?;
        }
        args.paths.sort();
        args.paths.dedup();
        Ok(args)
    }
}
#[async_trait]
impl QueryHandler for ProjectSnapshotHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        serde_json::to_value(self.parse(value)?).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args = self.parse(value)?;
        let mut reply = QuerySnapshot {
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
            target: self.owner.target(),
            source: "git/filesystem".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Partial,
            data: None,
            notices: Vec::new(),
        };
        let Ok(_lane) = self.owner.lane.try_lock() else {
            reply
                .notices
                .push("Project is busy; no filesystem query was submitted.".into());
            return Ok(reply);
        };
        match self.owner.runtime.snapshot(&args.paths, args.limit).await {
            Ok(snapshot) => {
                reply.observed_at_ms = snapshot.observed_at_ms;
                reply.status = QueryStatus::Ready;
                reply.data = Some(serde_json::to_value(snapshot).map_err(invalid)?);
                reply
                    .notices
                    .push("Native observation; external editors are not locked by Rho.".into());
            }
            Err(error) => {
                reply.status = QueryStatus::Unavailable;
                reply.notices.push(error);
            }
        }
        Ok(reply)
    }
}

pub struct ProjectReadHandler {
    owner: Arc<ProjectOwner>,
    descriptor: CapabilityDescriptor,
}
impl ProjectReadHandler {
    pub fn new(owner: Arc<ProjectOwner>) -> Self {
        Self {
            owner,
            descriptor: descriptor(
                "project.read_file",
                CapabilityKind::Query,
                schema_for!(ReadFileArguments).to_value(),
                schema_for!(FilePage).to_value(),
            ),
        }
    }
    fn parse(&self, value: &Value) -> Result<ReadFileArguments, OperationError> {
        let args: ReadFileArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        validate_path(&args.path).map_err(invalid)?;
        if !(1..=65536).contains(&args.limit_bytes) {
            return Err(invalid("file page limit must be 1..=65536 bytes"));
        }
        Ok(args)
    }
}
#[async_trait]
impl QueryHandler for ProjectReadHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        serde_json::to_value(self.parse(value)?).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let args = self.parse(value)?;
        let mut reply = QuerySnapshot {
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
            target: self.owner.target(),
            source: "filesystem".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Partial,
            data: None,
            notices: Vec::new(),
        };
        let Ok(_lane) = self.owner.lane.try_lock() else {
            reply
                .notices
                .push("Project is busy; no file bytes were read.".into());
            return Ok(reply);
        };
        match self.owner.runtime.read_file(&args).await {
            Ok(page) => {
                reply.status = QueryStatus::Ready;
                reply.data = Some(serde_json::to_value(page).map_err(invalid)?);
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

pub struct ProjectPatchHandler {
    owner: Arc<ProjectOwner>,
    descriptor: CapabilityDescriptor,
}
impl ProjectPatchHandler {
    pub fn new(owner: Arc<ProjectOwner>) -> Self {
        Self {
            owner,
            descriptor: descriptor(
                "project.apply_patch",
                CapabilityKind::Operation,
                schema_for!(ApplyPatchArguments).to_value(),
                schema_for!(ProjectPatchResult).to_value(),
            ),
        }
    }
}
#[async_trait]
impl OperationHandler for ProjectPatchHandler {
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.runtime.root().into())
    }
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: ApplyPatchArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        if args.patch.trim().is_empty()
            || args.patch.len() > MAX_PATCH_BYTES
            || args.patch.contains('\0')
        {
            return Err(invalid("patch must contain 1..=204800 non-NUL bytes"));
        }
        serde_json::to_value(args).map_err(invalid)
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
        cancellation: watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        let _lane = self.owner.lane.lock().await;
        if *cancellation.borrow() {
            let mut plan = CommitPlan::succeeded(json!(null));
            plan.outcome = OperationOutcome::Cancelled;
            return Ok(plan);
        }
        let args: ApplyPatchArguments =
            serde_json::from_value(operation.normalized_arguments.clone())
                .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        let paths = self
            .owner
            .runtime
            .patch_paths(&args.patch)
            .await
            .map_err(HandlerError::before_effect)?;
        if paths.is_empty() || paths.len() > MAX_PROJECT_PATHS {
            return Err(HandlerError::before_effect(
                "patch must affect between 1 and 64 paths",
            ));
        }
        let mut observed_paths = paths.clone();
        for condition in &operation.preconditions {
            match condition.kind.as_str() {
                "git.head" if condition.subject == "project" => {}
                "file.sha256" => {
                    validate_path(&condition.subject).map_err(HandlerError::before_effect)?;
                    observed_paths.push(condition.subject.clone());
                }
                _ => {
                    return Err(HandlerError::before_effect(
                        "unsupported project precondition",
                    ));
                }
            }
        }
        observed_paths.sort();
        observed_paths.dedup();
        if observed_paths.len() > MAX_PROJECT_PATHS {
            return Err(HandlerError::before_effect(
                "preconditions exceed the file observation limit",
            ));
        }
        self.owner
            .runtime
            .check_patch(&args.patch)
            .await
            .map_err(HandlerError::before_effect)?;
        let before = self
            .owner
            .runtime
            .snapshot(&observed_paths, 200)
            .await
            .map_err(HandlerError::before_effect)?;
        for condition in &operation.preconditions {
            if condition.kind == "file.sha256"
                && condition.expected.is_null()
                && before
                    .files
                    .iter()
                    .find(|file| file.path == condition.subject)
                    .is_some_and(|file| file.kind != "absent")
            {
                return Err(HandlerError::before_effect(format!(
                    "precondition failed: {} must be absent",
                    condition.subject
                )));
            }
            let observed = match condition.kind.as_str() {
                "git.head" => json!(before.git.as_ref().and_then(|git| git.head.as_ref())),
                _ => json!(
                    before
                        .files
                        .iter()
                        .find(|file| file.path == condition.subject)
                        .and_then(|file| file.sha256.as_ref())
                ),
            };
            if observed != condition.expected {
                return Err(HandlerError::before_effect(format!(
                    "precondition failed for {}: {}",
                    condition.kind, condition.subject
                )));
            }
        }
        let report = self.owner.runtime.apply_patch(&args.patch).await;
        let after = self.owner.runtime.snapshot(&observed_paths, 200).await.map_err(|error|
            HandlerError::after_possible_effect(error, Some(json!({"project_root":self.owner.runtime.root(), "before":before, "affected_paths":paths}))))?;
        let changed_paths = paths
            .iter()
            .filter(|path| {
                before.files.iter().find(|file| &file.path == *path)
                    != after.files.iter().find(|file| &file.path == *path)
            })
            .cloned()
            .collect::<Vec<_>>();
        let git_identity_changed = before
            .git
            .as_ref()
            .map(|git| (&git.repository_root, &git.head))
            != after
                .git
                .as_ref()
                .map(|git| (&git.repository_root, &git.head));
        let outcome = if git_identity_changed {
            OperationOutcome::Uncertain
        } else if report.exit_code == Some(0) {
            OperationOutcome::Succeeded
        } else if report.exit_code.is_some() && changed_paths.is_empty() {
            OperationOutcome::Failed
        } else {
            OperationOutcome::Uncertain
        };
        let error = (outcome != OperationOutcome::Succeeded).then(|| {
            if git_identity_changed {
                "Git identity changed while the patch was applied".into()
            } else {
                report.diagnostic.clone()
            }
        });
        let result = ProjectPatchResult {
            before,
            after,
            affected_paths: paths,
            changed_paths,
            git_exit_code: report.exit_code,
            diagnostic: report.diagnostic,
            committed_to_git: false,
        };
        let mut plan = CommitPlan::succeeded(
            serde_json::to_value(&result)
                .map_err(|e| HandlerError::after_possible_effect(e.to_string(), None))?,
        );
        plan.outcome = outcome;
        plan.error = error;
        if outcome == OperationOutcome::Uncertain {
            plan.recovery = Some(
                json!({"action":"query_project_snapshot_before_retry", "root":self.owner.runtime.root(), "affected_paths":result.affected_paths}),
            );
        }
        plan.facts.push(DomainFactMutation { domain:"project".into(), schema:"rho.project.patch.v1".into(),
            key:operation.operation_id.as_str().into(), value:json!({"operation_id":operation.operation_id,"root":self.owner.runtime.root(),"changed_paths":result.changed_paths}) });
        plan.effect_observations.push(EffectObservation { kind:"project_files".into(), source:"git/filesystem".into(),
            detail:json!({"changed_paths":result.changed_paths,"head":result.after.git.as_ref().and_then(|git| git.head.as_ref())}),
            observed_at_ms:result.after.observed_at_ms, completeness:ObservationCompleteness::Partial });
        plan.events.push(PlannedEvent {kind:"project.patch_observed".into(), payload:json!({"changed_paths":result.changed_paths,"git_exit_code":result.git_exit_code})});
        Ok(plan)
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
