use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Result, ensure};
use rho_extension_runtime::InternalExtensionRuntimeMode;
use rho_server::coordinator::{ProjectSkillDiscoverySummary, discover_project_skill_summaries};
use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::project::{
    MAX_VIEWER_FILE_BYTES, MAX_VIEWER_HTML_BYTES, ProjectRestoreResponse, ProjectSessionSnapshot,
    ProjectState, atomic_write, atomic_write_new, default_project_root,
    ensure_editable_content_size, ensure_editable_file, ensure_editable_file_size,
    list_project_files, normalize_existing_project_root, project_path, read_viewer_file,
    validate_project_root,
};
use crate::{
    AppState, active_context, display_error, persist_workspace_identity,
    project_file_viewer_capability_id, switch_project, text_sha256, write_startup_log,
};

#[tauri::command]
pub(crate) async fn project_state(state: State<'_, AppState>) -> Result<ProjectState, String> {
    let root = state.project_root.read().await.clone();
    list_project_files(&root).map_err(display_error)
}

#[tauri::command]
pub(crate) async fn project_mark_files_changed(
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    persist_workspace_identity(&context.executor, identity.clone())
        .await
        .map_err(display_error)?;
    serde_json::to_value(identity).map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn project_open(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectRestoreResponse, String> {
    let root = validate_project_root(Path::new(&path)).map_err(display_error)?;
    let session_snapshot = state.project_store.load_session_or_default(&root);
    switch_project(root, Some(session_snapshot), app, &state)
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn project_pick_directory(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectRestoreResponse, String> {
    let Some(path) = rfd::FileDialog::new().pick_folder() else {
        return Ok(ProjectRestoreResponse::cancelled());
    };
    let root = normalize_existing_project_root(&path).map_err(display_error)?;
    let session_snapshot = state.project_store.load_session_or_default(&root);
    switch_project(root, Some(session_snapshot), app, &state)
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn project_restore_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectRestoreResponse, String> {
    let started = Instant::now();
    let requested_root = state
        .project_store
        .last_opened_project()
        .map_err(display_error)?
        .unwrap_or_else(default_project_root);
    let root = match normalize_existing_project_root(&requested_root) {
        Ok(root) => root,
        Err(error) => {
            return Ok(ProjectRestoreResponse::unavailable(
                requested_root.to_string_lossy().replace('\\', "/"),
                error.to_string(),
            ));
        }
    };
    let session_snapshot = state.project_store.load_session_or_default(&root);
    let result = switch_project(root.clone(), Some(session_snapshot), app, &state)
        .await
        .map_err(|error| {
            write_startup_log(&format!(
                "project_restore_session failed for {}: {error:#}",
                root.display()
            ));
            display_error(error)
        });
    write_startup_log(&format!(
        "startup_phase=project_restore elapsed_ms={} outcome={}",
        started.elapsed().as_millis(),
        if result.is_ok() { "ok" } else { "failed" }
    ));
    result
}

#[tauri::command]
pub(crate) async fn project_save_session(
    snapshot: ProjectSessionSnapshot,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    state
        .project_store
        .save_session(&root, &snapshot)
        .map_err(display_error)?;
    Ok(json!({"status": "saved"}))
}

#[tauri::command]
pub(crate) async fn project_read_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let file = project_path(&root, &path).map_err(display_error)?;
    ensure_editable_file_size(&file).map_err(display_error)?;
    let content = std::fs::read_to_string(&file).map_err(display_error)?;
    let sha256 = text_sha256(&content);
    Ok(json!({"path": path, "content": content, "sha256": sha256}))
}

#[tauri::command]
pub(crate) async fn viewer_read_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<crate::project::ViewerFile, String> {
    viewer_read_file_with_state(path, &state).await
}

pub(crate) async fn viewer_read_file_with_state(
    path: String,
    state: &AppState,
) -> Result<crate::project::ViewerFile, String> {
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Legacy {
        let root = state.project_root.read().await.clone();
        return read_viewer_file(&root, &path).map_err(display_error);
    }
    let application = state.extension_host.scopes().application();
    let resolution = application
        .registry()
        .resolve_project_file_viewer(&project_file_viewer_capability_id())
        .map_err(display_error)?;
    if resolution.contribution().general_maximum_bytes() != MAX_VIEWER_FILE_BYTES as usize
        || resolution.contribution().html_maximum_bytes() != MAX_VIEWER_HTML_BYTES as usize
    {
        return Err("Project file viewer contribution has incompatible size limits".to_string());
    }
    let root = state.project_root.read().await.clone();
    let viewed = read_viewer_file(&root, &path).map_err(display_error)?;
    let current_root = state.project_root.read().await.clone();
    if current_root != root {
        return Err("Project file viewer result is stale after a project switch".to_string());
    }
    if !resolution
        .contribution()
        .supported_media_types()
        .iter()
        .any(|media_type| media_type == viewed.media_type)
    {
        return Err(format!(
            "Project file viewer contribution does not declare media type {}",
            viewed.media_type
        ));
    }
    Ok(viewed)
}

#[tauri::command]
pub(crate) async fn project_write_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<ProjectState, String> {
    ensure_editable_content_size(&content).map_err(display_error)?;
    let root = state.project_root.read().await.clone();
    let file = project_path(&root, &path).map_err(display_error)?;
    ensure_editable_file(&file).map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    atomic_write(&file, content.as_bytes()).map_err(display_error)?;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    persist_workspace_identity(&context.executor, identity)
        .await
        .map_err(display_error)?;
    drop(context);
    project_state(state).await
}

#[tauri::command]
pub(crate) async fn project_create_file(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<ProjectState, String> {
    ensure_editable_content_size(&content).map_err(display_error)?;
    let root = state.project_root.read().await.clone();
    let file = project_path(&root, &path).map_err(display_error)?;
    ensure_editable_file(&file).map_err(display_error)?;
    if file.exists() {
        return Err(format!("Project file already exists: {path}"));
    }
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    atomic_write_new(&file, content.as_bytes()).map_err(display_error)?;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    persist_workspace_identity(&context.executor, identity)
        .await
        .map_err(display_error)?;
    drop(context);
    project_state(state).await
}

#[tauri::command]
pub(crate) async fn project_delete_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectState, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    safe_delete_project_file(&root, &path).map_err(display_error)?;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    persist_workspace_identity(&context.executor, identity)
        .await
        .map_err(display_error)?;
    drop(context);
    project_state(state).await
}

#[tauri::command]
pub(crate) async fn list_project_skills(
    state: State<'_, AppState>,
) -> Result<ProjectSkillDiscoverySummary, String> {
    let root = state.project_root.read().await.clone();
    let normalized = root.to_string_lossy().replace('\\', "/");
    if normalized.trim().is_empty() {
        return Ok(ProjectSkillDiscoverySummary::default());
    }
    Ok(discover_project_skill_summaries(&normalized))
}

fn project_delete_target(root: &Path, path: &str) -> Result<PathBuf> {
    let file = project_path(root, path)?;
    ensure_editable_file(&file)?;
    ensure!(file.exists(), "Project file does not exist: {path}");
    ensure!(file.is_file(), "Project path is not a file: {path}");
    Ok(file)
}

pub(crate) fn safe_delete_project_file(root: &Path, path: &str) -> Result<()> {
    let file = project_delete_target(root, path)?;
    std::fs::remove_file(&file)?;
    Ok(())
}
