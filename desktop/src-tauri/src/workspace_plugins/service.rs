//! Asynchronous application services for plugin state that does not own or
//! dispatch Workspace R.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use rho_extension_runtime::WorkspaceGrantIdentity;
use rho_protocol::WorkspaceIdentity;
use rho_store::{BorrowedStore, StoreExecutor, StoreExecutorOperationError};

use super::{
    PendingPluginPermissionRegistry, PluginRuntimeContext, WorkspacePluginAgentProjection,
    WorkspacePluginBoundaryTeardownReport, WorkspacePluginHeartbeatReport,
    WorkspacePluginReconciliationReport,
};

pub(crate) struct AgentPluginProjectionSnapshot {
    pub project_root: String,
    pub runtime_context: PluginRuntimeContext,
    pub projection: WorkspacePluginAgentProjection,
}

pub(crate) struct PluginBoundaryTeardownOutcome {
    pub report: WorkspacePluginBoundaryTeardownReport,
    pub permission_recovery_error: Option<String>,
    pub grant_recovery_error: Option<String>,
}

pub(crate) async fn run_store_service<R, F>(executor: &StoreExecutor, operation: F) -> Result<R>
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

/// Build the Agent-facing plugin projection on the Store worker using the
/// last fully committed Workspace identity. The caller retains the project
/// transition gate, so the durable active root cannot switch between identity
/// selection and publication of this snapshot.
pub(crate) async fn agent_plugin_projection_snapshot(
    registry: Arc<PendingPluginPermissionRegistry>,
    executor: &StoreExecutor,
    app_data_dir: PathBuf,
    identity: Arc<WorkspaceIdentity>,
    missing_active_project_message: &'static str,
) -> Result<AgentPluginProjectionSnapshot> {
    run_store_service(executor, move |store| {
        let project_root = store
            .active_project_root()?
            .context(missing_active_project_message)?;
        let runtime_context = PluginRuntimeContext {
            app_data_dir,
            project_scope_id: crate::extension_project_scope_id(&project_root)?,
            project_root: project_root.clone(),
            project_revision: i64::try_from(identity.project_revision)
                .context("project revision exceeds the plugin contribution range")?,
            workspace: Some(WorkspaceGrantIdentity {
                workspace_id: identity.workspace_id.clone(),
                kernel_instance_id: identity.kernel_instance_id.clone(),
                state_revision: identity.state_revision,
                project_revision: identity.project_revision,
            }),
        };
        let projection = registry.agent_projection(&runtime_context, store)?;
        Ok(AgentPluginProjectionSnapshot {
            project_root,
            runtime_context,
            projection,
        })
    })
    .await
}

pub(crate) async fn teardown_plugin_boundary(
    registry: Arc<PendingPluginPermissionRegistry>,
    executor: &StoreExecutor,
    context: PluginRuntimeContext,
    kind: String,
    trigger: String,
) -> Result<PluginBoundaryTeardownOutcome> {
    run_store_service(executor, move |store| {
        let report = registry.teardown_project(&context, &kind, store);
        let permission_recovery_error = store
            .recover_pending_plugin_permission_requests(&context.project_root, &trigger)
            .err()
            .map(|error| error.to_string());
        let grant_recovery_error = store
            .recover_transient_plugin_permission_grants(&context.project_root, &trigger)
            .err()
            .map(|error| error.to_string());
        Ok(PluginBoundaryTeardownOutcome {
            report,
            permission_recovery_error,
            grant_recovery_error,
        })
    })
    .await
}

pub(crate) async fn reconcile_plugin_project(
    registry: Arc<PendingPluginPermissionRegistry>,
    executor: &StoreExecutor,
    context: PluginRuntimeContext,
) -> Result<WorkspacePluginReconciliationReport> {
    run_store_service(executor, move |store| {
        Ok(registry.reconcile_project(&context, store))
    })
    .await
}

pub(crate) async fn sweep_plugin_heartbeats(
    registry: Arc<PendingPluginPermissionRegistry>,
    executor: &StoreExecutor,
    context: PluginRuntimeContext,
) -> Result<WorkspacePluginHeartbeatReport> {
    run_store_service(executor, move |store| {
        Ok(registry.sweep_project_heartbeats(&context, store))
    })
    .await
}
