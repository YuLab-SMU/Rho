#![forbid(unsafe_code)]

mod environment;
mod records;
pub use environment::REnvironmentConfig;
use environment::selected_environment;
use records::JournalRecords;
use rho_next_environment::{
    ENVIRONMENT_READ_SCOPE, ENVIRONMENT_WRITE_SCOPE, EnvironmentAction, EnvironmentHandler,
    EnvironmentObserveHandler, EnvironmentOwner, EnvironmentRuntime,
};
use rho_next_r_environment::REnvironment;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use rho_next_contract::{
    CallContext, CallerIdentity, CallerKind, CapabilityDescriptor, EffectObservation, Invocation,
    ObservationCompleteness, Operation, OperationEventRecord, OperationId, OperationRecord,
    OutboxRecord, QueryRequest, QuerySnapshot,
};
use rho_next_execution::{RUN_LOCAL_SCOPE, ReconcileProcessHandler, RunLocalHandler};
use rho_next_git::GitProject;
use rho_next_operation::{
    CancellationRequestOutcome, CapabilityRegistry, Clock, OperationError, OperationGateway,
    OperationIdGenerator, OperationJournal, QueryGateway, StoredDomainFact, SystemClock,
    UuidOperationIdGenerator,
};
use rho_next_process::LocalProcessExecutor;
use rho_next_project::{
    PROJECT_READ_SCOPE, PROJECT_WRITE_SCOPE, ProjectOwner, ProjectPatchHandler, ProjectReadHandler,
    ProjectRuntime, ProjectSnapshotHandler,
};
use rho_next_sqlite::SqliteOperationJournal;
use rho_next_workspace::{
    RunRArguments, WORKSPACE_READ_SCOPE, WorkspaceQueryHandler, WorkspaceQueryKind,
    WorkspaceRunHandler, WorkspaceRuntime, WorkspaceRuntimeError, WorkspaceRuntimeReport,
};
use serde_json::json;

pub use rho_next_r_runtime::ArkConfig;
use rho_next_r_runtime::ArkRuntime;
pub use rho_next_workspace::{RUN_R_CAPABILITY_ID, RUN_R_CAPABILITY_VERSION, RUN_R_SCOPE};

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
            outcome: rho_next_contract::OperationOutcome::Succeeded,
            error: None,
        })
    }
}

pub struct NextHost {
    gateway: Arc<OperationGateway>,
    queries: Arc<QueryGateway>,
    recovered_on_open: Vec<OperationRecord>,
}

impl NextHost {
    pub async fn open_project(
        database: impl AsRef<Path>,
        project_root: impl AsRef<Path>,
    ) -> Result<Self, OperationError> {
        let database = database.as_ref();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let project = Arc::new(
            GitProject::open(project_root, protected_project_paths(database)?)
                .map_err(OperationError::TargetResolution)?,
        );
        Self::compose(
            journal,
            None,
            Some(project),
            None,
            None,
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }
    pub async fn dispatch(
        &self,
        context: &CallContext,
        request: rho_next_contract::HostRequest,
    ) -> Result<serde_json::Value, OperationError> {
        use rho_next_contract::HostRequest;
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
        let database = database.as_ref();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let root = config.project_root.clone();
        let data = config.data_root.clone();
        let environment =
            Arc::new(REnvironment::open(config).map_err(OperationError::TargetResolution)?);
        let mut excluded = protected_project_paths(database)?;
        excluded.push(
            data.canonicalize()
                .map_err(|e| OperationError::Storage(e.to_string()))?,
        );
        let project =
            Arc::new(GitProject::open(root, excluded).map_err(OperationError::TargetResolution)?);
        Self::compose(
            journal,
            None,
            Some(project),
            Some(environment),
            None,
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }

    pub async fn open_ark_with_environment(
        database: impl AsRef<Path>,
        mut config: ArkConfig,
        realization_id: Option<&str>,
    ) -> Result<Self, OperationError> {
        // Acquire the journal's host lock before creating any external runtime.
        let database = database.as_ref();
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        std::fs::create_dir_all(&config.data_root)
            .map_err(|error| OperationError::Storage(error.to_string()))?;
        let mut excluded = protected_project_paths(database)?;
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
            Some(runtime),
            Some(project),
            Some(environment),
            active_library,
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
    }
    /// Context for a local, OS-user-owned CLI. Callers cannot put identity in Invocation.
    pub fn local_context() -> CallContext {
        CallContext {
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
            gateway: Arc::new(OperationGateway::new(
                registry.clone(),
                Arc::new(SqliteOperationJournal::open_read_only(database)?),
                Arc::new(SystemClock),
                Arc::new(UuidOperationIdGenerator),
            )),
            queries: Arc::new(QueryGateway::new(registry)),
            recovered_on_open: Vec::new(),
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
            Some(runtime),
            None,
            None,
            None,
            clock,
            id_generator,
        )
        .await
    }

    async fn compose(
        journal: Arc<dyn OperationJournal>,
        runtime: Option<Arc<dyn WorkspaceRuntime>>,
        project: Option<Arc<dyn ProjectRuntime>>,
        environment: Option<Arc<dyn EnvironmentRuntime>>,
        active_library: Option<String>,
        clock: Arc<dyn Clock>,
        id_generator: Arc<dyn OperationIdGenerator>,
    ) -> Result<Self, OperationError> {
        let mut registry = CapabilityRegistry::new();
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let records = Arc::new(JournalRecords(journal.clone()));
        let has_workspace = runtime.is_some();
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
            let owner = Arc::new(EnvironmentOwner::new(
                environment,
                records,
                lane,
                active_library,
                has_workspace,
            ));
            for action in [
                EnvironmentAction::Plan,
                EnvironmentAction::Realize,
                EnvironmentAction::Verify,
                EnvironmentAction::Reconcile,
            ] {
                registry.register(Arc::new(EnvironmentHandler::new(owner.clone(), action)))?;
            }
            registry.register_query(Arc::new(EnvironmentObserveHandler::new(owner)))?;
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
            gateway,
            queries: Arc::new(QueryGateway::new(registry)),
            recovered_on_open,
        })
    }

    pub fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        self.gateway.registry_descriptors()
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
        let gateway = self.gateway.clone();
        let context = context.clone();
        tokio::spawn(async move { gateway.invoke(&context, invocation).await })
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
        let queries = self.queries.clone();
        let context = context.clone();
        // Keep the Workspace lane until the read has finished, even if an edge disconnects.
        tokio::spawn(async move { queries.query(&context, request).await })
            .await
            .map_err(|error| OperationError::Storage(format!("query task failed: {error}")))?
    }

    pub async fn get_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Option<OperationRecord>, OperationError> {
        self.gateway.get_operation(context, operation_id).await
    }

    pub async fn request_cancellation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<CancellationRequestOutcome, OperationError> {
        self.gateway
            .request_cancellation(context, operation_id)
            .await
    }

    pub async fn events(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Vec<OperationEventRecord>, OperationError> {
        self.gateway.events(context, operation_id).await
    }

    pub async fn outbox(
        &self,
        context: &CallContext,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<OutboxRecord>, OperationError> {
        self.gateway.outbox(context, after_sequence, limit).await
    }

    pub async fn facts_for_operation(
        &self,
        context: &CallContext,
        operation_id: &OperationId,
    ) -> Result<Vec<StoredDomainFact>, OperationError> {
        self.gateway
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
