//! Project Host lifecycle for independent local R instances. The journal and project lease
//! remain with the composing Host; an instance owns only its native runtime and Workspace owners.
mod protection;
use crate::{ApplicationStore, ArkConfig, ArkRuntime, JournalRecords, OperationError, probe_r};
use async_trait::async_trait;
use rho_contract::*;
use rho_operation::*;
use rho_workspace::*;
use schemars::schema_for;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

const POLICY_KEY: &str = "hosting.runtime_policy";

pub(crate) fn validate_id(value: &str) -> Result<(), OperationError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(OperationError::InvalidInput(
            "Instance identifiers must contain 1–160 ASCII letters, digits, hyphens or underscores"
                .into(),
        ));
    }
    Ok(())
}
fn invalid(error: impl ToString) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
fn storage_error(error: impl ToString) -> OperationError {
    OperationError::Storage(error.to_string())
}
fn before(error: impl ToString) -> HandlerError {
    HandlerError::before_effect(error.to_string())
}
fn now() -> Result<i64, OperationError> {
    SystemClock.now_ms()
}

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
    async fn prepare(
        &self,
        binding: &RuntimeLaunchBinding,
    ) -> Result<PreparedInstanceLaunch, OperationError>;
    async fn launch(
        &self,
        prepared: PreparedInstanceLaunch,
    ) -> Result<LaunchedInstance, OperationError>;
    fn archive_runtime(&self) -> Result<Option<Arc<dyn WorkspaceRuntime>>, OperationError> {
        Ok(None)
    }
    fn storage_root(&self) -> Option<PathBuf> {
        None
    }
    async fn original_process_alive(
        &self,
        _process: &RuntimeProcessIdentity,
    ) -> Result<Option<bool>, OperationError> {
        Ok(None)
    }
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
    async fn original_process_alive(
        &self,
        process: &RuntimeProcessIdentity,
    ) -> Result<Option<bool>, OperationError> {
        rho_r_runtime::recorded_process_alive(process)
            .await
            .map_err(OperationError::Unavailable)
    }
    fn storage_root(&self) -> Option<PathBuf> {
        Some(self.data_root.clone())
    }
    fn archive_runtime(&self) -> Result<Option<Arc<dyn WorkspaceRuntime>>, OperationError> {
        Ok(Some(Arc::new(
            rho_r_runtime::CheckpointArchiveRuntime::open(&self.project, &self.data_root)
                .map_err(OperationError::Storage)?,
        )))
    }
    async fn prepare(
        &self,
        binding: &RuntimeLaunchBinding,
    ) -> Result<PreparedInstanceLaunch, OperationError> {
        validate_binding(binding)?;
        let probe = probe_r(&RSelection {
            executable: binding.r_executable.clone(),
            ark: binding.ark_executable.clone(),
        })
        .await;
        if !probe.usable {
            return Err(OperationError::Unavailable(probe.diagnostics.join("\n")));
        }
        let r_home = probe
            .r_home
            .ok_or_else(|| OperationError::Unavailable("R home was not verified".into()))?;
        let output = crate::r_configuration::bounded_command(Path::new(&probe.selection.executable), &["--vanilla", "--slave", "-e", "cat(jsonlite::toJSON(list(r_home=normalizePath(R.home(),winslash='/',mustWork=TRUE),r_version=as.character(getRversion()),platform=R.version$platform),auto_unbox=TRUE))"]).await.map_err(OperationError::Unavailable)?;
        let installation: RuntimeInstallationIdentity =
            serde_json::from_str(&output).map_err(|_| {
                OperationError::Unavailable(
                    "R did not return a complete bounded installation identity".into(),
                )
            })?;
        if Path::new(&installation.r_home)
            .canonicalize()
            .map_err(storage_error)?
            != Path::new(&r_home).canonicalize().map_err(storage_error)?
            || installation.r_version.is_empty()
            || installation.platform.is_empty()
        {
            return Err(OperationError::Unavailable(
                "R installation metadata changed during preflight".into(),
            ));
        }
        let checkpoint_helper_path = prepared_checkpoint_helper(binding, &installation)?;
        let library_path = if let Some(id) = &binding.environment_realization_id {
            let environment = rho_r_environment::REnvironment::open(crate::REnvironmentConfig {
                rscript: Path::new(&r_home).join("bin").join(if cfg!(windows) {
                    "Rscript.exe"
                } else {
                    "Rscript"
                }),
                project_root: self.project.clone(),
                data_root: self.environment_root.clone(),
                timeout: Duration::from_secs(300),
            })
            .map_err(OperationError::TargetResolution)?;
            Some(PathBuf::from(
                crate::environment::selected_environment(self.journal.as_ref(), &environment, id)
                    .await?
                    .library_path,
            ))
        } else {
            binding
                .library_path
                .as_ref()
                .map(|path| {
                    let path = PathBuf::from(path).canonicalize().map_err(|error| {
                        OperationError::Unavailable(format!(
                            "The bound R library is unavailable: {error}"
                        ))
                    })?;
                    if !path.is_dir() {
                        return Err(OperationError::Unavailable(
                            "The bound R library is not a directory".into(),
                        ));
                    }
                    Ok(path)
                })
                .transpose()?
        };
        // The binding is the durable record of what this launch actually uses, so it
        // carries the resolved library and not only the declared realization.
        let bound_library = library_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| binding.library_path.clone());
        Ok(PreparedInstanceLaunch {
            binding: RuntimeLaunchBinding {
                r_executable: probe.selection.executable,
                ark_executable: probe.selection.ark,
                environment_realization_id: binding.environment_realization_id.clone(),
                library_path: bound_library,
                checkpoint_helper_path,
            },
            installation,
            library_path,
        })
    }
    async fn launch(
        &self,
        prepared: PreparedInstanceLaunch,
    ) -> Result<LaunchedInstance, OperationError> {
        let runtime = Arc::new(
            ArkRuntime::launch(ArkConfig {
                executable: PathBuf::from(&prepared.binding.ark_executable),
                r_home: PathBuf::from(&prepared.installation.r_home),
                project_root: self.project.clone(),
                data_root: self.data_root.clone(),
                execution_timeout: self.execution_timeout,
                library_path: prepared.library_path,
                checkpoint_helper_path: prepared
                    .binding
                    .checkpoint_helper_path
                    .as_ref()
                    .map(PathBuf::from),
            })
            .await
            .map_err(OperationError::TargetResolution)?,
        );
        // Startup has completed before publication. The native adapter owns the handshake.
        if runtime.runtime_status().state == "unavailable" {
            return Err(OperationError::Unavailable(
                "The R process did not complete startup".into(),
            ));
        }
        let installation = runtime.installation_identity().ok_or_else(|| {
            OperationError::Unavailable(
                "The native R handshake did not report its actual installation".into(),
            )
        })?;
        if runtime.process_identity().is_none() {
            return Err(OperationError::Unavailable("The native R process identity could not be verified; the candidate was not published".into()));
        }
        if installation != prepared.installation {
            return Err(OperationError::Unavailable("The actual R process does not match its prepared installation; the candidate was not published".into()));
        }
        Ok(LaunchedInstance {
            runtime,
            installation,
        })
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
    #[serde(default)]
    process: Option<RuntimeProcessIdentity>,
    #[serde(default)]
    launch_unconfirmed: bool,
}
struct InstanceSlot {
    stored: StoredInstance,
    persisted: Option<StoredInstance>,
    version: Option<String>,
    live: Option<Arc<InstanceLive>>,
    archive: Option<Arc<InstanceLive>>,
    maintenance: Option<OperationId>,
    query_count: usize,
    holds: BTreeMap<String, RuntimeLifecycleBlocker>,
}
struct AdmittedRequest {
    instance: String,
    live: Arc<InstanceLive>,
}
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

/// Reports whether any Studio window of this project is online. Window liveness
/// belongs to the Application owner; the idle-release policy only consumes it.
pub(crate) type WindowProbe = Arc<dyn Fn() -> bool + Send + Sync>;

pub(crate) struct InstanceOwner {
    project: String,
    store: Arc<ApplicationStore>,
    app_store: Arc<ApplicationStore>,
    journal: Arc<dyn OperationJournal>,
    launcher: Arc<dyn InstanceLauncher>,
    state: Mutex<State>,
    transition: Arc<tokio::sync::Mutex<()>>,
    native_reads_changed: tokio::sync::Notify,
    opening_cancellations: Mutex<BTreeMap<OperationId, tokio::sync::watch::Receiver<bool>>>,
    gateway: OnceLock<Weak<OperationGateway>>,
    windows_online: OnceLock<WindowProbe>,
    _project_lease: Option<Arc<crate::ProjectLease>>,
}

impl InstanceOwner {
    pub(crate) fn open(
        project: String,
        store: Arc<ApplicationStore>,
        app_store: Arc<ApplicationStore>,
        journal: Arc<dyn OperationJournal>,
        launcher: Arc<dyn InstanceLauncher>,
        initial: Option<RuntimeLaunchBinding>,
        project_lease: Option<Arc<crate::ProjectLease>>,
    ) -> Result<Arc<Self>, OperationError> {
        let mut saved = BTreeMap::new();
        let mut versions = BTreeMap::new();
        let mut after = None;
        loop {
            let page = store
                .runtime_instances(&format!("project:{project}"), after.as_deref(), 200)
                .map_err(storage_error)?;
            for row in page.records {
                let item: StoredInstance =
                    serde_json::from_value(row.value).map_err(storage_error)?;
                if item.id != row.key {
                    return Err(storage_error(
                        "Instance row identity does not match its contents",
                    ));
                }
                versions.insert(row.key.clone(), row.version);
                saved.insert(row.key, item);
            }
            after = page.next_after_instance_id;
            if after.is_none() {
                break;
            }
        }
        if let Some(binding) = initial
            && !saved.contains_key(MAIN_WORKSPACE_INSTANCE)
        {
            validate_binding(&binding)?;
            saved.insert(
                MAIN_WORKSPACE_INSTANCE.into(),
                StoredInstance {
                    id: MAIN_WORKSPACE_INSTANCE.into(),
                    name: "Main".into(),
                    binding,
                    installation: None,
                    lineage: format!("lineage_{}", uuid::Uuid::new_v4().simple()),
                    activity: 0,
                    state: RuntimeInstanceState::Stopped,
                    last_error: None,
                    last_operation: None,
                    process: None,
                    launch_unconfirmed: false,
                },
            );
        }
        let mut instances = BTreeMap::new();
        for (id, mut item) in saved {
            validate_id(&id)?;
            if id != item.id {
                return Err(storage_error(
                    "Instance identity does not match catalog key",
                ));
            }
            validate_binding(&item.binding)?;
            let version = versions.remove(&id).flatten();
            let persisted = version.as_ref().map(|_| item.clone());
            if matches!(
                item.state,
                RuntimeInstanceState::Starting | RuntimeInstanceState::Stopping
            ) {
                item.state = RuntimeInstanceState::RecoveryRequired;
                item.last_error = Some("The previous lifecycle operation did not confirm completion; inspect its original receipt before continuing".into());
            } else if item.state == RuntimeInstanceState::Ready {
                if item.process.is_some() {
                    item.state = RuntimeInstanceState::Stopped;
                } else {
                    item.state = RuntimeInstanceState::RecoveryRequired;
                    item.launch_unconfirmed = true;
                    item.last_error = Some("The previous R process identity is unavailable; starting a replacement could duplicate live work".into());
                }
            }
            instances.insert(
                id,
                InstanceSlot {
                    stored: item,
                    persisted,
                    version,
                    live: None,
                    archive: None,
                    maintenance: None,
                    query_count: 0,
                    holds: BTreeMap::new(),
                },
            );
        }
        let owner = Arc::new(Self {
            project,
            store,
            app_store,
            journal,
            launcher,
            state: Mutex::new(State {
                instances,
                requests: BTreeMap::new(),
                shutdown: false,
            }),
            transition: Arc::new(tokio::sync::Mutex::new(())),
            native_reads_changed: tokio::sync::Notify::new(),
            opening_cancellations: Mutex::new(BTreeMap::new()),
            gateway: OnceLock::new(),
            windows_online: OnceLock::new(),
            _project_lease: project_lease,
        });
        owner.persist_locked(&mut owner.state.lock().unwrap_or_else(|e| e.into_inner()))?;
        Ok(owner)
    }
    pub(crate) fn project(&self) -> &str {
        &self.project
    }
    fn scope(&self) -> String {
        format!("project:{}", self.project)
    }
    fn persist_locked(&self, state: &mut State) -> Result<(), OperationError> {
        for (id, slot) in &mut state.instances {
            if slot.persisted.as_ref() == Some(&slot.stored) {
                continue;
            }
            let row = self
                .store
                .write_runtime_instance(
                    &self.scope(),
                    &ApplicationState {
                        key: id.clone(),
                        version: slot.version.clone(),
                        value: serde_json::to_value(&slot.stored).map_err(storage_error)?,
                    },
                )
                .map_err(storage_error)?;
            slot.version = row.version;
            slot.persisted = Some(slot.stored.clone());
        }
        Ok(())
    }
    pub(crate) fn bind(
        self: &Arc<Self>,
        gateway: &Arc<OperationGateway>,
        windows_online: Option<WindowProbe>,
    ) {
        let _ = self.gateway.set(Arc::downgrade(gateway));
        if let Some(probe) = windows_online {
            let _ = self.windows_online.set(probe);
        }
        self.start_protection();
    }
    /// Fail-safe: an unobservable window is treated as a window that is watching,
    /// so idle release never ends a session it cannot prove is unattended.
    fn windows_online(&self) -> bool {
        self.windows_online.get().is_none_or(|probe| probe())
    }
    pub(crate) fn window_probe(application: Arc<rho_application::ApplicationOwner>) -> WindowProbe {
        Arc::new(move || {
            let Ok(now) = now() else { return true };
            application
                .any_window_online(&crate::NextHost::local_context(), now.max(0) as u64)
                .unwrap_or(true)
        })
    }
    fn gateway(&self) -> Result<Arc<OperationGateway>, OperationError> {
        self.gateway
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| OperationError::Unavailable("Instance gateway is not composed".into()))
    }

    fn policy_state(
        &self,
        scope: RuntimeSettingsScope,
        instance: Option<&str>,
    ) -> Result<ApplicationState, OperationError> {
        match scope {
            RuntimeSettingsScope::App => self
                .app_store
                .read("user", POLICY_KEY)
                .map_err(storage_error),
            RuntimeSettingsScope::Project => self
                .store
                .read(&self.scope(), POLICY_KEY)
                .map_err(storage_error),
            RuntimeSettingsScope::Instance => self
                .store
                .read(
                    &self.scope(),
                    &format!(
                        "hosting.instance_policy.{}",
                        instance.ok_or_else(|| invalid(
                            "Instance settings require workspace_instance_id"
                        ))?
                    ),
                )
                .map_err(storage_error),
        }
    }
    fn decode_policy(state: &ApplicationState) -> Result<RuntimePolicyOverrides, OperationError> {
        if state.value.is_null() {
            Ok(RuntimePolicyOverrides::default())
        } else {
            serde_json::from_value(state.value.clone()).map_err(storage_error)
        }
    }
    pub(crate) fn settings(
        &self,
        instance: Option<&str>,
    ) -> Result<RuntimeSettings, OperationError> {
        if let Some(id) = instance {
            validate_id(id)?;
        }
        let app = self.policy_state(RuntimeSettingsScope::App, None)?;
        let project = self.policy_state(RuntimeSettingsScope::Project, None)?;
        let local = instance
            .map(|id| self.policy_state(RuntimeSettingsScope::Instance, Some(id)))
            .transpose()?;
        let app_value = Self::decode_policy(&app)?;
        let project_value = Self::decode_policy(&project)?;
        let local_value = local
            .as_ref()
            .map(Self::decode_policy)
            .transpose()?
            .unwrap_or_default();
        let mut value = RuntimePolicy::default();
        app_value.apply_to(&mut value);
        project_value.apply_to(&mut value);
        local_value.apply_to(&mut value);
        validate_policy(&value)?;
        Ok(RuntimeSettings {
            defaults: RuntimePolicy::default(),
            project_storage_bytes: self
                .app_store
                .runtime_storage_usage(&self.project)
                .map_err(storage_error)?
                .0,
            effective: RuntimeEffectivePolicy {
                value,
                app: app_value,
                project: project_value,
                instance: local_value,
            },
            app_version: app.version,
            project_version: project.version,
            instance_version: local.and_then(|p| p.version),
        })
    }
    fn blockers_locked(state: &State, id: &str) -> Vec<RuntimeLifecycleBlocker> {
        let Some(slot) = state.instances.get(id) else {
            return Vec::new();
        };
        let mut blockers: Vec<_> = state
            .requests
            .iter()
            .filter(|(_, request)| {
                request.instance == id && !request.live.runtime.checkpoint_archive_only()
            })
            .map(|(operation, _)| RuntimeLifecycleBlocker {
                kind: "operation".into(),
                reference: operation.as_str().into(),
                label: "An accepted Workspace request still owns this session".into(),
            })
            .collect();
        if slot.query_count > 0 {
            blockers.push(RuntimeLifecycleBlocker {
                kind: "observation".into(),
                reference: id.into(),
                label: "A native observation is still reading this session".into(),
            });
        }
        blockers.extend(slot.holds.values().cloned());
        blockers
    }
    pub(crate) fn instance(&self, id: &str) -> Result<WorkspaceInstance, OperationError> {
        let policy = self.settings(Some(id))?.effective;
        let protection = self.protection_status(id)?;
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get(id)
            .ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))?;
        Ok(WorkspaceInstance {
            workspace_instance_id: id.into(),
            name: slot.stored.name.clone(),
            binding: slot.stored.binding.clone(),
            installation: slot.stored.installation.clone(),
            native_session_id: slot
                .live
                .as_ref()
                .map(|live| live.runtime.session_id().into()),
            continuation_lineage_id: slot.stored.lineage.clone(),
            state: slot.stored.state,
            policy,
            blockers: Self::blockers_locked(&state, id),
            last_error: slot.stored.last_error.clone(),
            last_lifecycle_operation_id: slot.stored.last_operation.clone(),
            protection,
        })
    }
    pub(crate) fn list(
        &self,
        args: &RuntimeInstancesArguments,
    ) -> Result<RuntimeInstances, OperationError> {
        if !(1..=200).contains(&args.limit) {
            return Err(invalid("Instance page limit must be 1..=200"));
        }
        if let Some(id) = &args.after_instance_id {
            validate_id(id)?;
        }
        let mut ids: Vec<_> = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .keys()
            .cloned()
            .collect();
        // Main leads the public catalog. The same composite order applies to
        // continuation cursors, including a page ending at Main.
        let key = |id: &str| (id != MAIN_WORKSPACE_INSTANCE, id.to_owned());
        ids.sort_by_key(|id| key(id));
        let mut instances = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for id in ids.iter().filter(|id| {
            args.after_instance_id
                .as_ref()
                .is_none_or(|after| key(id) > key(after))
        }) {
            let instance = self.instance(id)?;
            let cost = serde_json::to_vec(&instance).map_err(storage_error)?.len();
            if instances.len() >= args.limit as usize
                || (!instances.is_empty() && bytes + cost > 768 * 1024)
            {
                more = true;
                break;
            }
            if cost > 768 * 1024 {
                return Err(OperationError::BudgetExceeded(
                    "Instance settings exceed the observation bound".into(),
                ));
            }
            bytes += cost;
            instances.push(instance);
        }
        let next_after_instance_id = if more {
            instances
                .last()
                .map(|instance| instance.workspace_instance_id.clone())
        } else {
            None
        };
        Ok(RuntimeInstances {
            default_workspace_instance_id: ids
                .iter()
                .find(|id| id.as_str() == MAIN_WORKSPACE_INSTANCE)
                .cloned()
                .or_else(|| ids.first().cloned()),
            total: ids.len() as u64,
            instances,
            next_after_instance_id,
        })
    }
    pub(crate) fn targets(&self) -> Vec<TargetRef> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .values()
            .filter(|slot| slot.stored.state == RuntimeInstanceState::Ready)
            .filter_map(|slot| slot.live.as_ref())
            .filter(|live| live.runtime.runtime_status().state != "unavailable")
            .map(|live| TargetRef {
                kind: "workspace".into(),
                identity: live.runtime.session_id().into(),
            })
            .collect()
    }
    pub(crate) fn workspace_for_native(&self, native: &str) -> Option<Arc<WorkspaceRunHandler>> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .values()
            .filter_map(|slot| slot.live.as_ref())
            .find(|live| live.runtime.session_id() == native)
            .map(|live| live.workspace.clone())
    }
    pub(crate) fn capture_available(&self, id: &str) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(id)
            .is_some_and(|slot| {
                slot.stored.state == RuntimeInstanceState::Ready
                    && slot
                        .live
                        .as_ref()
                        .is_some_and(|live| live.checkpoint.capture_available())
            })
    }
    pub(crate) fn acquire_hold(
        self: &Arc<Self>,
        id: &str,
        native: &str,
        reference: &str,
        label: &str,
    ) -> Result<RuntimeInstanceHold, OperationError> {
        if reference.len() > 160
            || label.len() > 1024
            || reference.chars().any(char::is_control)
            || label.chars().any(char::is_control)
        {
            return Err(invalid("Runtime hold metadata exceeds its bounds"));
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown {
            return Err(OperationError::Unavailable(
                "The project Host is stopping".into(),
            ));
        }
        let slot = state
            .instances
            .get_mut(id)
            .ok_or_else(|| OperationError::NotFound(id.into()))?;
        if slot.stored.state != RuntimeInstanceState::Ready
            || slot.live.as_ref().map(|live| live.runtime.session_id()) != Some(native)
        {
            return Err(OperationError::StaleSession(
                "The Agent's captured R target is no longer ready".into(),
            ));
        }
        let key = format!("hold_{}", uuid::Uuid::new_v4().simple());
        slot.holds.insert(
            key.clone(),
            RuntimeLifecycleBlocker {
                kind: "attachment".into(),
                reference: reference.into(),
                label: label.into(),
            },
        );
        Ok(RuntimeInstanceHold {
            owner: Arc::downgrade(self),
            instance: id.into(),
            key,
        })
    }
    pub(crate) fn resolve_live(
        &self,
        id: &str,
        capability: &str,
    ) -> Result<Arc<InstanceLive>, OperationError> {
        if archive_capability(capability) {
            return self.archive(id);
        }
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown {
            return Err(OperationError::Unavailable(
                "The project Host is stopping".into(),
            ));
        }
        let slot = state
            .instances
            .get(id)
            .ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))?;
        if slot.stored.state != RuntimeInstanceState::Ready
            && !capability.starts_with("workspace.checkpoint")
            && capability != "workspace.runtime_status"
        {
            return Err(OperationError::Unavailable(format!(
                "R instance {id} is {:?}; inspect runtime.instance",
                slot.stored.state
            )));
        }
        slot.live.clone().ok_or_else(|| OperationError::Unavailable(format!("R instance {id} has no running process; continuing it is an explicit lifecycle operation")))
    }
    pub(crate) fn admit_operation(
        &self,
        id: &str,
        operation: &Operation,
    ) -> Result<Arc<InstanceLive>, HandlerError> {
        if !operation.capability.id.starts_with("workspace.checkpoint") {
            self.request_protection_yield(id);
        }
        let archived = archive_capability(&operation.capability.id);
        let archive = if archived {
            Some(self.archive(id).map_err(before)?)
        } else {
            None
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown {
            return Err(before("The project Host is stopping"));
        }
        let slot = state
            .instances
            .get_mut(id)
            .ok_or_else(|| before("The R instance no longer exists"))?;
        let maintenance = slot
            .maintenance
            .as_ref()
            .is_some_and(|id| operation.causation_id.as_ref() == Some(id))
            && operation.capability.id.starts_with("workspace.checkpoint");
        if slot.stored.state != RuntimeInstanceState::Ready && !maintenance && !archived {
            return Err(before("The R instance is not ready for analysis execution"));
        }
        let live = if let Some(archive) = archive {
            archive
        } else {
            slot.live
                .clone()
                .ok_or_else(|| before("The R instance has no process"))?
        };
        if operation.target.kind == "workspace"
            && live.runtime.session_id() != operation.target.identity
        {
            return Err(before("The native R session changed before admission"));
        }
        state.requests.insert(
            operation.operation_id.clone(),
            AdmittedRequest {
                instance: id.into(),
                live: live.clone(),
            },
        );
        Ok(live)
    }
    pub(crate) fn operation_live(&self, id: &OperationId) -> Option<Arc<InstanceLive>> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .requests
            .get(id)
            .map(|request| request.live.clone())
    }
    pub(crate) fn operation_hold(self: &Arc<Self>, id: OperationId) -> RequestHold {
        RequestHold {
            owner: Arc::downgrade(self),
            kind: Some(HoldKind::Operation(id)),
            mark_activity: false,
        }
    }
    pub(crate) fn release_operation(&self, id: &OperationId, activity: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(request) = state.requests.remove(id)
            && activity
        {
            let boundary = request.live.activity.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(slot) = state.instances.get_mut(&request.instance) {
                slot.stored.activity = boundary;
            }
            if let Err(error) = self.persist_locked(&mut state)
                && let Some(slot) = state.instances.get_mut(&request.instance)
            {
                slot.stored.last_error = Some(format!(
                    "The activity boundary could not be persisted: {error}"
                ));
            }
        }
    }
    pub(crate) fn admit_query(
        self: &Arc<Self>,
        id: &str,
        capability: &str,
    ) -> Result<(Arc<InstanceLive>, RequestHold), OperationError> {
        if archive_capability(capability) {
            return Ok((
                self.archive(id)?,
                RequestHold {
                    owner: Arc::downgrade(self),
                    kind: None,
                    mark_activity: false,
                },
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get_mut(id)
            .ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))?;
        if slot.stored.state == RuntimeInstanceState::Stopping {
            return Err(OperationError::Unavailable(
                "This R session is stopping; its last observation remains available".into(),
            ));
        }
        if slot.stored.state != RuntimeInstanceState::Ready
            && !capability.starts_with("workspace.checkpoint")
            && capability != "workspace.runtime_status"
        {
            return Err(OperationError::Unavailable(
                "This R instance is not ready for native observations".into(),
            ));
        }
        let live = slot.live.clone().ok_or_else(|| {
            OperationError::Unavailable(
                "This R instance is stopped; reading does not start it".into(),
            )
        })?;
        slot.query_count += 1;
        Ok((
            live,
            RequestHold {
                owner: Arc::downgrade(self),
                kind: Some(HoldKind::Query(id.into())),
                mark_activity: false,
            },
        ))
    }
    pub(crate) fn begin_shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.shutdown = true;
        for slot in state.instances.values() {
            if let Some(live) = &slot.live {
                live.workspace.begin_shutdown();
            }
        }
    }
    pub(crate) async fn seal_stopped_sessions(&self) -> Result<(), OperationError> {
        let _transition = self.transition.clone().lock_owned().await;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.requests.is_empty()
            || state.instances.values().any(|slot| {
                slot.live.is_some()
                    || slot.stored.process.is_some()
                    || slot.stored.launch_unconfirmed
            })
        {
            return Err(OperationError::Unavailable(
                "Stop all local R sessions and confirm their termination before quitting Workbench"
                    .into(),
            ));
        }
        state.shutdown = true;
        Ok(())
    }
    /// An exiting Host owns the R processes it started. Leaving them running strands
    /// the project: the recorded receipt correctly blocks a replacement, and an
    /// orphaned native process can never be reattached. Receipts are cleared only
    /// where termination was confirmed, so an uncertain stop keeps its evidence.
    pub(crate) async fn shutdown_instances(&self) {
        let live: Vec<(String, Arc<InstanceLive>)> = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .instances
                .iter()
                .filter_map(|(id, slot)| Some((id.clone(), slot.live.clone()?)))
                .collect()
        };
        for (id, live) in live {
            // A confirmed stop is refused while an observation or execution lease still
            // references the native client, so give transient leases a bounded moment
            // to drain instead of stranding the instance in RecoveryRequired.
            let mut stopped = false;
            for _ in 0..50 {
                match live.runtime.shutdown().await {
                    Ok(()) => {
                        stopped = true;
                        break;
                    }
                    Err(error) if error.effect_may_have_occurred => break,
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(slot) = state.instances.get_mut(&id) {
                slot.live = None;
                slot.maintenance = None;
                if stopped {
                    slot.stored.process = None;
                    slot.stored.launch_unconfirmed = false;
                    slot.stored.state = RuntimeInstanceState::Stopped;
                } else {
                    slot.stored.state = RuntimeInstanceState::RecoveryRequired;
                }
            }
            let _ = self.persist_locked(&mut state);
        }
    }
    /// The library bound to the project's default instance. A managed Host has no
    /// single workspace library, so the Environment owner resolves it on observation.
    pub(crate) fn active_library(&self) -> Option<String> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .instances
            .get(MAIN_WORKSPACE_INSTANCE)
            .or_else(|| state.instances.values().next())
            .and_then(|slot| slot.stored.binding.library_path.clone())
    }
    pub(crate) async fn protected_libraries(&self) -> Result<Vec<String>, String> {
        let (runtimes, mut bindings): (Vec<_>, Vec<_>) = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            (
                state
                    .instances
                    .values()
                    .filter_map(|slot| slot.live.as_ref().map(|live| live.runtime.clone()))
                    .collect(),
                state
                    .instances
                    .values()
                    .map(|slot| slot.stored.binding.clone())
                    .collect(),
            )
        };
        let mut paths = BTreeSet::new();
        for runtime in runtimes {
            paths.extend(
                rho_environment::EnvironmentUsage::protected_paths(&crate::usage::WorkspaceUsage(
                    runtime,
                ))
                .await?,
            );
        }
        // Stored recovery points keep their original libraries even after every R
        // process stopped or an instance was rebound. Reservation identities avoid
        // an unbounded filesystem scan and the Workspace owner verifies retention.
        let mut after = None;
        for page_index in 0..20 {
            let page =
                self.app_store
                    .runtime_storage_records(&self.project, after.as_deref(), 200)?;
            for (id, _, bytes, reserved) in &page {
                if *bytes == 0 && !reserved {
                    continue;
                }
                let record = self
                    .journal
                    .get(&OperationId::new(id).map_err(|e| e.to_string())?)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("A recovery storage reservation has no original operation")?;
                if record.status != OperationStatus::Succeeded {
                    return Err("Recovery storage still has an unconfirmed capture; its environment references cannot be discarded".into());
                }
                let manifest: CheckpointManifest = serde_json::from_value(
                    record
                        .output
                        .clone()
                        .ok_or("Recovery storage has no committed manifest")?,
                )
                .map_err(|e| e.to_string())?;
                let archive = self
                    .archive(&manifest.workspace_instance_id)
                    .map_err(|e| e.to_string())?;
                // Cleanup protects all retained references. This internal context is
                // bound to each original principal; no other principal's data is exposed.
                if let Some(manifest) = archive
                    .checkpoint
                    .retained_manifest_for(&Self::internal_context(&record.operation), manifest)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    paths.extend(manifest.report.library_paths);
                    if let Some(binding) = manifest.runtime_binding {
                        bindings.push(binding);
                    }
                }
            }
            if page.len() < 200 {
                break;
            }
            if page_index == 19 {
                return Err(
                    "Recovery reference observation reached its bound; cleanup remains blocked"
                        .into(),
                );
            }
            after = page.last().map(|row| row.0.clone());
        }
        // Dormant logical sessions still need their recorded dependency realization to continue.
        for binding in bindings {
            if let Some(path) = binding.library_path {
                paths.insert(path);
            }
            if let Some(id) = binding.environment_realization_id {
                let record = self
                    .journal
                    .get(&OperationId::new(&id).map_err(|e| e.to_string())?)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| {
                        "An instance's recorded Environment receipt is missing".to_string()
                    })?;
                if record.status != OperationStatus::Succeeded
                    || record.operation.capability.id != rho_environment::REALIZE_CAPABILITY
                {
                    return Err("An instance's Environment receipt is no longer valid".into());
                }
                let receipt: rho_environment::EnvironmentRealization = serde_json::from_value(
                    record
                        .output
                        .ok_or("An instance's Environment has no realization output")?,
                )
                .map_err(|e| e.to_string())?;
                paths.insert(receipt.library_path);
            }
        }
        Ok(paths.into_iter().collect())
    }
    fn make_live(
        &self,
        runtime: Arc<dyn WorkspaceRuntime>,
        stored: &StoredInstance,
    ) -> Result<Arc<InstanceLive>, OperationError> {
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let workspace = Arc::new(WorkspaceRunHandler::with_lane(
            runtime.clone(),
            lane.clone(),
        ));
        let activity = Arc::new(AtomicU64::new(stored.activity));
        let checkpoint = Arc::new(WorkspaceCheckpointOwner::new(
            runtime.clone(),
            lane,
            self.journal.clone(),
            stored.id.clone(),
            stored.lineage.clone(),
            activity.clone(),
        ));
        checkpoint.set_scientific_queue(workspace.checkpoint_queue());
        checkpoint.set_budget(self.checkpoint_budget(&stored.id)?);
        checkpoint.set_capture_context(
            stored.binding.environment_realization_id.clone(),
            stored.activity,
        );
        checkpoint.set_launch_binding(stored.binding.clone());
        let registry =
            workspace_registry(workspace.clone(), checkpoint.clone(), self.journal.clone())?;
        Ok(Arc::new(InstanceLive {
            runtime,
            workspace,
            registry,
            activity,
            checkpoint,
        }))
    }
    fn archive(&self, id: &str) -> Result<Arc<InstanceLive>, OperationError> {
        let stored = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state
                .instances
                .get(id)
                .ok_or_else(|| OperationError::NotFound(id.into()))?;
            if let Some(archive) = &slot.archive {
                return Ok(archive.clone());
            }
            slot.stored.clone()
        };
        let runtime = self.launcher.archive_runtime()?.ok_or_else(|| {
            OperationError::Unavailable("This runtime provider has no checkpoint archive".into())
        })?;
        let archive = self.make_live(runtime, &stored)?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get_mut(id)
            .ok_or_else(|| OperationError::NotFound(id.into()))?;
        if slot.stored.lineage != stored.lineage {
            return Err(OperationError::StaleSession(
                "The instance lineage changed while opening its archive".into(),
            ));
        }
        slot.archive = Some(archive.clone());
        Ok(archive)
    }
    pub(crate) fn prototype(&self) -> Result<CapabilityRegistry, OperationError> {
        let stored = StoredInstance {
            id: MAIN_WORKSPACE_INSTANCE.into(),
            name: "Main".into(),
            binding: RuntimeLaunchBinding {
                r_executable: "/schema/R".into(),
                ark_executable: "/schema/ark".into(),
                environment_realization_id: None,
                library_path: None,
                checkpoint_helper_path: None,
            },
            installation: None,
            lineage: "schema-lineage".into(),
            activity: 0,
            state: RuntimeInstanceState::Stopped,
            last_error: None,
            last_operation: None,
            process: None,
            launch_unconfirmed: false,
        };
        let runtime = Arc::new(SchemaRuntime {
            project: self.project.clone(),
        });
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        let workspace = Arc::new(WorkspaceRunHandler::with_lane(
            runtime.clone(),
            lane.clone(),
        ));
        let checkpoint = Arc::new(WorkspaceCheckpointOwner::new(
            runtime,
            lane,
            self.journal.clone(),
            stored.id,
            stored.lineage,
            Arc::new(AtomicU64::new(0)),
        ));
        workspace_registry(workspace, checkpoint, self.journal.clone())
    }
}

enum HoldKind {
    Operation(OperationId),
    Query(String),
}
/// An active consumer holds one exact native session; idle transport connections do not.
pub struct RuntimeInstanceHold {
    owner: Weak<InstanceOwner>,
    instance: String,
    key: String,
}
impl Drop for RuntimeInstanceHold {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade()
            && let Some(slot) = owner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .instances
                .get_mut(&self.instance)
        {
            slot.holds.remove(&self.key);
        }
    }
}
pub(crate) struct RequestHold {
    owner: Weak<InstanceOwner>,
    kind: Option<HoldKind>,
    pub mark_activity: bool,
}
impl RequestHold {
    pub(crate) fn release(&mut self) {
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        match self.kind.take() {
            Some(HoldKind::Operation(id)) => owner.release_operation(&id, self.mark_activity),
            Some(HoldKind::Query(id)) => {
                let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(slot) = state.instances.get_mut(&id) {
                    slot.query_count = slot.query_count.saturating_sub(1);
                }
                owner.native_reads_changed.notify_one();
            }
            None => (),
        }
    }
}
impl Drop for RequestHold {
    fn drop(&mut self) {
        self.release();
    }
}

struct SchemaRuntime {
    project: String,
}
#[async_trait]
impl WorkspaceRuntime for SchemaRuntime {
    fn session_id(&self) -> &str {
        "schema-only"
    }
    fn project_root(&self) -> Option<&str> {
        Some(&self.project)
    }
    async fn execute(
        &self,
        _: &Operation,
        _: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        Err(WorkspaceRuntimeError::before_effect(
            "Schema prototypes cannot execute",
        ))
    }
}

fn workspace_registry(
    workspace: Arc<WorkspaceRunHandler>,
    checkpoint: Arc<WorkspaceCheckpointOwner>,
    journal: Arc<dyn OperationJournal>,
) -> Result<CapabilityRegistry, OperationError> {
    let mut registry = CapabilityRegistry::new();
    registry.register(workspace.clone())?;
    for check in [false, true] {
        registry.register_query(Arc::new(ConsoleQueryHandler::new(workspace.clone(), check)))?;
    }
    for pause in [false, true] {
        registry.register(Arc::new(QueueControlHandler::new(workspace.clone(), pause)))?;
    }
    registry.register_query(Arc::new(WorkspaceOutputHandler::new(
        workspace.clone(),
        Arc::new(JournalRecords(journal)),
        OutputQueryKind::Status,
    )))?;
    for kind in [
        WorkspaceToolKind::Help,
        WorkspaceToolKind::Lint,
        WorkspaceToolKind::Format,
    ] {
        registry.register(Arc::new(WorkspaceToolHandler::new(workspace.clone(), kind)))?;
    }
    for kind in [
        WorkspaceQueryKind::Snapshot,
        WorkspaceQueryKind::Packages,
        WorkspaceQueryKind::InspectObject,
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
    register_checkpoint_handlers(&mut registry, checkpoint)?;
    Ok(registry)
}

fn validate_binding(binding: &RuntimeLaunchBinding) -> Result<(), OperationError> {
    for value in [&binding.r_executable, &binding.ark_executable] {
        if value.len() > 4096
            || !Path::new(value).is_absolute()
            || value.chars().any(char::is_control)
        {
            return Err(invalid(
                "Runtime executable paths must be absolute, bounded and contain no control characters",
            ));
        }
    }
    if let Some(id) = &binding.environment_realization_id {
        OperationId::new(id)?;
    }
    if let Some(path) = &binding.library_path {
        if !Path::new(path).is_absolute() || path.len() > 4096 || path.chars().any(char::is_control)
        {
            return Err(invalid("Library paths must be absolute and bounded"));
        }
        if binding.environment_realization_id.is_some() {
            return Err(invalid(
                "A verified Environment binding owns its library path; do not also specify a library override",
            ));
        }
    }
    if let Some(path) = &binding.checkpoint_helper_path
        && (!Path::new(path).is_absolute()
            || path.len() > 4096
            || path.chars().any(char::is_control))
    {
        return Err(invalid(
            "The checkpoint component must be an absolute bounded path",
        ));
    }
    Ok(())
}
fn prepared_checkpoint_helper(
    binding: &RuntimeLaunchBinding,
    installation: &RuntimeInstallationIdentity,
) -> Result<Option<String>, OperationError> {
    use std::io::Read;
    let (candidate, discovered_root) = if let Some(path) = &binding.checkpoint_helper_path {
        (Some(PathBuf::from(path)), None)
    } else {
        let key = format!("{}-{}", installation.r_version, installation.platform);
        if key.len() > 200
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err(invalid("R returned an invalid native component identity"));
        }
        let root = Path::new(&binding.ark_executable)
            .parent()
            .ok_or_else(|| invalid("Ark has no parent directory"))?
            .join("recovery-components")
            .join(key);
        let manifest = root.join("manifest.json");
        if !manifest.exists() {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&manifest)
            .map_err(storage_error)?
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(storage_error)?;
        if bytes.len() > 8192 {
            return Err(invalid(
                "The native recovery component manifest exceeds 8 KiB",
            ));
        }
        let metadata: Value = serde_json::from_slice(&bytes).map_err(invalid)?;
        let path = metadata
            .get("library")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("The recovery component manifest has no library path"))?;
        (Some(PathBuf::from(path)), Some(root))
    };
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let verified =
        rho_r_runtime::verify_checkpoint_helper(&candidate, Path::new(&installation.r_home))
            .map_err(OperationError::Unavailable)?;
    if let Some(root) = discovered_root
        && !verified.starts_with(root.canonicalize().map_err(storage_error)?)
    {
        return Err(invalid(
            "A discovered recovery component escaped its installation directory",
        ));
    }
    let manifest = verified.parent().unwrap().join("manifest.json");
    let mut bytes = Vec::new();
    std::fs::File::open(manifest)
        .map_err(storage_error)?
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(storage_error)?;
    if bytes.len() > 8192 {
        return Err(invalid(
            "The native recovery component manifest exceeds 8 KiB",
        ));
    }
    let metadata: Value = serde_json::from_slice(&bytes).map_err(invalid)?;
    if metadata["r_version"].as_str() != Some(installation.r_version.as_str())
        || metadata["platform"].as_str() != Some(installation.platform.as_str())
    {
        return Err(OperationError::Unavailable(
            "The recovery component does not match this R version and platform".into(),
        ));
    }
    Ok(Some(verified.to_string_lossy().into_owned()))
}
fn archive_capability(id: &str) -> bool {
    matches!(
        id,
        "workspace.checkpoints"
            | "workspace.checkpoint_pin"
            | "workspace.checkpoint_delete"
            | "workspace.checkpoint_reconcile"
    )
}
fn validate_policy(policy: &RuntimePolicy) -> Result<(), OperationError> {
    for names in [&policy.include_names, &policy.exclude_names] {
        if names.len() > 256
            || names.iter().any(|value| {
                value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
            })
        {
            return Err(invalid(
                "Object selection lists allow at most 256 nonempty names/patterns of 256 bytes each",
            ));
        }
    }
    for patterns in [&policy.include_patterns, &policy.exclude_patterns] {
        if patterns.len() > 32
            || patterns.iter().any(|value| {
                value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control)
            })
        {
            return Err(invalid(
                "Object selection allows at most 32 glob patterns of 1024 bytes each",
            ));
        }
    }
    if policy.idle_delay_seconds == 0
        || policy.automatic_interval_seconds == 0
        || policy.capture_budget_ms == 0
        || policy.capture_budget_ms > 60_000
        || policy.recent_checkpoints == 0
        || policy.recent_checkpoints > 100
        || policy.daily_retention_days > 365
        || policy.max_running_instances == 0
        || policy.max_running_instances > 32
        || policy.automatic_payload_limit_bytes == 0
        || policy.project_storage_limit_bytes == 0
        || policy.global_storage_limit_bytes < policy.project_storage_limit_bytes
    {
        return Err(invalid(
            "Runtime policy bounds are invalid (1–32 running sessions, 1–100 recent checkpoints, at most 365 days and a project quota no larger than the global quota)",
        ));
    }
    Ok(())
}

impl InstanceOwner {
    fn stored_instance(&self, id: &str) -> Result<StoredInstance, OperationError> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(id)
            .map(|slot| slot.stored.clone())
            .ok_or_else(|| OperationError::NotFound(format!("R instance {id}")))
    }
    fn change_state(
        &self,
        id: &str,
        status: RuntimeInstanceState,
        operation: &OperationId,
        error: Option<String>,
    ) -> Result<(), OperationError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get_mut(id)
            .ok_or_else(|| OperationError::NotFound(id.into()))?;
        slot.stored.state = status;
        slot.stored.last_error = error;
        slot.stored.last_operation = Some(operation.as_str().into());
        if matches!(
            status,
            RuntimeInstanceState::Ready | RuntimeInstanceState::Stopped
        ) {
            slot.stored.launch_unconfirmed = false;
        }
        slot.maintenance = matches!(
            status,
            RuntimeInstanceState::Starting | RuntimeInstanceState::Stopping
        )
        .then(|| operation.clone());
        self.persist_locked(&mut state)
    }
    fn record_launch_boundary(&self, id: &str) -> Result<(), OperationError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get_mut(id)
            .ok_or_else(|| OperationError::NotFound(id.into()))?;
        slot.stored.launch_unconfirmed = true;
        self.persist_locked(&mut state)
    }
    fn check_capacity(&self, id: &str) -> Result<(), OperationError> {
        let limit = self
            .settings(Some(id))?
            .effective
            .value
            .max_running_instances;
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .instances
            .values()
            .filter(|slot| slot.live.is_some())
            .count()
            >= limit as usize
        {
            return Err(OperationError::BudgetExceeded(format!(
                "{limit} R sessions are already running; stop a session before starting another"
            )));
        }
        Ok(())
    }
    fn require_quiet(&self, id: &str, expected: &str) -> Result<(), OperationError> {
        self.require_idle(id, expected, false)
    }
    fn require_idle(
        &self,
        id: &str,
        expected: &str,
        allow_reads: bool,
    ) -> Result<(), OperationError> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get(id)
            .ok_or_else(|| OperationError::NotFound(id.into()))?;
        let actual = slot.live.as_ref().map(|live| live.runtime.session_id());
        if actual != Some(expected) {
            return Err(OperationError::StaleSession(format!(
                "Expected {expected}; this logical instance now has a different native session"
            )));
        }
        let blockers: Vec<_> = Self::blockers_locked(&state, id)
            .into_iter()
            .filter(|blocker| !allow_reads || blocker.kind != "observation")
            .collect();
        if !blockers.is_empty() {
            return Err(OperationError::Unavailable(format!(
                "The session is in use: {}; inspect runtime.instance for its owners",
                blockers
                    .iter()
                    .map(|blocker| blocker.label.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        Ok(())
    }
    fn begin_stop(
        &self,
        id: &str,
        expected: &str,
        operation: &OperationId,
    ) -> Result<RuntimeInstanceState, OperationError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let slot = state
            .instances
            .get(id)
            .ok_or_else(|| OperationError::NotFound(id.into()))?;
        if slot.live.as_ref().map(|live| live.runtime.session_id()) != Some(expected) {
            return Err(OperationError::StaleSession(
                "The target native R session changed".into(),
            ));
        }
        if Self::blockers_locked(&state, id)
            .iter()
            .any(|blocker| blocker.kind != "observation")
        {
            return Err(OperationError::Unavailable(
                "This R session is still in use; inspect runtime.instance for its blockers".into(),
            ));
        }
        let slot = state.instances.get_mut(id).unwrap();
        let previous = slot.stored.state;
        slot.stored.state = RuntimeInstanceState::Stopping;
        slot.maintenance = Some(operation.clone());
        slot.stored.last_operation = Some(operation.as_str().into());
        slot.stored.last_error = None;
        self.persist_locked(&mut state)?;
        Ok(previous)
    }
    async fn drain_native_reads(&self, id: &str) -> Result<(), OperationError> {
        // Stopping fences new readers. Await actual release of already admitted
        // reads, rather than making routine UI refreshes randomly reject a stop.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let changed = self.native_reads_changed.notified();
                let count = self
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .instances
                    .get(id)
                    .map_or(0, |slot| slot.query_count);
                if count == 0 {
                    break;
                }
                changed.await;
            }
        })
        .await
        .map_err(|_| {
            OperationError::Unavailable(
                "A native observation did not finish; this R session remains open".into(),
            )
        })
    }
    fn internal_context(operation: &Operation) -> CallContext {
        CallContext {
            caller: operation.caller.clone(),
            principal: operation.principal.clone(),
            scopes: BTreeSet::from([
                WORKSPACE_READ_SCOPE.into(),
                RUN_R_SCOPE.into(),
                "operation.read".into(),
            ]),
            connection_id: "host:runtime-lifecycle".into(),
            correlation_id: Some(operation.correlation_id.clone()),
            causation_id: Some(operation.operation_id.clone()),
            trace_parent: operation.trace_parent.clone(),
        }
    }
    async fn child_operation(
        &self,
        parent: &Operation,
        suffix: &str,
        id: &str,
        capability: &str,
        mut arguments: Value,
    ) -> Result<OperationRecord, OperationError> {
        arguments["workspace_instance_id"] = json!(id);
        let request = Invocation {
            client_request_id: format!("{}:{suffix}", parent.operation_id.as_str()),
            capability: CapabilityRef::new(capability, 1)?,
            arguments,
            preconditions: vec![],
        };
        let cancellation = self
            .opening_cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&parent.operation_id)
            .cloned();
        let gateway = self.gateway()?;
        let context = Self::internal_context(parent);
        let Some(mut cancellation) = cancellation else {
            return gateway.invoke(&context, request).await;
        };
        let (accepted, receipt) = tokio::sync::oneshot::channel();
        let invocation = gateway.invoke_notifying(&context, request, Some(accepted));
        tokio::pin!(invocation);
        let forward = async {
            if let Ok(record) = receipt.await {
                wait_cancellation(&mut cancellation).await;
                // Continue observing the exact child after forwarding cancellation.
                let _ = gateway
                    .request_cancellation(&context, &record.operation.operation_id)
                    .await;
            }
        };
        tokio::select! { result = &mut invocation => result, _ = forward => invocation.await }
    }
    fn check_opening(&self, operation: &Operation) -> Result<(), OperationError> {
        let cancelled = self
            .opening_cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&operation.operation_id)
            .is_some_and(|receiver| *receiver.borrow());
        if cancelled {
            Err(OperationError::Unavailable(
                "Opening cancelled; the original recovery copy is retained".into(),
            ))
        } else {
            Ok(())
        }
    }
    async fn protect_before_stop(
        &self,
        operation: &Operation,
        id: &str,
        native: &str,
        discard: bool,
    ) -> Result<(), OperationError> {
        if discard {
            return Ok(());
        }
        let stored = self.stored_instance(id)?;
        if stored.activity == 0 {
            return Ok(());
        }
        let policy = self.settings(Some(id))?.effective.value;
        if policy.mode == RuntimeContinuationMode::Off {
            return Err(OperationError::Unavailable("Object protection is off. Explicitly choose to discard unsaved objects before ending this session".into()));
        }
        let result = self.child_operation(operation, "protect", id, "workspace.checkpoint_capture", json!({
            "expected_session": native, "automatic": false,
            "max_bytes": policy.automatic_payload_limit_bytes, "max_seconds": f64::from(policy.capture_budget_ms) / 1000.0,
            "include_names": if policy.object_selection == CheckpointObjectSelection::Selected { Some(&policy.include_names) } else { None },
            "exclude_names": policy.exclude_names,
            "include_patterns": if policy.object_selection == CheckpointObjectSelection::Selected { policy.include_patterns } else { vec![] }, "exclude_patterns": policy.exclude_patterns,
        })).await?;
        if result.status != OperationStatus::Succeeded {
            return Err(OperationError::Unavailable(format!(
                "Objects were not completely saved; this R session remains open. {}",
                result
                    .error
                    .unwrap_or_else(|| "Inspect the checkpoint operation".into())
            )));
        }
        let manifest: CheckpointManifest = serde_json::from_value(
            result
                .output
                .ok_or_else(|| stored_error("Checkpoint capture returned no manifest"))?,
        )
        .map_err(storage_error)?;
        let protected_selection = manifest.report.coverage
            == CheckpointCoverage::CompleteEligibleGraph
            && manifest.report.skipped.is_empty()
            || !manifest.report.skipped.is_empty()
                && manifest
                    .report
                    .skipped
                    .iter()
                    .all(|binding| binding.reason == "excluded_by_policy");
        if !protected_selection {
            return Err(OperationError::Unavailable(format!(
                "The recovery point saved supported objects but skipped {} binding(s); this R session remains open until the remaining loss is explicitly accepted",
                manifest.report.skipped.len()
            )));
        }
        Ok(())
    }
    async fn launch_candidate(
        &self,
        operation: &Operation,
        stored: &StoredInstance,
        prepared: PreparedInstanceLaunch,
        restore: bool,
    ) -> Result<WorkspaceInstance, OperationError> {
        self.check_capacity(&stored.id)?;
        self.record_launch_boundary(&stored.id)?;
        let actual_binding = prepared.binding.clone();
        let launched = self.launcher.launch(prepared).await?;
        let candidate = StoredInstance {
            binding: actual_binding.clone(),
            ..stored.clone()
        };
        let live = self.make_live(launched.runtime, &candidate)?;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state
                .instances
                .get_mut(&stored.id)
                .ok_or_else(|| OperationError::NotFound(stored.id.clone()))?;
            slot.stored.installation = Some(launched.installation);
            slot.stored.binding = actual_binding;
            slot.stored.process = live.runtime.process_identity();
            slot.live = Some(live.clone());
            // The candidate is visible for diagnostics/checkpoint recovery, never for analysis.
            slot.stored.state = RuntimeInstanceState::Starting;
            slot.maintenance = Some(operation.operation_id.clone());
            self.persist_locked(&mut state)?;
        }
        self.check_opening(operation)?;
        let mut restoration_notice = None;
        if restore {
            let context = Self::internal_context(operation);
            let latest = live.checkpoint.latest_for(&context).await?;
            if let Some(entry) = latest {
                let record = self.child_operation(operation, "restore", &stored.id, "workspace.checkpoint_restore", json!({
                    "expected_session": live.runtime.session_id(), "checkpoint_id": entry.manifest.checkpoint_id,
                })).await?;
                if record.status != OperationStatus::Succeeded {
                    return Err(OperationError::Unavailable(format!(
                        "The saved objects could not be restored. The candidate is held for recovery; analysis has not resumed. {}",
                        record.error.unwrap_or_default()
                    )));
                }
                let restored_boundary = entry.manifest.activity_boundary;
                live.activity.store(restored_boundary, Ordering::SeqCst);
                {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.instances.get_mut(&stored.id).unwrap().stored.activity =
                        restored_boundary;
                }
                if restored_boundary < stored.activity || !entry.manifest.report.skipped.is_empty()
                {
                    restoration_notice = Some(format!(
                        "Restored {} saved object(s); {} excluded binding(s) still need attention.{}",
                        entry.saved_count,
                        entry.skipped_count,
                        if restored_boundary < stored.activity {
                            " Changes made after this recovery point are not present in this R session."
                        } else {
                            ""
                        }
                    ));
                }
            } else if stored.activity > 0 {
                // This candidate was launched only to restore into it and was never
                // published for analysis, so keeping it alive would only block the
                // explicit remedy this refusal is about to offer.
                self.release_candidate(&stored.id, &live).await;
                return Err(OperationError::Unavailable("The previous session had activity but no available checkpoint in this continuation lineage. Continue with start_empty to begin an empty session, or restore an earlier recovery point explicitly".into()));
            }
        }
        self.check_opening(operation)?;
        self.change_state(
            &stored.id,
            RuntimeInstanceState::Ready,
            &operation.operation_id,
            restoration_notice,
        )?;
        self.instance(&stored.id)
    }
    /// End a candidate that was launched only to restore into it. Its receipt is
    /// cleared only once termination is confirmed, so an uncertain stop still leaves
    /// the evidence a later Host must check before starting a replacement.
    async fn release_candidate(&self, id: &str, live: &InstanceLive) -> bool {
        let stopped = live.runtime.shutdown().await.is_ok();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = state.instances.get_mut(id) {
            slot.live = None;
            slot.maintenance = None;
            if stopped {
                slot.stored.process = None;
                slot.stored.launch_unconfirmed = false;
            }
        }
        stopped && self.persist_locked(&mut state).is_ok()
    }
    async fn create(
        &self,
        operation: &Operation,
        arguments: CreateRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        let prepared = self.launcher.prepare(&arguments.binding).await?;
        self.check_opening(operation)?;
        let id = format!("instance_{}", operation.operation_id.as_str());
        validate_id(&id)?;
        let stored = StoredInstance {
            id: id.clone(),
            name: arguments.name,
            binding: prepared.binding.clone(),
            installation: Some(prepared.installation.clone()),
            lineage: format!("lineage_{}", operation.operation_id.as_str()),
            activity: 0,
            state: if arguments.start {
                RuntimeInstanceState::Starting
            } else {
                RuntimeInstanceState::Stopped
            },
            last_error: None,
            last_operation: Some(operation.operation_id.as_str().into()),
            process: None,
            launch_unconfirmed: false,
        };
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.shutdown {
                return Err(OperationError::Unavailable("The Host is stopping".into()));
            }
            state.instances.insert(
                id.clone(),
                InstanceSlot {
                    stored: stored.clone(),
                    persisted: None,
                    version: None,
                    live: None,
                    archive: None,
                    maintenance: Some(operation.operation_id.clone()),
                    query_count: 0,
                    holds: BTreeMap::new(),
                },
            );
            self.persist_locked(&mut state)?;
        }
        if arguments.policy != RuntimePolicyOverrides::default() {
            self.update_settings(UpdateRuntimeSettings {
                scope: RuntimeSettingsScope::Instance,
                workspace_instance_id: Some(id.clone()),
                expected_version: None,
                overrides: arguments.policy,
            })?;
        }
        if !arguments.start {
            return self.instance(&id);
        }
        let result = self
            .launch_candidate(operation, &stored, prepared, false)
            .await;
        if let Err(error) = &result {
            self.change_state(
                &id,
                RuntimeInstanceState::Failed,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
        }
        result
    }
    async fn continue_instance(
        &self,
        operation: &Operation,
        args: ContinueRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        let mut stored = self.stored_instance(&args.workspace_instance_id)?;
        if stored.lineage != args.expected_continuation_lineage_id {
            return Err(OperationError::StaleSession(
                "The continuation lineage changed; refresh this instance before continuing".into(),
            ));
        }
        let existing = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(&stored.id)
            .and_then(|slot| slot.live.clone());
        if let Some(existing) = existing {
            if stored.state == RuntimeInstanceState::Ready
                && existing.runtime.runtime_status().state != "unavailable"
            {
                if args.start_empty {
                    return Err(OperationError::Unavailable("R is already running. Review Restart with empty memory instead of treating a live session as an empty opening".into()));
                }
                return self.instance(&stored.id);
            }
            match existing.runtime.native_process_alive().await.map_err(|error| OperationError::Unavailable(error.message))? {
                Some(false) => {
                    self.require_quiet(&stored.id, existing.runtime.session_id())?;
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    let slot = state.instances.get_mut(&stored.id).unwrap(); slot.live = None; slot.stored.state = RuntimeInstanceState::Stopped; slot.stored.process = None; slot.stored.launch_unconfirmed = false;
                    self.persist_locked(&mut state)?;
                    stored.process = None; stored.launch_unconfirmed = false;
                },
                _ => return Err(OperationError::Unavailable("The original process is still alive or its termination is unconfirmed. Check its connection/recovery state before starting a replacement; continuing does not terminate it".into())),
            }
        }
        if let Some(process) = &stored.process {
            match self.launcher.original_process_alive(process).await? {
                Some(false) => {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    let slot = state.instances.get_mut(&stored.id).unwrap();
                    slot.stored.process = None;
                    slot.stored.launch_unconfirmed = false;
                    self.persist_locked(&mut state)?;
                    stored.process = None;
                    stored.launch_unconfirmed = false;
                }
                _ => {
                    let error = OperationError::Unavailable(format!(
                        "The previous R process {} ({}) is still alive or its identity cannot be checked. No replacement was started",
                        process.pid, process.native_session_id
                    ));
                    self.change_state(
                        &stored.id,
                        RuntimeInstanceState::RecoveryRequired,
                        &operation.operation_id,
                        Some(error.to_string()),
                    )?;
                    return Err(error);
                }
            }
        }
        if stored.launch_unconfirmed {
            return Err(OperationError::Unavailable("A previous launch has no confirmed native process receipt. Inspect the original lifecycle operation and process evidence before replacing it".into()));
        }
        let prepared = match self.launcher.prepare(&stored.binding).await {
            Ok(prepared) => prepared,
            Err(error) => {
                self.change_state(
                    &stored.id,
                    RuntimeInstanceState::RecoveryRequired,
                    &operation.operation_id,
                    Some(error.to_string()),
                )?;
                return Err(error);
            }
        };
        if stored
            .installation
            .as_ref()
            .is_some_and(|identity| identity != &prepared.installation)
        {
            let error = OperationError::Unavailable("The original R installation version or architecture changed. Automatic continuation will not substitute a different runtime".into());
            self.change_state(
                &stored.id,
                RuntimeInstanceState::RecoveryRequired,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
            return Err(error);
        }
        let mode = self.settings(Some(&stored.id))?.effective.value.mode;
        // Starting empty begins a new generation exactly like a clean restart: the
        // abandoned objects stay historical and only an explicit restore can return them.
        let empty = args.start_empty || mode != RuntimeContinuationMode::AutoContinue;
        if empty {
            stored.lineage = format!("lineage_{}", operation.operation_id.as_str());
            stored.activity = 0;
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state.instances.get_mut(&stored.id).unwrap();
            slot.stored = stored.clone();
            slot.archive = None;
        }
        self.change_state(
            &stored.id,
            RuntimeInstanceState::Starting,
            &operation.operation_id,
            None,
        )?;
        let result = self
            .launch_candidate(operation, &stored, prepared, !empty)
            .await;
        if let Err(error) = &result {
            self.change_state(
                &stored.id,
                RuntimeInstanceState::RecoveryRequired,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
        }
        result
    }
    async fn stop(
        &self,
        operation: &Operation,
        args: StopRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        let prior = self.stored_instance(&args.workspace_instance_id)?.state;
        if prior != RuntimeInstanceState::Ready && !args.discard_unsaved_objects {
            return Err(OperationError::Unavailable("The recovery candidate is not ready. Explicitly discard it to stop; its partial state will not replace the original recovery point".into()));
        }
        let prior = self.begin_stop(
            &args.workspace_instance_id,
            &args.expected_native_session_id,
            &operation.operation_id,
        )?;
        if let Err(error) = self.drain_native_reads(&args.workspace_instance_id).await {
            self.change_state(
                &args.workspace_instance_id,
                prior,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
            return Err(error);
        }
        if let Err(error) = self
            .protect_before_stop(
                operation,
                &args.workspace_instance_id,
                &args.expected_native_session_id,
                args.discard_unsaved_objects,
            )
            .await
        {
            self.change_state(
                &args.workspace_instance_id,
                prior,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
            return Err(error);
        }
        if let Err(error) = self.require_quiet(
            &args.workspace_instance_id,
            &args.expected_native_session_id,
        ) {
            self.change_state(
                &args.workspace_instance_id,
                prior,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
            return Err(error);
        }
        let live = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .instances
            .get(&args.workspace_instance_id)
            .and_then(|slot| slot.live.clone())
            .ok_or_else(|| {
                OperationError::StaleSession("The native session ended before shutdown".into())
            })?;
        if let Err(error) = live.runtime.shutdown().await {
            self.change_state(
                &args.workspace_instance_id,
                if error.effect_may_have_occurred {
                    RuntimeInstanceState::RecoveryRequired
                } else {
                    prior
                },
                &operation.operation_id,
                Some(error.message.clone()),
            )?;
            return Err(if error.effect_may_have_occurred {
                OperationError::LifecycleConflict(error.message)
            } else {
                OperationError::Unavailable(error.message)
            });
        }
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state
                .instances
                .get_mut(&args.workspace_instance_id)
                .unwrap();
            slot.live = None;
            slot.stored.process = None;
            slot.stored.launch_unconfirmed = false;
            slot.stored.state = RuntimeInstanceState::Stopped;
            slot.maintenance = None;
            self.persist_locked(&mut state)?;
        }
        self.instance(&args.workspace_instance_id)
    }
    async fn restart(
        &self,
        operation: &Operation,
        args: RestartRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        self.require_idle(
            &args.workspace_instance_id,
            &args.expected_native_session_id,
            true,
        )?;
        let stored = self.stored_instance(&args.workspace_instance_id)?;
        let prepared = self.launcher.prepare(&stored.binding).await?;
        if stored
            .installation
            .as_ref()
            .is_some_and(|identity| identity != &prepared.installation)
        {
            return Err(OperationError::Unavailable("The bound R installation changed; restarting will not silently replace its version or architecture".into()));
        }
        self.stop(
            operation,
            StopRuntimeInstance {
                workspace_instance_id: args.workspace_instance_id.clone(),
                expected_native_session_id: args.expected_native_session_id,
                discard_unsaved_objects: args.discard_unsaved_objects,
            },
        )
        .await?;
        let mut stored = self.stored_instance(&args.workspace_instance_id)?;
        if args.clean {
            stored.lineage = format!("lineage_{}", operation.operation_id.as_str());
            stored.activity = 0;
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state.instances.get_mut(&stored.id).unwrap();
            slot.stored = stored.clone();
            slot.archive = None;
        }
        // Persist the empty lineage before launch. A crash cannot resurrect a pre-clean checkpoint.
        self.change_state(
            &stored.id,
            RuntimeInstanceState::Starting,
            &operation.operation_id,
            None,
        )?;
        let result = self
            .launch_candidate(operation, &stored, prepared, !args.clean)
            .await;
        if let Err(error) = &result {
            self.change_state(
                &stored.id,
                RuntimeInstanceState::RecoveryRequired,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
        }
        result
    }
    async fn restore_as_new(
        &self,
        operation: &Operation,
        args: RestoreRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        let source = self.stored_instance(&args.source_workspace_instance_id)?;
        let record = self
            .journal
            .get(&args.checkpoint_id)
            .await?
            .ok_or_else(|| OperationError::NotFound(args.checkpoint_id.as_str().into()))?;
        if record.operation.principal() != operation.principal()
            || record.operation.idempotency_scope.as_deref() != Some(self.project())
            || record.operation.capability.id != "workspace.checkpoint_capture"
            || record.status != OperationStatus::Succeeded
        {
            return Err(invalid(
                "The requested recovery point is not a committed checkpoint visible to this project and principal",
            ));
        }
        let manifest: CheckpointManifest = serde_json::from_value(
            record
                .output
                .ok_or_else(|| invalid("The recovery point has no manifest"))?,
        )
        .map_err(invalid)?;
        if manifest.workspace_instance_id != source.id {
            return Err(invalid(
                "The recovery point does not belong to the named source instance",
            ));
        }
        let original_binding = args.binding.as_ref().or(manifest.runtime_binding.as_ref()).ok_or_else(|| OperationError::Unavailable("This checkpoint has no verified launch binding; choose a runtime explicitly before importing its objects".into()))?;
        let prepared = self.launcher.prepare(original_binding).await?;
        self.check_opening(operation)?;
        if prepared.installation.r_version != manifest.report.r_version
            || prepared.installation.platform != manifest.report.platform
        {
            return Err(OperationError::Unavailable("The recovery point's original R installation is unavailable or changed; creating a recovery session will not substitute another R".into()));
        }
        let id = format!("instance_{}", operation.operation_id.as_str());
        let stored = StoredInstance {
            id: id.clone(),
            name: args.name,
            binding: prepared.binding.clone(),
            installation: Some(prepared.installation.clone()),
            lineage: format!("lineage_{}", operation.operation_id.as_str()),
            activity: manifest.activity_boundary,
            state: RuntimeInstanceState::Starting,
            last_error: None,
            last_operation: Some(operation.operation_id.as_str().into()),
            process: None,
            launch_unconfirmed: false,
        };
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.instances.insert(
                id.clone(),
                InstanceSlot {
                    stored: stored.clone(),
                    persisted: None,
                    version: None,
                    live: None,
                    archive: None,
                    maintenance: Some(operation.operation_id.clone()),
                    query_count: 0,
                    holds: BTreeMap::new(),
                },
            );
            self.persist_locked(&mut state)?;
        }
        let result = async {
            self.check_capacity(&id)?;
            self.record_launch_boundary(&id)?;
            let launched = self.launcher.launch(prepared).await?;
            let live = self.make_live(launched.runtime, &stored)?;
            { let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner()); let slot = state.instances.get_mut(&id).unwrap(); slot.stored.process = live.runtime.process_identity(); slot.live = Some(live.clone()); self.persist_locked(&mut state)?; }
            self.check_opening(operation)?;
            let result = self.child_operation(operation, "import", &id, "workspace.checkpoint_restore", json!({
                "expected_session":live.runtime.session_id(), "checkpoint_id":manifest.checkpoint_id,
                "source_workspace_instance_id":source.id, "source_continuation_lineage_id":manifest.continuation_lineage_id,
            })).await?;
            if result.status != OperationStatus::Succeeded { return Err(OperationError::Unavailable(format!("The recovery candidate is retained for inspection. {}", result.error.unwrap_or_else(|| "Objects were not restored".into())))); }
            self.check_opening(operation)?;
            self.change_state(&id, RuntimeInstanceState::Ready, &operation.operation_id, None)?;
            self.instance(&id)
        }.await;
        if let Err(error) = &result {
            self.change_state(
                &id,
                RuntimeInstanceState::RecoveryRequired,
                &operation.operation_id,
                Some(error.to_string()),
            )?;
        }
        result
    }
    fn rename(
        &self,
        operation: &Operation,
        args: RenameRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state
                .instances
                .get_mut(&args.workspace_instance_id)
                .ok_or_else(|| OperationError::NotFound(args.workspace_instance_id.clone()))?;
            if slot.stored.name != args.expected_name {
                return Err(OperationError::ContentChanged(
                    "The instance was renamed in another window".into(),
                ));
            }
            slot.stored.name = args.name;
            slot.stored.last_operation = Some(operation.operation_id.as_str().into());
            self.persist_locked(&mut state)?;
        }
        self.instance(&args.workspace_instance_id)
    }
    async fn configure(
        &self,
        operation: &Operation,
        args: ConfigureRuntimeInstance,
    ) -> Result<WorkspaceInstance, OperationError> {
        let original = self.stored_instance(&args.workspace_instance_id)?;
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state
                .instances
                .get(&args.workspace_instance_id)
                .ok_or_else(|| OperationError::NotFound(args.workspace_instance_id.clone()))?;
            if slot.live.is_some() {
                return Err(OperationError::Unavailable("Stop this R instance before changing its installation or dependency environment".into()));
            }
            if slot.stored.lineage != args.expected_continuation_lineage_id {
                return Err(OperationError::StaleSession(
                    "The instance configuration changed; refresh it before applying a new binding"
                        .into(),
                ));
            }
        }
        if let Some(process) = &original.process {
            if self.launcher.original_process_alive(process).await? != Some(false) {
                return Err(OperationError::Unavailable("The previous native process is alive or unconfirmed; changing the binding cannot discard its ownership receipt".into()));
            }
        } else if original.launch_unconfirmed {
            return Err(OperationError::Unavailable("The original launch has no confirmed process identity; resolve it before changing this instance's binding".into()));
        }
        let prepared = self.launcher.prepare(&args.binding).await?;
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let slot = state
                .instances
                .get_mut(&args.workspace_instance_id)
                .unwrap();
            slot.stored.binding = prepared.binding;
            slot.stored.installation = Some(prepared.installation);
            slot.stored.lineage = format!("lineage_{}", operation.operation_id.as_str());
            slot.stored.activity = 0;
            slot.stored.process = None;
            slot.stored.launch_unconfirmed = false;
            slot.stored.state = RuntimeInstanceState::Stopped;
            slot.stored.last_error = None;
            slot.stored.last_operation = Some(operation.operation_id.as_str().into());
            slot.archive = None;
            self.persist_locked(&mut state)?;
        }
        self.instance(&args.workspace_instance_id)
    }
    fn update_settings(
        &self,
        args: UpdateRuntimeSettings,
    ) -> Result<RuntimeSettings, OperationError> {
        if args.scope != RuntimeSettingsScope::App
            && (args.overrides.global_storage_limit_bytes.is_some()
                || args.overrides.minimum_free_bytes.is_some())
        {
            return Err(invalid(
                "Global storage and free-space limits may only be set in application settings",
            ));
        }
        if args.scope == RuntimeSettingsScope::Instance
            && (args.overrides.project_storage_limit_bytes.is_some()
                || args.overrides.max_running_instances.is_some())
        {
            return Err(invalid(
                "A session cannot override project storage or simultaneous-process limits",
            ));
        }
        if args.scope == RuntimeSettingsScope::Instance {
            self.stored_instance(
                args.workspace_instance_id
                    .as_deref()
                    .ok_or_else(|| invalid("Instance settings require workspace_instance_id"))?,
            )?;
        } else if args.workspace_instance_id.is_some() {
            return Err(invalid(
                "App/project settings do not take workspace_instance_id",
            ));
        }
        let mut policy = self
            .settings(args.workspace_instance_id.as_deref())?
            .effective
            .value;
        args.overrides.apply_to(&mut policy);
        validate_policy(&policy)?;
        let old = self.policy_state(args.scope, args.workspace_instance_id.as_deref())?;
        if old.version != args.expected_version {
            return Err(OperationError::ContentChanged(
                "Runtime settings changed in another window".into(),
            ));
        }
        let state = ApplicationState {
            value: serde_json::to_value(args.overrides).map_err(storage_error)?,
            ..old
        };
        if args.scope == RuntimeSettingsScope::App {
            self.app_store
                .write("user", &state)
                .map_err(storage_error)?;
        } else {
            self.store
                .write(&self.scope(), &state)
                .map_err(storage_error)?;
        }
        self.settings(args.workspace_instance_id.as_deref())
    }
    pub(crate) async fn continue_default(&self) -> Result<(), OperationError> {
        let Some(id) = self
            .list(&RuntimeInstancesArguments {
                after_instance_id: None,
                limit: 1,
            })?
            .default_workspace_instance_id
        else {
            return Ok(());
        };
        let instance = self.instance(&id)?;
        // Opening the project starts only its default instance. Queries never call this path.
        if instance.state == RuntimeInstanceState::RecoveryRequired {
            return Ok(());
        }
        let context = crate::NextHost::local_context();
        let request = Invocation {
            client_request_id: format!("host-start:{}", uuid::Uuid::new_v4().simple()),
            capability: CapabilityRef::new("runtime.continue_instance", 1)?,
            arguments: json!({"workspace_instance_id":id,"expected_continuation_lineage_id":instance.continuation_lineage_id}),
            preconditions: vec![],
        };
        let record = self.gateway()?.invoke(&context, request).await?;
        if record.status != OperationStatus::Succeeded {
            // Failed continuation leaves files and the project Host available.
            return Ok(());
        }
        Ok(())
    }
}
fn stored_error(message: &str) -> OperationError {
    OperationError::Storage(message.into())
}

pub(crate) fn register_lifecycle(
    registry: &mut CapabilityRegistry,
    owner: Arc<InstanceOwner>,
) -> Result<(), OperationError> {
    for id in ["runtime.instances", "runtime.instance", "runtime.settings"] {
        registry.register_query(Arc::new(InstanceQuery {
            owner: owner.clone(),
            descriptor: lifecycle_descriptor(id),
        }))?;
    }
    for id in [
        "runtime.create_instance",
        "runtime.continue_instance",
        "runtime.stop_instance",
        "runtime.restart_instance",
        "runtime.restore_instance",
        "runtime.rename_instance",
        "runtime.configure_instance",
        "runtime.update_settings",
    ] {
        registry.register(Arc::new(InstanceOperation {
            owner: owner.clone(),
            descriptor: lifecycle_descriptor(id),
        }))?;
    }
    Ok(())
}

fn lifecycle_descriptor(id: &str) -> CapabilityDescriptor {
    let query = matches!(
        id,
        "runtime.instances" | "runtime.instance" | "runtime.settings"
    );
    let (input, output, summary, example) = match id {
        "runtime.instances" => (
            schema_for!(RuntimeInstancesArguments).to_value(),
            schema_for!(RuntimeInstances).to_value(),
            "List project R instances",
            json!({"limit":50}),
        ),
        "runtime.instance" => (
            schema_for!(RuntimeInstanceArguments).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Inspect a logical R instance and its blockers",
            json!({"workspace_instance_id":"main"}),
        ),
        "runtime.settings" => (
            schema_for!(RuntimeSettingsArguments).to_value(),
            schema_for!(RuntimeSettings).to_value(),
            "Read effective R continuation preferences",
            json!({"workspace_instance_id":null}),
        ),
        "runtime.create_instance" => (
            schema_for!(CreateRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Create an independent R instance",
            json!({"name":"Scratch","binding":{"r_executable":"/example/R","ark_executable":"/example/ark","environment_realization_id":null},"start":false,"policy":{}}),
        ),
        "runtime.continue_instance" => (
            schema_for!(ContinueRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Continue the original logical R session",
            json!({"workspace_instance_id":"main","expected_continuation_lineage_id":"lineage-example"}),
        ),
        "runtime.stop_instance" => (
            schema_for!(StopRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Save and stop one R instance",
            json!({"workspace_instance_id":"main","expected_native_session_id":"session-example","discard_unsaved_objects":false}),
        ),
        "runtime.restart_instance" => (
            schema_for!(RestartRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Restart one R instance with its bound environment",
            json!({"workspace_instance_id":"main","expected_native_session_id":"session-example","clean":true,"discard_unsaved_objects":false}),
        ),
        "runtime.restore_instance" => (
            schema_for!(RestoreRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Restore an earlier recovery point in a new R instance",
            json!({"source_workspace_instance_id":"main","checkpoint_id":"operation-example","name":"Recovered analysis"}),
        ),
        "runtime.rename_instance" => (
            schema_for!(RenameRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Rename a logical R session",
            json!({"workspace_instance_id":"main","expected_name":"Main","name":"Analysis"}),
        ),
        "runtime.configure_instance" => (
            schema_for!(ConfigureRuntimeInstance).to_value(),
            schema_for!(WorkspaceInstance).to_value(),
            "Bind a stopped R instance to a verified installation",
            json!({"workspace_instance_id":"main","expected_continuation_lineage_id":"lineage-example","binding":{"r_executable":"/example/R","ark_executable":"/example/ark","environment_realization_id":null}}),
        ),
        "runtime.update_settings" => (
            schema_for!(UpdateRuntimeSettings).to_value(),
            schema_for!(RuntimeSettings).to_value(),
            "Update explicit R continuation preferences",
            json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{}}),
        ),
        _ => unreachable!(),
    };
    let mut documentation = builtin_documentation(if query {
        "host.overview"
    } else {
        "workspace.run_r"
    });
    documentation.summary = summary.into();
    documentation.purpose = summary.into();
    documentation.owner = "host".into();
    documentation.examples = vec![CapabilityExample { arguments: example, result_explanation: "Inspect the owner observation or original OperationRecord; a native session change never replays code or queued work.".into() }];
    documentation.preconditions.clear();
    documentation.related_capabilities.clear();
    documentation.effects = if query {
        "Bounded Host metadata only; does not start or recover R"
    } else {
        "Changes only the explicitly targeted local R lifecycle or saved preference scope"
    }
    .into();
    CapabilityDescriptor {
        kind: if query {
            CapabilityKind::Query
        } else {
            CapabilityKind::Operation
        },
        capability: CapabilityRef::new(id, 1).unwrap(),
        domain: "runtime".into(),
        input_schema: input,
        output_schema: output,
        recovery_schema: json!({"type":"object"}),
        documentation,
        required_scopes: BTreeSet::from([if query {
            RUNTIME_READ_SCOPE
        } else {
            RUNTIME_CONTROL_SCOPE
        }
        .into()]),
        potential_effects: if query {
            BTreeSet::new()
        } else {
            BTreeSet::from([EffectHint::MayMutateRuntime, EffectHint::MaySpawnProcess])
        },
        idempotency: if query {
            IdempotencyClass::Pure
        } else {
            IdempotencyClass::CallerScoped
        },
        retry: if query {
            RetryClass::Safe
        } else {
            RetryClass::ReconcileFirst
        },
        cancellation: if matches!(
            id,
            "runtime.create_instance" | "runtime.continue_instance" | "runtime.restore_instance"
        ) {
            CancellationClass::Cooperative
        } else {
            CancellationClass::Unsupported
        },
    }
}

struct InstanceOperation {
    owner: Arc<InstanceOwner>,
    descriptor: CapabilityDescriptor,
}
#[async_trait]
impl OperationHandler for InstanceOperation {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.project.clone())
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        normalize_lifecycle(&self.descriptor.capability.id, arguments)
    }
    fn resolve_target(&self, arguments: &Value) -> Result<TargetRef, OperationError> {
        Ok(
            if let Some(id) = arguments
                .get("workspace_instance_id")
                .and_then(Value::as_str)
            {
                TargetRef {
                    kind: "workspace_instance".into(),
                    identity: id.into(),
                }
            } else {
                TargetRef {
                    kind: "project".into(),
                    identity: self.owner.project.clone(),
                }
            },
        )
    }
    async fn acquire_execution(
        &self,
        _operation: &Operation,
        mut cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        let guard = tokio::select! {
            guard = self.owner.transition.clone().lock_owned() => guard,
            _ = wait_cancellation(&mut cancellation) => return Err(HandlerError::cancelled("Opening cancelled before lifecycle admission", None)),
        };
        if self
            .owner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .shutdown
        {
            return Err(before("The Host is stopping"));
        }
        Ok(Box::new(LifecycleLease { _guard: guard }))
    }
    async fn execute_controlled(
        &self,
        operation: &Operation,
        cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        if *cancellation.borrow() {
            return Ok(CommitPlan::cancelled_before_start());
        }
        self.owner
            .opening_cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(operation.operation_id.clone(), cancellation.clone());
        let result = self.execute(operation).await;
        self.owner
            .opening_cancellations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&operation.operation_id);
        // A cancellation request arriving after publication cannot revoke success.
        if !*cancellation.borrow()
            || result
                .as_ref()
                .is_ok_and(|plan| plan.outcome == OperationOutcome::Succeeded)
        {
            return result;
        }
        if result
            .as_ref()
            .is_err_and(|error| error.effect_boundary == EffectBoundary::MayHaveOccurred)
        {
            return result;
        }
        let id = operation
            .normalized_arguments
            .get("workspace_instance_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("instance_{}", operation.operation_id.as_str()));
        let candidate = {
            let state = self.owner.state.lock().unwrap_or_else(|e| e.into_inner());
            state
                .instances
                .get(&id)
                .filter(|slot| {
                    slot.stored.last_operation.as_deref() == Some(operation.operation_id.as_str())
                        && slot.stored.state != RuntimeInstanceState::Ready
                })
                .map(|slot| (slot.live.clone(), slot.stored.launch_unconfirmed))
        };
        if let Some((live, unconfirmed)) = candidate {
            if live.is_none() && unconfirmed {
                return Err(HandlerError::after_possible_effect(
                    "Opening cancellation cannot confirm the original launch ended",
                    Some(json!({"workspace_instance_id":id,"automatic_reexecution":false})),
                ));
            }
            if let Some(live) = live
                && !self.owner.release_candidate(&id, &live).await
            {
                return Err(HandlerError::after_possible_effect(
                    "Restore cancellation requested, but candidate termination is unconfirmed",
                    Some(json!({"workspace_instance_id":id,"automatic_reexecution":false})),
                ));
            }
            self.owner
                .change_state(
                    &id,
                    RuntimeInstanceState::Stopped,
                    &operation.operation_id,
                    Some("Opening cancelled; the original recovery copy is retained".into()),
                )
                .map_err(before)?;
            let mut plan = CommitPlan::succeeded(
                serde_json::to_value(self.owner.instance(&id).map_err(before)?).map_err(before)?,
            );
            plan.outcome = OperationOutcome::Cancelled;
            plan.error = Some("Opening cancelled; candidate termination confirmed".into());
            return Ok(plan);
        }
        Ok(CommitPlan::cancelled_before_start())
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        let args = operation.normalized_arguments.clone();
        let result = match operation.capability.id.as_str() {
            "runtime.create_instance" => self
                .owner
                .create(operation, serde_json::from_value(args).map_err(before)?)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.continue_instance" => self
                .owner
                .continue_instance(operation, serde_json::from_value(args).map_err(before)?)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.stop_instance" => self
                .owner
                .stop(operation, serde_json::from_value(args).map_err(before)?)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.restart_instance" => self
                .owner
                .restart(operation, serde_json::from_value(args).map_err(before)?)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.restore_instance" => self
                .owner
                .restore_as_new(operation, serde_json::from_value(args).map_err(before)?)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.rename_instance" => self
                .owner
                .rename(operation, serde_json::from_value(args).map_err(before)?)
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.configure_instance" => self
                .owner
                .configure(operation, serde_json::from_value(args).map_err(before)?)
                .await
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            "runtime.update_settings" => self
                .owner
                .update_settings(serde_json::from_value(args).map_err(before)?)
                .and_then(|v| serde_json::to_value(v).map_err(storage_error)),
            _ => return Err(before("Unknown instance lifecycle operation")),
        };
        match result {
            Ok(value) => {
                let mut plan = CommitPlan::succeeded(value);
                plan.events.push(PlannedEvent { kind: "runtime.instance_changed".into(), payload: json!({"operation_id":operation.operation_id,"workspace_instance_id":operation.normalized_arguments.get("workspace_instance_id")}) });
                Ok(plan)
            }
            Err(error)
                if matches!(
                    error,
                    OperationError::Storage(_) | OperationError::CommitPending { .. }
                ) =>
            {
                Err(HandlerError::after_possible_effect(
                    error.to_string(),
                    Some(
                        json!({"action":"inspect_original_lifecycle","operation_id":operation.operation_id,"workspace_instance_id":operation.normalized_arguments.get("workspace_instance_id"),"automatic_reexecution":false}),
                    ),
                ))
            }
            Err(error) => {
                let id = operation
                    .normalized_arguments
                    .get("workspace_instance_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("instance_{}", operation.operation_id.as_str()));
                if self.owner.stored_instance(&id).is_ok_and(|instance| {
                    instance.last_operation.as_deref() == Some(operation.operation_id.as_str())
                }) {
                    let mut plan = CommitPlan::succeeded(
                        serde_json::to_value(self.owner.instance(&id).map_err(before)?)
                            .map_err(before)?,
                    );
                    plan.outcome = OperationOutcome::Failed;
                    plan.error = Some(error.to_string());
                    plan.recovery = Some(
                        json!({"action":"inspect_instance","workspace_instance_id":id,"automatic_reexecution":false}),
                    );
                    return Ok(plan);
                }
                Err(before(error))
            }
        }
    }
}
struct LifecycleLease {
    _guard: tokio::sync::OwnedMutexGuard<()>,
}
impl ExecutionLease for LifecycleLease {}

struct InstanceQuery {
    owner: Arc<InstanceOwner>,
    descriptor: CapabilityDescriptor,
}
#[async_trait]
impl QueryHandler for InstanceQuery {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        normalize_lifecycle(&self.descriptor.capability.id, arguments)
    }
    async fn query(&self, arguments: &Value) -> Result<QuerySnapshot, OperationError> {
        let data = match self.descriptor.capability.id.as_str() {
            "runtime.instances" => serde_json::to_value(
                self.owner
                    .list(&serde_json::from_value(arguments.clone()).map_err(invalid)?)?,
            )
            .map_err(storage_error)?,
            "runtime.instance" => {
                let args: RuntimeInstanceArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                serde_json::to_value(self.owner.instance(&args.workspace_instance_id)?)
                    .map_err(storage_error)?
            }
            "runtime.settings" => {
                let args: RuntimeSettingsArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if let Some(id) = &args.workspace_instance_id {
                    self.owner.stored_instance(id)?;
                }
                serde_json::to_value(self.owner.settings(args.workspace_instance_id.as_deref())?)
                    .map_err(storage_error)?
            }
            _ => return Err(invalid("Unknown instance query")),
        };
        let next_reads = data.get("next_after_instance_id").and_then(Value::as_str).map(|cursor| vec![NextRead::query("runtime.instances", "Continue the logical R instance catalog", json!({"after_instance_id":cursor,"limit":arguments.get("limit").and_then(Value::as_u64).unwrap_or(50)}))]).unwrap_or_default();
        let completeness = if next_reads.is_empty() {
            ObservationCompleteness::Complete
        } else {
            ObservationCompleteness::Partial
        };
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "project".into(),
                identity: self.owner.project.clone(),
            },
            source: "host-instance-owner".into(),
            observed_at_ms: now()?,
            status: QueryStatus::Ready,
            completeness,
            data: Some(data),
            notices: vec![],
            next_reads,
            diagnostics: vec![],
        })
    }
}
fn normalize_lifecycle(id: &str, value: &Value) -> Result<Value, OperationError> {
    fn parsed<T: serde::de::DeserializeOwned + Serialize>(
        value: &Value,
    ) -> Result<Value, OperationError> {
        serde_json::to_value(serde_json::from_value::<T>(value.clone()).map_err(invalid)?)
            .map_err(invalid)
    }
    let normalized = match id {
        "runtime.instances" => parsed::<RuntimeInstancesArguments>(value),
        "runtime.instance" => parsed::<RuntimeInstanceArguments>(value),
        "runtime.settings" => parsed::<RuntimeSettingsArguments>(value),
        "runtime.create_instance" => {
            let args: CreateRuntimeInstance =
                serde_json::from_value(value.clone()).map_err(invalid)?;
            if args.name.trim().is_empty()
                || args.name.len() > 160
                || args.name.chars().any(char::is_control)
            {
                return Err(invalid(
                    "Instance names must contain 1–160 bytes and no control characters",
                ));
            }
            validate_binding(&args.binding)?;
            serde_json::to_value(args).map_err(invalid)
        }
        "runtime.continue_instance" => parsed::<ContinueRuntimeInstance>(value),
        "runtime.stop_instance" => parsed::<StopRuntimeInstance>(value),
        "runtime.restart_instance" => parsed::<RestartRuntimeInstance>(value),
        "runtime.restore_instance" => parsed::<RestoreRuntimeInstance>(value),
        "runtime.rename_instance" => parsed::<RenameRuntimeInstance>(value),
        "runtime.configure_instance" => parsed::<ConfigureRuntimeInstance>(value),
        "runtime.update_settings" => parsed::<UpdateRuntimeSettings>(value),
        _ => Err(invalid("Unknown runtime capability or arguments")),
    }?;
    if let Some(id) = normalized
        .get("workspace_instance_id")
        .and_then(Value::as_str)
    {
        validate_id(id)?;
    }
    if let Some(binding) = normalized
        .get("binding")
        .filter(|binding| !binding.is_null())
    {
        validate_binding(&serde_json::from_value(binding.clone()).map_err(invalid)?)?;
    }
    if let Some(id) = normalized
        .get("source_workspace_instance_id")
        .and_then(Value::as_str)
    {
        validate_id(id)?;
    }
    if let Some(name) = normalized.get("name").and_then(Value::as_str)
        && (name.trim().is_empty() || name.len() > 160 || name.chars().any(char::is_control))
    {
        return Err(invalid(
            "Instance names must contain 1–160 bytes and no control characters",
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostDomains, ManagedInstances, NextHost, ProjectLease};
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    struct FixtureLauncher {
        root: String,
        launches: AtomicUsize,
        fail_prepare: AtomicBool,
        block_launch: AtomicBool,
        launch_started: tokio::sync::Notify,
        launch_release: tokio::sync::Notify,
        original_alive: AtomicUsize,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    struct FixtureRuntime {
        project: String,
        native: String,
        stopped: AtomicBool,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }
    #[async_trait]
    impl InstanceLauncher for FixtureLauncher {
        fn storage_root(&self) -> Option<PathBuf> {
            Some(Path::new(&self.root).parent().unwrap().join("runtime"))
        }
        fn archive_runtime(&self) -> Result<Option<Arc<dyn WorkspaceRuntime>>, OperationError> {
            Ok(Some(Arc::new(
                rho_r_runtime::CheckpointArchiveRuntime::open(
                    Path::new(&self.root),
                    &self.storage_root().unwrap(),
                )
                .map_err(storage_error)?,
            )))
        }
        async fn original_process_alive(
            &self,
            _: &RuntimeProcessIdentity,
        ) -> Result<Option<bool>, OperationError> {
            Ok(match self.original_alive.load(Ordering::SeqCst) {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            })
        }
        async fn prepare(
            &self,
            binding: &RuntimeLaunchBinding,
        ) -> Result<PreparedInstanceLaunch, OperationError> {
            if self.fail_prepare.load(Ordering::SeqCst) {
                return Err(OperationError::Unavailable(
                    "The original R installation is missing".into(),
                ));
            }
            Ok(PreparedInstanceLaunch {
                binding: binding.clone(),
                installation: RuntimeInstallationIdentity {
                    r_home: "/fixture/R".into(),
                    r_version: "4.6.0".into(),
                    platform: "fixture".into(),
                },
                library_path: None,
            })
        }
        async fn launch(
            &self,
            prepared: PreparedInstanceLaunch,
        ) -> Result<LaunchedInstance, OperationError> {
            if self.block_launch.load(Ordering::SeqCst) {
                self.launch_started.notify_one();
                self.launch_release.notified().await;
            }
            Ok(LaunchedInstance {
                installation: prepared.installation,
                runtime: Arc::new(FixtureRuntime {
                    project: self.root.clone(),
                    native: format!("fixture_{}", self.launches.fetch_add(1, Ordering::SeqCst)),
                    stopped: AtomicBool::new(false),
                    started: self.started.clone(),
                    release: self.release.clone(),
                }),
            })
        }
    }
    #[async_trait]
    impl WorkspaceRuntime for FixtureRuntime {
        fn project_root(&self) -> Option<&str> {
            Some(&self.project)
        }
        fn session_id(&self) -> &str {
            &self.native
        }
        fn process_identity(&self) -> Option<RuntimeProcessIdentity> {
            Some(RuntimeProcessIdentity {
                native_session_id: self.native.clone(),
                pid: 1000
                    + self
                        .native
                        .trim_start_matches("fixture_")
                        .parse::<u32>()
                        .unwrap(),
                start_time: 1,
            })
        }
        async fn native_process_alive(&self) -> Result<Option<bool>, WorkspaceRuntimeError> {
            Ok(Some(!self.stopped.load(Ordering::SeqCst)))
        }
        fn runtime_status(&self) -> RuntimeStatus {
            RuntimeStatus {
                session_id: self.native.clone(),
                state: if self.stopped.load(Ordering::SeqCst) {
                    "unavailable"
                } else {
                    "idle"
                }
                .into(),
                observed_at_ms: 1,
                processes: vec![],
                notices: vec![],
            }
        }
        async fn shutdown(&self) -> Result<(), WorkspaceRuntimeError> {
            self.stopped.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn execute(
            &self,
            operation: &Operation,
            request: &RunRArguments,
        ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
            self.execute_controlled(operation, request, tokio::sync::watch::channel(false).1)
                .await
        }
        async fn execute_controlled(
            &self,
            _operation: &Operation,
            request: &RunRArguments,
            mut cancellation: tokio::sync::watch::Receiver<bool>,
        ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
            let outcome = if request.code == "block" {
                self.started.notify_one();
                tokio::select! {
                    _ = self.release.notified() => OperationOutcome::Succeeded,
                    _ = rho_operation::wait_cancellation(&mut cancellation) => OperationOutcome::Cancelled,
                }
            } else {
                OperationOutcome::Succeeded
            };
            Ok(WorkspaceRuntimeReport {
                session_id: self.native.clone(),
                value: json!({"code":request.code}),
                stdout: String::new(),
                stderr: String::new(),
                conditions: vec![],
                output_references: vec![],
                effect_observations: vec![],
                outcome,
                error: None,
            })
        }
    }
    fn binding() -> RuntimeLaunchBinding {
        RuntimeLaunchBinding {
            r_executable: "/fixture/R/bin/R".into(),
            ark_executable: "/fixture/ark".into(),
            environment_realization_id: Some("environment-fixture".into()),
            library_path: None,
            checkpoint_helper_path: None,
        }
    }
    async fn fixture() -> (tempfile::TempDir, Arc<NextHost>, Arc<FixtureLauncher>) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(temp.path().join("runtime")).unwrap();
        let journal = Arc::new(
            rho_sqlite::SqliteOperationJournal::open(temp.path().join("records.sqlite")).unwrap(),
        );
        let store =
            Arc::new(ApplicationStore::open(&temp.path().join("application.sqlite")).unwrap());
        let app_store =
            Arc::new(ApplicationStore::open(&temp.path().join("preferences.sqlite")).unwrap());
        let launcher = Arc::new(FixtureLauncher {
            root: root.to_string_lossy().into_owned(),
            launches: AtomicUsize::new(0),
            fail_prepare: AtomicBool::new(false),
            block_launch: AtomicBool::new(false),
            launch_started: tokio::sync::Notify::new(),
            launch_release: tokio::sync::Notify::new(),
            original_alive: AtomicUsize::new(0),
            started: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let host = NextHost::compose(
            journal,
            HostDomains {
                project: Some(Arc::new(rho_git::GitProject::open(&root, vec![]).unwrap())),
                application_store: Some(store),
                project_lease: Some(ProjectLease::acquire(&root).unwrap()),
                managed: Some(ManagedInstances {
                    launcher: launcher.clone(),
                    app_store,
                    initial: Some(binding()),
                    auto_continue: true,
                }),
                ..HostDomains::default()
            },
            Arc::new(SystemClock),
            Arc::new(UuidOperationIdGenerator),
        )
        .await
        .unwrap();
        (temp, Arc::new(host), launcher)
    }
    fn request(id: &str, capability: &str, arguments: Value) -> Invocation {
        Invocation {
            client_request_id: id.into(),
            capability: CapabilityRef::new(capability, 1).unwrap(),
            arguments,
            preconditions: vec![],
        }
    }
    async fn invoke(
        host: &NextHost,
        id: &str,
        capability: &str,
        arguments: Value,
    ) -> OperationRecord {
        host.invoke(
            &NextHost::local_context(),
            request(id, capability, arguments),
        )
        .await
        .unwrap()
    }
    fn main(host: &NextHost) -> WorkspaceInstance {
        host.runtime
            .instances
            .as_ref()
            .unwrap()
            .instance("main")
            .unwrap()
    }

    #[tokio::test]
    async fn instance_dispatch_requires_an_explicit_target_and_never_starts_from_a_read() {
        let (_temp, host, launcher) = fixture().await;
        assert_eq!(main(&host).state, RuntimeInstanceState::Ready);
        assert!(
            host.invoke(
                &NextHost::local_context(),
                request("missing-target", "workspace.run_r", json!({"code":"1"}))
            )
            .await
            .is_err()
        );
        let record = invoke(
            &host,
            "explicit-target",
            "workspace.run_r",
            json!({"workspace_instance_id":"main","code":"1"}),
        )
        .await;
        assert_eq!(record.status, OperationStatus::Succeeded);
        assert_eq!(
            record.operation.normalized_arguments["workspace_instance_id"],
            "main"
        );
        assert_eq!(
            record.operation.target.identity,
            main(&host).native_session_id.unwrap()
        );
        let before = launcher.launches.load(Ordering::SeqCst);
        let page = host
            .query_snapshot(
                &NextHost::local_context(),
                QueryRequest {
                    capability: CapabilityRef::new("runtime.instances", 1).unwrap(),
                    arguments: json!({"limit":1}),
                },
            )
            .await
            .unwrap();
        assert_eq!(page.data.unwrap()["total"], 1);
        assert_eq!(launcher.launches.load(Ordering::SeqCst), before);
    }

    #[tokio::test]
    async fn instance_catalog_keeps_main_first_across_page_boundaries() {
        let (_temp, host, launcher) = fixture().await;
        let created = invoke(
            &host,
            "catalog-new",
            "runtime.create_instance",
            json!({"name":"Scratch","binding":binding(),"start":false}),
        )
        .await;
        assert_eq!(created.status, OperationStatus::Succeeded);
        let scratch: WorkspaceInstance = serde_json::from_value(created.output.unwrap()).unwrap();
        assert!(scratch.workspace_instance_id.as_str() < "main");
        let owner = host.runtime.instances.as_ref().unwrap();
        let launches = launcher.launches.load(Ordering::SeqCst);
        let first = owner
            .list(&RuntimeInstancesArguments {
                after_instance_id: None,
                limit: 1,
            })
            .unwrap();
        assert_eq!(first.instances[0].workspace_instance_id, "main");
        assert_eq!(first.next_after_instance_id.as_deref(), Some("main"));
        let second = owner
            .list(&RuntimeInstancesArguments {
                after_instance_id: first.next_after_instance_id,
                limit: 1,
            })
            .unwrap();
        assert_eq!(
            second.instances[0].workspace_instance_id,
            scratch.workspace_instance_id
        );
        assert!(second.next_after_instance_id.is_none());
        assert_eq!(
            second.default_workspace_instance_id.as_deref(),
            Some("main")
        );
        assert_eq!(second.total, 2);
        assert!(
            owner
                .list(&RuntimeInstancesArguments {
                    after_instance_id: Some(scratch.workspace_instance_id),
                    limit: 1
                })
                .unwrap()
                .instances
                .is_empty()
        );
        assert_eq!(launcher.launches.load(Ordering::SeqCst), launches);
    }

    #[tokio::test]
    async fn stopping_fences_new_native_reads_and_waits_for_the_original_read() {
        let (_temp, host, _) = fixture().await;
        let owner = host.runtime.instances.as_ref().unwrap().clone();
        let original = main(&host);
        let (_, hold) = owner.admit_query("main", "workspace.snapshot").unwrap();
        let previous = owner
            .begin_stop(
                "main",
                original.native_session_id.as_ref().unwrap(),
                &OperationId::new("stop-read-test").unwrap(),
            )
            .unwrap();
        assert_eq!(previous, RuntimeInstanceState::Ready);
        assert!(owner.admit_query("main", "workspace.snapshot").is_err());
        assert!(
            owner
                .admit_query("main", "workspace.runtime_status")
                .is_err()
        );
        let mut draining = Box::pin(owner.drain_native_reads("main"));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut draining)
                .await
                .is_err()
        );
        drop(hold);
        tokio::time::timeout(Duration::from_secs(1), draining)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(main(&host).native_session_id, original.native_session_id);
    }

    #[tokio::test]
    #[ignore = "requires RHO_ARK, RHO_R_HOME and RHO_CHECKPOINT_HELPER; uses an isolated real R"]
    async fn recovery_copy_protects_its_library_after_all_sessions_stop() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let retained = root.join("saved-library");
        std::fs::create_dir(&retained).unwrap();
        let host = NextHost::open_ark(
            &root.join("records.sqlite"),
            ArkConfig {
                executable: std::env::var_os("RHO_ARK").expect("RHO_ARK").into(),
                r_home: std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME").into(),
                checkpoint_helper_path: Some(
                    std::env::var_os("RHO_CHECKPOINT_HELPER")
                        .expect("RHO_CHECKPOINT_HELPER")
                        .into(),
                ),
                project_root: root.clone(),
                data_root: root.join("runtime"),
                execution_timeout: Duration::from_secs(30),
                library_path: None,
            },
        )
        .await
        .unwrap();
        let before = main(&host);
        let code = format!(
            ".libPaths(c({},.libPaths())); kept <- 1L",
            serde_json::to_string(&retained).unwrap()
        );
        assert_eq!(
            invoke(
                &host,
                "library-seed",
                "workspace.run_r",
                json!({"workspace_instance_id":"main","code":code})
            )
            .await
            .status,
            OperationStatus::Succeeded
        );
        let copy = invoke(&host,"library-copy","workspace.checkpoint_capture",json!({"workspace_instance_id":"main","expected_session":before.native_session_id,"max_bytes":1048576,"max_seconds":10})).await;
        assert_eq!(copy.status, OperationStatus::Succeeded, "{copy:?}");
        let stopped = invoke(&host,"library-stop","runtime.stop_instance",json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id,"discard_unsaved_objects":true})).await;
        assert_eq!(stopped.status, OperationStatus::Succeeded, "{stopped:?}");
        let owner = host.runtime.instances.as_ref().unwrap();
        let retained_path = retained.to_string_lossy().into_owned();
        assert!(
            owner
                .protected_libraries()
                .await
                .unwrap()
                .contains(&retained_path)
        );
        let continued = invoke(&host,"library-empty","runtime.continue_instance",json!({"workspace_instance_id":"main","expected_continuation_lineage_id":before.continuation_lineage_id,"start_empty":true})).await;
        assert_eq!(
            continued.status,
            OperationStatus::Succeeded,
            "{continued:?}"
        );
        let native = main(&host).native_session_id;
        let newer = invoke(&host,"library-new-copy","workspace.checkpoint_capture",json!({"workspace_instance_id":"main","expected_session":native,"max_bytes":1048576,"max_seconds":10})).await;
        assert_eq!(newer.status, OperationStatus::Succeeded, "{newer:?}");
        assert_eq!(invoke(&host,"library-stop-again","runtime.stop_instance",json!({"workspace_instance_id":"main","expected_native_session_id":native,"discard_unsaved_objects":true})).await.status,OperationStatus::Succeeded);
        let deleted = invoke(
            &host,
            "library-delete-old",
            "workspace.checkpoint_delete",
            json!({"workspace_instance_id":"main","checkpoint_id":copy.operation.operation_id}),
        )
        .await;
        assert_eq!(deleted.status, OperationStatus::Succeeded, "{deleted:?}");
        assert!(
            !owner
                .protected_libraries()
                .await
                .unwrap()
                .contains(&retained_path)
        );
    }

    #[tokio::test]
    async fn quitting_refuses_live_sessions_and_fences_a_later_launch() {
        let (_temp, host, _) = fixture().await;
        assert!(host.prepare_workbench_quit().await.is_err());
        let original = main(&host);
        let stopped = invoke(&host, "quit-stop", "runtime.stop_instance", json!({"workspace_instance_id":"main","expected_native_session_id":original.native_session_id,"discard_unsaved_objects":true})).await;
        assert_eq!(stopped.status, OperationStatus::Succeeded);
        host.prepare_workbench_quit().await.unwrap();
        let restarted = invoke(&host, "quit-no-start", "runtime.continue_instance", json!({"workspace_instance_id":"main","expected_continuation_lineage_id":original.continuation_lineage_id})).await;
        assert_eq!(restarted.status, OperationStatus::Failed);
        assert!(main(&host).native_session_id.is_none());
    }

    #[tokio::test]
    async fn cancelling_opening_waits_for_the_native_handshake_and_confirms_candidate_stop() {
        let (_temp, host, launcher) = fixture().await;
        let main_before = main(&host);
        launcher.block_launch.store(true, Ordering::SeqCst);
        let task_host = host.clone();
        let opening = tokio::spawn(async move {
            invoke(
                &task_host,
                "cancel-new",
                "runtime.create_instance",
                json!({"name":"Cancelled","binding":binding(),"start":true}),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), launcher.launch_started.notified())
            .await
            .unwrap();
        let owner = host.runtime.instances.as_ref().unwrap();
        let candidate = owner
            .list(&RuntimeInstancesArguments {
                after_instance_id: Some("main".into()),
                limit: 1,
            })
            .unwrap()
            .instances
            .remove(0);
        let operation_id =
            OperationId::new(candidate.last_lifecycle_operation_id.unwrap()).unwrap();
        host.request_cancellation(&NextHost::local_context(), &operation_id)
            .await
            .unwrap();
        assert_eq!(
            owner
                .instance(&candidate.workspace_instance_id)
                .unwrap()
                .state,
            RuntimeInstanceState::Starting
        );
        assert!(!opening.is_finished());
        launcher.launch_release.notify_one();
        let result = tokio::time::timeout(Duration::from_secs(2), opening)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status, OperationStatus::Cancelled, "{result:?}");
        let stopped = owner.instance(&candidate.workspace_instance_id).unwrap();
        assert_eq!(stopped.state, RuntimeInstanceState::Stopped);
        assert!(stopped.native_session_id.is_none());
        let stored = owner
            .stored_instance(&candidate.workspace_instance_id)
            .unwrap();
        assert!(stored.process.is_none());
        assert!(!stored.launch_unconfirmed);
        assert_eq!(main(&host).native_session_id, main_before.native_session_id);
    }

    #[tokio::test]
    async fn separate_instances_have_independent_queues_and_cancellation() {
        let (_temp, host, launcher) = fixture().await;
        let created = invoke(
            &host,
            "new",
            "runtime.create_instance",
            json!({"name":"Scratch","binding":binding(),"start":true}),
        )
        .await;
        assert_eq!(
            created.status,
            OperationStatus::Succeeded,
            "{:?}",
            created.error
        );
        let scratch: WorkspaceInstance = serde_json::from_value(created.output.unwrap()).unwrap();
        let primary = host.clone();
        let running = tokio::spawn(async move {
            primary
                .invoke_accepted(
                    &NextHost::local_context(),
                    request(
                        "blocked",
                        "workspace.run_r",
                        json!({"workspace_instance_id":"main","code":"block"}),
                    ),
                )
                .await
                .unwrap()
        });
        launcher.started.notified().await;
        let blocked = running.await.unwrap();
        let completed = tokio::time::timeout(
            Duration::from_secs(2),
            invoke(
                &host,
                "independent",
                "workspace.run_r",
                json!({"workspace_instance_id":scratch.workspace_instance_id,"code":"42"}),
            ),
        )
        .await
        .unwrap();
        assert_eq!(completed.status, OperationStatus::Succeeded);
        assert_ne!(completed.operation.target, blocked.operation.target);
        let restart = invoke(&host, "blocked-restart", "runtime.restart_instance", json!({"workspace_instance_id":"main","expected_native_session_id":main(&host).native_session_id,"clean":true,"discard_unsaved_objects":true})).await;
        assert_eq!(restart.status, OperationStatus::Failed);
        assert!(!main(&host).blockers.is_empty());
        host.request_cancellation(&NextHost::local_context(), &blocked.operation.operation_id)
            .await
            .unwrap();
        host.drain().await;
        let cancelled = host
            .get_operation(&NextHost::local_context(), &blocked.operation.operation_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.status, OperationStatus::Cancelled);
    }

    #[tokio::test]
    async fn clean_restart_preserves_binding_and_commits_a_new_empty_lineage() {
        let (_temp, host, launcher) = fixture().await;
        let before = main(&host);
        let arguments = json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id,"clean":true,"discard_unsaved_objects":true});
        let restarted = invoke(
            &host,
            "clean",
            "runtime.restart_instance",
            arguments.clone(),
        )
        .await;
        assert_eq!(
            restarted.status,
            OperationStatus::Succeeded,
            "{:?}",
            restarted.error
        );
        let after = main(&host);
        assert_eq!(after.binding, before.binding);
        assert_ne!(after.native_session_id, before.native_session_id);
        assert_ne!(
            after.continuation_lineage_id,
            before.continuation_lineage_id
        );
        let count = launcher.launches.load(Ordering::SeqCst);
        let replay = invoke(&host, "clean", "runtime.restart_instance", arguments).await;
        assert_eq!(
            replay.operation.operation_id,
            restarted.operation.operation_id
        );
        assert_eq!(launcher.launches.load(Ordering::SeqCst), count);
        let owner = host.runtime.instances.as_ref().unwrap();
        let saved = owner
            .store
            .runtime_instance(&owner.scope(), "main")
            .unwrap();
        let saved: StoredInstance = serde_json::from_value(saved.value).unwrap();
        assert_eq!(saved.lineage, after.continuation_lineage_id);
        assert_eq!(saved.activity, 0);
    }

    #[tokio::test]
    async fn failed_preflight_keeps_original_runtime_and_environment_alive() {
        let (_temp, host, launcher) = fixture().await;
        let before = main(&host);
        launcher.fail_prepare.store(true, Ordering::SeqCst);
        let result = invoke(&host, "missing", "runtime.restart_instance", json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id,"clean":true,"discard_unsaved_objects":true})).await;
        assert_eq!(result.status, OperationStatus::Failed);
        assert_eq!(main(&host).native_session_id, before.native_session_id);
        assert_eq!(
            main(&host).binding.environment_realization_id,
            before.binding.environment_realization_id
        );
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn settings_inherit_and_instance_cannot_raise_global_resource_limits() {
        let (_temp, host, _) = fixture().await;
        let changed = invoke(&host, "policy", "runtime.update_settings", json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{"mode":"save_start_empty","automatic_interval_seconds":600}})).await;
        assert_eq!(
            changed.status,
            OperationStatus::Succeeded,
            "{:?}",
            changed.error
        );
        assert_eq!(
            main(&host).policy.value.mode,
            RuntimeContinuationMode::SaveStartEmpty
        );
        assert_eq!(main(&host).policy.value.idle_delay_seconds, 30);
        assert_eq!(main(&host).policy.value.automatic_interval_seconds, 600);
        let forbidden = invoke(&host, "bad-policy", "runtime.update_settings", json!({"scope":"instance","workspace_instance_id":"main","expected_version":null,"overrides":{"global_storage_limit_bytes":1099511627776_u64}})).await;
        assert_eq!(forbidden.status, OperationStatus::Failed);
    }

    /// An update replaces its scope's whole override set, so omitting a field is
    /// how a caller resets it to the inherited value.
    #[tokio::test]
    async fn omitted_settings_reset_to_the_inherited_value() {
        let (_temp, host, _) = fixture().await;
        let project = invoke(&host, "project-policy", "runtime.update_settings", json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{"automatic_interval_seconds":600,"idle_delay_seconds":45}})).await;
        assert_eq!(
            project.status,
            OperationStatus::Succeeded,
            "{:?}",
            project.error
        );
        let instance = invoke(&host, "instance-policy", "runtime.update_settings", json!({"scope":"instance","workspace_instance_id":"main","expected_version":null,"overrides":{"idle_delay_seconds":90}})).await;
        assert_eq!(
            instance.status,
            OperationStatus::Succeeded,
            "{:?}",
            instance.error
        );
        assert_eq!(main(&host).policy.value.idle_delay_seconds, 90);
        assert_eq!(main(&host).policy.project.idle_delay_seconds, Some(45));
        let version = instance.output.clone().unwrap()["instance_version"].clone();
        let reset = invoke(&host, "instance-reset", "runtime.update_settings", json!({"scope":"instance","workspace_instance_id":"main","expected_version":version,"overrides":{}})).await;
        assert_eq!(
            reset.status,
            OperationStatus::Succeeded,
            "{:?}",
            reset.error
        );
        assert_eq!(main(&host).policy.instance.idle_delay_seconds, None);
        // The reset field falls back to the project override; the untouched
        // project setting is not disturbed by an instance-scope write.
        assert_eq!(main(&host).policy.value.idle_delay_seconds, 45);
        assert_eq!(main(&host).policy.value.automatic_interval_seconds, 600);
    }

    #[tokio::test]
    async fn idle_release_never_ends_a_session_by_default() {
        let (_temp, host, launcher) = fixture().await;
        assert_eq!(main(&host).state, RuntimeInstanceState::Ready);
        // No Studio window is online in this fixture, and the default policy
        // leaves idle stopping disabled.
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_millis(600)).await;
            assert_eq!(main(&host).state, RuntimeInstanceState::Ready);
        }
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn idle_release_stops_an_unattended_session_only_when_nothing_is_unprotected() {
        let (_temp, host, launcher) = fixture().await;
        let enabled = invoke(&host, "idle-release", "runtime.update_settings", json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{"idle_stop_without_windows_seconds":1}})).await;
        assert_eq!(
            enabled.status,
            OperationStatus::Succeeded,
            "{:?}",
            enabled.error
        );
        let mut released = false;
        for _ in 0..12 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if main(&host).state == RuntimeInstanceState::Stopped {
                released = true;
                break;
            }
        }
        assert!(
            released,
            "an unattended session holding nothing is released"
        );
        assert_eq!(
            launcher.launches.load(Ordering::SeqCst),
            1,
            "releasing never relaunches"
        );
    }

    #[tokio::test]
    async fn idle_release_keeps_a_session_with_unprotected_objects() {
        let (_temp, host, _) = fixture().await;
        let ran = invoke(
            &host,
            "run",
            "workspace.run_r",
            json!({"workspace_instance_id":"main","code":"x <- 1"}),
        )
        .await;
        assert_eq!(ran.status, OperationStatus::Succeeded, "{:?}", ran.error);
        let enabled = invoke(&host, "idle-release", "runtime.update_settings", json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{"idle_stop_without_windows_seconds":1}})).await;
        assert_eq!(
            enabled.status,
            OperationStatus::Succeeded,
            "{:?}",
            enabled.error
        );
        // This fixture runtime reports no native capture, so the created objects
        // can never be protected; the session must survive being unattended.
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert_eq!(main(&host).state, RuntimeInstanceState::Ready);
        }
        assert!(main(&host).native_session_id.is_some());
    }

    #[tokio::test]
    async fn draining_a_host_ends_the_r_processes_it_started() {
        let (_temp, host, launcher) = fixture().await;
        assert_eq!(main(&host).state, RuntimeInstanceState::Ready);
        host.drain().await;
        // Termination was confirmed, so the receipt is gone and a later Host continues
        // normally instead of refusing to replace a process it believes is alive.
        let drained = main(&host);
        assert_eq!(drained.state, RuntimeInstanceState::Stopped);
        assert!(drained.native_session_id.is_none());
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn automatic_continuation_refuses_to_abandon_objects_it_cannot_restore() {
        let (_temp, host, _) = fixture().await;
        let ran = invoke(
            &host,
            "run",
            "workspace.run_r",
            json!({"workspace_instance_id":"main","code":"x <- 1"}),
        )
        .await;
        assert_eq!(ran.status, OperationStatus::Succeeded, "{:?}", ran.error);
        let before = main(&host);
        let stopped = invoke(&host, "stop", "runtime.stop_instance", json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id.unwrap(),"discard_unsaved_objects":true})).await;
        assert_eq!(
            stopped.status,
            OperationStatus::Succeeded,
            "{:?}",
            stopped.error
        );
        // This fixture runtime reports no native capture, so the objects are gone and
        // continuing must say so instead of quietly presenting an empty session.
        let refused = invoke(&host, "continue", "runtime.continue_instance", json!({"workspace_instance_id":"main","expected_continuation_lineage_id":before.continuation_lineage_id})).await;
        assert_eq!(refused.status, OperationStatus::Failed);
        assert!(
            refused.error.unwrap().contains("start_empty"),
            "the refusal must name the explicit remedy"
        );
    }

    #[tokio::test]
    async fn empty_opening_cannot_claim_success_against_an_already_running_session() {
        let (_temp, host, _) = fixture().await;
        let original = main(&host);
        let result = invoke(&host,"empty-already-live","runtime.continue_instance",json!({"workspace_instance_id":"main","expected_continuation_lineage_id":original.continuation_lineage_id,"start_empty":true})).await;
        assert_eq!(result.status, OperationStatus::Failed);
        assert_eq!(main(&host).native_session_id, original.native_session_id);
        assert_eq!(
            main(&host).continuation_lineage_id,
            original.continuation_lineage_id
        );
    }

    #[tokio::test]
    async fn an_explicit_empty_start_opens_a_new_continuation_generation() {
        let (_temp, host, _) = fixture().await;
        let ran = invoke(
            &host,
            "run",
            "workspace.run_r",
            json!({"workspace_instance_id":"main","code":"x <- 1"}),
        )
        .await;
        assert_eq!(ran.status, OperationStatus::Succeeded, "{:?}", ran.error);
        let before = main(&host);
        let stopped = invoke(&host, "stop", "runtime.stop_instance", json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id.unwrap(),"discard_unsaved_objects":true})).await;
        assert_eq!(
            stopped.status,
            OperationStatus::Succeeded,
            "{:?}",
            stopped.error
        );
        let empty = invoke(&host, "start-empty", "runtime.continue_instance", json!({"workspace_instance_id":"main","expected_continuation_lineage_id":before.continuation_lineage_id,"start_empty":true})).await;
        assert_eq!(
            empty.status,
            OperationStatus::Succeeded,
            "{:?}",
            empty.error
        );
        let after = main(&host);
        assert_eq!(after.state, RuntimeInstanceState::Ready);
        assert_ne!(
            after.continuation_lineage_id, before.continuation_lineage_id,
            "an empty start must not inherit the generation it abandoned"
        );
        let resumed = invoke(
            &host,
            "run-after-empty",
            "workspace.run_r",
            json!({"workspace_instance_id":"main","code":"1 + 1"}),
        )
        .await;
        assert_eq!(
            resumed.status,
            OperationStatus::Succeeded,
            "{:?}",
            resumed.error
        );
    }

    #[tokio::test]
    async fn unknown_or_alive_original_process_prevents_a_cross_host_replacement() {
        let (_temp, host, launcher) = fixture().await;
        let owner = host.runtime.instances.as_ref().unwrap();
        let previous = main(&host);
        {
            let mut state = owner.state.lock().unwrap();
            let slot = state.instances.get_mut("main").unwrap();
            slot.live = None;
            slot.stored.state = RuntimeInstanceState::Stopped;
            owner.persist_locked(&mut state).unwrap();
        }
        for (observation, request_id) in [(1, "original-alive"), (2, "original-unknown")] {
            launcher.original_alive.store(observation, Ordering::SeqCst);
            let result = invoke(&host, request_id, "runtime.continue_instance", json!({"workspace_instance_id":"main","expected_continuation_lineage_id":previous.continuation_lineage_id})).await;
            assert_eq!(result.status, OperationStatus::Failed);
            assert_eq!(launcher.launches.load(Ordering::SeqCst), 1);
            assert_eq!(main(&host).state, RuntimeInstanceState::RecoveryRequired);
        }
        launcher.original_alive.store(0, Ordering::SeqCst);
        let result = invoke(&host,"original-ended","runtime.continue_instance",json!({"workspace_instance_id":"main","expected_continuation_lineage_id":previous.continuation_lineage_id})).await;
        assert_eq!(
            result.status,
            OperationStatus::Succeeded,
            "{:?}",
            result.error
        );
        assert_eq!(launcher.launches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn active_target_hold_blocks_restart_and_stopped_archive_reads_are_pure() {
        let (temp, host, launcher) = fixture().await;
        let before = main(&host);
        let hold = host
            .hold_runtime_instance(
                "main",
                before.native_session_id.as_deref().unwrap(),
                "agent-task",
                "An Agent is using Main",
            )
            .unwrap();
        let result = invoke(&host,"held","runtime.restart_instance",json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id,"clean":true,"discard_unsaved_objects":true})).await;
        assert_eq!(result.status, OperationStatus::Failed);
        assert_eq!(main(&host).blockers[0].kind, "attachment");
        drop(hold);
        let stopped = invoke(&host,"stop-for-archive","runtime.stop_instance",json!({"workspace_instance_id":"main","expected_native_session_id":before.native_session_id,"discard_unsaved_objects":true})).await;
        assert_eq!(stopped.status, OperationStatus::Succeeded);
        let calls = launcher.launches.load(Ordering::SeqCst);
        let archive = host
            .query_snapshot(
                &NextHost::local_context(),
                QueryRequest {
                    capability: CapabilityRef::new("workspace.checkpoints", 1).unwrap(),
                    arguments: json!({"workspace_instance_id":"main","limit":20}),
                },
            )
            .await
            .unwrap();
        assert!(
            archive.data.unwrap()["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(launcher.launches.load(Ordering::SeqCst), calls);
        assert!(
            !temp.path().join("runtime/checkpoints").exists(),
            "A recovery-point read must not create artifact directories"
        );
    }
}
