//! Native lifetime for independent plugin development projects. This composes
//! the same generic Host and calls its ordinary ports; it interprets no science.
use crate::NextHost;
use async_trait::async_trait;
use rho_contract as h;
use rho_operation::*;
use rho_plugin_protocol as p;
use rho_plugins::{PluginError, PluginRepository, plugin_principal_id, plugin_project_id};
use schemars::schema_for;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

const CREATE: &str = "plugins.test_create";
const STOP: &str = "plugins.test_stop";
const GET: &str = "plugins.test_project";
const LIST: &str = "plugins.test_projects";
const ORIGINAL: &str = "plugins.test_operation";
const MAX_LIVE: usize = 4;

struct Live {
    host: Arc<NextHost>,
    context: h::CallContext,
    closing: AtomicBool,
}
pub(crate) struct TestProjects {
    repository: Arc<Mutex<PluginRepository>>,
    scope: String,
    project: p::ProjectId,
    live: Mutex<BTreeMap<p::TestProjectId, Arc<Live>>>,
    // Current-process proof that no child backend was started, including an
    // interrupted directory/import attempt. Historical records provide no proof.
    unstarted: Mutex<BTreeMap<p::TestProjectId, h::CallContext>>,
    gate: tokio::sync::Mutex<()>,
}
impl TestProjects {
    pub(crate) fn open(store: &Path, scope: String) -> Result<Arc<Self>, OperationError> {
        Ok(Arc::new(Self {
            repository: Arc::new(Mutex::new(PluginRepository::open(store).map_err(fault)?)),
            project: plugin_project_id(&scope),
            scope,
            live: Mutex::new(BTreeMap::new()),
            unstarted: Mutex::new(BTreeMap::new()),
            gate: tokio::sync::Mutex::new(()),
        }))
    }
    pub(crate) fn register(
        self: &Arc<Self>,
        registry: &mut CapabilityRegistry,
    ) -> Result<(), OperationError> {
        for id in [GET, LIST, ORIGINAL] {
            registry.register_query(Arc::new(Read {
                owner: self.clone(),
                id,
                descriptor: descriptor(id),
            }))?;
        }
        for id in [CREATE, STOP] {
            registry.register(Arc::new(Manage {
                owner: self.clone(),
                id,
                descriptor: descriptor(id),
                bound: None,
            }))?;
        }
        Ok(())
    }
    fn record(
        &self,
        context: &h::CallContext,
        id: &p::TestProjectId,
    ) -> Result<p::PluginTestProject, OperationError> {
        self.repository
            .lock()
            .unwrap()
            .recorded_test_project(&self.project, &plugin_principal_id(context.principal()), id)
            .map_err(fault)
    }
    fn observation(&self, record: p::PluginTestProject) -> p::PluginTestProjectObservation {
        let observed = self.live.lock().unwrap().contains_key(&record.id);
        p::PluginTestProjectObservation {
            project: record,
            observed_in_this_host: observed,
        }
    }
    fn save(&self, record: &mut p::PluginTestProject) -> Result<(), OperationError> {
        let previous = record.version;
        record.version = previous
            .checked_add(1)
            .ok_or_else(|| invalid("test project version exhausted"))?;
        if let Err(error) = self
            .repository
            .lock()
            .unwrap()
            .record_test_project(previous, record)
        {
            record.version = previous;
            return Err(fault(error));
        }
        Ok(())
    }
    /// Native transport selection, not a new scientific dispatcher. The caller
    /// must keep this handle through the existing Host request. Stop refuses a
    /// borrowed Host and cannot race a newly admitted query or operation.
    pub(crate) fn host(
        &self,
        context: &h::CallContext,
        id: &p::TestProjectId,
    ) -> Result<Arc<NextHost>, OperationError> {
        authorize(context, &["plugins.read", "plugins.run"])?;
        let record = self.record(context, id)?;
        if !matches!(
            record.state,
            p::PluginTestProjectState::Ready | p::PluginTestProjectState::Failed
        ) {
            return Err(OperationError::Unavailable("Test project is not ready to receive calls; inspect its original lifecycle operation".into()));
        }
        let live = self.live.lock().unwrap();
        let entry = live.get(id).ok_or_else(|| {
            OperationError::Unavailable(
                "The original test Host is unavailable; it has not been restarted".into(),
            )
        })?;
        if entry.closing.load(Ordering::Acquire) {
            return Err(OperationError::Unavailable(
                "Test project stopped receiving new calls".into(),
            ));
        }
        Ok(entry.host.clone())
    }
    pub(crate) fn is_idle(&self) -> bool {
        self.live
            .lock()
            .unwrap()
            .values()
            .all(|entry| entry.host.is_idle() && Arc::strong_count(&entry.host) == 1)
    }
    async fn start(
        &self,
        context: &h::CallContext,
        record: &mut p::PluginTestProject,
        archives: &[Arc<p::PluginArchive>],
        order: &[p::InstanceAlias],
    ) -> Result<(), OperationError> {
        self.unstarted
            .lock()
            .unwrap()
            .insert(record.id.clone(), context.clone());
        if self.live.lock().unwrap().len() >= MAX_LIVE {
            return Err(OperationError::BudgetExceeded(
                "At most four test projects may be live in one Host; stop an existing test first"
                    .into(),
            ));
        }
        let directory = PathBuf::from(&record.directory);
        let storage_root = self.repository.lock().unwrap().root().to_owned();
        let material = record.clone();
        let material_archives = archives.to_vec();
        let database = tokio::task::spawn_blocking(move || {
            prepare_directory(&storage_root, &material, &material_archives)
        })
        .await
        .map_err(invalid)??;
        let child = Arc::new(NextHost::open_plugin_test_workspace(&database, &directory).await?);
        let mut child_context = context.clone();
        child_context.causation_id =
            Some(h::OperationId::new(record.source_operation_id.as_str())?);
        self.live.lock().unwrap().insert(
            record.id.clone(),
            Arc::new(Live {
                host: child.clone(),
                context: child_context.clone(),
                closing: AtomicBool::new(false),
            }),
        );
        self.unstarted.lock().unwrap().remove(&record.id);
        for alias in order {
            let selected = &record.selection.instances[alias];
            let target = archives
                .iter()
                .find(|archive| archive.revision.id == selected.revision)
                .unwrap()
                .artifacts
                .iter()
                .find(|artifact| artifact.id == selected.artifact)
                .unwrap()
                .target
                .clone();
            let result=child.invoke(&child_context,h::Invocation {
                client_request_id:format!("test-activate-{}",rho_plugins::content_digest(format!("{}:{alias}",record.id).as_bytes())),capability:h::CapabilityRef::new("plugins.activate",1)?,
                arguments:json!({"revision":selected.revision,"artifact":selected.artifact,"target":target,"alias":alias,"configuration":selected.configuration,"optional_capabilities":selected.optional_capabilities}),preconditions:vec![]
            }).await?;
            record.activation_operations.insert(
                alias.clone(),
                p::OperationId::new(result.operation.operation_id.as_str()).map_err(invalid)?,
            );
            self.save(record)?;
            if result.status != h::OperationStatus::Succeeded {
                return Err(OperationError::Unavailable(result.error.unwrap_or_else(
                    || format!("Original test activation is {:?}", result.status),
                )));
            }
            let observed: p::PluginInstanceObservation = decode(
                &result
                    .output
                    .ok_or_else(|| invalid("test activation has no result"))?,
            )?;
            if observed.instance.project != record.project
                || observed.instance.principal != record.principal
                || observed.instance.alias != *alias
                || !observed.observed_in_this_host
                || observed.instance.state != p::InstanceState::Active
            {
                return Err(invalid(
                    "test activation returned another or unavailable native instance",
                ));
            }
            record
                .instances
                .insert(alias.clone(), observed.instance.identity);
            self.save(record)?;
        }
        record.state = p::PluginTestProjectState::Ready;
        record.diagnostic = None;
        self.save(record)
    }
    async fn stop(
        &self,
        context: &h::CallContext,
        args: &p::StopPluginTestProject,
        operation: &h::OperationId,
    ) -> Result<(p::PluginTestProject, Vec<Value>), HandlerError> {
        let before = |e: OperationError| HandlerError::before_effect(e.to_string());
        let after = |e: OperationError, releases: &[Value]| {
            HandlerError::after_possible_effect(
                e.to_string(),
                Some(
                    json!({"kind":"plugin_test_project","test_project":args.id,"source_operation_id":operation,"releases":releases,"automatic_reexecution":false}),
                ),
            )
        };
        let mut record = self.record(context, &args.id).map_err(before)?;
        if record.version != args.expected_version {
            return Err(before(OperationError::ContentChanged(
                "Test project changed; inspect its current state".into(),
            )));
        }
        if record.state == p::PluginTestProjectState::Stopped {
            return Ok((record, vec![]));
        }
        let (entry, already_closing) = {
            let live = self.live.lock().unwrap();
            if let Some(entry) = live.get(&args.id) {
                if !entry.host.is_idle() || Arc::strong_count(&entry.host) != 1 {
                    return Err(before(OperationError::Unavailable("Test work or a test connection remains; finish or inspect its original operations before stopping".into())));
                }
                if entry
                    .host
                    .runtime
                    .plugins
                    .as_ref()
                    .is_some_and(|plugins| plugins.has_live_views())
                {
                    return Err(before(OperationError::Unavailable("Close the test project's views through their ordinary state-saving flow before stopping".into())));
                }
                let already_closing = entry.closing.swap(true, Ordering::AcqRel);
                (Some(entry.clone()), already_closing)
            } else if self.unstarted.lock().unwrap().contains_key(&args.id) {
                (None, false)
            } else {
                return Err(before(OperationError::Unavailable(
                    "Original test Host is unavailable; native cleanup is unconfirmed".into(),
                )));
            }
        };
        record.state = p::PluginTestProjectState::Stopping;
        record.diagnostic = None;
        if let Err(error) = self.save(&mut record) {
            if let Some(entry) = &entry {
                entry.closing.store(already_closing, Ordering::Release);
            }
            return Err(before(error));
        }
        let mut releases = vec![];
        if let Some(entry) = entry {
            let mut release_context = context.clone();
            release_context.causation_id = Some(operation.clone());
            let (attempts, outcome) =
                release_instances(&entry.host, &release_context, operation.as_str()).await;
            releases = attempts;
            if let Err(error) = outcome {
                record.state = p::PluginTestProjectState::Failed;
                record.diagnostic = Some(bounded(&error.to_string()));
                // Retain the closure fence and native evidence after partial cleanup.
                self.save(&mut record)
                    .map_err(|error| after(error, &releases))?;
                return Err(after(error, &releases));
            }
            Box::pin(entry.host.drain()).await;
        }
        record.state = p::PluginTestProjectState::Stopped;
        self.save(&mut record)
            .map_err(|error| after(error, &releases))?;
        self.live.lock().unwrap().remove(&record.id);
        self.unstarted.lock().unwrap().remove(&record.id);
        Ok((record, releases))
    }
    /// Hosting teardown is already authorized for this Host's own children.
    /// Retain actual incomplete cleanup as failed metadata, never as stopped.
    pub(crate) async fn drain(&self) {
        let _guard = self.gate.lock().await;
        let entries = self
            .live
            .lock()
            .unwrap()
            .iter()
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        for (id, entry) in entries {
            entry.closing.store(true, Ordering::Release);
            Box::pin(entry.host.drain()).await;
            let outcome = instances(&entry.host, &entry.context).await;
            let Ok(mut record) = self.record(&entry.context, &id) else {
                continue;
            };
            let confirmed = outcome.as_ref().is_ok_and(|items| {
                items
                    .iter()
                    .all(|item| item.instance.state == p::InstanceState::Released)
            });
            record.state = p::PluginTestProjectState::Stopping;
            if self.save(&mut record).is_err() {
                continue;
            }
            record.state = if confirmed {
                p::PluginTestProjectState::Stopped
            } else {
                p::PluginTestProjectState::Failed
            };
            record.diagnostic =
                (!confirmed).then(|| {
                    bounded(&outcome.err().map(|e| e.to_string()).unwrap_or_else(|| {
                        "Native test instance cleanup remains unconfirmed".into()
                    }))
                });
            match self.save(&mut record) {
                Ok(()) if confirmed => {
                    self.live.lock().unwrap().remove(&id);
                }
                Ok(()) => {}
                Err(error) => eprintln!("test project shutdown metadata: {error}"),
            }
        }
        let unstarted = self.unstarted.lock().unwrap().clone();
        for (id, context) in unstarted {
            let Ok(mut record) = self.record(&context, &id) else {
                continue;
            };
            record.state = p::PluginTestProjectState::Stopping;
            if self.save(&mut record).is_err() {
                continue;
            }
            record.state = p::PluginTestProjectState::Stopped;
            if self.save(&mut record).is_ok() {
                self.unstarted.lock().unwrap().remove(&id);
            }
        }
    }
}

async fn instances(
    host: &NextHost,
    context: &h::CallContext,
) -> Result<Vec<p::PluginInstanceObservation>, OperationError> {
    let mut after = None;
    let mut result = vec![];
    loop {
        let snapshot = host
            .query_snapshot(
                context,
                h::QueryRequest {
                    capability: h::CapabilityRef::new("plugins.instances", 1)?,
                    arguments: json!({"after":after,"limit":100,"include_previews":true}),
                },
            )
            .await?;
        let page: p::PluginInstanceObservations = decode(
            &snapshot
                .data
                .ok_or_else(|| invalid("test instance inventory is unavailable"))?,
        )?;
        result.extend(page.instances);
        if result.len() > rho_plugins::MAX_PLUGIN_INSTANCES {
            return Err(invalid("test instance inventory exceeds its native limit"));
        }
        let Some(next) = page.next else {
            return Ok(result);
        };
        if after.as_ref().is_some_and(|old| &next <= old) {
            return Err(invalid("test instance pagination did not advance"));
        }
        after = Some(next);
    }
}
async fn release_instances(
    host: &NextHost,
    context: &h::CallContext,
    operation: &str,
) -> (Vec<Value>, Result<(), OperationError>) {
    let mut attempts = vec![];
    let outcome = async {
        for observed in instances(host, context).await? {
            if observed.instance.state == p::InstanceState::Released {
                continue;
            }
            let identity = observed.instance.identity;
            let request = format!(
                "test-release-{}",
                rho_plugins::content_digest(
                    format!("{operation}:{}", identity.instance).as_bytes()
                )
            );
            attempts
                .push(json!({"instance":identity,"client_request_id":request,"operation_id":null}));
            let result = host
                .invoke(
                    context,
                    h::Invocation {
                        client_request_id: request,
                        capability: h::CapabilityRef::new("plugins.release", 1)?,
                        arguments: json!({"instance":identity}),
                        preconditions: vec![],
                    },
                )
                .await?;
            attempts.last_mut().unwrap()["operation_id"] = json!(result.operation.operation_id);
            if result.status != h::OperationStatus::Succeeded {
                return Err(OperationError::Unavailable(
                    result
                        .error
                        .unwrap_or_else(|| "Native test release is not confirmed".into()),
                ));
            }
        }
        if !instances(host, context)
            .await?
            .iter()
            .all(|item| item.instance.state == p::InstanceState::Released)
        {
            return Err(OperationError::Unavailable(
                "Test instances remain unreleased".into(),
            ));
        }
        Ok(())
    }
    .await;
    (attempts, outcome)
}
fn prepare_directory(
    storage_root: &Path,
    record: &p::PluginTestProject,
    archives: &[Arc<p::PluginArchive>],
) -> Result<PathBuf, OperationError> {
    let base = storage_root.join("test-projects-v1");
    match fs::create_dir(&base) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(storage(e)),
    }
    real_directory(&base)?;
    let container = base.join(record.id.as_str());
    fs::create_dir(&container).map_err(storage)?;
    real_directory(&container)?;
    let project = container.join("project");
    fs::create_dir(&project).map_err(storage)?;
    real_directory(&project)?;
    if project != Path::new(&record.directory) {
        return Err(invalid("test project directory changed"));
    }
    let data = container.join("data");
    fs::create_dir(&data).map_err(storage)?;
    real_directory(&data)?;
    let database = data.join("operations.sqlite");
    let mut target =
        PluginRepository::open(&rho_plugins::repository_path(&database)).map_err(fault)?;
    for archive in archives {
        target.import(archive).map_err(fault)?;
    }
    Ok(database)
}
fn real_directory(path: &Path) -> Result<(), OperationError> {
    let metadata = fs::symlink_metadata(path).map_err(storage)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || path.canonicalize().map_err(storage)? != path
    {
        return Err(invalid(
            "test project storage must be a contained native directory without symbolic links",
        ));
    }
    Ok(())
}

struct Bound {
    context: h::CallContext,
    id: p::TestProjectId,
    archives: Vec<Arc<p::PluginArchive>>,
    order: Vec<p::InstanceAlias>,
}
struct Manage {
    owner: Arc<TestProjects>,
    id: &'static str,
    descriptor: h::CapabilityDescriptor,
    bound: Option<Bound>,
}
#[async_trait]
impl OperationHandler for Manage {
    fn descriptor(&self) -> &h::CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.scope.clone())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        if self.id == CREATE {
            let value: p::CreatePluginTestProject = decode(value)?;
            value.validate().map_err(invalid)?;
            Ok(json!(value))
        } else {
            Ok(json!(decode::<p::StopPluginTestProject>(value)?))
        }
    }
    fn resolve_target(&self, _: &Value) -> Result<h::TargetRef, OperationError> {
        Ok(h::TargetRef {
            kind: "plugin_test_project".into(),
            identity: self
                .bound
                .as_ref()
                .map(|bound| bound.id.to_string())
                .unwrap_or_else(|| self.owner.scope.clone()),
        })
    }
    fn execution_context(&self) -> Value {
        json!({"test_project":self.bound.as_ref().map(|bound|&bound.id),"automatic_reexecution":false})
    }
    async fn bind(
        &self,
        context: &h::CallContext,
        value: &Value,
        preconditions: &[h::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !preconditions.is_empty() {
            return Err(invalid(
                "test projects use exact selections and lifecycle versions, not unrelated native preconditions",
            ));
        }
        let (id, archives, order) = if self.id == CREATE {
            if self.owner.live.lock().unwrap().len() >= MAX_LIVE {
                return Err(OperationError::BudgetExceeded(
                    "At most four test projects may be live; stop an existing test first".into(),
                ));
            }
            let selection: p::CreatePluginTestProject = decode(value)?;
            let repository = self.owner.repository.clone();
            let scopes = context.scopes.clone();
            let (archives, order) = tokio::task::spawn_blocking(move || {
                let repo = repository.lock().unwrap();
                let order = repo.validate_test_selection(&selection).map_err(fault)?;
                let mut revisions = BTreeSet::new();
                let mut archives = vec![];
                let mut bytes = 0u64;
                for selected in selection.instances.values() {
                    let revision = repo.revision(&selected.revision).map_err(fault)?;
                    for grant in revision
                        .manifest
                        .activation_requirements(&selected.optional_capabilities)
                        .map_err(invalid)?
                    {
                        if !grant.scopes.is_subset(&scopes) {
                            return Err(OperationError::AccessDenied {
                                capability: CREATE.into(),
                                missing: grant.scopes.difference(&scopes).cloned().collect(),
                            });
                        }
                    }
                    if revisions.insert(selected.revision.clone()) {
                        let archive = repo.export(&selected.revision).map_err(fault)?;
                        bytes = bytes.saturating_add(
                            archive
                                .blobs
                                .values()
                                .map(|blob| blob.len() as u64)
                                .sum::<u64>(),
                        );
                        if bytes > p::MAX_PACKAGE_BYTES * 4 / 3 + 4 {
                            return Err(OperationError::BudgetExceeded(
                                "Combined test package source and artifact bytes exceed 256 MiB"
                                    .into(),
                            ));
                        }
                        archives.push(Arc::new(archive));
                    }
                }
                Ok((archives, order))
            })
            .await
            .map_err(invalid)??;
            (
                p::TestProjectId::new(format!("test-{}", uuid::Uuid::new_v4().simple()))
                    .map_err(invalid)?,
                archives,
                order,
            )
        } else {
            let args: p::StopPluginTestProject = decode(value)?;
            let record = self.owner.record(context, &args.id)?;
            if record.version != args.expected_version {
                return Err(OperationError::ContentChanged(
                    "Test project changed; inspect the current lifecycle version".into(),
                ));
            }
            (args.id, vec![], vec![])
        };
        Ok(Some(Arc::new(Self {
            owner: self.owner.clone(),
            id: self.id,
            descriptor: self.descriptor.clone(),
            bound: Some(Bound {
                context: context.clone(),
                id,
                archives,
                order,
            }),
        })))
    }
    fn admitted(&self, operation: &h::Operation) -> Result<(), HandlerError> {
        if self.id != CREATE {
            return Ok(());
        }
        let bound = self
            .bound
            .as_ref()
            .ok_or_else(|| HandlerError::before_effect("test creation was not bound"))?;
        let mut repo = self.owner.repository.lock().unwrap();
        let directory = repo
            .test_project_directory(&bound.id)
            .to_string_lossy()
            .into_owned();
        let record = p::PluginTestProject {
            id: bound.id.clone(),
            source_project: self.owner.project.clone(),
            principal: plugin_principal_id(bound.context.principal()),
            source_operation_id: p::OperationId::new(operation.operation_id.as_str())
                .map_err(|e| HandlerError::before_effect(e.to_string()))?,
            project: plugin_project_id(&directory),
            directory,
            selection: decode(&operation.normalized_arguments)
                .map_err(|e| HandlerError::before_effect(e.to_string()))?,
            version: 0,
            state: p::PluginTestProjectState::Preparing,
            instances: BTreeMap::new(),
            activation_operations: BTreeMap::new(),
            diagnostic: None,
        };
        repo.register_test_project(&record)
            .map_err(|e| HandlerError::before_effect(e.to_string()))
    }
    async fn execute(&self, operation: &h::Operation) -> Result<CommitPlan, HandlerError> {
        let bound = self
            .bound
            .as_ref()
            .ok_or_else(|| HandlerError::before_effect("test project was not bound"))?;
        let _guard = self.owner.gate.lock().await;
        if self.id == STOP {
            let args: p::StopPluginTestProject = decode(&operation.normalized_arguments)
                .map_err(|e| HandlerError::before_effect(e.to_string()))?;
            return self
                .owner
                .stop(&bound.context, &args, &operation.operation_id)
                .await
                .map(|(record, releases)| {
                    let mut plan=CommitPlan::succeeded(json!(self.owner.observation(record)));
                    if !releases.is_empty() {
                        plan.recovery=Some(json!({"kind":"plugin_test_project","test_project":bound.id,"source_operation_id":operation.operation_id,"releases":releases,"automatic_reexecution":false}));
                    }
                    plan
                });
        }
        let mut record = self
            .owner
            .record(&bound.context, &bound.id)
            .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        let result = self
            .owner
            .start(&bound.context, &mut record, &bound.archives, &bound.order)
            .await;
        if let Err(error) = result {
            // A child may already have committed activation before the parent
            // catalog write fails. Preserve its acknowledged original IDs even
            // when saving the failed lifecycle record also fails.
            let recovery = json!({"kind":"plugin_test_project","test_project":bound.id,"source_operation_id":operation.operation_id,"activation_operations":record.activation_operations,"automatic_reexecution":false});
            record.state = p::PluginTestProjectState::Failed;
            record.diagnostic = Some(bounded(&error.to_string()));
            self.owner.save(&mut record).map_err(|e| {
                HandlerError::after_possible_effect(e.to_string(), Some(recovery.clone()))
            })?;
            let mut plan = CommitPlan::succeeded(json!(self.owner.observation(record)));
            plan.outcome = h::OperationOutcome::Failed;
            plan.error = Some(error.to_string());
            plan.recovery = Some(recovery);
            return Ok(plan);
        }
        Ok(CommitPlan::succeeded(json!(self.owner.observation(record))))
    }
}
struct Read {
    owner: Arc<TestProjects>,
    id: &'static str,
    descriptor: h::CapabilityDescriptor,
}
#[async_trait]
impl QueryHandler for Read {
    fn descriptor(&self) -> &h::CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        match self.id {
            GET => Ok(json!(decode::<p::PluginTestProjectArguments>(value)?)),
            ORIGINAL => Ok(json!(decode::<p::PluginTestOperationArguments>(value)?)),
            _ => Ok(json!(decode::<p::ListPluginTestProjects>(value)?)),
        }
    }
    async fn query(&self, _: &Value) -> Result<h::QuerySnapshot, OperationError> {
        Err(invalid("test project observation requires caller context"))
    }
    async fn query_for(
        &self,
        context: &h::CallContext,
        arguments: &Value,
    ) -> Result<h::QuerySnapshot, OperationError> {
        if self.id == ORIGINAL {
            let args: p::PluginTestOperationArguments = decode(arguments)?;
            let record = self.owner.record(context, &args.id)?;
            let directory = Path::new(&record.directory);
            // Reuse the ordinary Operation query owner with a read-only journal.
            // This works after stop/reopen without constructing or recovering a Host.
            let container = directory
                .parent()
                .ok_or_else(|| invalid("missing test container"))?;
            real_directory(
                container
                    .parent()
                    .ok_or_else(|| invalid("missing test storage"))?,
            )?;
            real_directory(container)?;
            real_directory(directory)?;
            let data = container.join("data");
            real_directory(&data)?;
            let database = data.join("operations.sqlite");
            if database.canonicalize().map_err(storage)? != database {
                return Err(invalid("test journal must not be a symbolic link"));
            }
            let journal = Arc::new(rho_sqlite::SqliteOperationJournal::open_read_only(
                &database,
            )?);
            let handler = Arc::new(OperationGetHandler::new(
                journal,
                Some(record.directory),
                &[],
            )?);
            let mut registry = CapabilityRegistry::new();
            registry.register_query(handler)?;
            return QueryGateway::new(Arc::new(registry))
                .query(
                    context,
                    h::QueryRequest {
                        capability: h::CapabilityRef::new("operation.get", 1)?,
                        arguments: json!({"operation_id":args.operation_id}),
                    },
                )
                .await;
        }
        let data = if self.id == GET {
            let args: p::PluginTestProjectArguments = decode(arguments)?;
            json!(
                self.owner
                    .observation(self.owner.record(context, &args.id)?)
            )
        } else {
            let args: p::ListPluginTestProjects = decode(arguments)?;
            let mut page = self
                .owner
                .repository
                .lock()
                .unwrap()
                .recorded_test_projects(
                    &self.owner.project,
                    &plugin_principal_id(context.principal()),
                    &args,
                )
                .map_err(fault)?;
            let live = self.owner.live.lock().unwrap();
            for item in &mut page.projects {
                item.observed_in_this_host = live.contains_key(&item.project.id);
            }
            json!(page)
        };
        Ok(h::QuerySnapshot {
            target: h::TargetRef {
                kind: "plugin_test_projects".into(),
                identity: self.owner.scope.clone(),
            },
            source: "plugins/test-project-lifecycle".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: h::QueryStatus::Ready,
            completeness: h::ObservationCompleteness::Complete,
            notices: vec![],
            next_reads: vec![],
            diagnostics: vec![],
            data: Some(data),
        })
    }
}
fn descriptor(id: &str) -> h::CapabilityDescriptor {
    let (input, output, summary, operation, example) = match id {
        CREATE => (
            schema_for!(p::CreatePluginTestProject).to_value(),
            schema_for!(p::PluginTestProjectObservation).to_value(),
            "Create a fresh test project for exact plugin instances",
            true,
            json!({"name":"Backend test","instances":{"subject":{"plugin":"example.plugin","revision":format!("sha256:{}","0".repeat(64)),"artifact":format!("sha256:{}","0".repeat(64)),"configuration":{},"dependencies":{}}}}),
        ),
        ORIGINAL => (
            schema_for!(p::PluginTestOperationArguments).to_value(),
            schema_for!(h::OperationGetResult).to_value(),
            "Read an original test operation without restarting its Host",
            false,
            json!({"id":"test-example","operation_id":"operation-example"}),
        ),
        STOP => (
            schema_for!(p::StopPluginTestProject).to_value(),
            schema_for!(p::PluginTestProjectObservation).to_value(),
            "Stop an independent test project after its work finishes",
            true,
            json!({"id":"test-example","expected_version":3}),
        ),
        GET => (
            schema_for!(p::PluginTestProjectArguments).to_value(),
            schema_for!(p::PluginTestProjectObservation).to_value(),
            "Observe one original test project without restarting it",
            false,
            json!({"id":"test-example"}),
        ),
        LIST => (
            schema_for!(p::ListPluginTestProjects).to_value(),
            schema_for!(p::PluginTestProjectPage).to_value(),
            "List scoped retained test project metadata",
            false,
            json!({"after":null,"limit":20}),
        ),
        _ => unreachable!(),
    };
    let mut scopes = BTreeSet::from(["plugins.read".into()]);
    if id == ORIGINAL {
        scopes.insert("operation.read".into());
    }
    if operation {
        scopes.insert("plugins.run".into());
    }
    if id == CREATE {
        scopes.insert("plugins.write".into());
    }
    h::CapabilityDescriptor{kind:if operation{h::CapabilityKind::Operation}else{h::CapabilityKind::Query},capability:h::CapabilityRef::new(id,1).unwrap(),domain:"plugins".into(),input_schema:input,output_schema:output,recovery_schema:json!({"type":["object","null"]}),required_scopes:scopes,potential_effects:if operation{BTreeSet::from([h::EffectHint::MaySpawnProcess,h::EffectHint::MayMutateRuntime])}else{BTreeSet::new()},idempotency:if operation{h::IdempotencyClass::CallerScoped}else{h::IdempotencyClass::Pure},retry:if operation{h::RetryClass::ReconcileFirst}else{h::RetryClass::Safe},cancellation:h::CancellationClass::Unsupported,
        documentation:h::CapabilityDocumentation{summary:summary.into(),purpose:"Manage a separate native project, package catalog and Operation journal for explicit backend development tests through the ordinary Host ports.".into(),when_to_use:vec!["Explicitly test an exact built plugin selection without attaching current analysis instances.".into()],limitations:vec!["At most four live test projects and sixteen selected instances per project. Combined captured archive data is bounded to 256 MiB. No toolchain or package dependency installation.".into(),"Native plugins remain trusted local code, not an OS sandbox. Test directories and original journals remain as recovery evidence after stop. Reopening metadata never restarts a test Host.".into(),"Stop refuses live calls, borrowed connections and unconfirmed instance cleanup. It never cancels accepted work or deletes evidence.".into()],owner:"plugin test project lifecycle and ordinary child Host ports".into(),effects:if operation{"Creates or releases only its managed independent test project; current project instances and routes are unchanged."}else{"Bounded retained metadata observation only."}.into(),retry_rule:"Inspect the original Operation and exact test identity after lost acknowledgement; do not create another test to infer the original result.".into(),cancellation_rule:"This lifecycle operation does not claim cancellation. Finish or explicitly cancel original child work through its existing owner before stopping the test project.".into(),preconditions:vec![],examples:vec![h::CapabilityExample{arguments:example,result_explanation:"Retained state is separate from observed native presence. Stopped requires confirmed instance release.".into()}],related_capabilities:vec![h::CapabilityRef::new(GET,1).unwrap(),h::CapabilityRef::new(LIST,1).unwrap()],related_skills:vec![],position_units:vec![]}}
}
fn authorize(context: &h::CallContext, scopes: &[&str]) -> Result<(), OperationError> {
    context.validate()?;
    let missing = scopes
        .iter()
        .filter(|scope| !context.scopes.contains(**scope))
        .map(|scope| scope.to_string())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(OperationError::AccessDenied {
            capability: "plugin test project".into(),
            missing,
        })
    }
}
fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, OperationError> {
    serde_json::from_value(value.clone()).map_err(invalid)
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
fn storage(error: impl std::fmt::Display) -> OperationError {
    OperationError::Storage(error.to_string())
}
fn fault(error: PluginError) -> OperationError {
    match error {
        PluginError::Conflict => OperationError::ContentChanged("test project changed".into()),
        PluginError::Missing(id) => OperationError::NotFound(id),
        PluginError::Invalid(message) => invalid(message),
        PluginError::Contract(error) => invalid(error),
        other => storage(other),
    }
}
fn bounded(text: &str) -> String {
    let mut end = text.len().min(8192);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}
