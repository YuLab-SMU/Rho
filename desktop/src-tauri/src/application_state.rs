use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, RwLock as SyncRwLock};

use anyhow::{Context, Result, anyhow};
use rho_extension_runtime::ExtensionHost;
use rho_kernel::ArkSession;
use rho_server::coordinator::{AgentWorkspaceLane, PendingApprovalRegistry};
use rho_server::workspace_lane::WorkspaceBrokerLane;
use rho_store::{BorrowedStore, StoreExecutor, StoreExecutorOperationError};
use tokio::sync::{Mutex, OnceCell, RwLock};

use crate::agent_llm::AgentModelTestControl;
use crate::commands::agent_execution::AgentTaskEntry;
#[cfg(test)]
use crate::commands::agent_files::AgentFileApplyTestControl;
use crate::commands::agent_files::AgentFileMutationRegistry;
use crate::commands::render::RenderJobState;
use crate::project::{ProjectSessionStore, ProjectWatcherControl};
use crate::project_transition::SwitchTestControl;
use crate::startup_runtime::{RuntimeConfig, StartupView, runtime_config};
use crate::{
    check_runtime, plugin_surface_runtime, resource_registry, runtime_registry, studio_runtime,
    surface_runtime, ui_profile, ui_runtime, workbench_projection, workspace_plugins,
};

pub(crate) struct WorkspaceEnvironmentRuntime {
    project_root: Option<String>,
    gate: rho_workspace::WorkspaceEnvironmentGate,
}

impl Default for WorkspaceEnvironmentRuntime {
    fn default() -> Self {
        Self {
            project_root: None,
            gate: rho_workspace::WorkspaceEnvironmentGate::new(None),
        }
    }
}

impl WorkspaceEnvironmentRuntime {
    pub(crate) fn for_project(
        &mut self,
        project_root: &str,
    ) -> &mut rho_workspace::WorkspaceEnvironmentGate {
        if self.project_root.as_deref() != Some(project_root) {
            self.project_root = Some(project_root.to_string());
            self.gate = rho_workspace::WorkspaceEnvironmentGate::new(None);
        }
        &mut self.gate
    }
}

pub(crate) struct AppState {
    pub(crate) data_dir: PathBuf,
    pub(crate) ark: PathBuf,
    pub(crate) config: SyncRwLock<Option<RuntimeConfig>>,
    pub(crate) selected_rscript: SyncRwLock<Option<PathBuf>>,
    pub(crate) startup: SyncRwLock<StartupView>,
    pub(crate) project_store: ProjectSessionStore,
    pub(crate) project_root: RwLock<PathBuf>,
    pub(crate) project_watcher: Mutex<Option<ProjectWatcherControl>>,
    pub(crate) session: RwLock<Option<Arc<ArkSession>>>,
    pub(crate) context: Mutex<Option<Arc<WorkspaceBrokerLane>>>,
    pub(crate) store_executor: OnceCell<StoreExecutor>,
    pub(crate) evidence_graph: rho_evidence_graph::ProjectGraphManager,
    pub(crate) approvals: Arc<PendingApprovalRegistry>,
    pub(crate) workspace_environment: Mutex<WorkspaceEnvironmentRuntime>,
    pub(crate) project_transition_gate: Arc<Mutex<()>>,
    pub(crate) extension_host: Arc<ExtensionHost>,
    pub(crate) plugin_permissions: Arc<workspace_plugins::PendingPluginPermissionRegistry>,
    pub(crate) agent_tasks: Arc<Mutex<HashMap<String, AgentTaskEntry>>>,
    pub(crate) agent_workspace_lane: Arc<AgentWorkspaceLane>,
    pub(crate) agent_file_mutations: Arc<AgentFileMutationRegistry>,
    #[cfg(test)]
    pub(crate) agent_file_apply_test_control: AgentFileApplyTestControl,
    pub(crate) agent_llm_test_control: AgentModelTestControl,
    pub(crate) switch_test_control: SwitchTestControl,
    pub(crate) shutdown_started: AtomicBool,
    pub(crate) render_jobs: Arc<Mutex<HashMap<String, RenderJobState>>>,
    pub(crate) render_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    pub(crate) surface_runtime: surface_runtime::SurfaceRuntimeState,
    pub(crate) plugin_surface_runtime: plugin_surface_runtime::PluginSurfaceRuntimeState,
    pub(crate) check_runtime: check_runtime::CheckRuntimeState,
    pub(crate) studio_runtime: studio_runtime::StudioRuntimeState,
    pub(crate) runtime_registry: runtime_registry::RuntimeRegistryState,
    pub(crate) resource_registry: resource_registry::ResourceRegistryState,
    pub(crate) ui_profile: ui_profile::ProjectUiProfileState,
    pub(crate) ui_runtime: ui_runtime::UiRuntimeState,
    pub(crate) workbench_projection: workbench_projection::WorkbenchProjectionState,
}

pub(crate) async fn run_store_executor_service<R, F>(
    executor: &StoreExecutor,
    operation: F,
) -> Result<R>
where
    R: Send + 'static,
    F: FnOnce(&mut BorrowedStore<'_>) -> Result<R> + Send + 'static,
{
    executor
        .run_service(operation)
        .await
        .map_err(|error| match error {
            StoreExecutorOperationError::Operation(error) => error,
            StoreExecutorOperationError::Worker(message) => {
                anyhow!("Store worker failed: {message}")
            }
        })
}

pub(crate) async fn persist_workspace_identity(
    executor: &StoreExecutor,
    identity: rho_protocol::WorkspaceIdentity,
) -> Result<()> {
    run_store_executor_service(executor, move |store| {
        store.save_identity(&identity)?;
        Ok(())
    })
    .await
}

pub(crate) async fn active_session(state: &AppState) -> Result<Arc<ArkSession>> {
    state
        .session
        .read()
        .await
        .clone()
        .context("Workspace R is not running")
}

pub(crate) async fn active_context(state: &AppState) -> Result<Arc<WorkspaceBrokerLane>> {
    state
        .context
        .lock()
        .await
        .clone()
        .context("Workspace context is not ready")
}

pub(crate) async fn active_workspace_id(state: &AppState) -> Option<String> {
    let context = state.context.lock().await.clone()?;
    Some(context.identity().workspace_id.clone())
}

pub(crate) async fn store_executor(state: &AppState) -> Result<&StoreExecutor> {
    let store_path = runtime_config(state)?.store_path;
    state
        .store_executor
        .get_or_try_init(|| async move {
            StoreExecutor::open(store_path)
                .await
                .context("opening asynchronous Rho Store executor")
        })
        .await
}
