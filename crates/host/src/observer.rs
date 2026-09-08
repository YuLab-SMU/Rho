//! Query-only Host composition. Uses the same owners and gateways without opening
//! a writer, creating a journal, recovering operations, or starting native runtimes.
use super::*;

/// A standalone observer has no invoke/control API and owns no scientific lease.
pub struct QueryObserver {
    pub(crate) registry: Arc<CapabilityRegistry>,
    queries: QueryGateway,
    // Existing event queries delegate to this read-only gateway. There is no
    // placeholder journal when the configured database does not exist.
    pub(crate) gateway: Option<Arc<OperationGateway>>,
}
impl QueryObserver {
    pub fn open(database: &Path, project: Option<&Path>) -> Result<Self, OperationError> {
        let database = std::path::absolute(database)
            .map_err(|error| OperationError::Storage(error.to_string()))?;
        let journal: Option<Arc<dyn OperationJournal>> = match std::fs::symlink_metadata(&database)
        {
            Ok(_) => Some(Arc::new(SqliteOperationJournal::open_read_only(&database)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(OperationError::Storage(error.to_string())),
        };
        let project = project
            .map(|root| {
                let mut excluded = skills::protected_path_candidates(&database);
                let root = root
                    .canonicalize()
                    .map_err(|error| OperationError::TargetResolution(error.to_string()))?;
                excluded.push(root.join(".rho/next-host.lock"));
                excluded.push(database.parent().unwrap_or(Path::new(".")).join("runtime"));
                excluded.push(
                    database
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join("environment"),
                );
                GitProject::open(root, excluded)
                    .map(|project| Arc::new(project) as Arc<dyn ProjectRuntime>)
                    .map_err(OperationError::TargetResolution)
            })
            .transpose()?;
        let outputs = if journal.is_some() {
            project
                .as_ref()
                .map(|project| {
                    rho_r_runtime::OutputStore::open_read_only(
                        &database.parent().unwrap_or(Path::new(".")).join("runtime"),
                        project.root(),
                    )
                    .map_err(OperationError::Storage)
                })
                .transpose()?
                .flatten()
                .map(|store| Arc::new(store) as Arc<dyn rho_workspace::WorkspaceOutputs>)
        } else {
            None
        };
        Self::from_sources(journal, project, outputs)
    }
    pub(crate) fn from_sources(
        journal: Option<Arc<dyn OperationJournal>>,
        project: Option<Arc<dyn ProjectRuntime>>,
        outputs: Option<Arc<dyn rho_workspace::WorkspaceOutputs>>,
    ) -> Result<Self, OperationError> {
        let project_scope = project.as_ref().map(|p| p.root().to_owned());
        let targets = project_scope
            .as_ref()
            .map(|root| {
                vec![rho_contract::TargetRef {
                    kind: "project".into(),
                    identity: root.clone(),
                }]
            })
            .unwrap_or_default();
        let discovery = discovery::DiscoveryOwner::new(project_scope.clone(), targets, None);
        let mut registry = CapabilityRegistry::new();
        for id in ["host.overview", "host.catalog", "host.describe"] {
            registry.register_query(Arc::new(discovery::DiscoveryHandler::new(
                discovery.clone(),
                id,
            )))?;
        }
        if let Some(project) = project {
            register_project_queries(
                &mut registry,
                project,
                Arc::new(tokio::sync::Mutex::new(())),
            )?;
        }
        if let (Some(outputs), Some(journal)) = (outputs, &journal) {
            register_output_queries(
                &mut registry,
                None,
                outputs,
                project_scope.clone(),
                Arc::new(JournalRecords(journal.clone())),
            )?;
        }
        let events = if let Some(journal) = &journal {
            Some(register_record_queries(
                &mut registry,
                journal.clone(),
                project_scope.clone(),
                false,
            )?)
        } else {
            None
        };
        registry.validate_links()?;
        let registry = Arc::new(registry);
        discovery.bind(&registry);
        let gateway = journal.map(|journal| {
            Arc::new(
                OperationGateway::new(
                    registry.clone(),
                    journal,
                    Arc::new(SystemClock),
                    Arc::new(UuidOperationIdGenerator),
                )
                .with_project_scope(project_scope),
            )
        });
        if let (Some(events), Some(gateway)) = (events, &gateway) {
            events.bind(gateway);
        }
        Ok(Self {
            queries: QueryGateway::new(registry.clone()),
            registry,
            gateway,
        })
    }
    pub fn capabilities(&self) -> Vec<CapabilityDescriptor> {
        self.registry.descriptors()
    }
    pub async fn query_snapshot(
        &self,
        context: &CallContext,
        request: QueryRequest,
    ) -> Result<QuerySnapshot, OperationError> {
        context.validate()?;
        request.validate()?;
        if self.registry.descriptor(&request.capability).is_none() {
            return Err(OperationError::Unavailable(format!(
                "{} is unavailable in this standalone query-only Host. It does not start R, recover work or attach live application state. Use the existing Host session/MCP for native or live-owner queries; use host.catalog for this observer's available reads.",
                request.capability.display_key()
            )));
        }
        self.queries.query(context, request).await
    }
}

/// The same project query handlers are registered by active Hosts and observers.
pub(crate) fn register_project_queries(
    registry: &mut CapabilityRegistry,
    project: Arc<dyn ProjectRuntime>,
    lane: Arc<tokio::sync::Mutex<()>>,
) -> Result<Arc<ProjectOwner>, OperationError> {
    let owner = Arc::new(ProjectOwner::new(project, lane));
    registry.register_query(Arc::new(ProjectSnapshotHandler::new(owner.clone())))?;
    registry.register_query(Arc::new(rho_project::ProjectDirectoryHandler::new(
        owner.clone(),
    )))?;
    registry.register_query(Arc::new(rho_project::ProjectSearchHandler::new(
        owner.clone(),
    )))?;
    registry.register_query(Arc::new(rho_project::ProjectReadTextHandler::new(
        owner.clone(),
    )))?;
    registry.register_query(Arc::new(rho_project::ProjectSearchTextHandler::new(
        owner.clone(),
    )))?;
    registry.register_query(Arc::new(ProjectReadHandler::new(owner.clone())))?;
    Ok(owner)
}
/// The same journal-backed record/evidence/event queries are used in both modes.
pub(crate) fn register_record_queries(
    registry: &mut CapabilityRegistry,
    journal: Arc<dyn OperationJournal>,
    project: Option<String>,
    has_workspace: bool,
) -> Result<Arc<port_contracts::EventsHandler>, OperationError> {
    if let Some(project) = &project {
        registry.register_query(Arc::new(
            rho_operation::OperationEventsCheckpointHandler::new(journal.clone(), project.clone()),
        ))?;
        registry.register_query(Arc::new(rho_operation::RecentOperationsHandler::new(
            journal.clone(),
            project.clone(),
        )))?;
    }
    registry.register_query(Arc::new(rho_operation::OperationEvidenceHandler::new(
        journal.clone(),
        project.clone(),
    )))?;
    registry.register_query(Arc::new(rho_operation::OperationGetHandler::new(
        journal,
        project.clone(),
        &registry.descriptors(),
    )?))?;
    port_contracts::register(registry, project, has_workspace)
}

/// All historical media/text reads stay with the existing Output owner and journal visibility port.
pub(crate) fn register_output_queries(
    registry: &mut CapabilityRegistry,
    workspace: Option<Arc<WorkspaceRunHandler>>,
    outputs: Arc<dyn rho_workspace::WorkspaceOutputs>,
    project: Option<String>,
    records: Arc<JournalRecords>,
) -> Result<Arc<rho_workspace::WorkspaceOutputHandler>, OperationError> {
    let owner = Arc::new(rho_workspace::WorkspaceOutputHandler::with_store(
        workspace.clone(),
        Some(outputs.clone()),
        project.clone(),
        records.clone(),
        rho_workspace::OutputQueryKind::Read,
    ));
    for kind in [
        rho_workspace::OutputQueryKind::Events,
        rho_workspace::OutputQueryKind::Read,
        rho_workspace::OutputQueryKind::List,
        rho_workspace::OutputQueryKind::View,
        rho_workspace::OutputQueryKind::ReadText,
    ] {
        registry.register_query(Arc::new(rho_workspace::WorkspaceOutputHandler::with_store(
            workspace.clone(),
            Some(outputs.clone()),
            project.clone(),
            records.clone(),
            kind,
        )))?;
    }
    Ok(owner)
}
