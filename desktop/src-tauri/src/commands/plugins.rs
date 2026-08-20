use anyhow::{Context, Result, ensure};
use rho_extension_runtime::WorkspaceGrantIdentity;
use rho_store::{PluginPermissionQueryService, PluginPermissionRequest};
use serde_json::Value;
use tauri::State;

use crate::workspace_plugins::{
    PluginCommandInvocationView, PluginContributionList, PluginGrantList, PluginGrantRevokeResult,
    PluginPermissionDecisionInput, PluginPermissionDecisionResult, PluginRuntimeContext,
    PluginViewerDocumentView, WorkspacePluginDisableResult, WorkspacePluginEnableResult,
    WorkspacePluginList,
};
use crate::{AppState, active_context, display_error, extension_project_scope_id, read_store};

pub(crate) async fn runtime_context(state: &AppState) -> Result<PluginRuntimeContext> {
    let root = state.project_root.read().await.clone();
    let project_root = rho_store::normalize_project_root(root.to_string_lossy().as_ref());
    ensure!(!project_root.is_empty(), "an active project is required");
    let coordinator = active_context(state).await?;
    let identity = coordinator.lock().await.broker.identity().clone();
    let project_revision = i64::try_from(identity.project_revision)
        .context("project revision exceeds the plugin permission range")?;
    Ok(PluginRuntimeContext {
        app_data_dir: state.data_dir.clone(),
        project_scope_id: extension_project_scope_id(&project_root)?,
        project_root,
        project_revision,
        workspace: Some(WorkspaceGrantIdentity {
            workspace_id: identity.workspace_id,
            kernel_instance_id: identity.kernel_instance_id,
            state_revision: identity.state_revision,
            project_revision: identity.project_revision,
        }),
    })
}

#[tauri::command]
pub(crate) async fn list_workspace_plugins(
    state: State<'_, AppState>,
) -> Result<WorkspacePluginList, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .list(&context, &mut store)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn request_workspace_plugin_enable(
    plugin_id: String,
    expected_project_revision: i64,
    state: State<'_, AppState>,
) -> Result<WorkspacePluginEnableResult, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    if expected_project_revision != context.project_revision {
        return Err("Workspace plugin enable request is stale after a project change.".to_string());
    }
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .request_enable(&context, &plugin_id, &mut store)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn disable_workspace_plugin(
    plugin_id: String,
    expected_project_revision: i64,
    state: State<'_, AppState>,
) -> Result<WorkspacePluginDisableResult, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    if expected_project_revision != context.project_revision {
        return Err(
            "Workspace plugin disable request is stale after a project change.".to_string(),
        );
    }
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .disable(&context, &plugin_id, &mut store)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn list_plugin_permission_requests(
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PluginPermissionRequest>, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    let store = read_store(&state).map_err(display_error)?;
    PluginPermissionQueryService::new(&store)
        .list_requests(&context.project_root, Some(100), status.as_deref())
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_plugin_permission_request(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<Option<PluginPermissionRequest>, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    let store = read_store(&state).map_err(display_error)?;
    PluginPermissionQueryService::new(&store)
        .get_request(&context.project_root, &request_id)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn respond_plugin_permission(
    input: PluginPermissionDecisionInput,
    state: State<'_, AppState>,
) -> Result<PluginPermissionDecisionResult, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .respond(&context, input, &mut store)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn list_plugin_grants(
    state: State<'_, AppState>,
) -> Result<PluginGrantList, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    let store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .list_grants(&context, &store)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn revoke_plugin_grant(
    grant_id: String,
    state: State<'_, AppState>,
) -> Result<PluginGrantRevokeResult, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .revoke(&context, &grant_id, &mut store)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn list_plugin_contributions(
    state: State<'_, AppState>,
) -> Result<PluginContributionList, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    Ok(state.plugin_permissions.list_contributions(&context))
}

#[tauri::command]
pub(crate) async fn invoke_plugin_command(
    contribution_id: String,
    input: Option<Value>,
    expected_project_revision: i64,
    state: State<'_, AppState>,
) -> Result<PluginCommandInvocationView, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    if expected_project_revision != context.project_revision {
        return Err("Plugin Command is stale after the project changed.".to_string());
    }
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .invoke_command_contribution(
            &context,
            &contribution_id,
            input.unwrap_or_else(|| serde_json::json!({})),
            &mut store,
        )
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn open_plugin_viewer(
    contribution_id: String,
    input: Option<Value>,
    expected_project_revision: i64,
    state: State<'_, AppState>,
) -> Result<PluginViewerDocumentView, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    if expected_project_revision != context.project_revision {
        return Err("Plugin Viewer is stale after the project changed.".to_string());
    }
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .open_viewer_contribution(
            &context,
            &contribution_id,
            input.unwrap_or_else(|| serde_json::json!({})),
            &mut store,
        )
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_plugin_panel_document(
    contribution_id: String,
    input: Option<Value>,
    expected_project_revision: i64,
    state: State<'_, AppState>,
) -> Result<PluginViewerDocumentView, String> {
    let context = runtime_context(&state).await.map_err(display_error)?;
    if expected_project_revision != context.project_revision {
        return Err("Plugin Panel is stale after the project changed.".to_string());
    }
    let mut store = read_store(&state).map_err(display_error)?;
    state
        .plugin_permissions
        .get_panel_contribution(
            &context,
            &contribution_id,
            input.unwrap_or_else(|| serde_json::json!({})),
            &mut store,
        )
        .map_err(display_error)
}
