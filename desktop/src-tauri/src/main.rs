#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod project;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

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
    bridge_package: PathBuf,
    agent_package: PathBuf,
    agent_runtime: AgentRuntimeStatus,
    store_path: PathBuf,
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
    agent_runtime: AgentRuntimeStatus,
}

struct AppState {
    config: RuntimeConfig,
    project_store: ProjectSessionStore,
    project_root: RwLock<PathBuf>,
    project_watcher: Mutex<Option<ProjectWatcherControl>>,
    session: RwLock<Option<Arc<ArkSession>>>,
    context: Mutex<Option<Arc<Mutex<CoordinatorRuntime>>>>,
    approvals: Arc<PendingApprovalRegistry>,
    agent_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

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

#[tauri::command]
async fn workspace_start(state: State<'_, AppState>) -> Result<WorkspaceStatus, String> {
    start_workspace(&state).await.map_err(display_error)
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
    model: Option<String>,
    auto_approve: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if prompt.trim().is_empty() {
        return Err("Agent prompt is empty".to_string());
    }
    if !matches!(mode.as_str(), "ask" | "plan" | "act") {
        return Err(format!("unsupported Agent mode `{mode}`"));
    }
    if !state.config.agent_runtime.available {
        return Err(state
            .config
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
    let model = model.unwrap_or_else(|| "deepseek:deepseek-v4-flash".to_string());
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
                model: model.clone(),
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
                    "auto_approve": auto_approve
                }))
                .map_err(display_error)?,
            })
            .map_err(display_error)?;
    }

    let approvals = state.approvals.clone();
    let rscript = state.config.rscript.clone();
    let agent_package = state.config.agent_package.clone();
    let task_turn_id = turn_id.clone();
    let task_agent_tasks = state.agent_tasks.clone();
    let (registered_tx, registered_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _ = registered_rx.await;
        let _ = run_agent_turn(
            session.as_ref(),
            context,
            rscript,
            agent_package,
            model,
            prompt,
            mode,
            task_turn_id.clone(),
            approvals,
            auto_approve,
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
    Store::open(&state.config.store_path).context("opening Rho event store")
}

async fn start_workspace(state: &AppState) -> Result<WorkspaceStatus> {
    if let Some(session) = state.session.read().await.clone() {
        let context = state.context.lock().await.clone();
        let identity = if let Some(context) = context {
            let context = context.lock().await;
            Some(context.broker.identity().clone())
        } else {
            None
        };
        return status_from(&state.config, &session, identity.as_ref());
    }

    let session = Arc::new(
        ArkSession::launch(&ArkLaunchConfig::new(&state.config.kernelspec))
            .await
            .context("starting Ark-backed Workspace R")?,
    );
    let mut store = Store::open(&state.config.store_path).context("opening Rho event store")?;
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
        &state.config.bridge_package,
    )
    .await?;
    let status = status_from(&state.config, &session, Some(broker.identity()))?;
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
    let metadata = std::fs::read_to_string(config.kernelspec.with_extension("runtime.json"))?;
    let metadata: Value = serde_json::from_str(&metadata)?;
    Ok(WorkspaceStatus {
        status: "idle",
        r_version: metadata["r_version"].as_str().unwrap_or("R").to_string(),
        r_home: metadata["r_home"].as_str().unwrap_or_default().to_string(),
        kernel_pid: session.child_pid(),
        workspace: identity.map(|value| serde_json::to_value(value).unwrap_or(Value::Null)),
        agent_runtime: config.agent_runtime.clone(),
        python_required: false,
    })
}

fn prepare_runtime(app: &tauri::App) -> Result<RuntimeConfig> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .context("resolving Rho application data directory")?;
    prepare_runtime_files(data_dir, locate_ark(app)?)
}

fn prepare_runtime_files(data_dir: PathBuf, ark: PathBuf) -> Result<RuntimeConfig> {
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

    let rscript = locate_rscript()?;
    let probe = probe_r_runtime(&rscript)?;
    let RRuntimeProbe {
        r_home,
        r_version,
        r_libs,
        agent_runtime,
    } = probe;
    let runtime_dir = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_dir)?;
    let empty_renviron = runtime_dir.join("empty.Renviron");
    write_source(&empty_renviron, "")?;
    let log_path = runtime_dir.join("ark.log");
    let kernelspec = runtime_dir.join("kernel.json");
    let r_bin = Path::new(&r_home).join("bin").join("x64");
    let path = format!(
        "{};{}",
        r_bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let spec = json!({
        "argv": [ark, "--connection_file", "{connection_file}", "--session-mode", "console", "--log", log_path, "--", "--interactive", "--no-environ", "--no-init-file", "--no-site-file"],
        "display_name": "Ark R 0.1.252 (Rho Desktop)",
        "language": "R",
        "interrupt_mode": "message",
        "kernel_protocol_version": "5.4",
        "env": {
            "R_HOME": r_home,
            "R_LIBS": r_libs,
            "R_ENVIRON_USER": empty_renviron,
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
    [installed, development]
        .into_iter()
        .find(|path| path.is_file())
        .context("bundled Ark executable was not found")
}

fn locate_rscript() -> Result<PathBuf> {
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
cat(
  "__RHO_LIBS__",
  paste(
    normalizePath(.libPaths(), winslash = "/", mustWork = FALSE),
    collapse = .Platform$path.sep
  ),
  "\n",
  sep = ""
)
tryCatch({
  loadNamespace("aisdk")
  cat("__RHO_AISDK__", as.character(utils::packageVersion("aisdk")), "\n", sep = "")
}, error = function(error) {
  message <- gsub("[\r\n]+", " ", conditionMessage(error))
  cat("__RHO_AISDK_ERROR__", message, "\n", sep = "")
})
"#;
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    let output = command
        .args(["-e", expression])
        .output()
        .with_context(|| format!("running {}", rscript.display()))?;
    ensure!(
        output.status.success(),
        "R runtime probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value = |prefix: &str| {
        stdout
            .lines()
            .find_map(|line| line.strip_prefix(prefix).map(str::trim))
            .map(str::to_string)
    };
    let r_home = value("__RHO_HOME__").context("R home was absent from runtime probe")?;
    let r_version = value("__RHO_VERSION__").context("R version was absent from runtime probe")?;
    let r_version_number = value("__RHO_VERSION_NUMBER__")
        .context("R version number was absent from runtime probe")?;
    ensure_supported_r_version(&r_version_number)?;
    let r_libs = value("__RHO_LIBS__").context("R library paths were absent from runtime probe")?;
    let agent_runtime = match value("__RHO_AISDK__") {
        Some(version) => AgentRuntimeStatus {
            available: true,
            aisdk_version: Some(version),
            error: None,
        },
        None => AgentRuntimeStatus {
            available: false,
            aisdk_version: None,
            error: Some(format!(
                "Agent R cannot load aisdk: {}",
                value("__RHO_AISDK_ERROR__")
                    .unwrap_or_else(|| "unknown namespace loading error".to_string())
            )),
        },
    };
    Ok(RRuntimeProbe {
        r_home,
        r_version,
        r_libs,
        agent_runtime,
    })
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
    std::env::temp_dir().join("rho-desktop-startup.log")
}

fn write_startup_log(message: &str) {
    let _ = std::fs::write(startup_log_path(), message);
}

#[cfg(test)]
mod tests {
    use super::ensure_supported_r_version;

    #[test]
    fn enforces_the_documented_minimum_r_version() {
        assert!(ensure_supported_r_version("4.3.3").is_err());
        assert!(ensure_supported_r_version("4.4.0").is_ok());
        assert!(ensure_supported_r_version("5.0.0").is_ok());
        assert!(ensure_supported_r_version("invalid").is_err());
    }
}

async fn smoke_test(include_agent: bool) -> Result<Value> {
    let data_dir = std::env::temp_dir().join("rho-desktop-smoke");
    let ark = Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/runtime/ark.exe");
    let config = prepare_runtime_files(data_dir, ark)?;
    let session = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
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
        {
            let mut context_guard = context.lock().await;
            let identity = context_guard.broker.identity().clone();
            context_guard.store.create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.clone(),
                mode: "ask".to_string(),
                prompt: prompt.clone(),
                model: "deepseek:deepseek-v4-flash".to_string(),
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
            "deepseek:deepseek-v4-flash".to_string(),
            prompt,
            "ask".to_string(),
            turn_id,
            Arc::new(PendingApprovalRegistry::default()),
            false,
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
    let context = context.lock().await;
    Ok(json!({
        "type": "rho_desktop_smoke",
        "workspace": context.broker.identity(),
        "plot_count": plot_count,
        "environment_object_found": object_found,
        "agent": agent,
        "event_count": context.store.event_count()?,
        "python_required": false
    }))
}

fn main() {
    let _ = std::fs::remove_file(startup_log_path());
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
    tauri::Builder::default()
        .setup(|app| {
            let config = prepare_runtime(app).map_err(|error| {
                write_startup_log(&format!("Rho desktop setup failed: {error:#}"));
                error
            })?;
            let project_store =
                ProjectSessionStore::new(config.data_dir.clone()).map_err(|error| {
                    write_startup_log(&format!("Rho project session setup failed: {error:#}"));
                    error
                })?;
            app.manage(AppState {
                config,
                project_store,
                project_root: RwLock::new(default_project_root()),
                project_watcher: Mutex::new(None),
                session: RwLock::new(None),
                context: Mutex::new(None),
                approvals: Arc::new(PendingApprovalRegistry::default()),
                agent_tasks: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        .run(tauri::generate_context!())
        .expect("error while running Rho desktop");
}
