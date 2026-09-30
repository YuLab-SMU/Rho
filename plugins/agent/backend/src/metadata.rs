use crate::arguments::*;
use rho_agent_api::{AgentControllerRef, component::ComponentAgentConversation};
use rho_agent_owner::component::{
    ComponentActor, ComponentActorValidator, ComponentAgentOwner, ComponentTaskError,
};
use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
use rho_agent_store::{AgentStore, CredentialFile};
use rho_plugin_sdk::protocol::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct Metadata {
    pub owner: ComponentAgentOwner,
    pub(crate) native: crate::native_tasks::NativeTasks,
    pub(crate) handoffs: rho_agent_owner::handoff::AgentHandoffOwner,
    store: Arc<AgentStore>,
    pub(crate) credentials: CredentialFile,
    settings_gate: Mutex<()>,
    diagnostics: crate::diagnostics::Diagnostics,
    runs: crate::runs::Runs,
    model_assets: crate::model_assets::ModelAssets,
    pub(crate) instance: PluginInstance,
    pub(crate) scope: AgentTaskScope,
    pub(crate) grants: Vec<CapabilityRequirement>,
    native_options: rho_agent_client::NativeAgentOptions,
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
impl Failure {
    pub fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_input",
            message: message.into(),
        }
    }
    pub fn body(self) -> RpcBody {
        RpcBody::Error {
            code: self.code.into(),
            message: self.message,
            recovery: None,
        }
    }
}
impl From<ComponentTaskError> for Failure {
    fn from(error: ComponentTaskError) -> Self {
        let code = match &error {
            ComponentTaskError::Storage(_) => "agent_storage_unavailable",
            ComponentTaskError::NotFound => "not_found",
            ComponentTaskError::Conflict | ComponentTaskError::IncarnationChanged => "conflict",
            ComponentTaskError::RequestConflict => "request_conflict",
            ComponentTaskError::Offline => "unavailable",
            ComponentTaskError::Budget(_) => "budget_exceeded",
            ComponentTaskError::AccessDenied { .. } | ComponentTaskError::InvalidBridge => {
                "access_denied"
            }
            _ => "invalid_input",
        };
        let message = if matches!(error, ComponentTaskError::Storage(_)) {
            "Agent metadata storage is unavailable; retain the original request".into()
        } else {
            error.to_string()
        };
        Self { code, message }
    }
}
pub fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, Failure> {
    serde_json::from_value(value.clone())
        .map_err(|_| Failure::invalid("Arguments do not match the declared Agent contract"))
}
pub(crate) fn encoded(value: impl serde::Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(|_| Failure::invalid("Agent metadata could not be encoded"))
}

// The native query was made for this active, already-admitted parent. This actor
// is constructed and consumed synchronously, with no intervening await or reuse.
// It does not retain the observation as authority for later calls/model actions.
struct CurrentAdmission {
    observed_at: u64,
    unused: AtomicBool,
}
impl ComponentActorValidator for CurrentAdmission {
    fn validate(&self, now: u64) -> Result<(), ComponentTaskError> {
        if now != self.observed_at || !self.unused.swap(false, Ordering::SeqCst) {
            return Err(ComponentTaskError::Offline);
        }
        Ok(())
    }
}

impl Metadata {
    /// Only explicit new model work reads the captured key; observations and
    /// repeated original requests never call this method.
    pub(crate) fn model_key(
        &self,
        reference: &rho_agent_api::ComponentCredentialRef,
    ) -> Result<rho_agent_owner::ComponentModelKey, Failure> {
        use rho_agent_api::ComponentCredentialRef;
        match reference {
            ComponentCredentialRef::LocalFile { key_id } => self
                .credentials
                .key(&self.scope, key_id)
                .map_err(ComponentTaskError::from)
                .map_err(Into::into),
            ComponentCredentialRef::Environment { name } => {
                rho_agent_owner::ComponentModelKey::new(std::env::var(name).map_err(|_| {
                    Failure::invalid("The configured model credential is unavailable")
                })?)
                .map_err(ComponentTaskError::from)
                .map_err(Into::into)
            }
            ComponentCredentialRef::Session { .. } => Err(Failure::invalid(
                "The configured model credential is unavailable",
            )),
        }
    }
    pub fn new(
        instance: PluginInstance,
        environment: BackendEnvironment,
        grants: Vec<CapabilityRequirement>,
        factory: Arc<dyn rho_agent_client::NativeAgentFactory>,
    ) -> Result<Self, String> {
        let native_options = decode::<AgentConfiguration>(&instance.configuration)
            .map_err(|e| e.message)?
            .native_options()?;
        for directory in [&environment.project_root, &environment.data_root] {
            let path = Path::new(directory);
            if !path.is_absolute()
                || !path.is_dir()
                || path
                    .canonicalize()
                    .map_err(|_| "Agent directories are unavailable")?
                    != path
            {
                return Err("Agent requires the existing normalized native project and instance directories".into());
            }
        }
        let store = Arc::new(
            AgentStore::open(&Path::new(&environment.data_root).join("agent-v1.sqlite"))
                .map_err(|_| "Agent instance storage is unavailable")?,
        );
        let scope = AgentTaskScope {
            project: environment.project_root,
            principal: instance.principal.to_string(),
        };
        let owner = ComponentAgentOwner::new(store.clone(), uuid::Uuid::new_v4().to_string());
        let native = crate::native_tasks::NativeTasks::new(
            Arc::new(rho_agent_owner::AgentTaskOwner::new(store.clone())),
            factory,
        );
        Ok(Self {
            native_options,
            owner,
            native,
            handoffs: rho_agent_owner::handoff::AgentHandoffOwner::new(store.clone()),
            store,
            diagnostics: Default::default(),
            runs: Default::default(),
            model_assets: Default::default(),
            credentials: CredentialFile::at(
                Path::new(&environment.data_root).join("model-credentials-v1.json"),
            ),
            settings_gate: Mutex::new(()),
            instance,
            scope,
            grants,
        })
    }
    pub fn validate(
        &self,
        request: &RequestId,
        call: &PluginCall,
        kind: CapabilityKind,
    ) -> Result<(), Failure> {
        let operation = kind == CapabilityKind::Operation;
        let writes = kind != CapabilityKind::Query;
        if &call.request != request
            || call.binding.provider != self.instance.identity
            || call.binding.project != self.instance.project
            || call.principal != self.instance.principal
            || operation != call.operation_id.is_some()
            || call.binding.capability.version != 1
            || call.binding.target.is_some()
            || !(call.preconditions.is_null() || call.preconditions == json!([]))
            || !call.owner_context.is_null()
        {
            return Err(Failure::invalid(
                "Agent call differs from its admitted identity or native preconditions",
            ));
        }
        let scope = if writes {
            "application.control"
        } else {
            "application.read"
        };
        if !call.scopes.contains(scope) || (writes && !call.scopes.contains("plugins.read")) {
            return Err(Failure {
                code: "access_denied",
                message: "Original Agent call lacks its declared scope".into(),
            });
        }
        if kind != crate::manifest::kind(call.binding.capability.id.as_str()) {
            return Err(Failure::invalid(
                "Agent capability does not match the requested call kind",
            ));
        }
        Ok(())
    }
    pub async fn query(
        &self,
        call: &PluginCall,
        host: rho_plugin_sdk::HostCallClient,
    ) -> Result<Value, Failure> {
        if call
            .binding
            .capability
            .id
            .as_str()
            .starts_with("agent.native.")
        {
            return self.native.query(self, call, host).await;
        }
        if call.binding.capability.id.as_str() == "agent.model.tool.operation" {
            return crate::tools::inspect_original(self, call, host).await;
        }
        if call.binding.capability.id.as_str() == "agent.handoff.target" {
            return crate::handoffs::target(self, call, host).await;
        }
        if call.binding.capability.id.as_str().starts_with("agent.context.") { return crate::contexts::query(self, call); }
        self.read(call)
    }
    pub fn read(&self, call: &PluginCall) -> Result<Value, Failure> {
        match call.binding.capability.id.as_str() {
            "agent.handoff.source" | "agent.handoff.receipt" => crate::handoffs::read(self, call),
            "agent.model.run.get"
            | "agent.model.history"
            | "agent.model.run.request"
            | "agent.model.run.events"
            | "agent.model.run.admission"
            | "agent.model.run.tools" => self.runs.read(self, call),
            "agent.model.diagnostic" => self.diagnostics.read(self, &call.arguments),
            "agent.model.key.receipt" => {
                let args: CredentialRequest = decode(&call.arguments)?;
                let status = self
                    .credentials
                    .reference_for_request(&self.scope, &args.request_id)
                    .map_err(ComponentTaskError::from)?
                    .unwrap_or(rho_agent_api::ComponentCredentialStatus {
                        credential: None,
                        available: false,
                    });
                encoded(status)
            }
            "agent.model.key.status" => {
                let args: CredentialStatus = decode(&call.arguments)?;
                let _gate = self
                    .settings_gate
                    .lock()
                    .map_err(|_| Failure::invalid("Model settings are unavailable"))?;
                let settings = self.owner.store.component_settings(&self.scope)?;
                if settings.version != args.settings_version {
                    return Err(ComponentTaskError::Conflict.into());
                }
                let credential = settings.connection.map(|connection| connection.credential);
                let available = match &credential {
                    Some(rho_agent_api::ComponentCredentialRef::LocalFile { key_id }) => self
                        .credentials
                        .available(&self.scope, key_id)
                        .map_err(ComponentTaskError::from)?,
                    Some(rho_agent_api::ComponentCredentialRef::Environment { name }) => {
                        std::env::var(name).ok().is_some_and(|value| {
                            rho_agent_owner::ComponentModelKey::new(value).is_ok()
                        })
                    }
                    _ => false,
                };
                encoded(rho_agent_api::ComponentCredentialStatus {
                    credential,
                    available,
                })
            }
            "agent.tasks" => {
                let args: TaskList = decode(&call.arguments)?;
                if !(1..=20).contains(&args.limit)
                    || args.before.as_ref().is_some_and(|v| v.len() > 512)
                {
                    return Err(Failure::invalid("Agent task page bounds are invalid"));
                }
                let live = self.runs.live_ids()?;
                encoded(
                    self.store
                        .project_agent_tasks(
                            &self.scope,
                            args.archived,
                            args.before.as_deref(),
                            args.limit as usize,
                            &self.native.owner.host_incarnation,
                            &self.owner.host_incarnation,
                            &live,
                        )
                        .map_err(ComponentTaskError::from)?,
                )
            }
            "agent.model.conversation" => {
                let args: Conversation = decode(&call.arguments)?;
                encoded(self.conversation(&args.conversation_id)?)
            }
            "agent.model.assets" => crate::model_assets::list(self, call),
            "agent.model.settings" => {
                let _: Empty = decode(&call.arguments)?;
                encoded(self.owner.store.component_settings(&self.scope)?)
            }
            _ => Err(Failure::invalid("Agent query is not implemented")),
        }
    }
    /// Invoked only after this Control's original native caller query succeeds.
    /// Caller observations are consumed here, never retained for future writes.
    pub async fn control(
        &self,
        call: &PluginCall,
        caller: PluginViewCaller,
        host: rho_plugin_sdk::HostCallClient,
    ) -> Result<Value, Failure> {
        if call.binding.capability.id.as_str() == "agent.model.assets.stage" {
            return self.model_assets.stage(self, call, caller);
        }
        if call.binding.capability.id.as_str() == "agent.model.assets.finish" {
            return self.model_assets.finish(self, call, caller);
        }
        if call.binding.capability.id.as_str() == "agent.native.assets.stage" {
            return self.native.stage_upload(self, call, caller);
        }
        if call.binding.capability.id.as_str() == "agent.native.assets.finish" {
            return self.native.finish_staged_upload(self, call, caller).await;
        }
        if call.binding.capability.id.as_str() == "agent.native.assets.import" {
            return self.native.import_asset(self, call, caller, host).await;
        }
        if call.binding.capability.id.as_str() == "agent.native.assets.upload" {
            return self.native.upload(self, call, caller).await;
        }
        if call.binding.capability.id.as_str() == "agent.model.key.remove" {
            drop(caller);
            let args: RemoveCredential = decode(&call.arguments)?;
            let _gate = self
                .settings_gate
                .lock()
                .map_err(|_| Failure::invalid("Model settings are unavailable"))?;
            let settings = self.owner.store.component_settings(&self.scope)?;
            let credential = settings.connection.map(|connection| connection.credential);
            if settings.version != args.settings_version
                || !matches!(&credential,
                Some(rho_agent_api::ComponentCredentialRef::LocalFile { key_id }) if key_id == &args.key_id)
            {
                return Err(ComponentTaskError::Conflict.into());
            }
            self.credentials
                .remove(&self.scope, &args.key_id)
                .map_err(ComponentTaskError::from)?;
            return encoded(rho_agent_api::ComponentCredentialStatus {
                credential,
                available: false,
            });
        }
        if call.binding.capability.id.as_str() != "agent.model.key.store" {
            return Err(Failure::invalid("Agent control is not implemented"));
        }
        drop(caller);
        let args: StoreCredential = decode(&call.arguments)?;
        encoded(
            self.credentials
                .put_for_request(&self.scope, &args.request_id, args.value)
                .map_err(ComponentTaskError::from)?,
        )
    }
    fn conversation(&self, id: &str) -> Result<ComponentAgentConversation, Failure> {
        if id.is_empty() || id.len() > 160 {
            return Err(Failure::invalid("Invalid conversation identity"));
        }
        Ok(self
            .owner
            .store
            .component_conversation(&self.scope, id)?
            .ok_or(ComponentTaskError::NotFound)?)
    }
    pub(crate) fn actor(&self, caller: PluginViewCaller, observed_at: u64) -> ComponentActor {
        let controller = match caller.view {
            Some(origin) => AgentControllerRef {
                window_id: origin.window.to_string(),
                // The fresh caller observation validates the connection. A
                // private connection rotation must not change persisted task
                // identity or the digest of an original Send.
                incarnation: format!("view:{}", origin.view),
            },
            // A direct native caller has its own controller namespace. It cannot
            // masquerade as a view or implicitly take over another controller.
            None => AgentControllerRef {
                window_id: format!("agent:{}", self.instance.identity.instance),
                incarnation: format!("instance:{}", self.instance.identity.instance),
            },
        };
        ComponentActor::new(
            self.scope.clone(),
            controller,
            Arc::new(CurrentAdmission {
                observed_at,
                unused: AtomicBool::new(true),
            }),
        )
    }
    pub async fn dispatch(
        self: &Arc<Self>,
        call: &PluginCall,
        caller: PluginViewCaller,
        host: rho_plugin_sdk::HostCallClient,
    ) -> Result<Value, Failure> {
        match call.binding.capability.id.as_str() {
            "agent.native.discover" => {
                let args: crate::native_arguments::DiscoverNative = decode(&call.arguments)?;
                // This is an admitted Operation, not a task-list query. The
                // existing adapter bounds discovery and closes its probe CLI.
                encoded(
                    rho_agent_client::discover_agent_with_options(
                        args.provider,
                        Path::new(&self.scope.project),
                        args.model.as_deref(),
                        &self.native_options,
                    )
                    .await,
                )
            }
            "agent.native.command" => self.native.command(self, call, caller, host).await,
            "agent.handoff.append" => crate::handoffs::append(self, call, caller, host).await,
            "agent.model.run" => self.runs.start(self, call, caller, host).await,
            "agent.model.run.stop" => self.runs.stop(self, call, caller),
            "agent.model.run.reconcile" => {
                crate::run_recovery::reconcile(self, &self.runs, call, caller, host).await
            }
            "agent.model.test" => self.diagnostics.start(self, call, caller).await,
            "agent.model.test.stop" => self.diagnostics.stop(self, call, caller),
            _ => self.mutate(call, caller),
        }
    }
    pub async fn close(&self) -> Result<(), Failure> {
        self.diagnostics.cancel_all();
        self.runs.cancel_all();
        self.native.close(&self.scope).await
    }
    pub fn mutate(&self, call: &PluginCall, caller: PluginViewCaller) -> Result<Value, Failure> {
        let now = now();
        let actor = self.actor(caller, now);
        match call.binding.capability.id.as_str() {
            "agent.model.configure" => {
                let _gate = self
                    .settings_gate
                    .lock()
                    .map_err(|_| Failure::invalid("Model settings are unavailable"))?;
                let settings: rho_agent_api::ComponentModelSettings = decode(&call.arguments)?;
                let updated = self.owner.configure(&actor, &settings, now)?;
                if !updated.enabled {
                    self.diagnostics.cancel_all();
                    self.runs.cancel_all();
                }
                encoded(updated)
            }
            "agent.model.create" => {
                let args: CreateConversation = decode(&call.arguments)?;
                encoded(
                    self.owner
                        .create(&actor, &args.conversation_id, args.profile, now)?,
                )
            }
            "agent.model.draft" => {
                let args: SaveDraft = decode(&call.arguments)?;
                self.owner.save_draft_content(
                    &actor,
                    &args.conversation_id,
                    args.draft_version,
                    args.content,
                    args.grant,
                    now,
                )?;
                encoded(self.conversation(&args.conversation_id)?)
            }
            "agent.model.update" => {
                let args: UpdateConversation = decode(&call.arguments)?;
                if args.title.is_none() && args.archived.is_none() {
                    return Err(Failure::invalid("Select a task metadata change"));
                }
                self.owner.update_task_metadata(
                    &actor,
                    &args.conversation_id,
                    args.expected_version,
                    args.title,
                    args.archived,
                    now,
                )?;
                encoded(self.conversation(&args.conversation_id)?)
            }
            "agent.model.take_control" => {
                let args: TakeControl = decode(&call.arguments)?;
                let active = self.conversation(&args.conversation_id)?.active_run_id;
                let updated = self.owner.take_control(
                    &actor,
                    &args.conversation_id,
                    args.expected_version,
                    now,
                )?;
                if let Some(run) = active {
                    self.runs.cancel(&run);
                }
                encoded(updated)
            }
            _ => Err(Failure::invalid("Agent mutation is not implemented")),
        }
    }
}
