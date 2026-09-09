//! Project Host lifecycle for independent local R instances. The journal and project lease
//! remain with the composing Host; an instance owns only its native runtime and Workspace owners.
use crate::{ApplicationStore, ArkConfig, ArkRuntime, JournalRecords, OperationError, probe_r};
use async_trait::async_trait;
use rho_contract::*;
use rho_operation::*;
use rho_workspace::*;
use schemars::schema_for;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, Weak, atomic::{AtomicU64, Ordering}}, time::Duration};

const POLICY_KEY: &str = "hosting.runtime_policy";

pub(crate) fn validate_id(value: &str) -> Result<(), OperationError> {
    if value.is_empty() || value.len() > 160 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(OperationError::InvalidInput("Instance identifiers must contain 1–160 ASCII letters, digits, hyphens or underscores".into()));
    }
    Ok(())
}
fn invalid(error: impl ToString) -> OperationError { OperationError::InvalidInput(error.to_string()) }
fn stored(error: impl ToString) -> OperationError { OperationError::Storage(error.to_string()) }
fn before(error: impl ToString) -> HandlerError { HandlerError::before_effect(error.to_string()) }
fn now() -> Result<i64, OperationError> { SystemClock.now_ms() }

/// A launch is prepared before ending the previous process. No default installation fallback.
pub struct PreparedInstanceLaunch {
    pub binding: RuntimeLaunchBinding,
    pub installation: RuntimeInstallationIdentity,
    pub library_path: Option<PathBuf>,
}
pub struct LaunchedInstance {
    pub runtime: Arc<dyn WorkspaceRuntime>,
    pub installation: RuntimeInstallationIdentity,
}
#[async_trait]
pub trait InstanceLauncher: Send + Sync {
    async fn prepare(&self, binding: &RuntimeLaunchBinding) -> Result<PreparedInstanceLaunch, OperationError>;
    async fn launch(&self, prepared: PreparedInstanceLaunch) -> Result<LaunchedInstance, OperationError>;
}

pub(crate) struct ArkInstanceLauncher {
    pub project: PathBuf,
    pub data_root: PathBuf,
    pub environment_root: PathBuf,
    pub execution_timeout: Duration,
    pub journal: Arc<dyn OperationJournal>,
}
#[async_trait]
impl InstanceLauncher for ArkInstanceLauncher {
    async fn prepare(&self, binding: &RuntimeLaunchBinding) -> Result<PreparedInstanceLaunch, OperationError> {
        validate_binding(binding)?;
        let probe = probe_r(&RSelection { executable: binding.r_executable.clone(), ark: binding.ark_executable.clone() }).await;
        if !probe.usable { return Err(OperationError::Unavailable(probe.diagnostics.join("\n"))); }
        let r_home = probe.r_home.ok_or_else(|| OperationError::Unavailable("R home was not verified".into()))?;
        let installation = RuntimeInstallationIdentity {
            r_home: r_home.clone(),
            r_version: probe.version.ok_or_else(|| OperationError::Unavailable("R version was not verified".into()))?,
            platform: probe.architecture.ok_or_else(|| OperationError::Unavailable("R architecture was not verified".into()))?,
        };
        let library_path = if let Some(id) = &binding.environment_realization_id {
            let environment = rho_r_environment::REnvironment::open(crate::REnvironmentConfig {
                rscript: Path::new(&r_home).join("bin").join(if cfg!(windows) {"Rscript.exe"} else {"Rscript"}),
                project_root: self.project.clone(), data_root: self.environment_root.clone(), timeout: Duration::from_secs(300),
            }).map_err(OperationError::TargetResolution)?;
            Some(PathBuf::from(crate::environment::selected_environment(self.journal.as_ref(), &environment, id).await?.library_path))
        } else { binding.library_path.as_ref().map(PathBuf::from) };
        Ok(PreparedInstanceLaunch { binding: RuntimeLaunchBinding {
            r_executable: probe.selection.executable, ark_executable: probe.selection.ark,
            environment_realization_id: binding.environment_realization_id.clone(),
            library_path: binding.library_path.clone(),
        }, installation, library_path })
    }
    async fn launch(&self, prepared: PreparedInstanceLaunch) -> Result<LaunchedInstance, OperationError> {
        let runtime = Arc::new(ArkRuntime::launch(ArkConfig {
            executable: PathBuf::from(&prepared.binding.ark_executable),
            r_home: PathBuf::from(&prepared.installation.r_home),
            project_root: self.project.clone(), data_root: self.data_root.clone(),
            execution_timeout: self.execution_timeout, library_path: prepared.library_path,
        }).await.map_err(OperationError::TargetResolution)?);
        // Startup has completed before publication. The native adapter owns the handshake.
        if runtime.runtime_status().state == "unavailable" {
            return Err(OperationError::Unavailable("The R process did not complete startup".into()));
        }
        Ok(LaunchedInstance { runtime, installation: prepared.installation })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredInstance {
    id: String,
    name: String,
    binding: RuntimeLaunchBinding,
    installation: Option<RuntimeInstallationIdentity>,
    lineage: String,
    activity: u64,
    state: RuntimeInstanceState,
    last_error: Option<String>,
    last_operation: Option<String>,
}
struct InstanceSlot {
    stored: StoredInstance,
    persisted: Option<StoredInstance>,
    version: Option<String>,
    live: Option<Arc<InstanceLive>>,
    maintenance: Option<OperationId>,
    query_count: usize,
    holds: BTreeMap<String, RuntimeLifecycleBlocker>,
}
struct AdmittedRequest { instance: String, live: Arc<InstanceLive> }
struct State {
    instances: BTreeMap<String, InstanceSlot>,
    requests: BTreeMap<OperationId, AdmittedRequest>,
    shutdown: bool,
}

pub(crate) struct InstanceLive {
    pub runtime: Arc<dyn WorkspaceRuntime>,
    pub workspace: Arc<WorkspaceRunHandler>,
    pub registry: CapabilityRegistry,
    pub activity: Arc<AtomicU64>,
    pub checkpoint: Arc<WorkspaceCheckpointOwner>,
}

pub(crate) struct InstanceOwner {
    project: String,
    store: Arc<ApplicationStore>,
    app_store: Arc<ApplicationStore>,
    journal: Arc<dyn OperationJournal>,
    launcher: Arc<dyn InstanceLauncher>,
    state: Mutex<State>,
    transition: Arc<tokio::sync::Mutex<()>>,
    gateway: OnceLock<Weak<OperationGateway>>,
}

impl InstanceOwner {
    pub(crate) fn open(project: String, store: Arc<ApplicationStore>, app_store: Arc<ApplicationStore>, journal: Arc<dyn OperationJournal>, launcher: Arc<dyn InstanceLauncher>, initial: Option<RuntimeLaunchBinding>) -> Result<Arc<Self>, OperationError> {
        let mut saved = BTreeMap::new();
        let mut versions = BTreeMap::new();
        let mut after = None;
        loop {
            let page = store.runtime_instances(&format!("project:{project}"), after.as_deref(), 200).map_err(stored)?;
            for row in page.records {
                let item: StoredInstance = serde_json::from_value(row.value).map_err(stored)?;
                if item.id != row.key { return Err(stored("Instance row identity does not match its contents")); }
                versions.insert(row.key.clone(), row.version); saved.insert(row.key, item);
            }
            after = page.next_after_instance_id;
            if after.is_none() { break; }
        }
        if let Some(binding) = initial && !saved.contains_key(MAIN_WORKSPACE_INSTANCE) {
            validate_binding(&binding)?;
            saved.insert(MAIN_WORKSPACE_INSTANCE.into(), StoredInstance {
                id: MAIN_WORKSPACE_INSTANCE.into(), name: "Main".into(), binding, installation: None,
                lineage: format!("lineage_{}", uuid::Uuid::new_v4().simple()), activity: 0,
                state: RuntimeInstanceState::Stopped, last_error: None, last_operation: None,
            });
        }
        let mut instances = BTreeMap::new();
        for (id, mut item) in saved {
            validate_id(&id)?;
            if id != item.id { return Err(stored("Instance identity does not match catalog key")); }
            validate_binding(&item.binding)?;
            let version = versions.remove(&id).flatten();
            let persisted = version.as_ref().map(|_| item.clone());
            if matches!(item.state, RuntimeInstanceState::Starting | RuntimeInstanceState::Stopping) {
                item.state = RuntimeInstanceState::RecoveryRequired;
                item.last_error = Some("The previous lifecycle operation did not confirm completion; inspect its original receipt before continuing".into());
            } else if item.state == RuntimeInstanceState::Ready { item.state = RuntimeInstanceState::Stopped; }
            instances.insert(id, InstanceSlot { stored: item, persisted, version, live: None, maintenance: None, query_count: 0, holds: BTreeMap::new() });
        }
        let owner = Arc::new(Self { project, store, app_store, journal, launcher, state: Mutex::new(State { instances, requests: BTreeMap::new(), shutdown: false }), transition: Arc::new(tokio::sync::Mutex::new(())), gateway: OnceLock::new() });
        owner.persist_locked(&mut owner.state.lock().unwrap_or_else(|e| e.into_inner()))?;
        Ok(owner)
    }
    pub(crate) fn project(&self) -> &str { &self.project }
    fn scope(&self) -> String { format!("project:{}", self.project) }
    fn persist_locked(&self, state: &mut State) -> Result<(), OperationError> {
        for (id, slot) in &mut state.instances {
            if slot.persisted.as_ref() == Some(&slot.stored) { continue; }
            let row = self.store.write_runtime_instance(&self.scope(), &ApplicationState { key: id.clone(), version: slot.version.clone(), value: serde_json::to_value(&slot.stored).map_err(stored)? }).map_err(stored)?;
            slot.version = row.version; slot.persisted = Some(slot.stored.clone());
        }
        Ok(())
    }
    pub(crate) fn bind(&self, gateway: &Arc<OperationGateway>) { let _ = self.gateway.set(Arc::downgrade(gateway)); }
    fn gateway(&self) -> Result<Arc<OperationGateway>, OperationError> { self.gateway.get().and_then(Weak::upgrade).ok_or_else(|| OperationError::Unavailable("Instance gateway is not composed".into())) }

    fn policy_state(&self, scope: RuntimeSettingsScope, instance: Option<&str>) -> Result<ApplicationState, OperationError> {
        match scope {
            RuntimeSettingsScope::App => self.app_store.read("user", POLICY_KEY).map_err(stored),
            RuntimeSettingsScope::Project => self.store.read(&self.scope(), POLICY_KEY).map_err(stored),
            RuntimeSettingsScope::Instance => self.store.read(&self.scope(), &format!("hosting.instance_policy.{}", instance.ok_or_else(|| invalid("Instance settings require workspace_instance_id"))?)).map_err(stored),
        }
    }
    fn decode_policy(state: &ApplicationState) -> Result<RuntimePolicyOverrides, OperationError> { if state.value.is_null() { Ok(RuntimePolicyOverrides::default()) } else { serde_json::from_value(state.value.clone()).map_err(stored) } }
    pub(crate) fn settings(&self, instance: Option<&str>) -> Result<RuntimeSettings, OperationError> {
        if let Some(id) = instance { validate_id(id)?; }
        let app = self.policy_state(RuntimeSettingsScope::App, None)?;
        let project = self.policy_state(RuntimeSettingsScope::Project, None)?;
        let local = instance.map(|id| self.policy_state(RuntimeSettingsScope::Instance, Some(id))).transpose()?;
        let app_value = Self::decode_policy(&app)?;
        let project_value = Self::decode_policy(&project)?;
        let local_value = local.as_ref().map(Self::decode_policy).transpose()?.unwrap_or_default();
        let mut value = RuntimePolicy::default(); app_value.apply_to(&mut value); project_value.apply_to(&mut value); local_value.apply_to(&mut value);
        validate_policy(&value)?;
        Ok(RuntimeSettings { effective: RuntimeEffectivePolicy { value, app: app_value, project: project_value, instance: local_value }, app_version: app.version, project_version: project.version, instance_version: local.and_then(|p| p.version) })
    }
    fn blockers_locked(state: &State, id: &str) -> Vec<RuntimeLifecycleBlocker> {
        let Some(slot) = state.instances.get(id) else { return Vec::new(); };
        let mut blockers: Vec<_> = state.requests.iter().filter(|(_, request)| request.instance == id).map(|(operation, _)| RuntimeLifecycleBlocker {
            kind: "operation".into(), reference: operation.as_str().into(), label: "An accepted Workspace request still owns this session".into(),
        }).collect();
        if slot.query_count > 0 { blockers.push(RuntimeLifecycleBlocker { kind: "observation".into(), reference: id.into(), label: "A native observation is still reading this session".into() }); }
        blockers.extend(slot.holds.values().cloned());
        blockers
    }
    pub(crate) fn instance(&self, id: &str) -> Result<WorkspaceInstance, OperationError> {
        let policy = self.settings(Some(id))?.effective;
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state.instances.get(id).ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))?;
        Ok(WorkspaceInstance { workspace_instance_id: id.into(), name: slot.stored.name.clone(), binding: slot.stored.binding.clone(), installation: slot.stored.installation.clone(), native_session_id: slot.live.as_ref().map(|live| live.runtime.session_id().into()), continuation_lineage_id: slot.stored.lineage.clone(), state: slot.stored.state, policy, blockers: Self::blockers_locked(&state, id), last_error: slot.stored.last_error.clone(), last_lifecycle_operation_id: slot.stored.last_operation.clone() })
    }
    pub(crate) fn list(&self, args: &RuntimeInstancesArguments) -> Result<RuntimeInstances, OperationError> {
        if !(1..=200).contains(&args.limit) { return Err(invalid("Instance page limit must be 1..=200")); }
        if let Some(id) = &args.after_instance_id { validate_id(id)?; }
        let ids: Vec<_> = self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.keys().cloned().collect();
        let mut instances = Vec::new(); let mut bytes = 0; let mut more = false;
        for id in ids.iter().filter(|id| args.after_instance_id.as_ref().is_none_or(|after| *id > after)) {
            let instance = self.instance(id)?;
            let cost = serde_json::to_vec(&instance).map_err(stored)?.len();
            if instances.len() >= args.limit as usize || (!instances.is_empty() && bytes + cost > 768 * 1024) { more = true; break; }
            if cost > 768 * 1024 { return Err(OperationError::BudgetExceeded("Instance settings exceed the observation bound".into())); }
            bytes += cost; instances.push(instance);
        }
        let next_after_instance_id = if more { instances.last().map(|instance| instance.workspace_instance_id.clone()) } else { None };
        Ok(RuntimeInstances { default_workspace_instance_id: ids.iter().find(|id| id.as_str() == MAIN_WORKSPACE_INSTANCE).cloned().or_else(|| ids.first().cloned()), total: ids.len() as u64, instances, next_after_instance_id })
    }
    pub(crate) fn targets(&self) -> Vec<TargetRef> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.values().filter_map(|slot| slot.live.as_ref()).map(|live| TargetRef { kind: "workspace".into(), identity: live.runtime.session_id().into() }).collect()
    }
    pub(crate) fn workspace_for_native(&self, native: &str) -> Option<Arc<WorkspaceRunHandler>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.values().filter_map(|slot| slot.live.as_ref()).find(|live| live.runtime.session_id() == native).map(|live| live.workspace.clone())
    }
    pub(crate) fn resolve_live(&self, id: &str, capability: &str) -> Result<Arc<InstanceLive>, OperationError> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown { return Err(OperationError::Unavailable("The project Host is stopping".into())); }
        let slot = state.instances.get(id).ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))?;
        if slot.stored.state != RuntimeInstanceState::Ready && !capability.starts_with("workspace.checkpoint") && capability != "workspace.runtime_status" {
            return Err(OperationError::Unavailable(format!("R instance {id} is {:?}; inspect runtime.instance", slot.stored.state)));
        }
        slot.live.clone().ok_or_else(|| OperationError::Unavailable(format!("R instance {id} has no running process; continuing it is an explicit lifecycle operation")))
    }
    pub(crate) fn admit_operation(&self, id: &str, operation: &Operation) -> Result<Arc<InstanceLive>, HandlerError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown { return Err(before("The project Host is stopping")); }
        let slot = state.instances.get(id).ok_or_else(|| before("The R instance no longer exists"))?;
        let maintenance = slot.maintenance.as_ref().is_some_and(|id| operation.causation_id.as_ref() == Some(id)) && operation.capability.id.starts_with("workspace.checkpoint");
        if slot.stored.state != RuntimeInstanceState::Ready && !maintenance { return Err(before("The R instance is not ready for analysis execution")); }
        let live = slot.live.clone().ok_or_else(|| before("The R instance has no process"))?;
        if operation.target.kind == "workspace" && live.runtime.session_id() != operation.target.identity { return Err(before("The native R session changed before admission")); }
        state.requests.insert(operation.operation_id.clone(), AdmittedRequest { instance: id.into(), live: live.clone() });
        Ok(live)
    }
    pub(crate) fn operation_live(&self, id: &OperationId) -> Option<Arc<InstanceLive>> { self.state.lock().unwrap_or_else(|e| e.into_inner()).requests.get(id).map(|request| request.live.clone()) }
    pub(crate) fn operation_hold(self: &Arc<Self>, id: OperationId) -> RequestHold { RequestHold { owner: Arc::downgrade(self), kind: Some(HoldKind::Operation(id)), mark_activity: false } }
    pub(crate) fn release_operation(&self, id: &OperationId, activity: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = state.requests.remove(id) && activity {
            let boundary = request.live.activity.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(slot) = state.instances.get_mut(&request.instance) { slot.stored.activity = boundary; }
            if let Err(error) = self.persist_locked(&mut state) && let Some(slot) = state.instances.get_mut(&request.instance) {
                slot.stored.last_error = Some(format!("The activity boundary could not be persisted: {error}"));
            }
        }
    }
    pub(crate) fn admit_query(self: &Arc<Self>, id: &str, capability: &str) -> Result<(Arc<InstanceLive>, RequestHold), OperationError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state.instances.get_mut(id).ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))?;
        if slot.stored.state != RuntimeInstanceState::Ready && !capability.starts_with("workspace.checkpoint") && capability != "workspace.runtime_status" { return Err(OperationError::Unavailable("This R instance is not ready for native observations".into())); }
        let live = slot.live.clone().ok_or_else(|| OperationError::Unavailable("This R instance is stopped; reading does not start it".into()))?;
        slot.query_count += 1;
        Ok((live, RequestHold { owner: Arc::downgrade(self), kind: Some(HoldKind::Query(id.into())), mark_activity: false }))
    }
    pub(crate) fn begin_shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner()); state.shutdown = true;
        for slot in state.instances.values() { if let Some(live) = &slot.live { live.workspace.begin_shutdown(); } }
    }
    pub(crate) async fn protected_libraries(&self) -> Result<Vec<String>, String> {
        let runtimes: Vec<_> = self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.values().filter_map(|slot| slot.live.as_ref().map(|live| live.runtime.clone())).collect();
        let mut paths = BTreeSet::new();
        for runtime in runtimes { paths.extend(rho_environment::EnvironmentUsage::protected_paths(&crate::usage::WorkspaceUsage(runtime)).await?); }
        Ok(paths.into_iter().collect())
    }
    fn make_live(&self, runtime: Arc<dyn WorkspaceRuntime>, stored: &StoredInstance) -> Result<Arc<InstanceLive>, OperationError> {
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let workspace = Arc::new(WorkspaceRunHandler::with_lane(runtime.clone(), lane.clone()));
        let activity = Arc::new(AtomicU64::new(stored.activity));
        let checkpoint = Arc::new(WorkspaceCheckpointOwner::new(runtime.clone(), lane, self.journal.clone(), stored.id.clone(), stored.lineage.clone(), activity.clone()));
        checkpoint.set_scientific_queue(workspace.checkpoint_queue());
        checkpoint.set_capture_context(stored.binding.environment_realization_id.clone(), stored.activity);
        let registry = workspace_registry(workspace.clone(), checkpoint.clone(), self.journal.clone())?;
        Ok(Arc::new(InstanceLive { runtime, workspace, registry, activity, checkpoint }))
    }
    pub(crate) fn prototype(&self) -> Result<CapabilityRegistry, OperationError> {
        let stored = StoredInstance { id: MAIN_WORKSPACE_INSTANCE.into(), name: "Main".into(), binding: RuntimeLaunchBinding { r_executable: "/schema/R".into(), ark_executable: "/schema/ark".into(), environment_realization_id: None, library_path: None }, installation: None, lineage: "schema-lineage".into(), activity: 0, state: RuntimeInstanceState::Stopped, last_error: None, last_operation: None };
        let runtime = Arc::new(SchemaRuntime { project: self.project.clone() });
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let workspace = Arc::new(WorkspaceRunHandler::with_lane(runtime.clone(), lane.clone()));
        let checkpoint = Arc::new(WorkspaceCheckpointOwner::new(runtime, lane, self.journal.clone(), stored.id, stored.lineage, Arc::new(AtomicU64::new(0))));
        workspace_registry(workspace, checkpoint, self.journal.clone())
    }
}

enum HoldKind { Operation(OperationId), Query(String) }
pub(crate) struct RequestHold { owner: Weak<InstanceOwner>, kind: Option<HoldKind>, pub mark_activity: bool }
impl RequestHold {
    pub(crate) fn release(&mut self) {
        let Some(owner) = self.owner.upgrade() else { return; };
        match self.kind.take() {
            Some(HoldKind::Operation(id)) => owner.release_operation(&id, self.mark_activity),
            Some(HoldKind::Query(id)) => { let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner()); if let Some(slot) = state.instances.get_mut(&id) { slot.query_count = slot.query_count.saturating_sub(1); } },
            None => (),
        }
    }
}
impl Drop for RequestHold { fn drop(&mut self) { self.release(); } }

struct SchemaRuntime { project: String }
#[async_trait]
impl WorkspaceRuntime for SchemaRuntime {
    fn session_id(&self) -> &str { "schema-only" }
    fn project_root(&self) -> Option<&str> { Some(&self.project) }
    async fn execute(&self, _: &Operation, _: &RunRArguments) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> { Err(WorkspaceRuntimeError::before_effect("Schema prototypes cannot execute")) }
}

fn workspace_registry(workspace: Arc<WorkspaceRunHandler>, checkpoint: Arc<WorkspaceCheckpointOwner>, journal: Arc<dyn OperationJournal>) -> Result<CapabilityRegistry, OperationError> {
    let mut registry = CapabilityRegistry::new(); registry.register(workspace.clone())?;
    for check in [false, true] { registry.register_query(Arc::new(ConsoleQueryHandler::new(workspace.clone(), check)))?; }
    for pause in [false, true] { registry.register(Arc::new(QueueControlHandler::new(workspace.clone(), pause)))?; }
    registry.register_query(Arc::new(WorkspaceOutputHandler::new(workspace.clone(), Arc::new(JournalRecords(journal)), OutputQueryKind::Status)))?;
    for kind in [WorkspaceToolKind::Help, WorkspaceToolKind::Lint, WorkspaceToolKind::Format] { registry.register(Arc::new(WorkspaceToolHandler::new(workspace.clone(), kind)))?; }
    for kind in [WorkspaceQueryKind::Snapshot, WorkspaceQueryKind::Packages, WorkspaceQueryKind::InspectObject, WorkspaceQueryKind::ListObjects, WorkspaceQueryKind::ObserveObject, WorkspaceQueryKind::ReadObject, WorkspaceQueryKind::PackageIndex] { registry.register_query(Arc::new(WorkspaceQueryHandler::new(workspace.clone(), kind)))?; }
    register_checkpoint_handlers(&mut registry, checkpoint)?;
    Ok(registry)
}

fn validate_binding(binding: &RuntimeLaunchBinding) -> Result<(), OperationError> {
    for value in [&binding.r_executable, &binding.ark_executable] {
        if value.len() > 4096 || !Path::new(value).is_absolute() || value.chars().any(char::is_control) { return Err(invalid("Runtime executable paths must be absolute, bounded and contain no control characters")); }
    }
    if let Some(id) = &binding.environment_realization_id { OperationId::new(id)?; }
    if let Some(path) = &binding.library_path {
        if !Path::new(path).is_absolute() || path.len() > 4096 || path.chars().any(char::is_control) { return Err(invalid("Library paths must be absolute and bounded")); }
        if binding.environment_realization_id.is_some() { return Err(invalid("A verified Environment binding owns its library path; do not also specify a library override")); }
    }
    Ok(())
}
fn validate_policy(policy: &RuntimePolicy) -> Result<(), OperationError> {
    for names in [&policy.include_names, &policy.exclude_names, &policy.include_patterns, &policy.exclude_patterns] {
        if names.len() > 256 || names.iter().any(|value| value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)) { return Err(invalid("Object selection lists allow at most 256 nonempty names/patterns of 256 bytes each")); }
    }
    if policy.idle_delay_seconds == 0 || policy.automatic_interval_seconds == 0 || policy.capture_budget_ms == 0 || policy.capture_budget_ms > 60_000 || policy.recent_checkpoints == 0 || policy.recent_checkpoints > 100 || policy.daily_retention_days > 365 || policy.max_running_instances == 0 || policy.max_running_instances > 32 || policy.automatic_payload_limit_bytes == 0 || policy.project_storage_limit_bytes == 0 || policy.global_storage_limit_bytes < policy.project_storage_limit_bytes {
        return Err(invalid("Runtime policy bounds are invalid (1–32 running sessions, 1–100 recent checkpoints, at most 365 days and a project quota no larger than the global quota)"));
    }
    Ok(())
}

impl InstanceOwner {
    fn stored_instance(&self, id: &str) -> Result<StoredInstance, OperationError> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.get(id).map(|slot| slot.stored.clone()).ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))
    }
    fn change_state(&self, id: &str, status: RuntimeInstanceState, operation: &OperationId, error: Option<String>) -> Result<(), OperationError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state.instances.get_mut(id).ok_or_else(|| OperationError::NotFound(id.into()))?;
        slot.stored.state = status; slot.stored.last_error = error; slot.stored.last_operation = Some(operation.as_str().into());
        slot.maintenance = matches!(status, RuntimeInstanceState::Starting | RuntimeInstanceState::Stopping).then(|| operation.clone());
        self.persist_locked(&mut state)
    }
    fn check_capacity(&self, id: &str) -> Result<(), OperationError> {
        let limit = self.settings(Some(id))?.effective.value.max_running_instances;
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.instances.values().filter(|slot| slot.live.is_some()).count() >= limit as usize {
            return Err(OperationError::BudgetExceeded(format!("{limit} R sessions are already running; stop a session before starting another")));
        }
        Ok(())
    }
    fn require_quiet(&self, id: &str, expected: &str) -> Result<(), OperationError> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state.instances.get(id).ok_or_else(|| OperationError::NotFound(id.into()))?;
        let actual = slot.live.as_ref().map(|live| live.runtime.session_id());
        if actual != Some(expected) { return Err(OperationError::StaleSession(format!("Expected {expected}; this logical instance now has a different native session"))); }
        let blockers = Self::blockers_locked(&state, id);
        if !blockers.is_empty() { return Err(OperationError::Unavailable(format!("The session is in use: {}; inspect runtime.instance for its owners", blockers.iter().map(|blocker| blocker.label.as_str()).collect::<Vec<_>>().join("; ")))); }
        Ok(())
    }
    fn begin_stop(&self, id: &str, expected: &str, operation: &OperationId) -> Result<RuntimeInstanceState, OperationError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state.instances.get(id).ok_or_else(|| OperationError::NotFound(id.into()))?;
        if slot.live.as_ref().map(|live| live.runtime.session_id()) != Some(expected) { return Err(OperationError::StaleSession("The target native R session changed".into())); }
        if !Self::blockers_locked(&state, id).is_empty() { return Err(OperationError::Unavailable("This R session is still in use; inspect runtime.instance for its blockers".into())); }
        let slot = state.instances.get_mut(id).unwrap();
        let previous = slot.stored.state;
        slot.stored.state = RuntimeInstanceState::Stopping; slot.maintenance = Some(operation.clone());
        slot.stored.last_operation = Some(operation.as_str().into()); slot.stored.last_error = None;
        self.persist_locked(&mut state)?;
        Ok(previous)
    }
    fn internal_context(operation: &Operation) -> CallContext {
        CallContext { caller: operation.caller.clone(), principal: operation.principal.clone(),
            scopes: BTreeSet::from([WORKSPACE_READ_SCOPE.into(), RUN_R_SCOPE.into(), "operation.read".into()]),
            connection_id: "host:runtime-lifecycle".into(), correlation_id: Some(operation.correlation_id.clone()),
            causation_id: Some(operation.operation_id.clone()), trace_parent: operation.trace_parent.clone(),
        }
    }
    async fn child_operation(&self, parent: &Operation, suffix: &str, id: &str, capability: &str, mut arguments: Value) -> Result<OperationRecord, OperationError> {
        arguments["workspace_instance_id"] = json!(id);
        let request = Invocation { client_request_id: format!("{}:{suffix}", parent.operation_id.as_str()), capability: CapabilityRef::new(capability, 1)?, arguments, preconditions: vec![] };
        self.gateway()?.invoke(&Self::internal_context(parent), request).await
    }
    async fn protect_before_stop(&self, operation: &Operation, id: &str, native: &str, discard: bool) -> Result<(), OperationError> {
        if discard { return Ok(()); }
        let stored = self.stored_instance(id)?;
        if stored.activity == 0 { return Ok(()); }
        let policy = self.settings(Some(id))?.effective.value;
        if policy.mode == RuntimeContinuationMode::Off { return Err(OperationError::Unavailable("Object protection is off. Explicitly choose to discard unsaved objects before ending this session".into())); }
        let result = self.child_operation(operation, "protect", id, "workspace.checkpoint_capture", json!({
            "expected_session": native, "automatic": false,
            "max_bytes": policy.automatic_payload_limit_bytes, "max_seconds": policy.capture_budget_ms.div_ceil(1000),
            "include_names": if policy.object_selection == CheckpointObjectSelection::Selected { Some(&policy.include_names) } else { None },
            "exclude_names": policy.exclude_names,
            "include_patterns": policy.include_patterns, "exclude_patterns": policy.exclude_patterns,
        })).await?;
        if result.status != OperationStatus::Succeeded { return Err(OperationError::Unavailable(format!("Objects were not completely saved; this R session remains open. {}", result.error.unwrap_or_else(|| "Inspect the checkpoint operation".into())))); }
        let manifest: CheckpointManifest = serde_json::from_value(result.output.ok_or_else(|| stored_error("Checkpoint capture returned no manifest"))?).map_err(stored)?;
        if manifest.report.coverage != CheckpointCoverage::CompleteEligibleGraph || !manifest.report.skipped.is_empty() {
            return Err(OperationError::Unavailable(format!("The recovery point saved supported objects but skipped {} binding(s); this R session remains open until the remaining loss is explicitly accepted", manifest.report.skipped.len())));
        }
        Ok(())
    }
    async fn launch_candidate(&self, operation: &Operation, stored: &StoredInstance, prepared: PreparedInstanceLaunch, restore: bool) -> Result<WorkspaceInstance, OperationError> {
        self.check_capacity(&stored.id)?;
        let launched = self.launcher.launch(prepared).await?;
        let live = self.make_live(launched.runtime, stored)?;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state.instances.get_mut(&stored.id).ok_or_else(|| OperationError::NotFound(stored.id.clone()))?;
            slot.stored.installation = Some(launched.installation); slot.live = Some(live.clone());
            // The candidate is visible for diagnostics/checkpoint recovery, never for analysis.
            slot.stored.state = RuntimeInstanceState::Starting; slot.maintenance = Some(operation.operation_id.clone());
            self.persist_locked(&mut state)?;
        }
        if restore {
            let context = Self::internal_context(operation);
            let latest = live.checkpoint.latest_for(&context).await?;
            if let Some(entry) = latest {
                let record = self.child_operation(operation, "restore", &stored.id, "workspace.checkpoint_restore", json!({
                    "expected_session": live.runtime.session_id(), "checkpoint_id": entry.manifest.checkpoint_id,
                })).await?;
                if record.status != OperationStatus::Succeeded {
                    return Err(OperationError::Unavailable(format!("The saved objects could not be restored. The candidate is held for recovery; analysis has not resumed. {}", record.error.unwrap_or_default())));
                }
            } else if stored.activity > 0 {
                return Err(OperationError::Unavailable("The previous session had activity but no available checkpoint in this continuation lineage. Start an empty session or select an earlier recovery point explicitly".into()));
            }
        }
        self.change_state(&stored.id, RuntimeInstanceState::Ready, &operation.operation_id, None)?;
        self.instance(&stored.id)
    }
    async fn create(&self, operation: &Operation, arguments: CreateRuntimeInstance) -> Result<WorkspaceInstance, OperationError> {
        let prepared = self.launcher.prepare(&arguments.binding).await?;
        let id = format!("instance_{}", operation.operation_id.as_str()); validate_id(&id)?;
        let stored = StoredInstance { id: id.clone(), name: arguments.name, binding: prepared.binding.clone(), installation: Some(prepared.installation.clone()),
            lineage: format!("lineage_{}", operation.operation_id.as_str()), activity: 0,
            state: if arguments.start { RuntimeInstanceState::Starting } else { RuntimeInstanceState::Stopped },
            last_error: None, last_operation: Some(operation.operation_id.as_str().into()),
        };
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.shutdown { return Err(OperationError::Unavailable("The Host is stopping".into())); }
            state.instances.insert(id.clone(), InstanceSlot { stored: stored.clone(), persisted: None, version: None, live: None, maintenance: Some(operation.operation_id.clone()), query_count: 0, holds: BTreeMap::new() });
            self.persist_locked(&mut state)?;
        }
        if arguments.policy != RuntimePolicyOverrides::default() {
            self.update_settings(UpdateRuntimeSettings { scope: RuntimeSettingsScope::Instance, workspace_instance_id: Some(id.clone()), expected_version: None, overrides: arguments.policy })?;
        }
        if !arguments.start { return self.instance(&id); }
        let result = self.launch_candidate(operation, &stored, prepared, false).await;
        if let Err(error) = &result { self.change_state(&id, RuntimeInstanceState::Failed, &operation.operation_id, Some(error.to_string()))?; }
        result
    }
    async fn continue_instance(&self, operation: &Operation, args: ContinueRuntimeInstance) -> Result<WorkspaceInstance, OperationError> {
        let mut stored = self.stored_instance(&args.workspace_instance_id)?;
        if stored.lineage != args.expected_continuation_lineage_id { return Err(OperationError::StaleSession("The continuation lineage changed; refresh this instance before continuing".into())); }
        if self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.get(&stored.id).is_some_and(|slot| slot.live.is_some()) {
            if stored.state == RuntimeInstanceState::Ready { return self.instance(&stored.id); }
            return Err(OperationError::Unavailable("This instance already has a candidate requiring recovery; inspect it before starting another process".into()));
        }
        let prepared = match self.launcher.prepare(&stored.binding).await {
            Ok(prepared) => prepared,
            Err(error) => { self.change_state(&stored.id, RuntimeInstanceState::RecoveryRequired, &operation.operation_id, Some(error.to_string()))?; return Err(error); }
        };
        if stored.installation.as_ref().is_some_and(|identity| identity != &prepared.installation) {
            let error = OperationError::Unavailable("The original R installation version or architecture changed. Automatic continuation will not substitute a different runtime".into());
            self.change_state(&stored.id, RuntimeInstanceState::RecoveryRequired, &operation.operation_id, Some(error.to_string()))?;
            return Err(error);
        }
        let mode = self.settings(Some(&stored.id))?.effective.value.mode;
        if mode != RuntimeContinuationMode::AutoContinue {
            stored.lineage = format!("lineage_{}", operation.operation_id.as_str()); stored.activity = 0;
            self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.get_mut(&stored.id).unwrap().stored = stored.clone();
        }
        self.change_state(&stored.id, RuntimeInstanceState::Starting, &operation.operation_id, None)?;
        let result = self.launch_candidate(operation, &stored, prepared, mode == RuntimeContinuationMode::AutoContinue).await;
        if let Err(error) = &result { self.change_state(&stored.id, RuntimeInstanceState::RecoveryRequired, &operation.operation_id, Some(error.to_string()))?; }
        result
    }
    async fn stop(&self, operation: &Operation, args: StopRuntimeInstance) -> Result<WorkspaceInstance, OperationError> {
        let prior = self.stored_instance(&args.workspace_instance_id)?.state;
        if prior != RuntimeInstanceState::Ready && !args.discard_unsaved_objects { return Err(OperationError::Unavailable("The recovery candidate is not ready. Explicitly discard it to stop; its partial state will not replace the original recovery point".into())); }
        let prior = self.begin_stop(&args.workspace_instance_id, &args.expected_native_session_id, &operation.operation_id)?;
        if let Err(error) = self.protect_before_stop(operation, &args.workspace_instance_id, &args.expected_native_session_id, args.discard_unsaved_objects).await {
            self.change_state(&args.workspace_instance_id, prior, &operation.operation_id, Some(error.to_string()))?;
            return Err(error);
        }
        if let Err(error) = self.require_quiet(&args.workspace_instance_id, &args.expected_native_session_id) {
            self.change_state(&args.workspace_instance_id, prior, &operation.operation_id, Some(error.to_string()))?;
            return Err(error);
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state.instances.get_mut(&args.workspace_instance_id).unwrap();
            if let Some(live) = slot.live.take() { live.workspace.begin_shutdown(); }
            slot.stored.state = RuntimeInstanceState::Stopped; slot.maintenance = None;
            self.persist_locked(&mut state)?;
        }
        self.instance(&args.workspace_instance_id)
    }
    async fn restart(&self, operation: &Operation, args: RestartRuntimeInstance) -> Result<WorkspaceInstance, OperationError> {
        self.require_quiet(&args.workspace_instance_id, &args.expected_native_session_id)?;
        let stored = self.stored_instance(&args.workspace_instance_id)?;
        let prepared = self.launcher.prepare(&stored.binding).await?;
        if stored.installation.as_ref().is_some_and(|identity| identity != &prepared.installation) { return Err(OperationError::Unavailable("The bound R installation changed; restarting will not silently replace its version or architecture".into())); }
        self.stop(operation, StopRuntimeInstance { workspace_instance_id: args.workspace_instance_id.clone(), expected_native_session_id: args.expected_native_session_id, discard_unsaved_objects: args.discard_unsaved_objects }).await?;
        let mut stored = self.stored_instance(&args.workspace_instance_id)?;
        if args.clean {
            stored.lineage = format!("lineage_{}", operation.operation_id.as_str()); stored.activity = 0;
            self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.get_mut(&stored.id).unwrap().stored = stored.clone();
        }
        // Persist the empty lineage before launch. A crash cannot resurrect a pre-clean checkpoint.
        self.change_state(&stored.id, RuntimeInstanceState::Starting, &operation.operation_id, None)?;
        let result = self.launch_candidate(operation, &stored, prepared, !args.clean).await;
        if let Err(error) = &result { self.change_state(&stored.id, RuntimeInstanceState::RecoveryRequired, &operation.operation_id, Some(error.to_string()))?; }
        result
    }
    async fn restore_as_new(&self, operation: &Operation, args: RestoreRuntimeInstance) -> Result<WorkspaceInstance, OperationError> {
        let source = self.stored_instance(&args.source_workspace_instance_id)?;
        let record = self.journal.get(&args.checkpoint_id).await?.ok_or_else(|| OperationError::NotFound(args.checkpoint_id.as_str().into()))?;
        if record.operation.principal() != operation.principal() || record.operation.idempotency_scope.as_deref() != Some(self.project()) || record.operation.capability.id != "workspace.checkpoint_capture" || record.status != OperationStatus::Succeeded {
            return Err(invalid("The requested recovery point is not a committed checkpoint visible to this project and principal"));
        }
        let manifest: CheckpointManifest = serde_json::from_value(record.output.ok_or_else(|| invalid("The recovery point has no manifest"))?).map_err(invalid)?;
        if manifest.workspace_instance_id != source.id { return Err(invalid("The recovery point does not belong to the named source instance")); }
        let prepared = self.launcher.prepare(&source.binding).await?;
        if source.installation.as_ref().is_some_and(|identity| identity != &prepared.installation) { return Err(OperationError::Unavailable("The recovery point's original R installation is unavailable or changed; creating a recovery session will not substitute another R".into())); }
        let id = format!("instance_{}", operation.operation_id.as_str());
        let stored = StoredInstance { id: id.clone(), name: args.name, binding: prepared.binding.clone(), installation: Some(prepared.installation.clone()), lineage: format!("lineage_{}", operation.operation_id.as_str()), activity: manifest.activity_boundary, state: RuntimeInstanceState::Starting, last_error: None, last_operation: Some(operation.operation_id.as_str().into()) };
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.instances.insert(id.clone(), InstanceSlot { stored: stored.clone(), persisted: None, version: None, live: None, maintenance: Some(operation.operation_id.clone()), query_count: 0, holds: BTreeMap::new() });
            self.persist_locked(&mut state)?;
        }
        let result = async {
            self.check_capacity(&id)?;
            let launched = self.launcher.launch(prepared).await?;
            let live = self.make_live(launched.runtime, &stored)?;
            self.state.lock().unwrap_or_else(|e| e.into_inner()).instances.get_mut(&id).unwrap().live = Some(live.clone());
            let result = self.child_operation(operation, "import", &id, "workspace.checkpoint_restore", json!({
                "expected_session":live.runtime.session_id(), "checkpoint_id":manifest.checkpoint_id,
                "source_workspace_instance_id":source.id, "source_continuation_lineage_id":manifest.continuation_lineage_id,
            })).await?;
            if result.status != OperationStatus::Succeeded { return Err(OperationError::Unavailable(format!("The recovery candidate is retained for inspection. {}", result.error.unwrap_or_else(|| "Objects were not restored".into())))); }
            self.change_state(&id, RuntimeInstanceState::Ready, &operation.operation_id, None)?;
            self.instance(&id)
        }.await;
        if let Err(error) = &result { self.change_state(&id, RuntimeInstanceState::RecoveryRequired, &operation.operation_id, Some(error.to_string()))?; }
        result
    }
    fn rename(&self, operation: &Operation, args: RenameRuntimeInstance) -> Result<WorkspaceInstance, OperationError> {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state.instances.get_mut(&args.workspace_instance_id).ok_or_else(|| OperationError::NotFound(args.workspace_instance_id.clone()))?;
            if slot.stored.name != args.expected_name { return Err(OperationError::ContentChanged("The instance was renamed in another window".into())); }
            slot.stored.name = args.name; slot.stored.last_operation = Some(operation.operation_id.as_str().into());
            self.persist_locked(&mut state)?;
        }
        self.instance(&args.workspace_instance_id)
    }
    fn update_settings(&self, args: UpdateRuntimeSettings) -> Result<RuntimeSettings, OperationError> {
        if args.scope != RuntimeSettingsScope::App && (args.overrides.global_storage_limit_bytes.is_some() || args.overrides.minimum_free_bytes.is_some()) { return Err(invalid("Global storage and free-space limits may only be set in application settings")); }
        if args.scope == RuntimeSettingsScope::Instance && (args.overrides.project_storage_limit_bytes.is_some() || args.overrides.max_running_instances.is_some()) { return Err(invalid("A session cannot override project storage or simultaneous-process limits")); }
        if args.scope == RuntimeSettingsScope::Instance {
            self.stored_instance(args.workspace_instance_id.as_deref().ok_or_else(|| invalid("Instance settings require workspace_instance_id"))?)?;
        } else if args.workspace_instance_id.is_some() { return Err(invalid("App/project settings do not take workspace_instance_id")); }
        let mut policy = self.settings(args.workspace_instance_id.as_deref())?.effective.value;
        args.overrides.apply_to(&mut policy); validate_policy(&policy)?;
        let old = self.policy_state(args.scope, args.workspace_instance_id.as_deref())?;
        if old.version != args.expected_version { return Err(OperationError::ContentChanged("Runtime settings changed in another window".into())); }
        let state = ApplicationState { value: serde_json::to_value(args.overrides).map_err(stored)?, ..old };
        if args.scope == RuntimeSettingsScope::App { self.app_store.write("user", &state).map_err(stored)?; }
        else { self.store.write(&self.scope(), &state).map_err(stored)?; }
        self.settings(args.workspace_instance_id.as_deref())
    }
    pub(crate) async fn continue_default(&self) -> Result<(), OperationError> {
        let Some(id) = self.list(&RuntimeInstancesArguments { after_instance_id: None, limit: 1 })?.default_workspace_instance_id else { return Ok(()); };
        let instance = self.instance(&id)?;
        // Opening the project starts only its default instance. Queries never call this path.
        if instance.state == RuntimeInstanceState::RecoveryRequired { return Ok(()); }
        let context = crate::NextHost::local_context();
        let request = Invocation { client_request_id: format!("host-start:{}", uuid::Uuid::new_v4().simple()), capability: CapabilityRef::new("runtime.continue_instance", 1)?, arguments: json!({"workspace_instance_id":id,"expected_continuation_lineage_id":instance.continuation_lineage_id}), preconditions: vec![] };
        let record = self.gateway()?.invoke(&context, request).await?;
        if record.status != OperationStatus::Succeeded {
            // Failed continuation leaves files and the project Host available.
            return Ok(());
        }
        Ok(())
    }
}
fn stored_error(message: &str) -> OperationError { OperationError::Storage(message.into()) }

pub(crate) fn register_lifecycle(registry: &mut CapabilityRegistry, owner: Arc<InstanceOwner>) -> Result<(), OperationError> {
    for id in ["runtime.instances", "runtime.instance", "runtime.settings"] { registry.register_query(Arc::new(InstanceQuery { owner: owner.clone(), descriptor: lifecycle_descriptor(id) }))?; }
    for id in ["runtime.create_instance", "runtime.continue_instance", "runtime.stop_instance", "runtime.restart_instance", "runtime.restore_instance", "runtime.rename_instance", "runtime.update_settings"] { registry.register(Arc::new(InstanceOperation { owner: owner.clone(), descriptor: lifecycle_descriptor(id) }))?; }
    Ok(())
}

fn lifecycle_descriptor(id: &str) -> CapabilityDescriptor {
    let query = matches!(id, "runtime.instances" | "runtime.instance" | "runtime.settings");
    let (input, output, summary, example) = match id {
        "runtime.instances" => (schema_for!(RuntimeInstancesArguments).to_value(), schema_for!(RuntimeInstances).to_value(), "List project R instances", json!({"limit":50})),
        "runtime.instance" => (schema_for!(RuntimeInstanceArguments).to_value(), schema_for!(WorkspaceInstance).to_value(), "Inspect a logical R instance and its blockers", json!({"workspace_instance_id":"main"})),
        "runtime.settings" => (schema_for!(RuntimeSettingsArguments).to_value(), schema_for!(RuntimeSettings).to_value(), "Read effective R continuation preferences", json!({"workspace_instance_id":null})),
        "runtime.create_instance" => (schema_for!(CreateRuntimeInstance).to_value(), schema_for!(WorkspaceInstance).to_value(), "Create an independent R instance", json!({"name":"Scratch","binding":{"r_executable":"/example/R","ark_executable":"/example/ark","environment_realization_id":null},"start":false,"policy":{}})),
        "runtime.continue_instance" => (schema_for!(ContinueRuntimeInstance).to_value(), schema_for!(WorkspaceInstance).to_value(), "Continue the original logical R session", json!({"workspace_instance_id":"main","expected_continuation_lineage_id":"lineage-example"})),
        "runtime.stop_instance" => (schema_for!(StopRuntimeInstance).to_value(), schema_for!(WorkspaceInstance).to_value(), "Save and stop one R instance", json!({"workspace_instance_id":"main","expected_native_session_id":"session-example","discard_unsaved_objects":false})),
        "runtime.restart_instance" => (schema_for!(RestartRuntimeInstance).to_value(), schema_for!(WorkspaceInstance).to_value(), "Restart one R instance with its bound environment", json!({"workspace_instance_id":"main","expected_native_session_id":"session-example","clean":true,"discard_unsaved_objects":false})),
        "runtime.restore_instance" => (schema_for!(RestoreRuntimeInstance).to_value(), schema_for!(WorkspaceInstance).to_value(), "Restore an earlier recovery point in a new R instance", json!({"source_workspace_instance_id":"main","checkpoint_id":"operation-example","name":"Recovered analysis"})),
        "runtime.rename_instance" => (schema_for!(RenameRuntimeInstance).to_value(), schema_for!(WorkspaceInstance).to_value(), "Rename a logical R session", json!({"workspace_instance_id":"main","expected_name":"Main","name":"Analysis"})),
        "runtime.update_settings" => (schema_for!(UpdateRuntimeSettings).to_value(), schema_for!(RuntimeSettings).to_value(), "Update explicit R continuation preferences", json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{}})),
        _ => unreachable!(),
    };
    let mut documentation = builtin_documentation(if query {"host.overview"} else {"workspace.run_r"});
    documentation.summary = summary.into(); documentation.purpose = summary.into(); documentation.owner = "host".into();
    documentation.examples = vec![CapabilityExample { arguments: example, result_explanation: "Inspect the owner observation or original OperationRecord; a native session change never replays code or queued work.".into() }];
    documentation.preconditions.clear(); documentation.related_capabilities.clear();
    documentation.effects = if query {"Bounded Host metadata only; does not start or recover R"} else {"Changes only the explicitly targeted local R lifecycle or saved preference scope"}.into();
    CapabilityDescriptor { kind: if query {CapabilityKind::Query} else {CapabilityKind::Operation}, capability: CapabilityRef::new(id, 1).unwrap(), domain: "runtime".into(), input_schema: input, output_schema: output, recovery_schema: json!({"type":"object"}), documentation,
        required_scopes: BTreeSet::from([if query {RUNTIME_READ_SCOPE} else {RUNTIME_CONTROL_SCOPE}.into()]),
        potential_effects: if query {BTreeSet::new()} else {BTreeSet::from([EffectHint::MayMutateRuntime, EffectHint::MaySpawnProcess])},
        idempotency: if query {IdempotencyClass::Pure} else {IdempotencyClass::CallerScoped}, retry: if query {RetryClass::Safe} else {RetryClass::ReconcileFirst}, cancellation: CancellationClass::Unsupported,
    }
}

struct InstanceOperation { owner: Arc<InstanceOwner>, descriptor: CapabilityDescriptor }
#[async_trait]
impl OperationHandler for InstanceOperation {
    fn descriptor(&self) -> &CapabilityDescriptor { &self.descriptor }
    fn idempotency_scope(&self) -> Option<String> { Some(self.owner.project.clone()) }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        normalize_lifecycle(&self.descriptor.capability.id, arguments)
    }
    fn resolve_target(&self, arguments: &Value) -> Result<TargetRef, OperationError> {
        Ok(if let Some(id) = arguments.get("workspace_instance_id").and_then(Value::as_str) { TargetRef { kind: "workspace_instance".into(), identity: id.into() } } else { TargetRef { kind: "project".into(), identity: self.owner.project.clone() } })
    }
    async fn acquire_execution(&self, _operation: &Operation, _cancellation: tokio::sync::watch::Receiver<bool>) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(LifecycleLease { _guard: self.owner.transition.clone().lock_owned().await }))
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        let args = operation.normalized_arguments.clone();
        let result = match operation.capability.id.as_str() {
            "runtime.create_instance" => self.owner.create(operation, serde_json::from_value(args).map_err(before)?).await.and_then(|v| serde_json::to_value(v).map_err(stored)),
            "runtime.continue_instance" => self.owner.continue_instance(operation, serde_json::from_value(args).map_err(before)?).await.and_then(|v| serde_json::to_value(v).map_err(stored)),
            "runtime.stop_instance" => self.owner.stop(operation, serde_json::from_value(args).map_err(before)?).await.and_then(|v| serde_json::to_value(v).map_err(stored)),
            "runtime.restart_instance" => self.owner.restart(operation, serde_json::from_value(args).map_err(before)?).await.and_then(|v| serde_json::to_value(v).map_err(stored)),
            "runtime.restore_instance" => self.owner.restore_as_new(operation, serde_json::from_value(args).map_err(before)?).await.and_then(|v| serde_json::to_value(v).map_err(stored)),
            "runtime.rename_instance" => self.owner.rename(operation, serde_json::from_value(args).map_err(before)?).and_then(|v| serde_json::to_value(v).map_err(stored)),
            "runtime.update_settings" => self.owner.update_settings(serde_json::from_value(args).map_err(before)?).and_then(|v| serde_json::to_value(v).map_err(stored)),
            _ => return Err(before("Unknown instance lifecycle operation")),
        };
        match result {
            Ok(value) => { let mut plan = CommitPlan::succeeded(value); plan.events.push(PlannedEvent { kind: "runtime.instance_changed".into(), payload: json!({"operation_id":operation.operation_id,"workspace_instance_id":operation.normalized_arguments.get("workspace_instance_id")}) }); Ok(plan) },
            Err(error) if matches!(error, OperationError::Storage(_) | OperationError::CommitPending { .. }) => Err(HandlerError::after_possible_effect(error.to_string(), Some(json!({"action":"inspect_original_lifecycle","operation_id":operation.operation_id,"workspace_instance_id":operation.normalized_arguments.get("workspace_instance_id"),"automatic_reexecution":false})))),
            Err(error) => {
                let id = operation.normalized_arguments.get("workspace_instance_id").and_then(Value::as_str).map(str::to_owned)
                    .unwrap_or_else(|| format!("instance_{}", operation.operation_id.as_str()));
                if self.owner.stored_instance(&id).is_ok_and(|instance| instance.last_operation.as_deref() == Some(operation.operation_id.as_str())) {
                    let mut plan = CommitPlan::succeeded(serde_json::to_value(self.owner.instance(&id).map_err(before)?).map_err(before)?);
                    plan.outcome = OperationOutcome::Failed; plan.error = Some(error.to_string());
                    plan.recovery = Some(json!({"action":"inspect_instance","workspace_instance_id":id,"automatic_reexecution":false}));
                    return Ok(plan);
                }
                Err(before(error))
            },
        }
    }
}
struct LifecycleLease { _guard: tokio::sync::OwnedMutexGuard<()> }
impl ExecutionLease for LifecycleLease {}

struct InstanceQuery { owner: Arc<InstanceOwner>, descriptor: CapabilityDescriptor }
#[async_trait]
impl QueryHandler for InstanceQuery {
    fn descriptor(&self) -> &CapabilityDescriptor { &self.descriptor }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> { normalize_lifecycle(&self.descriptor.capability.id, arguments) }
    async fn query(&self, arguments: &Value) -> Result<QuerySnapshot, OperationError> {
        let data = match self.descriptor.capability.id.as_str() {
            "runtime.instances" => serde_json::to_value(self.owner.list(&serde_json::from_value(arguments.clone()).map_err(invalid)?)?).map_err(stored)?,
            "runtime.instance" => { let args: RuntimeInstanceArguments = serde_json::from_value(arguments.clone()).map_err(invalid)?; serde_json::to_value(self.owner.instance(&args.workspace_instance_id)?).map_err(stored)? },
            "runtime.settings" => { let args: RuntimeSettingsArguments = serde_json::from_value(arguments.clone()).map_err(invalid)?; serde_json::to_value(self.owner.settings(args.workspace_instance_id.as_deref())?).map_err(stored)? },
            _ => return Err(invalid("Unknown instance query")),
        };
        Ok(QuerySnapshot { target: TargetRef { kind: "project".into(), identity: self.owner.project.clone() }, source: "host-instance-owner".into(), observed_at_ms: now()?, status: QueryStatus::Ready, completeness: ObservationCompleteness::Complete, data: Some(data), notices: vec![], next_reads: vec![], diagnostics: vec![] })
    }
}
fn normalize_lifecycle(id: &str, value: &Value) -> Result<Value, OperationError> {
    fn parsed<T: serde::de::DeserializeOwned + Serialize>(value: &Value) -> Result<Value, OperationError> { serde_json::to_value(serde_json::from_value::<T>(value.clone()).map_err(invalid)?).map_err(invalid) }
    let normalized = match id {
        "runtime.instances" => parsed::<RuntimeInstancesArguments>(value),
        "runtime.instance" => parsed::<RuntimeInstanceArguments>(value),
        "runtime.settings" => parsed::<RuntimeSettingsArguments>(value),
        "runtime.create_instance" => {
            let args: CreateRuntimeInstance = serde_json::from_value(value.clone()).map_err(invalid)?;
            if args.name.trim().is_empty() || args.name.len() > 160 || args.name.chars().any(char::is_control) { return Err(invalid("Instance names must contain 1–160 bytes and no control characters")); }
            validate_binding(&args.binding)?; serde_json::to_value(args).map_err(invalid)
        },
        "runtime.continue_instance" => parsed::<ContinueRuntimeInstance>(value),
        "runtime.stop_instance" => parsed::<StopRuntimeInstance>(value),
        "runtime.restart_instance" => parsed::<RestartRuntimeInstance>(value),
        "runtime.restore_instance" => parsed::<RestoreRuntimeInstance>(value),
        "runtime.rename_instance" => parsed::<RenameRuntimeInstance>(value),
        "runtime.update_settings" => parsed::<UpdateRuntimeSettings>(value),
        _ => Err(invalid("Unknown runtime capability or arguments")),
    }?;
    if let Some(id) = normalized.get("workspace_instance_id").and_then(Value::as_str) { validate_id(id)?; }
    if let Some(id) = normalized.get("source_workspace_instance_id").and_then(Value::as_str) { validate_id(id)?; }
    if let Some(name) = normalized.get("name").and_then(Value::as_str) && (name.trim().is_empty() || name.len() > 160 || name.chars().any(char::is_control)) { return Err(invalid("Instance names must contain 1–160 bytes and no control characters")); }
    Ok(normalized)
}
