//! Application task orchestration. Native adapters own protocol/process facts;
//! Application owns durable identity, admission and presentation observations.
use crate::{ApplicationStore, NextHost};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_client::*;
use rho_application::*;
use rho_contract::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc,
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
fn err(error: impl ToString) -> ApplicationError {
    ApplicationError::InvalidInput(error.to_string())
}
fn scope(project: &str, context: &CallContext) -> Result<ApplicationScope, ApplicationError> {
    context.validate().map_err(err)?;
    Ok(ApplicationScope {
        project: project.into(),
        principal: serde_json::to_string(context.principal()).map_err(err)?,
    })
}
struct LiveTask {
    task_id: String,
    scope: ApplicationScope,
    session: Arc<dyn NativeAgentSession>,
    generation: AtomicU64,
    closed: AtomicBool,
    watching: AtomicBool,
    cursor: AtomicU64,
    flush: Mutex<()>,
    _permit: OwnedSemaphorePermit,
}
type DiagnosticEntries = HashMap<String, (String, Arc<std::sync::Mutex<AgentDiagnostic>>)>;
pub struct AgentTaskService {
    owner: Arc<AgentTaskOwner>,
    factory: Arc<dyn NativeAgentFactory>,
    live: Mutex<HashMap<String, Arc<LiveTask>>>,
    gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    slots: Arc<Semaphore>,
    stopped: AtomicBool,
    diagnostics: Mutex<DiagnosticEntries>,
    catalogs: std::sync::Mutex<HashMap<(String, AgentProvider), LocalAgent>>,
    context_providers: std::sync::RwLock<Vec<Arc<dyn crate::AgentContextProvider>>>,
}
impl AgentTaskService {
    fn validate_project(host: &NextHost, project: &str) -> Result<(), ApplicationError> {
        if !host
            .runtime
            ._project_lease
            .as_ref()
            .is_some_and(|lease| lease.root().to_str() == Some(project))
        {
            return Err(err("Agent task belongs to a different project"));
        }
        Ok(())
    }
    pub fn new(store: Arc<ApplicationStore>) -> Arc<Self> {
        Self::with_factory(store, Arc::new(LocalNativeAgents))
    }
    pub fn with_factory(
        store: Arc<dyn AgentTaskRepository>,
        factory: Arc<dyn NativeAgentFactory>,
    ) -> Arc<Self> {
        Arc::new(Self {
            owner: Arc::new(AgentTaskOwner::new(store)),
            factory,
            live: Mutex::new(HashMap::new()),
            gates: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(8)),
            stopped: AtomicBool::new(false),
            diagnostics: Mutex::new(HashMap::new()),
            catalogs: std::sync::Mutex::new(HashMap::new()),
            context_providers: std::sync::RwLock::new(Vec::new()),
        })
    }
    pub fn remember_catalog(&self, project: String, catalog: LocalAgent) {
        self.catalogs
            .lock()
            .unwrap()
            .insert((project, catalog.provider), catalog);
    }
    pub fn register_context_provider(
        &self,
        provider: Arc<dyn crate::AgentContextProvider>,
    ) -> Result<(), String> {
        let source = provider.source();
        if !source.plugin
            || !source.id.starts_with("plugin.")
            || source.id.len() > 80
            || !source
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            || source.name.is_empty()
            || source.name.len() > 128
        {
            return Err("Invalid plugin context-source identity".into());
        }
        let mut providers = self
            .context_providers
            .write()
            .map_err(|_| "Context registry unavailable")?;
        if providers.iter().any(|p| p.source().id == source.id) {
            return Err("Context source is already registered".into());
        }
        if providers.len() >= 32 {
            return Err("Context source budget reached".into());
        }
        providers.push(provider);
        Ok(())
    }
    pub async fn has_live(&self) -> bool {
        self.slots.available_permits() != 8
    }
    pub fn reserve_connection(&self) -> Result<OwnedSemaphorePermit, ApplicationError> {
        self.slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| err("Eight Agent connections are active; disconnect an idle task first"))
    }
    pub async fn test(
        self: &Arc<Self>,
        host: &NextHost,
        mut request: TestAgent,
        endpoint: String,
        token: String,
    ) -> Result<AgentDiagnostic, ApplicationError> {
        Self::validate_project(host, &request.project_root)?;
        uuid::Uuid::parse_str(&request.request_id)
            .map_err(|_| err("Invalid diagnostic request ID"))?;
        let observe = request.observe_only;
        request.observe_only = false;
        let signature = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request).map_err(err)?)
        );
        let mut entries = self.diagnostics.lock().await;
        if let Some((old, state)) = entries.get(&request.request_id) {
            if *old != signature {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(state.lock().map_err(err)?.clone());
        }
        let initial = AgentDiagnostic {
            request_id: request.request_id.clone(),
            provider: request.provider,
            model: request.model.clone(),
            state: if observe { "unknown" } else { "running" }.into(),
            elapsed_ms: None,
            response: None,
            error: observe.then(|| {
                "The previous diagnostic is unavailable. Run Test explicitly to start another."
                    .into()
            }),
        };
        if observe {
            return Ok(initial);
        }
        Self::validate_window(host, &request.window, &NextHost::local_context()).await?;
        if entries.len() >= 128 {
            return Err(ApplicationError::Budget(
                "Diagnostic request budget reached for this Host".into(),
            ));
        }
        let permit = self.reserve_connection()?;
        let status = Arc::new(std::sync::Mutex::new(initial.clone()));
        entries.insert(request.request_id.clone(), (signature, status.clone()));
        drop(entries);
        let service = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let started = now();
            let opened = service
                .factory
                .open(NativeOpenRequest {
                    provider: request.provider,
                    root: request.project_root.into(),
                    window: request.window.clone(),
                    native_session_id: None,
                    endpoint,
                    token,
                    interrupted: false,
                })
                .await;
            let result = match opened {
                Err(e) => Err(e.error),
                Ok(session) => {
                    let result=async {
                        if service.stopped.load(Ordering::Acquire) { return Err("Host closed before the diagnostic started".into()); }
                        session.configure(&request.model,request.effort.as_deref(),None).await?;
                        session.send(NativePrompt{request_id:request.request_id,display_text:"Connection test".into(),parts:vec![NativeInput::Text("Reply with exactly ok. Do not call tools or read files.".into())],window:request.window}).await?;
                        tokio::time::timeout(Duration::from_secs(90),async {
                            let mut tick=tokio::time::interval(Duration::from_millis(100));
                            loop {
                                if service.stopped.load(Ordering::Acquire) { return Err("Host closed during the diagnostic".into()); }
                                let s=session.snapshot();
                                match s.state.as_str(){
                                    "ready"=>return Ok(session.events(0).events.into_iter().filter(|e|e.role.as_deref()==Some("assistant")).map(|e|e.text).collect::<Vec<_>>().join("\n")),
                                    "running"=>{},
                                    "waiting_for_permission"=>return Err("Test requested a tool permission; diagnostics do not run tools".into()),
                                    _=>return Err(s.error.unwrap_or_else(||format!("Diagnostic ended: {}",s.state))),
                                }
                                tick.tick().await;
                            }
                        }).await.map_err(|_|"Diagnostic timed out; the request was not replayed".to_owned())?
                    }.await;
                    session.close().await;
                    result
                }
            };
            let mut state = status.lock().unwrap();
            state.elapsed_ms = Some(now().saturating_sub(started));
            match result {
                Ok(text) => {
                    state.response = Some(text);
                    state.state = "succeeded".into();
                }
                Err(e) => {
                    state.state = "failed".into();
                    state.error = Some(e);
                }
            }
        });
        Ok(initial)
    }
    pub async fn close(&self) {
        self.stopped.store(true, Ordering::Release);
        let all: Vec<_> = self.live.lock().await.drain().map(|(_, v)| v).collect();
        for live in all {
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
        self.gates
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
    pub async fn validate_window(
        host: &NextHost,
        window: &ApplicationWindowRef,
        context: &CallContext,
    ) -> Result<(), ApplicationError> {
        let result = host
            .dispatch(
                context,
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: CapabilityRef {
                        id: "application.context".into(),
                        version: 1,
                    },
                    arguments: json!({"window":window,"limit":1}),
                }),
            )
            .await
            .map_err(err)?;
        if result["status"] != "ready" || result["data"]["source"] != "live_bridge" {
            return Err(ApplicationError::Offline);
        }
        Ok(())
    }
    pub async fn query(
        &self,
        host: &NextHost,
        context: &CallContext,
        request: AgentTasksQuery,
    ) -> Result<AgentTaskQueryResult, ApplicationError> {
        Self::validate_project(host, &request.project_root)?;
        let scope = scope(&request.project_root, context)?;
        match request.query {
            AgentTaskQuery::ContextSources => Ok(AgentTaskQueryResult::ContextSources {
                sources: crate::agent_context::sources(&self.context_providers.read().unwrap()),
            }),
            AgentTaskQuery::ContextSearch {
                window,
                source,
                text,
                limit,
            } => {
                let providers = self.context_providers.read().unwrap().clone();
                let reader = crate::AgentContextReader::new(&scope.project, host, context);
                let (items, notices) = crate::agent_context::search(
                    &reader,
                    &window,
                    source.as_deref(),
                    &text,
                    limit,
                    &providers,
                )
                .await
                .map_err(err)?;
                Ok(AgentTaskQueryResult::ContextItems { items, notices })
            }
            AgentTaskQuery::ContextPreview { window, selection } => {
                let providers = self.context_providers.read().unwrap().clone();
                let reader = crate::AgentContextReader::new(&scope.project, host, context);
                Ok(AgentTaskQueryResult::ContextPreview {
                    preview: crate::agent_context::preview(
                        &reader, &window, &selection, &providers, false,
                    )
                    .await
                    .map_err(err)?,
                })
            }
            AgentTaskQuery::List {
                archived,
                before,
                limit,
            } => {
                if !(1..=100).contains(&limit) {
                    return Err(err("Task page limit must be 1–100"));
                }
                let mut records = self.owner.store.agent_tasks(
                    &scope,
                    archived,
                    before.as_deref(),
                    limit as usize + 1,
                )?;
                let more = records.len() > limit as usize;
                records.truncate(limit as usize);
                let next = if more {
                    records
                        .last()
                        .map(|r| format!("{}:{}", r.task.created_at_ms, r.task.task_id))
                } else {
                    None
                };
                let tasks = records
                    .iter()
                    .map(|r| {
                        self.owner.detail(&scope, &r.task.task_id).map(|mut d| {
                            d.summary.attachment.capabilities.models.clear();
                            d.summary
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let (running, permissions) = self
                    .owner
                    .store
                    .agent_task_counts(&scope, &self.owner.host_incarnation)?;
                let active_ids = self
                    .live
                    .lock()
                    .await
                    .values()
                    .filter(|t| {
                        t.scope.project == scope.project && t.scope.principal == scope.principal
                    })
                    .map(|t| t.task_id.clone())
                    .take(8)
                    .collect::<Vec<_>>();
                let mut attention = Vec::new();
                for id in active_ids {
                    let mut summary = self.owner.detail(&scope, &id)?.summary;
                    if !summary.attachment.decisions.is_empty() {
                        summary.attachment.capabilities.models.clear();
                        attention.push(summary);
                    }
                }
                Ok(AgentTaskQueryResult::List {
                    tasks,
                    attention,
                    next,
                    running,
                    permissions,
                })
            }
            AgentTaskQuery::Get { task_id } => Ok(AgentTaskQueryResult::Detail {
                detail: Box::new(self.owner.detail(&scope, &task_id)?),
            }),
            AgentTaskQuery::Receipt { request_id } => {
                let mut receipt = self.owner.store.agent_receipt(&scope, &request_id)?;
                if let Some(r) = &mut receipt {
                    let task = self.owner.get(&scope, &r.task_id)?;
                    if task.host_incarnation != self.owner.host_incarnation
                        && matches!(r.status.as_str(), "prepared" | "submitted")
                    {
                        r.status = "uncertain".into();
                        r.error =
                            Some("Host restarted before the original result was confirmed".into());
                    }
                }
                Ok(AgentTaskQueryResult::Receipt { receipt })
            }
            AgentTaskQuery::Events {
                task_id,
                after,
                before,
                limit,
            } => Ok(AgentTaskQueryResult::Events {
                page: self.owner.store.agent_events(
                    &scope,
                    &task_id,
                    after,
                    before,
                    limit as usize,
                )?,
            }),
            AgentTaskQuery::NativeHistory {
                task_id,
                cursor,
                limit,
            } => {
                let record = self.owner.get(&scope, &task_id)?;
                let live=self.live.lock().await.get(&task_id).cloned().ok_or_else(||err("Resume this task to read its native history; cached history remains available"))?;
                let (events, next) = live.session.history(cursor, limit).await.map_err(err)?;
                let partial = events.len() >= 500
                    || events
                        .iter()
                        .any(|e| e.status.as_deref() == Some("truncated"));
                let receipts = self.owner.store.agent_receipts(&scope, &task_id)?;
                let events = events
                    .into_iter()
                    .map(|mut e| {
                        if let Some(turn) = &e.turn {
                            e.request_id = receipts
                                .iter()
                                .find(|r| {
                                    r.command == "send" && r.native_turn_id.as_ref() == Some(turn)
                                })
                                .map(|r| r.request_id.clone());
                        }
                        to_event(e, 0, record.attachment.generation)
                    })
                    .collect();
                Ok(AgentTaskQueryResult::NativeHistory {
                    page: AgentNativeHistoryPage {
                        task_id,
                        events,
                        next_cursor: next,
                        source: record.attachment.capabilities.history,
                        partial,
                    },
                })
            }
        }
    }
    pub async fn command(
        self: &Arc<Self>,
        host: Arc<NextHost>,
        context: CallContext,
        request: AgentTasksCommand,
        endpoint: String,
        token: String,
    ) -> Result<AgentTaskCommandResult, ApplicationError> {
        Self::validate_project(&host, &request.project_root)?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(err("This Host is closing"));
        }
        Self::validate_window(&host, &request.window, &context).await?;
        let scope = scope(&request.project_root, &context)?;
        if let AgentTaskCommand::TakeOver {
            control,
            stop: true,
        } = &request.command
        {
            let record = self.owner.get(&scope, &control.task_id)?;
            if record.attachment.controller.window_id != request.window.window_id
                && Self::validate_window(&host, &record.attachment.controller, &context)
                    .await
                    .is_ok()
            {
                return Err(err(
                    "The operating window is still online; stop the Agent there before taking over",
                ));
            }
        }
        // No await between durable admission and spawning the owned native action.
        let admission = self.owner.admit(&scope, &request, now())?;
        let id = admission.task.task.task_id.clone();
        let receipt = admission.receipt.clone();
        if !admission.repeated
            && matches!(request.command, AgentTaskCommand::Create { .. })
            && let Some(catalog) = self
                .catalogs
                .lock()
                .unwrap()
                .get(&(scope.project.clone(), admission.task.task.provider))
                .cloned()
        {
            self.owner.update(
                &scope,
                &id,
                admission.task.attachment.generation,
                |t, _, _, _| {
                    t.attachment.capabilities = catalog.capabilities;
                    Ok(())
                },
            )?;
        }
        if admission.native && !admission.repeated {
            let service = self.clone();
            let background_scope = scope.clone();
            tokio::spawn(async move {
                let gate = service.gate(&id).await;
                let _guard = gate.lock().await;
                let generation = admission.task.attachment.generation;
                if let Err(error) = service
                    .run(
                        &host,
                        &context,
                        &background_scope,
                        &request,
                        &admission,
                        (&endpoint, &token),
                    )
                    .await
                {
                    let snapshot = service
                        .live
                        .lock()
                        .await
                        .get(&id)
                        .map(|live| live.session.snapshot());
                    let _ = service.fail(
                        &background_scope,
                        &id,
                        generation,
                        &admission.receipt,
                        error,
                        snapshot,
                    );
                }
            });
        } else if !admission.repeated
            && matches!(
                request.command,
                AgentTaskCommand::TakeOver { stop: false, .. }
            )
            && let Some(live) = self.live.lock().await.get(&id).cloned()
        {
            live.session.rebind(request.window.clone());
            live.generation
                .store(admission.task.attachment.generation, Ordering::Release);
        }
        let detail = self.owner.detail(&scope, &receipt.task_id)?;
        Ok(AgentTaskCommandResult { receipt, detail })
    }
    fn fail(
        &self,
        scope: &ApplicationScope,
        id: &str,
        generation: u64,
        original: &AgentCommandReceipt,
        failure: TaskFailure,
        native: Option<AgentClientSession>,
    ) -> Result<(), ApplicationError> {
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
                if let Some(id) = failure.native_id {
                    t.task.native_session_id = Some(id.clone());
                    receipt.native_session_id = Some(id);
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
        scope: &ApplicationScope,
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
        host: &NextHost,
        context: &CallContext,
        scope: &ApplicationScope,
        request: &AgentTasksCommand,
        a: &AgentTaskAdmission,
        connection: (&str, &str),
    ) -> Result<(), TaskFailure> {
        let (endpoint, token) = connection;
        let id = &a.task.task.task_id;
        let generation = a.task.attachment.generation;
        if self.owner.get(scope, id)?.attachment.generation != generation {
            return Err(TaskFailure::before(
                "Task attachment changed before the command ran",
            ));
        }
        match &request.command {
            AgentTaskCommand::Send { .. } => {
                let parts = self.input(host, context, scope, &a.task, &a.draft).await?;
                let live = self
                    .connection(scope, &a.task, request, endpoint, token)
                    .await?;
                live.session
                    .configure(
                        &a.task.task.model,
                        a.task.task.effort.as_deref(),
                        a.task.task.mode.as_deref(),
                    )
                    .await
                    .map_err(TaskFailure::before)?;
                let current = self.owner.get(scope, id)?;
                if self.stopped.load(Ordering::Acquire)
                    || current.attachment.generation != generation
                    || current.attachment.control_frozen
                    || current.attachment.state == "stopping"
                {
                    return Err(TaskFailure::before(
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
                    .map_err(TaskFailure::uncertain)?;
                let _flush = live.flush.lock().await;
                let page = live.session.events(live.cursor.load(Ordering::Acquire));
                let current = live.session.snapshot();
                let status = native_receipt_status(&current.state);
                let mut receipt = self.receipt(scope, &a.receipt, status, current.error.clone());
                receipt.native_session_id = Some(current.native_session_id);
                receipt.native_turn_id = live.session.native_turn_id();
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
                        if d.version == a.draft.version && !matches!(status, "uncertain" | "failed")
                        {
                            d.content = AgentDraftContent::default();
                            d.version += 1;
                            d.updated_at_ms = now();
                        }
                        append_events(t, page.events.clone(), events);
                        receipts.push(receipt);
                        Ok(())
                    })?;
                live.cursor.store(page.cursor, Ordering::Release);
                drop(_flush);
                self.watch(scope.clone(), id.clone(), live);
            }
            AgentTaskCommand::Connect { .. } | AgentTaskCommand::Resume { .. } => {
                let live = self
                    .connection(scope, &a.task, request, endpoint, token)
                    .await?;
                live.session
                    .configure(
                        &a.task.task.model,
                        a.task.task.effort.as_deref(),
                        a.task.task.mode.as_deref(),
                    )
                    .await
                    .map_err(TaskFailure::before)?;
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
                    TaskFailure::before("Native connection was lost while updating configuration")
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
                        .map_err(TaskFailure::before)?;
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
                    TaskFailure::before("Native permission connection is unavailable")
                })?;
                live.session
                    .decide(*decision_id, option_id)
                    .await
                    .map_err(TaskFailure::uncertain)?;
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
                            .map_err(TaskFailure::uncertain)?;
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
                    .map_err(|_| TaskFailure::uncertain("Native stop could not be confirmed"))?;
                    if matches!(
                        live.session.snapshot().state.as_str(),
                        "uncertain" | "disconnected"
                    ) {
                        return Err(TaskFailure::uncertain(
                            "Native quiet is not confirmed; control was not transferred",
                        ));
                    }
                } else if !a.task.native_quiet {
                    let proof = a.task.process.as_ref().ok_or_else(|| {
                        TaskFailure::uncertain(
                            "The previous Agent process has no verifiable ownership evidence",
                        )
                    })?;
                    self.factory
                        .recover_process(&to_proof(proof))
                        .await
                        .map_err(TaskFailure::uncertain)?;
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
                    live.closed.store(true, Ordering::Release);
                    live.session.close().await;
                    if let Some(proof) = live.session.process_proof() {
                        self.factory
                            .recover_process(&proof)
                            .await
                            .map_err(TaskFailure::uncertain)?;
                    } else {
                        return Err(TaskFailure::uncertain(
                            "Cannot verify that the native process ended",
                        ));
                    }
                } else if !a.task.native_quiet {
                    let proof = a.task.process.as_ref().ok_or_else(|| {
                        TaskFailure::uncertain(
                            "Cannot confirm ownership of the previous native process",
                        )
                    })?;
                    self.factory
                        .recover_process(&to_proof(proof))
                        .await
                        .map_err(TaskFailure::uncertain)?;
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
                    return Err(TaskFailure::before("Invalid attachment metadata"));
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|_| TaskFailure::before("Invalid attachment encoding"))?;
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
                        return Err(ApplicationError::Conflict);
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
        scope: &ApplicationScope,
        task: &StoredAgentTask,
        request: &AgentTasksCommand,
        endpoint: &str,
        token: &str,
    ) -> Result<Arc<LiveTask>, TaskFailure> {
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
            live.closed.store(true, Ordering::Release);
            self.live.lock().await.remove(&task.task.task_id);
            live.session.close().await;
            let proof = live.session.process_proof().ok_or_else(|| {
                TaskFailure::uncertain("Cannot verify ownership of the previous native process")
            })?;
            self.factory
                .recover_process(&proof)
                .await
                .map_err(TaskFailure::uncertain)?;
        }
        let permit = if replacing {
            tokio::time::timeout(Duration::from_secs(1), self.slots.clone().acquire_owned())
                .await
                .map_err(|_| TaskFailure::before("Previous connection is still closing"))?
                .map_err(|_| TaskFailure::before("Agent connection service closed"))?
        } else {
            self.slots.clone().try_acquire_owned().map_err(|_| {
                TaskFailure::before(
                    "Eight Agent connections are active. Disconnect an idle task first.",
                )
            })?
        };
        if !task.native_quiet {
            let proof = task.process.as_ref().ok_or_else(|| {
                TaskFailure::uncertain("Cannot confirm ownership of the previous native process")
            })?;
            self.factory
                .recover_process(&to_proof(proof))
                .await
                .map_err(TaskFailure::uncertain)?;
        }
        let session = self
            .factory
            .open(NativeOpenRequest {
                provider: task.task.provider,
                root: task.task.project_root.clone().into(),
                window: request.window.clone(),
                native_session_id: task.task.native_session_id.clone(),
                endpoint: endpoint.into(),
                token: token.into(),
                interrupted: task.interrupted_context || task.active_request.is_some(),
            })
            .await
            .map_err(|e| TaskFailure {
                message: e.error,
                uncertain: e.uncertain,
                native_id: e.native_session_id,
            })?;
        let snapshot = session.snapshot();
        if self.stopped.load(Ordering::Acquire) {
            session.close().await;
            return Err(TaskFailure {
                message: "Host closed while the native connection was opening".into(),
                uncertain: false,
                native_id: Some(snapshot.native_session_id),
            });
        }
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
        });
        let page = live.session.events(0);
        self.owner.update(
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
        )?;
        live.cursor.store(page.cursor, Ordering::Release);
        self.live
            .lock()
            .await
            .insert(task.task.task_id.clone(), live.clone());
        self.watch(scope.clone(), task.task.task_id.clone(), live.clone());
        Ok(live)
    }
    fn watch(self: &Arc<Self>, scope: ApplicationScope, id: String, live: Arc<LiveTask>) {
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
                    .update(&scope, &id, generation, |t, _, rs, events| {
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
                if snapshot.state == "disconnected" {
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
    async fn input(
        &self,
        host: &NextHost,
        context: &CallContext,
        scope: &ApplicationScope,
        task: &StoredAgentTask,
        draft: &AgentTaskDraft,
    ) -> Result<Vec<NativeInput>, TaskFailure> {
        let mut parts = vec![NativeInput::Text(draft.content.text.clone())];
        let overview = host
            .dispatch(
                context,
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: CapabilityRef {
                        id: "host.overview".into(),
                        version: 1,
                    },
                    arguments: json!({}),
                }),
            )
            .await
            .map_err(|e| TaskFailure::before(e.to_string()))?;
        let unconfirmed = self
            .owner
            .store
            .agent_receipts(scope, &task.task.task_id)?
            .into_iter()
            .filter(unconfirmed_receipt)
            .map(|r| json!({"request_id":r.request_id,"status":r.status}))
            .take(32)
            .collect::<Vec<_>>();
        parts.push(NativeInput::Resource{uri:"rho://connection-context".into(),mime_type:"application/json".into(),text:json!({"project":scope.project,"window":task.attachment.controller,"workspace":overview["data"],"previous_unconfirmed_requests":unconfirmed}).to_string()});
        for id in &draft.content.assets {
            let (asset, bytes) = self
                .owner
                .store
                .agent_asset(scope, &task.task.task_id, id)?;
            if asset.mime_type.starts_with("image/") {
                parts.push(NativeInput::Image {
                    mime_type: asset.mime_type,
                    data: bytes,
                });
            } else {
                let text = String::from_utf8(bytes).map_err(|_| {
                    TaskFailure::before(format!(
                        "{} is not a supported text/image input for this Agent",
                        asset.name
                    ))
                })?;
                parts.push(NativeInput::Resource {
                    uri: format!("rho://attachments/{}/{}", task.task.task_id, asset.asset_id),
                    text,
                    mime_type: asset.mime_type,
                });
            }
        }
        let providers = self.context_providers.read().unwrap().clone();
        let reader = crate::AgentContextReader::new(&scope.project, host, context);
        for selection in &draft.content.context {
            let captured = crate::agent_context::preview(
                &reader,
                &task.attachment.controller,
                selection,
                &providers,
                true,
            )
            .await
            .map_err(TaskFailure::before)?;
            parts.extend(crate::agent_context::input(captured).map_err(TaskFailure::before)?);
        }
        Ok(parts)
    }
    pub fn asset(
        &self,
        context: &CallContext,
        project: &str,
        task: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
        self.owner
            .store
            .agent_asset(&scope(project, context)?, task, asset)
    }
}
struct TaskFailure {
    message: String,
    uncertain: bool,
    native_id: Option<String>,
}
impl TaskFailure {
    fn before(error: impl ToString) -> Self {
        Self {
            message: error.to_string(),
            uncertain: false,
            native_id: None,
        }
    }
    fn uncertain(error: impl ToString) -> Self {
        Self {
            message: error.to_string(),
            uncertain: true,
            native_id: None,
        }
    }
}
impl From<ApplicationError> for TaskFailure {
    fn from(e: ApplicationError) -> Self {
        Self::before(e)
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
