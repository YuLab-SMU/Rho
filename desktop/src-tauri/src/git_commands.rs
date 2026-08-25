use std::path::Path;

use serde_json::{Value, json};
use tauri::State;

use crate::{AppState, git, git_review};

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn git_status(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    let root = state.project_root.read().await.clone();
    git::git_status(Path::new(&root)).map_err(|error| error.to_string())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn git_log(
    limit: Option<rho_ui_contract::UiIpcUsize>,
    state: State<'_, AppState>,
) -> Result<Vec<git::GitLogEntry>, String> {
    let root = state.project_root.read().await.clone();
    git::git_log(Path::new(&root), limit.map(usize::from).unwrap_or(20))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_diff(
    staged: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<git_review::GitReviewFile>, String> {
    let root = state.project_root.read().await.clone();
    git_review::list_files(Path::new(&root), staged.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_stage(
    file_path: String,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::stage_file(Path::new(&root), &file_path, &expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_commit(
    message: String,
    expected_staged_revision: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = state.project_root.read().await.clone();
    git_review::commit(Path::new(&root), &message, &expected_staged_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_diff_unified(
    file_path: String,
    staged: Option<bool>,
    state: State<'_, AppState>,
) -> Result<git_review::GitReviewDiff, String> {
    let root = state.project_root.read().await.clone();
    git_review::review_diff(Path::new(&root), &file_path, staged.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_hunk_stage(
    file_path: String,
    hunk_index: usize,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::stage_hunk(Path::new(&root), &file_path, hunk_index, &expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_hunk_unstage(
    file_path: String,
    hunk_index: usize,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::unstage_hunk(Path::new(&root), &file_path, hunk_index, &expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_restore_file(
    file_path: String,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::restore_file(Path::new(&root), &file_path, &expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_unstage_file(
    file_path: String,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::unstage_file(Path::new(&root), &file_path, &expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_staged_revision(state: State<'_, AppState>) -> Result<String, String> {
    let root = state.project_root.read().await.clone();
    git_review::staged_revision(Path::new(&root)).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn git_list_conflicts(state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = Path::new(&*root);
    let merge_head = git::run_git(project_root, &["rev-parse", "--short", "MERGE_HEAD"])
        .map(|value| value.trim().to_string())
        .ok();
    let output = git::run_git(project_root, &["diff", "--name-only", "--diff-filter=U"])
        .map_err(|error| error.to_string())?;
    let files: Vec<String> = output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    Ok(json!({
        "files": files,
        "merge_head": merge_head,
        "has_conflicts": !files.is_empty(),
    }))
}

#[tauri::command]
pub(crate) async fn git_resolve_conflict(
    file_path: String,
    resolution: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    let root_path = Path::new(&*root);
    match resolution.as_str() {
        "ours" => {
            git::run_git(root_path, &["checkout", "--ours", "--", &file_path])
                .map_err(|error| error.to_string())?;
            git::run_git(root_path, &["add", "--", &file_path])
                .map_err(|error| error.to_string())?;
        }
        "theirs" => {
            git::run_git(root_path, &["checkout", "--theirs", "--", &file_path])
                .map_err(|error| error.to_string())?;
            git::run_git(root_path, &["add", "--", &file_path])
                .map_err(|error| error.to_string())?;
        }
        "mark" => {
            git::run_git(root_path, &["add", "--", &file_path])
                .map_err(|error| error.to_string())?;
        }
        other => return Err(format!("unknown resolution: {other}")),
    }
    Ok(())
}
