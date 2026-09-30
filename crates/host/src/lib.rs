#![forbid(unsafe_code)]
mod discovery;
mod observer;
mod port_contracts;
mod config;
mod paths;
mod plugin_views;
mod plugin_tests;
mod ownership;
pub use observer::QueryObserver;
pub use config::{HostProfile, ReservedHost};
pub use paths::default_database;
pub use rho_sqlite::ApplicationStore;
pub use rho_operation::OperationError;
use ownership::ProjectLease;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use rho_contract::{CallContext, CallerIdentity, CallerKind, CapabilityDescriptor, Invocation,
    OperationEventRecord, OperationId, OperationRecord, OutboxRecord, QueryRequest, QuerySnapshot};
use rho_operation::{CancellationRequestOutcome, CapabilityRegistry, Clock, OperationGateway,
    OperationIdGenerator, OperationJournal, QueryGateway, StoredDomainFact, SystemClock, UuidOperationIdGenerator};
use rho_sqlite::SqliteOperationJournal;
use serde_json::json;

pub struct NextHost {
    runtime: Arc<HostRuntime>,
    recovered_on_open: Vec<OperationRecord>,
    tasks: tokio_util::task::TaskTracker,
}

// Accepted tasks retain this entire lifetime, not just a gateway or query
// handle. Drop adapters/journal before releasing the project's OS lease.
struct HostRuntime {
    registry: Arc<CapabilityRegistry>,
    gateway: Arc<OperationGateway>,
    queries: Arc<QueryGateway>,
    plugins: Option<Arc<rho_plugins::PluginService>>,
    test_projects: Option<Arc<plugin_tests::TestProjects>>,
    _project_lease: Option<Arc<ProjectLease>>,
}

#[derive(Default)]
struct HostDomains {
    disable_test_projects: bool,
    plugin_store: Option<PathBuf>,
    protected_paths: Vec<PathBuf>,
    project_lease: Option<ProjectLease>,
}
impl NextHost {
    /// Compose only the generic plugin/Operation workspace. Package discovery
    /// never selects providers, starts a scientific owner or attaches R. A fresh
    /// test project can use this same Host flow without inheriting an analysis.
    pub async fn open_plugin_workspace(
        database: impl AsRef<Path>,
        project_root: impl AsRef<Path>,
    ) -> Result<Self, OperationError> {
        let database = database.as_ref();
        let lease = ProjectLease::acquire(project_root.as_ref())?;
        Self::open_plugin_workspace_reserved(database, lease).await
    }

    async fn open_plugin_workspace_reserved(
        database: &Path,
        lease: ProjectLease,
    ) -> Result<Self, OperationError> {
        Self::open_generic_reserved(database, lease, false).await
    }

    async fn open_plugin_test_workspace(database: &Path, root: &Path) -> Result<Self, OperationError> {
        Self::open_generic_reserved(database, ProjectLease::acquire(root)?, true).await
    }

    async fn open_generic_reserved(database: &Path, lease: ProjectLease, disable_test_projects: bool) -> Result<Self, OperationError> {
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let mut protected = paths::protected_path_candidates(database);
        protected.push(lease.path().to_owned());
        Self::compose(
            journal,
            HostDomains {
                plugin_store: Some(rho_plugins::repository_path(database)),
                disable_test_projects,
                protected_paths: protected,
                project_lease: Some(lease),
                ..HostDomains::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }

    pub async fn dispatch(
        &self,
        context: &CallContext,
        request: rho_contract::HostRequest,
    ) -> Result<serde_json::Value, OperationError> {
        use rho_contract::HostRequest;
        let request = match request {
            HostRequest::Control(control) => port_contracts::control_request(&self.runtime.registry, context, control)?,
            request => request,
        };
        let result = match request {
            HostRequest::Control(request) => {
                let runtime = self.runtime.clone();
                let context = context.clone();
                return self.tasks.spawn(async move {
                    runtime.registry.control(&context, request).await
                }).await.map_err(|_| OperationError::Unavailable(
                    "Control completion was lost; inspect the native request before retrying".into()
                ))?;
            }
            HostRequest::Invoke(invocation) => {
                serde_json::to_value(if invocation.return_after_acceptance == Some(true) {
                    self.invoke_accepted(context, invocation.invocation).await?
                } else {
                    self.invoke(context, invocation.invocation).await?
                })
            }
            HostRequest::GetOperation { operation_id } => {
                serde_json::to_value(self.get_operation(context, &operation_id).await?)
            }
            HostRequest::RequestCancellation {
                operation_id,
                only_if_pending,
            } => serde_json::to_value(
                self.request_cancellation_conditional(
                    context,
                    &operation_id,
                    only_if_pending.unwrap_or(false),
                )
                .await?,
            ),
            HostRequest::ReconcileCommit(args) => {
                serde_json::to_value(self.reconcile_commit(context, &args).await?)
            }
            HostRequest::QuerySnapshot(query) => {
                serde_json::to_value(self.query_snapshot(context, query).await?)
            }
            HostRequest::Subscribe {
                after_sequence,
                limit,
            } => serde_json::to_value(self.outbox(context, after_sequence, limit).await?),
        };
        result.map_err(|error| OperationError::Contract(error.to_string()))
    }
    /// Context for a local, OS-user-owned CLI. Callers cannot put identity in Invocation.
    pub fn local_context() -> CallContext {
        CallContext {
            view_scope: None,
            principal: None,
            caller: CallerIdentity {
                kind: CallerKind::Human,
                id: "local-user".into(),
            },
            scopes: std::collections::BTreeSet::from([
                "operation.read".into(),
                "project.references.read".into(),
                "application.read".into(),
                "application.control".into(),
                "skill.read".into(),
                rho_plugins::PLUGINS_READ_SCOPE.into(),
                rho_plugins::RESOURCES_READ_SCOPE.into(),
                rho_plugins::DOCUMENTS_READ_SCOPE.into(),
                rho_plugins::DOCUMENTS_WRITE_SCOPE.into(),
                rho_plugins::PLUGINS_WRITE_SCOPE.into(),
                rho_plugins::PLUGINS_RUN_SCOPE.into(),
                "workspace.run_r".into(),
                "workspace.read".into(),
                "project.read".into(),
                "project.write".into(),
                "environment.read".into(),
                "environment.write".into(),
                "process.run_local".into(),
                "remote.execute".into(),
                "slurm.read".into(),
                "slurm.write".into(),
            ]),
            connection_id: format!("cli:{}", std::process::id()),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        }
    }

    /// Compose standalone history observations without writer ownership or runtime startup.
    pub fn open_query_observer(
        database: impl AsRef<Path>,
        project: Option<&Path>,
    ) -> Result<QueryObserver, OperationError> {
        QueryObserver::open(database.as_ref(), project)
    }
    pub fn open_read_only(database: impl AsRef<Path>) -> Result<Self, OperationError> {
        let journal = Arc::new(SqliteOperationJournal::open_read_only(database)?);
        let observer = QueryObserver::from_sources(Some(journal), None)?;
        let registry = observer.registry;
        let gateway = observer
            .gateway
            .expect("A composed existing journal provides its read gateway");
        Ok(Self {
            runtime: Arc::new(HostRuntime {
                gateway,
                queries: Arc::new(QueryGateway::new(registry.clone())),
                registry,
                plugins: None,
                test_projects: None,
                _project_lease: None,
            }),
            recovered_on_open: Vec::new(),
            tasks: tokio_util::task::TaskTracker::new(),
        })
    }
    async fn compose(
        journal: Arc<dyn OperationJournal>,
        domains: HostDomains,
        clock: Arc<dyn Clock>,
        id_generator: Arc<dyn OperationIdGenerator>,
    ) -> Result<Self, OperationError> {
        let HostDomains { disable_test_projects, plugin_store, protected_paths, project_lease } = domains;
        let project_lease = project_lease.map(Arc::new);
        let project = project_lease.as_ref().map(|lease| lease.root().to_string_lossy().into_owned());
        let targets = project.as_ref().map(|root| vec![rho_contract::TargetRef {
            kind: "project".into(), identity: root.clone(),
        }]).unwrap_or_default();
        let discovery = discovery::DiscoveryOwner::new(project.clone(), targets);
        let mut registry = CapabilityRegistry::new();
        for id in ["host.overview", "host.catalog", "host.describe", "host.core_contract"] {
            registry.register_query(Arc::new(discovery::DiscoveryHandler::new(discovery.clone(), id)))?;
        }
        let test_projects = if disable_test_projects { None } else {
            plugin_store.as_ref().zip(project.clone())
                .map(|(store, project)| plugin_tests::TestProjects::open(store, project)).transpose()?
        };
        if let Some(owner) = &test_projects { owner.register(&mut registry)?; }
        let plugins = plugin_store.zip(project.clone())
            .map(|(store, project)| rho_plugins::PluginService::open(&store, project, protected_paths, journal.clone()))
            .transpose()?;
        if let Some(plugins) = &plugins { plugins.register(&mut registry)?; }
        let event_port = observer::register_record_queries(&mut registry, journal.clone(), project.clone(), true)?;
        registry.validate_links()?;
        let registry = Arc::new(registry);
        discovery.bind(&registry);
        let gateway = Arc::new(OperationGateway::new(registry.clone(), journal, clock, id_generator)
            .with_project_scope(project));
        event_port.bind(&gateway, &registry);
        if let Some(plugins) = &plugins { plugins.bind(&registry, &gateway); }
        let recovered_on_open = gateway.recover_incomplete().await?;
        let tasks = tokio_util::task::TaskTracker::new();
        let runtime = Arc::new(HostRuntime {
            gateway, queries: Arc::new(QueryGateway::new(registry.clone())), registry,
            plugins, test_projects, _project_lease: project_lease,
        });
        if let Some(plugins) = &runtime.plugins { plugins.bind_lifetime(&runtime, &tasks); }
        Ok(Self { runtime, recovered_on_open, tasks })
    }

    /// Select an already running disposable Host. Holding this handle prevents
    /// its stop operation from racing requests through the ordinary Host ports.
    pub fn plugin_test_host(&self, context: &CallContext, id: &rho_plugin_protocol::TestProjectId) -> Result<Arc<NextHost>, OperationError> {
        self.runtime.test_projects.as_ref().ok_or_else(||OperationError::Unavailable("Test project hosting is unavailable".into()))?.host(context, id)
    }

    /// Transport selection preserves the same caller and the selected Host's
    /// ordinary ports. Holding the child handle fences native stop through the call.
    pub async fn dispatch_selected(&self, context: &CallContext, test_project: Option<&rho_plugin_protocol::TestProjectId>, request: rho_contract::HostRequest) -> Result<serde_json::Value, OperationError> {
        match test_project {
            Some(id) => self.plugin_test_host(context, id)?.dispatch(context, request).await,
            None => self.dispatch(context, request).await,
        }
    }

    pub fn capability_publications(&self) -> tokio::sync::watch::Receiver<u64> {
        self.runtime.registry.subscribe_publications()
    }

    pub fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        self.refresh_plugin_registrations();
        self.runtime.gateway.registry_descriptors()
    }
    /// Shared discovery/tool visibility; target-specific authority is checked
    /// again by its owner when a control is admitted.
    pub fn capabilities_for(&self, context: &CallContext) -> Vec<CapabilityDescriptor> {
        port_contracts::visible(self.capabilities(), context)
    }

    pub fn recovered_on_open(&self) -> &[OperationRecord] {
        &self.recovered_on_open
    }

    fn refresh_plugin_registrations(&self) {
        if let Some(plugins) = &self.runtime.plugins {
            // Native failure can withdraw capabilities; this observes only state
            // already held by the owner, and never starts or repairs a process.
            if let Err(error) = plugins.refresh() { eprintln!("plugin registration refresh: {error}"); }
        }
    }

    pub async fn invoke(
        &self,
        context: &CallContext,
        invocation: Invocation,
    ) -> Result<OperationRecord, OperationError> {
        self.refresh_plugin_registrations();
        // The host owns execution. Dropping an edge's response future must not abandon
        // the result commit or release plugin ownership while work is still running.
        let runtime = self.runtime.clone();
        let context = context.clone();
        self.tasks
            .spawn(async move {
                let result = runtime.gateway.invoke(&context, invocation).await;
                drop(runtime);
                result
            })
            .await
            .map_err(|error| {
                OperationError::Storage(format!("operation task ended without a result: {error}"))
            })?
    }

    pub async fn invoke_accepted(
        &self,
        context: &CallContext,
        invocation: Invocation,
    ) -> Result<OperationRecord, OperationError> {
        self.refresh_plugin_registrations();
        let runtime = self.runtime.clone();
        let context = context.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut task = self.tasks.spawn(async move {
            let result = runtime
                .gateway
                .invoke_notifying(&context, invocation, Some(tx))
                .await;
            drop(runtime);
            result
        });
        tokio::select! {
            record=rx=> match record {Ok(record)=>Ok(record),Err(_)=>task.await.map_err(|e|OperationError::Storage(e.to_string()))?},
            result=&mut task=>result.map_err(|e|OperationError::Storage(e.to_string()))?,
        }
    }

    pub async fn query_snapshot(
        &self,
        context: &CallContext,
        request: QueryRequest,
    ) -> Result<QuerySnapshot, OperationError> {
        self.refresh_plugin_registrations();
        let runtime = self.runtime.clone();
        let context = context.clone();
        // Keep provider ownership until the read has finished, even if an edge disconnects.
        self.tasks
            .spawn(async move {
                let result = runtime.queries.query(&context, request).await;
                drop(runtime);
                result
            })
            .await
            .map_err(|error| OperationError::Storage(format!("query task failed: {error}")))?
    }

    pub async fn get_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        let snapshot = self
            .query_snapshot(
                context,
                QueryRequest {
                    capability: rho_contract::CapabilityRef::new("operation.get", 1)?,
                    arguments: json!({"operation_id":operation_id}),
                },
            )
            .await?;
        let result: rho_contract::OperationGetResult =
            serde_json::from_value(snapshot.data.ok_or_else(|| {
                OperationError::Contract("operation.get returned no payload".into())
            })?)
            .map_err(|e| OperationError::Contract(e.to_string()))?;
        Ok(result.record)
    }
    /// Hosting lifecycle only: keep accepted work alive after an edge disconnects.
    pub fn is_idle(&self) -> bool {
        self.tasks.is_empty() && !self.runtime.gateway.commit_recovery().has_retained_results()
            && self.runtime.test_projects.as_ref().is_none_or(|owner| owner.is_idle())
    }

    /// The caller must first stop accepting new work through every edge.
    pub async fn prepare_workbench_quit(&self) -> Result<(), OperationError> {
        if !self.is_idle() {
            return Err(OperationError::Unavailable(
                "Accepted work or an uncommitted result remains; inspect and reconcile its original operation before quitting"
                    .into(),
            ));
        }
        Ok(())
    }

    /// The caller must first stop accepting new work through every edge.
    pub async fn drain(&self) {
        self.drain_plugins(true).await;
    }

    /// Disposable child-project teardown permanently releases its instances.
    pub(crate) async fn drain_discarding_plugins(&self) {
        self.drain_plugins(false).await;
    }

    async fn drain_plugins(&self, retain_plugins: bool) {
        self.tasks.close();
        self.tasks.wait().await;
        if let Some(owner) = &self.runtime.test_projects { Box::pin(owner.drain()).await; }
        if let Some(plugins) = &self.runtime.plugins {
            if retain_plugins { plugins.suspend_for_restart().await; }
            else { plugins.drain().await; }
        }
    }

    pub async fn reconcile_commit(
        &self,
        context: &CallContext,
        args: &rho_contract::ReconcileOperationCommit,
    ) -> Result<OperationRecord, OperationError> {
        // The Host owns the completion attempt even if its requesting edge
        // disconnects. Quit must wait for the original lease callback as well.
        let runtime = self.runtime.clone();
        let context = context.clone();
        let args = args.clone();
        self.tasks.spawn(async move {
            let capability = rho_contract::CapabilityRef::new(port_contracts::RECONCILE, 1)?;
            runtime.registry.validate_control_input(&context, &capability, &json!(args))?;
            let record = runtime.gateway.reconcile_commit(&context, &args).await?;
            runtime.registry.validate_control_output(&capability, &json!(record))?;
            if let Some(plugins) = &runtime.plugins {
                if let Err(error) = plugins.complete_record(&context, &record).await {
                    eprintln!("committed operation retains plugin protections; use plugins.reconcile_references: {error}");
                }
            }
            Ok(record)
        }).await.map_err(|error| OperationError::Storage(format!("commit reconciliation task ended: {error}")))?
    }

    pub async fn request_cancellation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        self.request_cancellation_conditional(context, operation_id, false)
            .await
    }

    async fn request_cancellation_conditional(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
        only_if_pending: bool,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        let runtime = self.runtime.clone();
        let context = context.clone();
        let operation_id = operation_id.clone();
        // Native pending-cancellation preparation can outlive a view/edge. Keep
        // its original journal decision and signal owned by this Host task.
        self.tasks.spawn(async move {
            let result = runtime.registry.control(&context, rho_contract::ControlRequest {
                capability: rho_contract::CapabilityRef::new(port_contracts::CANCEL, 1)?,
                arguments: json!({"operation_id":operation_id,"only_if_pending":only_if_pending}),
            }).await?;
            serde_json::from_value(result).map_err(|e| OperationError::Contract(e.to_string()))
        }).await.map_err(|_| OperationError::Unavailable("Original cancellation acknowledgement was lost; inspect the same operation before retrying".into()))?
    }

    pub async fn events(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Vec<OperationEventRecord>, OperationError> {
        self.runtime.gateway.events(context, operation_id).await
    }

    pub async fn outbox(
        &self,
        context: &CallContext,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, OperationError> {
        let snapshot = self
            .query_snapshot(
                context,
                QueryRequest {
                    capability: rho_contract::CapabilityRef::new(port_contracts::EVENTS, 1)?,
                    arguments: json!({"after_sequence":after_sequence,"limit":limit}),
                },
            )
            .await?;
        let page: rho_contract::OperationEventsPage =
            serde_json::from_value(snapshot.data.ok_or_else(|| {
                OperationError::Contract("operation.events returned no payload".into())
            })?)
            .map_err(|e| OperationError::Contract(e.to_string()))?;
        Ok(page.events)
    }

    pub async fn facts_for_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Vec<StoredDomainFact>, OperationError> {
        self.runtime
            .gateway
            .facts_for_operation(context, operation_id)
            .await
    }
}
