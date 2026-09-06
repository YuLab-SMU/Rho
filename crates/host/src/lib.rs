#![forbid(unsafe_code)]

mod config;
mod environment;
mod ownership;
pub use config::{HostProfile, ReservedHost, RuntimeConfiguration};
use ownership::ProjectLease;
mod records;
mod usage;
pub use environment::REnvironmentConfig;
use environment::selected_environment;
use records::JournalRecords;
use rho_environment::{
    ENVIRONMENT_READ_SCOPE, ENVIRONMENT_WRITE_SCOPE, EnvironmentAction, EnvironmentHandler,
    EnvironmentObserveHandler, EnvironmentOwner, EnvironmentRuntime,
};
use rho_r_environment::REnvironment;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use rho_contract::{
    CallContext, CallerIdentity, CallerKind, CapabilityDescriptor, EffectObservation, Invocation,
    ObservationCompleteness, Operation, OperationEventRecord, OperationId, OperationRecord,
    OutboxRecord, QueryRequest, QuerySnapshot,
};
use rho_execution::remote::{REMOTE_EXECUTE_SCOPE, RemoteRunHandler};
use rho_execution::slurm::{
    SLURM_READ_SCOPE, SLURM_WRITE_SCOPE, SlurmAction, SlurmHandler, SlurmOwner, SlurmQueryHandler,
};
use rho_execution::{RUN_LOCAL_SCOPE, ReconcileProcessHandler, RunLocalHandler};
use rho_git::GitProject;
use rho_operation::{
    CancellationRequestOutcome, CapabilityRegistry, Clock, OperationError, OperationGateway,
    OperationIdGenerator, OperationJournal, QueryGateway, StoredDomainFact, SystemClock,
    UuidOperationIdGenerator,
};
use rho_process::LocalProcessExecutor;
use rho_project::{
    PROJECT_READ_SCOPE, PROJECT_WRITE_SCOPE, ProjectOwner, ProjectPatchHandler, ProjectReadHandler,
    ProjectRuntime, ProjectSnapshotHandler,
};
use rho_sqlite::SqliteOperationJournal;
pub use rho_ssh::SshConfig;
use rho_ssh::SshRemote;
use rho_workspace::{
    RunRArguments, WORKSPACE_READ_SCOPE, WorkspaceQueryHandler, WorkspaceQueryKind,
    WorkspaceRunHandler, WorkspaceRuntime, WorkspaceRuntimeError, WorkspaceRuntimeReport,
};
use serde_json::json;

pub use rho_r_runtime::ArkConfig;
use rho_r_runtime::ArkRuntime;
pub use rho_workspace::{RUN_R_CAPABILITY_ID, RUN_R_CAPABILITY_VERSION, RUN_R_SCOPE};

pub const FAKE_WORKSPACE_SESSION_ID: &str = "workspace-session-deterministic-fake";

pub struct DeterministicWorkspaceRuntime {
    session_id: String,
    executions: AtomicU64,
}

impl Default for DeterministicWorkspaceRuntime {
    fn default() -> Self {
        Self::new(FAKE_WORKSPACE_SESSION_ID)
    }
}

impl DeterministicWorkspaceRuntime {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            executions: AtomicU64::new(0),
        }
    }

    pub fn execution_count(&self) -> u64 {
        self.executions.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl WorkspaceRuntime for DeterministicWorkspaceRuntime {
    fn session_id(&self) -> &str {
        &self.session_id
    }

    async fn execute(
        &self,
        operation: &Operation,
        request: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        let execution_index = self.executions.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(WorkspaceRuntimeReport {
            session_id: self.session_id.clone(),
            value: json!({
                "kind": "deterministic_fake",
                "echo": request.code,
                "execution_index": execution_index,
                "operation_id": operation.operation_id,
            }),
            stdout: String::new(),
            stderr: String::new(),
            conditions: Vec::new(),
            output_references: Vec::new(),
            effect_observations: vec![EffectObservation {
                kind: "runtime_evaluation".into(),
                source: "deterministic_fake".into(),
                detail: json!({"simulated": true}),
                observed_at_ms: operation.accepted_at_ms,
                completeness: ObservationCompleteness::Complete,
            }],
            outcome: rho_contract::OperationOutcome::Succeeded,
            error: None,
        })
    }
}

pub struct NextHost {
    runtime: Arc<HostRuntime>,
    recovered_on_open: Vec<OperationRecord>,
    tasks: tokio_util::task::TaskTracker,
}

// Accepted tasks retain this entire lifetime, not just a gateway or query
// handle. Drop adapters/journal before releasing the project's OS lease.
struct HostRuntime {
    gateway: Arc<OperationGateway>,
    queries: Arc<QueryGateway>,
    _project_lease: Option<ProjectLease>,
}

#[derive(Default)]
struct HostDomains {
    workspace: Option<Arc<dyn WorkspaceRuntime>>,
    project: Option<Arc<dyn ProjectRuntime>>,
    environment: Option<Arc<dyn EnvironmentRuntime>>,
    active_library: Option<String>,
    remote: Option<Arc<SshRemote>>,
    project_lease: Option<ProjectLease>,
}
fn remote_components(
    root: &Path,
    config: Option<SshConfig>,
) -> Result<Option<Arc<SshRemote>>, OperationError> {
    config
        .map(|config| {
            SshRemote::new(root, config)
                .map(Arc::new)
                .map_err(OperationError::TargetResolution)
        })
        .transpose()
}

impl NextHost {
    pub async fn open_project(
        database: impl AsRef<Path>,
        project_root: impl AsRef<Path>,
    ) -> Result<Self, OperationError> {
        Self::open_project_with_remote(database, project_root, None).await
    }
    pub async fn open_project_with_remote(
        database: impl AsRef<Path>,
        project_root: impl AsRef<Path>,
        remote: Option<SshConfig>,
    ) -> Result<Self, OperationError> {
        let lease = ProjectLease::acquire(project_root.as_ref())?;
        Self::open_project_reserved(database.as_ref(), lease, remote).await
    }

    async fn open_project_reserved(
        database: &Path,
        lease: ProjectLease,
        remote: Option<SshConfig>,
    ) -> Result<Self, OperationError> {
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let mut excluded = protected_project_paths(database)?;
        excluded.push(lease.path().to_owned());
        let project = Arc::new(
            GitProject::open(lease.root(), excluded).map_err(OperationError::TargetResolution)?,
        );
        let remote = remote_components(Path::new(project.root()), remote)?;
        Self::compose(
            journal,
            HostDomains {
                project: Some(project),
                remote,
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
        let result = match request {
            HostRequest::Invoke(invocation) => {
                serde_json::to_value(self.invoke(context, invocation).await?)
            }
            HostRequest::GetOperation { operation_id } => {
                serde_json::to_value(self.get_operation(context, &operation_id).await?)
            }
            HostRequest::RequestCancellation { operation_id } => {
                serde_json::to_value(self.request_cancellation(context, &operation_id).await?)
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
    pub async fn open_ark(
        database: impl AsRef<Path>,
        config: ArkConfig,
    ) -> Result<Self, OperationError> {
        Self::open_ark_with_environment(database, config, None).await
    }

    pub async fn open_environment(
        database: impl AsRef<Path>,
        config: REnvironmentConfig,
    ) -> Result<Self, OperationError> {
        Self::open_environment_with_remote(database, config, None).await
    }
    pub async fn open_environment_with_remote(
        database: impl AsRef<Path>,
        config: REnvironmentConfig,
        remote: Option<SshConfig>,
    ) -> Result<Self, OperationError> {
        let lease = ProjectLease::acquire(&config.project_root)?;
        Self::open_environment_reserved(database.as_ref(), config, remote, lease).await
    }

    async fn open_environment_reserved(
        database: &Path,
        mut config: REnvironmentConfig,
        remote: Option<SshConfig>,
        lease: ProjectLease,
    ) -> Result<Self, OperationError> {
        config.project_root = lease.root().to_owned();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let root = config.project_root.clone();
        let remote = remote_components(&root, remote)?;
        let data = config.data_root.clone();
        let environment =
            Arc::new(REnvironment::open(config).map_err(OperationError::TargetResolution)?);
        let mut excluded = protected_project_paths(database)?;
        excluded.push(lease.path().to_owned());
        excluded.push(
            data.canonicalize()
                .map_err(|e| OperationError::Storage(e.to_string()))?,
        );
        let project =
            Arc::new(GitProject::open(root, excluded).map_err(OperationError::TargetResolution)?);
        Self::compose(
            journal,
            HostDomains {
                project: Some(project),
                environment: Some(environment),
                remote,
                project_lease: Some(lease),
                ..HostDomains::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }

    pub async fn open_ark_with_environment(
        database: impl AsRef<Path>,
        config: ArkConfig,
        realization_id: Option<&str>,
    ) -> Result<Self, OperationError> {
        Self::open_ark_with_remote(database, config, realization_id, None).await
    }
    pub async fn open_ark_with_remote(
        database: impl AsRef<Path>,
        config: ArkConfig,
        realization_id: Option<&str>,
        remote: Option<SshConfig>,
    ) -> Result<Self, OperationError> {
        // Acquire project ownership before journal creation, recovery or R launch.
        let lease = ProjectLease::acquire(&config.project_root)?;
        Self::open_ark_reserved(database.as_ref(), config, realization_id, remote, lease).await
    }

    async fn open_ark_reserved(
        database: &Path,
        mut config: ArkConfig,
        realization_id: Option<&str>,
        remote: Option<SshConfig>,
        lease: ProjectLease,
    ) -> Result<Self, OperationError> {
        config.project_root = lease.root().to_owned();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let remote = remote_components(&config.project_root, remote)?;
        std::fs::create_dir_all(&config.data_root)
            .map_err(|error| OperationError::Storage(error.to_string()))?;
        let mut excluded = protected_project_paths(database)?;
        excluded.push(lease.path().to_owned());
        excluded.push(
            config
                .data_root
                .canonicalize()
                .map_err(|error| OperationError::Storage(error.to_string()))?,
        );
        let environment_root = database
            .parent()
            .unwrap_or(Path::new("."))
            .join("environment");
        let executable = if cfg!(windows) {
            "Rscript.exe"
        } else {
            "Rscript"
        };
        let environment = Arc::new(
            REnvironment::open(REnvironmentConfig {
                rscript: config.r_home.join("bin").join(executable),
                project_root: config.project_root.clone(),
                data_root: environment_root.clone(),
                timeout: std::time::Duration::from_secs(300),
            })
            .map_err(OperationError::TargetResolution)?,
        );
        excluded.push(
            environment_root
                .canonicalize()
                .map_err(|e| OperationError::Storage(e.to_string()))?,
        );
        if let Some(id) = realization_id {
            let receipt = selected_environment(journal.as_ref(), environment.as_ref(), id).await?;
            config.library_path = Some(receipt.library_path.into());
        }
        let active_library = config
            .library_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let project = Arc::new(
            GitProject::open(&config.project_root, excluded)
                .map_err(OperationError::TargetResolution)?,
        );
        let runtime = Arc::new(
            ArkRuntime::launch(config)
                .await
                .map_err(OperationError::TargetResolution)?,
        );
        Self::compose(
            journal,
            HostDomains {
                workspace: Some(runtime),
                project: Some(project),
                environment: Some(environment),
                active_library,
                remote,
                project_lease: Some(lease),
            },
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }
    /// Context for a local, OS-user-owned CLI. Callers cannot put identity in Invocation.
    pub fn local_context() -> CallContext {
        CallContext {
            principal: None,
            caller: CallerIdentity {
                kind: CallerKind::Human,
                id: "local-user".into(),
            },
            scopes: std::collections::BTreeSet::from([
                RUN_R_SCOPE.into(),
                WORKSPACE_READ_SCOPE.into(),
                PROJECT_READ_SCOPE.into(),
                PROJECT_WRITE_SCOPE.into(),
                ENVIRONMENT_READ_SCOPE.into(),
                ENVIRONMENT_WRITE_SCOPE.into(),
                RUN_LOCAL_SCOPE.into(),
                REMOTE_EXECUTE_SCOPE.into(),
                SLURM_READ_SCOPE.into(),
                SLURM_WRITE_SCOPE.into(),
            ]),
            connection_id: format!("cli:{}", std::process::id()),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        }
    }

    pub fn open_read_only(database: impl AsRef<Path>) -> Result<Self, OperationError> {
        let registry = Arc::new(CapabilityRegistry::new());
        Ok(Self {
            runtime: Arc::new(HostRuntime {
                gateway: Arc::new(OperationGateway::new(
                    registry.clone(),
                    Arc::new(SqliteOperationJournal::open_read_only(database)?),
                    Arc::new(SystemClock),
                    Arc::new(UuidOperationIdGenerator),
                )),
                queries: Arc::new(QueryGateway::new(registry)),
                _project_lease: None,
            }),
            recovered_on_open: Vec::new(),
            tasks: tokio_util::task::TaskTracker::new(),
        })
    }
    pub async fn open_demo(database: impl AsRef<Path>) -> Result<Self, OperationError> {
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        Self::with_components(
            journal,
            Arc::new(DeterministicWorkspaceRuntime::default()),
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }

    pub async fn with_components(
        journal: Arc<dyn OperationJournal>,
        runtime: Arc<dyn WorkspaceRuntime>,
        clock: Arc<dyn Clock>,
        id_generator: Arc<dyn OperationIdGenerator>,
    ) -> Result<Self, OperationError> {
        Self::compose(
            journal,
            HostDomains {
                workspace: Some(runtime),
                ..HostDomains::default()
            },
            clock,
            id_generator,
        )
        .await
    }

    async fn compose(
        journal: Arc<dyn OperationJournal>,
        domains: HostDomains,
        clock: Arc<dyn Clock>,
        id_generator: Arc<dyn OperationIdGenerator>,
    ) -> Result<Self, OperationError> {
        let HostDomains {
            workspace: runtime,
            project,
            environment,
            active_library,
            remote,
            project_lease,
        } = domains;
        let mut registry = CapabilityRegistry::new();
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let records = Arc::new(JournalRecords(journal.clone()));
        if let Some(remote) = remote {
            registry.register(Arc::new(RemoteRunHandler::new(remote.clone())))?;
            if remote.has_slurm() {
                let owner = Arc::new(SlurmOwner::new(remote, records.clone()));
                for action in [
                    SlurmAction::Submit,
                    SlurmAction::Reconcile,
                    SlurmAction::RequestCancel,
                ] {
                    registry.register(Arc::new(SlurmHandler::new(owner.clone(), action)))?;
                }
                registry.register_query(Arc::new(SlurmQueryHandler::new(owner)))?;
            }
        }
        let has_workspace = runtime.is_some();
        let usage = runtime.as_ref().map(|runtime| {
            Arc::new(usage::WorkspaceUsage(runtime.clone()))
                as Arc<dyn rho_environment::EnvironmentUsage>
        });
        if let Some(runtime) = runtime {
            let workspace = Arc::new(WorkspaceRunHandler::with_lane(runtime, lane.clone()));
            registry.register(workspace.clone())?;
            registry.register_query(Arc::new(WorkspaceQueryHandler::new(
                workspace.clone(),
                WorkspaceQueryKind::Snapshot,
            )))?;
            registry.register_query(Arc::new(WorkspaceQueryHandler::new(
                workspace,
                WorkspaceQueryKind::InspectObject,
            )))?;
        }
        if let Some(project) = project {
            let process = Arc::new(
                LocalProcessExecutor::new(project.root())
                    .map_err(|e| OperationError::TargetResolution(e.to_string()))?,
            );
            registry.register(Arc::new(RunLocalHandler::new(
                process.clone(),
                lane.clone(),
            )))?;
            registry.register(Arc::new(ReconcileProcessHandler::new(
                process,
                records.clone(),
                lane.clone(),
            )))?;
            let owner = Arc::new(ProjectOwner::new(project, lane.clone()));
            registry.register(Arc::new(ProjectPatchHandler::new(owner.clone())))?;
            registry.register_query(Arc::new(ProjectSnapshotHandler::new(owner.clone())))?;
            registry.register_query(Arc::new(ProjectReadHandler::new(owner)))?;
        }
        if let Some(environment) = environment {
            let owner = Arc::new(
                EnvironmentOwner::new(environment, records, lane, active_library, has_workspace)
                    .with_usage(usage),
            );
            for action in [
                EnvironmentAction::Plan,
                EnvironmentAction::Realize,
                EnvironmentAction::Verify,
                EnvironmentAction::Reconcile,
            ] {
                registry.register(Arc::new(EnvironmentHandler::new(owner.clone(), action)))?;
            }
            registry.register_query(Arc::new(EnvironmentObserveHandler::new(owner.clone())))?;
            for action in [
                rho_environment::MaterialAction::Quarantine,
                rho_environment::MaterialAction::Restore,
                rho_environment::MaterialAction::Purge,
            ] {
                registry.register(Arc::new(rho_environment::RetentionHandler::new(
                    owner.clone(),
                    action,
                )))?;
            }
            for trash in [false, true] {
                registry.register_query(Arc::new(rho_environment::RetentionQuery::new(
                    owner.clone(),
                    trash,
                )))?;
            }
        }
        let registry = Arc::new(registry);
        let gateway = Arc::new(OperationGateway::new(
            registry.clone(),
            journal,
            clock,
            id_generator,
        ));
        let recovered_on_open = gateway.recover_incomplete().await?;
        Ok(Self {
            runtime: Arc::new(HostRuntime {
                gateway,
                queries: Arc::new(QueryGateway::new(registry)),
                _project_lease: project_lease,
            }),
            recovered_on_open,
            tasks: tokio_util::task::TaskTracker::new(),
        })
    }

    pub fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        self.runtime.gateway.registry_descriptors()
    }

    pub fn recovered_on_open(&self) -> &[OperationRecord] {
        &self.recovered_on_open
    }

    pub async fn invoke(
        &self,
        context: &CallContext,
        invocation: Invocation,
    ) -> Result<OperationRecord, OperationError> {
        // The host owns execution. Dropping an edge's response future must not abandon
        // the result commit or release the runtime lane while R is still working.
        let runtime = self.runtime.clone();
        let context = context.clone();
        self.tasks
            .spawn(async move { runtime.gateway.invoke(&context, invocation).await })
            .await
            .map_err(|error| {
                OperationError::Storage(format!("operation task ended without a result: {error}"))
            })?
    }

    pub async fn query_snapshot(
        &self,
        context: &CallContext,
        request: QueryRequest,
    ) -> Result<QuerySnapshot, OperationError> {
        let runtime = self.runtime.clone();
        let context = context.clone();
        // Keep the Workspace lane until the read has finished, even if an edge disconnects.
        self.tasks
            .spawn(async move { runtime.queries.query(&context, request).await })
            .await
            .map_err(|error| OperationError::Storage(format!("query task failed: {error}")))?
    }

    pub async fn get_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        self.runtime
            .gateway
            .get_operation(context, operation_id)
            .await
    }
    /// Hosting lifecycle only: keep accepted work alive after an edge disconnects.
    pub fn is_idle(&self) -> bool {
        self.tasks.is_empty()
    }

    /// The caller must first stop accepting new work through every edge.
    pub async fn drain(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub async fn request_cancellation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        self.runtime
            .gateway
            .request_cancellation(context, operation_id)
            .await
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
        self.runtime
            .gateway
            .outbox(context, after_sequence, limit)
            .await
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

fn protected_project_paths(database: &Path) -> Result<Vec<std::path::PathBuf>, OperationError> {
    let database = database
        .canonicalize()
        .map_err(|e| OperationError::Storage(e.to_string()))?;
    let mut excluded = vec![database.clone()];
    for suffix in [".host.lock", "-journal", "-wal", "-shm"] {
        let mut path = database.as_os_str().to_os_string();
        path.push(suffix);
        excluded.push(path.into());
    }
    Ok(excluded)
}
