#![forbid(unsafe_code)]

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use rho_next_contract::{
    CallContext, CallerIdentity, CallerKind, CapabilityDescriptor, EffectObservation, Invocation,
    ObservationCompleteness, Operation, OperationEventRecord, OperationId, OperationRecord,
    OutboxRecord, QueryRequest, QuerySnapshot,
};
use rho_next_operation::{
    CancellationRequestOutcome, CapabilityRegistry, Clock, OperationError, OperationGateway,
    OperationIdGenerator, OperationJournal, QueryGateway, StoredDomainFact, SystemClock,
    UuidOperationIdGenerator,
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
        // Acquire the journal's host lock before creating any external runtime.
        let journal = Arc::new(SqliteOperationJournal::open(database)?);
        let runtime = Arc::new(
            ArkRuntime::launch(config)
                .await
                .map_err(OperationError::TargetResolution)?,
        );
        Self::with_components(
            journal,
            runtime,
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
        let mut registry = CapabilityRegistry::new();
        let workspace = Arc::new(WorkspaceRunHandler::new(runtime));
        registry.register(workspace.clone())?;
        registry.register_query(Arc::new(WorkspaceQueryHandler::new(
            workspace.clone(),
            WorkspaceQueryKind::Snapshot,
        )))?;
        registry.register_query(Arc::new(WorkspaceQueryHandler::new(
            workspace,
            WorkspaceQueryKind::InspectObject,
        )))?;
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
