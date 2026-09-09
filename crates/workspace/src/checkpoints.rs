//! Checkpoint metadata becomes authoritative only through the shared operation journal.
use crate::{WorkspaceRuntime, WorkspaceRuntimeError};
use async_trait::async_trait;
use rho_contract::*;
use rho_operation::{CapabilityRegistry, Clock, CommitPlan, DomainFactMutation, ExecutionLease, HandlerError, OperationError, OperationHandler, OperationJournal, PlannedEvent, QueryHandler, SystemClock};
use schemars::schema_for;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}};
use tokio::sync::{OwnedMutexGuard, watch};

pub struct CheckpointArtifact { pub report: CheckpointNativeReport, pub sha256: String, pub byte_size: u64 }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointControlEvidence { pub operation_id: OperationId, pub report: CheckpointControlReport, pub at_ms: i64 }
pub struct WorkspaceCheckpointOwner {
    runtime: Arc<dyn WorkspaceRuntime>, lane: Arc<tokio::sync::Mutex<()>>,
    queue: Mutex<Option<Arc<crate::ConsoleQueue>>>,
    journal: Arc<dyn OperationJournal>, instance: String, lineage: String,
    environment: Mutex<Option<String>>, activity: Arc<AtomicU64>,
}
impl WorkspaceCheckpointOwner {
    pub fn new(runtime: Arc<dyn WorkspaceRuntime>, lane: Arc<tokio::sync::Mutex<()>>, journal: Arc<dyn OperationJournal>, logical_instance_id: String, continuation_lineage_id: String, activity_boundary: Arc<AtomicU64>) -> Self {
        Self { runtime, lane, queue:Mutex::new(None), journal, instance: logical_instance_id, lineage: continuation_lineage_id, environment: Mutex::new(None), activity: activity_boundary }
    }
    pub fn set_scientific_queue(&self,queue:Arc<crate::ConsoleQueue>) { *self.queue.lock().unwrap_or_else(|e|e.into_inner())=Some(queue); }
    pub fn set_capture_context(&self, environment_fingerprint: Option<String>, activity_boundary: u64) {
        *self.environment.lock().unwrap_or_else(|e|e.into_inner()) = environment_fingerprint;
        self.activity.store(activity_boundary, Ordering::Release);
    }
    pub fn capture_available(&self) -> bool { self.runtime.checkpoint_available() }
    fn project(&self) -> &str { self.runtime.project_root().unwrap_or_default() }
    async fn entry(&self, context: &CallContext, manifest: CheckpointManifest, source_instance:&str, lineage:Option<&str>) -> Result<Option<CheckpointEntry>, OperationError> {
        if manifest.workspace_instance_id != source_instance || lineage.is_some_and(|value|manifest.continuation_lineage_id!=value) { return Ok(None); }
        let Some(record) = self.journal.get(&manifest.checkpoint_id).await? else { return Ok(None) };
        if record.operation.principal() != context.principal() || record.operation.idempotency_scope.as_deref() != Some(self.project()) || record.outcome != Some(OperationOutcome::Succeeded) || record.operation.capability.id != "workspace.checkpoint_capture" { return Ok(None); }
        if record.output.as_ref() != Some(&json!(manifest)) { return Ok(None); }
        let mut pinned = false;
        let mut controls = self.runtime.checkpoint_control_evidence(&manifest.checkpoint_id).await.map_err(native_query)?;
        controls.sort_by_key(|e| (e.at_ms, e.operation_id.as_str().to_string()));
        for evidence in controls {
            let Some(record) = self.journal.get(&evidence.operation_id).await? else { continue };
            if record.operation.principal() != context.principal() || record.operation.idempotency_scope.as_deref() != Some(self.project()) || record.outcome != Some(OperationOutcome::Succeeded) || record.output != Some(json!(evidence.report)) { continue; }
            if evidence.report.deleted && record.operation.capability.id == "workspace.checkpoint_delete" { return Ok(None); }
            if record.operation.capability.id == "workspace.checkpoint_pin" { pinned = evidence.report.pinned; }
        }
        let available = self.runtime.checkpoint_present(&manifest).await.map_err(native_query)?;
        Ok(Some(CheckpointEntry { manifest, pinned, available }))
    }
    async fn journal_page(&self,context:&CallContext,before:Option<u64>,limit:u32,lineage:Option<&str>)->Result<RecentOperations,OperationError>{
        self.journal.list_recent_for_capability(self.project(),context.principal(),&RecentOperationsArguments {before_cursor:before,client_request_id:None,operation_id:None,limit},&rho_operation::OperationRecordFilter {capability:CapabilityRef::new("workspace.checkpoint_capture",1).unwrap(),workspace_instance_id:Some(self.instance.clone()),continuation_lineage_id:lineage.map(str::to_string)}).await
    }
    pub async fn list_for(&self, context: &CallContext, args: &CheckpointListArguments) -> Result<CheckpointList, OperationError> {
        if args.limit == 0 || args.limit > 50 { return Err(invalid("Checkpoint page limit must be 1..=50")); }
        let before=args.before.as_deref().map(str::parse::<u64>).transpose().map_err(|_|invalid("Invalid checkpoint catalog cursor"))?;
        let page=self.journal_page(context,before,args.limit,None).await?;
        let mut entries=Vec::new();
        for summary in page.operations {
            let Some(record)=self.journal.get(&summary.operation_id).await? else {continue};
            let Some(output)=record.output else {continue};
            let manifest:CheckpointManifest=serde_json::from_value(output).map_err(|e|OperationError::Contract(e.to_string()))?;
            if let Some(entry)=self.entry(context,manifest,&self.instance,None).await?{entries.push(entry);}
        }
        Ok(CheckpointList {entries,next:page.next_cursor.map(|c|c.to_string()),native_capture_available:self.capture_available(),notice:(!self.capture_available()&&!self.runtime.checkpoint_archive_only()).then(||"Native checkpoint component is unavailable for this R installation; objects are not automatically protected.".into())})
    }
    pub async fn latest_for(&self,context:&CallContext)->Result<Option<CheckpointEntry>,OperationError>{
        let mut before=None;
        for _ in 0..2 {
            let page=self.journal_page(context,before,50,Some(&self.lineage)).await?;
            for summary in page.operations {
                let Some(record)=self.journal.get(&summary.operation_id).await? else {continue};
                let Some(output)=record.output else {continue};
                let manifest:CheckpointManifest=serde_json::from_value(output).map_err(|e|OperationError::Contract(e.to_string()))?;
                if let Some(entry)=self.entry(context,manifest,&self.instance,Some(&self.lineage)).await?{return Ok(Some(entry));}
            }
            before=page.next_cursor;if before.is_none(){return Ok(None)}
        }
        Err(OperationError::Unavailable("Newest retained checkpoint is beyond the bounded control-history scan; open Recovery copies explicitly.".into()))
    }
    pub async fn source_manifest_for(&self,context:&CallContext,id:&OperationId,source_instance:&str)->Result<CheckpointManifest,OperationError>{
        Ok(self.required_from(context,id,source_instance,None).await?.manifest)
    }
    async fn required_from(&self,context:&CallContext,id:&OperationId,source_instance:&str,lineage:Option<&str>)->Result<CheckpointEntry,OperationError>{
        let record=self.journal.get(id).await?.ok_or_else(||invalid("Checkpoint not found"))?;
        // The shared original operation record is the authority, not a directory scan.
        let manifest:CheckpointManifest=serde_json::from_value(record.output.ok_or_else(||invalid("Checkpoint has no committed manifest"))?).map_err(|_|invalid("Operation does not contain a checkpoint manifest"))?;
        self.entry(context,manifest,source_instance,lineage).await?.ok_or_else(||invalid("Checkpoint is deleted, uncommitted, or outside this caller/project/source instance"))
    }
    async fn required(&self,context:&CallContext,id:&OperationId)->Result<CheckpointEntry,OperationError>{self.required_from(context,id,&self.instance,None).await}

}
fn invalid(message: impl Into<String>) -> OperationError { OperationError::InvalidInput(message.into()) }
fn native_query(error: WorkspaceRuntimeError) -> OperationError { OperationError::Unavailable(error.message) }
fn native(error: WorkspaceRuntimeError) -> HandlerError {
    if error.effect_may_have_occurred { HandlerError::after_possible_effect(error.message,error.recovery) } else { HandlerError::before_effect(error.message) }
}
fn context(operation: &Operation) -> CallContext { CallContext { caller:operation.caller.clone(), principal:Some(operation.principal().clone()), scopes:BTreeSet::new(), connection_id:"checkpoint-owner".into(), correlation_id:Some(operation.correlation_id.clone()),causation_id:Some(operation.operation_id.clone()),trace_parent:operation.trace_parent.clone() } }

#[derive(Clone, Copy)] enum Action { Capture, Restore, Pin, Delete }
struct CheckpointHandler { owner: Arc<WorkspaceCheckpointOwner>, action: Action, descriptor: CapabilityDescriptor }
struct MaintenanceLease { _lane: OwnedMutexGuard<()>, runtime: Arc<dyn WorkspaceRuntime>, delete: Option<OperationId> }
impl ExecutionLease for MaintenanceLease {
    fn completed(&mut self, result: &Result<OperationRecord, OperationError>) {
        // Storage maintenance failure cannot pause scientific queue items. Uncertain native
        // state is surfaced by the operation and lifecycle owner, never converted to success.
        if result.as_ref().is_ok_and(|r|r.outcome == Some(OperationOutcome::Succeeded)) {
            if let Some(id) = &self.delete { let _ = self.runtime.checkpoint_remove_payload(id); }
        }
    }
}
fn descriptor(id: &str, summary: &str, input: Value, output: Value, query: bool) -> CapabilityDescriptor {
    CapabilityDescriptor {
        kind: if query { CapabilityKind::Query } else { CapabilityKind::Operation }, capability: CapabilityRef::new(id,1).unwrap(), domain:"workspace".into(),
        input_schema:input, output_schema:output, recovery_schema: if query {json!({"type":"null"})} else {schema_for!(Option<CheckpointRecovery>).to_value()},
        required_scopes:BTreeSet::from([if query {"workspace.read".into()} else {"workspace.run_r".into()}]),
        potential_effects:if query {BTreeSet::new()} else {BTreeSet::from([EffectHint::ProducesArtifact,EffectHint::MayMutateRuntime])},
        idempotency:if query {IdempotencyClass::Pure} else {IdempotencyClass::CallerScoped}, retry:if query {RetryClass::Safe} else {RetryClass::ReconcileFirst}, cancellation:if query {CancellationClass::Unsupported} else {CancellationClass::Cooperative},
        documentation:CapabilityDocumentation { summary:summary.into(), purpose:"Protect or recover a conservative R object graph through the Workspace owner and shared operation journal.".into(), when_to_use:vec![summary.into()], limitations:vec!["Object storage is not a complete R process image. Unsupported graphs remain explicit; no scientific code is replayed.".into()], owner:"Workspace".into(), effects:if query {"Read committed checkpoint metadata without starting R.".into()} else {"Capture immutable files or restore objects into an empty candidate session.".into()}, retry_rule:"Read the original operation before retrying; do not replay uncertain restoration.".into(), cancellation_rule:"Capture is cooperative and bounded; cancellation is not rollback of restored assignments.".into(), preconditions:vec![],examples:vec![],related_capabilities:vec![],related_skills:vec![],position_units:vec![] }
    }
}
impl CheckpointHandler {
    fn new(owner: Arc<WorkspaceCheckpointOwner>, action: Action) -> Self {
        let (id,summary,input,output) = match action {
            Action::Capture => ("workspace.checkpoint_capture","Save R objects",schema_for!(CheckpointCaptureArguments).to_value(),schema_for!(CheckpointManifest).to_value()),
            Action::Restore => ("workspace.checkpoint_restore","Restore R objects in an empty candidate",schema_for!(CheckpointRestoreArguments).to_value(),schema_for!(CheckpointRestoreReport).to_value()),
            Action::Pin => ("workspace.checkpoint_pin","Retain a checkpoint",schema_for!(CheckpointControlArguments).to_value(),schema_for!(CheckpointControlReport).to_value()),
            Action::Delete => ("workspace.checkpoint_delete","Delete a checkpoint",schema_for!(CheckpointControlArguments).to_value(),schema_for!(CheckpointControlReport).to_value()),
        }; Self {owner,action,descriptor:descriptor(id,summary,input,output,false)}
    }
}
#[async_trait]
impl OperationHandler for CheckpointHandler {
    fn descriptor(&self) -> &CapabilityDescriptor { &self.descriptor }
    fn idempotency_scope(&self) -> Option<String> { Some(self.owner.project().into()) }
    fn normalize_arguments(&self, value: &Value) -> Result<Value,OperationError> {
        match self.action {
            Action::Capture => {
                let a:CheckpointCaptureArguments=serde_json::from_value(value.clone()).map_err(|e|invalid(e.to_string()))?;
                if a.expected_session.is_empty() || a.max_bytes < 1024 || a.max_bytes > 16*1024*1024*1024 || a.max_seconds == 0 || a.max_seconds > 300 { return Err(invalid("Capture requires a native session, 1 KiB..16 GiB and 1..300 seconds")); }
                for names in a.include_names.iter().chain(std::iter::once(&a.exclude_names)) { if names.len()>10000 || names.iter().any(|n|n.is_empty() || n.len()>4096 || n.contains('\0')) {return Err(invalid("Invalid capture binding selection"));} }
                for patterns in [&a.include_patterns,&a.exclude_patterns] {if patterns.len()>32||patterns.iter().any(|p|p.is_empty()||p.len()>1024||p.contains('\0')){return Err(invalid("Capture supports at most 32 bounded glob patterns per selection"));}}
                Ok(json!(a))
            }
            Action::Restore => Ok(json!(serde_json::from_value::<CheckpointRestoreArguments>(value.clone()).map_err(|e|invalid(e.to_string()))?)),
            _ => Ok(json!(serde_json::from_value::<CheckpointControlArguments>(value.clone()).map_err(|e|invalid(e.to_string()))?)),
        }
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef,OperationError> { Ok(if matches!(self.action,Action::Pin|Action::Delete) {TargetRef {kind:"workspace_instance".into(),identity:self.owner.instance.clone()}} else {TargetRef {kind:"workspace".into(),identity:self.owner.runtime.session_id().into()}}) }
    async fn acquire_execution(&self, operation: &Operation, mut cancellation: watch::Receiver<bool>) -> Result<Box<dyn ExecutionLease>,HandlerError> {
        let lane = if operation.normalized_arguments["automatic"] == true {
            match self.owner.queue.lock().unwrap_or_else(|e|e.into_inner()).as_ref() {
                Some(queue)=>queue.try_acquire_maintenance(self.owner.lane.clone())?,
                None=>return Err(HandlerError::before_effect("Automatic checkpoint queue coordination unavailable")),
            }
        } else { tokio::select! { guard = self.owner.lane.clone().lock_owned() => guard, _ = cancellation.changed() => return Err(HandlerError::before_effect("Checkpoint operation cancelled before native work")) } };
        let delete = if matches!(self.action,Action::Delete) { Some(serde_json::from_value::<CheckpointControlArguments>(operation.normalized_arguments.clone()).map_err(|e|HandlerError::before_effect(e.to_string()))?.checkpoint_id) } else { None };
        Ok(Box::new(MaintenanceLease {_lane:lane,runtime:self.owner.runtime.clone(),delete}))
    }
    async fn execute(&self, op: &Operation) -> Result<CommitPlan,HandlerError> { self.execute_controlled(op,watch::channel(false).1).await }
    async fn execute_controlled(&self, op: &Operation, cancellation: watch::Receiver<bool>) -> Result<CommitPlan,HandlerError> {
        if *cancellation.borrow() { return Ok(CommitPlan::cancelled_before_start()); }
        let expected_target=if matches!(self.action,Action::Pin|Action::Delete){self.owner.instance.as_str()}else{self.owner.runtime.session_id()};
        if op.target.identity != expected_target {return Err(HandlerError::before_effect("Checkpoint target changed"));}
        for p in &op.preconditions { if p.kind != "workspace.session" || p.subject != "active" || p.expected.as_str() != Some(self.owner.runtime.session_id()) {return Err(HandlerError::before_effect("Unsupported or stale checkpoint precondition"));} }
        let context = context(op);
        let output = match self.action {
            Action::Capture => {
                let args:CheckpointCaptureArguments=serde_json::from_value(op.normalized_arguments.clone()).map_err(|e|HandlerError::before_effect(e.to_string()))?;
                if args.expected_session != self.owner.runtime.session_id() {return Err(HandlerError::before_effect("Capture names a stale native session"));}
                let artifact=self.owner.runtime.checkpoint_capture(op,&args,cancellation).await.map_err(native)?;
                let manifest=CheckpointManifest {checkpoint_id:op.operation_id.clone(),workspace_instance_id:self.owner.instance.clone(),native_session_id:self.owner.runtime.session_id().into(),continuation_lineage_id:self.owner.lineage.clone(),environment_fingerprint:self.owner.environment.lock().unwrap_or_else(|e|e.into_inner()).clone(),activity_boundary:self.owner.activity.load(Ordering::Acquire),created_at_ms:SystemClock.now_ms().map_err(|e|HandlerError::before_effect(e.to_string()))?,sha256:artifact.sha256,byte_size:artifact.byte_size,report:artifact.report,automatic:args.automatic,validation:"integrity_verified; graph_classified; functional_equivalence_not_asserted".into()};
                self.owner.runtime.checkpoint_publish(&manifest).await.map_err(native)?; json!(manifest)
            }
            Action::Restore => {
                let args:CheckpointRestoreArguments=serde_json::from_value(op.normalized_arguments.clone()).map_err(|e|HandlerError::before_effect(e.to_string()))?;
                if args.expected_session != self.owner.runtime.session_id() {return Err(HandlerError::before_effect("Restore names a stale candidate session"));}
                if args.source_workspace_instance_id.is_some()!=args.source_continuation_lineage_id.is_some(){return Err(HandlerError::before_effect("Source instance and continuation lineage are required together"));}
                let source=args.source_workspace_instance_id.as_deref().unwrap_or(&self.owner.instance);
                let lineage=args.source_continuation_lineage_id.as_deref().unwrap_or(&self.owner.lineage);
                let entry=self.owner.required_from(&context,&args.checkpoint_id,source,Some(lineage)).await.map_err(|e|HandlerError::before_effect(e.to_string()))?;
                if !entry.available {return Err(HandlerError::before_effect("Checkpoint artifact missing or corrupt"));}
                if entry.manifest.environment_fingerprint != *self.owner.environment.lock().unwrap_or_else(|e|e.into_inner()) {return Err(HandlerError::before_effect("Bound Environment fingerprint differs"));}
                let names=self.owner.runtime.checkpoint_restore(op,&entry.manifest,cancellation).await.map_err(native)?;
                json!(CheckpointRestoreReport {checkpoint_id:args.checkpoint_id,native_session_id:self.owner.runtime.session_id().into(),restored_names:names,skipped:entry.manifest.report.skipped,validation:"structural_read_verified; functional_equivalence_not_asserted".into()})
            }
            Action::Pin | Action::Delete => {
                let args:CheckpointControlArguments=serde_json::from_value(op.normalized_arguments.clone()).map_err(|e|HandlerError::before_effect(e.to_string()))?;
                let entry=self.owner.required(&context,&args.checkpoint_id).await.map_err(|e|HandlerError::before_effect(e.to_string()))?;
                if matches!(self.action,Action::Delete) && entry.pinned { return Err(HandlerError::before_effect("Unpin the retained checkpoint before deleting it")); }
                let report=CheckpointControlReport {checkpoint_id:args.checkpoint_id,pinned:args.pinned,deleted:matches!(self.action,Action::Delete)};
                self.owner.runtime.checkpoint_write_control(&CheckpointControlEvidence {operation_id:op.operation_id.clone(),report:report.clone(),at_ms:SystemClock.now_ms().map_err(|e|HandlerError::before_effect(e.to_string()))?}).await.map_err(native)?; json!(report)
            }
        };
        let mut plan=CommitPlan::succeeded(output.clone());
        plan.facts.push(DomainFactMutation {domain:"workspace".into(),schema:format!("rho.{}.v1",op.capability.id),key:op.operation_id.as_str().into(),value:output.clone()});
        plan.events.push(PlannedEvent {kind:format!("{}.completed",op.capability.id),payload:output}); Ok(plan)
    }
}
struct CheckpointsQuery { owner: Arc<WorkspaceCheckpointOwner>, descriptor:CapabilityDescriptor }
#[async_trait]
impl QueryHandler for CheckpointsQuery {
    fn normalize_arguments(&self,value:&Value)->Result<Value,OperationError>{let a:CheckpointListArguments=serde_json::from_value(value.clone()).map_err(|e|invalid(e.to_string()))?;if a.limit==0||a.limit>50{return Err(invalid("Checkpoint limit must be 1..=50"));}Ok(json!(a))}
    fn descriptor(&self)->&CapabilityDescriptor {&self.descriptor}
    async fn query(&self,_:&Value)->Result<QuerySnapshot,OperationError>{Err(invalid("Caller context required"))}
    async fn query_for(&self,context:&CallContext,value:&Value)->Result<QuerySnapshot,OperationError>{
        let args:CheckpointListArguments=serde_json::from_value(value.clone()).map_err(|e|invalid(e.to_string()))?;
        let result=self.owner.list_for(context,&args).await?;
        Ok(QuerySnapshot {target:TargetRef {kind:"workspace_instance".into(),identity:self.owner.instance.clone()},source:"workspace.checkpoints/journal".into(),observed_at_ms:SystemClock.now_ms()?,status:QueryStatus::Ready,completeness:if result.next.is_some(){ObservationCompleteness::Partial}else{ObservationCompleteness::Complete},data:Some(json!(result)),notices:vec![],next_reads:vec![],diagnostics:vec![]})
    }
}
pub fn register_checkpoint_handlers(registry:&mut CapabilityRegistry,owner:Arc<WorkspaceCheckpointOwner>)->Result<(),OperationError>{
    for action in [Action::Capture,Action::Restore,Action::Pin,Action::Delete] { registry.register(Arc::new(CheckpointHandler::new(owner.clone(),action)))?; }
    registry.register_query(Arc::new(CheckpointsQuery {owner,descriptor:descriptor("workspace.checkpoints","Read saved object checkpoints",schema_for!(CheckpointListArguments).to_value(),schema_for!(CheckpointList).to_value(),true)}))?; Ok(())
}
