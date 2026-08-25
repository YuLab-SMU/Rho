use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use rho_core::ExecutionOrigin;
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::{
    ArtifactRecordDraft, ArtifactRecordSummary, PlotArtifactSummary, PlotPayloadPruneResult,
    ProjectRetentionSummary, RetentionPolicy, RunDetail,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use uuid::Uuid;

use crate::commands::workspace::{ViewerWorkspaceRequest, viewer_expected_workspace};
use crate::project::{atomic_write_new, project_path, relative_project_path};
use crate::{
    AppState, active_context, active_session, display_error, durable_project_root,
    persist_workspace_identity, store_executor,
};

#[derive(Deserialize)]
pub(crate) struct ExportPlotArtifactRequest {
    plot_id: String,
    path: String,
}

#[derive(Deserialize)]
pub(crate) struct ExportDataViewArtifactRequest {
    path: String,
    format: String,
    object_name: String,
    view_token: String,
    view_kind: String,
    view_key: String,
    row_offset: Option<usize>,
    row_limit: Option<usize>,
    column_offset: Option<usize>,
    column_limit: Option<usize>,
    query: Option<String>,
    sort_column: Option<usize>,
    sort_direction: Option<String>,
    workspace: ViewerWorkspaceRequest,
}

#[derive(Serialize)]
pub(crate) struct ArtifactRecordView {
    #[serde(flatten)]
    artifact: ArtifactRecordSummary,
    file_available: bool,
    file_status: String,
    output_absolute_path: String,
    run: Option<RunDetail>,
}

#[derive(Serialize)]
pub(crate) struct ProjectRetentionView {
    #[serde(flatten)]
    summary: ProjectRetentionSummary,
    policy: RetentionPolicy,
}

pub(crate) fn ensure_artifact_export_target(
    root: &Path,
    path: &str,
    allowed_extensions: &[&str],
) -> Result<(PathBuf, String, String)> {
    let file = project_path(root, path)?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    ensure!(
        allowed_extensions
            .iter()
            .any(|allowed| *allowed == extension),
        "Artifact export path must use one of: {}",
        allowed_extensions.join(", ")
    );
    ensure!(
        !file.exists(),
        "Artifact export destination already exists: {}",
        path
    );
    let relative = relative_project_path(root, &file)?;
    let absolute = file.to_string_lossy().replace('\\', "/");
    Ok((file, relative, absolute))
}

fn artifact_file_status(root: &Path, output_path: &str) -> (String, bool, &'static str) {
    match project_path(root, output_path) {
        Ok(path) => {
            let absolute = path.to_string_lossy().replace('\\', "/");
            if !path.is_file() {
                return (absolute, false, "missing");
            }
            let supported = matches!(
                path.extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "html"
                    | "htm"
                    | "md"
                    | "r"
                    | "rmd"
                    | "txt"
                    | "log"
                    | "json"
                    | "csv"
                    | "tsv"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
            );
            if supported {
                (absolute, true, "available")
            } else {
                (absolute, true, "unsupported")
            }
        }
        Err(_) => (output_path.to_string(), false, "missing"),
    }
}

fn artifact_provenance_status(
    run: Option<&RunDetail>,
    source_path: Option<&str>,
    document_version: Option<i64>,
) -> (bool, Option<String>) {
    if run.is_none() {
        return (false, Some("run_link_unavailable".to_string()));
    }
    if source_path.is_none() {
        return (false, Some("source_path_unavailable".to_string()));
    }
    if document_version.is_none() {
        return (false, Some("document_version_unavailable".to_string()));
    }
    (true, None)
}

pub(crate) fn has_png_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
}

pub(crate) fn decode_plot_png_base64(encoded: &str) -> Result<Vec<u8>> {
    let mut normalized = encoded
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    ensure!(!normalized.is_empty(), "PNG plot payload is empty");
    let remainder = normalized.len() % 4;
    ensure!(remainder != 1, "PNG plot payload has invalid base64 length");
    normalized.extend(std::iter::repeat_n('=', (4 - remainder) % 4));
    BASE64_STANDARD
        .decode(normalized)
        .context("decoding PNG plot payload")
}

fn quote_delimited_cell(value: Option<&str>, delimiter: char) -> String {
    let text = value.unwrap_or_default();
    if !text.contains('"')
        && !text.contains('\n')
        && !text.contains('\r')
        && !text.contains(delimiter)
    {
        return text.to_string();
    }
    format!("\"{}\"", text.replace('"', "\"\""))
}

pub(crate) fn data_view_delimited_text(page: &Value, delimiter: char) -> Result<String> {
    let columns = page
        .get("columns")
        .and_then(Value::as_array)
        .context("Data view page is missing columns")?;
    let rows = page
        .get("rows")
        .and_then(Value::as_array)
        .context("Data view page is missing rows")?;
    let mut lines = Vec::with_capacity(rows.len() + 1);
    let mut header = Vec::with_capacity(columns.len() + 1);
    header.push(quote_delimited_cell(Some("row_name"), delimiter));
    for column in columns {
        header.push(quote_delimited_cell(
            column
                .get("label")
                .and_then(Value::as_str)
                .or_else(|| column.get("name").and_then(Value::as_str)),
            delimiter,
        ));
    }
    lines.push(header.join(&delimiter.to_string()));
    for row in rows {
        let cells = row
            .get("cells")
            .and_then(Value::as_array)
            .context("Data view row is missing cells")?;
        let mut fields = Vec::with_capacity(cells.len() + 1);
        fields.push(quote_delimited_cell(
            row.get("row_name").and_then(Value::as_str),
            delimiter,
        ));
        for cell in cells {
            let value = match cell {
                Value::Null => String::new(),
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            fields.push(quote_delimited_cell(Some(&value), delimiter));
        }
        lines.push(fields.join(&delimiter.to_string()));
    }
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

pub(crate) fn data_view_artifact_metadata(
    page: &Value,
    object_name: &str,
    view_kind: &str,
    view_key: &str,
    format: &str,
) -> Value {
    json!({
        "object_name": object_name,
        "view_kind": view_kind,
        "view_key": view_key,
        "row_offset": page.get("row_offset").and_then(Value::as_u64),
        "row_count": page.get("rows").and_then(Value::as_array).map(Vec::len),
        "column_offset": page.get("column_offset").and_then(Value::as_u64),
        "column_count": page.get("columns").and_then(Value::as_array).map(Vec::len),
        "query": page.get("query").cloned().unwrap_or(Value::Null),
        "sort_column": page.get("sort_column").cloned().unwrap_or(Value::Null),
        "sort_direction": page.get("sort_direction").cloned().unwrap_or(Value::Null),
        "format": format,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_plot_artifacts(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<PlotArtifactSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.identity().workspace_id.clone();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .list_plots(
            project_root,
            Some(workspace_id),
            session_only.unwrap_or(true),
            limit.map(usize::from),
        )
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn export_plot_artifact(
    request: ExportPlotArtifactRequest,
    state: State<'_, AppState>,
) -> Result<ArtifactRecordView, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let (file, output_path, output_absolute_path) =
        ensure_artifact_export_target(&root, &request.path, &["png"]).map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let artifact_repository = context.executor.artifact_repository();
    let plot = artifact_repository
        .get_plot(project_root.clone(), request.plot_id.clone())
        .await
        .map_err(display_error)?
        .context(format!("Plot artifact not found: {}", request.plot_id))
        .map_err(display_error)?;
    if plot.media_type != "image/png" {
        return Err("Only PNG plot export is supported in WP3".to_string());
    }
    let payload: Value = serde_json::from_str(&plot.payload_json).map_err(display_error)?;
    let encoded = payload
        .get("image/png")
        .and_then(Value::as_str)
        .context("PNG plot payload is unavailable")
        .map_err(display_error)?;
    let bytes = decode_plot_png_base64(encoded).map_err(display_error)?;
    if !has_png_signature(&bytes) {
        return Err("Plot PNG payload has an invalid signature".to_string());
    }
    atomic_write_new(&file, &bytes).map_err(display_error)?;
    let run = context
        .executor
        .run_repository()
        .get_run_detail(project_root, plot.run_id.clone())
        .await
        .map_err(display_error)?;
    let (provenance_complete, incomplete_reason) = artifact_provenance_status(
        run.as_ref(),
        plot.source_path.as_deref(),
        plot.document_version,
    );
    let artifact = ArtifactRecordDraft {
        artifact_id: format!("artifact_{}", Uuid::new_v4().simple()),
        artifact_kind: "plot_export".to_string(),
        run_id: Some(plot.run_id.clone()),
        project_root: root.to_string_lossy().replace('\\', "/"),
        output_path,
        source_path: plot.source_path.clone(),
        execution_mode: plot.execution_mode.clone(),
        document_version: plot.document_version,
        workspace_id: plot.workspace_id.clone(),
        state_revision: plot.state_revision,
        project_revision: plot.project_revision,
        media_type: "image/png".to_string(),
        metadata_json: serde_json::to_string(&json!({
            "plot_id": plot.plot_id,
            "payload_media_type": plot.media_type,
        }))
        .map_err(display_error)?,
        provenance_complete,
        incomplete_reason,
    };
    let detail = artifact_repository
        .create_record(artifact)
        .await
        .map_err(display_error)?;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    persist_workspace_identity(&context.executor, identity)
        .await
        .map_err(display_error)?;
    Ok(ArtifactRecordView {
        artifact: detail,
        file_available: true,
        file_status: "available".to_string(),
        output_absolute_path,
        run,
    })
}

/// Inline preview payload for one plot artifact. Capped so a runaway plot
/// cannot flood the webview through a data URL.
const MAX_PLOT_PREVIEW_BASE64_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct PlotImageView {
    plot_id: String,
    media_type: String,
    data_base64: String,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn read_plot_artifact(
    plot_id: String,
    state: State<'_, AppState>,
) -> Result<PlotImageView, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let plot = store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .get_plot(project_root, plot_id.clone())
        .await
        .map_err(display_error)?
        .context(format!("Plot artifact not found: {plot_id}"))
        .map_err(display_error)?;
    if plot.media_type != "image/png" {
        return Err(format!(
            "Plot media type {} cannot be previewed inline",
            plot.media_type
        ));
    }
    let payload: Value = serde_json::from_str(&plot.payload_json).map_err(display_error)?;
    let encoded = payload
        .get("image/png")
        .and_then(Value::as_str)
        .context("PNG plot payload is unavailable")
        .map_err(display_error)?;
    if encoded.len() > MAX_PLOT_PREVIEW_BASE64_BYTES {
        return Err("Plot image exceeds the inline preview budget".to_string());
    }
    Ok(PlotImageView {
        plot_id,
        media_type: plot.media_type,
        data_base64: encoded.to_string(),
    })
}

#[tauri::command]
pub(crate) async fn export_data_view_artifact(
    request: ExportDataViewArtifactRequest,
    state: State<'_, AppState>,
) -> Result<ArtifactRecordView, String> {
    let format = request.format.to_ascii_lowercase();
    if !matches!(format.as_str(), "csv" | "tsv") {
        return Err("Visible table export format must be csv or tsv".to_string());
    }
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let (file, output_path, output_absolute_path) =
        ensure_artifact_export_target(&root, &request.path, &[format.as_str()])
            .map_err(display_error)?;
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "object_name": request.object_name,
            "view_token": request.view_token,
            "view_kind": request.view_kind,
            "view_key": request.view_key,
            "row_offset": request.row_offset.unwrap_or(0),
            "row_limit": request.row_limit.unwrap_or(50),
            "column_offset": request.column_offset.unwrap_or(0),
            "column_limit": request.column_limit.unwrap_or(20),
            "query": request.query,
            "sort_column": request.sort_column,
            "sort_direction": request.sort_direction
        },
        "expected_workspace": viewer_expected_workspace(&request.workspace)
    });
    let response = dispatch_workspace_request(
        "workspace.read_data_view",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)?;
    let page = response
        .get("execution")
        .and_then(|value| value.get("page"))
        .context("Workspace data view did not return a page")
        .map_err(display_error)?;
    let delimiter = if format == "tsv" { '\t' } else { ',' };
    let content = data_view_delimited_text(page, delimiter).map_err(display_error)?;
    atomic_write_new(&file, content.as_bytes()).map_err(display_error)?;
    let run = match (
        request.workspace.kernel_instance_id.as_deref(),
        request.workspace.state_revision,
        request.workspace.project_revision,
    ) {
        (Some(workspace_id), Some(state_revision), Some(project_revision)) => executor
            .run_repository()
            .find_for_workspace_state(
                project_root.clone(),
                workspace_id.to_string(),
                state_revision as i64,
                project_revision as i64,
            )
            .await
            .map_err(display_error)?,
        _ => None,
    };
    let source_path = run.as_ref().and_then(|item| item.source_path.clone());
    let document_version = run.as_ref().and_then(|item| item.document_version);
    let run_id = run.as_ref().map(|item| item.run_id.clone());
    let (provenance_complete, incomplete_reason) =
        artifact_provenance_status(run.as_ref(), source_path.as_deref(), document_version);
    let artifact = ArtifactRecordDraft {
        artifact_id: format!("artifact_{}", Uuid::new_v4().simple()),
        artifact_kind: "table_export".to_string(),
        run_id,
        project_root: root.to_string_lossy().replace('\\', "/"),
        output_path,
        source_path,
        execution_mode: Some("table_export".to_string()),
        document_version,
        workspace_id: request.workspace.kernel_instance_id.clone(),
        state_revision: request.workspace.state_revision.map(|value| value as i64),
        project_revision: request.workspace.project_revision.map(|value| value as i64),
        media_type: if format == "tsv" {
            "text/tab-separated-values"
        } else {
            "text/csv"
        }
        .to_string(),
        metadata_json: serde_json::to_string(&data_view_artifact_metadata(
            page,
            &request.object_name,
            &request.view_kind,
            &request.view_key,
            &format,
        ))
        .map_err(display_error)?,
        provenance_complete,
        incomplete_reason,
    };
    let detail = executor
        .artifact_repository()
        .create_record(artifact)
        .await
        .map_err(display_error)?;
    broker.project_changed();
    let identity = broker.identity().clone();
    persist_workspace_identity(executor, identity)
        .await
        .map_err(display_error)?;
    Ok(ArtifactRecordView {
        artifact: detail,
        file_available: true,
        file_status: "available".to_string(),
        output_absolute_path,
        run,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_artifact_records(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ArtifactRecordSummary>, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.identity().workspace_id.clone();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .list_records(
            root.to_string_lossy().replace('\\', "/"),
            Some(workspace_id),
            session_only.unwrap_or(false),
            limit.map(usize::from),
        )
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_artifact_record(
    artifact_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ArtifactRecordView>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let Some(projection) = store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .get_record(project_root, artifact_id)
        .await
        .map_err(display_error)?
    else {
        return Ok(None);
    };
    let (output_absolute_path, file_available, file_status) =
        artifact_file_status(&root, &projection.artifact.output_path);
    Ok(Some(ArtifactRecordView {
        artifact: projection.artifact,
        file_available,
        file_status: file_status.to_string(),
        output_absolute_path,
        run: projection.run,
    }))
}

#[tauri::command]
pub(crate) async fn clear_artifact_records(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.identity().workspace_id.clone();
    let deleted = store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .clear_records(
            root.to_string_lossy().into_owned(),
            Some(workspace_id),
            session_only.unwrap_or(false),
        )
        .await
        .map_err(display_error)?;
    Ok(json!({ "deleted": deleted }))
}

#[tauri::command]
pub(crate) async fn clear_plot_artifacts(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.identity().workspace_id.clone();
    let deleted = store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .clear_plots(
            project_root,
            Some(workspace_id),
            session_only.unwrap_or(true),
        )
        .await
        .map_err(display_error)?;
    Ok(json!({"deleted": deleted}))
}

#[tauri::command]
pub(crate) async fn prune_plot_payloads(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PlotPayloadPruneResult, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.identity().workspace_id.clone();
    store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .prune_plot_payloads(
            project_root,
            Some(workspace_id),
            session_only.unwrap_or(true),
        )
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn get_project_retention_summary(
    state: State<'_, AppState>,
) -> Result<ProjectRetentionView, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.identity().workspace_id.clone();
    let retention = store_executor(&state)
        .await
        .map_err(display_error)?
        .artifact_repository()
        .retention(project_root, Some(workspace_id))
        .await
        .map_err(display_error)?;
    let policy = RetentionPolicy {
        max_runtime_output_bytes_per_execution: retention
            .runtime_policy
            .max_runtime_output_bytes_per_execution,
        runtime_output_project_warning_bytes: retention
            .runtime_policy
            .runtime_output_project_warning_bytes,
        max_runtime_execution_rows: retention.runtime_policy.max_runtime_execution_rows,
        auto_prune_enabled: retention.runtime_policy.auto_prune_enabled,
        ..RetentionPolicy::default()
    };
    Ok(ProjectRetentionView {
        summary: retention.summary,
        policy,
    })
}
