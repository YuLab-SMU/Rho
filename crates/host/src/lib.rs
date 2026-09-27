#![forbid(unsafe_code)]
pub use rho_agent_client::{
    ExternalAgentClient, discover_agent, install_deepseek_component,
    NativeAgentFactory, NativeAgentSession, NativeEvent, NativeEventPage, NativeOpenFailure,
    NativeOpenRequest, NativeProcessProof, NativePrompt,
};
mod application;
mod discovery;
mod observer;
mod port_contracts;
pub use observer::QueryObserver;
mod instance_router;
mod instances;
mod skills;
pub use instances::{
    InstanceLauncher, LaunchedInstance, PreparedInstanceLaunch, RuntimeInstanceHold,
};

mod config;
mod r_configuration;
pub use r_configuration::{default_database, discover_r, probe_r};
pub use rho_sqlite::ApplicationStore;
mod agent_tasks;
mod agent_handoffs;
pub use agent_handoffs::AgentHandoffService;
mod annotations;
pub use annotations::AnnotationService;
mod html_views;
mod plugin_views;
mod plugin_tests;
pub use html_views::HtmlViewTokens;
mod agent_connections;
pub use agent_connections::{AgentMcpConnections, AgentMcpIdentity};
mod component_agents;
pub use component_agents::ComponentAgentService;
pub use rho_application::ApplicationError;
pub use agent_tasks::AgentTaskService;
mod agent_context;
pub use agent_context::{AgentContextProvider, AgentContextReader};
mod environment;
mod ownership;
pub use config::{HostProfile, ReservedHost, RuntimeConfiguration};
use ownership::ProjectLease;
mod records;
mod usage;
pub use environment::REnvironmentConfig;
use records::JournalRecords;
use rho_environment::{
    ENVIRONMENT_READ_SCOPE, ENVIRONMENT_WRITE_SCOPE, EnvironmentAction, EnvironmentHandler,
    EnvironmentObserveHandler, EnvironmentOwner, EnvironmentRuntime,
};
use rho_r_environment::REnvironment;

use std::path::{Path, PathBuf};
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
pub use rho_operation::OperationError;
use rho_operation::{
    CancellationRequestOutcome, CapabilityRegistry, Clock, OperationGateway, OperationIdGenerator,
    OperationJournal, QueryGateway, StoredDomainFact, SystemClock, UuidOperationIdGenerator,
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
    WorkspaceToolHandler, WorkspaceToolKind,
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
    registry: Arc<CapabilityRegistry>,
    gateway: Arc<OperationGateway>,
    queries: Arc<QueryGateway>,
    workspace: Option<Arc<WorkspaceRunHandler>>,
    instances: Option<Arc<instances::InstanceOwner>>,
    application: Option<Arc<rho_application::ApplicationOwner>>,
    annotations: Option<Arc<rho_application::AnnotationOwner>>,
    output_owner: Option<Arc<rho_workspace::WorkspaceOutputHandler>>,
    skills: Option<Arc<rho_skills::SkillOwner>>,
    plugins: Option<Arc<rho_plugins::PluginService>>,
    test_projects: Option<Arc<plugin_tests::TestProjects>>,
    method_binding_gate: tokio::sync::Mutex<()>,
    _project_lease: Option<Arc<ProjectLease>>,
}

#[derive(Default)]
struct HostDomains {
    disable_test_projects: bool,
    plugin_store: Option<PathBuf>,
    host_skills: Option<std::path::PathBuf>,
    skill_exclusions: Vec<std::path::PathBuf>,
    application_store: Option<Arc<ApplicationStore>>,
    workspace: Option<Arc<dyn WorkspaceRuntime>>,
    outputs: Option<Arc<dyn rho_workspace::WorkspaceOutputs>>,
    project: Option<Arc<dyn ProjectRuntime>>,
    environment: Option<Arc<dyn EnvironmentRuntime>>,
    active_library: Option<String>,
    managed: Option<ManagedInstances>,
    remote: Option<Arc<SshRemote>>,
    project_lease: Option<ProjectLease>,
}
struct ManagedInstances {
    launcher: Arc<dyn instances::InstanceLauncher>,
    app_store: Arc<ApplicationStore>,
    initial: Option<rho_contract::RuntimeLaunchBinding>,
    auto_continue: bool,
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
        let mut protected = skills::protected_path_candidates(database);
        protected.push(lease.path().to_owned());
        Self::compose(
            journal,
            HostDomains {
                plugin_store: Some(rho_plugins::repository_path(database)),
                disable_test_projects,
                skill_exclusions: protected,
                project_lease: Some(lease),
                ..HostDomains::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }

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
        Self::open_project_reserved(database.as_ref(), lease, remote, None).await
    }

    async fn open_project_reserved(
        database: &Path,
        lease: ProjectLease,
        remote: Option<SshConfig>,
        host_skills: Option<&Path>,
    ) -> Result<Self, OperationError> {
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let mut excluded = protected_project_paths(database)?;
        if let Some(manifest) = host_skills {
            excluded.push(manifest.to_path_buf());
            if let Ok(actual) = manifest.canonicalize() {
                excluded.push(actual);
            }
        }
        excluded.push(lease.path().to_owned());
        let project = Arc::new(
            GitProject::open(lease.root(), excluded.clone())
                .map_err(OperationError::TargetResolution)?,
        );
        let remote = remote_components(Path::new(project.root()), remote)?;
        let managed = ManagedInstances {
            launcher: Arc::new(instances::ArkInstanceLauncher {
                project: PathBuf::from(project.root()),
                data_root: database.parent().unwrap_or(Path::new(".")).join("runtime"),
                environment_root: database
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join("environment"),
                execution_timeout: std::time::Duration::from_secs(600),
                journal: journal.clone(),
            }),
            app_store: Arc::new(
                ApplicationStore::open(
                    &database
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join("runtime-preferences.sqlite"),
                )
                .map_err(OperationError::Storage)?,
            ),
            initial: None,
            auto_continue: false,
        };
        Self::compose(
            journal,
            HostDomains {
                plugin_store: Some(rho_plugins::repository_path(database)),
                disable_test_projects: false,
                host_skills: host_skills.map(Path::to_path_buf),
                skill_exclusions: excluded,
                application_store: Some(Arc::new(
                    ApplicationStore::open(&database.with_extension("studio.sqlite"))
                        .map_err(OperationError::Storage)?,
                )),
                outputs: Some(Arc::new(
                    rho_r_runtime::OutputStore::open(
                        &database.parent().unwrap_or(Path::new(".")).join("runtime"),
                        project.root(),
                    )
                    .map_err(OperationError::Storage)?,
                )),
                project: Some(project),
                managed: Some(managed),
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
            HostRequest::RespondInput(reply) => {
                let capability = rho_contract::CapabilityRef::new(port_contracts::INPUT, 1)?;
                // Values exist only for transient schema validation. Never put
                // stdin content into a diagnostic, operation, receipt or journal.
                let arguments = json!({"session_id":reply.session_id,"operation_id":reply.operation_id,
                    "request_id":reply.request_id,"reply_id":reply.reply_id,"value":reply.value});
                self.runtime
                    .registry
                    .validate_control_input(context, &capability, &arguments)
                    .map_err(|error| match error {
                        OperationError::InvalidInput(_) => OperationError::InvalidInput(
                            "Input response violates its contract (answer redacted)".into(),
                        ),
                        other => other,
                    })?;
                drop(arguments);
                OperationId::new(reply.operation_id.as_str())?;
                if reply.value.len() > 65536 || reply.value.contains('\0') {
                    return Err(OperationError::InvalidInput(
                        "Invalid input response byte bounds or NUL (answer redacted)".into(),
                    ));
                }
                let record = self
                    .runtime
                    .gateway
                    .owner_record(context, &reply.operation_id)
                    .await?
                    .ok_or_else(|| {
                        OperationError::NotFound(reply.operation_id.as_str().to_string())
                    })?;
                if record.operation.target.kind != "workspace"
                    || record.operation.target.identity != reply.session_id
                {
                    return Err(OperationError::InvalidInput(
                        "Input request session or scope does not match".into(),
                    ));
                }
                let workspace = if let Some(instances) = &self.runtime.instances {
                    instances.workspace_for_native(&reply.session_id)
                } else {
                    self.runtime.workspace.clone()
                };
                workspace
                    .ok_or_else(|| {
                        OperationError::StaleSession(
                            "The input's original R session is no longer available".into(),
                        )
                    })?
                    .respond_input(reply)
                    .map_err(OperationError::InvalidInput)?;
                let result =
                    serde_json::to_value(rho_contract::RespondInputResult { submitted: true })
                        .map_err(|e| OperationError::Contract(e.to_string()))?;
                self.runtime
                    .registry
                    .validate_control_output(&capability, &result)?;
                Ok(result)
            }
            HostRequest::QuerySnapshot(query) => {
                serde_json::to_value(self.query_snapshot(context, query).await?)
            }
            HostRequest::ApplicationControl(request) => {
                application::scope(context, "application.control", "application.control")?;
                let capability = rho_contract::CapabilityRef::new("application.control", 1)?;
                let arguments = serde_json::to_value(&request)
                    .map_err(|e| OperationError::Contract(e.to_string()))?;
                self.runtime
                    .registry
                    .validate_control_input(context, &capability, &arguments)?;
                let result = serde_json::to_value(
                    self.application_owner()?
                        .control(context, request, application::now()?)
                        .map_err(application::error)?,
                )
                .map_err(|e| OperationError::Contract(e.to_string()))?;
                self.runtime
                    .registry
                    .validate_control_output(&capability, &result)?;
                Ok(result)
            }
            HostRequest::ApplicationBridge(request) => {
                application::studio(context)?;
                serde_json::to_value(
                    self.application_owner()?
                        .bridge(context, request, application::now()?)
                        .map_err(application::error)?,
                )
            }
            HostRequest::ApplicationExecute(request) => {
                application::studio(context)?;
                serde_json::to_value(self.application_execute(context, request).await?)
            }
            HostRequest::BindMethod(request) => {
                let _gate = self.runtime.method_binding_gate.lock().await;
                let capability = rho_contract::CapabilityRef::new("application.bind_method", 1)?;
                self.runtime.registry.validate_control_input(
                    context,
                    &capability,
                    &serde_json::to_value(&request)
                        .map_err(|e| OperationError::Contract(e.to_string()))?,
                )?;
                let owner = self.runtime.skills.as_ref().ok_or_else(|| {
                    OperationError::Unavailable("Skills owner is unavailable".into())
                })?;
                let result = serde_json::to_value(
                    skills::bind_method(
                        owner,
                        self.application_owner()?,
                        context,
                        request.expected_version.as_deref(),
                        &request.binding,
                    )
                    .await?,
                )
                .map_err(|e| OperationError::Contract(e.to_string()))?;
                self.runtime
                    .registry
                    .validate_control_output(&capability, &result)?;
                Ok(result)
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
        Self::open_environment_reserved(database.as_ref(), config, remote, lease, None).await
    }

    async fn open_environment_reserved(
        database: &Path,
        mut config: REnvironmentConfig,
        remote: Option<SshConfig>,
        lease: ProjectLease,
        host_skills: Option<&Path>,
    ) -> Result<Self, OperationError> {
        config.project_root = lease.root().to_owned();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let root = config.project_root.clone();
        let remote = remote_components(&root, remote)?;
        let data = config.data_root.clone();
        let environment =
            Arc::new(REnvironment::open(config).map_err(OperationError::TargetResolution)?);
        // Startup is explicit. The adapter retains a failed seed as Unavailable;
        // later Environment queries never launch a helper to fill this cache.
        let _ = environment.initialize_observation().await;
        let mut excluded = protected_project_paths(database)?;
        if let Some(manifest) = host_skills {
            excluded.push(manifest.to_path_buf());
            if let Ok(actual) = manifest.canonicalize() {
                excluded.push(actual);
            }
        }
        excluded.push(lease.path().to_owned());
        excluded.push(
            data.canonicalize()
                .map_err(|e| OperationError::Storage(e.to_string()))?,
        );
        let project = Arc::new(
            GitProject::open(root, excluded.clone()).map_err(OperationError::TargetResolution)?,
        );
        Self::compose(
            journal,
            HostDomains {
                plugin_store: Some(rho_plugins::repository_path(database)),
                disable_test_projects: false,
                host_skills: host_skills.map(Path::to_path_buf),
                skill_exclusions: excluded,
                application_store: Some(Arc::new(
                    ApplicationStore::open(&database.with_extension("studio.sqlite"))
                        .map_err(OperationError::Storage)?,
                )),
                outputs: Some(Arc::new(
                    rho_r_runtime::OutputStore::open(
                        &database.parent().unwrap_or(Path::new(".")).join("runtime"),
                        project.root(),
                    )
                    .map_err(OperationError::Storage)?,
                )),
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
        Self::open_ark_reserved(
            database.as_ref(),
            config,
            realization_id,
            remote,
            lease,
            None,
            true,
        )
        .await
    }

    async fn open_ark_reserved(
        database: &Path,
        mut config: ArkConfig,
        realization_id: Option<&str>,
        remote: Option<SshConfig>,
        lease: ProjectLease,
        host_skills: Option<&Path>,
        auto_continue: bool,
    ) -> Result<Self, OperationError> {
        config.project_root = lease.root().to_owned();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let remote = remote_components(&config.project_root, remote)?;
        std::fs::create_dir_all(&config.data_root)
            .map_err(|error| OperationError::Storage(error.to_string()))?;
        let mut excluded = protected_project_paths(database)?;
        if let Some(manifest) = host_skills {
            excluded.push(manifest.to_path_buf());
            if let Ok(actual) = manifest.canonicalize() {
                excluded.push(actual);
            }
        }
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
        let _ = environment.initialize_observation().await;
        excluded.push(
            environment_root
                .canonicalize()
                .map_err(|e| OperationError::Storage(e.to_string()))?,
        );
        let project = Arc::new(
            GitProject::open(&config.project_root, excluded.clone())
                .map_err(OperationError::TargetResolution)?,
        );
        let outputs = Arc::new(
            rho_r_runtime::OutputStore::open(&config.data_root, project.root())
                .map_err(OperationError::Storage)?,
        );
        let managed = ManagedInstances {
            launcher: Arc::new(instances::ArkInstanceLauncher {
                project: config.project_root.clone(),
                data_root: config.data_root.clone(),
                environment_root,
                execution_timeout: config.execution_timeout,
                journal: journal.clone(),
            }),
            app_store: Arc::new(
                ApplicationStore::open(
                    &database
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join("runtime-preferences.sqlite"),
                )
                .map_err(OperationError::Storage)?,
            ),
            initial: Some(rho_contract::RuntimeLaunchBinding {
                r_executable: config
                    .r_home
                    .join("bin")
                    .join(if cfg!(windows) { "R.exe" } else { "R" })
                    .to_string_lossy()
                    .into_owned(),
                ark_executable: config.executable.to_string_lossy().into_owned(),
                environment_realization_id: realization_id.map(str::to_owned),
                library_path: config
                    .library_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                checkpoint_helper_path: config
                    .checkpoint_helper_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
            }),
            auto_continue,
        };
        Self::compose(
            journal,
            HostDomains {
                plugin_store: Some(rho_plugins::repository_path(database)),
                disable_test_projects: false,
                host_skills: host_skills.map(Path::to_path_buf),
                skill_exclusions: excluded,
                application_store: Some(Arc::new(
                    ApplicationStore::open(&database.with_extension("studio.sqlite"))
                        .map_err(OperationError::Storage)?,
                )),
                workspace: None,
                outputs: Some(outputs),
                project: Some(project),
                environment: Some(environment),
                active_library: None,
                managed: Some(managed),
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

    /// Compose standalone file/history observations without writer ownership or runtime startup.
    pub fn open_query_observer(
        database: impl AsRef<Path>,
        project: Option<&Path>,
    ) -> Result<QueryObserver, OperationError> {
        QueryObserver::open(database.as_ref(), project)
    }
    pub fn open_read_only(database: impl AsRef<Path>) -> Result<Self, OperationError> {
        let journal = Arc::new(SqliteOperationJournal::open_read_only(database)?);
        let observer = QueryObserver::from_sources(Some(journal), None, None)?;
        let registry = observer.registry;
        let gateway = observer
            .gateway
            .expect("A composed existing journal provides its read gateway");
        Ok(Self {
            runtime: Arc::new(HostRuntime {
                gateway,
                queries: Arc::new(QueryGateway::new(registry.clone())),
                registry,
                workspace: None,
                instances: None,
                application: None,
                annotations: None,
                output_owner: None,
                skills: None,
                plugins: None,
                test_projects: None,
                method_binding_gate: tokio::sync::Mutex::new(()),
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
            disable_test_projects,
            plugin_store,
            host_skills,
            skill_exclusions,
            application_store,
            workspace: runtime,
            outputs,
            project,
            environment,
            active_library,
            managed,
            remote,
            project_lease,
        } = domains;
        let project_lease = project_lease.map(Arc::new);
        // Project identity belongs to the native Host lease, independently of
        // whether a Files/Git or scientific owner is composed. Test components
        // without a native lease continue to supply their own explicit root.
        let output_project = project_lease
            .as_ref()
            .map(|lease| lease.root().to_string_lossy().into_owned())
            .or_else(|| project.as_ref().map(|p| p.root().to_string()));
        let auto_continue = managed
            .as_ref()
            .is_some_and(|managed| managed.auto_continue);
        let instance_owner = managed
            .map(|managed| {
                instances::InstanceOwner::open(
                    output_project.clone().ok_or_else(|| {
                        OperationError::Contract("Managed instances require a project".into())
                    })?,
                    application_store.clone().ok_or_else(|| {
                        OperationError::Contract(
                            "Managed instances require application storage".into(),
                        )
                    })?,
                    managed.app_store,
                    journal.clone(),
                    managed.launcher,
                    managed.initial,
                    project_lease.clone(),
                )
            })
            .transpose()?;
        let annotation_owner = application_store
            .clone()
            .map(|store| Arc::new(rho_application::AnnotationOwner::new(store)));
        let application_owner =
            application_store
                .zip(output_project.clone())
                .map(|(store, project)| {
                    Arc::new(rho_application::ApplicationOwner::new(project, store))
                });
        let mut registry = CapabilityRegistry::new();
        let mut targets = Vec::new();
        if let Some(project) = &output_project {
            targets.push(rho_contract::TargetRef {
                kind: "project".into(),
                identity: project.clone(),
            });
        }
        if let Some(project) = &project {
            targets.push(rho_contract::TargetRef {
                kind: "local_process".into(),
                identity: project.root().into(),
            });
        }
        if let Some(runtime) = &runtime {
            targets.push(rho_contract::TargetRef {
                kind: "workspace".into(),
                identity: runtime.session_id().into(),
            });
        }
        if let Some(environment) = &environment {
            targets.push(rho_contract::TargetRef {
                kind: "environment".into(),
                identity: environment.root().into(),
            });
        }
        if let Some(remote) = &remote {
            targets.push(rho_execution::remote::RemoteExecutor::target(
                remote.as_ref(),
            ));
        }
        let discovery =
            discovery::DiscoveryOwner::new(output_project.clone(), targets, runtime.clone());
        if let Some(owner) = &instance_owner {
            discovery.bind_instances(owner);
        }
        let skill_owner = if let Some(app) = &application_owner {
            Some(skills::compose(
                output_project.as_deref().unwrap(),
                app.clone(),
                discovery.clone(),
                host_skills.as_deref(),
                skill_exclusions.clone(),
            )?)
        } else {
            None
        };
        for id in ["host.overview", "host.catalog", "host.describe"] {
            registry.register_query(Arc::new(discovery::DiscoveryHandler::new(
                discovery.clone(),
                id,
            )))?;
        }
        if let Some(owner) = &application_owner {
            for id in [
                "application.windows",
                "application.context",
                "application.read_document",
                "application.command_status",
            ] {
                registry.register_query(Arc::new(application::ApplicationHandler::new(
                    owner.clone(),
                    journal.clone(),
                    output_project.clone().unwrap(),
                    id,
                )))?;
            }
            registry.register_control(application::descriptor("application.control"))?;
        }
        if let Some(owner) = &skill_owner {
            for kind in [
                rho_skills::SkillQueryKind::List,
                rho_skills::SkillQueryKind::Read,
                rho_skills::SkillQueryKind::ResolveContext,
            ] {
                registry.register_query(Arc::new(rho_skills::SkillQueryHandler::new(
                    owner.clone(),
                    kind,
                )))?;
            }
            registry.register_control(skills::bind_method_descriptor())?;
        }
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
        let has_workspace = runtime.is_some() || instance_owner.is_some();
        let usage = if let Some(owner) = &instance_owner {
            Some(Arc::new(usage::InstancesUsage(owner.clone()))
                as Arc<dyn rho_environment::EnvironmentUsage>)
        } else {
            runtime.as_ref().map(|runtime| {
                Arc::new(usage::WorkspaceUsage(runtime.clone()))
                    as Arc<dyn rho_environment::EnvironmentUsage>
            })
        };
        let mut workspace_owner = None;
        if let Some(owner) = &instance_owner {
            instances::register_lifecycle(&mut registry, owner.clone())?;
            instance_router::register(&mut registry, owner.clone(), &owner.prototype()?)?;
        }
        if let Some(runtime) = runtime {
            let workspace = Arc::new(WorkspaceRunHandler::with_lane(runtime, lane.clone()));
            workspace_owner = Some(workspace.clone());
            registry.register(workspace.clone())?;
            for check in [false, true] {
                registry.register_query(Arc::new(rho_workspace::ConsoleQueryHandler::new(
                    workspace.clone(),
                    check,
                )))?;
            }
            for pause in [false, true] {
                registry.register(Arc::new(rho_workspace::QueueControlHandler::new(
                    workspace.clone(),
                    pause,
                )))?;
            }
            for kind in [
                rho_workspace::OutputQueryKind::Events,
                rho_workspace::OutputQueryKind::Read,
                rho_workspace::OutputQueryKind::Status,
            ] {
                if outputs.is_some() && !matches!(kind, rho_workspace::OutputQueryKind::Status) {
                    continue;
                }
                registry.register_query(Arc::new(rho_workspace::WorkspaceOutputHandler::new(
                    workspace.clone(),
                    records.clone(),
                    kind,
                )))?;
            }
            for kind in [
                WorkspaceToolKind::Help,
                WorkspaceToolKind::Lint,
                WorkspaceToolKind::Format,
            ] {
                registry.register(Arc::new(WorkspaceToolHandler::new(workspace.clone(), kind)))?;
            }
            registry.register_query(Arc::new(WorkspaceQueryHandler::new(
                workspace.clone(),
                WorkspaceQueryKind::Snapshot,
            )))?;
            registry.register_query(Arc::new(WorkspaceQueryHandler::new(
                workspace.clone(),
                WorkspaceQueryKind::Packages,
            )))?;
            registry.register_query(Arc::new(WorkspaceQueryHandler::new(
                workspace.clone(),
                WorkspaceQueryKind::InspectObject,
            )))?;
            for kind in [
                WorkspaceQueryKind::ListObjects,
                WorkspaceQueryKind::ObserveObject,
                WorkspaceQueryKind::ReadObject,
                WorkspaceQueryKind::PackageIndex,
                WorkspaceQueryKind::ReadHelp,
            ] {
                registry.register_query(Arc::new(WorkspaceQueryHandler::new(
                    workspace.clone(),
                    kind,
                )))?;
            }
        }
        let output_owner = outputs
            .map(|outputs| {
                observer::register_output_queries(
                    &mut registry,
                    workspace_owner.clone(),
                    outputs,
                    output_project.clone(),
                    records.clone(),
                )
            })
            .transpose()?;
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
            let owner = observer::register_project_queries(&mut registry, project, lane.clone())?;
            registry.register(Arc::new(ProjectPatchHandler::new(owner)))?;
        }
        if let Some(environment) = environment {
            let mut owner =
                EnvironmentOwner::new(environment, records, lane, active_library, has_workspace)
                    .with_usage(usage);
            if let Some(instances) = &instance_owner {
                let instances = instances.clone();
                owner = owner
                    .with_active_library_resolver(Arc::new(move || instances.active_library()));
            }
            let owner = Arc::new(owner);
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
        let test_projects = if disable_test_projects { None } else {
            plugin_store.as_ref().zip(output_project.clone())
                .map(|(store, project)| plugin_tests::TestProjects::open(store, project)).transpose()?
        };
        if let Some(owner) = &test_projects { owner.register(&mut registry)?; }
        let plugins = plugin_store.zip(output_project.clone())
            .map(|(store, project)| rho_plugins::PluginService::open(&store, project, skill_exclusions, journal.clone()))
            .transpose()?;
        if let Some(plugins) = &plugins { plugins.register(&mut registry)?; }
        let event_port = observer::register_record_queries(
            &mut registry,
            journal.clone(),
            output_project.clone(),
            has_workspace,
            true,
        )?;
        registry.validate_links()?;
        let registry = Arc::new(registry);
        discovery.bind(&registry);
        let gateway = Arc::new(
            OperationGateway::new(registry.clone(), journal, clock, id_generator)
                .with_project_scope(output_project),
        );
        event_port.bind(&gateway, &registry);
        if let Some(plugins) = &plugins { plugins.bind(&registry, &gateway); }
        if let Some(owner) = &instance_owner {
            let probe = application_owner
                .clone()
                .map(instances::InstanceOwner::window_probe);
            owner.bind(&gateway, probe);
        }
        let recovered_on_open = gateway.recover_incomplete().await?;
        if auto_continue && let Some(owner) = &instance_owner {
            owner.continue_default().await?;
        }
        let tasks = tokio_util::task::TaskTracker::new();
        let runtime = Arc::new(HostRuntime {
            gateway,
            queries: Arc::new(QueryGateway::new(registry.clone())),
            registry,
            workspace: workspace_owner,
            instances: instance_owner,
            application: application_owner,
            annotations: annotation_owner,
            output_owner,
            skills: skill_owner,
            plugins,
            test_projects,
            method_binding_gate: tokio::sync::Mutex::new(()),
            _project_lease: project_lease,
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
    /// Continue the project's default R instance. A deferred open makes files,
    /// drafts and history available without starting R; attaching the default
    /// session is this separate lifecycle action, and a failed continuation leaves
    /// the project usable.
    pub async fn continue_default_instance(&self) -> Result<(), OperationError> {
        match &self.runtime.instances {
            Some(owner) => owner.continue_default().await,
            None => Ok(()),
        }
    }
    /// Used by an already authorized active Agent turn to retain its captured target.
    /// A connection that is only idle must not acquire this hold.
    pub fn hold_runtime_instance(
        &self,
        instance: &str,
        native: &str,
        reference: &str,
        label: &str,
    ) -> Result<RuntimeInstanceHold, OperationError> {
        self.runtime
            .instances
            .as_ref()
            .ok_or_else(|| {
                OperationError::Unavailable("Managed R instances are unavailable".into())
            })?
            .acquire_hold(instance, native, reference, label)
    }

    /// Shared discovery/tool visibility; target-specific authority is checked
    /// again by its owner when a control is admitted.
    pub fn capabilities_for(&self, context: &CallContext) -> Vec<CapabilityDescriptor> {
        port_contracts::visible(self.capabilities(), context)
    }

    pub(crate) fn annotations(&self) -> Option<&Arc<rho_application::AnnotationOwner>> {
        self.runtime.annotations.as_ref()
    }

    fn application_owner(&self) -> Result<&Arc<rho_application::ApplicationOwner>, OperationError> {
        self.runtime.application.as_ref().ok_or_else(|| {
            OperationError::Unavailable("No project Application owner is composed".into())
        })
    }

    pub async fn verified_output(
        &self,
        context: &CallContext,
        reference: &rho_contract::MediaReference,
    ) -> Result<Arc<[u8]>, OperationError> {
        self.runtime
            .output_owner
            .as_ref()
            .ok_or_else(|| OperationError::Unavailable("Output owner is unavailable".into()))?
            .verified_original_for(context, reference)
            .await
    }

    async fn application_execute(
        &self,
        context: &CallContext,
        request: rho_contract::ApplicationExecuteRequest,
    ) -> Result<rho_contract::ApplicationExecuteReply, OperationError> {
        let runtime = self.runtime.clone();
        let context = context.clone();
        // Own admission, scientific execution and receipt persistence independently
        // of the browser wait. There is no automatic submission of a later step.
        self.tasks.spawn(async move {
            let owner=runtime.application.as_ref().ok_or_else(||OperationError::Unavailable("Application owner unavailable".into()))?;
            let admission=owner.begin_execution(&context,&request,application::now()?).map_err(application::error)?;
            let result=match admission {
                rho_application::ApplicationExecutionAdmission::VerifySaved{context:original,path,sha256}=>{
                    let observation=runtime.queries.query(&original,QueryRequest{capability:rho_contract::CapabilityRef::new("project.read_text",1)?,arguments:json!({"path":path,"expected_sha256":sha256,"limit_lines":1})}).await;
                    let verification=observation.and_then(|snapshot|{
                        let page:rho_contract::TextPage=serde_json::from_value(snapshot.data.ok_or_else(||OperationError::Unavailable(snapshot.notices.join("; ")))?).map_err(|e|OperationError::Contract(e.to_string()))?;
                        let file=page.file.ok_or_else(||OperationError::Unavailable("Captured file could not be read by Project owner".into()))?;
                        if file.path!=path || file.sha256!=sha256 || file.byte_size!=0 || page.skipped.is_some(){return Err(OperationError::ContentChanged("Captured empty file no longer matches the Project observation".into()));}
                        Ok(rho_contract::ApplicationSaveVerification{path:file.path,sha256:file.sha256,source:snapshot.source,observed_at_ms:snapshot.observed_at_ms.max(0) as u64})
                    });
                    let receipt=match verification{
                        Ok(verification)=>owner.record_saved_verification(&context,&request,&verification,application::now()?).map_err(application::error)?,
                        Err(error)=>owner.record_saved_verification_failure(&context,&request,&error.to_string(),application::now()?).map_err(application::error)?,
                    };
                    return Ok(rho_contract::ApplicationExecuteReply{receipt,operation:None});
                },
                rho_application::ApplicationExecutionAdmission::Invoke{context:original,invocation}=>runtime.gateway.invoke(&original,invocation).await.map(Some),
                rho_application::ApplicationExecutionAdmission::Observe{lookup}=>{
                    if let Some(id)=lookup.operation_id {runtime.gateway.owner_record(&lookup.context,&id).await}else{runtime.gateway.owner_request_record(&lookup.context,&lookup.client_request_id).await}
                }
            };
            match result {
                Ok(Some(record))=>{
                    let receipt=owner.record_execution(&context,&request,&record,application::now()?).map_err(application::error)?;
                    Ok(rho_contract::ApplicationExecuteReply{receipt,operation:Some(record)})
                },
                Ok(None)=>{
                    let receipt=owner.command_status(&context,rho_contract::ApplicationCommandStatusArguments{window:request.session.window,request_id:request.request_id},application::now()?).map_err(application::error)?;
                    Ok(rho_contract::ApplicationExecuteReply{receipt,operation:None})
                },
                Err(error)=>{
                    let receipt=owner.record_execution_error(&context,&request,error.to_string(),application::now()?).map_err(application::error)?;
                    Ok(rho_contract::ApplicationExecuteReply{receipt,operation:None})
                }
            }
        }).await.map_err(|e|OperationError::Storage(format!("application execution observation interrupted: {e}")))?
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
        // the result commit or release the runtime lane while R is still working.
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
        // Keep the Workspace lane until the read has finished, even if an edge disconnects.
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
        if let Some(instances) = &self.runtime.instances {
            instances.seal_stopped_sessions().await?;
        } else if self.runtime.workspace.is_some() {
            return Err(OperationError::Unavailable(
                "This Host does not expose individually stoppable R sessions".into(),
            ));
        }
        Ok(())
    }

    /// The caller must first stop accepting new work through every edge.
    pub async fn drain(&self) {
        if let Some(instances) = &self.runtime.instances {
            instances.begin_shutdown();
        }
        if let Some(workspace) = &self.runtime.workspace {
            workspace.begin_shutdown();
        }
        self.tasks.close();
        self.tasks.wait().await;
        if let Some(owner) = &self.runtime.test_projects { Box::pin(owner.drain()).await; }
        if let Some(plugins) = &self.runtime.plugins { plugins.drain().await; }
        // Accepted work has drained. The native adapter has no drop teardown, so an
        // exiting Host must end the R processes it started rather than orphan them.
        if let Some(instances) = &self.runtime.instances {
            instances.shutdown_instances().await;
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

fn protected_project_paths(database: &Path) -> Result<Vec<std::path::PathBuf>, OperationError> {
    // The application store follows the configured database name, which may be
    // a symlink alias. Protect that sibling before canonicalizing the journal.
    let configured_application = database.with_extension("studio.sqlite");
    let parent = configured_application
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let application = parent
        .canonicalize()
        .map_err(|e| OperationError::Storage(e.to_string()))?
        .join(configured_application.file_name().ok_or_else(|| {
            OperationError::Storage("application state path has no filename".into())
        })?);
    let database = database
        .canonicalize()
        .map_err(|e| OperationError::Storage(e.to_string()))?;
    let preferences = application
        .parent()
        .unwrap_or(Path::new("."))
        .join("runtime-preferences.sqlite");
    let plugins = application.parent().unwrap_or(Path::new(".")).join("plugins-v1");
    let mut excluded = vec![database.clone(), application.clone(), preferences.clone(), plugins];
    for store in [application, preferences] {
        for suffix in ["-journal", "-wal", "-shm"] {
            let mut path = store.as_os_str().to_os_string();
            path.push(suffix);
            excluded.push(path.into());
        }
    }
    for suffix in [".host.lock", "-journal", "-wal", "-shm"] {
        let mut path = database.as_os_str().to_os_string();
        path.push(suffix);
        excluded.push(path.into());
    }
    Ok(excluded)
}
