//! Composition and narrow tool access for the optional component engine.
use crate::{ApplicationStore, NextHost};
use async_trait::async_trait;
use rho_application::*;
use rho_contract::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

mod context;
mod registry;
use registry::{RegisteredTool, registered_tools};

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn error(error: impl ToString) -> ApplicationError {
    ApplicationError::InvalidInput(error.to_string())
}
struct LiveRun {
    cancellation: CancellationToken,
    scope: ApplicationScope,
}
type SecretScope = (String, String, String);

pub struct ComponentAgentService {
    owner: Arc<ComponentAgentOwner>,
    engine: Arc<dyn ComponentAgentEngine>,
    live: Mutex<BTreeMap<String, LiveRun>>,
    gate: Mutex<()>,
    slots: Arc<Semaphore>,
    tasks: TaskTracker,
    closed: AtomicBool,
    keys: RwLock<BTreeMap<SecretScope, Arc<ComponentModelKey>>>,
}
impl ComponentAgentService {
    pub fn new(store: Arc<ApplicationStore>) -> Arc<Self> {
        Self::with_engine(store, Arc::new(rho_agents::RigComponentEngine::default()))
    }
    pub fn with_engine(
        store: Arc<dyn ComponentAgentRepository>,
        engine: Arc<dyn ComponentAgentEngine>,
    ) -> Arc<Self> {
        Arc::new(Self {
            owner: Arc::new(ComponentAgentOwner::new(
                store,
                uuid::Uuid::new_v4().to_string(),
            )),
            engine,
            live: Mutex::new(BTreeMap::new()),
            gate: Mutex::new(()),
            slots: Arc::new(Semaphore::new(MAX_COMPONENT_RUNNING_RUNS)),
            tasks: TaskTracker::new(),
            closed: AtomicBool::new(false),
            keys: RwLock::new(BTreeMap::new()),
        })
    }
    fn scope(
        host: &NextHost,
        context: &CallContext,
        project: &str,
    ) -> Result<ApplicationScope, ApplicationError> {
        context.validate().map_err(error)?;
        if !host
            .runtime
            ._project_lease
            .as_ref()
            .is_some_and(|lease| lease.root().to_str() == Some(project))
        {
            return Err(error("Component request belongs to a different project"));
        }
        host.application_owner().map_err(error)?.scope(context)
    }
    fn actor(
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
    ) -> Result<ComponentActor, ApplicationError> {
        Self::scope(host, context, project)?;
        host.application_owner()
            .map_err(error)?
            .component_actor(context, window, now())
    }
    pub fn settings(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        self.owner
            .store
            .component_settings(&Self::scope(host, context, project)?)
    }
    pub async fn preview_source(
        &self,
        host: &NextHost,
        context: &CallContext,
        request: ComponentSourcePreviewRequest,
    ) -> Result<ComponentSourcePreview, ApplicationError> {
        context::preview(host, context, &request, false).await
    }
    pub async fn configure(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        settings: &ComponentModelSettings,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        let _gate = self.gate.lock().await;
        let actor = Self::actor(host, context, project, window)?;
        let updated = self.owner.configure(&actor, settings, now())?;
        if !updated.enabled {
            for run in self
                .live
                .lock()
                .await
                .values()
                .filter(|r| r.scope == *actor.scope())
            {
                run.cancellation.cancel();
            }
        }
        Ok(updated)
    }
    pub fn put_session_key(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        value: String,
    ) -> Result<ComponentCredentialRef, ApplicationError> {
        let actor = Self::actor(host, context, project, window)?;
        let key = ComponentModelKey::new(value)?;
        let key_id = uuid::Uuid::new_v4().to_string();
        let mut keys = self
            .keys
            .write()
            .map_err(|_| error("Model credential store unavailable"))?;
        if keys.len() >= 64 {
            return Err(ApplicationError::Budget(
                "Host session credential limit reached".into(),
            ));
        }
        keys.insert(
            (
                actor.scope().project.clone(),
                actor.scope().principal.clone(),
                key_id.clone(),
            ),
            Arc::new(key),
        );
        Ok(ComponentCredentialRef::Session { key_id })
    }
    fn key(
        &self,
        scope: &ApplicationScope,
        reference: &ComponentCredentialRef,
    ) -> Result<ComponentModelKey, ApplicationError> {
        match reference {
            ComponentCredentialRef::Environment { name } => ComponentModelKey::new(
                std::env::var(name)
                    .map_err(|_| error("Configured model credential is unavailable"))?,
            ),
            ComponentCredentialRef::Session { key_id } => {
                let keys = self
                    .keys
                    .read()
                    .map_err(|_| error("Model credential store unavailable"))?;
                ComponentModelKey::new(
                    keys.get(&(
                        scope.project.clone(),
                        scope.principal.clone(),
                        key_id.clone(),
                    ))
                    .ok_or_else(|| {
                        error("Session model credential is unavailable after Host restart")
                    })?
                    .expose()
                    .into(),
                )
            }
        }
    }
    pub fn create(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        id: &str,
        profile: ComponentAgentProfile,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        self.owner.create(
            &Self::actor(host, context, project, window)?,
            id,
            profile,
            now(),
        )
    }
    pub fn conversation(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        id: &str,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        self.owner
            .store
            .component_conversation(&Self::scope(host, context, project)?, id)?
            .ok_or(ApplicationError::NotFound)
    }
    pub fn conversations(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ComponentAgentConversation>, ApplicationError> {
        self.owner.store.component_conversations(
            &Self::scope(host, context, project)?,
            after,
            limit,
        )
    }
    pub fn save_draft(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        draft: ComponentAgentDraftUpdate,
    ) -> Result<(), ApplicationError> {
        self.owner.save_draft(
            &Self::actor(host, context, project, window)?,
            &draft.conversation_id,
            draft.draft_version,
            draft.text,
            now(),
        )
    }
    pub fn run(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        id: &str,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        self.owner
            .store
            .component_run(&Self::scope(host, context, project)?, id)?
            .map(|r| r.run)
            .ok_or(ApplicationError::NotFound)
    }
    pub fn run_by_request(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        id: &str,
    ) -> Result<Option<ComponentAgentRun>, ApplicationError> {
        Ok(self
            .owner
            .store
            .component_run_by_request(&Self::scope(host, context, project)?, id)?
            .map(|r| r.run))
    }
    pub fn tools(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        run: &str,
    ) -> Result<Vec<ComponentToolReceipt>, ApplicationError> {
        Ok(self
            .owner
            .store
            .component_tools(&Self::scope(host, context, project)?, run)?
            .into_iter()
            .map(|t| t.receipt)
            .collect())
    }
    pub fn events(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        run: &str,
        after: u64,
        limit: usize,
    ) -> Result<ComponentAgentEventPage, ApplicationError> {
        self.owner
            .store
            .component_events(&Self::scope(host, context, project)?, run, after, limit)
    }
    pub async fn start(
        self: &Arc<Self>,
        host: Arc<NextHost>,
        context: CallContext,
        project: &str,
        request: ComponentAgentStart,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        let _gate = self.gate.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(error("Component service is closing"));
        }
        let actor = Self::actor(&host, &context, project, &request.window)?;
        if self
            .owner
            .store
            .component_run_by_request(actor.scope(), &request.request_id)?
            .is_some()
        {
            return Ok(self.owner.start(&actor, request, now())?.run.run);
        }
        if request.grant.mode != ComponentAgentMode::Explain {
            return Err(error("Authorized write dispatch is not connected yet"));
        }
        if serde_json::to_vec(&request).map_err(error)?.len() > 64 * 1024 {
            return Err(error("Assistant request exceeds 64 KiB"));
        }
        drop(_gate);
        let prepared = context::prepare(&host, &context, project, &request).await?;
        let _gate = self.gate.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(error("Component service is closing"));
        }
        let admission = self.owner.start(&actor, request, now())?;
        if admission.repeated {
            return Ok(admission.run.run);
        }
        let mut run = admission.run.run;
        if let Err(error) =
            self.owner
                .capture_context(actor.scope(), &run.run_id, prepared.context.clone(), now())
        {
            let _ = self.owner.finish(
                actor.scope(),
                &run.run_id,
                ComponentAgentRunState::Failed,
                Some("Context persistence failed before model dispatch".into()),
                now(),
            );
            return Err(error);
        }
        run.context = Some(prepared.context);
        let images = prepared.images;
        let cancellation = CancellationToken::new();
        let scope = actor.scope().clone();
        self.live.lock().await.insert(
            run.run_id.clone(),
            LiveRun {
                cancellation: cancellation.clone(),
                scope: scope.clone(),
            },
        );
        let service = self.clone();
        let accepted = run.clone();
        self.tasks.spawn(async move {
            let stopped = cancellation.clone();
            let mut outcome = service
                .execute(
                    host,
                    context,
                    scope.clone(),
                    run.clone(),
                    cancellation,
                    images,
                )
                .await;
            // Serialize final acknowledgement against Stop/Disable admission.
            let _gate = service.gate.lock().await;
            if stopped.is_cancelled() {
                outcome = ComponentEngineOutcome::Stopped;
            }
            let (state, reason) = match outcome {
                ComponentEngineOutcome::Completed => (ComponentAgentRunState::Completed, None),
                ComponentEngineOutcome::Stopped => (ComponentAgentRunState::Stopped, None),
                ComponentEngineOutcome::Failed(reason) => {
                    (ComponentAgentRunState::Failed, Some(reason))
                }
            };
            // A storage failure deliberately leaves the durable run nonterminal for recovery.
            let _ = service
                .owner
                .finish(&scope, &run.run_id, state, reason, now());
            service.live.lock().await.remove(&run.run_id);
        });
        Ok(accepted)
    }
    async fn execute(
        self: &Arc<Self>,
        host: Arc<NextHost>,
        context: CallContext,
        scope: ApplicationScope,
        run: ComponentAgentRun,
        cancellation: CancellationToken,
        images: Vec<ComponentImageInput>,
    ) -> ComponentEngineOutcome {
        let permit = tokio::select! {biased;_=cancellation.cancelled()=>return ComponentEngineOutcome::Stopped,p=self.slots.clone().acquire_owned()=>p};
        let Ok(_permit) = permit else {
            return ComponentEngineOutcome::Stopped;
        };
        let result: Result<ComponentEngineOutcome, ApplicationError> = async {
            let key = self.key(&scope, &run.model.credential)?;
            self.owner.claim(&scope, &run.run_id, now())?;
            let mut native = context.clone();
            native.principal = Some(context.principal().clone());
            native.caller = CallerIdentity {
                kind: CallerKind::Agent,
                id: format!("component:{}", run.run_id),
            };
            native.connection_id = format!("component:{}", run.run_id);
            native.correlation_id = Some(run.run_id.clone());
            let registered = registered_tools(&host, &native, &run)?;
            native.scopes = registered
                .values()
                .flat_map(|t| t.descriptor.required_scopes.iter().cloned())
                .collect::<BTreeSet<_>>();
            let tools = registered.values().map(|t| t.spec.clone()).collect();
            let port = Arc::new(HostRunPort {
                host,
                owner: self.owner.clone(),
                scope,
                context: native,
                run: run.clone(),
                registered,
                cancellation: cancellation.clone(),
            });
            Ok(self
                .engine
                .execute(ComponentEngineExecution {
                    context: serde_json::to_string(&run.context).map_err(error)?,
                    run,
                    images,
                    tools,
                    key,
                    port,
                    cancellation,
                })
                .await)
        }
        .await;
        match result {
            Ok(outcome) => outcome,
            Err(e) => ComponentEngineOutcome::Failed(e.to_string()),
        }
    }
    pub async fn stop(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        run_id: &str,
    ) -> Result<ComponentAgentRun, ApplicationError> {
        let _gate = self.gate.lock().await;
        let actor = Self::actor(host, context, project, window)?;
        let run = self.owner.stop(&actor, run_id, now())?;
        if let Some(live) = self.live.lock().await.get(run_id)
            && live.scope == *actor.scope()
        {
            live.cancellation.cancel();
        }
        Ok(run.run)
    }
    pub async fn has_live(&self) -> bool {
        !self.live.lock().await.is_empty()
    }
    pub async fn close(&self) {
        {
            let _gate = self.gate.lock().await;
            self.closed.store(true, Ordering::SeqCst);
            for run in self.live.lock().await.values() {
                run.cancellation.cancel();
            }
            self.tasks.close();
        }
        self.tasks.wait().await;
        if let Ok(mut keys) = self.keys.write() {
            keys.clear();
        }
    }
}

struct HostRunPort {
    host: Arc<NextHost>,
    owner: Arc<ComponentAgentOwner>,
    scope: ApplicationScope,
    context: CallContext,
    run: ComponentAgentRun,
    registered: BTreeMap<String, RegisteredTool>,
    cancellation: CancellationToken,
}
#[async_trait]
impl ComponentRunPort for HostRunPort {
    async fn begin_model_call(&self) -> Result<u32, ApplicationError> {
        if self.cancellation.is_cancelled() {
            return Err(error("Component run stopped"));
        }
        self.owner
            .begin_model_call(&self.scope, &self.run.run_id, now())
    }
    async fn prepare_tool(
        &self,
        model_call: u32,
        call_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<ComponentToolAdmission, ApplicationError> {
        if self.cancellation.is_cancelled() {
            return Err(error("Component run stopped"));
        }
        let tool = self
            .registered
            .get(name)
            .ok_or_else(|| error("Tool is outside this component's scope"))?;
        let action = tool.bind(&self.run, arguments)?;
        self.owner.admit_tool(
            &self.scope,
            &self.run.run_id,
            model_call,
            call_id,
            action,
            now(),
        )
    }
    async fn execute_tool(
        &self,
        admission: ComponentToolAdmission,
    ) -> Result<Value, ApplicationError> {
        let tool = self
            .owner
            .store
            .component_tools(&self.scope, &self.run.run_id)?
            .into_iter()
            .find(|tool| tool.receipt.receipt_id == admission.tool.receipt.receipt_id)
            .ok_or(ApplicationError::NotFound)?;
        if component_digest(&tool.action)? != component_digest(&admission.tool.action)? {
            return Err(error("Tool ticket differs from its durable intent"));
        }
        if admission.repeated {
            return Ok(tool.receipt.result.unwrap_or_else(||json!({"status":"uncertain","receipt_id":tool.receipt.receipt_id,"message":"Original tool intent is unconfirmed; it was not replayed"})));
        }
        if self.cancellation.is_cancelled() {
            return Err(error("Component run stopped"));
        }
        self.owner.check_tool_dispatch(
            &self.scope,
            &self.run.run_id,
            &tool.receipt.receipt_id,
            now(),
        )?;
        let ComponentToolAction::Query(query) = &tool.action else {
            return Err(error("Mutation dispatch is not connected"));
        };
        let needs_session = query.arguments.get("workspace_instance_id").is_some()
            && query.capability.id.starts_with("workspace.");
        let _hold = if needs_session {
            let session = self
                .run
                .request
                .grant
                .session
                .as_ref()
                .ok_or_else(|| error("Native session is not bound"))?;
            Some(
                self.host
                    .hold_runtime_instance(
                        &session.workspace_instance_id,
                        &session.session_id,
                        &tool.receipt.client_request_id,
                        "Component query",
                    )
                    .map_err(error)?,
            )
        } else {
            None
        };
        let mut value = match self
            .host
            .dispatch(&self.context, HostRequest::QuerySnapshot(query.clone()))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                json!({"status":"error","error":error.to_string(),"capability":query.capability})
            }
        };
        let mut evidence = Vec::new();
        if query.capability.id == "workspace.console_state"
            && let Some(data) = value.get_mut("data").and_then(Value::as_object_mut)
        {
            let waiting = data.remove("input").is_some_and(|input| !input.is_null());
            data.insert("needs_user_input".into(), json!(waiting));
            value["model_projection"] = json!({"omitted_fields":["data.input"],"reason":"Native input belongs to the user"});
        }
        if query.capability.id == "output.view"
            && let Some(data) = value.get_mut("data").and_then(Value::as_object_mut)
        {
            data.remove("preview_base64");
            if let Some(reference) = data.get("reference").cloned() {
                let included = self.run.context.as_ref().is_some_and(|context| {
                    context.sources.iter().any(|source| {
                        source.selection.source == "plots"
                            && source.selection.inclusion == "image"
                            && source.selection.reference == reference
                    })
                });
                if let Ok(reference) = serde_json::from_value(reference) {
                    evidence.push(ComponentAgentEvidence::Media { reference });
                }
                value["model_projection"] = json!({"omitted_fields":["data.preview_base64"],"image_in_initial_context":included,"reason":if included{"Verified image is already provided with selected sources"}else{"Add this plot as image context before visual analysis"}});
            }
        }
        if query.capability.id == "project.read_text"
            && let Some(file) = value["data"].get("file")
            && let (Some(path), Some(sha256)) = (file["path"].as_str(), file["sha256"].as_str())
        {
            evidence.push(ComponentAgentEvidence::File {
                path: path.into(),
                sha256: sha256.into(),
            });
        }
        self.owner.record_tool(
            &self.scope,
            &self.run.run_id,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: value.clone(),
                evidence,
            },
            now(),
        )?;
        Ok(value)
    }
    async fn append_text(&self, text: String) -> Result<(), ApplicationError> {
        self.owner
            .append_text(&self.scope, &self.run.run_id, text, now())
    }
    async fn record_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Result<(), ApplicationError> {
        self.owner.record_usage(
            &self.scope,
            &self.run.run_id,
            input_tokens,
            output_tokens,
            now(),
        )
    }
    async fn interrupted_tool(&self, tool: &StoredComponentTool) -> Result<(), ApplicationError> {
        let current = self
            .owner
            .store
            .component_tools(&self.scope, &self.run.run_id)?
            .into_iter()
            .find(|t| t.receipt.receipt_id == tool.receipt.receipt_id)
            .ok_or(ApplicationError::NotFound)?;
        if matches!(
            current.receipt.phase,
            ComponentToolPhase::Intent | ComponentToolPhase::Accepted
        ) {
            self.owner.record_tool(
                &self.scope,
                &self.run.run_id,
                &tool.receipt.receipt_id,
                ComponentToolUpdate::Uncertain {
                    reason: "Tool wait interrupted; original request identity retained".into(),
                },
                now(),
            )?;
        }
        Ok(())
    }
}
