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
use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) mod context;
mod assets;
mod credentials;
mod continuation;
mod mutations;
mod recovery;
mod history;
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

async fn model_slot(slots: Arc<Semaphore>, cancellation: &CancellationToken, deadline_ms: u64)
    -> Result<OwnedSemaphorePermit, ComponentEngineOutcome> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ComponentEngineOutcome::Stopped),
        _ = tokio::time::sleep(std::time::Duration::from_millis(deadline_ms.saturating_sub(now()))) =>
            Err(ComponentEngineOutcome::Failed("Component run deadline exceeded while queued".into())),
        permit = slots.acquire_owned() => permit.map_err(|_| ComponentEngineOutcome::Stopped),
    }
}

#[cfg(test)]
mod model_slot_tests {
    use super::*;
    #[tokio::test]
    async fn queue_deadline_expires_without_a_slot_or_a_model_call() {
        let slots=Arc::new(Semaphore::new(0));
        let cancellation=CancellationToken::new();
        let result=tokio::time::timeout(std::time::Duration::from_secs(1),
            model_slot(slots.clone(),&cancellation,now()+10)).await.unwrap();
        assert!(matches!(result,Err(ComponentEngineOutcome::Failed(message)) if message.contains("while queued")));
        assert_eq!(slots.available_permits(),0);
    }
}
fn native_error(host: &NextHost, context: &CallContext, failure: rho_operation::OperationError) -> ApplicationError {
    ApplicationError::Diagnostic(Box::new(host.runtime.gateway.diagnostic(context, &failure)))
}
fn observe_test_liveness(diagnostic: &mut ComponentModelDiagnostic, live: bool) {
    if !live && matches!(diagnostic.state, ComponentModelTestState::Queued | ComponentModelTestState::Running) {
        diagnostic.state = ComponentModelTestState::Interrupted;
        diagnostic.detail = Some("The original Host no longer owns this model test; its final result is unconfirmed".into());
    }
}
struct LiveRun {
    permission_changed: Arc<Notify>,
    cancellation: CancellationToken,
    scope: ApplicationScope,
}
type SecretScope = (String, String, String);

pub struct ComponentAgentService {
    owner: Arc<ComponentAgentOwner>,
    engine: Arc<dyn ComponentAgentEngine>,
    live: Mutex<BTreeMap<String, LiveRun>>,
    tests: Mutex<BTreeMap<SecretScope, CancellationToken>>,
    gate: Mutex<()>,
    slots: Arc<Semaphore>,
    test_slot: Arc<Semaphore>,
    credential_file: credentials::CredentialFile,
    tasks: TaskTracker,
    closed: AtomicBool,
    keys: RwLock<BTreeMap<SecretScope, Arc<ComponentModelKey>>>,
}
impl ComponentAgentService {
    pub(crate) fn with_handoff_write<T>(&self, write: impl FnOnce() -> Result<T, ApplicationError>) -> Result<T, ApplicationError> {
        self.owner.with_handoff_write(write)
    }
    pub fn host_incarnation(&self) -> &str { &self.owner.host_incarnation }

    pub async fn live_run_ids(&self) -> Vec<String> {
        let _gate = self.gate.lock().await;
        self.live.lock().await.keys().cloned().collect()
    }

    pub async fn with_live_run_ids<T>(&self, read: impl FnOnce(&[String]) -> T) -> T {
        let _gate = self.gate.lock().await;
        let ids: Vec<_> = self.live.lock().await.keys().cloned().collect();
        read(&ids)
    }

    pub async fn decide_permission(&self, host: &NextHost, context: &CallContext,
        project: &str, window: &ApplicationWindowRef, run_id: &str,
        decision_id: &str, allow: bool) -> Result<ComponentAgentRun, ApplicationError> {
        let _gate = self.gate.lock().await;
        let actor = Self::actor(host, context, project, window)?;
        let live = self.live.lock().await;
        let signal = live.get(run_id).filter(|run| run.scope == *actor.scope())
            .ok_or_else(|| error("The original task is no longer running; check its status"))?;
        let run = self.owner.decide_permission(&actor, run_id, decision_id, allow, now())?;
        signal.permission_changed.notify_one();
        Ok(run)
    }
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
            tests: Mutex::new(BTreeMap::new()),
            gate: Mutex::new(()),
            slots: Arc::new(Semaphore::new(MAX_COMPONENT_RUNNING_RUNS)),
            test_slot: Arc::new(Semaphore::new(1)),
            credential_file: credentials::CredentialFile::user_config(),
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
            return Err(ApplicationError::Diagnostic(Box::new(Diagnostic {
                code: DiagnosticCode::Unavailable,
                message: "Component request belongs to a different project".into(),
                continuation: DiagnosticContinuation::ReadAgain,
                next_reads: vec![],
            })));
        }
        host.application_owner().map_err(|failure| native_error(host, context, failure))?.scope(context)
    }
    fn actor(
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
    ) -> Result<ComponentActor, ApplicationError> {
        Self::scope(host, context, project)?;
        host.application_owner()
            .map_err(|failure| native_error(host, context, failure))?
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
    pub async fn search_sources(
        &self,
        host: &NextHost,
        context: &CallContext,
        request: ComponentSourceSearch,
    ) -> Result<ComponentSourceSearchResult, ApplicationError> {
        context::search(host, context, &request).await
    }
    pub fn diagnostics(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
    ) -> Result<Vec<ComponentModelDiagnostic>, ApplicationError> {
        let scope = Self::scope(host, context, project)?;
        let mut diagnostics = self.owner.store.component_diagnostics(&scope)?;
        // Derive liveness only between admission/completion transitions. If a
        // transition is in flight, retain its bounded stored observation.
        if let Ok(_gate) = self.gate.try_lock()
            && let Ok(tests) = self.tests.try_lock() {
            for diagnostic in &mut diagnostics {
                let live = tests.contains_key(&(scope.project.clone(), scope.principal.clone(), diagnostic.request_id.clone()));
                observe_test_liveness(diagnostic, live);
            }
        }
        Ok(diagnostics)
    }
    pub fn diagnostic(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        id: &str,
    ) -> Result<Option<ComponentModelDiagnostic>, ApplicationError> {
        let scope = Self::scope(host, context, project)?;
        let mut diagnostic = self.owner.store.component_diagnostic(&scope, id)?;
        if let Some(diagnostic) = &mut diagnostic
            && let Ok(_gate) = self.gate.try_lock()
            && let Ok(tests) = self.tests.try_lock() {
            observe_test_liveness(diagnostic, tests.contains_key(&(scope.project.clone(), scope.principal.clone(), id.into())));
        }
        Ok(diagnostic)
    }
    pub async fn test_model(
        self: &Arc<Self>,
        host: Arc<NextHost>,
        context: CallContext,
        request: ComponentModelTestRequest,
    ) -> Result<ComponentModelDiagnostic, ApplicationError> {
        let _gate = self.gate.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(error("Component service is closing"));
        }
        let actor = Self::actor(&host, &context, &request.project_root, &request.window)?;
        if self
            .owner
            .store
            .component_diagnostic(actor.scope(), &request.request_id)?
            .is_some()
        {
            let mut diagnostic = self.owner.begin_model_test(&actor, &request, now())?.0;
            observe_test_liveness(&mut diagnostic, self.tests.lock().await.contains_key(&(
                actor.scope().project.clone(), actor.scope().principal.clone(), request.request_id.clone())));
            return Ok(diagnostic);
        }
        if self.live.lock().await.len() + self.tests.lock().await.len() >= MAX_COMPONENT_QUEUED_RUNS
        {
            return Err(ApplicationError::Budget(
                "Model request queue is full".into(),
            ));
        }
        // Diagnostics reserve their own category before joining the shared model queue.
        // The service gate makes the request identity and visible busy reference stable.
        let category_permit = self.test_slot.clone().try_acquire_owned().map_err(|_| {
            ApplicationError::Busy {
                message: "A model test is already queued or running".into(),
                request_id: None,
            }
        });
        let category_permit = match category_permit {
            Ok(permit) => permit,
            Err(ApplicationError::Busy { message, .. }) => {
                let visible = self.tests.lock().await.keys().find(|(project, principal, _)|
                    project == &actor.scope().project && principal == &actor.scope().principal
                ).map(|(_, _, request_id)| request_id.clone());
                return Err(ApplicationError::Busy { message, request_id: visible });
            },
            Err(error) => return Err(error),
        };
        let settings = self.owner.store.component_settings(actor.scope())?;
        let key = self.key(actor.scope(), &settings.connection.as_ref().ok_or_else(|| error("No model configured"))?.credential)?;
        let (diagnostic, _) = self.owner.begin_model_test(&actor, &request, now())?;
        let scope = actor.scope().clone();
        let identity = (
            scope.project.clone(),
            scope.principal.clone(),
            request.request_id.clone(),
        );
        let cancellation = CancellationToken::new();
        self.tests
            .lock()
            .await
            .insert(identity.clone(), cancellation.clone());
        let service = self.clone();
        let accepted = diagnostic.clone();
        self.tasks.spawn(async move {
            let _host=host;
            let _category_permit = category_permit;
            let work=async {
                let _permit=service.slots.clone().acquire_owned().await.map_err(|_|error("Model service closed"))?;
                service.owner.update_model_test(&scope,&diagnostic.request_id,ComponentModelTestState::Running,None,now())?;
                service.engine.test_model(diagnostic.model.clone(),key,diagnostic.kind,cancellation.clone()).await.map_err(error)
            };
            let result=tokio::select!{biased;_=cancellation.cancelled()=>Err(error("Model test interrupted")),result=tokio::time::timeout(std::time::Duration::from_secs(600),work)=>result.unwrap_or_else(|_|Err(error("Model test request timed out")))};
            let _gate=service.gate.lock().await;
            let (state,detail)=if cancellation.is_cancelled(){(ComponentModelTestState::Interrupted,Some("Model test interrupted".into()))}else{match result{Ok(())=>(ComponentModelTestState::Passed,None),Err(error)=>(ComponentModelTestState::Failed,Some(error.to_string()))}};
            let _=service.owner.update_model_test(&scope,&diagnostic.request_id,state,detail,now());
            service.tests.lock().await.remove(&identity);
        });
        Ok(accepted)
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
        // A settings CAS owns this database row, not all references to a key in
        // other Hosts/databases. Immutable versions are removed only explicitly.
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
            for ((project, principal, _), cancel) in self.tests.lock().await.iter() {
                if project == &actor.scope().project && principal == &actor.scope().principal {
                    cancel.cancel();
                }
            }
        }
        Ok(updated)
    }
    pub async fn stop_test(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        id: &str,
    ) -> Result<ComponentModelDiagnostic, ApplicationError> {
        let _gate = self.gate.lock().await;
        let actor = Self::actor(host, context, project, window)?;
        let original = self
            .owner
            .store
            .component_diagnostic(actor.scope(), id)?
            .ok_or(ApplicationError::NotFound)?;
        if original.window != *window {
            return Err(ApplicationError::Conflict);
        }
        if !matches!(
            original.state,
            ComponentModelTestState::Queued | ComponentModelTestState::Running
        ) {
            return Ok(original);
        }
        let result = self.owner.update_model_test(
            actor.scope(),
            id,
            ComponentModelTestState::Interrupted,
            Some("Model test stopped by the user".into()),
            now(),
        )?;
        if let Some(cancel) = self.tests.lock().await.get(&(
            actor.scope().project.clone(),
            actor.scope().principal.clone(),
            id.into(),
        )) {
            cancel.cancel();
        }
        Ok(result)
    }
    pub fn put_local_key(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        value: String,
    ) -> Result<ComponentCredentialRef, ApplicationError> {
        let actor = Self::actor(host, context, project, window)?;
        self.credential_file.put(actor.scope(), value)
    }
    pub fn credential_status(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
    ) -> Result<ComponentCredentialStatus, ApplicationError> {
        let scope = Self::scope(host, context, project)?;
        let credential = self.owner.store.component_settings(&scope)?.connection.map(|c| c.credential);
        let available = credential.as_ref().is_some_and(|reference| self.key(&scope, reference).is_ok());
        Ok(ComponentCredentialStatus { credential, available })
    }
    pub async fn remove_credential(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        settings_version: u64,
        key_id: &str,
    ) -> Result<ComponentCredentialStatus, ApplicationError> {
        let _gate = self.gate.lock().await;
        let actor = Self::actor(host, context, project, window)?;
        let settings = self.owner.store.component_settings(actor.scope())?;
        if settings.version != settings_version { return Err(ApplicationError::Conflict); }
        let Some(connection) = settings.connection else { return Err(ApplicationError::NotFound); };
        match &connection.credential {
            ComponentCredentialRef::LocalFile { key_id: current } if current == key_id =>
                self.credential_file.remove(actor.scope(), key_id)?,
            ComponentCredentialRef::Session { key_id: current } if current == key_id => {
                self.keys.write().map_err(|_| error("Model credential store unavailable"))?.remove(&(
                    actor.scope().project.clone(), actor.scope().principal.clone(), key_id.into()
                ));
            },
            _ => return Err(ApplicationError::Conflict),
        }
        Ok(ComponentCredentialStatus { credential: Some(connection.credential), available: false })
    }
    /// Legacy test/embedding entry point. Studio saves new keys to the local file.
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
            ).map_err(Into::into),
            ComponentCredentialRef::LocalFile { key_id } => self.credential_file.key(scope, key_id),
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
                ).map_err(Into::into)
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
        self.owner.save_draft_content(
            &Self::actor(host, context, project, window)?,
            &draft.conversation_id,
            draft.draft_version,
            draft.content.unwrap_or(AgentDraftContent { text: draft.text, ..Default::default() }),
            draft.grant,
            now(),
        )
    }
    pub fn update_task_metadata(&self, host: &NextHost, context: &CallContext, project: &str, window: &ApplicationWindowRef, id: &str, expected_version: u64, title: Option<String>, archived: Option<bool>) -> Result<ComponentAgentConversation, ApplicationError> {
        self.owner.update_task_metadata(&Self::actor(host, context, project, window)?, id, expected_version, title, archived, now())?;
        self.conversation(host, context, project, id)
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
            .map(|r| self.owner.observed_run(r))
            .transpose()?
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
            .map(|r| self.owner.observed_run(r)).transpose()?)
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
            let original = self.owner.start(&actor, request, now())?.run;
            let mut run = self.owner.observed_run(original)?;
            if !run.state.is_terminal() && !self.live.lock().await.contains_key(&run.run_id) {
                run.state = ComponentAgentRunState::Interrupted;
                run.reason = Some(
                    "The original request has no live Host task; reconcile its tool records".into(),
                );
            }
            return Ok(run);
        }
        if request.grant.permission_policy.is_none() && request.grant.mode == ComponentAgentMode::Edit && request.grant.documents.is_empty() {
            return Err(error(
                "Open the authorized target as a document before editing",
            ));
        }
        let settings = self.owner.store.component_settings(actor.scope())?;
        if !settings.enabled || settings.connection.is_none() {
            return Err(error("Component assistant is disabled or unconfigured"));
        }
        if settings.version != request.model_settings_version {
            return Err(ApplicationError::Conflict);
        }
        let captured_assets = self.captured_assets(actor.scope(), &request)?;
        if request.sources.iter().any(|source| source.source == "plots" && source.inclusion == "image")
            || captured_assets.iter().any(|(asset, _)| asset.mime_type.starts_with("image/"))
        {
            let digest = component_digest(settings.connection.as_ref().unwrap())?;
            let latest = self
                .owner
                .store
                .component_diagnostics(actor.scope())?
                .into_iter()
                .find(|d| {
                    d.kind == ComponentModelTestKind::Images && d.connection_digest == digest
                });
            if latest.is_none_or(|d| d.state != ComponentModelTestState::Passed) {
                return Err(error(
                    "Image input is not verified for this model; run Test image input first",
                ));
            }
        }
        if serde_json::to_vec(&request).map_err(error)?.len() > 64 * 1024 {
            return Err(error("Assistant request exceeds 64 KiB"));
        }
        drop(_gate);
        let mut prepared = context::prepare(&host, &context, project, &request).await?;
        assets::include(&mut prepared, &request.conversation_id, captured_assets)?;
        if let Some(reference) = &request.continuation {
            let previous = self
                .reconcile(&host, &context, project, &request.window, &reference.run_id)
                .await?;
            if previous
                .recovery
                .as_ref()
                .is_none_or(|r| r.digest != reference.recovery_digest)
            {
                return Err(ApplicationError::Conflict);
            }
            self.validate_continued_targets(&host, &context, actor.scope(), &request, &previous)
                .await?;
            prepared.context.history = Some(self.continuation_history(actor.scope(), &previous)?);
        } else {
            let selected_bytes = serde_json::to_vec(&prepared.context).map_err(error)?.len();
            prepared.context.history = self.conversation_history(actor.scope(), &request.conversation_id,
                (64 * 1024usize).saturating_sub(selected_bytes + 256).min(24 * 1024))?;
        }
        if serde_json::to_vec(&prepared.context).map_err(error)?.len() > 64 * 1024 {
            return Err(error(
                "Conversation history and selected sources exceed 64 KiB; reduce the selected sources",
            ));
        }
        let _gate = self.gate.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Err(error("Component service is closing"));
        }
        if self
            .owner
            .store
            .component_run_by_request(actor.scope(), &request.request_id)?
            .is_none()
            && self.live.lock().await.len() + self.tests.lock().await.len()
                >= MAX_COMPONENT_QUEUED_RUNS
        {
            return Err(ApplicationError::Budget(
                "Model request queue is full".into(),
            ));
        }
        let key = self.key(actor.scope(), &settings.connection.as_ref().unwrap().credential)?;
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
                permission_changed: Arc::new(Notify::new()),
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
                    key,
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
        key: ComponentModelKey,
    ) -> ComponentEngineOutcome {
        let _permit = match model_slot(self.slots.clone(), &cancellation,
            run.created_at_ms.saturating_add(run.budget.duration_ms)).await {
            Ok(permit) => permit,
            Err(outcome) => return outcome,
        };
        let result: Result<ComponentEngineOutcome, ApplicationError> = async {
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
            let mut tools: Vec<_> = registered.values().map(|t| t.spec.clone()).collect();
            if run.request.grant.permission_policy.is_some() && run.task_intent.is_none() {
                tools.push(rho_agents::task_intent_spec(&run));
            }
            let permission_changed = self.live.lock().await.get(&run.run_id)
                .ok_or_else(|| error("The task is no longer live"))?.permission_changed.clone();
            let port = Arc::new(HostRunPort {
                model_closed: AtomicBool::new(false),
                permission_changed,
                host,
                owner: self.owner.clone(),
                scope,
                context: native,
                run: run.clone(),
                registered,
                cancellation: cancellation.clone(),
                native_tasks: TaskTracker::new(),
            });
            let result = self
                .engine
                .execute(ComponentEngineExecution {
                    context: serde_json::to_string(&run.context).map_err(error)?,
                    run,
                    images,
                    tools,
                    key,
                    port: port.clone(),
                    cancellation,
                })
                .await;
            // Model callbacks lose admission even if the final SQLite write
            // fails. Already accepted native tasks still record their facts.
            port.model_closed.store(true, Ordering::SeqCst);
            port.native_tasks.close();
            port.native_tasks.wait().await;
            Ok(result)
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
        !self.live.lock().await.is_empty() || !self.tests.lock().await.is_empty()
    }
    pub async fn close(&self) {
        {
            let _gate = self.gate.lock().await;
            self.closed.store(true, Ordering::SeqCst);
            for run in self.live.lock().await.values() {
                run.cancellation.cancel();
            }
            for cancel in self.tests.lock().await.values() {
                cancel.cancel();
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
    model_closed: AtomicBool,
    permission_changed: Arc<Notify>,
    host: Arc<NextHost>,
    owner: Arc<ComponentAgentOwner>,
    scope: ApplicationScope,
    context: CallContext,
    run: ComponentAgentRun,
    registered: BTreeMap<String, RegisteredTool>,
    cancellation: CancellationToken,
    native_tasks: TaskTracker,
}
#[async_trait]
impl ComponentRunPort for HostRunPort {
    async fn begin_model_call(&self) -> Result<u32, ApplicationError> {
        if self.model_closed.load(Ordering::SeqCst) || self.cancellation.is_cancelled() {
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
        if self.model_closed.load(Ordering::SeqCst) || self.cancellation.is_cancelled() {
            return Err(error("Component run stopped"));
        }
        if name == "rho_task_intent" && self.run.request.grant.permission_policy.is_some() {
            let mut arguments = arguments.as_object().cloned().ok_or_else(|| error("Task intent must be an object"))?;
            if arguments.contains_key("request_id") { return Err(error("The Agent cannot replace the original user request")); }
            arguments.insert("request_id".into(), json!(self.run.request.request_id));
            let intent = serde_json::from_value(Value::Object(arguments)).map_err(error)?;
            return self.owner.admit_tool(&self.scope, &self.run.run_id, model_call,
                call_id, ComponentToolAction::TaskIntent(intent), now());
        }
        let tool = self
            .registered
            .get(name)
            .ok_or_else(|| error("Tool is outside this component's scope"))?;
        let current = self
            .owner
            .store
            .component_run(&self.scope, &self.run.run_id)?
            .ok_or(ApplicationError::NotFound)?;
        let origin = ComponentToolOrigin {
            name: name.into(),
            arguments_digest: component_digest(&arguments)?,
        };
        let mut action = if let Some(feedback) = tool.invalid_arguments_feedback(&arguments) {
            ComponentToolAction::Rejected {
                capability: tool.descriptor.capability.clone(),
                arguments_digest: component_digest(&arguments)?,
                feedback,
            }
        } else if tool.is_document_navigation() {
            let snapshot = self.host.application_owner().map_err(|failure| native_error(&self.host, &self.context, failure))?.context(&self.context,
                ApplicationContextArguments {window:current.run.request.window.clone(),allow_offline:false,
                    after_document_id:None,limit:Some(1)}, now())?;
            tool.bind_navigation(&current.run, &arguments, snapshot.window.context_version)?
        } else if tool.is_valid_text_replace(&arguments) {
            let document = component_document_reference(
                &current.run,
                arguments["document_id"].as_str().unwrap(),
            )
            .ok_or_else(|| error("Document is outside this request"))?;
            let matched = self
                .host
                .application_owner()
                .map_err(|failure| native_error(&self.host, &self.context, failure))?
                .prepare_text_replacement(
                    &self.context,
                    &current.run.request.window,
                    document,
                    arguments["old_text"].as_str().unwrap(),
                    arguments["new_text"].as_str().unwrap(),
                    now(),
                )?;
            let mut history = self
                .owner
                .store
                .component_tools(&self.scope, &current.run.run_id)?
                .into_iter()
                .filter(|t| {
                    t.receipt.phase == ComponentToolPhase::Resolved
                        && t.receipt
                            .result
                            .as_ref()
                            .is_some_and(|r| r["state"] == "applied")
                })
                .collect::<Vec<_>>();
            for ancestor in self.owner.ancestor_runs(&self.scope, &current.run)? {
                history.extend(
                    self.owner
                        .store
                        .component_tools(&self.scope, &ancestor.run.run_id)?
                        .into_iter()
                        .filter(|t| {
                            ancestor.run.recovery.as_ref().is_some_and(|r| {
                                r.tools.iter().any(|entry| {
                                    entry.receipt_id == t.receipt.receipt_id
                                        && entry.state == ComponentRecoveryState::Confirmed
                                        && entry.application_state
                                            == Some(ApplicationCommandState::Applied)
                                })
                            })
                        }),
                );
            }
            let previous = history.iter().find_map(|prior| {
                if !prior
                    .calls
                    .iter()
                    .any(|call| call.origin.as_ref() == Some(&origin))
                {
                    return None;
                }
                match &prior.action {
                    ComponentToolAction::Control(command) => match &command.action {
                        ApplicationAction::EditDocument { edits, .. } => Some(edits.clone()),
                        _ => None,
                    },
                    _ => None,
                }
            });
            let edits = previous.or_else(|| match matched {
                ApplicationTextMatch::Unique(edit) => Some(vec![edit]),
                _ => None,
            });
            if let Some(edits) = edits {
                self.registered
                    .get("application_edit_document")
                    .ok_or_else(|| error("Native document editing is unavailable"))?
                    .bind(
                        &current.run,
                        json!({"document_id":document.document_id,"edits":edits}),
                    )?
            } else {
                ComponentToolAction::Rejected {
                    capability: tool.descriptor.capability.clone(),
                    arguments_digest: origin.arguments_digest.clone(),
                    feedback: json!({"status":"rejected","accepted":false,"tool":tool.spec.name,"parameters":tool.spec.parameters,
                        "error":"The old text has no unique exact match. No edit was applied; read current text and include enough surrounding context."}),
                }
            }
        } else {
            tool.bind(&current.run, arguments)?
        };
        if let ComponentToolAction::Invoke(invocation) = &mut action
            && invocation.capability.id == "workspace.resume_queue"
        {
            let tools = self
                .owner
                .store
                .component_tools(&self.scope, &self.run.run_id)?;
            let mut known = tools.clone();
            for ancestor in self.owner.ancestor_runs(&self.scope, &current.run)? {
                let recovered = ancestor.run.recovery.as_ref();
                known.extend(self.owner.store.component_tools(&self.scope,&ancestor.run.run_id)?.into_iter().filter(|tool|
                    matches!(&tool.action,ComponentToolAction::Invoke(i) if i.capability.id=="workspace.resume_queue")
                    && recovered.is_some_and(|r|r.tools.iter().any(|entry|entry.receipt_id==tool.receipt.receipt_id && entry.state==ComponentRecoveryState::Confirmed))));
            }
            let previous = known.iter().find_map(|t| match &t.action {
                ComponentToolAction::Invoke(old)
                    if old.capability.id == "workspace.resume_queue"
                        && old.arguments["pause_id"] == invocation.arguments["pause_id"] =>
                {
                    Some(old)
                }
                _ => None,
            });
            if let Some(previous) = previous {
                invocation.arguments = previous.arguments.clone();
            } else {
                let owned = self
                    .owner
                    .owned_operations(&self.scope, &current.run, &tools)?;
                let session = current
                    .run
                    .request
                    .grant
                    .session
                    .as_ref()
                    .ok_or_else(|| error("R session is absent"))?;
                let state=self.host.query_snapshot(&self.context,QueryRequest{capability:CapabilityRef::new("workspace.console_state",1).map_err(error)?,
                arguments:json!({"workspace_instance_id":session.workspace_instance_id})}).await.map_err(|failure| native_error(&self.host, &self.context, failure))?;
                let state: ConsoleState = serde_json::from_value(
                    state
                        .data
                        .ok_or_else(|| error("Console state is unavailable"))?,
                )
                .map_err(error)?;
                if state.session_id != session.session_id {
                    return Err(error("The native R session changed"));
                }
                let pause = state
                    .pause
                    .ok_or_else(|| error("There is no observed R queue pause"))?;
                let id = pause
                    .operation_id
                    .ok_or_else(|| error("The queue was paused outside this assistant run"))?;
                if invocation.arguments["pause_id"].as_str() != Some(&pause.id)
                    || !owned.contains(&id)
                {
                    return Err(error("The queue pause is outside this assistant run"));
                }
                let original = self
                    .host
                    .get_operation(&self.context, &id)
                    .await
                    .map_err(|failure| native_error(&self.host, &self.context, failure))?
                    .ok_or_else(|| error("Original failed operation is unavailable"))?;
                let ancestors = self.owner.ancestor_runs(&self.scope, &current.run)?;
                let own_caller = original.operation.caller == self.context.caller
                    || ancestors.iter().any(|r| {
                        original.operation.caller.kind == CallerKind::Agent
                            && original.operation.caller.id == format!("component:{}", r.run.run_id)
                    });
                if original.status != OperationStatus::Failed
                    || !own_caller
                    || original.operation.capability.id != "workspace.run_r"
                {
                    return Err(error(
                        "Verify the original failure before resuming its queue",
                    ));
                }
                invocation.arguments["only_operation_ids"] =
                    serde_json::to_value(owned).map_err(error)?;
            }
        }
        let starts_r = match &action {
            ComponentToolAction::Invoke(invocation) => invocation.capability.id == "workspace.run_r",
            ComponentToolAction::Control(command) => matches!(command.action,
                ApplicationAction::RunFile { .. } | ApplicationAction::RunSelection { .. }),
            _ => false,
        };
        let rejection = if starts_r {
            let session = current.run.request.grant.session.as_ref()
                .ok_or_else(|| error("R session is absent"))?;
            let observed = self.host.query_snapshot(&self.context, QueryRequest {
                capability: CapabilityRef::new("workspace.console_state", 1).map_err(error)?,
                arguments: json!({"workspace_instance_id":session.workspace_instance_id}),
            }).await;
            let state = observed.ok().and_then(|snapshot| snapshot.data)
                .and_then(|data| serde_json::from_value::<ConsoleState>(data).ok());
            match state {
                Some(state) if state.session_id == session.session_id =>
                    state.pause.is_some().then_some("The R queue is paused. No new execution was submitted. Read workspace_console_state and explicitly use workspace_resume_queue only for this run's verified failure. A pause owned by the user or another operation requires user action."),
                _ => Some("The original R session's queue could not be verified. No new execution was submitted. Inspect the original session; do not switch targets or repeat uncertain work."),
            }
        } else { None };
        let rejection = rejection.or_else(|| (action.requires_permission()
            && current.run.request.grant.permission_policy.is_some() && current.run.task_intent.is_none())
            .then_some("Use rho_task_intent to record the user's request and its intended actions before changing anything."));
        let admission = self.owner.admit_tool_call_with_precondition(
            &self.scope,
            &self.run.run_id,
            ComponentToolCall {
                model_call,
                tool_call_id: call_id.into(),
                origin: Some(origin),
            },
            action,
            rejection,
            now(),
        )?;
        if current.run.request.grant.permission_policy.is_some() && admission.tool.action.requires_permission()
            && admission.tool.receipt.phase == ComponentToolPhase::Intent {
            let (basis, allowed) = rho_agents::action_permission(&current.run, &admission.tool.action);
            let permission = self.owner.record_permission(&self.scope, &self.run.run_id,
                &admission.tool.receipt.receipt_id, name, basis, allowed, now())?;
            if permission.state == ComponentPermissionState::Pending {
                loop {
                    let saved = self.owner.store.component_run(&self.scope, &self.run.run_id)?.ok_or(ApplicationError::NotFound)?;
                    if saved.run.permissions.iter().any(|p| p.decision_id == permission.decision_id && p.state != ComponentPermissionState::Pending) { break; }
                    let remaining = saved.run.created_at_ms.saturating_add(saved.run.budget.duration_ms).saturating_sub(now());
                    tokio::select! {
                        biased;
                        _ = self.cancellation.cancelled() => return Err(error("Component run stopped")),
                        _ = tokio::time::sleep(std::time::Duration::from_millis(remaining)) => return Err(ApplicationError::Budget("Component run deadline exceeded".into())),
                        _ = self.permission_changed.notified() => {},
                    }
                }
            }
        }
        Ok(admission)
    }
    async fn execute_tool(
        &self,
        admission: ComponentToolAdmission,
    ) -> Result<Value, ApplicationError> {
        if self.model_closed.load(Ordering::SeqCst) { return Err(error("The model task has finished")); }
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
        if tool.receipt.phase == ComponentToolPhase::Resolved {
            return tool.receipt.result.ok_or_else(|| error("Resolved tool result is unavailable"));
        }
        if let ComponentToolAction::TaskIntent(intent) = &tool.action {
            self.owner.capture_task_intent(&self.scope, &self.run.run_id, intent, now())?;
            let result = json!({"status":"recorded","request_id":intent.request_id,"actions":intent.actions});
            self.owner.record_tool(&self.scope, &self.run.run_id, &tool.receipt.receipt_id,
                ComponentToolUpdate::Resolved { result: result.clone(), evidence: vec![] }, now())?;
            return Ok(result);
        }
        if let ComponentToolAction::PreviousResult {
            run_id, receipt_id, ..
        } = &tool.action
        {
            if admission.repeated {
                return tool
                    .receipt
                    .result
                    .ok_or_else(|| error("Previous result observation is incomplete"));
            }
            self.owner.check_tool_dispatch(
                &self.scope,
                &self.run.run_id,
                &tool.receipt.receipt_id,
                now(),
            )?;
            let (source, original) =
                self.owner
                    .previous_tool(&self.scope, &self.run, run_id, receipt_id)?;
            let value = continuation::previous_result(
                &self.host,
                &self.context,
                &self.scope.project,
                &source.run,
                &original,
            )
            .await?;
            self.owner.record_tool(
                &self.scope,
                &self.run.run_id,
                &tool.receipt.receipt_id,
                ComponentToolUpdate::Resolved {
                    result: value.clone(),
                    evidence: original.receipt.evidence.clone(),
                },
                now(),
            )?;
            return Ok(value);
        }
        if matches!(tool.action, ComponentToolAction::Rejected { .. }) {
            return tool
                .receipt
                .result
                .ok_or_else(|| error("Rejected argument feedback is unavailable"));
        }
        if matches!(
            tool.action,
            ComponentToolAction::Invoke(_) | ComponentToolAction::Control(_)
        ) {
            return mutations::execute(self, &tool, admission.repeated).await;
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
                    .map_err(|failure| native_error(&self.host, &self.context, failure))?,
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
                let diagnostic = self.host.runtime.gateway.diagnostic(&self.context, &error);
                json!({"status":"error","error":error.to_string(),"diagnostic":diagnostic,"capability":query.capability})
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
    async fn record_diagnostic(&self, diagnostic: Diagnostic) -> Result<(), ApplicationError> {
        if self.model_closed.load(Ordering::SeqCst) { return Err(error("The model task has finished")); }
        self.owner.record_diagnostic(&self.scope, &self.run.run_id, diagnostic, now())
    }
    async fn append_text(&self, text: String) -> Result<(), ApplicationError> {
        if self.model_closed.load(Ordering::SeqCst) || self.cancellation.is_cancelled() {
            return Err(error("The model task has finished or stopped"));
        }
        self.owner
            .append_text(&self.scope, &self.run.run_id, text, now())
    }
    async fn record_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Result<(), ApplicationError> {
        if self.model_closed.load(Ordering::SeqCst) { return Err(error("The model task has finished")); }
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

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[tokio::test]
    async fn independent_settings_owners_preserve_each_others_immutable_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("study");
        std::fs::create_dir(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let root = project.to_str().unwrap();
        let host = NextHost::open_project(directory.path().join("journal.sqlite"), &project).await.unwrap();
        let store = Arc::new(ApplicationStore::open(&directory.path().join("custom-state.sqlite")).unwrap());
        let config_path = directory.path().join("user-config/model-credentials.json");
        let mut service = ComponentAgentService::new(store.clone());
        Arc::get_mut(&mut service).unwrap().credential_file = credentials::CredentialFile::at(config_path.clone());
        let mut context = NextHost::local_context(); context.connection_id = "studio:credential-test".into();
        let registration = host.dispatch(&context, HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
            window_id: "credential-window".into(), incarnation: "credential-life".into(), label: "Credential test".into(), previous_session: None,
        })).await.unwrap();
        let ApplicationBridgeReply::Registered(registration) = serde_json::from_value(registration).unwrap() else { panic!() };
        let window = registration.session.window;
        let original = service.put_local_key(&host, &context, root, &window, "original-key".into()).unwrap();
        let settings = service.configure(&host, &context, root, &window, &ComponentModelSettings {
            version: 0, enabled: true, connection: Some(ComponentModelConnection { protocol: ComponentModelProtocol::Anthropic,
                base_url: "https://example.test".into(), model: "fixture".into(), credential: original.clone() }),
        }).await.unwrap();
        service.close().await; drop(service);
        let mut reopened = ComponentAgentService::new(store);
        Arc::get_mut(&mut reopened).unwrap().credential_file = credentials::CredentialFile::at(config_path.clone());
        assert!(reopened.credential_status(&host, &context, root).unwrap().available);
        let scope = ComponentAgentService::scope(&host, &context, root).unwrap();
        let frozen = reopened.key(&scope, &original).unwrap();
        let attempted = reopened.put_local_key(&host, &context, root, &window, "other-owner-key".into()).unwrap();
        let mut other = ComponentAgentService::new(Arc::new(ApplicationStore::open(&directory.path().join("other-state.sqlite")).unwrap()));
        Arc::get_mut(&mut other).unwrap().credential_file = credentials::CredentialFile::at(config_path);
        let mut other_settings = settings.clone(); other_settings.version=0;
        other_settings.connection.as_mut().unwrap().credential=attempted.clone();
        other.configure(&host,&context,root,&window,&other_settings).await.unwrap();
        let mut stale = settings.clone(); stale.version = 0; stale.connection.as_mut().unwrap().credential = attempted.clone();
        assert!(matches!(reopened.configure(&host, &context, root, &window, &stale).await, Err(ApplicationError::Conflict)));
        assert_eq!(reopened.settings(&host, &context, root).unwrap(), settings);
        assert!(other.credential_status(&host,&context,root).unwrap().available);
        assert_eq!(reopened.key(&scope, &attempted).unwrap().expose(), "other-owner-key");
        assert_eq!(reopened.key(&scope, &original).unwrap().expose(), "original-key");
        let replacement = reopened.put_local_key(&host, &context, root, &window, "replacement-key".into()).unwrap();
        let mut next = settings; next.connection.as_mut().unwrap().credential = replacement.clone();
        let current = reopened.configure(&host, &context, root, &window, &next).await.unwrap();
        assert_eq!(reopened.key(&scope, &original).unwrap().expose(), "original-key");
        assert!(other.credential_status(&host,&context,root).unwrap().available);
        assert_eq!(frozen.expose(), "original-key");
        let ComponentCredentialRef::LocalFile { key_id } = replacement else { panic!() };
        assert!(!reopened.remove_credential(&host, &context, root, &window, current.version, &key_id).await.unwrap().available);
        assert!(!reopened.credential_status(&host, &context, root).unwrap().available);
        assert!(other.credential_status(&host,&context,root).unwrap().available);
        assert_eq!(other.key(&scope,&attempted).unwrap().expose(),"other-owner-key");
        other.close().await;
        reopened.close().await;
    }
    #[tokio::test]
    async fn native_diagnostics_keep_typed_recovery_and_filter_identity_reads_by_scope() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("study");
        std::fs::create_dir(&project).unwrap();
        let host = NextHost::open_project(directory.path().join("journal.sqlite"), &project).await.unwrap();
        let allowed = NextHost::local_context();
        let failure = rho_operation::OperationError::CommitPending {
            operation_id: OperationId::new("original-operation").unwrap(), detail: "Awaiting commit".into(),
        };
        let visible = native_error(&host, &allowed, failure.clone()).diagnostic();
        assert_eq!(visible.code, DiagnosticCode::OutcomeUncertain);
        assert_eq!(visible.continuation, DiagnosticContinuation::InspectOriginal);
        assert_eq!(visible.next_reads.iter().map(|read|read.capability.id.as_str()).collect::<Vec<_>>(),
            vec!["operation.get","operation.commit_status"]);
        assert!(visible.next_reads.iter().all(|read|read.arguments["operation_id"] == "original-operation"));
        // Other granted scopes, including plugin lifecycle authority, cannot
        // reveal the original identity reads without operation.read.
        let mut denied = allowed; denied.scopes.remove("operation.read");
        let hidden = native_error(&host, &denied, failure).diagnostic();
        assert_eq!(hidden.code, DiagnosticCode::OutcomeUncertain);
        assert!(hidden.next_reads.is_empty());
    }
}
