#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_llm;
mod project;

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock as SyncRwLock};
use std::time::{Duration, Instant};

use agent_llm::{
    AgentLlmSettingsView, AgentModelProfile, AgentModelTestControl, AgentProviderProfile,
    DeleteModelRequest,
};
use anyhow::{Context, Result, bail, ensure};
use project::{
    ProjectRestoreResponse, ProjectSessionSnapshot, ProjectSessionStore, ProjectState,
    ProjectWatcherControl, atomic_write, atomic_write_new, default_project_root,
    ensure_editable_content_size, ensure_editable_file, ensure_editable_file_size,
    list_project_files, normalize_existing_project_root, project_path, replace_project_watcher,
    validate_project_root,
};
use rho_core::{BrokerState, ExecutionOrigin};
use rho_kernel::{ArkLaunchConfig, ArkSession};
use rho_server::coordinator::{
    ApprovalResponseInput, CoordinatorRuntime, PendingApprovalRegistry, bootstrap_bridge,
    dispatch_workspace_request, run_agent_turn,
};
use rho_store::{
    AgentTurnDetail, AgentTurnDraft, AgentTurnEventDraft, AgentTurnFinish, AgentTurnSummary,
    ApprovalRequestSummary, PlotArtifactSummary, ProblemSummary, RunDetail, RunSummary, Store,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, RwLock, oneshot};
use uuid::Uuid;

const BRIDGE_STATE: &str = include_str!("../../../r/rho.bridge/R/state.R");
const BRIDGE_EXECUTE: &str = include_str!("../../../r/rho.bridge/R/execute.R");
const BRIDGE_WORKSPACE: &str = include_str!("../../../r/rho.bridge/R/workspace.R");
const AGENT_STATE: &str = include_str!("../../../r/rho.agent/R/aaa-state.R");
const AGENT_TRANSPORT: &str = include_str!("../../../r/rho.agent/R/transport.R");
const AGENT_ADAPTER: &str = include_str!("../../../r/rho.agent/R/aisdk_adapter.R");
#[derive(Clone)]
struct RuntimeConfig {
    data_dir: PathBuf,
    kernelspec: PathBuf,
    rscript: PathBuf,
    r_version: String,
    r_home: String,
    r_profile_user: PathBuf,
    r_environ_user: PathBuf,
    bridge_package: PathBuf,
    agent_package: PathBuf,
    agent_runtime: AgentRuntimeStatus,
    store_path: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum StartupSeverity {
    Recoverable,
    Fatal,
}

#[derive(Clone, Serialize)]
struct StartupIssue {
    code: String,
    phase: String,
    severity: StartupSeverity,
    title: String,
    message: String,
    technical_detail: String,
    actions: Vec<String>,
    diagnostics_path: String,
}

#[derive(Clone, Serialize)]
struct StartupRuntimeView {
    rscript: String,
    r_version: String,
    agent_runtime: AgentRuntimeStatus,
}

#[derive(Clone, Serialize)]
struct StartupView {
    phase: String,
    busy: bool,
    runtime: Option<StartupRuntimeView>,
    issue: Option<StartupIssue>,
}

#[derive(Clone, Serialize)]
struct AgentRuntimeStatus {
    available: bool,
    aisdk_version: Option<String>,
    error: Option<String>,
}

struct RRuntimeProbe {
    r_home: String,
    r_version: String,
    r_libs: String,
    r_profile_user: PathBuf,
    r_environ_user: PathBuf,
}

struct ProbeProcessOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    elapsed_ms: u128,
    timed_out: bool,
}

#[derive(Clone, Copy)]
enum RProbeStartup {
    Controlled,
    UserProfile,
}

struct AppState {
    data_dir: PathBuf,
    ark: PathBuf,
    config: SyncRwLock<Option<RuntimeConfig>>,
    selected_rscript: SyncRwLock<Option<PathBuf>>,
    startup: SyncRwLock<StartupView>,
    project_store: ProjectSessionStore,
    project_root: RwLock<PathBuf>,
    project_watcher: Mutex<Option<ProjectWatcherControl>>,
    session: RwLock<Option<Arc<ArkSession>>>,
    context: Mutex<Option<Arc<Mutex<CoordinatorRuntime>>>>,
    approvals: Arc<PendingApprovalRegistry>,
    agent_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    agent_llm_test_control: AgentModelTestControl,
    shutdown_started: AtomicBool,
}

static STARTUP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Serialize)]
struct WorkspaceStatus {
    status: &'static str,
    r_version: String,
    r_home: String,
    kernel_pid: Option<u32>,
    workspace: Option<Value>,
    agent_runtime: AgentRuntimeStatus,
    python_required: bool,
}

#[derive(Deserialize)]
struct ExecuteRequest {
    code: String,
    source_path: Option<String>,
    execution_mode: Option<String>,
    document_version: Option<i64>,
}

#[derive(Deserialize)]
struct InspectObjectRequest {
    name: String,
}

#[derive(Deserialize)]
struct RenderRequest {
    path: String,
    format: Option<String>,
    document_version: Option<i64>,
}

#[derive(Deserialize)]
struct AgentLlmSelectRequest {
    model_id: String,
}

fn runtime_config(state: &AppState) -> Result<RuntimeConfig> {
    state
        .config
        .read()
        .map_err(|_| anyhow::anyhow!("STARTUP_NOT_READY: runtime state lock is unavailable"))?
        .clone()
        .context("STARTUP_NOT_READY: finish Rho startup before using the workbench")
}

fn current_startup_view(state: &AppState) -> StartupView {
    state
        .startup
        .read()
        .map(|view| view.clone())
        .unwrap_or_else(|_| StartupView {
            phase: "failed".to_string(),
            busy: false,
            runtime: None,
            issue: Some(startup_issue(
                "APP_STATE_UNAVAILABLE",
                "shell_ready",
                StartupSeverity::Fatal,
                "Rho could not read its startup state",
                "Restart Rho. If the problem continues, open the diagnostic log.",
                "startup state lock was poisoned".to_string(),
                vec!["open_log".to_string(), "exit".to_string()],
            )),
        })
}

#[tauri::command]
async fn startup_status(state: State<'_, AppState>) -> Result<StartupView, String> {
    Ok(current_startup_view(&state))
}

async fn bootstrap_runtime(state: &AppState, selected: Option<PathBuf>) -> StartupView {
    if selected.is_none()
        && state
            .config
            .read()
            .map(|config| config.is_some())
            .unwrap_or(false)
    {
        return current_startup_view(state);
    }
    if let Ok(mut view) = state.startup.write() {
        if view.busy {
            return view.clone();
        }
        view.phase = "probing_runtime".to_string();
        view.busy = true;
        view.issue = None;
    }

    if let Some(path) = selected {
        if let Ok(mut preferred) = state.selected_rscript.write() {
            *preferred = Some(path.clone());
        }
        if let Err(error) = persist_selected_rscript(&state.data_dir, &path) {
            write_startup_log(&format!("Could not persist selected Rscript: {error:#}"));
        }
    }

    let data_dir = state.data_dir.clone();
    let ark = state.ark.clone();
    let preferred = state
        .selected_rscript
        .read()
        .ok()
        .and_then(|path| path.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        prepare_runtime_files_with_rscript(data_dir, ark, preferred.as_deref())
    })
    .await;

    let view = match result {
        Ok(Ok(config)) => {
            let runtime = StartupRuntimeView {
                rscript: config.rscript.to_string_lossy().replace('\\', "/"),
                r_version: config.r_version.clone(),
                agent_runtime: config.agent_runtime.clone(),
            };
            if let Ok(mut stored) = state.config.write() {
                *stored = Some(config);
            }
            write_startup_log("Runtime bootstrap completed");
            StartupView {
                phase: "runtime_ready".to_string(),
                busy: false,
                runtime: Some(runtime),
                issue: None,
            }
        }
        Ok(Err(error)) => {
            let detail = format!("{error:#}");
            write_startup_log(&format!("Runtime bootstrap failed: {detail}"));
            StartupView {
                phase: "needs_attention".to_string(),
                busy: false,
                runtime: None,
                issue: Some(classify_startup_error(&detail)),
            }
        }
        Err(error) => {
            let detail = format!("runtime bootstrap task failed: {error}");
            write_startup_log(&detail);
            StartupView {
                phase: "needs_attention".to_string(),
                busy: false,
                runtime: None,
                issue: Some(startup_issue(
                    "R_PROBE_SPAWN_FAILED",
                    "probing_base_r",
                    StartupSeverity::Recoverable,
                    "Rho could not check R",
                    "Retry the check or choose Rscript.exe manually.",
                    detail,
                    startup_recovery_actions(),
                )),
            }
        }
    };
    if let Ok(mut stored) = state.startup.write() {
        *stored = view.clone();
    }
    view
}

#[tauri::command]
async fn startup_bootstrap(state: State<'_, AppState>) -> Result<StartupView, String> {
    Ok(bootstrap_runtime(&state, None).await)
}

#[tauri::command]
async fn startup_choose_rscript(state: State<'_, AppState>) -> Result<StartupView, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Choose Rscript.exe")
        .add_filter("Rscript", &["exe"])
        .pick_file()
    else {
        return Ok(current_startup_view(&state));
    };
    Ok(bootstrap_runtime(&state, Some(path)).await)
}

#[tauri::command]
async fn startup_diagnostics(state: State<'_, AppState>) -> Result<String, String> {
    let path = startup_log_path();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let log_tail = content
        .chars()
        .rev()
        .take(65_536)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let view = serde_json::to_string_pretty(&current_startup_view(&state)).unwrap_or_default();
    Ok(format!(
        "Rho startup status\n{view}\n\nStartup log\n{log_tail}"
    ))
}

#[tauri::command]
async fn startup_open_log_directory() -> Result<Value, String> {
    let path = startup_log_path();
    let mut command = Command::new("explorer.exe");
    command.arg("/select,").arg(&path);
    command
        .spawn()
        .map_err(|error| format!("Could not open the startup log directory: {error}"))?;
    Ok(json!({"path": path}))
}

#[tauri::command]
async fn agent_runtime_retry(state: State<'_, AppState>) -> Result<AgentRuntimeStatus, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let rscript = config.rscript.clone();
    let r_profile_user = config.r_profile_user.clone();
    let r_environ_user = config.r_environ_user.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        probe_agent_runtime(&rscript, &r_profile_user, &r_environ_user)
    })
    .await
    .map_err(display_error)?;
    if let Ok(mut stored) = state.config.write()
        && let Some(config) = stored.as_mut()
    {
        config.agent_runtime = status.clone();
    }
    if let Ok(mut startup) = state.startup.write()
        && let Some(runtime) = startup.runtime.as_mut()
    {
        runtime.agent_runtime = status.clone();
    }
    write_startup_log(if status.available {
        "Agent runtime retry completed"
    } else {
        "Agent runtime retry remains unavailable"
    });
    Ok(status)
}

#[tauri::command]
async fn workspace_start(state: State<'_, AppState>) -> Result<WorkspaceStatus, String> {
    match start_workspace(&state).await {
        Ok(status) => Ok(status),
        Err(error) => {
            write_startup_log(&format!("Workspace R startup failed: {error:#}"));
            Err(display_error(error))
        }
    }
}

#[tauri::command]
async fn workspace_status(state: State<'_, AppState>) -> Result<Value, String> {
    let session = state.session.read().await.clone();
    let context = state.context.lock().await.clone();
    let workspace = if let Some(context) = context {
        let context = context.lock().await;
        Some(serde_json::to_value(context.broker.identity()).unwrap_or(Value::Null))
    } else {
        None
    };
    Ok(json!({
        "status": if session.is_some() { "idle" } else { "disconnected" },
        "kernel_pid": session.as_ref().and_then(|value| value.child_pid()),
        "workspace": workspace,
        "python_required": false
    }))
}

#[tauri::command]
async fn project_state(state: State<'_, AppState>) -> Result<ProjectState, String> {
    let root = state.project_root.read().await.clone();
    list_project_files(&root).map_err(display_error)
}

#[tauri::command]
async fn project_mark_files_changed(state: State<'_, AppState>) -> Result<Value, String> {
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    context
        .store
        .save_identity(&identity)
        .map_err(display_error)?;
    serde_json::to_value(identity).map_err(display_error)
}

#[tauri::command]
async fn project_open(
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

#[tauri::command]
async fn project_pick_directory(
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

#[tauri::command]
async fn project_restore_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectRestoreResponse, String> {
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
    switch_project(root, Some(session_snapshot), app, &state)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn project_save_session(
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
async fn project_read_file(path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let file = project_path(&root, &path).map_err(display_error)?;
    ensure_editable_file_size(&file).map_err(display_error)?;
    let content = std::fs::read_to_string(&file).map_err(display_error)?;
    Ok(json!({"path": path, "content": content}))
}

#[tauri::command]
async fn project_write_file(
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
    context
        .store
        .save_identity(&identity)
        .map_err(display_error)?;
    drop(context);
    project_state(state).await
}

#[tauri::command]
async fn project_create_file(
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
    context
        .store
        .save_identity(&identity)
        .map_err(display_error)?;
    drop(context);
    project_state(state).await
}

#[tauri::command]
async fn project_delete_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectState, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    safe_delete_project_file(&root, &path).map_err(display_error)?;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    context
        .store
        .save_identity(&identity)
        .map_err(display_error)?;
    drop(context);
    project_state(state).await
}

fn project_delete_target(root: &Path, path: &str) -> Result<PathBuf> {
    let file = project_path(root, path)?;
    ensure_editable_file(&file)?;
    ensure!(file.exists(), "Project file does not exist: {path}");
    ensure!(file.is_file(), "Project path is not a file: {path}");
    Ok(file)
}

fn safe_delete_project_file(root: &Path, path: &str) -> Result<()> {
    let file = project_delete_target(root, path)?;
    std::fs::remove_file(&file)?;
    Ok(())
}

#[tauri::command]
async fn execute_r(request: ExecuteRequest, state: State<'_, AppState>) -> Result<Value, String> {
    if request.code.trim().is_empty() {
        return Err("R code is empty".to_string());
    }
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {
            "code": request.code,
            "source_path": request.source_path,
            "execution_mode": request.execution_mode,
            "document_version": request.document_version
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.execute",
        &payload,
        ExecutionOrigin::User,
        session.as_ref(),
        broker,
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn snapshot_workspace(state: State<'_, AppState>) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {},
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.snapshot",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn inspect_object(
    request: InspectObjectRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {
            "name": request.name
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.inspect_object",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn render_document(
    request: RenderRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let source_path = request.path.clone();
    let file = project_path(&root, &source_path).map_err(display_error)?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "rmd" | "qmd") {
        return Err("Render only supports project .Rmd and .qmd files".to_string());
    }
    if !file.is_file() {
        return Err(format!("Render source does not exist: {source_path}"));
    }
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {
            "path": file.to_string_lossy(),
            "format": request.format,
            "source_path": source_path,
            "execution_mode": "render",
            "document_version": request.document_version
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.render_document",
        &payload,
        ExecutionOrigin::User,
        session.as_ref(),
        broker,
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn list_runs(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<RunSummary>, String> {
    read_store(&state)
        .map_err(display_error)?
        .list_runs(limit)
        .map_err(display_error)
}

#[tauri::command]
async fn list_problems(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<ProblemSummary>, String> {
    read_store(&state)
        .map_err(display_error)?
        .list_problems(limit)
        .map_err(display_error)
}

#[tauri::command]
async fn get_run_detail(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RunDetail>, String> {
    read_store(&state)
        .map_err(display_error)?
        .get_run_detail(&run_id)
        .map_err(display_error)
}

#[tauri::command]
async fn list_plot_artifacts(
    limit: Option<usize>,
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<PlotArtifactSummary>, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    read_store(&state)
        .map_err(display_error)?
        .list_plot_artifacts(
            limit,
            Some(root.to_string_lossy().as_ref()),
            Some(&workspace_id),
            session_only.unwrap_or(true),
        )
        .map_err(display_error)
}

#[tauri::command]
async fn clear_plot_artifacts(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    let mut store = read_store(&state).map_err(display_error)?;
    let deleted = store
        .clear_plot_artifacts(
            Some(root.to_string_lossy().as_ref()),
            Some(&workspace_id),
            session_only.unwrap_or(true),
        )
        .map_err(display_error)?;
    Ok(json!({"deleted": deleted}))
}

#[tauri::command]
async fn retry_run(run_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let detail = context
        .store
        .get_run_detail(&run_id)
        .map_err(display_error)?
        .context(format!("Run not found: {run_id}"))
        .map_err(display_error)?;
    let mut arguments: Value =
        serde_json::from_str(&detail.arguments_json).map_err(display_error)?;
    let object = arguments
        .as_object_mut()
        .context("Stored run arguments are invalid")
        .map_err(display_error)?;
    object.insert(
        "parent_run_id".to_string(),
        Value::String(detail.run_id.clone()),
    );
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn run_agent(
    prompt: String,
    mode: String,
    model_id: Option<String>,
    auto_approve: Option<bool>,
    editor_context: Option<Value>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if prompt.trim().is_empty() {
        return Err("Agent prompt is empty".to_string());
    }
    if !matches!(mode.as_str(), "ask" | "plan" | "act") {
        return Err(format!("unsupported Agent mode `{mode}`"));
    }
    let config = runtime_config(&state).map_err(display_error)?;
    if !config.agent_runtime.available {
        return Err(config
            .agent_runtime
            .error
            .clone()
            .unwrap_or_else(|| "aisdk is unavailable in Agent R".to_string()));
    }
    let mut tasks = state.agent_tasks.lock().await;
    if !tasks.is_empty() {
        return Err("An Agent turn is already running".to_string());
    }
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let turn_id = format!("agent_turn_{}", Uuid::new_v4());
    let resolved_model = agent_llm::resolve_model_for_turn(&config.data_dir, model_id.as_deref())
        .map_err(display_error)?;
    let user_environ = agent_llm::resolve_user_environ(&config.rscript)
        .map_err(display_error)?
        .path;
    if mode == "act" && resolved_model.runtime_profile.tool_calling != "yes" {
        return Err("The selected model does not support Act mode.".to_string());
    }
    let auto_approve = auto_approve.unwrap_or(false) && mode == "act";
    {
        let mut context_guard = context.lock().await;
        let identity = context_guard.broker.identity().clone();
        context_guard
            .store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.clone(),
                mode: mode.clone(),
                prompt: prompt.clone(),
                model: resolved_model.effective_model_ref.clone(),
                workspace_id: identity.workspace_id.clone(),
                state_revision_before: identity.state_revision as i64,
                project_revision_before: identity.project_revision as i64,
            })
            .map_err(display_error)?;
        context_guard
            .store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: turn_id.clone(),
                event_type: "agent.user_prompt".to_string(),
                title: "You".to_string(),
                body: Some(prompt.clone()),
                status: "completed".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: serde_json::to_string(&json!({
                    "prompt": prompt,
                    "mode": mode,
                    "auto_approve": auto_approve,
                    "editor_context": editor_context.clone(),
                    "model_profile_id": resolved_model.runtime_profile.profile_id,
                    "model_display_name": resolved_model.model_display_name,
                    "provider_display_name": resolved_model.provider_display_name,
                    "effective_model": resolved_model.effective_model_ref
                }))
                .map_err(display_error)?,
            })
            .map_err(display_error)?;
    }

    let approvals = state.approvals.clone();
    let rscript = config.rscript.clone();
    let agent_package = config.agent_package.clone();
    let task_turn_id = turn_id.clone();
    let task_agent_tasks = state.agent_tasks.clone();
    let runtime_profile = resolved_model.runtime_profile.clone();
    let (registered_tx, registered_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _ = registered_rx.await;
        let _ = run_agent_turn(
            session.as_ref(),
            context,
            rscript,
            agent_package,
            resolved_model.effective_model_ref,
            Some(runtime_profile),
            Some(user_environ),
            prompt,
            mode,
            task_turn_id.clone(),
            approvals,
            auto_approve,
            editor_context,
        )
        .await;
        task_agent_tasks.lock().await.remove(&task_turn_id);
        let _ = app.emit(
            "rho://agent-turn-updated",
            json!({ "turn_id": task_turn_id.clone() }),
        );
    });
    tasks.insert(turn_id.clone(), task);
    drop(tasks);
    let _ = registered_tx.send(());
    Ok(json!({
        "status": "started",
        "turn_id": turn_id,
        "auto_approve": auto_approve
    }))
}

#[tauri::command]
async fn agent_llm_settings(state: State<'_, AppState>) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_save_provider(
    provider: AgentProviderProfile,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::save_provider(&config.data_dir, provider).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_delete_provider(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::delete_provider(&config.data_dir, &provider_id).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_save_model(
    model: AgentModelProfile,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::save_model(&config.data_dir, model).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_delete_model(
    request: DeleteModelRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::delete_model(&config.data_dir, &request).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_select_model(
    request: AgentLlmSelectRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::select_model(&config.data_dir, &request.model_id).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_refresh_credentials(
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::refresh_credentials_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_open_user_environ(state: State<'_, AppState>) -> Result<Value, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let info = agent_llm::open_user_environ(&config.rscript).map_err(display_error)?;
    Ok(json!({ "path": info.path, "source": info.source }))
}

#[tauri::command]
async fn agent_llm_test_model(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let data_dir = config.data_dir.clone();
    let rscript = config.rscript.clone();
    let agent_package = config.agent_package.clone();
    let test_control = state.agent_llm_test_control.clone();
    tauri::async_runtime::spawn_blocking(move || {
        agent_llm::test_model(
            &data_dir,
            &rscript,
            &agent_package,
            &model_id,
            Some(&test_control),
        )
    })
    .await
    .map_err(display_error)?
    .map_err(display_error)
}

#[tauri::command]
async fn agent_llm_cancel_test(state: State<'_, AppState>) -> Result<Value, String> {
    let cancelled = agent_llm::cancel_test(&state.agent_llm_test_control).map_err(display_error)?;
    Ok(json!({ "status": if cancelled { "cancelled" } else { "idle" } }))
}

#[tauri::command]
async fn agent_llm_catalog(state: State<'_, AppState>) -> Result<Value, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let entries = agent_llm::catalog(&config.rscript).map_err(display_error)?;
    serde_json::to_value(entries).map_err(display_error)
}

#[derive(Deserialize)]
struct ApprovalDecisionRequest {
    request_id: String,
    decision: String,
    reason: Option<String>,
}

#[tauri::command]
async fn list_agent_turns(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentTurnSummary>, String> {
    read_store(&state)
        .map_err(display_error)?
        .list_agent_turns(limit)
        .map_err(display_error)
}

#[tauri::command]
async fn list_approval_requests(
    limit: Option<usize>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ApprovalRequestSummary>, String> {
    read_store(&state)
        .map_err(display_error)?
        .list_approval_requests(limit, status.as_deref())
        .map_err(display_error)
}

#[tauri::command]
async fn get_agent_turn_detail(
    turn_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentTurnDetail>, String> {
    read_store(&state)
        .map_err(display_error)?
        .get_agent_turn_detail(&turn_id)
        .map_err(display_error)
}

#[tauri::command]
async fn respond_approval(
    request: ApprovalDecisionRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if !matches!(request.decision.as_str(), "approve" | "reject" | "cancel") {
        return Err(format!(
            "unsupported approval decision `{}`",
            request.decision
        ));
    }
    let pending = read_store(&state)
        .map_err(display_error)?
        .get_approval_request(&request.request_id)
        .map_err(display_error)?
        .filter(|item| item.status == "waiting")
        .context(format!(
            "Approval request not found or no longer waiting: {}",
            request.request_id
        ))
        .map_err(display_error)?;
    let delivered = state
        .approvals
        .respond(
            &request.request_id,
            ApprovalResponseInput {
                decision: request.decision.clone(),
                reason: request.reason.clone(),
            },
        )
        .await;
    if !delivered {
        read_store(&state)
            .map_err(display_error)?
            .resolve_approval_request(
                &request.request_id,
                &rho_store::ApprovalDecisionRecord {
                    decision: "cancel".to_string(),
                    status: "interrupted".to_string(),
                    reason: Some("Approval channel is no longer active.".to_string()),
                    continuation_outcome: Some("agent_unavailable".to_string()),
                },
            )
            .map_err(display_error)?;
    }
    Ok(json!({
        "status": if delivered { "delivered" } else { "not_delivered" },
        "request_id": request.request_id,
        "turn_id": pending.turn_id
    }))
}

#[tauri::command]
async fn interrupt_r(state: State<'_, AppState>) -> Result<Value, String> {
    request_run_interrupt(None, &state)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn cancel_run(run_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    request_run_interrupt(Some(run_id), &state)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn restart_workspace(state: State<'_, AppState>) -> Result<WorkspaceStatus, String> {
    state
        .approvals
        .cancel_all("Workspace R is restarting.")
        .await;
    let tasks = {
        let mut tasks = state.agent_tasks.lock().await;
        tasks.drain().map(|(_, task)| task).collect::<Vec<_>>()
    };
    for task in tasks {
        task.abort();
        let _ = task.await;
    }

    let active_run_id = {
        let mut store = read_store(&state).map_err(display_error)?;
        let run_id = store.latest_active_run_id().map_err(display_error)?;
        if let Some(run_id) = run_id.as_ref() {
            let _ = store.request_cancel(run_id).map_err(display_error)?;
        }
        run_id
    };

    let old_context = state.context.lock().await.take();
    let old_session = state.session.write().await.take();
    if active_run_id.is_some() {
        if let Some(session) = old_session.as_ref() {
            let _ = session.interrupt().await;
        }
    }
    if let Some(context) = old_context.clone() {
        match tokio::time::timeout(std::time::Duration::from_secs(15), context.lock()).await {
            Ok(guard) => drop(guard),
            Err(_) => {
                *state.context.lock().await = old_context;
                *state.session.write().await = old_session;
                return Err(
                    "Timed out waiting for the previous Workspace R run to stop".to_string()
                );
            }
        }
    }
    drop(old_session);
    drop(old_context);
    let status = start_workspace(&state).await.map_err(display_error)?;
    let root = state.project_root.read().await.clone();
    sync_workspace_project_root(&state, &root)
        .await
        .map_err(display_error)?;
    Ok(status)
}

async fn shutdown_application(state: &AppState) {
    write_startup_log("Rho desktop shutdown started");
    state.approvals.cancel_all("Rho is closing.").await;

    if let Err(error) = agent_llm::cancel_test(&state.agent_llm_test_control) {
        write_startup_log(&format!("Agent model test shutdown failed: {error:#}"));
    }

    if let Some(watcher) = state.project_watcher.lock().await.take() {
        watcher.stop();
    }

    let tasks = {
        let mut tasks = state.agent_tasks.lock().await;
        tasks.drain().map(|(_, task)| task).collect::<Vec<_>>()
    };
    for task in tasks {
        task.abort();
        let _ = task.await;
    }

    let context = state.context.lock().await.take();
    let session = state.session.write().await.take();
    let kernel_pid = session.as_ref().and_then(|session| session.child_pid());

    if let Some(session) = session.as_ref() {
        let _ = session.interrupt().await;
    }

    if let Some(context) = context.as_ref() {
        if tokio::time::timeout(Duration::from_secs(5), context.lock())
            .await
            .is_err()
        {
            write_startup_log("Timed out waiting for Workspace R execution during shutdown");
        }
    }
    drop(context);

    if let Some(session) = session {
        match Arc::try_unwrap(session) {
            Ok(mut session) => {
                if let Err(error) = session.shutdown().await {
                    write_startup_log(&format!("Graceful Ark shutdown failed: {error:#}"));
                }
            }
            Err(session) => {
                write_startup_log(&format!(
                    "Ark session still has {} active references; terminating its process tree",
                    Arc::strong_count(&session)
                ));
                drop(session);
                if let Some(pid) = kernel_pid
                    && let Err(error) = terminate_process_tree(pid)
                {
                    write_startup_log(&format!("Ark process-tree termination failed: {error:#}"));
                }
            }
        }
    }
    write_startup_log("Rho desktop shutdown completed");
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) -> Result<()> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("starting taskkill for Ark")?;
    ensure!(status.success(), "taskkill failed with status {status}");
    Ok(())
}

#[cfg(not(windows))]
fn terminate_process_tree(_pid: u32) -> Result<()> {
    Ok(())
}

async fn active_session(state: &AppState) -> Result<Arc<ArkSession>> {
    state
        .session
        .read()
        .await
        .clone()
        .context("Workspace R is not running")
}

async fn active_context(state: &AppState) -> Result<Arc<Mutex<CoordinatorRuntime>>> {
    state
        .context
        .lock()
        .await
        .clone()
        .context("Workspace context is not ready")
}

fn read_store(state: &AppState) -> Result<Store> {
    let config = runtime_config(state)?;
    Store::open(&config.store_path).context("opening Rho event store")
}

async fn start_workspace(state: &AppState) -> Result<WorkspaceStatus> {
    let config = runtime_config(state)?;
    if let Some(session) = state.session.read().await.clone() {
        let context = state.context.lock().await.clone();
        let identity = if let Some(context) = context {
            let context = context.lock().await;
            Some(context.broker.identity().clone())
        } else {
            None
        };
        return status_from(&config, &session, identity.as_ref());
    }

    let session = Arc::new(
        ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec))
            .await
            .context("starting Ark-backed Workspace R")?,
    );
    let mut store = Store::open(&config.store_path).context("opening Rho event store")?;
    store
        .recover_incomplete_runs()
        .context("recovering incomplete runs after desktop restart")?;
    store
        .recover_incomplete_agent_turns()
        .context("recovering incomplete agent turns after desktop restart")?;
    store
        .recover_incomplete_approvals()
        .context("recovering incomplete approvals after desktop restart")?;
    let mut broker = BrokerState::new(format!("desktop_{}", Uuid::new_v4()));
    store.save_identity(broker.identity())?;
    bootstrap_bridge(
        session.as_ref(),
        &mut broker,
        &mut store,
        &config.bridge_package,
    )
    .await?;
    let status = status_from(&config, &session, Some(broker.identity()))?;
    *state.context.lock().await = Some(Arc::new(Mutex::new(CoordinatorRuntime { broker, store })));
    *state.session.write().await = Some(session);
    Ok(status)
}

async fn request_run_interrupt(run_id: Option<String>, state: &AppState) -> Result<Value> {
    let session = active_session(state).await?;
    let mut store = read_store(state)?;
    let target = match run_id {
        Some(value) => value,
        None => store
            .latest_active_run_id()
            .context("looking up active run")?
            .context("No active run is available to interrupt")?,
    };
    ensure!(
        store
            .request_cancel(&target)
            .context("marking run as cancel-requested")?,
        "Run is not active: {target}"
    );
    drop(store);
    session
        .interrupt()
        .await
        .context("interrupting Workspace R")?;
    Ok(json!({
        "status": "interrupt_requested",
        "run_id": target
    }))
}

fn parse_execution_origin(origin: &str) -> ExecutionOrigin {
    match origin {
        "agent" => ExecutionOrigin::Agent,
        "system" => ExecutionOrigin::System,
        _ => ExecutionOrigin::User,
    }
}

async fn switch_project(
    root: PathBuf,
    session_snapshot: Option<ProjectSessionSnapshot>,
    app: AppHandle,
    state: &AppState,
) -> Result<ProjectRestoreResponse> {
    sync_workspace_project_root(state, &root).await?;
    {
        let context = active_context(state).await?;
        context
            .lock()
            .await
            .store
            .set_project_root(Some(root.to_string_lossy().as_ref()))?;
    }
    state.project_store.save_last_opened_project(&root)?;
    let session_snapshot =
        session_snapshot.unwrap_or_else(|| state.project_store.load_session_or_default(&root));
    *state.project_root.write().await = root.clone();
    let mut watcher = state.project_watcher.lock().await;
    replace_project_watcher(&mut watcher, app, root.clone())?;
    let project = list_project_files(&root)?;
    Ok(ProjectRestoreResponse::ready(project, session_snapshot))
}

async fn sync_workspace_project_root(state: &AppState, root: &Path) -> Result<()> {
    let session = active_session(state).await?;
    let context = active_context(state).await?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {"code": format!("setwd({})", serde_json::to_string(&root.to_string_lossy()).unwrap())},
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.set_project_root",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        store,
    )
    .await?;
    Ok(())
}

fn status_from(
    config: &RuntimeConfig,
    session: &ArkSession,
    identity: Option<&rho_protocol::WorkspaceIdentity>,
) -> Result<WorkspaceStatus> {
    Ok(WorkspaceStatus {
        status: "idle",
        r_version: config.r_version.clone(),
        r_home: config.r_home.clone(),
        kernel_pid: session.child_pid(),
        workspace: identity.map(|value| serde_json::to_value(value).unwrap_or(Value::Null)),
        agent_runtime: config.agent_runtime.clone(),
        python_required: false,
    })
}

fn prepare_runtime_files(data_dir: PathBuf, ark: PathBuf) -> Result<RuntimeConfig> {
    prepare_runtime_files_with_rscript(data_dir, ark, None)
}

fn prepare_runtime_files_with_rscript(
    data_dir: PathBuf,
    ark: PathBuf,
    selected_rscript: Option<&Path>,
) -> Result<RuntimeConfig> {
    ensure!(ark.is_file(), "bundled Ark executable was not found");
    std::fs::create_dir_all(&data_dir)?;
    let source_dir = data_dir.join("sources");
    let bridge_package = source_dir.join("rho.bridge");
    let agent_package = source_dir.join("rho.agent");
    write_source(&bridge_package.join("R/state.R"), BRIDGE_STATE)?;
    write_source(&bridge_package.join("R/execute.R"), BRIDGE_EXECUTE)?;
    write_source(&bridge_package.join("R/workspace.R"), BRIDGE_WORKSPACE)?;
    write_source(&agent_package.join("R/aaa-state.R"), AGENT_STATE)?;
    write_source(&agent_package.join("R/transport.R"), AGENT_TRANSPORT)?;
    write_source(&agent_package.join("R/aisdk_adapter.R"), AGENT_ADAPTER)?;

    let rscript = locate_rscript(selected_rscript)?;
    let probe = probe_r_runtime(&rscript)?;
    let RRuntimeProbe {
        r_home,
        r_version,
        r_libs,
        r_profile_user,
        r_environ_user,
    } = probe;
    let agent_runtime = probe_agent_runtime(&rscript, &r_profile_user, &r_environ_user);
    let runtime_dir = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_dir)?;
    let empty_site_environ = runtime_dir.join("empty-site.Renviron");
    write_source(&empty_site_environ, "")?;
    let log_path = runtime_dir.join("ark.log");
    let kernelspec = runtime_dir.join("kernel.json");
    let r_bin = Path::new(&r_home).join("bin").join("x64");
    let path = format!(
        "{};{}",
        r_bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let spec = json!({
        "argv": [ark, "--connection_file", "{connection_file}", "--session-mode", "console", "--log", log_path, "--", "--interactive", "--no-site-file"],
        "display_name": "Ark R 0.1.252 (Rho Desktop)",
        "language": "R",
        "interrupt_mode": "message",
        "kernel_protocol_version": "5.4",
        "env": {
            "R_HOME": r_home,
            "R_LIBS": r_libs,
            "R_ENVIRON": empty_site_environ,
            "R_ENVIRON_USER": r_environ_user,
            "R_PROFILE_USER": r_profile_user,
            "PATH": path
        }
    });
    atomic_write(&kernelspec, &serde_json::to_vec_pretty(&spec)?)?;
    atomic_write(
        &kernelspec.with_extension("runtime.json"),
        &serde_json::to_vec_pretty(&json!({"r_version": r_version, "r_home": r_home}))?,
    )?;
    Ok(RuntimeConfig {
        data_dir: data_dir.clone(),
        kernelspec,
        rscript,
        r_version,
        r_home,
        r_profile_user,
        r_environ_user,
        bridge_package,
        agent_package,
        agent_runtime,
        store_path: data_dir.join("rho-desktop.sqlite"),
    })
}

fn locate_ark(app: &tauri::App) -> Result<PathBuf> {
    let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/runtime/ark.exe");
    let installed = app
        .path()
        .resource_dir()
        .context("resolving Rho resource directory")?
        .join("resources/runtime/ark.exe");
    Ok(if installed.is_file() {
        installed
    } else if development.is_file() {
        development
    } else {
        installed
    })
}

fn locate_rscript(selected: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = selected {
        ensure!(
            path.is_file(),
            "selected Rscript path does not point to a file"
        );
        return Ok(path.to_path_buf());
    }
    if let Some(path) = std::env::var_os("RHO_RSCRIPT") {
        let path = PathBuf::from(path);
        ensure!(path.is_file(), "RHO_RSCRIPT does not point to a file");
        return Ok(path);
    }
    let mut command = Command::new("where.exe");
    hide_console_window(&mut command);
    let output = command
        .arg("Rscript.exe")
        .output()
        .context("searching for Rscript.exe")?;
    if output.status.success() {
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
            .context("where.exe returned no Rscript path");
    }
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    if let Ok(entries) = std::fs::read_dir(program_files.join("R")) {
        let mut candidates = entries
            .flatten()
            .map(|entry| entry.path().join("bin/Rscript.exe"))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();
        candidates.sort();
        if let Some(path) = candidates.pop() {
            return Ok(path);
        }
    }
    bail!("Rscript.exe was not found. Install R 4.4 or later, then restart Rho.")
}

fn probe_r_runtime(rscript: &Path) -> Result<RRuntimeProbe> {
    let expression = r#"
cat("__RHO_HOME__", normalizePath(R.home(), winslash = "/"), "\n", sep = "")
cat("__RHO_VERSION__", R.version.string, "\n", sep = "")
cat("__RHO_VERSION_NUMBER__", as.character(getRversion()), "\n", sep = "")
cat("__RHO_PROFILE_USER__", normalizePath(path.expand("~/.Rprofile"), winslash = "/", mustWork = FALSE), "\n", sep = "")
cat("__RHO_ENVIRON_USER__", normalizePath(path.expand("~/.Renviron"), winslash = "/", mustWork = FALSE), "\n", sep = "")
cat(
  "__RHO_LIBS__",
  paste(
    normalizePath(.libPaths(), winslash = "/", mustWork = FALSE),
    collapse = .Platform$path.sep
  ),
  "\n",
  sep = ""
)
"#;
    let output = run_r_probe(
        rscript,
        expression,
        Duration::from_secs(15),
        RProbeStartup::Controlled,
        None,
    )?;
    ensure!(
        output.success,
        "R runtime probe failed (exit_code={:?}, timed_out={}, elapsed_ms={}): stdout={} stderr={}",
        output.exit_code,
        output.timed_out,
        output.elapsed_ms,
        bounded_diagnostic(&output.stdout),
        bounded_diagnostic(&output.stderr)
    );
    let mut probe = parse_r_runtime_probe(&output.stdout)?;
    let library_expression = r#"
cat(
  "__RHO_EFFECTIVE_LIBS__",
  paste(
    normalizePath(.libPaths(), winslash = "/", mustWork = FALSE),
    collapse = .Platform$path.sep
  ),
  "\n",
  sep = ""
)
"#;
    match run_r_probe(
        rscript,
        library_expression,
        Duration::from_secs(15),
        RProbeStartup::UserProfile,
        Some((&probe.r_profile_user, &probe.r_environ_user)),
    ) {
        Ok(output) if output.success => {
            if let Some(libraries) = probe_value(&output.stdout, "__RHO_EFFECTIVE_LIBS__") {
                if !libraries.is_empty() {
                    probe.r_libs = libraries;
                }
            } else {
                write_startup_log(
                    "User R profile library probe returned no marker; using controlled library paths",
                );
            }
        }
        Ok(output) => write_startup_log(&format!(
            "User R profile library probe failed; using controlled library paths (exit_code={:?}, timed_out={}, stderr={})",
            output.exit_code,
            output.timed_out,
            bounded_diagnostic(&output.stderr)
        )),
        Err(error) => write_startup_log(&format!(
            "User R profile library probe could not start; using controlled library paths: {error:#}"
        )),
    }
    Ok(probe)
}

fn parse_r_runtime_probe(stdout: &str) -> Result<RRuntimeProbe> {
    let r_home =
        probe_value(stdout, "__RHO_HOME__").context("R home was absent from runtime probe")?;
    let r_version = probe_value(stdout, "__RHO_VERSION__")
        .context("R version was absent from runtime probe")?;
    let r_version_number = probe_value(stdout, "__RHO_VERSION_NUMBER__")
        .context("R version number was absent from runtime probe")?;
    ensure_supported_r_version(&r_version_number)?;
    let r_libs = probe_value(stdout, "__RHO_LIBS__")
        .context("R library paths were absent from runtime probe")?;
    let r_profile_user = probe_value(stdout, "__RHO_PROFILE_USER__")
        .map(PathBuf::from)
        .context("R user profile path was absent from runtime probe")?;
    let r_environ_user = probe_value(stdout, "__RHO_ENVIRON_USER__")
        .map(PathBuf::from)
        .context("R user environment path was absent from runtime probe")?;
    Ok(RRuntimeProbe {
        r_home,
        r_version,
        r_libs,
        r_profile_user,
        r_environ_user,
    })
}

fn probe_value(stdout: &str, prefix: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix(prefix).map(str::trim))
        .map(str::to_string)
}

fn probe_agent_runtime(
    rscript: &Path,
    r_profile_user: &Path,
    r_environ_user: &Path,
) -> AgentRuntimeStatus {
    let expression = r#"
loadNamespace("aisdk")
cat("__RHO_AISDK__", as.character(utils::packageVersion("aisdk")), "\n", sep = "")
"#;
    let output = match run_r_probe(
        rscript,
        expression,
        Duration::from_secs(30),
        RProbeStartup::UserProfile,
        Some((r_profile_user, r_environ_user)),
    ) {
        Ok(output) => output,
        Err(error) => {
            return AgentRuntimeStatus {
                available: false,
                aisdk_version: None,
                error: Some(format!("Agent R check could not start: {error:#}")),
            };
        }
    };
    if !output.success {
        return AgentRuntimeStatus {
            available: false,
            aisdk_version: None,
            error: Some(format!(
                "Agent R cannot load aisdk (exit_code={:?}, timed_out={}): {}",
                output.exit_code,
                output.timed_out,
                bounded_diagnostic(&output.stderr)
            )),
        };
    }
    let version = output.stdout.lines().find_map(|line| {
        line.strip_prefix("__RHO_AISDK__")
            .map(str::trim)
            .map(str::to_string)
    });
    match version {
        Some(version) => AgentRuntimeStatus {
            available: true,
            aisdk_version: Some(version),
            error: None,
        },
        None => AgentRuntimeStatus {
            available: false,
            aisdk_version: None,
            error: Some("Agent R check returned no aisdk version".to_string()),
        },
    }
}

fn run_r_probe(
    rscript: &Path,
    expression: &str,
    timeout: Duration,
    startup: RProbeStartup,
    user_files: Option<(&Path, &Path)>,
) -> Result<ProbeProcessOutput> {
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    if matches!(startup, RProbeStartup::Controlled) {
        command.args(["--no-environ", "--no-init-file", "--no-site-file"]);
    } else if let Some((r_profile_user, r_environ_user)) = user_files {
        let empty_site_environ =
            tempfile::NamedTempFile::new().context("creating empty site R environment file")?;
        command
            .arg("--no-site-file")
            .env("R_ENVIRON", empty_site_environ.path())
            .env("R_ENVIRON_USER", r_environ_user)
            .env("R_PROFILE_USER", r_profile_user);
        return run_prepared_r_probe(command, expression, timeout, Some(empty_site_environ));
    }
    run_prepared_r_probe(command, expression, timeout, None)
}

fn run_prepared_r_probe(
    mut command: Command,
    expression: &str,
    timeout: Duration,
    _empty_site_environ: Option<tempfile::NamedTempFile>,
) -> Result<ProbeProcessOutput> {
    let stdout_file = tempfile::NamedTempFile::new().context("creating R probe stdout file")?;
    let stderr_file = tempfile::NamedTempFile::new().context("creating R probe stderr file")?;
    command
        .args(["-e", expression])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file.reopen()?))
        .stderr(Stdio::from(stderr_file.reopen()?));
    let program = command.get_program().to_string_lossy().into_owned();
    let started = Instant::now();
    let mut child = command
        .spawn()
        .with_context(|| format!("running {program}"))?;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().context("waiting for R runtime probe")? {
            break (status, false);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            break (
                child.wait().context("stopping timed-out R runtime probe")?,
                true,
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = std::fs::read(stdout_file.path())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    let stderr = std::fs::read(stderr_file.path())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    Ok(ProbeProcessOutput {
        success: status.success() && !timed_out,
        exit_code: status.code(),
        stdout,
        stderr,
        elapsed_ms: started.elapsed().as_millis(),
        timed_out,
    })
}

fn bounded_diagnostic(value: &str) -> String {
    let mut tokens = Vec::new();
    let mut redact_next = false;
    for token in value.split_whitespace() {
        if redact_next {
            tokens.push("<redacted>".to_string());
            redact_next = false;
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if lower == "bearer" {
            tokens.push("Bearer".to_string());
            redact_next = true;
            continue;
        }
        let secret_assignment = ["api_key=", "apikey=", "token=", "authorization="]
            .iter()
            .find_map(|marker| lower.find(marker).map(|index| (marker, index)));
        if let Some((marker, index)) = secret_assignment {
            tokens.push(format!(
                "{}{}<redacted>",
                &token[..index],
                &token[index..index + marker.len()]
            ));
        } else {
            tokens.push(token.to_string());
        }
    }
    let sanitized = tokens.join(" ");
    sanitized.chars().take(4096).collect()
}

#[tauri::command]
async fn clear_agent_history(state: State<'_, AppState>) -> Result<Value, String> {
    if !state.agent_tasks.lock().await.is_empty() {
        return Err("Stop the active Agent turn before clearing its history.".to_string());
    }
    let mut store = read_store(&state).map_err(display_error)?;
    let deleted = store.clear_agent_history().map_err(display_error)?;
    Ok(json!({"deleted": deleted}))
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn ensure_supported_r_version(version: &str) -> Result<()> {
    let mut components = version.split('.');
    let major = components
        .next()
        .context("R version has no major component")?
        .parse::<u64>()
        .with_context(|| format!("invalid R version `{version}`"))?;
    let minor = components
        .next()
        .context("R version has no minor component")?
        .parse::<u64>()
        .with_context(|| format!("invalid R version `{version}`"))?;
    ensure!(
        (major, minor) >= (4, 4),
        "Rho requires R 4.4 or later; found R {version}"
    );
    Ok(())
}

#[tauri::command]
async fn cancel_agent_turn(
    turn_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let task = state
        .agent_tasks
        .lock()
        .await
        .remove(&turn_id)
        .context(format!("Agent turn is not active: {turn_id}"))
        .map_err(display_error)?;
    state
        .approvals
        .cancel_all("Agent turn cancelled by the user.")
        .await;
    task.abort();
    let _ = task.await;

    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let detail = context
        .store
        .get_agent_turn_detail(&turn_id)
        .map_err(display_error)?;
    let status = detail
        .as_ref()
        .map(|detail| detail.turn.status.as_str())
        .unwrap_or("missing");
    if matches!(status, "running" | "waiting") {
        let identity = context.broker.identity().clone();
        context
            .store
            .interrupt_agent_approvals(&turn_id, "Agent turn cancelled by the user.")
            .map_err(display_error)?;
        context
            .store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: turn_id.clone(),
                event_type: "agent.cancelled".to_string(),
                title: "Agent turn cancelled".to_string(),
                body: Some("The user stopped this Agent turn.".to_string()),
                status: "interrupted".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: "{}".to_string(),
            })
            .map_err(display_error)?;
        context
            .store
            .finish_agent_turn(&AgentTurnFinish {
                turn_id: turn_id.clone(),
                status: "interrupted".to_string(),
                workspace_id_after: Some(identity.workspace_id),
                state_revision_after: Some(identity.state_revision as i64),
                project_revision_after: Some(identity.project_revision as i64),
                final_message: None,
                error_message: Some("Agent turn cancelled by the user.".to_string()),
            })
            .map_err(display_error)?;
    }
    drop(context);
    let _ = app.emit(
        "rho://agent-turn-updated",
        json!({ "turn_id": turn_id.clone() }),
    );
    Ok(json!({ "status": "cancelled", "turn_id": turn_id }))
}

fn write_source(path: &Path, content: &str) -> Result<()> {
    atomic_write(path, content.as_bytes())
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn startup_log_path() -> PathBuf {
    STARTUP_LOG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("rho-desktop-startup.log"))
}

fn initialize_startup_log(data_dir: &Path) {
    let directory = data_dir.join("logs");
    let path = if std::fs::create_dir_all(&directory).is_ok() {
        directory.join("startup.jsonl")
    } else {
        std::env::temp_dir().join("rho-desktop-startup.log")
    };
    let _ = STARTUP_LOG_PATH.set(path);
}

fn write_startup_log(message: &str) {
    let path = startup_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let timestamp = chrono::Utc::now().to_rfc3339();
        let event = json!({
            "timestamp": timestamp,
            "message": bounded_diagnostic(message),
        });
        let _ = writeln!(file, "{event}");
    }
}

fn selected_rscript_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("selected-rscript.txt")
}

fn load_selected_rscript(data_dir: &Path) -> Option<PathBuf> {
    std::fs::read_to_string(selected_rscript_path(data_dir))
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
}

fn persist_selected_rscript(data_dir: &Path, path: &Path) -> Result<()> {
    if let Some(parent) = selected_rscript_path(data_dir).parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(
        &selected_rscript_path(data_dir),
        path.to_string_lossy().as_bytes(),
    )
}

fn startup_recovery_actions() -> Vec<String> {
    vec![
        "retry".to_string(),
        "choose_rscript".to_string(),
        "copy_diagnostics".to_string(),
        "open_log".to_string(),
        "exit".to_string(),
    ]
}

fn startup_issue(
    code: &str,
    phase: &str,
    severity: StartupSeverity,
    title: &str,
    message: &str,
    technical_detail: String,
    actions: Vec<String>,
) -> StartupIssue {
    StartupIssue {
        code: code.to_string(),
        phase: phase.to_string(),
        severity,
        title: title.to_string(),
        message: message.to_string(),
        technical_detail,
        actions,
        diagnostics_path: startup_log_path().to_string_lossy().replace('\\', "/"),
    }
}

fn classify_startup_error(detail: &str) -> StartupIssue {
    let (code, phase, title, message, actions) = if detail.contains("bundled Ark executable") {
        (
            "ARK_RESOURCE_MISSING",
            "checking_installation",
            "Rho installation needs repair",
            "The bundled Workspace R engine is missing. Reinstall Rho, then retry.",
            vec![
                "retry".to_string(),
                "open_log".to_string(),
                "exit".to_string(),
            ],
        )
    } else if detail.contains("selected Rscript path") || detail.contains("RHO_RSCRIPT") {
        (
            "R_PATH_INVALID",
            "locating_r",
            "The selected R installation is unavailable",
            "Choose Rscript.exe from an R 4.4 or later installation.",
            startup_recovery_actions(),
        )
    } else if detail.contains("Rscript.exe was not found") {
        (
            "R_NOT_FOUND",
            "locating_r",
            "R was not found",
            "Rho requires R 4.4 or later. Install R or choose Rscript.exe manually.",
            startup_recovery_actions(),
        )
    } else if detail.contains("requires R 4.4") {
        (
            "R_VERSION_UNSUPPORTED",
            "probing_base_r",
            "This R version is not supported",
            "Choose an R 4.4 or later installation, then retry.",
            startup_recovery_actions(),
        )
    } else if detail.contains("timed_out=true") {
        (
            "R_PROBE_TIMED_OUT",
            "probing_base_r",
            "R took too long to start",
            "Retry the runtime check or choose another Rscript.exe.",
            startup_recovery_actions(),
        )
    } else if detail.contains("R runtime probe failed") {
        (
            "R_PROBE_EXITED",
            "probing_base_r",
            "R could not complete its runtime check",
            "Your R installation was not changed. Retry or choose another Rscript.exe.",
            startup_recovery_actions(),
        )
    } else if detail.contains("absent from runtime probe") {
        (
            "R_PROBE_OUTPUT_INVALID",
            "probing_base_r",
            "R returned an incomplete runtime result",
            "Retry the runtime check and copy diagnostics if it continues.",
            startup_recovery_actions(),
        )
    } else {
        (
            "R_PROBE_SPAWN_FAILED",
            "probing_base_r",
            "Rho could not prepare the R runtime",
            "Retry the check or choose Rscript.exe manually.",
            startup_recovery_actions(),
        )
    };
    startup_issue(
        code,
        phase,
        StartupSeverity::Recoverable,
        title,
        message,
        detail.to_string(),
        actions,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_diagnostic, classify_startup_error, ensure_supported_r_version,
        parse_r_runtime_probe, safe_delete_project_file,
    };
    use tempfile::TempDir;

    #[test]
    fn enforces_the_documented_minimum_r_version() {
        assert!(ensure_supported_r_version("4.3.3").is_err());
        assert!(ensure_supported_r_version("4.4.0").is_ok());
        assert!(ensure_supported_r_version("5.0.0").is_ok());
        assert!(ensure_supported_r_version("invalid").is_err());
    }

    #[test]
    fn parses_base_r_probe_without_requiring_aisdk_output() {
        let probe = parse_r_runtime_probe(
            "__RHO_HOME__C:/Program Files/R/R-4.4.2\n\
             __RHO_VERSION__R version 4.4.2\n\
             __RHO_VERSION_NUMBER__4.4.2\n\
             __RHO_PROFILE_USER__C:/Users/test/Documents/.Rprofile\n\
             __RHO_ENVIRON_USER__C:/Users/test/Documents/.Renviron\n\
             __RHO_LIBS__C:/Users/test/R/win-library/4.4;C:/Program Files/R/R-4.4.2/library\n",
        )
        .unwrap();
        assert_eq!(probe.r_home, "C:/Program Files/R/R-4.4.2");
        assert_eq!(probe.r_version, "R version 4.4.2");
        assert!(probe.r_libs.contains("win-library"));
        assert!(probe.r_profile_user.ends_with(".Rprofile"));
        assert!(probe.r_environ_user.ends_with(".Renviron"));
    }

    #[test]
    fn classifies_empty_stderr_probe_exit_as_recoverable() {
        let issue = classify_startup_error(
            "R runtime probe failed (exit_code=Some(1), timed_out=false): stdout= stderr=",
        );
        assert_eq!(issue.code, "R_PROBE_EXITED");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn bounds_multiline_subprocess_diagnostics() {
        let value = format!("secret-free\r\n{}", "x".repeat(5000));
        let bounded = bounded_diagnostic(&value);
        assert!(!bounded.contains(['\r', '\n']));
        assert_eq!(bounded.chars().count(), 4096);
    }

    #[test]
    fn redacts_common_secret_shapes_from_diagnostics() {
        let bounded = bounded_diagnostic(
            "DEEPSEEK_API_KEY=secret Authorization=token Bearer another-secret safe",
        );
        assert!(!bounded.contains("secret"));
        assert!(!bounded.contains("another-secret"));
        assert!(bounded.contains("<redacted>"));
        assert!(bounded.ends_with("safe"));
    }

    #[test]
    fn safe_delete_project_file_deletes_supported_project_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("analysis.R");
        std::fs::write(&file, "x <- 1").unwrap();
        safe_delete_project_file(&root, "analysis.R").unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn safe_delete_project_file_rejects_missing_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = safe_delete_project_file(&root, "missing.R").unwrap_err();
        assert!(error.to_string().contains("does not exist"));
    }

    #[test]
    fn safe_delete_project_file_rejects_unsupported_extension() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("figure.png");
        std::fs::write(&file, [0_u8, 1, 2]).unwrap();
        let error = safe_delete_project_file(&root, "figure.png").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Unsupported or binary project file")
        );
    }

    #[test]
    fn safe_delete_project_file_rejects_parent_escape() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = safe_delete_project_file(&root, "../outside.R").unwrap_err();
        assert!(error.to_string().contains("parent, root or drive prefix"));
    }

    #[test]
    fn safe_delete_project_file_rejects_symlink_escape() {
        let directory = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let outside = outside_dir.path().join("outside.R");
        std::fs::write(&outside, "outside <- TRUE").unwrap();
        let link = root.join("link-outside.R");
        if let Err(error) = std::os::windows::fs::symlink_file(&outside, &link) {
            if error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("Could not create symlink test fixture: {error}");
        }
        let error = safe_delete_project_file(&root, "link-outside.R").unwrap_err();
        assert!(error.to_string().contains("escapes project root"));
        assert!(outside.exists());
    }

    #[test]
    fn safe_delete_project_file_rejects_directories() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("folder.R")).unwrap();
        let error = safe_delete_project_file(&root, "folder.R").unwrap_err();
        assert!(error.to_string().contains("is not a file"));
        assert!(root.join("folder.R").is_dir());
    }
}

async fn smoke_test(include_agent: bool) -> Result<Value> {
    let data_dir = std::env::temp_dir().join("rho-desktop-smoke");
    let ark = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/runtime/ark.exe");
    let config = prepare_runtime_files(data_dir, ark)?;
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
    let mut store = Store::open(&config.store_path)?;
    let mut broker = BrokerState::new("desktop_smoke");
    store.save_identity(broker.identity())?;
    bootstrap_bridge(&session, &mut broker, &mut store, &config.bridge_package).await?;
    let execute_payload = json!({
        "arguments": {
            "code": "rho_desktop_smoke <- data.frame(x = 1:5, y = (1:5)^2); plot(rho_desktop_smoke$x, rho_desktop_smoke$y, pch = 19)"
        },
        "expected_workspace": broker.identity()
    });
    let execution = dispatch_workspace_request(
        "workspace.execute",
        &execute_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let snapshot_payload = json!({
        "arguments": {},
        "expected_workspace": broker.identity()
    });
    let snapshot = dispatch_workspace_request(
        "workspace.snapshot",
        &snapshot_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let plot_count = execution["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|event| event["type"] == "display_data")
        .count();
    let object_found = snapshot["execution"]["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|object| object["name"] == "rho_desktop_smoke");
    ensure!(plot_count > 0, "desktop smoke test did not receive a plot");
    ensure!(
        object_found,
        "desktop smoke object was absent from Environment"
    );
    let context = Arc::new(Mutex::new(CoordinatorRuntime { broker, store }));
    let agent = if include_agent {
        let turn_id = format!("smoke_turn_{}", Uuid::new_v4());
        let prompt =
            "请检查 rho_desktop_smoke 对象，告诉我它有多少行和多少列。不要修改工作区。".to_string();
        let resolved_model = agent_llm::resolve_model_for_turn(&config.data_dir, None)?;
        let user_environ = agent_llm::resolve_user_environ(&config.rscript)?.path;
        {
            let mut context_guard = context.lock().await;
            let identity = context_guard.broker.identity().clone();
            context_guard.store.create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.clone(),
                mode: "ask".to_string(),
                prompt: prompt.clone(),
                model: resolved_model.effective_model_ref.clone(),
                workspace_id: identity.workspace_id,
                state_revision_before: identity.state_revision as i64,
                project_revision_before: identity.project_revision as i64,
            })?;
            context_guard
                .store
                .append_agent_turn_event(&AgentTurnEventDraft {
                    turn_id: turn_id.clone(),
                    event_type: "agent.user_prompt".to_string(),
                    title: "You".to_string(),
                    body: Some(prompt.clone()),
                    status: "completed".to_string(),
                    tool: None,
                    request_id: None,
                    code: None,
                    details_json: serde_json::to_string(
                        &json!({"prompt": prompt.clone(), "mode": "ask"}),
                    )?,
                })?;
        }
        let result = run_agent_turn(
            &session,
            context.clone(),
            config.rscript.clone(),
            config.agent_package.clone(),
            resolved_model.effective_model_ref.clone(),
            Some(resolved_model.runtime_profile),
            Some(user_environ),
            prompt,
            "ask".to_string(),
            turn_id,
            Arc::new(PendingApprovalRegistry::default()),
            false,
            None,
        )
        .await?;
        let completed = result["events"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|event| event["type"] == "chat.message_completed");
        ensure!(completed, "desktop Agent turn omitted its final message");
        Some(json!({"completed": true, "model": result["model"]}))
    } else {
        None
    };
    let report = {
        let context = context.lock().await;
        json!({
            "type": "rho_desktop_smoke",
            "workspace": context.broker.identity(),
            "plot_count": plot_count,
            "environment_object_found": object_found,
            "agent": agent,
            "event_count": context.store.event_count()?,
            "python_required": false
        })
    };
    session.shutdown().await?;
    Ok(report)
}

fn main() {
    std::panic::set_hook(Box::new(|information| {
        write_startup_log(&format!("Rho desktop panic: {information}"));
    }));
    let arguments = std::env::args().collect::<Vec<_>>();
    let smoke_agent = arguments.iter().any(|argument| argument == "--smoke-agent");
    if smoke_agent || arguments.iter().any(|argument| argument == "--smoke-test") {
        let runtime = tokio::runtime::Runtime::new().expect("creating smoke-test runtime");
        match runtime.block_on(smoke_test(smoke_agent)) {
            Ok(report) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
                return;
            }
            Err(error) => {
                eprintln!("Rho desktop smoke test failed: {error:#}");
                std::process::exit(1);
            }
        }
    }
    let run_result = tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .context("resolving Rho application data directory")?;
            initialize_startup_log(&data_dir);
            write_startup_log("Rho desktop shell setup started");
            let ark = locate_ark(app)?;
            let project_store = ProjectSessionStore::new(data_dir.clone()).map_err(|error| {
                write_startup_log(&format!("Rho project session setup failed: {error:#}"));
                error
            })?;
            let selected_rscript = load_selected_rscript(&data_dir);
            app.manage(AppState {
                data_dir,
                ark,
                config: SyncRwLock::new(None),
                selected_rscript: SyncRwLock::new(selected_rscript),
                startup: SyncRwLock::new(StartupView {
                    phase: "shell_ready".to_string(),
                    busy: false,
                    runtime: None,
                    issue: None,
                }),
                project_store,
                project_root: RwLock::new(default_project_root()),
                project_watcher: Mutex::new(None),
                session: RwLock::new(None),
                context: Mutex::new(None),
                approvals: Arc::new(PendingApprovalRegistry::default()),
                agent_tasks: Arc::new(Mutex::new(HashMap::new())),
                agent_llm_test_control: AgentModelTestControl::default(),
                shutdown_started: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_status,
            startup_bootstrap,
            startup_choose_rscript,
            startup_diagnostics,
            startup_open_log_directory,
            agent_runtime_retry,
            workspace_start,
            workspace_status,
            project_state,
            project_mark_files_changed,
            project_open,
            project_pick_directory,
            project_restore_session,
            project_save_session,
            project_read_file,
            project_write_file,
            project_create_file,
            project_delete_file,
            execute_r,
            snapshot_workspace,
            inspect_object,
            render_document,
            list_runs,
            list_plot_artifacts,
            clear_plot_artifacts,
            list_problems,
            get_run_detail,
            retry_run,
            run_agent,
            agent_llm_settings,
            agent_llm_save_provider,
            agent_llm_delete_provider,
            agent_llm_save_model,
            agent_llm_delete_model,
            agent_llm_select_model,
            agent_llm_refresh_credentials,
            agent_llm_open_user_environ,
            agent_llm_test_model,
            agent_llm_cancel_test,
            agent_llm_catalog,
            list_agent_turns,
            clear_agent_history,
            list_approval_requests,
            get_agent_turn_detail,
            respond_approval,
            interrupt_r,
            cancel_run,
            cancel_agent_turn,
            restart_workspace
        ])
        .build(tauri::generate_context!());
    match run_result {
        Ok(app) => {
            app.run(|app_handle, event| {
                if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                    && code.is_none()
                {
                    api.prevent_exit();
                    let state = app_handle.state::<AppState>();
                    if state.shutdown_started.swap(true, Ordering::SeqCst) {
                        return;
                    }

                    let app_handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app_handle.state::<AppState>();
                        shutdown_application(&state).await;
                        app_handle.exit(0);
                    });
                }
            });
        }
        Err(error) => {
            let detail = format!("Rho desktop could not start: {error:#}");
            write_startup_log(&detail);
            let _ = rfd::MessageDialog::new()
                .set_title("Rho could not start")
                .set_description(format!(
                    "Rho could not open its interface.\n\n{error}\n\nDiagnostic log:\n{}",
                    startup_log_path().display()
                ))
                .set_level(rfd::MessageLevel::Error)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        }
    }
}
