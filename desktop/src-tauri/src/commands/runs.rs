use anyhow::Result;
use rho_extension_runtime::{
    BoundedJson, DiagnosticCode, DiagnosticSeverity, ExtensionDiagnostic,
    InternalExtensionRuntimeMode, SourceCallError,
};
use rho_store::{
    AuditLimits, AuditResponse, AuditScope, CompareRunsResponse, ProblemSummary,
    ProjectQueryService, RunDetail, RunSummary,
};
use serde_json::json;
use tauri::State;

use crate::{
    AppState, display_error, extension_project_scope_id, read_store,
    run_history_source_capability_id,
};

#[tauri::command]
pub(crate) async fn list_runs(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<RunSummary>, String> {
    list_runs_with_state(limit, &state).await
}

async fn list_runs_legacy(
    limit: Option<usize>,
    state: &AppState,
) -> Result<Vec<RunSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy();
    let store = read_store(state).map_err(display_error)?;
    ProjectQueryService::new(&store)
        .list_runs(project_root.as_ref(), limit)
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

#[tauri::command]
pub(crate) async fn list_problems(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<ProblemSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy();
    let store = read_store(&state).map_err(display_error)?;
    ProjectQueryService::new(&store)
        .list_problems(project_root.as_ref(), limit)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_run_detail(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RunDetail>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy();
    let store = read_store(&state).map_err(display_error)?;
    ProjectQueryService::new(&store)
        .get_run_detail(project_root.as_ref(), &run_id)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn compare_runs(
    left_run_id: String,
    right_run_id: String,
    state: State<'_, AppState>,
) -> Result<CompareRunsResponse, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy();
    let store = read_store(&state).map_err(display_error)?;
    ProjectQueryService::new(&store)
        .compare_runs(project_root.as_ref(), &left_run_id, &right_run_id)
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn audit_reproducibility(
    scope: String,
    reference_snapshot_id: Option<String>,
    state: State<'_, AppState>,
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
    let store = read_store(&state).map_err(display_error)?;
    contain_audit_panic(|| {
        store.audit_reproducibility(
            audit_scope,
            &project_root,
            reference_snapshot_id.as_deref(),
            &AuditLimits::default(),
        )
    })
}

pub(crate) fn contain_audit_panic<T>(operation: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)).map_err(|_| {
        "The project reproducibility check failed unexpectedly. Try the check again.".to_string()
    })
}
