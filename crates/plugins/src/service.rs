//! Host composition for the same unprivileged package repository and backend runtime.
//! No scientific owner, browser credential, model client or native-session shortcut.
use crate::*;
use async_trait::async_trait;
use rho_contract as host;
use rho_operation::{
    CapabilityRegistry, OperationError, OperationGateway, OperationJournal, QueryGateway,
};
use rho_plugin_protocol::*;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

pub const RESOURCES_READ_SCOPE: &str = "resources.read";

pub const PLUGINS_READ_SCOPE: &str = "plugins.read";
pub const PLUGINS_WRITE_SCOPE: &str = "plugins.write";
pub const PLUGINS_RUN_SCOPE: &str = "plugins.run";

/// A configured journal's sibling repository. Explicit CLI --store addresses the
/// same format; there is no special default-package installation or second catalog.
pub fn repository_path(database: &Path) -> PathBuf {
    database
        .parent()
        .unwrap_or(Path::new("."))
        .join("plugins-v1")
}
pub fn backend_target() -> String {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin".into()
    } else {
        format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS)
    }
}

pub struct PluginService {
    pub(crate) repository: Arc<Mutex<PluginRepository>>,
    pub(crate) runtime: Arc<PluginRuntime>,
    pub(crate) resources: Arc<PluginResources>,
    pub(crate) views: Mutex<BTreeMap<ViewInstanceId, crate::views::LiveView>>,
    pub(crate) view_sequences: tokio::sync::watch::Sender<u64>,
    pub(crate) bridge: PluginCapabilityBridge,
    pub(crate) scope: String,
    pub(crate) project: ProjectId,
    pub(crate) registry: OnceLock<Weak<CapabilityRegistry>>,
    pub(crate) journal: Arc<dyn OperationJournal>,
    pub(crate) gate: tokio::sync::Mutex<()>,
    pub(crate) services: Arc<Services>,
    published: Mutex<Vec<CapabilityContribution>>,
    stopped: tokio_util::sync::CancellationToken,
}
impl PluginService {
    pub fn open(
        store: &Path,
        project: String,
        journal: Arc<dyn OperationJournal>,
    ) -> Result<Arc<Self>, OperationError> {
        let repository = Arc::new(Mutex::new(PluginRepository::open(store).map_err(error)?));
        let resources = Arc::new(PluginResources::open(store).map_err(error)?);
        let services = Arc::new(Services {
            resources: resources.clone(),
            project: plugin_project_id(&project),
            scope: project.clone(),
            registry: OnceLock::new(),
            gateway: OnceLock::new(),
            lifetime: OnceLock::new(),
            tasks: OnceLock::new(),
            principals: Mutex::new(BTreeMap::new()),
        });
        let runtime = Arc::new(PluginRuntime::new(
            repository.clone(),
            services.clone(),
            BackendPolicy::default(),
        ));
        let bridge = PluginCapabilityBridge::new(
            runtime.clone(),
            project.clone(),
            resources.clone(),
        );
        Ok(Arc::new(Self {
            repository,
            resources,
            views: Mutex::new(BTreeMap::new()),
            view_sequences: tokio::sync::watch::channel(0).0,
            runtime,
            bridge,
            scope: project.clone(),
            project: plugin_project_id(&project),
            registry: OnceLock::new(),
            journal,
            gate: tokio::sync::Mutex::new(()),
            services,
            published: Mutex::new(vec![]),
            stopped: tokio_util::sync::CancellationToken::new(),
        }))
    }
    pub fn register(
        self: &Arc<Self>,
        registry: &mut CapabilityRegistry,
    ) -> Result<(), OperationError> {
        crate::service_handlers::register(self, registry)
    }
    pub fn bind(
        self: &Arc<Self>,
        registry: &Arc<CapabilityRegistry>,
        gateway: &Arc<OperationGateway>,
    ) {
        self.registry
            .set(Arc::downgrade(registry))
            .expect("plugin service binds once");
        self.services
            .registry
            .set(Arc::downgrade(registry))
            .expect("services bind once");
        self.services
            .gateway
            .set(Arc::downgrade(gateway))
            .expect("services bind once");
        let mut lifecycle = self.runtime.subscribe_lifecycle();
        let weak = Arc::downgrade(self);
        let stopped = self.stopped.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _=stopped.cancelled()=>break,
                    changed=lifecycle.changed()=>{
                        if changed.is_err() { break; }
                        let Some(service)=weak.upgrade() else { break };
                        let _guard=service.gate.lock().await;
                        if let Err(error)=service.refresh_locked() { eprintln!("plugin lifecycle publication: {error}"); }
                    }
                }
            }
        });
    }
    pub fn bind_lifetime<T: Send + Sync + 'static>(
        &self,
        lifetime: &Arc<T>,
        tasks: &tokio_util::task::TaskTracker,
    ) {
        let lifetime: Arc<dyn Send + Sync> = lifetime.clone();
        self.services
            .lifetime
            .set(Arc::downgrade(&lifetime))
            .ok()
            .expect("Host lifetime binds once");
        self.services
            .tasks
            .set(tasks.clone())
            .expect("Host tasks bind once");
    }
    pub(crate) fn registry(&self) -> Result<Arc<CapabilityRegistry>, OperationError> {
        self.registry
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| OperationError::Unavailable("plugin ports are not composed".into()))
    }
    /// Refresh only registration metadata from already-observed native state.
    /// This never activates, reconnects, recovers or repeats scientific work.
    pub fn refresh(&self) -> Result<(), OperationError> {
        let Ok(_guard) = self.gate.try_lock() else {
            return Ok(());
        };
        self.refresh_locked()
    }
    pub(crate) fn refresh_locked(&self) -> Result<(), OperationError> {
        let capabilities = self.runtime.contributions(&self.project);
        let mut published = self.published.lock().unwrap();
        if *published != capabilities {
            self.bridge.refresh(self.registry()?.as_ref())?;
            *published = capabilities;
        }
        Ok(())
    }
    pub(crate) fn published(&self) {
        *self.published.lock().unwrap() = self.runtime.contributions(&self.project);
    }
    pub fn observe_instance(
        &self,
        context: &host::CallContext,
        identity: &InstanceRef,
        logs: bool,
    ) -> Result<PluginInstanceObservation, OperationError> {
        let principal = plugin_principal_id(context.principal());
        let instance = self
            .repository
            .lock()
            .unwrap()
            .recorded_instance(identity, &self.project, &principal)
            .map_err(|_| OperationError::NotFound(identity.instance.to_string()))?;
        let current = self
            .runtime
            .observe()
            .into_iter()
            .find(|o| o.instance.identity == *identity);
        Ok(match current {
            Some(observation) => PluginInstanceObservation {
                instance: observation.instance,
                observed_in_this_host: true,
                process_id: observation.process_id,
                retained_calls: Some(observation.retained_calls as u32),
                pending_messages: Some(observation.pending_messages as u32),
                stderr: logs.then_some(observation.stderr),
            },
            None => PluginInstanceObservation {
                instance,
                observed_in_this_host: false,
                process_id: None,
                retained_calls: None,
                pending_messages: None,
                stderr: None,
            },
        })
    }
    /// Completion confirms native scheduling cleanup and version protections
    /// from original terminal journal authority. It never repeats scientific
    /// execution or changes its outcome.
    pub async fn complete_record(
        &self,
        context: &host::CallContext,
        record: &host::OperationRecord,
    ) -> Result<(), OperationError> {
        if record.operation.idempotency_scope.as_deref() != Some(self.scope.as_str())
            || record.operation.principal() != context.principal()
            || !record.status.is_terminal()
        {
            return Err(OperationError::NotFound(
                record.operation.operation_id.as_str().into(),
            ));
        }
        let Some(admission) = &record.operation.admission else {
            return Ok(());
        };
        let missing = admission
            .descriptor
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: record.operation.capability.display_key(),
                missing,
            });
        }
        if record.operation.domain == "plugins"
            && let Some(revision) = admission
                .owner_context
                .get("managed_revision")
                .and_then(Value::as_str)
        {
            self.repository
                .lock()
                .unwrap()
                .release_reference(
                    "management",
                    record.operation.operation_id.as_str(),
                    &RevisionId::new(revision).map_err(error)?,
                )
                .map_err(error)?;
        } else if admission
            .descriptor
            .input_schema
            .get("x-rho-plugin-contract")
            .is_some()
        {
            self.bridge
                .reconcile_reference(
                    self.journal.as_ref(),
                    context,
                    &record.operation.operation_id,
                )
                .await?;
        }
        Ok(())
    }
    pub async fn drain(&self) {
        let _guard = self.gate.lock().await;
        self.close_live_views();
        for observation in self.runtime.observe() {
            if matches!(
                observation.instance.state,
                InstanceState::Active | InstanceState::Draining
            ) {
                let _ = self.runtime.release(&observation.instance.identity).await;
            }
        }
        let _ = self.refresh_locked();
    }
}

pub(crate) struct Services {
    resources: Arc<PluginResources>,
    project: ProjectId,
    scope: String,
    registry: OnceLock<Weak<CapabilityRegistry>>,
    gateway: OnceLock<Weak<OperationGateway>>,
    lifetime: OnceLock<Weak<dyn Send + Sync>>,
    tasks: OnceLock<tokio_util::task::TaskTracker>,
    pub(crate) principals: Mutex<BTreeMap<PrincipalId, host::CallerIdentity>>,
}
#[async_trait]
impl PluginHostServices for Services {
    fn resources(&self) -> Option<Arc<PluginResources>> { Some(self.resources.clone()) }
    async fn call(&self, call: DelegatedPluginCall) -> Result<Value, String> {
        self.delegate(call).await.map_err(|e| e.to_string())
    }
}
impl Services {
    async fn delegate(&self, call: DelegatedPluginCall) -> Result<Value, OperationError> {
        if call.parent.binding.project != self.project
            || call.parent.binding.provider != call.provider
        {
            return Err(OperationError::InvalidInput(
                "delegation does not belong to this Host/provider".into(),
            ));
        }
        let principal = self
            .principals
            .lock()
            .unwrap()
            .get(&call.parent.principal)
            .cloned()
            .ok_or_else(|| {
                OperationError::Unavailable("delegated principal is no longer bound".into())
            })?;
        let context = host::CallContext {
            caller: host::CallerIdentity {
                kind: host::CallerKind::Plugin,
                id: call.provider.instance.to_string(),
            },
            principal: Some(principal),
            scopes: call.grant.scopes.clone(),
            connection_id: format!("plugin:{}", call.provider.instance),
            correlation_id: None,
            causation_id: call
                .parent
                .operation_id
                .as_deref()
                .map(host::OperationId::new)
                .transpose()?,
            trace_parent: None,
        };
        let registry = self
            .registry
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| OperationError::Unavailable("Host registry ended".into()))?;
        let capability = host::CapabilityRef::new(
            call.grant.capability.id.as_str(),
            call.grant.capability.version.try_into().map_err(invalid)?,
        )?;
        let descriptor = registry
            .descriptor(&capability)
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))?;
        let lifetime = self
            .lifetime
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| error("Host lifetime ended"))?;
        let tasks = self
            .tasks
            .get()
            .ok_or_else(|| error("Host task tracker unavailable"))?;
        match descriptor.kind {
            host::CapabilityKind::Query => {
                tasks.spawn(async move {
                    let result=QueryGateway::new(registry).query(&context,host::QueryRequest {capability,arguments:call.arguments}).await;
                    drop(lifetime);
                    result.map(|value|json!(value))
                }).await.map_err(error)?
            }
            host::CapabilityKind::Operation if !call.query_only && call.parent.operation_id.is_some() => {
                let gateway=self.gateway.get().and_then(Weak::upgrade).ok_or_else(||OperationError::Unavailable("Host gateway ended".into()))?;
                let identity=json!({"provider":call.provider,"parent":call.parent.operation_id,"request":call.request,"project":self.scope});
                let id=crate::content_digest(&serde_json::to_vec(&identity).map_err(error)?);
                tasks.spawn(async move {
                    let result=gateway.invoke(&context,host::Invocation {client_request_id:format!("delegated-{}",id.as_str()),capability,arguments:call.arguments,preconditions:vec![]}).await;
                    drop(lifetime);
                    result.map(|value|json!(value))
                }).await.map_err(error)?
            }
            _=>Err(OperationError::AccessDenied {capability:capability.display_key(),missing:vec!["an effectful active parent and an Operation grant (controls cannot be delegated as queries)".into()]}),
        }
    }
}

pub(crate) fn error(e: impl std::fmt::Display) -> OperationError {
    OperationError::Unavailable(e.to_string())
}
pub(crate) fn invalid(e: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(e.to_string())
}

impl Drop for PluginService {
    fn drop(&mut self) {
        self.stopped.cancel();
    }
}
