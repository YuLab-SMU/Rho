use std::collections::HashMap;
use std::path::Path;

use anyhow::Context;
use rho_core::ExecutionOrigin;
use rho_server::coordinator::{
    ApprovalResponseInput, EnvironmentOperationArguments, decide_environment_operation,
    dispatch_workspace_request, request_environment_operation,
};
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::{EnvironmentOperationRequestSummary, normalize_project_root};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use crate::application_state::{active_context, active_session, store_executor};
use crate::{AppState, display_error};

#[derive(Deserialize)]
pub(crate) struct EnvironmentOperationRequestInput {
    operation: String,
    repositories: Option<HashMap<String, String>>,
    bioconductor: Option<String>,
    package: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct EnvironmentOperationDecisionRequest {
    request_id: String,
    decision: String,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(transparent)]
pub(crate) struct InstalledPackageInventory(#[specta(type = rho_ui_contract::UiIpcUnknown)] Value);

#[tauri::command]
pub(crate) async fn request_environment_operation_preview(
    request: EnvironmentOperationRequestInput,
    state: State<'_, AppState>,
) -> Result<EnvironmentOperationRequestSummary, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    request_environment_operation(
        EnvironmentOperationArguments {
            operation: request.operation,
            project_root: None,
            repositories: request.repositories,
            bioconductor: request.bioconductor,
            package: request.package,
            project_library: None,
        },
        None,
        "user",
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_environment_operation_requests(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<EnvironmentOperationRequestSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    store_executor(&state)
        .await
        .map_err(display_error)?
        .environment_repository()
        .list_requests(project_root, limit.map(usize::from), status)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_environment_operation_request(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<Option<EnvironmentOperationRequestSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    store_executor(&state)
        .await
        .map_err(display_error)?
        .environment_repository()
        .get_request(project_root, request_id)
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_installed_packages(
    limit: Option<rho_ui_contract::UiIpcU64>,
    state: State<'_, AppState>,
) -> Result<InstalledPackageInventory, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "limit": limit.map(u64::from).unwrap_or(500) },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.list_installed_packages",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map(InstalledPackageInventory)
    .map_err(display_error)
}

pub(crate) fn lockfile_inventory_arguments(project_root: &Path, limit: Option<u64>) -> Value {
    json!({
        "project_root": normalize_project_root(project_root.to_string_lossy().as_ref()),
        "limit": limit.unwrap_or(500).clamp(1, 500)
    })
}

#[tauri::command]
pub(crate) async fn list_lockfile_packages(
    limit: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": lockfile_inventory_arguments(&root, limit),
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.list_lockfile_packages",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn respond_environment_operation(
    request: EnvironmentOperationDecisionRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !matches!(request.decision.as_str(), "approve" | "reject" | "cancel") {
        return Err(format!(
            "unsupported environment operation decision `{}`",
            request.decision
        ));
    }
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let environment_store = store_executor(&state)
        .await
        .map_err(display_error)?
        .environment_repository();
    let pending = environment_store
        .get_request(project_root, request.request_id.clone())
        .await
        .map_err(display_error)?
        .filter(|item| item.status == "requested")
        .context(format!(
            "Environment operation request not found or no longer pending: {}",
            request.request_id
        ))
        .map_err(display_error)?;
    if pending.source == "agent" {
        let delivered = state
            .environment_approvals
            .respond_for_turn(
                &request.request_id,
                pending.turn_id.as_deref(),
                ApprovalResponseInput {
                    decision: request.decision.clone(),
                    reason: request.reason.clone(),
                },
            )
            .await;
        if !delivered {
            environment_store
                .decide_request(
                    request.request_id.clone(),
                    rho_store::EnvironmentOperationDecisionRecord {
                        decision: "cancel".to_string(),
                        status: "interrupted".to_string(),
                        reason: Some(
                            "Environment operation channel is no longer active.".to_string(),
                        ),
                    },
                )
                .await
                .map_err(display_error)?;
        }
        return Ok(json!({
            "status": if delivered { "delivered" } else { "not_delivered" },
            "request_id": request.request_id,
            "turn_id": pending.turn_id
        }));
    }

    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    decide_environment_operation(
        &request.request_id,
        &request.decision,
        request.reason,
        ExecutionOrigin::User,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}
