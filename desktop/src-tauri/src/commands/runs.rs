use anyhow::{Context, Result};
use rho_core::ExecutionOrigin;
use rho_extension_runtime::{
    BoundedJson, DiagnosticCode, DiagnosticSeverity, ExtensionDiagnostic,
    InternalExtensionRuntimeMode, SourceCallError,
};
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::{
    AuditLimits, AuditResponse, AuditScope, CompareRunsResponse, ProblemSummary, RunDetail,
    RunSummary,
};
use rho_toolchain::TargetAdmissionMode;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;

use crate::application_state::{active_context, active_session, store_executor};
use crate::internal_extensions::{extension_project_scope_id, run_history_source_capability_id};
use crate::{AppState, display_error};

fn parse_execution_origin(origin: &str) -> ExecutionOrigin {
    match origin {
        "agent" => ExecutionOrigin::Agent,
        "system" => ExecutionOrigin::System,
        _ => ExecutionOrigin::User,
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(transparent)]
pub(crate) struct RunRetryResult(#[specta(type = rho_ui_contract::UiIpcUnknown)] Value);

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_runs(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    state: State<'_, AppState>,
) -> Result<Vec<RunSummary>, String> {
    list_runs_with_state(limit.map(usize::from), &state).await
}

async fn list_runs_legacy(
    limit: Option<usize>,
    state: &AppState,
) -> Result<Vec<RunSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().into_owned();
    store_executor(state)
        .await
        .map_err(display_error)?
        .run_repository()
        .list_runs(project_root, limit)
        .await
        .map_err(display_error)
}

pub(crate) async fn list_runs_with_state(
    limit: Option<usize>,
    state: &AppState,
) -> Result<Vec<RunSummary>, String> {
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Legacy {
        return list_runs_legacy(limit, state).await;
    }

    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let Some(scope) = state.extension_host.scopes().project() else {
        return Err("Run History extension project scope is unavailable".to_string());
    };
    let expected_scope_id = extension_project_scope_id(&project_root).map_err(display_error)?;
    if scope.identity().id != expected_scope_id {
        return Err("Run History extension project scope is stale".to_string());
    }

    let request = BoundedJson::generic(json!({ "limit": limit })).map_err(display_error)?;
    let result = match scope
        .registry()
        .call_source(&run_history_source_capability_id(), request)
        .await
    {
        Ok(result) => result,
        Err(error @ SourceCallError::MissingContribution { .. }) => {
            return Err(display_error(error));
        }
        Err(SourceCallError::Routing(error)) => {
            return Err(display_error(error));
        }
        Err(SourceCallError::Payload(error)) => {
            return Err(display_error(error));
        }
        Err(SourceCallError::Handler(error)) => {
            state
                .extension_host
                .scopes()
                .diagnostics()
                .emit(ExtensionDiagnostic {
                    code: DiagnosticCode::SourceCallFailed,
                    severity: DiagnosticSeverity::Error,
                    plugin_id: None,
                    capability_id: Some(run_history_source_capability_id()),
                    scope_kind: Some(scope.identity().kind.clone()),
                    scope_id: Some(scope.identity().id.clone()),
                    activation_generation: Some(scope.identity().generation),
                    effect_order: None,
                    related_plugins: Vec::new(),
                    cycle_path: Vec::new(),
                    message: error.to_string(),
                });
            return Err(display_error(error));
        }
    };

    state
        .extension_host
        .scopes()
        .validate_project_current(&result.scope)
        .map_err(display_error)?;
    let current_root = state.project_root.read().await.clone();
    if current_root != root {
        return Err("Run History result is stale after a project switch".to_string());
    }
    serde_json::from_value(result.payload.into_value()).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_problems(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    state: State<'_, AppState>,
) -> Result<Vec<ProblemSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().into_owned();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .run_repository()
        .list_problems(project_root, limit.map(usize::from))
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_run_detail(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RunDetail>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().into_owned();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .run_repository()
        .get_run_detail(project_root, run_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn compare_runs(
    left_run_id: String,
    right_run_id: String,
    state: State<'_, AppState>,
) -> Result<CompareRunsResponse, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().into_owned();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .run_repository()
        .compare_runs(project_root, left_run_id, right_run_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn audit_reproducibility(
    scope: String,
    reference_snapshot_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<AuditResponse, String> {
    audit_reproducibility_with_state(scope, reference_snapshot_id, &state).await
}

pub(crate) async fn audit_reproducibility_with_state(
    scope: String,
    reference_snapshot_id: Option<String>,
    state: &AppState,
) -> Result<AuditResponse, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let audit_scope = if scope == "project" {
        AuditScope::Project
    } else if scope == "project_current" {
        AuditScope::CurrentProject
    } else if let Some(rest) = scope.strip_prefix("run:") {
        AuditScope::Run(rest.to_string())
    } else if let Some(rest) = scope.strip_prefix("artifact:") {
        AuditScope::Artifact(rest.to_string())
    } else {
        return Err(format!(
            "invalid audit scope: {scope} (expected 'project', 'project_current', 'run:<id>', or 'artifact:<id>')"
        ));
    };
    store_executor(state)
        .await
        .map_err(display_error)?
        .audit_repository()
        .audit_reproducibility(
            audit_scope,
            project_root,
            reference_snapshot_id,
            AuditLimits::default(),
        )
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn retry_run(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<RunRetryResult, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    crate::commands::toolchain::require_target_admission(&state, TargetAdmissionMode::Run)
        .await
        .map_err(display_error)?;
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let detail = executor
        .run_repository()
        .get_run_detail(project_root, run_id.clone())
        .await
        .map_err(display_error)?
        .context(format!("Run not found: {run_id}"))
        .map_err(display_error)?;
    if !run_is_retryable(&detail.request_type, &detail.origin) {
        return Err(format!(
            "Run type `{}` cannot be retried from history",
            detail.request_type
        ));
    }
    let arguments =
        retry_run_arguments(&detail.arguments_json, &detail.run_id).map_err(display_error)?;
    let payload = json!({
        "arguments": arguments,
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        &detail.request_type,
        &payload,
        parse_execution_origin(&detail.origin),
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map(RunRetryResult)
    .map_err(display_error)
}

pub(crate) fn retry_run_arguments(arguments_json: &str, parent_run_id: &str) -> Result<Value> {
    let mut arguments: Value = serde_json::from_str(arguments_json)?;
    let object = arguments
        .as_object_mut()
        .context("Stored run arguments are invalid")?;
    object.insert(
        "parent_run_id".to_string(),
        Value::String(parent_run_id.to_string()),
    );
    Ok(arguments)
}

pub(crate) fn run_is_retryable(request_type: &str, origin: &str) -> bool {
    request_type == "workspace.execute" && matches!(origin, "user" | "agent")
}
