use anyhow::{Context, Result, ensure};
use rho_core::ExecutionOrigin;
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::workspace_lane::WorkspaceBrokerState;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::State;

use crate::application_state::{active_context, active_session};
use crate::{AppState, display_error};

#[derive(Deserialize)]
pub(crate) struct EditorFormatRequest {
    path: String,
    source: String,
    document_version: i64,
}

pub(crate) fn editor_format_result(response: Value) -> Result<Value> {
    let execution = response
        .get("execution")
        .cloned()
        .context("Formatting response omitted the Workspace R result")?;
    ensure!(
        execution.get("kind").and_then(Value::as_str) == Some("rho.editor_format_result.v1"),
        "Formatting response returned an unexpected Workspace R result"
    );
    Ok(execution)
}

#[tauri::command]
pub(crate) async fn editor_goto_definition(
    name: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "name": name, "project_root": project_root },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.find_function_definition",
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
pub(crate) async fn editor_find_project_references(
    name: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "name": name,
            "project_root": project_root,
            "limit": limit.unwrap_or(100).clamp(1, 200)
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.find_project_references",
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
pub(crate) async fn editor_discover_chunks(
    path: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "path": path },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.discover_chunks",
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
pub(crate) async fn editor_package_functions(
    packages: Option<Vec<String>>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "packages": packages,
            "limit": limit.unwrap_or(500)
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.list_package_functions",
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
pub(crate) async fn editor_function_help(
    name: String,
    package: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "name": name,
            "package": package
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.function_help",
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
pub(crate) async fn editor_function_documentation(
    name: String,
    package: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "name": name, "package": package },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.function_documentation",
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
pub(crate) async fn editor_lint_file(
    path: String,
    document_version: i64,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": { "path": path, "document_version": document_version },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.lint_file",
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
pub(crate) async fn editor_format_source(
    request: EditorFormatRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let EditorFormatRequest {
        path,
        source,
        document_version,
    } = request;
    let payload = json!({
        "arguments": {
            "path": path.clone(),
            "source": source,
            "source_path": path,
            "document_version": document_version
        },
        "expected_workspace": broker.identity()
    });
    let response = dispatch_workspace_request(
        "workspace.format_r_source",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)?;
    editor_format_result(response).map_err(display_error)
}
