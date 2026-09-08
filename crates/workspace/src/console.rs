use super::*;
use rho_contract::OperationRecord;
use rho_contract::{ConsoleState, InputRequest, QueuePause, QueuedRun};
use rho_operation::ExecutionLease;
use std::{
    collections::{BTreeSet, VecDeque},
    sync::Mutex,
};
use tokio::sync::{OwnedMutexGuard, watch};

#[derive(Default)]
struct QueueData {
    pending: VecDeque<QueuedRun>,
    current: Option<QueuedRun>,
    reserved: Option<rho_contract::OperationId>,
    pause: Option<QueuePause>,
    cancelled: BTreeSet<String>,
    serial: u64,
    controls_pending: usize,
    closing: bool,
    principals: std::collections::BTreeMap<rho_contract::OperationId, rho_contract::CallerIdentity>,
}
pub struct ConsoleQueue {
    data: Mutex<QueueData>,
    changed: watch::Sender<u64>,
}
impl Default for ConsoleQueue {
    fn default() -> Self {
        Self {
            data: Mutex::new(QueueData::default()),
            changed: watch::channel(0).0,
        }
    }
}
impl ConsoleQueue {
    pub fn snapshot(&self, session_id: &str, input: Option<InputRequest>) -> ConsoleState {
        let d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        ConsoleState {
            session_id: session_id.into(),
            current: d.current.clone(),
            pending: d.pending.iter().cloned().collect(),
            pause: d.pause.clone(),
            input,
        }
    }
    pub fn visible_snapshot(
        &self,
        session_id: &str,
        input: Option<InputRequest>,
        principal: &rho_contract::CallerIdentity,
    ) -> ConsoleState {
        let mut snapshot = self.snapshot(session_id, input);
        let d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        let visible = |id: &rho_contract::OperationId| d.principals.get(id) == Some(principal);
        snapshot.pending.retain(|r| visible(&r.operation_id));
        if snapshot
            .current
            .as_ref()
            .is_some_and(|r| !visible(&r.operation_id))
        {
            snapshot.current = None;
        }
        if snapshot
            .input
            .as_ref()
            .is_some_and(|r| !visible(&r.operation_id))
        {
            snapshot.input = None;
        }
        if snapshot
            .pause
            .as_ref()
            .and_then(|p| p.operation_id.as_ref())
            .is_some_and(|id| !visible(id))
        {
            snapshot.pause = None;
        }
        snapshot
    }
    pub fn begin_shutdown(&self) {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        d.closing = true;
        if d.pause.is_some() {
            Self::cancel_on_shutdown(&mut d);
        }
        drop(d);
        self.signal();
    }
    fn cancel_on_shutdown(d: &mut QueueData) {
        let ids: Vec<_> = d
            .pending
            .iter()
            .map(|r| r.operation_id.as_str().to_string())
            .collect();
        d.cancelled.extend(ids);
    }
    fn signal(&self) {
        self.changed.send_modify(|v| *v = v.wrapping_add(1));
    }
    fn pause_locked(d: &mut QueueData, id: Option<rho_contract::OperationId>, reason: &str) {
        d.serial += 1;
        d.pause = Some(QueuePause {
            id: format!("pause-{}", d.serial),
            operation_id: id,
            reason: reason.into(),
        });
        if d.closing {
            Self::cancel_on_shutdown(d);
        }
    }
    pub(super) fn admit(&self, operation: &Operation) -> Result<(), HandlerError> {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if d.pending.len() >= 32 {
            return Err(HandlerError::before_effect(
                "The queue is full (32 pending runs). Keep the input and try again after a run starts.",
            ));
        }
        let args: RunRArguments = serde_json::from_value(operation.normalized_arguments.clone())
            .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        d.principals.insert(
            operation.operation_id.clone(),
            operation.principal().clone(),
        );
        d.pending.push_back(QueuedRun {
            operation_id: operation.operation_id.clone(),
            source: args.source,
            summary: args.code.chars().take(160).collect(),
        });
        drop(d);
        self.signal();
        Ok(())
    }
    pub(super) fn cancel_pending(&self, operation: &Operation) -> bool {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if !d
            .pending
            .iter()
            .any(|r| r.operation_id == operation.operation_id)
        {
            return false;
        }
        d.cancelled
            .insert(operation.operation_id.as_str().to_string());
        drop(d);
        self.signal();
        true
    }
    fn finish(&self, id: &rho_contract::OperationId, success: bool, reason: &str) {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if d.current.as_ref().is_some_and(|r| &r.operation_id == id) {
            d.current = None;
        }
        d.pending.retain(|r| &r.operation_id != id);
        d.cancelled.remove(id.as_str());
        if !success {
            Self::pause_locked(&mut d, Some(id.clone()), reason);
        }
        let live: BTreeSet<_> = d
            .pending
            .iter()
            .map(|r| r.operation_id.clone())
            .chain(d.current.iter().map(|r| r.operation_id.clone()))
            .chain(d.pause.iter().filter_map(|p| p.operation_id.clone()))
            .collect();
        d.principals.retain(|id, _| live.contains(id));
        drop(d);
        self.signal();
    }
    pub(super) async fn acquire(
        self: &Arc<Self>,
        operation: &Operation,
        lane: Arc<tokio::sync::Mutex<()>>,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        let mut changed = self.changed.subscribe();
        loop {
            let (cancelled, reserved) = {
                let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
                let cancelled =
                    *cancellation.borrow() || d.cancelled.contains(operation.operation_id.as_str());
                let available = !cancelled
                    && d.controls_pending == 0
                    && d.pause.is_none()
                    && d.current.is_none()
                    && d.reserved.is_none()
                    && d.pending
                        .front()
                        .is_some_and(|r| r.operation_id == operation.operation_id);
                if available {
                    d.reserved = Some(operation.operation_id.clone());
                }
                (cancelled, available)
            };
            if cancelled {
                self.finish(
                    &operation.operation_id,
                    false,
                    "Pending run cancelled. Resume the remaining queue explicitly.",
                );
                let mut error = HandlerError::before_effect("Cancelled before execution");
                error.cancellation_confirmed = true;
                return Err(error);
            }
            if !reserved {
                tokio::select! {_=changed.changed()=>{},_=cancellation.changed()=>{}};
                continue;
            }
            let acquiring = lane.clone().lock_owned();
            tokio::pin!(acquiring);
            let guard = loop {
                tokio::select! {
                    guard=&mut acquiring=>break Some(guard),
                    _=changed.changed()=>{},
                    _=cancellation.changed()=>{},
                }
                let d = self.data.lock().unwrap_or_else(|e| e.into_inner());
                if *cancellation.borrow()
                    || d.cancelled.contains(operation.operation_id.as_str())
                    || d.pause.is_some()
                    || d.controls_pending > 0
                {
                    break None;
                }
            };
            let start = {
                let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
                d.reserved = None;
                let start = guard.is_some()
                    && !*cancellation.borrow()
                    && !d.cancelled.contains(operation.operation_id.as_str())
                    && d.pause.is_none()
                    && d.controls_pending == 0;
                if start {
                    d.current = d.pending.pop_front();
                }
                start
            };
            if start {
                return Ok(Box::new(ConsoleLease {
                    queue: self.clone(),
                    id: operation.operation_id.clone(),
                    _guard: guard.unwrap(),
                    finished: false,
                }));
            }
            drop(guard);
        }
    }
    fn begin_control(self: &Arc<Self>) -> Box<dyn ExecutionLease> {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .controls_pending += 1;
        Box::new(QueueControlLease {
            queue: self.clone(),
            completed: false,
        })
    }
    fn finish_control(&self, confirmed: bool) {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        d.controls_pending = d.controls_pending.saturating_sub(1);
        if !confirmed {
            Self::pause_locked(
                &mut d,
                None,
                "Queue control commit is unconfirmed. Inspect the operation before resuming.",
            );
        }
        drop(d);
        self.signal();
    }
    pub fn control(&self, pause: bool, pause_id: Option<&str>) -> Result<(), HandlerError> {
        let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if pause {
            Self::pause_locked(&mut d, None, "Queue paused. The current run continues.");
        } else {
            if d.pause.as_ref().map(|p| p.id.as_str()) != pause_id || pause_id.is_none() {
                return Err(HandlerError::before_effect(
                    "Queue pause changed. Refresh before resuming.",
                ));
            }
            d.pause = None;
        }
        drop(d);
        self.signal();
        Ok(())
    }
}
struct ConsoleLease {
    queue: Arc<ConsoleQueue>,
    id: rho_contract::OperationId,
    _guard: OwnedMutexGuard<()>,
    finished: bool,
}
impl ExecutionLease for ConsoleLease {
    fn completed(&mut self, result: &Result<OperationRecord, OperationError>) {
        self.finished = true;
        let success = result
            .as_ref()
            .is_ok_and(|r| r.status == rho_contract::OperationStatus::Succeeded);
        let reason = match result {
            Err(_) => {
                "Final result commit is unconfirmed. Inspect the stopped run before resuming."
            }
            Ok(record) if record.status == rho_contract::OperationStatus::Uncertain => {
                "R's result is unconfirmed. Inspect the stopped run before resuming."
            }
            _ => {
                "The previous run did not complete successfully. Inspect its result before resuming."
            }
        };
        self.queue.finish(&self.id, success, reason);
    }
}
impl Drop for ConsoleLease {
    fn drop(&mut self) {
        if !self.finished {
            self.queue.finish(
                &self.id,
                false,
                "Execution or its final commit is unconfirmed. Inspect the run before resuming.",
            );
        }
    }
}

pub struct ConsoleQueryHandler {
    owner: Arc<WorkspaceRunHandler>,
    descriptor: CapabilityDescriptor,
    check: bool,
}
impl ConsoleQueryHandler {
    pub fn new(owner: Arc<WorkspaceRunHandler>, check: bool) -> Self {
        let mut descriptor = owner.descriptor.clone();
        descriptor.kind = rho_contract::CapabilityKind::Query;
        descriptor.output_schema = if check {
            schema_for!(rho_contract::CodeCompleteness).to_value()
        } else {
            schema_for!(rho_contract::ConsoleState).to_value()
        };
        descriptor.capability = CapabilityRef::new(
            if check {
                "workspace.check_code"
            } else {
                "workspace.console_state"
            },
            1,
        )
        .unwrap();
        descriptor.input_schema = if check {
            schema_for!(rho_contract::CheckCodeArguments).to_value()
        } else {
            json!({"type":"object","properties":{},"additionalProperties":false})
        };
        descriptor.required_scopes = BTreeSet::from([super::WORKSPACE_READ_SCOPE.into()]);
        descriptor.documentation = rho_contract::builtin_documentation(&descriptor.capability.id);
        descriptor.potential_effects.clear();
        descriptor.idempotency = IdempotencyClass::Pure;
        descriptor.retry = RetryClass::Safe;
        descriptor.cancellation = CancellationClass::Unsupported;
        Self {
            owner,
            descriptor,
            check,
        }
    }
}
#[async_trait]
impl rho_operation::QueryHandler for ConsoleQueryHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        if self.check {
            let args: rho_contract::CheckCodeArguments = serde_json::from_value(value.clone())
                .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
            if args.code.len() > MAX_CODE_BYTES || args.code.contains('\0') {
                return Err(OperationError::InvalidInput("Invalid code bounds".into()));
            }
        } else if value != &json!({}) {
            return Err(OperationError::InvalidInput(
                "Console state accepts no arguments".into(),
            ));
        }
        Ok(value.clone())
    }
    async fn query(&self, _value: &Value) -> Result<rho_contract::QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "Caller context required".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &rho_contract::CallContext,
        value: &Value,
    ) -> Result<rho_contract::QuerySnapshot, OperationError> {
        use rho_operation::{Clock, SystemClock};
        let mut status = rho_contract::QueryStatus::Ready;
        let result = if self.check {
            match self.owner.lane.try_lock() {
                Ok(_guard) => self
                    .owner
                    .runtime
                    .check_code(value["code"].as_str().unwrap_or(""))
                    .await
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
                Err(_) => {
                    status = rho_contract::QueryStatus::Busy;
                    Err("R is busy. Code has not been checked by R.".into())
                }
            }
        } else {
            serde_json::to_value(self.owner.queue.visible_snapshot(
                self.owner.runtime.session_id(),
                self.owner.runtime.input_request(),
                context.principal(),
            ))
            .map_err(|e| e.to_string())
        };
        let (data, notices) = match result {
            Ok(data) => (Some(data), vec![]),
            Err(e) => {
                if status != rho_contract::QueryStatus::Busy {
                    status = rho_contract::QueryStatus::Unavailable;
                }
                (None, vec![e])
            }
        };
        Ok(rho_contract::QuerySnapshot {
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
            target: TargetRef {
                kind: "workspace".into(),
                identity: self.owner.runtime.session_id().into(),
            },
            source: "workspace/console".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status,
            completeness: rho_contract::ObservationCompleteness::Complete,
            data,
            notices,
        })
    }
}

struct QueueControlLease {
    queue: Arc<ConsoleQueue>,
    completed: bool,
}
impl ExecutionLease for QueueControlLease {
    fn completed(&mut self, result: &Result<OperationRecord, OperationError>) {
        self.completed = true;
        self.queue.finish_control(result.is_ok());
    }
}
impl Drop for QueueControlLease {
    fn drop(&mut self) {
        if !self.completed {
            self.queue.finish_control(false);
        }
    }
}

pub struct QueueControlHandler {
    owner: Arc<WorkspaceRunHandler>,
    descriptor: CapabilityDescriptor,
    pause: bool,
}
impl QueueControlHandler {
    pub fn new(owner: Arc<WorkspaceRunHandler>, pause: bool) -> Self {
        let mut descriptor = owner.descriptor.clone();
        descriptor.capability = CapabilityRef::new(
            if pause {
                "workspace.pause_queue"
            } else {
                "workspace.resume_queue"
            },
            1,
        )
        .unwrap();
        descriptor.input_schema = schema_for!(rho_contract::QueueControlArguments).to_value();
        descriptor.documentation = rho_contract::builtin_documentation(&descriptor.capability.id);
        descriptor.output_schema = json!({"type":"object","properties":{"paused":{"type":"boolean"}},"required":["paused"],"additionalProperties":false});
        descriptor.potential_effects.clear();
        descriptor.cancellation = CancellationClass::Unsupported;
        Self {
            owner,
            descriptor,
            pause,
        }
    }
}
#[async_trait]
impl OperationHandler for QueueControlHandler {
    async fn acquire_execution(
        &self,
        _operation: &Operation,
        _cancellation: watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(self.owner.queue.begin_control())
    }
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        self.owner.idempotency_scope()
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: rho_contract::QueueControlArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        serde_json::to_value(args).map_err(|e| OperationError::InvalidInput(e.to_string()))
    }
    fn resolve_target(&self, value: &Value) -> Result<TargetRef, OperationError> {
        self.owner.resolve_target(value)
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        self.owner.check_preconditions(operation)?;
        if operation.normalized_arguments["session_id"].as_str()
            != Some(self.owner.runtime.session_id())
        {
            return Err(HandlerError::before_effect("Workspace session changed"));
        }
        self.owner.queue.control(
            self.pause,
            operation.normalized_arguments["pause_id"].as_str(),
        )?;
        Ok(CommitPlan::succeeded(json!({"paused":self.pause})))
    }
}
