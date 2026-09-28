#![forbid(unsafe_code)]
//! Native Agent task scheduling over the package's task owner and native client.
//! The containing application supplies already-authorized context and connection
//! ports. No Host database, private credentials, scientific owner or core UI is
//! referenced here. Task receipts remain observations, not scientific commits.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_api::*;
use rho_agent_client::*;
use rho_agent_owner::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn err(error: impl ToString) -> AgentTaskError {
    AgentTaskError::InvalidInput(error.to_string())
}

/// Idempotent revocation belongs to this exact native connection. Implementations must not
/// use a plugin's endpoint token as a general Host credential.
pub trait NativeConnectionLease: Send + Sync {
    fn revoke(&self);
}
/// Ephemeral endpoint credentials, never task/store/Operation serialization.
pub struct NativeTaskEndpoint {
    pub url: String,
    pub token: String,
    pub lease: Arc<dyn NativeConnectionLease>,
}
/// Captured callbacks for one admitted command. The containing application is
/// responsible for validating original caller identity and capability scope;
/// these callbacks cannot derive new authority from model/context content.
#[async_trait]
pub trait NativeTaskPort: Send + Sync {
    async fn input(
        &self,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
        draft: &AgentTaskDraft,
    ) -> Result<Vec<NativeInput>, NativeTaskFailure>;
    async fn endpoint(
        &self,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
    ) -> Result<NativeTaskEndpoint, NativeTaskFailure>;
}
struct OwnedConnectionLease(Arc<dyn NativeConnectionLease>);
impl OwnedConnectionLease {
    fn revoke(&self) {
        self.0.revoke();
    }
}
impl Drop for OwnedConnectionLease {
    fn drop(&mut self) {
        self.revoke();
    }
}
struct LiveTask {
    task_id: String,
    scope: AgentTaskScope,
    session: Arc<dyn NativeAgentSession>,
    generation: AtomicU64,
    closed: AtomicBool,
    watching: AtomicBool,
    cursor: AtomicU64,
    flush: Mutex<()>,
    _permit: OwnedSemaphorePermit,
    lease: OwnedConnectionLease,
}

pub struct NativeTaskRuntime {
    owner: Arc<AgentTaskOwner>,
    factory: Arc<dyn NativeAgentFactory>,
    live: Mutex<HashMap<String, Arc<LiveTask>>>,
    gates: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    slots: Arc<Semaphore>,
    stopped: AtomicBool,
}
impl NativeTaskRuntime {
    pub fn new(owner: Arc<AgentTaskOwner>, factory: Arc<dyn NativeAgentFactory>) -> Arc<Self> {
        Arc::new(Self {
            owner,
            factory,
            live: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(8)),
            stopped: AtomicBool::new(false),
        })
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub async fn has_live(&self) -> bool {
        self.slots.available_permits() != 8
    }
    pub fn reserve_connection(&self) -> Result<OwnedSemaphorePermit, AgentTaskError> {
        self.slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| err("Eight Agent connections are active; disconnect an idle task first"))
    }
    /// Dispatch only fresh native admissions. The same original receipt and owner
    /// continue through native acceptance, uncertainty, observation and cleanup.
    pub fn launch(
        self: &Arc<Self>,
        scope: AgentTaskScope,
        request: AgentTaskRequest,
        admission: AgentTaskAdmission,
        port: Arc<dyn NativeTaskPort>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        if !admission.native || admission.repeated {
            return None;
        }
        let service = self.clone();
        Some(tokio::spawn(async move {
            let id = admission.task.task.task_id.clone();
            let gate = service.gate(&id).await;
            let _guard = gate.lock().await;
            let generation = admission.task.attachment.generation;
            if let Err(error) = service
                .run(port.as_ref(), &scope, &request, &admission)
                .await
            {
                let snapshot = service
                    .live
                    .lock()
                    .await
                    .get(&id)
                    .map(|live| live.session.snapshot());
                let _ = service.fail(&scope, &id, generation, &admission.receipt, error, snapshot);
            }
        }))
    }
    pub async fn rebind(&self, task: &str, window: AgentControllerRef, generation: u64) {
        if let Some(live) = self.live.lock().await.get(task).cloned() {
            live.session.rebind(window);
            live.generation.store(generation, Ordering::Release);
        }
    }
    pub async fn active_ids(&self, scope: &AgentTaskScope) -> Vec<String> {
        self.live
            .lock()
            .await
            .values()
            .filter(|task| &task.scope == scope)
            .map(|task| task.task_id.clone())
            .take(8)
            .collect()
    }
    pub async fn history(
        &self,
        scope: &AgentTaskScope,
        task_id: &str,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<AgentNativeHistoryPage, AgentTaskError> {
        let record = self.owner.get(scope, task_id)?;
        let live = self
            .live
            .lock()
            .await
            .get(task_id)
            .filter(|live| &live.scope == scope)
            .cloned()
            .ok_or_else(|| {
                err("Resume this task to read its native history; cached history remains available")
            })?;
        let (events, next) = live.session.history(cursor, limit).await.map_err(err)?;
        let partial = events.len() >= 500
            || events
                .iter()
                .any(|event| event.status.as_deref() == Some("truncated"));
        let receipts = self.owner.store.agent_receipts(scope, task_id)?;
        let events = events
            .into_iter()
            .map(|mut event| {
                if let Some(turn) = &event.turn {
                    event.request_id = receipts
                        .iter()
                        .find(|receipt| {
                            receipt.command == "send"
                                && receipt.native_turn_id.as_ref() == Some(turn)
                        })
                        .map(|receipt| receipt.request_id.clone());
                }
                to_event(event, 0, record.attachment.generation)
            })
            .collect();
        Ok(AgentNativeHistoryPage {
            task_id: task_id.into(),
            events,
            next_cursor: next,
            source: record.attachment.capabilities.history,
            partial,
        })
    }
    pub async fn close(&self) {
        self.stopped.store(true, Ordering::Release);
        let all: Vec<_> = self.live.lock().await.drain().map(|(_, v)| v).collect();
        for live in all {
            live.lease.revoke();
            live.closed.store(true, Ordering::Release);
            let before = live.session.snapshot();
            live.session.close().await;
            let quiet = if let Some(proof) = live.session.process_proof() {
                self.factory.recover_process(&proof).await.is_ok()
            } else {
                false
            };
            let _flush = live.flush.lock().await;
            let page = live.session.events(live.cursor.load(Ordering::Acquire));
            let _ = self.owner.update(
                &live.scope,
                &live.task_id,
                live.generation.load(Ordering::Acquire),
                |t, _, receipts, events| {
                    t.attachment.state = "disconnected".into();
                    t.attachment.connection_id = None;
                    t.attachment.decisions.clear();
                    t.native_quiet = quiet;
                    append_events(t, page.events, events);
                    if let Some(active) = &t.active_request
                        && let Some(mut receipt) =
                            self.owner.store.agent_receipt(&live.scope, active)?
                    {
                        receipt.status = if before.last_request_id.as_ref() == Some(active)
                            && matches!(before.state.as_str(), "ready" | "interrupted" | "failed")
                        {
                            native_receipt_status(&before.state)
                        } else {
                            "uncertain"
                        }
                        .into();
                        receipt.updated_at_ms = now();
                        if receipt.status == "succeeded" {
                            receipt.submitted_draft = None;
                        }
                        if receipt.status == "uncertain" {
                            receipt.error = Some(
                                "Host closed before the original native outcome was confirmed"
                                    .into(),
                            );
                        }
                        receipts.push(receipt);
                    }
                    Ok(())
                },
            );
        }
    }
    async fn gate(&self, id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.gates.lock().await;
        // A waiter holds the strong reference. Never remove an occupied gate:
        // creating a second lock for the same task would break serialization.
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(id.into(), Arc::downgrade(&gate));
        gate
    }
    fn fail(
        &self,
        scope: &AgentTaskScope,
        id: &str,
        generation: u64,
        original: &AgentCommandReceipt,
        failure: NativeTaskFailure,
        native: Option<AgentClientSession>,
    ) -> Result<(), AgentTaskError> {
        let mut receipt = original.clone();
        receipt.status = if failure.uncertain {
            "uncertain"
        } else {
            "failed"
        }
        .into();
        receipt.error = Some(failure.message.clone());
        receipt.updated_at_ms = now();
        self.owner
            .update(scope, id, generation, |t, _, receipts, _| {
                // Observation may have committed a final native result while this
                // background failure was waiting for the task lock. Do not regress it.
                if self
                    .owner
                    .store
                    .agent_receipt(scope, &original.request_id)?
                    .is_some_and(|receipt| {
                        matches!(
                            receipt.status.as_str(),
                            "succeeded" | "interrupted" | "failed"
                        )
                    })
                {
                    return Ok(());
                }
                if let Some(id) = failure.native_id {
                    t.task.native_session_id = Some(id.clone());
                    receipt.native_session_id = Some(id);
                }
                if let Some((process, quiet)) = failure.retired_connection {
                    t.process = process;
                    t.native_quiet = quiet;
                    t.attachment.connection_id = None;
                }
                t.attachment.error = Some(failure.message);
                if !t.attachment.control_frozen && t.attachment.state != "stopping" {
                    t.attachment.state = if failure.uncertain {
                        "uncertain".into()
                    } else if let Some(native) = native {
                        native.state
                    } else if t.task.native_session_id.is_some() {
                        "disconnected".into()
                    } else {
                        "draft".into()
                    };
                }
                if !failure.uncertain && t.active_request.as_deref() == Some(&original.request_id) {
                    t.active_request = None;
                }
                if t.attachment.control_frozen {
                    t.attachment.state = "uncertain".into();
                }
                receipts.push(receipt);
                Ok(())
            })
    }
    fn receipt(
        &self,
        scope: &AgentTaskScope,
        original: &AgentCommandReceipt,
        status: &str,
        error: Option<String>,
    ) -> AgentCommandReceipt {
        let mut r = self
            .owner
            .store
            .agent_receipt(scope, &original.request_id)
            .ok()
            .flatten()
            .unwrap_or_else(|| original.clone());
        r.status = status.into();
        r.error = error;
        r.updated_at_ms = now();
        if status == "succeeded" {
            r.submitted_draft = None;
        }
        r
    }
    async fn run(
        self: &Arc<Self>,
        port: &dyn NativeTaskPort,
        scope: &AgentTaskScope,
        request: &AgentTaskRequest,
        a: &AgentTaskAdmission,
    ) -> Result<(), NativeTaskFailure> {
        let id = &a.task.task.task_id;
        let generation = a.task.attachment.generation;
        if self.owner.get(scope, id)?.attachment.generation != generation {
            return Err(NativeTaskFailure::before(
                "Task attachment changed before the command ran",
            ));
        }
        match &request.command {
            AgentTaskCommand::Send { .. } => {
                let parts = port.input(scope, &a.task, &a.draft).await?;
                let live = self.connection(port, scope, &a.task, request).await?;
                live.session
                    .configure(
                        &a.task.task.model,
                        a.task.task.effort.as_deref(),
                        a.task.task.mode.as_deref(),
                    )
                    .await
                    .map_err(NativeTaskFailure::before)?;
                let current = self.owner.get(scope, id)?;
                if self.stopped.load(Ordering::Acquire)
                    || current.attachment.generation != generation
                    || current.attachment.control_frozen
                    || current.attachment.state == "stopping"
                {
                    return Err(NativeTaskFailure::before(
                        "Submission was stopped before sending; the draft is preserved",
                    ));
                }
                live.session
                    .send(NativePrompt {
                        request_id: request.request_id.clone(),
                        display_text: if a.draft.content.text.is_empty() {
                            "Attached context".into()
                        } else {
                            a.draft.content.text.clone()
                        },
                        parts,
                        window: request.window.clone(),
                    })
                    .await
                    .map_err(NativeTaskFailure::uncertain)?;
                let _flush = live.flush.lock().await;
                let page = live.session.events(live.cursor.load(Ordering::Acquire));
                let current = live.session.snapshot();
                let status = native_receipt_status(&current.state);
                let mut receipt = self.receipt(scope, &a.receipt, status, current.error.clone());
                receipt.native_session_id = Some(current.native_session_id);
                receipt.native_turn_id = live.session.native_turn_id();
                let committed =
                    self.owner
                        .update(scope, id, generation, |t, d, receipts, events| {
                            if !t.attachment.control_frozen && t.attachment.state != "stopping" {
                                t.attachment.state = current.state.clone();
                            }
                            t.attachment.error = current.error.clone();
                            t.interrupted_context = false;
                            if matches!(status, "succeeded" | "interrupted" | "failed") {
                                t.active_request = None;
                            }
                            if d.version == a.draft.version
                                && !matches!(status, "uncertain" | "failed")
                            {
                                d.content = AgentDraftContent::default();
                                d.version += 1;
                                d.updated_at_ms = now();
                            }
                            append_events(t, page.events.clone(), events);
                            receipts.push(receipt);
                            Ok(())
                        });
                if committed.is_ok() {
                    live.cursor.store(page.cursor, Ordering::Release);
                }
                drop(_flush);
                self.watch(scope.clone(), id.clone(), live);
                // Native send already accepted the prompt. Retain its identity
                // and keep observing if the acknowledgement could not be saved.
                committed.map_err(NativeTaskFailure::uncertain)?;
            }
            AgentTaskCommand::Connect { .. } | AgentTaskCommand::Resume { .. } => {
                let live = self.connection(port, scope, &a.task, request).await?;
                live.session
                    .configure(
                        &a.task.task.model,
                        a.task.task.effort.as_deref(),
                        a.task.task.mode.as_deref(),
                    )
                    .await
                    .map_err(NativeTaskFailure::before)?;
                let mut old = self.owner.store.agent_receipts(scope, id)?;
                for r in &mut old {
                    if r.request_id != request.request_id
                        && matches!(r.status.as_str(), "prepared" | "submitted")
                    {
                        r.status = "uncertain".into();
                        r.error =
                            Some("Previous Host ended before this outcome was confirmed".into());
                        r.updated_at_ms = now();
                    }
                }
                let mut receipt = self.receipt(scope, &a.receipt, "succeeded", None);
                receipt.native_session_id = Some(live.session.snapshot().native_session_id);
                self.owner
                    .update(scope, id, generation, |t, _, receipts, _| {
                        t.active_request = None;
                        t.attachment.state = "ready".into();
                        t.attachment.capabilities = live.session.capabilities();
                        receipts.extend(
                            old.into_iter()
                                .filter(|r| r.request_id != request.request_id),
                        );
                        receipts.push(receipt);
                        Ok(())
                    })?;
                self.watch(scope.clone(), id.clone(), live);
            }
            AgentTaskCommand::Configure { .. } => {
                let live = self.live.lock().await.get(id).cloned().ok_or_else(|| {
                    NativeTaskFailure::before(
                        "Native connection was lost while updating configuration",
                    )
                })?;
                {
                    let current = live.session.snapshot();
                    let (model, effort) =
                        if agent_busy(&current.state) || current.state == "uncertain" {
                            (&current.model, current.effort.as_deref())
                        } else {
                            (&a.task.task.model, a.task.task.effort.as_deref())
                        };
                    live.session
                        .configure(model, effort, a.task.task.mode.as_deref())
                        .await
                        .map_err(NativeTaskFailure::before)?;
                    self.owner.update(scope, id, generation, |t, _, rs, _| {
                        t.attachment.capabilities = live.session.capabilities();
                        rs.push(self.receipt(scope, &a.receipt, "succeeded", None));
                        Ok(())
                    })?;
                }
            }
            AgentTaskCommand::Decision {
                decision_id,
                option_id,
                ..
            } => {
                let live = self.live.lock().await.get(id).cloned().ok_or_else(|| {
                    NativeTaskFailure::before("Native permission connection is unavailable")
                })?;
                live.session
                    .decide(*decision_id, option_id)
                    .await
                    .map_err(NativeTaskFailure::uncertain)?;
                self.owner.update(scope, id, generation, |t, _, rs, _| {
                    t.attachment.decisions = live.session.snapshot().decisions;
                    rs.push(self.receipt(scope, &a.receipt, "succeeded", None));
                    Ok(())
                })?;
            }
            AgentTaskCommand::Stop { .. } | AgentTaskCommand::TakeOver { stop: true, .. } => {
                let live = self.live.lock().await.get(id).cloned();
                if let Some(live) = &live {
                    if agent_busy(&live.session.snapshot().state) {
                        live.session
                            .interrupt()
                            .await
                            .map_err(NativeTaskFailure::uncertain)?;
                    }
                    tokio::time::timeout(Duration::from_secs(20), async {
                        let mut tick = tokio::time::interval(Duration::from_millis(50));
                        loop {
                            if !agent_busy(&live.session.snapshot().state) {
                                break;
                            }
                            tick.tick().await;
                        }
                    })
                    .await
                    .map_err(|_| {
                        NativeTaskFailure::uncertain("Native stop could not be confirmed")
                    })?;
                    if matches!(
                        live.session.snapshot().state.as_str(),
                        "uncertain" | "disconnected"
                    ) {
                        return Err(NativeTaskFailure::uncertain(
                            "Native quiet is not confirmed; control was not transferred",
                        ));
                    }
                } else if !a.task.native_quiet {
                    let proof = a.task.process.as_ref().ok_or_else(|| {
                        NativeTaskFailure::uncertain(
                            "The previous Agent process has no verifiable ownership evidence",
                        )
                    })?;
                    self.factory
                        .recover_process(&to_proof(proof))
                        .await
                        .map_err(NativeTaskFailure::uncertain)?;
                }
                let transfer = matches!(request.command, AgentTaskCommand::TakeOver { .. });
                self.owner.update(scope, id, generation, |t, _, rs, _| {
                    if let Some(active) = &t.active_request
                        && let Some(mut old) = self.owner.store.agent_receipt(scope, active)?
                    {
                        old.status = if live.is_some() {
                            "interrupted"
                        } else {
                            "uncertain"
                        }
                        .into();
                        old.updated_at_ms = now();
                        rs.push(old);
                    }
                    t.active_request = None;
                    t.attachment.control_frozen = false;
                    t.attachment.decisions.clear();
                    t.attachment.error = None;
                    t.attachment.state = if live.is_some() {
                        "ready"
                    } else {
                        "disconnected"
                    }
                    .into();
                    t.native_quiet = live.is_none();
                    if transfer {
                        t.attachment.generation += 1;
                        t.attachment.controller = request.window.clone();
                    }
                    rs.push(self.receipt(scope, &a.receipt, "succeeded", None));
                    Ok(())
                })?;
                if transfer && let Some(live) = live {
                    live.session.rebind(request.window.clone());
                    live.generation.store(generation + 1, Ordering::Release);
                }
            }
            AgentTaskCommand::Disconnect { .. } => {
                let live = self.live.lock().await.remove(id);
                if let Some(live) = live {
                    live.lease.revoke();
                    live.closed.store(true, Ordering::Release);
                    live.session.close().await;
                    if let Some(proof) = live.session.process_proof() {
                        self.factory
                            .recover_process(&proof)
                            .await
                            .map_err(NativeTaskFailure::uncertain)?;
                    } else {
                        return Err(NativeTaskFailure::uncertain(
                            "Cannot verify that the native process ended",
                        ));
                    }
                } else if !a.task.native_quiet {
                    let proof = a.task.process.as_ref().ok_or_else(|| {
                        NativeTaskFailure::uncertain(
                            "Cannot confirm ownership of the previous native process",
                        )
                    })?;
                    self.factory
                        .recover_process(&to_proof(proof))
                        .await
                        .map_err(NativeTaskFailure::uncertain)?;
                }
                self.owner.update(scope, id, generation, |t, _, rs, _| {
                    t.attachment.state = "disconnected".into();
                    t.attachment.connection_id = None;
                    t.attachment.decisions.clear();
                    t.native_quiet = true;
                    rs.push(self.receipt(scope, &a.receipt, "succeeded", None));
                    Ok(())
                })?;
            }
            AgentTaskCommand::AddAsset {
                name,
                mime_type,
                data,
                ..
            } => {
                if name.is_empty()
                    || name.len() > 256
                    || name.chars().any(char::is_control)
                    || mime_type.len() > 128
                    || mime_type.chars().any(char::is_control)
                {
                    return Err(NativeTaskFailure::before("Invalid attachment metadata"));
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|_| NativeTaskFailure::before("Invalid attachment encoding"))?;
                let asset = AgentAsset {
                    asset_id: request.request_id.clone(),
                    name: name.rsplit(['/', '\\']).next().unwrap_or(name).into(),
                    mime_type: mime_type.clone(),
                    bytes: bytes.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                };
                self.owner
                    .store
                    .put_agent_asset(scope, id, &asset, &bytes)?;
                self.owner.update(scope, id, generation, |_, _, rs, _| {
                    rs.push(self.receipt(scope, &a.receipt, "succeeded", None));
                    Ok(())
                })?;
            }
            AgentTaskCommand::RemoveAsset {
                asset_id,
                draft_version,
                ..
            } => {
                self.owner.update(scope, id, generation, |_, d, rs, _| {
                    if d.version != *draft_version {
                        return Err(AgentTaskError::Conflict);
                    }
                    d.content.assets.retain(|id| id != asset_id);
                    d.version += 1;
                    d.updated_at_ms = now();
                    rs.push(self.receipt(scope, &a.receipt, "succeeded", None));
                    Ok(())
                })?;
            }
            _ => {}
        }
        Ok(())
    }
    async fn connection(
        self: &Arc<Self>,
        port: &dyn NativeTaskPort,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
        request: &AgentTaskRequest,
    ) -> Result<Arc<LiveTask>, NativeTaskFailure> {
        let existing = self.live.lock().await.get(&task.task.task_id).cloned();
        let replacing = existing.is_some();
        if let Some(live) = existing {
            if !live.closed.load(Ordering::Acquire)
                && live.generation.load(Ordering::Acquire) == task.attachment.generation
            {
                return Ok(live);
            }
            // A resume is a new attachment, including after an uncertain native
            // turn. Never revive the old transport by relabelling it ready.
            live.lease.revoke();
            live.closed.store(true, Ordering::Release);
            self.live.lock().await.remove(&task.task.task_id);
            live.session.close().await;
            let proof = live.session.process_proof().ok_or_else(|| {
                NativeTaskFailure::uncertain(
                    "Cannot verify ownership of the previous native process",
                )
            })?;
            self.factory
                .recover_process(&proof)
                .await
                .map_err(NativeTaskFailure::uncertain)?;
        }
        let permit = if replacing {
            tokio::time::timeout(Duration::from_secs(1), self.slots.clone().acquire_owned())
                .await
                .map_err(|_| NativeTaskFailure::before("Previous connection is still closing"))?
                .map_err(|_| NativeTaskFailure::before("Agent connection service closed"))?
        } else {
            self.slots.clone().try_acquire_owned().map_err(|_| {
                NativeTaskFailure::before(
                    "Eight Agent connections are active. Disconnect an idle task first.",
                )
            })?
        };
        if !task.native_quiet {
            let proof = task.process.as_ref().ok_or_else(|| {
                NativeTaskFailure::uncertain(
                    "Cannot confirm ownership of the previous native process",
                )
            })?;
            self.factory
                .recover_process(&to_proof(proof))
                .await
                .map_err(NativeTaskFailure::uncertain)?;
        }
        let endpoint = port.endpoint(scope, task).await?;
        let lease = OwnedConnectionLease(endpoint.lease);
        let session = self
            .factory
            .open(NativeOpenRequest {
                provider: task.task.provider,
                root: task.task.project_root.clone().into(),
                window: request.window.clone(),
                native_session_id: task.task.native_session_id.clone(),
                endpoint: endpoint.url,
                token: endpoint.token,
                interrupted: task.interrupted_context || task.active_request.is_some(),
            })
            .await
            .map_err(|e| NativeTaskFailure {
                message: e.error,
                uncertain: e.uncertain,
                native_id: e.native_session_id,
                retired_connection: None,
            })?;
        let snapshot = session.snapshot();
        let live = Arc::new(LiveTask {
            task_id: task.task.task_id.clone(),
            scope: scope.clone(),
            session,
            generation: AtomicU64::new(task.attachment.generation),
            closed: AtomicBool::new(false),
            watching: AtomicBool::new(false),
            cursor: AtomicU64::new(0),
            flush: Mutex::new(()),
            _permit: permit,
            lease,
        });
        // Publish under the same map lock drained by close(). A late open must
        // not slip between shutdown's stopped check and its live-map drain.
        let mut connections = self.live.lock().await;
        if self.stopped.load(Ordering::Acquire) {
            drop(connections);
            return Err(self
                .retire_unregistered(
                    &live,
                    "Host closed while the native connection was opening".into(),
                )
                .await);
        }
        let page = live.session.events(0);
        let retained = self.owner.update(
            scope,
            &task.task.task_id,
            task.attachment.generation,
            |t, _, _, events| {
                t.task.native_session_id = Some(snapshot.native_session_id.clone());
                t.attachment.connection_id = Some(snapshot.id);
                if t.attachment.state != "stopping" {
                    t.attachment.state = "ready".into();
                }
                t.attachment.capabilities = live.session.capabilities();
                t.attachment.error = None;
                t.native_quiet = false;
                t.host_incarnation = self.owner.host_incarnation.clone();
                t.process = live.session.process_proof().map(|p| AgentOwnedProcess {
                    pid: p.pid,
                    start_time: p.start_time,
                    executable: p.executable,
                    marker: p.marker,
                });
                if task.task.provider == AgentProvider::Kimi
                    && task.task.native_session_id.is_some()
                    && !page.events.is_empty()
                {
                    t.history_generation += 1;
                    t.history_gap = true;
                }
                t.history_gap |= page.gap;
                append_events(t, page.events.clone(), events);
                Ok(())
            },
        );
        if let Err(error) = retained {
            drop(connections);
            return Err(self.retire_unregistered(&live, error.to_string()).await);
        }
        live.cursor.store(page.cursor, Ordering::Release);
        connections.insert(task.task.task_id.clone(), live.clone());
        drop(connections);
        self.watch(scope.clone(), task.task.task_id.clone(), live.clone());
        Ok(live)
    }
    async fn retire_unregistered(&self, live: &LiveTask, message: String) -> NativeTaskFailure {
        let native_id = live.session.snapshot().native_session_id;
        let proof = live.session.process_proof();
        live.lease.revoke();
        live.closed.store(true, Ordering::Release);
        live.session.close().await;
        let quiet = match &proof {
            Some(proof) => self.factory.recover_process(proof).await.is_ok(),
            None => false,
        };
        NativeTaskFailure {
            message,
            uncertain: !quiet,
            native_id: Some(native_id),
            retired_connection: Some((
                proof.map(|proof| AgentOwnedProcess {
                    pid: proof.pid,
                    start_time: proof.start_time,
                    executable: proof.executable,
                    marker: proof.marker,
                }),
                quiet,
            )),
        }
    }
    fn watch(self: &Arc<Self>, scope: AgentTaskScope, id: String, live: Arc<LiveTask>) {
        if live.watching.swap(true, Ordering::AcqRel) {
            return;
        }
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut signature = String::new();
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {_=tick.tick()=>{},_=live.session.changed()=>{}}
                let Some(service) = service.upgrade() else {
                    break;
                };
                if service.stopped.load(Ordering::Acquire) || live.closed.load(Ordering::Acquire) {
                    break;
                }
                let _flush = live.flush.lock().await;
                let cursor = live.cursor.load(Ordering::Acquire);
                let generation = live.generation.load(Ordering::Acquire);
                let snapshot = live.session.snapshot();
                let page = live.session.events(cursor);
                let next_signature = serde_json::to_string(&(
                    &snapshot.state,
                    &snapshot.decisions,
                    &snapshot.error,
                    live.session.native_turn_id(),
                    live.session.capabilities(),
                ))
                .unwrap_or_default();
                if next_signature == signature && page.cursor == cursor {
                    continue;
                }
                let result = service
                    .owner
                    .update(&scope, &id, generation, |t, d, rs, events| {
                        if !t.attachment.control_frozen && t.attachment.state != "stopping" {
                            t.attachment.state = snapshot.state.clone();
                        }
                        t.attachment.decisions = snapshot.decisions.clone();
                        t.attachment.error = snapshot.error.clone();
                        t.attachment.capabilities = live.session.capabilities();
                        t.history_gap |= page.gap;
                        append_events(t, page.events.clone(), events);
                        if let Some(active) = &t.active_request
                            && snapshot.last_request_id.as_ref() == Some(active)
                            && let Some(mut r) =
                                service.owner.store.agent_receipt(&scope, active)?
                        {
                            r.native_turn_id = live.session.native_turn_id();
                            r.native_session_id = Some(snapshot.native_session_id.clone());
                            r.updated_at_ms = now();
                            r.status = native_receipt_status(&snapshot.state).into();
                            r.error = snapshot.error.clone();
                            if r.submitted_draft_version == Some(d.version)
                                && matches!(
                                    r.status.as_str(),
                                    "submitted" | "succeeded" | "interrupted"
                                )
                            {
                                d.content = AgentDraftContent::default();
                                d.version += 1;
                                d.updated_at_ms = now();
                            }
                            if r.status == "succeeded" {
                                r.submitted_draft = None;
                            }
                            if matches!(r.status.as_str(), "succeeded" | "interrupted" | "failed") {
                                t.active_request = None;
                            }
                            rs.push(r);
                        }
                        Ok(())
                    });
                if result.is_ok() {
                    live.cursor.store(page.cursor, Ordering::Release);
                    signature = next_signature;
                }
                if result.is_ok() && snapshot.state == "disconnected" {
                    live.lease.revoke();
                    live.closed.store(true, Ordering::Release);
                    let mut map = service.live.lock().await;
                    if map
                        .get(&id)
                        .is_some_and(|current| Arc::ptr_eq(current, &live))
                    {
                        map.remove(&id);
                    }
                    break;
                }
            }
        });
    }
}
pub struct NativeTaskFailure {
    message: String,
    uncertain: bool,
    native_id: Option<String>,
    retired_connection: Option<(Option<AgentOwnedProcess>, bool)>,
}
impl NativeTaskFailure {
    pub fn before(error: impl ToString) -> Self {
        Self {
            message: error.to_string(),
            uncertain: false,
            native_id: None,
            retired_connection: None,
        }
    }
    pub fn uncertain(error: impl ToString) -> Self {
        Self {
            message: error.to_string(),
            uncertain: true,
            native_id: None,
            retired_connection: None,
        }
    }
}
impl From<AgentTaskError> for NativeTaskFailure {
    fn from(error: AgentTaskError) -> Self {
        Self::before(error)
    }
}
fn to_proof(p: &AgentOwnedProcess) -> NativeProcessProof {
    NativeProcessProof {
        pid: p.pid,
        start_time: p.start_time,
        executable: p.executable.clone(),
        marker: p.marker.clone(),
    }
}
fn native_receipt_status(state: &str) -> &'static str {
    match state {
        "ready" => "succeeded",
        "interrupted" => "interrupted",
        "failed" => "failed",
        "uncertain" | "disconnected" => "uncertain",
        _ => "submitted",
    }
}
fn append_events(
    task: &mut StoredAgentTask,
    native: Vec<NativeEvent>,
    events: &mut Vec<AgentTaskEvent>,
) {
    for e in native {
        if task.task.native_session_id.as_deref() != Some(&e.session) {
            continue;
        }
        task.event_cursor += 1;
        events.push(to_event(e, task.event_cursor, task.attachment.generation));
    }
}
fn to_event(e: NativeEvent, sequence: u64, generation: u64) -> AgentTaskEvent {
    AgentTaskEvent {
        usage: e.usage,
        sequence,
        event_id: if e.role.as_deref() == Some("user") && e.request_id.is_some() {
            format!(
                "{}:request:{}:user",
                e.session,
                e.request_id.as_deref().unwrap()
            )
        } else if let (Some(turn), Some(item)) = (&e.turn, &e.item) {
            format!("{}:native:{turn}:{item}", e.session)
        } else {
            format!("{}:{}", e.session, e.key)
        },
        request_id: e.request_id,
        generation,
        native_session_id: e.session,
        native_turn_id: e.turn,
        native_item_id: e.item,
        kind: e.kind,
        role: e.role,
        text: e.text,
        status: e.status,
        source: if e.historical {
            "native_history"
        } else {
            "observation"
        }
        .into(),
        observed_at_ms: e.at_ms,
    }
}

#[cfg(test)]
mod tests;

pub mod mcp;
