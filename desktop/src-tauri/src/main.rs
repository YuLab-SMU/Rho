#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_llm;
mod git;
mod git_review;
mod platform;
mod project;
mod update;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, RwLock as SyncRwLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use agent_llm::{
    AgentCapabilityRoute, AgentLlmSettingsView, AgentModelCapabilityPatch,
    AgentModelDiscoveryResponse, AgentModelProfile, AgentModelTestControl, AgentProviderProfile,
    DeleteModelRequest,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use project::{
    ProjectRestoreResponse, ProjectSessionSnapshot, ProjectSessionStore, ProjectState,
    ProjectSwitchBlocker, ProjectSwitchBlockerKind, ProjectWatcherControl, atomic_write,
    atomic_write_new, default_project_root, display_path, ensure_editable_content_size,
    ensure_editable_file, ensure_editable_file_size, list_project_files,
    normalize_existing_project_root, project_path, read_viewer_file, relative_project_path,
    start_project_watcher, validate_project_root,
};
use rho_core::{BrokerState, ExecutionOrigin};
use rho_kernel::{ArkLaunchConfig, ArkSession, KernelEvent};
use rho_server::coordinator::{
    ApprovalResponseInput, CoordinatorRuntime, EnvironmentOperationArguments,
    PendingApprovalRegistry, ProjectSkillDiscoverySummary, bootstrap_bridge,
    decide_environment_operation, discover_project_skill_summaries, dispatch_workspace_request,
    dispatch_workspace_request_with_execution_id, request_environment_operation, run_agent_turn,
};
use rho_store::{
    AgentConversationDraft, AgentConversationSummary, AgentTurnDetail, AgentTurnDraft,
    AgentTurnEventDraft, AgentTurnFinish, AgentTurnSummary, ApprovalRequestSummary,
    ArtifactRecordDraft, ArtifactRecordSummary, AuditLimits, AuditResponse, AuditScope,
    CompareRunsResponse, EnvironmentOperationRequestSummary, EvidenceClaim, EvidenceClaimDraft,
    EvidenceClaimReview, EvidenceEntry, EvidenceEntryDraft, PlotArtifactSummary,
    PlotPayloadPruneResult, ProblemSummary, ProjectRetentionSummary, RetentionPolicy, RunDetail,
    RunSummary, Store, normalize_project_root,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, RwLock, oneshot};
use uuid::Uuid;

use update::{ReleaseChannel, SOURCE_URL, UpdateCheckResult, WEBSITE_URL};

const BRIDGE_STATE: &str = include_str!("../../../r/rho.bridge/R/state.R");
const BRIDGE_EXECUTE: &str = include_str!("../../../r/rho.bridge/R/execute.R");
const BRIDGE_WORKSPACE: &str = include_str!("../../../r/rho.bridge/R/workspace.R");
const BRIDGE_COMPLETION: &str = include_str!("../../../r/rho.bridge/R/completion.R");
const BRIDGE_LINTR: &str = include_str!("../../../r/rho.bridge/R/lintr.R");
const BRIDGE_TARGETS: &str = include_str!("../../../r/rho.bridge/R/targets.R");
const BRIDGE_FORMATTING: &str = include_str!("../../../r/rho.bridge/R/formatting.R");
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
    process_path: OsString,
    r_profile_user: Option<PathBuf>,
    r_environ_user: Option<PathBuf>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AgentRuntimeStatus {
    available: bool,
    aisdk_version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct AppRuntimeInfo {
    rscript: Option<String>,
    r_version: Option<String>,
    agent_available: Option<bool>,
    aisdk_version: Option<String>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    channel: ReleaseChannel,
    commit: String,
    platform: String,
    website_url: &'static str,
    source_url: &'static str,
    runtime: AppRuntimeInfo,
}

#[derive(Debug)]
struct RRuntimeProbe {
    r_home: String,
    r_bin: String,
    r_arch: String,
    path_sep: String,
    r_version: String,
    r_libs: String,
    r_profile_user: Option<PathBuf>,
    r_environ_user: Option<PathBuf>,
}

const RUNTIME_CACHE_VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RuntimeFileSignature {
    path: String,
    size: u64,
    modified_unix_ms: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RuntimeCacheFile {
    version: u32,
    rscript: RuntimeFileSignature,
    ark: RuntimeFileSignature,
    r_profile_user: Option<RuntimeFileSignature>,
    r_environ_user: Option<RuntimeFileSignature>,
    r_home: String,
    r_bin: String,
    r_arch: String,
    path_sep: String,
    r_version: String,
    r_libs: String,
    agent_runtime: AgentRuntimeStatus,
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

#[derive(Clone, Copy)]
struct RUserStartupFiles<'a> {
    profile: Option<&'a Path>,
    environ: Option<&'a Path>,
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
    environment_approvals: Arc<PendingApprovalRegistry>,
    agent_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    agent_llm_test_control: AgentModelTestControl,
    switch_test_control: SwitchTestControl,
    shutdown_started: AtomicBool,
    render_jobs: Arc<Mutex<HashMap<String, RenderJobState>>>,
    render_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

/// Tracked state of an async render job.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RenderJobState {
    pub job_id: String,
    pub project_root: String,
    pub path: String,
    pub document_version: Option<i64>,
    pub status: String,
    pub artifact_id: Option<String>,
    pub output_path: Option<String>,
    pub tool: Option<String>,
    pub media_type: Option<String>,
    pub provenance_complete: Option<bool>,
    pub message: Option<String>,
    pub terminal_reason: Option<String>,
    pub submitted_at: String,
    pub completed_at: Option<String>,
}

fn attach_render_artifact(job: &mut RenderJobState, artifact: &ArtifactRecordSummary) {
    job.artifact_id = Some(artifact.artifact_id.clone());
    job.output_path = Some(artifact.output_path.clone());
    job.media_type = Some(artifact.media_type.clone());
    job.provenance_complete = Some(artifact.provenance_complete);
}

fn render_job_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

fn finish_render_job(
    job: &mut RenderJobState,
    status: &str,
    message: Option<String>,
    terminal_reason: Option<&str>,
) {
    if render_job_is_terminal(&job.status) {
        return;
    }
    job.status = status.to_string();
    job.message = message;
    job.terminal_reason = terminal_reason.map(str::to_string);
    job.completed_at = Some(chrono::Utc::now().to_rfc3339());
}

fn reconcile_render_job(
    job: &mut RenderJobState,
    run_status: Option<&str>,
    run_message: Option<String>,
    terminal_reason: Option<&str>,
) {
    if render_job_is_terminal(&job.status) {
        return;
    }
    match run_status {
        Some("completed") => finish_render_job(job, "completed", None, Some("completed")),
        Some("failed") => finish_render_job(job, "failed", run_message, terminal_reason),
        Some("interrupted") => finish_render_job(
            job,
            "interrupted",
            Some("Render interrupted while Workspace R restarted.".to_string()),
            terminal_reason,
        ),
        _ => finish_render_job(
            job,
            "interrupted",
            Some("Render stopped before Workspace R restarted.".to_string()),
            Some("workspace_restart_before_start"),
        ),
    }
}

static STARTUP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum SwitchTestStep {
    SyncWorkspace,
    SetActiveProjectRoot,
    SaveLastOpenedProject,
    RestoreWorkspace,
    RestoreActiveProjectRoot,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
enum SwitchTestDirective {
    SucceedWithoutRunning,
    Fail(String),
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Default)]
struct SwitchTestControl {
    directives: Arc<StdMutex<HashMap<SwitchTestStep, SwitchTestDirective>>>,
}

impl SwitchTestControl {
    #[cfg(test)]
    fn succeed_without_running(&self, step: SwitchTestStep) {
        self.directives
            .lock()
            .unwrap()
            .insert(step, SwitchTestDirective::SucceedWithoutRunning);
    }

    #[cfg(test)]
    fn fail(&self, step: SwitchTestStep, message: impl Into<String>) {
        self.directives
            .lock()
            .unwrap()
            .insert(step, SwitchTestDirective::Fail(message.into()));
    }

    fn take(&self, step: SwitchTestStep) -> Option<SwitchTestDirective> {
        self.directives.lock().unwrap().remove(&step)
    }
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

#[derive(Clone, Copy, Deserialize, Serialize)]
struct ExecuteSourceRange {
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Deserialize)]
struct ExecuteRequest {
    code: String,
    source_path: Option<String>,
    execution_mode: Option<String>,
    document_version: Option<i64>,
    source_range: Option<ExecuteSourceRange>,
}

#[derive(Deserialize)]
struct InspectObjectRequest {
    name: String,
}

#[derive(Deserialize)]
struct InspectDataObjectRequest {
    object_name: String,
}

#[derive(Deserialize)]
struct ViewerWorkspaceRequest {
    kernel_instance_id: Option<String>,
    state_revision: Option<u64>,
    project_revision: Option<u64>,
}

#[derive(Deserialize)]
struct ReadDataViewRequest {
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

#[derive(Deserialize)]
struct ExportPlotArtifactRequest {
    plot_id: String,
    path: String,
}

#[derive(Deserialize)]
struct ExportDataViewArtifactRequest {
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

#[derive(Deserialize)]
struct RenderRequest {
    path: String,
    format: Option<String>,
    document_version: Option<i64>,
}

#[derive(Deserialize)]
struct EditorFormatRequest {
    path: String,
    source: String,
    document_version: i64,
}

fn editor_format_result(response: Value) -> Result<Value> {
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

#[derive(Deserialize)]
struct EvidenceClaimCreateRequest {
    kind: String,
    summary: String,
    anchor_kind: String,
    source_path: Option<String>,
    start_line: Option<i64>,
    start_column: Option<i64>,
    end_line: Option<i64>,
    end_column: Option<i64>,
    artifact_id: Option<String>,
    evidence_ids: Vec<i64>,
}

#[derive(Serialize)]
struct ArtifactRecordView {
    #[serde(flatten)]
    artifact: ArtifactRecordSummary,
    file_available: bool,
    file_status: String,
    output_absolute_path: String,
    run: Option<RunDetail>,
}

#[derive(Serialize)]
struct ProjectRetentionView {
    #[serde(flatten)]
    summary: ProjectRetentionSummary,
    policy: RetentionPolicy,
}

#[derive(Deserialize)]
struct EnvironmentOperationRequestInput {
    operation: String,
    repositories: Option<HashMap<String, String>>,
    bioconductor: Option<String>,
    package: Option<String>,
}

#[derive(Deserialize)]
struct EnvironmentOperationDecisionRequest {
    request_id: String,
    decision: String,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentLlmSelectRequest {
    model_id: String,
    expected_revision: u64,
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

#[tauri::command]
async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, String> {
    let version = env!("CARGO_PKG_VERSION").to_string();
    let channel = semver::Version::parse(&version)
        .map(|value| ReleaseChannel::for_version(&value))
        .map_err(display_error)?;
    let runtime = state.config.read().ok().and_then(|config| config.clone());
    Ok(AppInfo {
        version,
        channel,
        commit: env!("RHO_BUILD_COMMIT").to_string(),
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        website_url: WEBSITE_URL,
        source_url: SOURCE_URL,
        runtime: AppRuntimeInfo {
            rscript: runtime
                .as_ref()
                .map(|value| value.rscript.to_string_lossy().into_owned()),
            r_version: runtime.as_ref().map(|value| value.r_version.clone()),
            agent_available: runtime.as_ref().map(|value| value.agent_runtime.available),
            aisdk_version: runtime.and_then(|value| value.agent_runtime.aisdk_version),
        },
    })
}

#[tauri::command]
async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    tauri::async_runtime::spawn_blocking(|| update::check_for_updates(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(display_error)?
        .map_err(display_error)
}

#[tauri::command]
async fn open_rho_website(url: String) -> Result<(), String> {
    update::validate_product_url(&url).map_err(display_error)?;
    let mut command = platform::open_url_command(&url);
    hide_console_window(&mut command);
    command.spawn().map_err(display_error)?;
    Ok(())
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
            git::set_process_path(config.process_path.clone());
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
                    &format!(
                        "Retry the check or choose {} manually.",
                        platform::rscript_display_name()
                    ),
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
    let mut dialog = rfd::FileDialog::new().set_title(platform::rscript_picker_title());
    if let Some(extension) = platform::rscript_picker_extension() {
        dialog = dialog.add_filter("Rscript", &[extension]);
    }
    let Some(path) = dialog.pick_file() else {
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
    let mut command = platform::reveal_path_command(&path);
    hide_console_window(&mut command);
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
        probe_agent_runtime(
            &rscript,
            r_profile_user.as_deref(),
            r_environ_user.as_deref(),
        )
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
    let started = Instant::now();
    match start_workspace(&state).await {
        Ok(status) => {
            write_startup_log(&format!(
                "startup_phase=workspace_start elapsed_ms={}",
                started.elapsed().as_millis()
            ));
            Ok(status)
        }
        Err(error) => {
            write_startup_log(&format!(
                "startup_phase=workspace_start outcome=failed elapsed_ms={} detail={error:#}",
                started.elapsed().as_millis()
            ));
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
    let result = switch_project(root, Some(session_snapshot), app, &state)
        .await
        .map_err(display_error);
    write_startup_log(&format!(
        "startup_phase=project_restore elapsed_ms={} outcome={}",
        started.elapsed().as_millis(),
        if result.is_ok() { "ok" } else { "failed" }
    ));
    result
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
async fn viewer_read_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<project::ViewerFile, String> {
    let root = state.project_root.read().await.clone();
    read_viewer_file(&root, &path).map_err(display_error)
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

fn ensure_artifact_export_target(
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

fn has_png_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
}

fn decode_plot_png_base64(encoded: &str) -> Result<Vec<u8>> {
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

fn data_view_delimited_text(page: &Value, delimiter: char) -> Result<String> {
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

fn data_view_artifact_metadata(
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

#[tauri::command]
async fn execute_r(request: ExecuteRequest, state: State<'_, AppState>) -> Result<Value, String> {
    if request.code.trim().is_empty() {
        return Err("R code is empty".to_string());
    }
    validate_execute_source_range(&request, &state)
        .await
        .map_err(display_error)?;
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {
            "code": request.code,
            "source_path": request.source_path,
            "execution_mode": request.execution_mode,
            "document_version": request.document_version,
            "source_range": request.source_range
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

async fn validate_execute_source_range(request: &ExecuteRequest, state: &AppState) -> Result<()> {
    validate_execute_source_range_shape(request)?;
    if request.source_range.is_none() {
        return Ok(());
    }
    let source_path = request.source_path.as_deref().unwrap();
    let root = state.project_root.read().await.clone();
    project_path(&root, source_path)?;
    Ok(())
}

fn validate_execute_source_range_shape(request: &ExecuteRequest) -> Result<()> {
    const MAX_DIAGNOSTIC_LINE: u32 = 10_000_000;
    const MAX_DIAGNOSTIC_COLUMN: u32 = 1_000_000;
    let Some(range) = request.source_range else {
        return Ok(());
    };
    ensure!(
        range.start_line > 0
            && range.start_column > 0
            && range.end_line > 0
            && range.end_column > 0
            && range.start_line <= MAX_DIAGNOSTIC_LINE
            && range.end_line <= MAX_DIAGNOSTIC_LINE
            && range.start_column <= MAX_DIAGNOSTIC_COLUMN
            && range.end_column <= MAX_DIAGNOSTIC_COLUMN,
        "Execution source range is out of bounds."
    );
    let ordered = range.end_line > range.start_line
        || (range.end_line == range.start_line && range.end_column > range.start_column);
    ensure!(ordered, "Execution source range is empty or inverted.");
    let source_path = request
        .source_path
        .as_deref()
        .context("Execution source range requires a project file path.")?;
    ensure!(
        !source_path.starts_with('<'),
        "Execution source range requires a real project file."
    );
    let code_lines = request.code.split('\n').collect::<Vec<_>>();
    let expected_end_line = range
        .start_line
        .checked_add(u32::try_from(code_lines.len().saturating_sub(1))?)
        .context("Execution source range line count overflowed.")?;
    let last_line_width = u32::try_from(
        code_lines
            .last()
            .map_or(0, |line| line.encode_utf16().count()),
    )?;
    let expected_end_column = if code_lines.len() == 1 {
        range
            .start_column
            .checked_add(last_line_width)
            .context("Execution source range column overflowed.")?
    } else {
        last_line_width
            .checked_add(1)
            .context("Execution source range column overflowed.")?
    };
    ensure!(
        range.end_line == expected_end_line && range.end_column == expected_end_column,
        "Execution source range does not match the submitted code."
    );
    Ok(())
}

#[tauri::command]
async fn editor_goto_definition(name: String, state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn editor_find_project_references(
    name: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn editor_discover_chunks(path: String, state: State<'_, AppState>) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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

fn viewer_expected_workspace(
    workspace: &ViewerWorkspaceRequest,
) -> rho_protocol::ExpectedWorkspace {
    rho_protocol::ExpectedWorkspace {
        kernel_instance_id: workspace.kernel_instance_id.clone(),
        state_revision: workspace.state_revision,
        project_revision: workspace.project_revision,
    }
}

#[tauri::command]
async fn inspect_data_object(
    request: InspectDataObjectRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {
            "object_name": request.object_name
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.inspect_data_object",
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
async fn read_data_view(
    request: ReadDataViewRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
    dispatch_workspace_request(
        "workspace.read_data_view",
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
async fn render_document_job(
    path: String,
    document_version: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let file = project_path(&root, &path).map_err(display_error)?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "rmd" | "qmd") {
        return Err("Render only supports project .Rmd and .qmd files".to_string());
    }
    if !file.is_file() {
        return Err(format!("Render source does not exist: {path}"));
    }

    let job_id = format!("render_{}", Uuid::new_v4().simple());
    let job_id_return = job_id.clone();
    let job_project_root = project_root.clone();
    let render_jobs = state.render_jobs.clone();
    let render_tasks = state.render_tasks.clone();
    {
        let mut jobs = render_jobs.lock().await;
        jobs.insert(
            job_id.clone(),
            RenderJobState {
                job_id: job_id.clone(),
                project_root,
                path: path.clone(),
                document_version,
                status: "submitted".to_string(),
                artifact_id: None,
                output_path: None,
                tool: None,
                media_type: None,
                provenance_complete: None,
                message: None,
                terminal_reason: None,
                submitted_at: chrono::Utc::now().to_rfc3339(),
                completed_at: None,
            },
        );
    }
    let session_arc = state.session.read().await.clone();
    let context_arc = state.context.lock().await.clone();
    let file_path = file.to_string_lossy().to_string();
    let task_job_id = job_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;
        let session = match session_arc {
            Some(s) => s,
            None => {
                eprintln!("render_document_job [{job_id}]: no active session");
                let mut jobs = render_jobs.lock().await;
                if let Some(job) = jobs.get_mut(&job_id) {
                    finish_render_job(
                        job,
                        "failed",
                        Some("No active Workspace R session".to_string()),
                        Some("workspace_unavailable"),
                    );
                }
                drop(jobs);
                render_tasks.lock().await.remove(&job_id);
                return;
            }
        };
        let context = match context_arc {
            Some(c) => c,
            None => {
                eprintln!("render_document_job [{job_id}]: no active context");
                let mut jobs = render_jobs.lock().await;
                if let Some(job) = jobs.get_mut(&job_id) {
                    finish_render_job(
                        job,
                        "failed",
                        Some("No active coordinator context".to_string()),
                        Some("coordinator_unavailable"),
                    );
                }
                drop(jobs);
                render_tasks.lock().await.remove(&job_id);
                return;
            }
        };
        let mut context = context.lock().await;
        let cancelled_before_start = {
            let mut jobs = render_jobs.lock().await;
            match jobs.get_mut(&job_id) {
                None => true,
                Some(job) if job.status == "cancel_requested" => {
                    finish_render_job(
                        job,
                        "interrupted",
                        Some("Render cancelled before it started.".to_string()),
                        Some("user_cancel_before_start"),
                    );
                    true
                }
                Some(job) => {
                    job.status = "running".to_string();
                    false
                }
            }
        };
        if cancelled_before_start {
            render_tasks.lock().await.remove(&job_id);
            return;
        }
        let CoordinatorRuntime { broker, store } = &mut *context;
        let payload = serde_json::json!({
            "arguments": {
                "path": file_path,
                "source_path": path,
                "execution_mode": "render",
                "document_version": document_version,
            },
            "expected_workspace": broker.identity()
        });
        let outcome = dispatch_workspace_request_with_execution_id(
            "workspace.render_document",
            &payload,
            ExecutionOrigin::User,
            session.as_ref(),
            broker,
            store,
            Some(&job_id),
        )
        .await;
        let artifact = outcome
            .as_ref()
            .ok()
            .filter(|response| response["execution"]["ok"].as_bool().unwrap_or(false))
            .and_then(|response| response["artifact_id"].as_str())
            .and_then(|artifact_id| {
                store
                    .get_artifact_record(&job_project_root, artifact_id)
                    .ok()
                    .flatten()
            });
        let mut jobs = render_jobs.lock().await;
        if let Some(job) = jobs.get_mut(&job_id) {
            match outcome {
                Ok(response) if response["execution"]["ok"].as_bool().unwrap_or(false) => {
                    job.artifact_id = response["artifact_id"].as_str().map(str::to_string);
                    job.output_path = response["execution"]["output_path"]
                        .as_str()
                        .map(str::to_string);
                    job.tool = response["execution"]["tool"].as_str().map(str::to_string);
                    job.media_type = response["artifact_media_type"].as_str().map(str::to_string);
                    if let Some(artifact) = artifact.as_ref() {
                        attach_render_artifact(job, artifact);
                    }
                    finish_render_job(job, "completed", None, Some("completed"));
                }
                Ok(response) => {
                    let message = response["execution"]["error"]["message"]
                        .as_str()
                        .unwrap_or("Render failed")
                        .to_string();
                    finish_render_job(job, "failed", Some(message), Some("r_error"));
                }
                Err(_error) if job.status == "cancel_requested" => {
                    finish_render_job(
                        job,
                        "interrupted",
                        Some("Render cancelled.".to_string()),
                        Some("user_interrupt"),
                    );
                }
                Err(error) => {
                    eprintln!("render_document_job [{job_id}]: dispatch failed: {error:#}");
                    finish_render_job(
                        job,
                        "failed",
                        Some(format!("{error:#}")),
                        Some("execution_error"),
                    );
                }
            }
        }
        render_tasks.lock().await.remove(&job_id);
    });
    state.render_tasks.lock().await.insert(task_job_id, task);
    Ok(serde_json::json!({ "job_id": job_id_return, "status": "submitted" }))
}

#[tauri::command]
async fn render_job_status(
    job_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let mut jobs = state.render_jobs.lock().await;
    // Keep active jobs indefinitely; expire only terminal convenience records.
    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(5);
    jobs.retain(|_, job| {
        !render_job_is_terminal(&job.status)
            || job.completed_at.as_ref().map_or(true, |at| {
                chrono::DateTime::parse_from_rfc3339(at)
                    .map(|value| value.with_timezone(&chrono::Utc) >= cutoff)
                    .unwrap_or(true)
            })
    });
    if let Some(id) = job_id {
        let job_project_root = jobs
            .get(&id)
            .filter(|job| job.project_root == project_root)
            .map(|job| job.project_root.clone())
            .context("Render job not found")
            .map_err(display_error)?;
        drop(jobs);

        // The worker updates the in-memory projection after the durable Run
        // is finished. Reconcile from the store here as well so a completed
        // render cannot leave the UI polling forever if that update is late.
        let durable = read_store(&state).ok().and_then(|store| {
            let run = store.get_run_detail(&job_project_root, &id).ok().flatten();
            let artifact = store
                .get_artifact_record_for_run(&job_project_root, &id, "render_output")
                .ok()
                .flatten();
            Some((run, artifact))
        });
        if let Some((run, artifact)) = durable {
            let mut jobs = state.render_jobs.lock().await;
            if let Some(job) = jobs.get_mut(&id) {
                if let Some(artifact) = artifact.as_ref() {
                    attach_render_artifact(job, artifact);
                }
                if let Some(run) = run.as_ref() {
                    reconcile_render_job(
                        job,
                        Some(run.status.as_str()),
                        run.error_message.clone(),
                        run.terminal_reason.as_deref(),
                    );
                }
            }
        }
        let jobs = state.render_jobs.lock().await;
        let job = jobs
            .get(&id)
            .filter(|job| job.project_root == project_root)
            .context("Render job not found")
            .map_err(display_error)?;
        Ok(serde_json::json!(job))
    } else {
        let list: Vec<&RenderJobState> = jobs
            .values()
            .filter(|job| job.project_root == project_root)
            .collect();
        Ok(serde_json::json!(list))
    }
}

#[tauri::command]
async fn cancel_render_job(job_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let should_interrupt = {
        let mut jobs = state.render_jobs.lock().await;
        let job = jobs
            .get_mut(&job_id)
            .filter(|job| job.project_root == project_root)
            .context("Render job not found")
            .map_err(display_error)?;
        match job.status.as_str() {
            "submitted" => {
                job.status = "cancel_requested".to_string();
                false
            }
            "running" => {
                job.status = "cancel_requested".to_string();
                true
            }
            "cancel_requested" | "interrupted" => false,
            "completed" | "failed" => {
                return Err(format!("Render job is already {}", job.status));
            }
            _ => return Err(format!("Render job has invalid status: {}", job.status)),
        }
    };
    if should_interrupt {
        let marked = {
            let mut store = read_store(&state).map_err(display_error)?;
            store
                .request_cancel(&project_root, &job_id)
                .map_err(display_error)?
        };
        // The render owns the coordinator lock while running, so this cannot
        // target a different Workspace R request during the pre-run race.
        let session = active_session(&state).await.map_err(display_error)?;
        session.interrupt().await.map_err(display_error)?;
        return Ok(json!({
            "job_id": job_id,
            "status": "cancel_requested",
            "run_marked": marked
        }));
    }
    Ok(json!({
        "job_id": job_id,
        "status": "cancel_requested"
    }))
}

#[tauri::command]
async fn request_environment_operation_preview(
    request: EnvironmentOperationRequestInput,
    state: State<'_, AppState>,
) -> Result<EnvironmentOperationRequestSummary, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn list_environment_operation_requests(
    limit: Option<usize>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<EnvironmentOperationRequestSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .list_environment_operation_requests(&project_root, limit, status.as_deref())
        .map_err(display_error)
}

#[tauri::command]
async fn get_environment_operation_request(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<Option<EnvironmentOperationRequestSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .get_environment_operation_request(&project_root, &request_id)
        .map_err(display_error)
}

#[tauri::command]
async fn list_installed_packages(
    limit: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": { "limit": limit.unwrap_or(500) },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.list_installed_packages",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        store,
    )
    .await
    .map_err(display_error)
}

fn lockfile_inventory_arguments(project_root: &Path, limit: Option<u64>) -> Value {
    json!({
        "project_root": normalize_project_root(project_root.to_string_lossy().as_ref()),
        "limit": limit.unwrap_or(500).clamp(1, 500)
    })
}

#[tauri::command]
async fn list_lockfile_packages(
    limit: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn respond_environment_operation(
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
    let pending = read_store(&state)
        .map_err(display_error)?
        .get_environment_operation_request(&project_root, &request.request_id)
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
                .decide_environment_operation_request(
                    &request.request_id,
                    &rho_store::EnvironmentOperationDecisionRecord {
                        decision: "cancel".to_string(),
                        status: "interrupted".to_string(),
                        reason: Some(
                            "Environment operation channel is no longer active.".to_string(),
                        ),
                    },
                )
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
    let CoordinatorRuntime { broker, store } = &mut *context;
    decide_environment_operation(
        &request.request_id,
        &request.decision,
        request.reason,
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
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .list_runs(&project_root, limit)
        .map_err(display_error)
}

#[tauri::command]
async fn list_problems(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<ProblemSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .list_problems(&project_root, limit)
        .map_err(display_error)
}

#[tauri::command]
async fn get_run_detail(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Option<RunDetail>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .get_run_detail(&project_root, &run_id)
        .map_err(display_error)
}

#[tauri::command]
async fn compare_runs(
    left_run_id: String,
    right_run_id: String,
    state: State<'_, AppState>,
) -> Result<CompareRunsResponse, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .compare_runs(&project_root, &left_run_id, &right_run_id)
        .map_err(display_error)
}

#[tauri::command]
async fn audit_reproducibility(
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

fn contain_audit_panic<T>(operation: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)).map_err(|_| {
        "The project reproducibility check failed unexpectedly. Try the check again.".to_string()
    })
}

#[tauri::command]
async fn editor_package_functions(
    packages: Option<Vec<String>>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn editor_function_help(
    name: String,
    package: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn editor_function_documentation(
    name: String,
    package: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn editor_lint_file(
    path: String,
    document_version: i64,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
async fn editor_format_source(
    request: EditorFormatRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
    )
    .await
    .map_err(display_error)?;
    editor_format_result(response).map_err(display_error)
}

#[tauri::command]
async fn list_plot_artifacts(
    limit: Option<usize>,
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<PlotArtifactSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    read_store(&state)
        .map_err(display_error)?
        .list_plot_artifacts(
            limit,
            Some(&project_root),
            Some(&workspace_id),
            session_only.unwrap_or(true),
        )
        .map_err(display_error)
}

#[tauri::command]
async fn export_plot_artifact(
    request: ExportPlotArtifactRequest,
    state: State<'_, AppState>,
) -> Result<ArtifactRecordView, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let (file, output_path, output_absolute_path) =
        ensure_artifact_export_target(&root, &request.path, &["png"]).map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let plot = context
        .store
        .get_plot_artifact(&project_root, &request.plot_id)
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
        .store
        .get_run_detail(&project_root, &plot.run_id)
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
    context
        .store
        .create_artifact_record(&artifact)
        .map_err(display_error)?;
    context.broker.project_changed();
    let identity = context.broker.identity().clone();
    context
        .store
        .save_identity(&identity)
        .map_err(display_error)?;
    let detail = context
        .store
        .get_artifact_record(&project_root, &artifact.artifact_id)
        .map_err(display_error)?
        .context("Exported artifact record was not found")
        .map_err(display_error)?;
    Ok(ArtifactRecordView {
        artifact: detail,
        file_available: true,
        file_status: "available".to_string(),
        output_absolute_path,
        run,
    })
}

#[tauri::command]
async fn export_data_view_artifact(
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
    let CoordinatorRuntime { broker, store } = &mut *context;
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
        store,
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
        (Some(workspace_id), Some(state_revision), Some(project_revision)) => store
            .find_run_detail_for_workspace_state(
                &project_root,
                workspace_id,
                state_revision as i64,
                project_revision as i64,
            )
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
    store
        .create_artifact_record(&artifact)
        .map_err(display_error)?;
    broker.project_changed();
    let identity = broker.identity().clone();
    store.save_identity(&identity).map_err(display_error)?;
    let detail = store
        .get_artifact_record(&project_root, &artifact.artifact_id)
        .map_err(display_error)?
        .context("Exported table artifact record was not found")
        .map_err(display_error)?;
    Ok(ArtifactRecordView {
        artifact: detail,
        file_available: true,
        file_status: "available".to_string(),
        output_absolute_path,
        run,
    })
}

#[tauri::command]
async fn list_artifact_records(
    limit: Option<usize>,
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ArtifactRecordSummary>, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    read_store(&state)
        .map_err(display_error)?
        .list_artifact_records(
            limit,
            &root.to_string_lossy().replace('\\', "/"),
            Some(&workspace_id),
            session_only.unwrap_or(false),
        )
        .map_err(display_error)
}

#[tauri::command]
async fn get_artifact_record(
    artifact_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ArtifactRecordView>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let store = read_store(&state).map_err(display_error)?;
    let Some(artifact) = store
        .get_artifact_record(&project_root, &artifact_id)
        .map_err(display_error)?
    else {
        return Ok(None);
    };
    let run = artifact
        .run_id
        .as_deref()
        .map(|run_id| store.get_run_detail(&project_root, run_id))
        .transpose()
        .map_err(display_error)?
        .flatten();
    let (output_absolute_path, file_available, file_status) =
        artifact_file_status(&root, &artifact.output_path);
    Ok(Some(ArtifactRecordView {
        artifact,
        file_available,
        file_status: file_status.to_string(),
        output_absolute_path,
        run,
    }))
}

#[tauri::command]
async fn list_project_skills(
    state: State<'_, AppState>,
) -> Result<ProjectSkillDiscoverySummary, String> {
    let root = state.project_root.read().await.clone();
    let normalized = root.to_string_lossy().replace('\\', "/");
    if normalized.trim().is_empty() {
        return Ok(ProjectSkillDiscoverySummary::default());
    }
    Ok(discover_project_skill_summaries(&normalized))
}

#[tauri::command]
async fn clear_artifact_records(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    let mut store = read_store(&state).map_err(display_error)?;
    let deleted = store
        .clear_artifact_records(
            &root.to_string_lossy().replace('\\', "/"),
            Some(&workspace_id),
            session_only.unwrap_or(false),
        )
        .map_err(display_error)?;
    Ok(json!({ "deleted": deleted }))
}

#[tauri::command]
async fn clear_plot_artifacts(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    let mut store = read_store(&state).map_err(display_error)?;
    let deleted = store
        .clear_plot_artifacts(
            Some(&project_root),
            Some(&workspace_id),
            session_only.unwrap_or(true),
        )
        .map_err(display_error)?;
    Ok(json!({"deleted": deleted}))
}

// ── Evidence workspace commands ──────────────────────────────

fn resolve_doi_citation(doi: &str) -> Option<Value> {
    let url = format!("https://api.crossref.org/works/{doi}");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .ok()?;
    let body: Value = resp.json().ok()?;
    let message = body.get("message")?;
    let title = message.get("title")?.as_array()?.first()?.as_str()?;
    let authors = message
        .get("author")
        .and_then(|v| v.as_array())
        .map(|authors| {
            authors
                .iter()
                .filter_map(|a| a.get("family").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let year = message
        .get("published-print")
        .or_else(|| message.get("published-online"))
        .or_else(|| message.get("issued"))
        .and_then(|v| v.get("date-parts"))
        .and_then(|v| v.as_array())
        .and_then(|parts| parts.first())
        .and_then(|p| p.as_array())
        .and_then(|p| p.first())
        .and_then(|y| y.as_i64());
    let journal = message
        .get("container-title")
        .and_then(|v| v.as_array())
        .and_then(|titles| titles.first())
        .and_then(|t| t.as_str());
    Some(json!({
        "title": title,
        "authors": authors,
        "year": year,
        "journal": journal,
    }))
}

#[tauri::command]
async fn resolve_doi(doi: String, _state: State<'_, AppState>) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || resolve_doi_citation(&doi))
        .await
        .map_err(|e| format!("DOI resolution failed: {e}"))
        .map(|v| v.unwrap_or(Value::Null))
}

#[tauri::command]
async fn create_evidence_entry(
    title: String,
    notes: Option<String>,
    doi: Option<String>,
    run_id: Option<String>,
    artifact_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<EvidenceEntry, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let mut store = read_store(&state).map_err(display_error)?;
    store
        .create_evidence_entry(&EvidenceEntryDraft {
            project_root,
            title,
            notes: notes.unwrap_or_default(),
            doi,
            run_id,
            artifact_id,
        })
        .map_err(display_error)
}

#[tauri::command]
async fn list_evidence_entries(
    limit: Option<usize>,
    search: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<EvidenceEntry>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let store = read_store(&state).map_err(display_error)?;
    store
        .list_evidence_entries(&project_root, limit, search.as_deref())
        .map_err(display_error)
}

#[tauri::command]
async fn get_evidence_entry(
    id: i64,
    state: State<'_, AppState>,
) -> Result<Option<EvidenceEntry>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let store = read_store(&state).map_err(display_error)?;
    store
        .get_evidence_entry(&project_root, id)
        .map_err(display_error)
}

#[tauri::command]
async fn delete_evidence_entry(id: i64, state: State<'_, AppState>) -> Result<bool, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let mut store = read_store(&state).map_err(display_error)?;
    store
        .delete_evidence_entry(&project_root, id)
        .map_err(display_error)
}

fn source_claim_snapshot(
    root: &Path,
    path: &str,
    start_line: i64,
    end_line: i64,
) -> Result<(String, String)> {
    ensure!(
        start_line >= 1 && end_line >= start_line,
        "Claim source range is invalid"
    );
    ensure!(
        end_line - start_line < 200,
        "Claim source range exceeds 200 lines"
    );
    let file = project_path(root, path)?;
    ensure_editable_file(&file)?;
    ensure_editable_file_size(&file)?;
    let content = std::fs::read_to_string(&file)?;
    let lines = content.lines().collect::<Vec<_>>();
    ensure!(
        end_line as usize <= lines.len(),
        "Claim source range is outside the file"
    );
    let excerpt = lines[(start_line as usize - 1)..end_line as usize].join("\n");
    ensure!(
        excerpt.len() <= 16 * 1024,
        "Claim source excerpt exceeds 16 KiB"
    );
    let digest = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok((digest, excerpt))
}

#[tauri::command]
async fn create_evidence_claim(
    request: EvidenceClaimCreateRequest,
    state: State<'_, AppState>,
) -> Result<EvidenceClaim, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let (source_sha256, source_excerpt) = if request.anchor_kind == "source_range" {
        let path = request
            .source_path
            .as_deref()
            .ok_or_else(|| "Source path is required".to_string())?;
        let (digest, excerpt) = source_claim_snapshot(
            &root,
            path,
            request.start_line.unwrap_or(0),
            request.end_line.unwrap_or(0),
        )
        .map_err(display_error)?;
        (Some(digest), Some(excerpt))
    } else {
        (None, None)
    };
    let mut store = read_store(&state).map_err(display_error)?;
    store
        .create_evidence_claim(&EvidenceClaimDraft {
            project_root,
            kind: request.kind,
            summary: request.summary,
            anchor_kind: request.anchor_kind,
            source_path: request.source_path.map(|path| path.replace('\\', "/")),
            start_line: request.start_line,
            start_column: request.start_column,
            end_line: request.end_line,
            end_column: request.end_column,
            source_sha256,
            source_excerpt,
            artifact_id: request.artifact_id,
            evidence_ids: request.evidence_ids,
        })
        .map_err(display_error)
}

#[tauri::command]
async fn list_evidence_claims(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<EvidenceClaim>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let store = read_store(&state).map_err(display_error)?;
    store
        .list_evidence_claims(&project_root, limit)
        .map_err(display_error)
}

#[tauri::command]
async fn review_evidence_claim(
    claim_id: String,
    state: State<'_, AppState>,
) -> Result<EvidenceClaimReview, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let store = read_store(&state).map_err(display_error)?;
    let claim = store
        .get_evidence_claim(&project_root, &claim_id)
        .map_err(display_error)?;
    let source_resolved = claim.as_ref().and_then(|claim| {
        if claim.anchor_kind != "source_range" {
            return None;
        }
        let snapshot = source_claim_snapshot(
            &root,
            claim.source_path.as_deref()?,
            claim.start_line?,
            claim.end_line?,
        )
        .ok()?;
        Some(
            claim.source_sha256.as_deref() == Some(snapshot.0.as_str())
                && claim.source_excerpt.as_deref() == Some(snapshot.1.as_str()),
        )
    });
    store
        .review_evidence_claim(&project_root, &claim_id, source_resolved)
        .map_err(display_error)
}

#[tauri::command]
async fn delete_evidence_claim(
    claim_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let mut store = read_store(&state).map_err(display_error)?;
    store
        .delete_evidence_claim(&project_root, &claim_id)
        .map_err(display_error)
}

#[tauri::command]
async fn prune_plot_payloads(
    session_only: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PlotPayloadPruneResult, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    let mut store = read_store(&state).map_err(display_error)?;
    store
        .prune_plot_artifact_payloads(
            Some(&project_root),
            Some(&workspace_id),
            session_only.unwrap_or(true),
        )
        .map_err(display_error)
}

fn current_retention_policy_snapshot() -> RetentionPolicy {
    RetentionPolicy::default()
}

#[tauri::command]
async fn get_project_retention_summary(
    state: State<'_, AppState>,
) -> Result<ProjectRetentionView, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let context = active_context(&state).await.map_err(display_error)?;
    let workspace_id = context.lock().await.broker.identity().workspace_id.clone();
    let summary = read_store(&state)
        .map_err(display_error)?
        .project_retention_summary(&project_root, Some(&workspace_id))
        .map_err(display_error)?;
    Ok(ProjectRetentionView {
        summary,
        policy: current_retention_policy_snapshot(),
    })
}

#[tauri::command]
async fn retry_run(run_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let detail = context
        .store
        .get_run_detail(&project_root, &run_id)
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

fn retry_run_arguments(arguments_json: &str, parent_run_id: &str) -> Result<Value> {
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

fn run_is_retryable(request_type: &str, origin: &str) -> bool {
    request_type == "workspace.execute" && matches!(origin, "user" | "agent")
}

#[tauri::command]
async fn run_agent(
    prompt: String,
    mode: String,
    task_kind: Option<String>,
    model_id: Option<String>,
    auto_approve: Option<bool>,
    editor_context: Option<Value>,
    conversation_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if prompt.trim().is_empty() {
        return Err("Agent prompt is empty".to_string());
    }
    if !matches!(mode.as_str(), "ask" | "plan" | "act") {
        return Err(format!("unsupported Agent mode `{mode}`"));
    }
    let task_kind = task_kind.unwrap_or_else(|| "agent_turn".to_string());
    if !matches!(task_kind.as_str(), "agent_turn" | "problem_repair") {
        return Err(format!("unsupported Agent task kind `{task_kind}`"));
    }
    if task_kind == "problem_repair" && mode != "ask" {
        return Err("Problem repair must use read-only Ask mode.".to_string());
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
    let (resolved_model, credential_override) = if task_kind == "problem_repair" {
        agent_llm::resolve_model_and_credential_for_task(
            &config.data_dir,
            model_id.as_deref(),
            &mode,
            &task_kind,
        )
    } else {
        agent_llm::resolve_model_and_credential_for_turn(
            &config.data_dir,
            model_id.as_deref(),
            &mode,
        )
    }
    .map_err(display_error)?;
    let auto_approve = task_kind == "agent_turn" && auto_approve.unwrap_or(false) && mode == "act";
    let requested_conversation_id = conversation_id.map(|value| value.trim().to_string());
    if requested_conversation_id.as_deref() == Some("") {
        return Err("Agent Conversation identity cannot be empty".to_string());
    }
    let conversation_id;
    {
        let mut context_guard = context.lock().await;
        let identity = context_guard.broker.identity().clone();
        let project_root = context_guard
            .store
            .active_project_root()
            .map_err(display_error)?
            .context("Cannot start Agent without an active project identity")
            .map_err(display_error)?;
        let turn_draft = AgentTurnDraft {
            turn_id: turn_id.clone(),
            project_root: project_root.clone(),
            mode: mode.clone(),
            prompt: prompt.clone(),
            model: resolved_model.effective_model_ref.clone(),
            workspace_id: identity.workspace_id.clone(),
            state_revision_before: identity.state_revision as i64,
            project_revision_before: identity.project_revision as i64,
        };
        conversation_id = if let Some(conversation_id) = requested_conversation_id {
            context_guard
                .store
                .create_agent_turn_in_conversation(&conversation_id, None, &turn_draft)
                .map_err(display_error)?;
            conversation_id
        } else {
            let conversation_id = format!("agent_conversation_{}", Uuid::new_v4());
            context_guard
                .store
                .create_agent_turn_with_conversation(
                    &AgentConversationDraft {
                        conversation_id: conversation_id.clone(),
                        project_root,
                        title: "New conversation".to_string(),
                        legacy_unthreaded: false,
                    },
                    &turn_draft,
                )
                .map_err(display_error)?;
            conversation_id
        };
        let event_result = context_guard
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
                    "task_kind": task_kind,
                    "conversation_id": conversation_id,
                    "auto_approve": auto_approve,
                    "editor_context": editor_context.clone(),
                    "model_profile_id": resolved_model.runtime_profile.profile_id,
                    "model_display_name": resolved_model.model_display_name,
                    "provider_display_name": resolved_model.provider_display_name,
                    "effective_model": resolved_model.effective_model_ref,
                    "model_settings_revision": resolved_model.settings_revision,
                    "capability_route": resolved_model.route_capability
                }))
                .map_err(display_error)?,
            });
        if let Err(error) = event_result {
            let _ = context_guard.store.finish_agent_turn(&AgentTurnFinish {
                turn_id: turn_id.clone(),
                status: "failed".to_string(),
                terminal_reason: Some("agent_failure".to_string()),
                workspace_id_after: Some(identity.workspace_id.clone()),
                state_revision_after: Some(identity.state_revision as i64),
                project_revision_after: Some(identity.project_revision as i64),
                final_message: None,
                error_message: Some(
                    "Agent turn could not start because its initial event was not persisted."
                        .to_string(),
                ),
            });
            return Err(display_error(error));
        }
    }

    let approvals = state.approvals.clone();
    let environment_approvals = state.environment_approvals.clone();
    let rscript = config.rscript.clone();
    let process_path = config.process_path.clone();
    let agent_package = config.agent_package.clone();
    let task_turn_id = turn_id.clone();
    let task_conversation_id = conversation_id.clone();
    let task_agent_tasks = state.agent_tasks.clone();
    let runtime_profile = resolved_model.runtime_profile.clone();
    let (registered_tx, registered_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _ = registered_rx.await;
        let _ = run_agent_turn(
            session.as_ref(),
            context,
            rscript,
            Some(process_path),
            agent_package,
            resolved_model.effective_model_ref,
            Some(runtime_profile),
            None,
            credential_override,
            prompt,
            mode,
            task_turn_id.clone(),
            task_conversation_id,
            approvals,
            environment_approvals,
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
        "conversation_id": conversation_id,
        "auto_approve": auto_approve,
        "task_kind": task_kind
    }))
}

#[tauri::command]
async fn agent_llm_settings(state: State<'_, AppState>) -> Result<AgentLlmSettingsView, String> {
    let result = (|| {
        let config = runtime_config(&state)?;
        agent_llm::settings_view(&config.data_dir, &config.rscript)
    })();
    match result {
        Ok(view) => Ok(view),
        Err(error) => {
            write_startup_log(&format!(
                "agent_llm_settings outcome=failed detail={error:#}"
            ));
            Err(display_error(error))
        }
    }
}

#[tauri::command]
async fn agent_llm_save_provider(
    provider: AgentProviderProfile,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = agent_llm::save_provider(&config.data_dir, provider).map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_delete_provider(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings =
        agent_llm::delete_provider(&config.data_dir, &provider_id).map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_set_credential(
    provider_id: String,
    credential: String,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::set_credential(&config.data_dir, &provider_id, &credential)
        .map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_delete_credential(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::delete_credential(&config.data_dir, &provider_id).map_err(display_error)?;
    agent_llm::settings_view(&config.data_dir, &config.rscript).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_save_model(
    model: AgentModelProfile,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = agent_llm::save_model(&config.data_dir, model).map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_delete_model(
    request: DeleteModelRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = agent_llm::delete_model(&config.data_dir, &request).map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_select_model(
    request: AgentLlmSelectRequest,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = agent_llm::save_capability_route(
        &config.data_dir,
        request.expected_revision,
        AgentCapabilityRoute {
            capability: "agent.chat".to_string(),
            model_id: request.model_id,
            model_type: "language".to_string(),
            required_model_capabilities: Vec::new(),
        },
    )
    .map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_save_capability_route(
    expected_revision: u64,
    route: AgentCapabilityRoute,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = agent_llm::save_capability_route(&config.data_dir, expected_revision, route)
        .map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_delete_capability_route(
    expected_revision: u64,
    capability: String,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings =
        agent_llm::delete_capability_route(&config.data_dir, expected_revision, &capability)
            .map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_declare_model_capabilities(
    expected_revision: u64,
    model_id: String,
    patch: AgentModelCapabilityPatch,
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let settings = agent_llm::declare_model_capabilities(
        &config.data_dir,
        expected_revision,
        &model_id,
        patch,
    )
    .map_err(display_error)?;
    agent_llm::settings_view_from_settings(settings).map_err(display_error)
}

#[tauri::command]
async fn agent_llm_refresh_credentials(
    state: State<'_, AppState>,
) -> Result<AgentLlmSettingsView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    agent_llm::refresh_credentials_view(&config.data_dir, &config.rscript).map_err(display_error)
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

#[tauri::command]
async fn agent_llm_discover_models(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<AgentModelDiscoveryResponse, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let data_dir = config.data_dir.clone();
    let rscript = config.rscript.clone();
    tauri::async_runtime::spawn_blocking(move || {
        agent_llm::discover_models(&data_dir, &rscript, &provider_id)
    })
    .await
    .map_err(display_error)?
    .map_err(display_error)
}

#[derive(Deserialize)]
struct ApprovalDecisionRequest {
    request_id: String,
    decision: String,
    reason: Option<String>,
}

#[tauri::command]
async fn list_agent_conversations(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversationSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    read_store(&state)
        .map_err(display_error)?
        .list_agent_conversations(&project_root, limit)
        .map_err(display_error)
}

#[tauri::command]
async fn create_agent_conversation(
    state: State<'_, AppState>,
) -> Result<AgentConversationSummary, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let mut store = read_store(&state).map_err(display_error)?;
    store
        .create_agent_conversation(&AgentConversationDraft {
            conversation_id: format!("agent_conversation_{}", Uuid::new_v4()),
            project_root,
            title: "New conversation".to_string(),
            legacy_unthreaded: false,
        })
        .map_err(display_error)
}

#[tauri::command]
async fn list_agent_turns(
    conversation_id: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentTurnSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let store = read_store(&state).map_err(display_error)?;
    match conversation_id {
        Some(conversation_id) => store
            .list_agent_turns_for_conversation(&project_root, &conversation_id, limit)
            .map_err(display_error),
        None => store
            .list_agent_turns(&project_root, limit)
            .map_err(display_error),
    }
}

#[tauri::command]
async fn list_approval_requests(
    limit: Option<usize>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ApprovalRequestSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .list_approval_requests(&project_root, limit, status.as_deref())
        .map_err(display_error)
}

#[tauri::command]
async fn get_agent_turn_detail(
    turn_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentTurnDetail>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    read_store(&state)
        .map_err(display_error)?
        .get_agent_turn_detail(&project_root, &turn_id)
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
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let pending = read_store(&state)
        .map_err(display_error)?
        .get_approval_request(&project_root, &request.request_id)
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

    let current_project_root = {
        let root = state.project_root.read().await.clone();
        normalize_project_root(root.to_string_lossy().as_ref())
    };
    let render_job_ids = {
        let mut jobs = state.render_jobs.lock().await;
        jobs.values_mut()
            .filter(|job| {
                job.project_root == current_project_root && !render_job_is_terminal(&job.status)
            })
            .map(|job| {
                job.status = "cancel_requested".to_string();
                job.job_id.clone()
            })
            .collect::<Vec<_>>()
    };
    let render_tasks = {
        let mut tasks = state.render_tasks.lock().await;
        render_job_ids
            .iter()
            .filter_map(|job_id| tasks.remove(job_id))
            .collect::<Vec<_>>()
    };

    let active_run_id = {
        let mut store = read_store(&state).map_err(display_error)?;
        let run_id = store
            .latest_active_run_id(&current_project_root)
            .map_err(display_error)?;
        if let Some(run_id) = run_id.as_ref() {
            let _ = store
                .request_cancel(&current_project_root, run_id)
                .map_err(display_error)?;
        }
        run_id
    };

    let old_context = state.context.lock().await.take();
    let old_session = state.session.write().await.take();
    if active_run_id.is_some() || !render_job_ids.is_empty() {
        if let Some(session) = old_session.as_ref() {
            let _ = session.interrupt().await;
        }
    }
    for task in render_tasks {
        task.abort();
        let _ = task.await;
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
    sync_workspace_project_root(&state, &root, SwitchTestStep::SyncWorkspace)
        .await
        .map_err(display_error)?;
    if !render_job_ids.is_empty() {
        let reconciled = {
            let store = read_store(&state).map_err(display_error)?;
            let mut reconciled = Vec::with_capacity(render_job_ids.len());
            for job_id in &render_job_ids {
                let run = store
                    .get_run_detail(&current_project_root, job_id)
                    .map_err(display_error)?;
                let artifact = store
                    .get_artifact_record_for_run(&current_project_root, job_id, "render_output")
                    .map_err(display_error)?;
                reconciled.push((job_id.clone(), run, artifact));
            }
            reconciled
        };
        let mut jobs = state.render_jobs.lock().await;
        for (job_id, run, artifact) in reconciled {
            if let Some(job) = jobs.get_mut(&job_id) {
                if run.as_ref().is_some_and(|run| run.status == "completed") {
                    if let Some(artifact) = artifact.as_ref() {
                        attach_render_artifact(job, artifact);
                    }
                }
                reconcile_render_job(
                    job,
                    run.as_ref().map(|run| run.status.as_str()),
                    run.as_ref().and_then(|run| run.error_message.clone()),
                    run.as_ref().and_then(|run| run.terminal_reason.as_deref()),
                );
            }
        }
    }
    Ok(status)
}

#[tauri::command]
async fn git_status(state: State<'_, AppState>) -> Result<git::GitStatus, String> {
    let root = state.project_root.read().await.clone();
    git::git_status(Path::new(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_log(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<git::GitLogEntry>, String> {
    let root = state.project_root.read().await.clone();
    git::git_log(Path::new(&root), limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_diff(
    staged: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<git_review::GitReviewFile>, String> {
    let root = state.project_root.read().await.clone();
    git_review::list_files(Path::new(&root), staged.unwrap_or(false)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_stage(
    file_path: String,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::stage_file(Path::new(&root), &file_path, &expected_revision)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_commit(
    message: String,
    expected_staged_revision: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = state.project_root.read().await.clone();
    git_review::commit(Path::new(&root), &message, &expected_staged_revision)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_diff_unified(
    file_path: String,
    staged: Option<bool>,
    state: State<'_, AppState>,
) -> Result<git_review::GitReviewDiff, String> {
    let root = state.project_root.read().await.clone();
    git_review::review_diff(Path::new(&root), &file_path, staged.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_hunk_stage(
    file_path: String,
    hunk_index: usize,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::stage_hunk(Path::new(&root), &file_path, hunk_index, &expected_revision)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_hunk_unstage(
    file_path: String,
    hunk_index: usize,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::unstage_hunk(Path::new(&root), &file_path, hunk_index, &expected_revision)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_restore_file(
    file_path: String,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::restore_file(Path::new(&root), &file_path, &expected_revision)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_unstage_file(
    file_path: String,
    expected_revision: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    git_review::unstage_file(Path::new(&root), &file_path, &expected_revision)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_staged_revision(state: State<'_, AppState>) -> Result<String, String> {
    let root = state.project_root.read().await.clone();
    git_review::staged_revision(Path::new(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_list_conflicts(state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = Path::new(&*root);
    // Check MERGE_HEAD
    let merge_head = git::run_git(project_root, &["rev-parse", "--short", "MERGE_HEAD"])
        .map(|s| s.trim().to_string())
        .ok();
    let output = git::run_git(project_root, &["diff", "--name-only", "--diff-filter=U"])
        .map_err(|e| e.to_string())?;
    let files: Vec<String> = output
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(json!({
        "files": files,
        "merge_head": merge_head,
        "has_conflicts": !files.is_empty(),
    }))
}

#[tauri::command]
async fn git_resolve_conflict(
    file_path: String,
    resolution: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = state.project_root.read().await.clone();
    let root_path = Path::new(&*root);
    match resolution.as_str() {
        "ours" => {
            git::run_git(root_path, &["checkout", "--ours", "--", &file_path])
                .map_err(|e| e.to_string())?;
            git::run_git(root_path, &["add", "--", &file_path]).map_err(|e| e.to_string())?;
        }
        "theirs" => {
            git::run_git(root_path, &["checkout", "--theirs", "--", &file_path])
                .map_err(|e| e.to_string())?;
            git::run_git(root_path, &["add", "--", &file_path]).map_err(|e| e.to_string())?;
        }
        "mark" => {
            git::run_git(root_path, &["add", "--", &file_path]).map_err(|e| e.to_string())?;
        }
        other => return Err(format!("unknown resolution: {other}")),
    }
    Ok(())
}

#[tauri::command]
async fn targets_status(state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": { "project_root": project_root },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.inspect_targets",
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
async fn shutdown_application(state: &AppState) -> Result<(), String> {
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
    #[cfg(windows)]
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
                #[cfg(unix)]
                if let Err(error) = session.terminate_process_group().await {
                    write_startup_log(&format!("Ark process-group termination failed: {error:#}"));
                }
                drop(session);
                #[cfg(windows)]
                if let Some(pid) = kernel_pid
                    && let Err(error) = terminate_process_tree(pid)
                {
                    write_startup_log(&format!("Ark process-tree termination failed: {error:#}"));
                }
            }
        }
    }
    write_startup_log("Rho desktop shutdown completed");
    Ok(())
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

fn durable_project_root(root: &Path) -> String {
    normalize_project_root(root.to_string_lossy().as_ref())
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
    let mut store = match Store::open(&config.store_path) {
        Ok(store) => {
            write_startup_event(json!({
                "kind": "store_migration",
                "outcome": store.migration_outcome(),
            }));
            store
        }
        Err(error) => {
            if let Some(outcome) = error.migration_outcome() {
                write_startup_event(json!({
                    "kind": "store_migration",
                    "outcome": outcome,
                }));
            }
            return Err(error).context("opening Rho event store");
        }
    };
    let project_root = state.project_root.read().await.clone();
    store
        .set_project_root(Some(&normalize_project_root(
            project_root.to_string_lossy().as_ref(),
        )))
        .context("binding the active project identity")?;
    store
        .recover_incomplete_runs()
        .context("recovering incomplete runs after desktop restart")?;
    store
        .recover_incomplete_agent_turns()
        .context("recovering incomplete agent turns after desktop restart")?;
    store
        .recover_incomplete_approvals()
        .context("recovering incomplete approvals after desktop restart")?;
    store
        .recover_incomplete_environment_operations()
        .context("recovering incomplete environment operations after desktop restart")?;
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
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let mut store = read_store(state)?;
    let target = match run_id {
        Some(value) => value,
        None => store
            .latest_active_run_id(&project_root)
            .context("looking up active run")?
            .context("No active run is available to interrupt")?,
    };
    ensure!(
        store
            .request_cancel(&project_root, &target)
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
    switch_project_with_watcher_factory(root, session_snapshot, state, |watch_root| {
        start_project_watcher(app.clone(), watch_root.to_path_buf())
    })
    .await
}

async fn switch_project_with_watcher_factory<F>(
    root: PathBuf,
    session_snapshot: Option<ProjectSessionSnapshot>,
    state: &AppState,
    start_watcher: F,
) -> Result<ProjectRestoreResponse>
where
    F: FnOnce(&Path) -> Result<ProjectWatcherControl>,
{
    let target_session =
        session_snapshot.unwrap_or_else(|| state.project_store.load_session_or_default(&root));
    if let Some(blocker) = project_switch_blocker(state).await? {
        write_project_switch_event(
            "project_switch_blocked",
            &root,
            None,
            Some("project_switch_blocked"),
            Some(blocker.message.as_str()),
        );
        return Ok(ProjectRestoreResponse::blocked(target_session, blocker));
    }

    let project = list_project_files(&root)?;
    let normalized_root = normalize_project_root(root.to_string_lossy().as_ref());
    let previous_ui_root = state.project_root.read().await.clone();
    let previous_session = state
        .project_store
        .load_session_or_default(&previous_ui_root);
    let previous_store_root = read_store(state)?.active_project_root()?;

    sync_workspace_project_root(state, &root, SwitchTestStep::SyncWorkspace).await?;

    let next_watcher = start_watcher(&root)
        .map_err(|error| anyhow!("starting target project watcher failed: {error:#}"));

    let next_watcher = match next_watcher {
        Ok(next_watcher) => next_watcher,
        Err(error) => {
            return recover_failed_project_switch(
                state,
                &previous_ui_root,
                previous_store_root.as_deref(),
                previous_session,
                "project_switch_watcher_failed",
                format!("Target project watcher failed after workspace sync: {error:#}"),
            )
            .await;
        }
    };

    if let Err(error) = set_store_active_project_root(
        state,
        Some(&normalized_root),
        SwitchTestStep::SetActiveProjectRoot,
    ) {
        return recover_failed_project_switch(
            state,
            &previous_ui_root,
            previous_store_root.as_deref(),
            previous_session,
            "project_switch_store_root_failed",
            format!("Project identity could not be committed: {error:#}"),
        )
        .await;
    }

    if let Err(error) =
        save_last_opened_project(state, &root, SwitchTestStep::SaveLastOpenedProject)
    {
        return recover_failed_project_switch(
            state,
            &previous_ui_root,
            previous_store_root.as_deref(),
            previous_session,
            "project_switch_last_opened_failed",
            format!("Last opened project could not be committed: {error:#}"),
        )
        .await;
    }

    *state.project_root.write().await = root.clone();
    let mut watcher = state.project_watcher.lock().await;
    let previous_watcher = watcher.replace(next_watcher);
    drop(watcher);
    if let Some(previous) = previous_watcher {
        previous.stop();
    }

    write_project_switch_event(
        "project_switch_succeeded",
        &root,
        None,
        None,
        Some("project switch committed"),
    );

    Ok(ProjectRestoreResponse::ready(project, target_session))
}

async fn recover_failed_project_switch(
    state: &AppState,
    previous_ui_root: &Path,
    previous_store_root: Option<&str>,
    previous_session: ProjectSessionSnapshot,
    reason_code: &str,
    message: String,
) -> Result<ProjectRestoreResponse> {
    let restore_result = async {
        sync_workspace_project_root(state, previous_ui_root, SwitchTestStep::RestoreWorkspace)
            .await?;
        set_store_active_project_root(
            state,
            previous_store_root,
            SwitchTestStep::RestoreActiveProjectRoot,
        )?;
        Result::<()>::Ok(())
    }
    .await;

    match restore_result {
        Ok(()) => {
            let restored_root = previous_ui_root.to_string_lossy().replace('\\', "/");
            write_project_switch_event(
                "project_switch_failed_restored",
                previous_ui_root,
                Some(previous_ui_root),
                Some(reason_code),
                Some(message.as_str()),
            );
            Ok(ProjectRestoreResponse::failed_restored(
                previous_session,
                restored_root,
                reason_code,
                message,
            ))
        }
        Err(restore_error) => {
            let fatal_message =
                format!("{message}; restore failed and restart is required: {restore_error:#}");
            write_project_switch_event(
                "project_switch_fatal",
                previous_ui_root,
                None,
                Some("project_switch_restore_failed"),
                Some(fatal_message.as_str()),
            );
            Ok(ProjectRestoreResponse::fatal(
                previous_session,
                "project_switch_restore_failed",
                fatal_message,
            ))
        }
    }
}

async fn project_switch_blocker(state: &AppState) -> Result<Option<ProjectSwitchBlocker>> {
    let fallback_root = {
        let root = state.project_root.read().await.clone();
        normalize_project_root(root.to_string_lossy().as_ref())
    };
    let approval_count = state.approvals.count().await;
    let environment_approval_count = state.environment_approvals.count().await;
    let store = read_store(state)?;
    let current_root = store.active_project_root()?.unwrap_or(fallback_root);

    if let Some(run_id) = store.latest_active_run_id(&current_root)? {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::ActiveRun,
            message: "Finish or interrupt the active scientific run before switching projects."
                .to_string(),
            pending_count: 1,
            run_id: Some(run_id),
            turn_id: None,
            request_id: None,
            operation_status: Some("running".to_string()),
        }));
    }

    let render_jobs = state.render_jobs.lock().await;
    if let Some(job) = render_jobs
        .values()
        .find(|job| job.project_root == current_root && !render_job_is_terminal(&job.status))
    {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::ActiveRun,
            message: "Cancel the submitted document render before switching projects.".to_string(),
            pending_count: 1,
            run_id: Some(job.job_id.clone()),
            turn_id: None,
            request_id: None,
            operation_status: Some(job.status.clone()),
        }));
    }
    drop(render_jobs);

    let agent_tasks = state.agent_tasks.lock().await;
    if let Some(turn_id) = agent_tasks.keys().next().cloned() {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::AgentTurn,
            message: "Stop the active Agent turn before switching projects.".to_string(),
            pending_count: agent_tasks.len(),
            run_id: None,
            turn_id: Some(turn_id),
            request_id: None,
            operation_status: Some("running".to_string()),
        }));
    }
    drop(agent_tasks);

    let waiting_approvals =
        store.list_approval_requests(&current_root, Some(10), Some("waiting"))?;
    if approval_count > 0 || !waiting_approvals.is_empty() {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::Approval,
            message: "Resolve the waiting approval before switching projects.".to_string(),
            pending_count: approval_count.max(waiting_approvals.len()),
            run_id: None,
            turn_id: waiting_approvals
                .first()
                .map(|approval| approval.turn_id.clone()),
            request_id: waiting_approvals
                .first()
                .map(|approval| approval.request_id.clone()),
            operation_status: Some("waiting".to_string()),
        }));
    }

    if let Some(blocker) =
        environment_operation_switch_blocker(&store, &current_root, environment_approval_count)?
    {
        return Ok(Some(blocker));
    }

    Ok(None)
}

fn environment_operation_switch_blocker(
    store: &Store,
    project_root: &str,
    environment_approval_count: usize,
) -> Result<Option<ProjectSwitchBlocker>> {
    for status in ["running", "approved", "requested"] {
        let requests =
            store.list_environment_operation_requests(project_root, Some(10), Some(status))?;
        if !requests.is_empty() {
            let message = match status {
                "running" => {
                    "Wait for the active direct environment operation to finish before switching projects."
                }
                _ => "Resolve the direct environment operation decision before switching projects.",
            };
            return Ok(Some(ProjectSwitchBlocker {
                kind: ProjectSwitchBlockerKind::EnvironmentOperation,
                message: message.to_string(),
                pending_count: environment_approval_count.max(requests.len()),
                run_id: requests.first().and_then(|request| request.run_id.clone()),
                turn_id: requests.first().and_then(|request| request.turn_id.clone()),
                request_id: requests.first().map(|request| request.request_id.clone()),
                operation_status: Some(status.to_string()),
            }));
        }
    }
    if environment_approval_count > 0 {
        return Ok(Some(ProjectSwitchBlocker {
            kind: ProjectSwitchBlockerKind::EnvironmentOperation,
            message: "Resolve the direct environment operation decision before switching projects."
                .to_string(),
            pending_count: environment_approval_count,
            run_id: None,
            turn_id: None,
            request_id: None,
            operation_status: Some("requested".to_string()),
        }));
    }
    Ok(None)
}

fn maybe_handle_switch_test_directive(state: &AppState, step: SwitchTestStep) -> Result<bool> {
    match state.switch_test_control.take(step) {
        Some(SwitchTestDirective::SucceedWithoutRunning) => Ok(true),
        Some(SwitchTestDirective::Fail(message)) => Err(anyhow!(message)),
        None => Ok(false),
    }
}

fn set_store_active_project_root(
    state: &AppState,
    project_root: Option<&str>,
    step: SwitchTestStep,
) -> Result<()> {
    if maybe_handle_switch_test_directive(state, step)? {
        return Ok(());
    }
    let mut store = read_store(state)?;
    store.set_project_root(project_root)?;
    Ok(())
}

fn save_last_opened_project(state: &AppState, root: &Path, step: SwitchTestStep) -> Result<()> {
    if maybe_handle_switch_test_directive(state, step)? {
        return Ok(());
    }
    state.project_store.save_last_opened_project(root)
}

async fn sync_workspace_project_root(
    state: &AppState,
    root: &Path,
    step: SwitchTestStep,
) -> Result<()> {
    if maybe_handle_switch_test_directive(state, step)? {
        return Ok(());
    }
    let session = active_session(state).await?;
    let context = active_context(state).await?;
    let mut context = context.lock().await;
    let CoordinatorRuntime { broker, store } = &mut *context;
    let payload = json!({
        "arguments": {"code": workspace_project_root_code(root)?},
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

fn workspace_project_root_code(root: &Path) -> Result<String> {
    Ok(format!(
        "setwd({})",
        serde_json::to_string(&display_path(root))?
    ))
}

fn write_project_switch_event(
    kind: &str,
    target_root: &Path,
    restored_root: Option<&Path>,
    reason_code: Option<&str>,
    message: Option<&str>,
) {
    write_startup_event(json!({
        "kind": kind,
        "target_root": bounded_diagnostic(&target_root.to_string_lossy()),
        "restored_root": restored_root.map(|value| bounded_diagnostic(&value.to_string_lossy())),
        "reason_code": reason_code.map(bounded_diagnostic),
        "message": message.map(bounded_diagnostic),
    }));
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
    let started = Instant::now();
    ensure!(ark.is_file(), "bundled Ark executable was not found");
    std::fs::create_dir_all(&data_dir)?;
    let source_dir = data_dir.join("sources");
    let bridge_package = source_dir.join("rho.bridge");
    let agent_package = source_dir.join("rho.agent");
    write_source(&bridge_package.join("R/state.R"), BRIDGE_STATE)?;
    write_source(&bridge_package.join("R/execute.R"), BRIDGE_EXECUTE)?;
    write_source(&bridge_package.join("R/workspace.R"), BRIDGE_WORKSPACE)?;
    write_source(&bridge_package.join("R/completion.R"), BRIDGE_COMPLETION)?;
    write_source(&bridge_package.join("R/lintr.R"), BRIDGE_LINTR)?;
    write_source(&bridge_package.join("R/targets.R"), BRIDGE_TARGETS)?;
    write_source(&bridge_package.join("R/formatting.R"), BRIDGE_FORMATTING)?;
    write_source(&agent_package.join("R/aaa-state.R"), AGENT_STATE)?;
    write_source(&agent_package.join("R/transport.R"), AGENT_TRANSPORT)?;
    write_source(&agent_package.join("R/aisdk_adapter.R"), AGENT_ADAPTER)?;

    let rscript = locate_rscript(selected_rscript)?;
    let cached = load_runtime_cache(&data_dir, &rscript, &ark);
    let (
        r_home,
        r_bin,
        r_arch,
        path_sep,
        r_version,
        r_libs,
        r_profile_user,
        r_environ_user,
        agent_runtime,
    ) = if let Some(cache) = cached {
        write_startup_log(&format!(
            "startup_phase=runtime_cache outcome=hit elapsed_ms={}",
            started.elapsed().as_millis()
        ));
        (
            cache.r_home,
            cache.r_bin,
            cache.r_arch,
            cache.path_sep,
            cache.r_version,
            cache.r_libs,
            cache
                .r_profile_user
                .map(|signature| PathBuf::from(signature.path)),
            cache
                .r_environ_user
                .map(|signature| PathBuf::from(signature.path)),
            cache.agent_runtime,
        )
    } else {
        let probe_started = Instant::now();
        let probe = probe_r_runtime(&rscript)?;
        let RRuntimeProbe {
            r_home,
            r_bin,
            r_arch,
            path_sep,
            r_version,
            r_libs,
            r_profile_user,
            r_environ_user,
        } = probe;
        write_startup_log(&format!(
            "startup_phase=runtime_probe elapsed_ms={} agent_probe=deferred",
            probe_started.elapsed().as_millis()
        ));
        let agent_runtime = AgentRuntimeStatus {
            available: false,
            aisdk_version: None,
            error: Some("Agent runtime check is continuing in the background.".to_string()),
        };
        let cache = RuntimeCacheFile {
            version: RUNTIME_CACHE_VERSION,
            rscript: runtime_file_signature(&rscript)?,
            ark: runtime_file_signature(&ark)?,
            r_profile_user: r_profile_user
                .as_deref()
                .map(runtime_file_signature)
                .transpose()?,
            r_environ_user: r_environ_user
                .as_deref()
                .map(runtime_file_signature)
                .transpose()?,
            r_home: r_home.clone(),
            r_bin: r_bin.clone(),
            r_arch: r_arch.clone(),
            path_sep: path_sep.clone(),
            r_version: r_version.clone(),
            r_libs: r_libs.clone(),
            agent_runtime: agent_runtime.clone(),
        };
        if let Err(error) = save_runtime_cache(&data_dir, &cache) {
            write_startup_log(&format!(
                "startup_phase=runtime_cache outcome=write_failed detail={error:#}"
            ));
        }
        (
            r_home,
            r_bin,
            r_arch,
            path_sep,
            r_version,
            r_libs,
            r_profile_user,
            r_environ_user,
            agent_runtime,
        )
    };
    ensure_supported_r_architecture(&r_arch)?;
    let process_path = platform::child_process_path(Some(Path::new(&r_bin)))
        .context("constructing the desktop child-process PATH")?;
    let runtime_dir = data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_dir)?;
    let empty_site_environ = runtime_dir.join("empty-site.Renviron");
    write_source(&empty_site_environ, "")?;
    let log_path = runtime_dir.join("ark.log");
    let kernelspec = runtime_dir.join("kernel.json");
    let mut argv = vec![
        json!(ark),
        json!("--connection_file"),
        json!("{connection_file}"),
        json!("--session-mode"),
        json!("console"),
        json!("--log"),
        json!(log_path),
        json!("--"),
        json!("--interactive"),
        json!("--no-site-file"),
    ];
    let mut environment = serde_json::Map::from_iter([
        ("R_HOME".to_string(), json!(r_home)),
        ("R_LIBS".to_string(), json!(r_libs)),
        (
            "PATH".to_string(),
            json!(process_path.to_string_lossy().into_owned()),
        ),
    ]);
    if let Some(r_profile_user) = &r_profile_user {
        environment.insert("R_PROFILE_USER".to_string(), json!(r_profile_user));
    } else {
        argv.push(json!("--no-init-file"));
    }
    if let Some(r_environ_user) = &r_environ_user {
        environment.insert("R_ENVIRON".to_string(), json!(empty_site_environ));
        environment.insert("R_ENVIRON_USER".to_string(), json!(r_environ_user));
    } else {
        argv.push(json!("--no-environ"));
    }
    let spec = json!({
        "argv": argv,
        "display_name": "Ark R 0.1.252 (Rho Desktop)",
        "language": "R",
        "interrupt_mode": "message",
        "kernel_protocol_version": "5.4",
        "env": environment
    });
    atomic_write(&kernelspec, &serde_json::to_vec_pretty(&spec)?)?;
    atomic_write(
        &kernelspec.with_extension("runtime.json"),
        &serde_json::to_vec_pretty(&json!({
            "r_version": r_version,
            "r_home": r_home,
            "r_bin": r_bin,
            "r_arch": r_arch,
            "path_sep": path_sep
        }))?,
    )?;
    Ok(RuntimeConfig {
        data_dir: data_dir.clone(),
        kernelspec,
        rscript,
        r_version,
        r_home,
        process_path,
        r_profile_user,
        r_environ_user,
        bridge_package,
        agent_package,
        agent_runtime,
        store_path: data_dir.join("rho-desktop.sqlite"),
    })
}

fn runtime_cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime").join("runtime-cache.json")
}

fn runtime_file_signature(path: &Path) -> Result<RuntimeFileSignature> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("reading runtime metadata for {}", path.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or_default();
    Ok(RuntimeFileSignature {
        path: path.to_string_lossy().replace('\\', "/"),
        size: metadata.len(),
        modified_unix_ms: modified,
    })
}

fn runtime_signature_matches(path: &Path, expected: &RuntimeFileSignature) -> bool {
    runtime_file_signature(path)
        .map(|actual| {
            actual.path == expected.path
                && actual.size == expected.size
                && actual.modified_unix_ms == expected.modified_unix_ms
        })
        .unwrap_or(false)
}

fn optional_runtime_signature_matches(
    signature: Option<&RuntimeFileSignature>,
    missing_name: &str,
) -> bool {
    signature
        .map(|value| runtime_signature_matches(Path::new(&value.path), value))
        .unwrap_or_else(|| {
            let path = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .map(|home| home.join(missing_name));
            path.map(|value| !value.is_file()).unwrap_or(true)
        })
}

fn load_runtime_cache(data_dir: &Path, rscript: &Path, ark: &Path) -> Option<RuntimeCacheFile> {
    let path = runtime_cache_path(data_dir);
    let cache = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeCacheFile>(&bytes).ok())?;
    if cache.version != RUNTIME_CACHE_VERSION
        || !runtime_signature_matches(rscript, &cache.rscript)
        || !runtime_signature_matches(ark, &cache.ark)
        || !optional_runtime_signature_matches(cache.r_profile_user.as_ref(), ".Rprofile")
        || !optional_runtime_signature_matches(cache.r_environ_user.as_ref(), ".Renviron")
    {
        return None;
    }
    Some(cache)
}

fn save_runtime_cache(data_dir: &Path, cache: &RuntimeCacheFile) -> Result<()> {
    let path = runtime_cache_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write(&path, &serde_json::to_vec_pretty(cache)?)
}

fn locate_ark(app: &tauri::App) -> Result<PathBuf> {
    let resource_dir = app
        .path()
        .resource_dir()
        .context("resolving Rho resource directory")?;
    let current_exe = std::env::current_exe().context("resolving the Rho executable path")?;
    locate_ark_from_candidates(ark_candidate_paths(
        std::env::consts::OS,
        std::env::consts::ARCH,
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &resource_dir,
        &current_exe,
    ))
}

fn ark_candidate_paths(
    os: &str,
    arch: &str,
    manifest_dir: &Path,
    resource_dir: &Path,
    current_exe: &Path,
) -> Vec<PathBuf> {
    match (os, arch) {
        ("windows", "x86_64") => vec![
            resource_dir.join("resources/runtime/ark.exe"),
            manifest_dir.join("../resources/runtime/ark.exe"),
        ],
        ("macos", "aarch64") => vec![
            current_exe.parent().unwrap_or(current_exe).join("ark"),
            manifest_dir.join("binaries/ark-aarch64-apple-darwin"),
        ],
        _ => Vec::new(),
    }
}

fn locate_ark_from_candidates(candidates: Vec<PathBuf>) -> Result<PathBuf> {
    ensure!(
        !candidates.is_empty(),
        "bundled Ark is unavailable for {}-{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    Ok(candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone()))
}

fn development_ark_path() -> Result<PathBuf> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let current_exe = std::env::current_exe().context("resolving the Rho executable path")?;
    locate_ark_from_candidates(ark_candidate_paths(
        std::env::consts::OS,
        std::env::consts::ARCH,
        manifest_dir,
        manifest_dir,
        &current_exe,
    ))
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

    #[cfg(target_os = "macos")]
    for candidate in [
        PathBuf::from("/Library/Frameworks/R.framework/Resources/bin/Rscript"),
        PathBuf::from("/Library/Frameworks/R.framework/Versions/Current/Resources/bin/Rscript"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let search_path =
        platform::child_process_path(None).context("constructing the Rscript search PATH")?;
    let executable = if cfg!(windows) {
        "Rscript.exe"
    } else {
        "Rscript"
    };
    if let Some(path) = find_executable_on_path(executable, &search_path) {
        return Ok(path);
    }

    #[cfg(windows)]
    {
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
    }
    #[cfg(windows)]
    bail!("Rscript.exe was not found. Install R 4.4 or later, then restart Rho.");
    #[cfg(target_os = "macos")]
    bail!("Rscript was not found. Install arm64 R 4.4 or later, then restart Rho.");
    #[cfg(not(any(windows, target_os = "macos")))]
    bail!("Rscript was not found. Install R 4.4 or later, then restart Rho.")
}

fn find_executable_on_path(executable: &str, search_path: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
}

fn probe_r_runtime(rscript: &Path) -> Result<RRuntimeProbe> {
    let expression = r#"
cat("__RHO_HOME__", normalizePath(R.home(), winslash = "/"), "\n", sep = "")
cat("__RHO_BIN__", normalizePath(R.home("bin"), winslash = "/"), "\n", sep = "")
cat("__RHO_ARCH__", R.version$arch, "\n", sep = "")
cat("__RHO_PATH_SEP__", .Platform$path.sep, "\n", sep = "")
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
        Some(RUserStartupFiles {
            profile: probe.r_profile_user.as_deref(),
            environ: probe.r_environ_user.as_deref(),
        }),
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
    let r_bin =
        probe_value(stdout, "__RHO_BIN__").context("R bin was absent from runtime probe")?;
    let r_arch = probe_value(stdout, "__RHO_ARCH__")
        .context("R architecture was absent from runtime probe")?;
    let path_sep = probe_value(stdout, "__RHO_PATH_SEP__")
        .context("R path separator was absent from runtime probe")?;
    ensure_supported_r_architecture(&r_arch)?;
    let r_version = probe_value(stdout, "__RHO_VERSION__")
        .context("R version was absent from runtime probe")?;
    let r_version_number = probe_value(stdout, "__RHO_VERSION_NUMBER__")
        .context("R version number was absent from runtime probe")?;
    ensure_supported_r_version(&r_version_number)?;
    let r_libs = probe_value(stdout, "__RHO_LIBS__")
        .context("R library paths were absent from runtime probe")?;
    let r_profile_user = existing_startup_file(
        probe_value(stdout, "__RHO_PROFILE_USER__")
            .context("R user profile path was absent from runtime probe")?,
    );
    let r_environ_user = existing_startup_file(
        probe_value(stdout, "__RHO_ENVIRON_USER__")
            .context("R user environment path was absent from runtime probe")?,
    );
    Ok(RRuntimeProbe {
        r_home,
        r_bin,
        r_arch,
        path_sep,
        r_version,
        r_libs,
        r_profile_user,
        r_environ_user,
    })
}

fn existing_startup_file(path: String) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    path.is_file().then_some(path)
}

fn probe_value(stdout: &str, prefix: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix(prefix).map(str::trim))
        .map(str::to_string)
}

fn probe_agent_runtime(
    rscript: &Path,
    r_profile_user: Option<&Path>,
    r_environ_user: Option<&Path>,
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
        Some(RUserStartupFiles {
            profile: r_profile_user,
            environ: r_environ_user,
        }),
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
    user_files: Option<RUserStartupFiles<'_>>,
) -> Result<ProbeProcessOutput> {
    let mut command = Command::new(rscript);
    hide_console_window(&mut command);
    if matches!(startup, RProbeStartup::Controlled) {
        command.args(["--no-environ", "--no-init-file", "--no-site-file"]);
    } else if let Some(user_files) = user_files {
        let empty_site_environ = configure_user_startup(&mut command, user_files)?;
        return run_prepared_r_probe(command, expression, timeout, empty_site_environ);
    }
    run_prepared_r_probe(command, expression, timeout, None)
}

fn configure_user_startup(
    command: &mut Command,
    user_files: RUserStartupFiles<'_>,
) -> Result<Option<tempfile::NamedTempFile>> {
    command.arg("--no-site-file");
    if let Some(r_profile_user) = user_files.profile {
        command.env("R_PROFILE_USER", r_profile_user);
    } else {
        command.arg("--no-init-file");
    }
    if let Some(r_environ_user) = user_files.environ {
        let empty_site_environ =
            tempfile::NamedTempFile::new().context("creating empty site R environment file")?;
        command
            .env("R_ENVIRON", empty_site_environ.path())
            .env("R_ENVIRON_USER", r_environ_user);
        Ok(Some(empty_site_environ))
    } else {
        command.arg("--no-environ");
        Ok(None)
    }
}

fn run_prepared_r_probe(
    mut command: Command,
    expression: &str,
    timeout: Duration,
    _empty_site_environ: Option<tempfile::NamedTempFile>,
) -> Result<ProbeProcessOutput> {
    let script_file = write_r_probe_script(expression)?;
    let stdout_file = tempfile::NamedTempFile::new().context("creating R probe stdout file")?;
    let stderr_file = tempfile::NamedTempFile::new().context("creating R probe stderr file")?;
    command
        .arg(script_file.path())
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

fn write_r_probe_script(expression: &str) -> Result<tempfile::NamedTempFile> {
    let mut script_file = tempfile::Builder::new()
        .prefix("rho-probe-")
        .suffix(".R")
        .tempfile()
        .context("creating R probe script file")?;
    script_file
        .write_all(expression.as_bytes())
        .context("writing R probe script file")?;
    script_file
        .flush()
        .context("flushing R probe script file")?;
    Ok(script_file)
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
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let mut store = read_store(&state).map_err(display_error)?;
    let deleted = store
        .clear_agent_history(&project_root)
        .map_err(display_error)?;
    Ok(json!({"deleted": deleted}))
}

fn hide_console_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _command.creation_flags(0x0800_0000);
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

fn r_architecture_supported(target_os: &str, target_arch: &str, r_arch: &str) -> bool {
    if target_os == "macos" && target_arch == "aarch64" {
        matches!(r_arch.trim(), "aarch64" | "arm64")
    } else {
        true
    }
}

fn ensure_supported_r_architecture(r_arch: &str) -> Result<()> {
    ensure!(
        r_architecture_supported(std::env::consts::OS, std::env::consts::ARCH, r_arch),
        "R_ARCH_MISMATCH: Rho for Apple Silicon requires arm64 R; found `{}`",
        r_arch.trim()
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
    let project_root = context
        .store
        .active_project_root()
        .map_err(display_error)?
        .context("Cannot cancel Agent without an active project identity")
        .map_err(display_error)?;
    let detail = context
        .store
        .get_agent_turn_detail(&project_root, &turn_id)
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
                terminal_reason: Some("user_cancelled".to_string()),
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
    write_startup_event(json!({ "message": bounded_diagnostic(message) }));
}

fn write_startup_event(event: Value) {
    let path = startup_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let timestamp = chrono::Utc::now().to_rfc3339();
        let envelope = json!({
            "timestamp": timestamp,
            "event": event,
        });
        let _ = writeln!(file, "{envelope}");
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
    let (code, phase, title, message, actions): (&str, &str, &str, String, Vec<String>) =
        if detail.contains("bundled Ark executable") {
            (
                "ARK_RESOURCE_MISSING",
                "checking_installation",
                "Rho installation needs repair",
                "The bundled Workspace R engine is missing. Reinstall Rho, then retry.".to_string(),
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
                format!(
                    "Choose {} from an R 4.4 or later installation.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("R_ARCH_MISMATCH") {
            (
                "R_ARCH_MISMATCH",
                "probing_base_r",
                "This R architecture is not supported",
                "Rho for Apple Silicon requires an arm64 R 4.4 or later installation.".to_string(),
                startup_recovery_actions(),
            )
        } else if detail.contains("Rscript was not found")
            || detail.contains("Rscript.exe was not found")
        {
            (
                "R_NOT_FOUND",
                "locating_r",
                "R was not found",
                format!(
                    "Rho requires R 4.4 or later. Install R or choose {} manually.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("requires R 4.4") {
            (
                "R_VERSION_UNSUPPORTED",
                "probing_base_r",
                "This R version is not supported",
                "Choose an R 4.4 or later installation, then retry.".to_string(),
                startup_recovery_actions(),
            )
        } else if detail.contains("timed_out=true") {
            (
                "R_PROBE_TIMED_OUT",
                "probing_base_r",
                "R took too long to start",
                format!(
                    "Retry the runtime check or choose another {}.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("R runtime probe failed") {
            (
                "R_PROBE_EXITED",
                "probing_base_r",
                "R could not complete its runtime check",
                format!(
                    "Your R installation was not changed. Retry or choose another {}.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        } else if detail.contains("absent from runtime probe") {
            (
                "R_PROBE_OUTPUT_INVALID",
                "probing_base_r",
                "R returned an incomplete runtime result",
                "Retry the runtime check and copy diagnostics if it continues.".to_string(),
                startup_recovery_actions(),
            )
        } else {
            (
                "R_PROBE_SPAWN_FAILED",
                "probing_base_r",
                "Rho could not prepare the R runtime",
                format!(
                    "Retry the check or choose {} manually.",
                    platform::rscript_display_name()
                ),
                startup_recovery_actions(),
            )
        };
    startup_issue(
        code,
        phase,
        StartupSeverity::Recoverable,
        title,
        &message,
        detail.to_string(),
        actions,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        AgentModelTestControl, AgentRuntimeStatus, AppState, ExecuteRequest, ExecuteSourceRange,
        RUNTIME_CACHE_VERSION, RUserStartupFiles, RenderJobState, RuntimeCacheFile, RuntimeConfig,
        StartupView, SwitchTestControl, SwitchTestStep, ark_candidate_paths,
        attach_render_artifact, bounded_diagnostic, classify_startup_error, configure_user_startup,
        contain_audit_panic, data_view_artifact_metadata, data_view_delimited_text,
        decode_plot_png_base64, durable_project_root, editor_format_result,
        ensure_artifact_export_target, ensure_supported_r_architecture, ensure_supported_r_version,
        existing_startup_file, find_executable_on_path, finish_render_job, has_png_signature,
        load_runtime_cache, locate_ark_from_candidates, locate_rscript,
        lockfile_inventory_arguments, parse_r_runtime_probe, project_switch_blocker,
        r_architecture_supported, reconcile_render_job, render_job_is_terminal,
        retry_run_arguments, run_is_retryable, runtime_file_signature, safe_delete_project_file,
        save_runtime_cache, source_claim_snapshot, switch_project_with_watcher_factory,
        validate_execute_source_range_shape, workspace_project_root_code, write_r_probe_script,
    };
    use crate::platform;

    use crate::project::{
        ProjectSessionSnapshot, ProjectSessionStore, ProjectSwitchBlockerKind,
        ProjectWatcherControl,
    };
    use rho_server::coordinator::PendingApprovalRegistry;
    use rho_store::{
        AgentTurnDraft, ApprovalRequestDraft, ArtifactRecordSummary,
        EnvironmentOperationRequestDraft, PlotArtifactDraft, RunDraft, Store,
        normalize_project_root,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use tempfile::TempDir;
    use tokio::sync::{Mutex, RwLock};

    fn execute_request(code: &str, source_range: Option<ExecuteSourceRange>) -> ExecuteRequest {
        ExecuteRequest {
            code: code.to_string(),
            source_path: Some("analysis.R".to_string()),
            execution_mode: Some("selection".to_string()),
            document_version: Some(1),
            source_range,
        }
    }

    #[test]
    fn execute_source_range_matches_submitted_utf16_code_shape() {
        let request = execute_request(
            "value <- '😀'\nstop('错误')",
            Some(ExecuteSourceRange {
                start_line: 8,
                start_column: 4,
                end_line: 9,
                end_column: 11,
            }),
        );
        assert!(validate_execute_source_range_shape(&request).is_ok());

        let single_line = execute_request(
            "stop('错误')",
            Some(ExecuteSourceRange {
                start_line: 2,
                start_column: 7,
                end_line: 2,
                end_column: 17,
            }),
        );
        assert!(validate_execute_source_range_shape(&single_line).is_ok());
        assert!(validate_execute_source_range_shape(&execute_request("summary(qc)", None)).is_ok());
    }

    #[test]
    fn execute_source_range_rejects_partial_virtual_inverted_and_mismatched_input() {
        assert!(
            serde_json::from_value::<ExecuteRequest>(json!({
                "code": "summary(qc)",
                "source_path": "analysis.R",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1}
            }))
            .is_err()
        );
        let invalid = [
            execute_request(
                "summary(qc)",
                Some(ExecuteSourceRange {
                    start_line: 1,
                    start_column: 0,
                    end_line: 1,
                    end_column: 12,
                }),
            ),
            execute_request(
                "summary(qc)",
                Some(ExecuteSourceRange {
                    start_line: 2,
                    start_column: 5,
                    end_line: 2,
                    end_column: 5,
                }),
            ),
            execute_request(
                "summary(qc)",
                Some(ExecuteSourceRange {
                    start_line: 2,
                    start_column: 1,
                    end_line: 2,
                    end_column: 11,
                }),
            ),
        ];
        for request in invalid {
            assert!(validate_execute_source_range_shape(&request).is_err());
        }
        let mut virtual_request = execute_request(
            "summary(qc)",
            Some(ExecuteSourceRange {
                start_line: 2,
                start_column: 1,
                end_line: 2,
                end_column: 12,
            }),
        );
        virtual_request.source_path = Some("<console>".to_string());
        assert!(validate_execute_source_range_shape(&virtual_request).is_err());
    }

    fn test_runtime_cache(directory: &Path) -> RuntimeCacheFile {
        let rscript = directory.join("Rscript.exe");
        let ark = directory.join("ark.exe");
        std::fs::write(&rscript, b"rscript").unwrap();
        std::fs::write(&ark, b"ark").unwrap();
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        RuntimeCacheFile {
            version: RUNTIME_CACHE_VERSION,
            rscript: runtime_file_signature(&rscript).unwrap(),
            ark: runtime_file_signature(&ark).unwrap(),
            r_profile_user: home
                .as_ref()
                .map(|path| path.join(".Rprofile"))
                .filter(|path| path.is_file())
                .map(|path| runtime_file_signature(&path).unwrap()),
            r_environ_user: home
                .as_ref()
                .map(|path| path.join(".Renviron"))
                .filter(|path| path.is_file())
                .map(|path| runtime_file_signature(&path).unwrap()),
            r_home: "C:/R".to_string(),
            r_bin: "C:/R/bin/x64".to_string(),
            r_arch: "x86_64".to_string(),
            path_sep: ";".to_string(),
            r_version: "R version 4.4.2".to_string(),
            r_libs: "C:/R/library".to_string(),
            agent_runtime: AgentRuntimeStatus {
                available: false,
                aisdk_version: None,
                error: None,
            },
        }
    }

    #[test]
    fn runtime_cache_accepts_matching_inputs_and_rejects_changes() {
        let directory = TempDir::new().unwrap();
        let cache = test_runtime_cache(directory.path());
        save_runtime_cache(directory.path(), &cache).unwrap();
        let rscript = directory.path().join("Rscript.exe");
        let ark = directory.path().join("ark.exe");
        assert!(load_runtime_cache(directory.path(), &rscript, &ark).is_some());

        std::fs::write(&rscript, b"changed").unwrap();
        assert!(load_runtime_cache(directory.path(), &rscript, &ark).is_none());
    }

    #[test]
    fn malformed_runtime_cache_falls_back_without_error() {
        let directory = TempDir::new().unwrap();
        let cache_path = directory.path().join("runtime").join("runtime-cache.json");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, b"not-json").unwrap();
        let rscript = directory.path().join("Rscript.exe");
        let ark = directory.path().join("ark.exe");
        std::fs::write(&rscript, b"rscript").unwrap();
        std::fs::write(&ark, b"ark").unwrap();
        assert!(load_runtime_cache(directory.path(), &rscript, &ark).is_none());
    }

    #[test]
    fn audit_command_boundary_contains_panics() {
        assert_eq!(contain_audit_panic(|| 42).unwrap(), 42);
        let error = contain_audit_panic(|| -> usize { panic!("audit fixture panic") }).unwrap_err();
        assert_eq!(
            error,
            "The project reproducibility check failed unexpectedly. Try the check again."
        );
    }

    #[test]
    fn editor_format_command_returns_the_typed_workspace_result() {
        let result = editor_format_result(json!({
            "execution_id": "run_1",
            "execution": {
                "kind": "rho.editor_format_result.v1",
                "ok": true,
                "status": "formatted",
                "path": "analysis.R",
                "document_version": 7
            },
            "workspace": {"workspace_id": "workspace_1"}
        }))
        .unwrap();

        assert_eq!(result["kind"], "rho.editor_format_result.v1");
        assert_eq!(result["status"], "formatted");
        assert_eq!(result["path"], "analysis.R");
        assert_eq!(result["document_version"], 7);
        assert!(result.get("execution").is_none());
    }

    #[test]
    fn editor_format_command_rejects_missing_or_untyped_workspace_results() {
        assert!(editor_format_result(json!({"workspace": {}})).is_err());
        assert!(
            editor_format_result(json!({
                "execution": {"kind": "rho.other_result.v1", "ok": true}
            }))
            .is_err()
        );
    }

    #[test]
    fn retries_only_scientific_workspace_execution() {
        assert!(run_is_retryable("workspace.execute", "user"));
        assert!(run_is_retryable("workspace.execute", "agent"));
        assert!(!run_is_retryable("environment.restore", "user"));
        assert!(!run_is_retryable("workspace.set_project_root", "system"));
        assert!(!run_is_retryable("workspace.bootstrap", "system"));
    }

    #[test]
    fn retry_preserves_the_admitted_source_range_and_replaces_only_parent_identity() {
        let original = json!({
            "code": "stop('boom')",
            "source_path": "analysis.R",
            "execution_mode": "selection",
            "document_version": 7,
            "parent_run_id": "older_parent",
            "source_range": {
                "start_line": 8,
                "start_column": 4,
                "end_line": 8,
                "end_column": 16
            }
        });
        let retried = retry_run_arguments(&original.to_string(), "failed_run").unwrap();

        assert_eq!(retried["source_range"], original["source_range"]);
        assert_eq!(retried["code"], original["code"]);
        assert_eq!(retried["source_path"], original["source_path"]);
        assert_eq!(retried["document_version"], original["document_version"]);
        assert_eq!(retried["parent_run_id"], "failed_run");
        assert!(retry_run_arguments("[]", "failed_run").is_err());
    }

    #[test]
    fn source_claim_snapshot_is_bounded_and_content_bound() {
        let directory = TempDir::new().unwrap();
        let project_path = directory.path().join("project");
        std::fs::create_dir_all(project_path.join("reports")).unwrap();
        let project = project_path.canonicalize().unwrap();
        std::fs::write(project.join("reports/demo.qmd"), "one\ntwo\nthree\n").unwrap();

        let (digest, excerpt) = source_claim_snapshot(&project, "reports/demo.qmd", 2, 3).unwrap();
        assert_eq!(digest.len(), 64);
        assert_eq!(excerpt, "two\nthree");
        assert!(source_claim_snapshot(&project, "../outside.qmd", 1, 1).is_err());
        assert!(source_claim_snapshot(&project, "reports/demo.qmd", 0, 1).is_err());
        assert!(source_claim_snapshot(&project, "reports/demo.qmd", 1, 201).is_err());

        std::fs::write(
            project.join("reports/demo.qmd"),
            "one\ntwo changed\nthree\n",
        )
        .unwrap();
        let changed = source_claim_snapshot(&project, "reports/demo.qmd", 2, 3).unwrap();
        assert_ne!(changed.0, digest);
        assert_ne!(changed.1, excerpt);
    }

    #[test]
    fn lockfile_inventory_arguments_normalize_root_and_clamp_limit() {
        let root = Path::new("C:\\projects\\rho-lockfile");
        let low = lockfile_inventory_arguments(root, Some(0));
        let high = lockfile_inventory_arguments(root, Some(900));

        assert_eq!(low["project_root"], "C:/projects/rho-lockfile");
        assert_eq!(low["limit"], 1);
        assert_eq!(high["limit"], 500);
    }

    #[test]
    fn workspace_project_root_code_uses_user_readable_windows_paths() {
        assert_eq!(
            workspace_project_root_code(Path::new(r"\\?\E:\YuNotebooks\project")).unwrap(),
            r#"setwd("E:/YuNotebooks/project")"#
        );
        assert_eq!(
            workspace_project_root_code(Path::new(r"\\?\UNC\server\share\project")).unwrap(),
            r#"setwd("//server/share/project")"#
        );
        assert_eq!(
            workspace_project_root_code(Path::new(r"E:\路径 含 空格\project")).unwrap(),
            r#"setwd("E:/路径 含 空格/project")"#
        );
    }

    #[test]
    fn durable_project_root_matches_store_identity_on_windows() {
        assert_eq!(
            durable_project_root(Path::new(r"E:\YuNotebooks\project\")),
            "E:/YuNotebooks/project"
        );
        assert_eq!(
            durable_project_root(Path::new(r"\\?\E:\YuNotebooks\project\")),
            "//?/E:/YuNotebooks/project"
        );
        assert_eq!(
            durable_project_root(Path::new(r"\\?\UNC\server\share\project\")),
            "//?/UNC/server/share/project"
        );
    }

    #[test]
    fn plot_queries_share_the_normalized_windows_project_key() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let raw_root = Path::new(r"\\?\E:\Rho\project\");
        let project_root = durable_project_root(raw_root);
        let workspace_id = "desktop_plot_session";
        store.set_project_root(Some(&project_root)).unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_windows_root".to_string(),
                run_id: "run_windows_root".to_string(),
                project_root: Some(project_root.clone()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some(workspace_id.to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: "{\"image/png\":\"aGVsbG8=\"}".to_string(),
                provenance_complete: true,
            })
            .unwrap();
        let other_project_root = "//?/E:/Rho/other-project";
        let other_payload = "{\"image/png\":\"b3RoZXI=\"}";
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_other_project".to_string(),
                run_id: "run_other_project".to_string(),
                project_root: Some(other_project_root.to_string()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some(workspace_id.to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: other_payload.to_string(),
                provenance_complete: true,
            })
            .unwrap();

        assert!(
            store
                .list_plot_artifacts(
                    Some(10),
                    Some(raw_root.to_string_lossy().as_ref()),
                    Some(workspace_id),
                    true,
                )
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_plot_artifacts(Some(10), Some(&project_root), Some(workspace_id), true,)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .project_retention_summary(&project_root, Some(workspace_id))
                .unwrap()
                .session
                .plot_history_count,
            1
        );
        assert_eq!(
            store
                .prune_plot_artifact_payloads(Some(&project_root), Some(workspace_id), true,)
                .unwrap()
                .pruned_count,
            1
        );
        assert_eq!(
            store
                .clear_plot_artifacts(Some(&project_root), Some(workspace_id), true,)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .list_plot_artifacts(Some(10), Some(other_project_root), Some(workspace_id), true,)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .get_plot_artifact(other_project_root, "plot_other_project")
                .unwrap()
                .unwrap()
                .payload_json,
            other_payload
        );
    }

    fn test_runtime_config(store_path: &Path, data_dir: &Path) -> RuntimeConfig {
        RuntimeConfig {
            data_dir: data_dir.to_path_buf(),
            kernelspec: data_dir.join("kernel.json"),
            rscript: Path::new("Rscript").to_path_buf(),
            r_version: "R version 4.6.1".to_string(),
            r_home: "C:/R".to_string(),
            process_path: std::env::var_os("PATH").unwrap_or_default(),
            r_profile_user: None,
            r_environ_user: None,
            bridge_package: data_dir.join("rho.bridge"),
            agent_package: data_dir.join("rho.agent"),
            agent_runtime: AgentRuntimeStatus {
                available: true,
                aisdk_version: Some("1.0.0".to_string()),
                error: None,
            },
            store_path: store_path.to_path_buf(),
        }
    }

    fn test_app_state(data_dir: &Path, project_root: &Path, store_path: &Path) -> AppState {
        AppState {
            data_dir: data_dir.to_path_buf(),
            ark: data_dir.join("ark.exe"),
            config: std::sync::RwLock::new(Some(test_runtime_config(store_path, data_dir))),
            selected_rscript: std::sync::RwLock::new(None),
            startup: std::sync::RwLock::new(StartupView {
                phase: "shell_ready".to_string(),
                busy: false,
                runtime: None,
                issue: None,
            }),
            project_store: ProjectSessionStore::new(data_dir.to_path_buf()).unwrap(),
            project_root: RwLock::new(project_root.to_path_buf()),
            project_watcher: Mutex::new(None),
            session: RwLock::new(None),
            context: Mutex::new(None),
            approvals: Arc::new(PendingApprovalRegistry::default()),
            environment_approvals: Arc::new(PendingApprovalRegistry::default()),
            agent_tasks: Arc::new(Mutex::new(HashMap::new())),
            agent_llm_test_control: AgentModelTestControl::default(),
            switch_test_control: SwitchTestControl::default(),
            shutdown_started: AtomicBool::new(false),
            render_jobs: Arc::new(Mutex::new(HashMap::new())),
            render_tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn create_waiting_approval(
        store: &mut Store,
        project_root: &str,
        turn_id: &str,
        request_id: &str,
    ) {
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.to_string(),
                project_root: project_root.to_string(),
                mode: "ask".to_string(),
                prompt: "Need approval".to_string(),
                model: "test-model".to_string(),
                workspace_id: "ws-1".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
            })
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: request_id.to_string(),
                turn_id: turn_id.to_string(),
                project_root: project_root.to_string(),
                tool: "write_file".to_string(),
                policy: "ask".to_string(),
                arguments_json: "{}".to_string(),
                code: None,
                workspace_id: "ws-1".to_string(),
                state_revision: 1,
                project_revision: 1,
            })
            .unwrap();
    }

    fn save_session_fixture(
        state: &AppState,
        root: &Path,
        active_document: &str,
        left_panel: u32,
    ) -> ProjectSessionSnapshot {
        let snapshot = ProjectSessionSnapshot {
            open_documents: vec![],
            closed_documents: vec![],
            active_document: Some(active_document.to_string()),
            panels: crate::project::PanelSizes {
                left: Some(left_panel),
                right: Some(300),
                dock: Some(240),
            },
        };
        state.project_store.save_session(root, &snapshot).unwrap();
        snapshot
    }

    #[test]
    fn project_switch_preflight_blocks_active_run() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            store
                .create_run(&RunDraft {
                    run_id: "run-active".to_string(),
                    parent_run_id: None,
                    project_root: normalized_root.clone(),
                    origin: "user".to_string(),
                    request_type: "workspace.execute".to_string(),
                    operation_class: "scientific".to_string(),
                    code: "x <- 1".to_string(),
                    arguments_json: "{}".to_string(),
                    source_path: None,
                    execution_mode: Some("console".to_string()),
                    document_version: None,
                    workspace_id: "ws-1".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 1,
                    environment_snapshot_id: None,
                })
                .unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::ActiveRun);
            assert_eq!(blocker.run_id.as_deref(), Some("run-active"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_only_current_project_render_jobs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            state.render_jobs.lock().await.insert(
                "render_foreign".to_string(),
                render_job_fixture("render_foreign", "D:/other-project", "submitted"),
            );
            assert!(project_switch_blocker(&state).await.unwrap().is_none());

            state.render_jobs.lock().await.insert(
                "render_current".to_string(),
                render_job_fixture("render_current", &normalized_root, "submitted"),
            );
            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::ActiveRun);
            assert_eq!(blocker.run_id.as_deref(), Some("render_current"));
            assert_eq!(blocker.operation_status.as_deref(), Some("submitted"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_active_agent_turn() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let handle = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            state
                .agent_tasks
                .lock()
                .await
                .insert("turn-running".to_string(), handle);

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentTurn);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-running"));

            if let Some(handle) = state.agent_tasks.lock().await.remove("turn-running") {
                handle.abort();
            }
        });
    }

    #[test]
    fn project_switch_preflight_blocks_waiting_approval() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            create_waiting_approval(
                &mut store,
                &normalized_root,
                "turn-approval",
                "req-approval",
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let _receiver = state.approvals.register("req-approval".to_string()).await;

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::Approval);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-approval"));
            assert_eq!(blocker.request_id.as_deref(), Some("req-approval"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_environment_operation() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            store
                .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                    request_id: "env-req-1".to_string(),
                    turn_id: None,
                    source: "direct".to_string(),
                    request_name: "renv::restore".to_string(),
                    project_root: normalized_root.clone(),
                    arguments_json: "{}".to_string(),
                    preview_json: "{}".to_string(),
                    preview_sha256: "sha".to_string(),
                    workspace_id: "ws-1".to_string(),
                    state_revision: 1,
                    project_revision: 1,
                    before_snapshot_id: None,
                })
                .unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let _receiver = state
                .environment_approvals
                .register("env-req-1".to_string())
                .await;

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::EnvironmentOperation);
            assert_eq!(blocker.request_id.as_deref(), Some("env-req-1"));
            assert_eq!(blocker.operation_status.as_deref(), Some("requested"));
        });
    }

    #[test]
    fn project_switch_preflight_allows_clean_project() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            assert!(project_switch_blocker(&state).await.unwrap().is_none());
        });
    }

    #[test]
    fn project_switch_commits_only_after_full_chain_success() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            save_session_fixture(&state, &project_a, "old.R", 210);
            let target_session = save_session_fixture(&state, &project_b, "new.R", 260);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);

            let response = switch_project_with_watcher_factory(
                project_b.clone(),
                Some(target_session.clone()),
                &state,
                |_| Ok(ProjectWatcherControl::noop()),
            )
            .await
            .unwrap();

            assert_eq!(response.status, "ready");
            assert_eq!(response.session.active_document.as_deref(), Some("new.R"));
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_b.to_string_lossy().replace('\\', "/")
            );
            let active_root = Store::open(&store_path)
                .unwrap()
                .active_project_root()
                .unwrap()
                .unwrap();
            assert_eq!(active_root, root_b);
            let last_opened = state
                .project_store
                .last_opened_project()
                .unwrap()
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            assert_eq!(last_opened, project_b.to_string_lossy().replace('\\', "/"));
        });
    }

    #[test]
    fn project_switch_returns_failed_restored_and_preserves_previous_state() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let previous_session = save_session_fixture(&state, &project_a, "old.R", 210);
            save_session_fixture(&state, &project_b, "new.R", 260);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            state.switch_test_control.fail(
                SwitchTestStep::SetActiveProjectRoot,
                "inject store root failure",
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::RestoreWorkspace);

            let response =
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();

            let restored_root = project_a.to_string_lossy().replace('\\', "/");
            assert_eq!(response.status, "failed_restored");
            assert_eq!(
                response.reason_code.as_deref(),
                Some("project_switch_store_root_failed")
            );
            assert_eq!(
                response.restored_root.as_deref(),
                Some(restored_root.as_str())
            );
            assert_eq!(
                response.session.active_document,
                previous_session.active_document
            );
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
            let active_root = Store::open(&store_path)
                .unwrap()
                .active_project_root()
                .unwrap()
                .unwrap();
            assert_eq!(active_root, root_a);
        });
    }

    #[test]
    fn project_switch_returns_fatal_when_restore_path_fails() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let previous_session = save_session_fixture(&state, &project_a, "old.R", 210);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            state.switch_test_control.fail(
                SwitchTestStep::SetActiveProjectRoot,
                "inject store root failure",
            );
            state
                .switch_test_control
                .fail(SwitchTestStep::RestoreWorkspace, "inject restore failure");

            let response =
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();

            assert_eq!(response.status, "fatal");
            assert!(response.restart_required);
            assert_eq!(
                response.reason_code.as_deref(),
                Some("project_switch_restore_failed")
            );
            assert_eq!(
                response.session.active_document,
                previous_session.active_document
            );
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
        });
    }

    #[test]
    fn enforces_the_documented_minimum_r_version() {
        assert!(ensure_supported_r_version("4.3.3").is_err());
        assert!(ensure_supported_r_version("4.4.0").is_ok());
        assert!(ensure_supported_r_version("5.0.0").is_ok());
        assert!(ensure_supported_r_version("invalid").is_err());
    }

    #[test]
    fn requires_arm64_r_only_for_apple_silicon_macos() {
        assert!(r_architecture_supported("macos", "aarch64", "aarch64"));
        assert!(r_architecture_supported("macos", "aarch64", "arm64"));
        assert!(!r_architecture_supported("macos", "aarch64", "x86_64"));
        assert!(r_architecture_supported("windows", "x86_64", "x86_64"));

        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert!(ensure_supported_r_architecture("aarch64").is_ok());
            assert!(ensure_supported_r_architecture("x86_64").is_err());
        }
    }

    #[test]
    fn executable_path_search_preserves_spaces_and_unicode() {
        let directory = TempDir::new().unwrap();
        let first = directory.path().join("missing path");
        let second = directory.path().join("R 工具");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let executable = if cfg!(windows) {
            "Rscript.exe"
        } else {
            "Rscript"
        };
        let expected = second.join(executable);
        std::fs::write(&expected, b"fixture").unwrap();
        let search_path = std::env::join_paths([first, second]).unwrap();

        assert_eq!(
            find_executable_on_path(executable, &search_path),
            Some(expected)
        );
    }

    #[test]
    fn invalid_persisted_r_selection_fails_without_falling_through() {
        let directory = TempDir::new().unwrap();
        let missing = directory.path().join("missing R/Rscript");
        let error = locate_rscript(Some(&missing)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("selected Rscript path does not point to a file")
        );
    }

    #[test]
    fn ark_lookup_prefers_installed_macos_sidecar_and_falls_back_to_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("Rho.app/Contents/Resources");
        let current_exe = directory.path().join("Rho.app/Contents/MacOS/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        let candidates = ark_candidate_paths(
            "macos",
            "aarch64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let installed = current_exe.parent().unwrap().join("ark");
        let development = manifest_dir.join("binaries/ark-aarch64-apple-darwin");
        assert_eq!(candidates, vec![installed.clone(), development.clone()]);

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&installed, b"installed").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), installed);
    }

    #[test]
    fn ark_lookup_retains_windows_resources_and_rejects_unknown_targets() {
        let root = Path::new("C:/rho");
        let windows = ark_candidate_paths(
            "windows",
            "x86_64",
            root,
            Path::new("C:/installed"),
            Path::new("C:/installed/rho-desktop.exe"),
        );
        assert_eq!(
            windows,
            vec![
                PathBuf::from("C:/installed/resources/runtime/ark.exe"),
                PathBuf::from("C:/rho/../resources/runtime/ark.exe")
            ]
        );
        assert!(ark_candidate_paths("macos", "x86_64", root, root, root).is_empty());
        assert!(locate_ark_from_candidates(Vec::new()).is_err());
    }

    #[test]
    fn writes_probe_code_to_a_utf8_r_script() {
        let expression = "cat('Rho UTF-8: 中文')\n";
        let script = write_r_probe_script(expression).unwrap();
        assert_eq!(
            script.path().extension().and_then(|value| value.to_str()),
            Some("R")
        );
        assert_eq!(std::fs::read_to_string(script.path()).unwrap(), expression);
    }

    #[test]
    fn parses_base_r_probe_without_requiring_user_startup_files() {
        let probe = parse_r_runtime_probe(
            "__RHO_HOME__C:/Program Files/R/R-4.4.2\n\
             __RHO_BIN__C:/Program Files/R/R-4.4.2/bin/x64\n\
             __RHO_ARCH__aarch64\n\
             __RHO_PATH_SEP__;\n\
             __RHO_VERSION__R version 4.4.2\n\
             __RHO_VERSION_NUMBER__4.4.2\n\
             __RHO_PROFILE_USER__C:/Users/test/Documents/.Rprofile\n\
             __RHO_ENVIRON_USER__C:/Users/test/Documents/.Renviron\n\
             __RHO_LIBS__C:/Users/test/R/win-library/4.4;C:/Program Files/R/R-4.4.2/library\n",
        )
        .unwrap();
        assert_eq!(probe.r_home, "C:/Program Files/R/R-4.4.2");
        assert!(probe.r_bin.ends_with("bin/x64"));
        assert_eq!(probe.r_arch, "aarch64");
        assert_eq!(probe.path_sep, ";");
        assert_eq!(probe.r_version, "R version 4.4.2");
        assert!(probe.r_libs.contains("win-library"));
        assert!(probe.r_profile_user.is_none());
        assert!(probe.r_environ_user.is_none());
    }

    #[test]
    fn rejects_x86_and_old_r_probe_results_before_runtime_generation() {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            let x86 = parse_r_runtime_probe(
                "__RHO_HOME__/Library/Frameworks/R.framework/Resources\n\
                 __RHO_BIN__/Library/Frameworks/R.framework/Resources/bin\n\
                 __RHO_ARCH__x86_64\n\
                 __RHO_PATH_SEP__:\n",
            )
            .unwrap_err();
            assert!(x86.to_string().contains("R_ARCH_MISMATCH"));
        }

        let old = parse_r_runtime_probe(
            "__RHO_HOME__/Library/Frameworks/R.framework/Resources\n\
             __RHO_BIN__/Library/Frameworks/R.framework/Resources/bin\n\
             __RHO_ARCH__aarch64\n\
             __RHO_PATH_SEP__:\n\
             __RHO_VERSION__R version 4.3.3\n\
             __RHO_VERSION_NUMBER__4.3.3\n",
        )
        .unwrap_err();
        assert!(old.to_string().contains("requires R 4.4"));
    }

    #[test]
    fn retains_only_user_startup_paths_that_are_files() {
        let directory = TempDir::new().unwrap();
        let profile = directory.path().join(".Rprofile");
        std::fs::write(&profile, "options(rho.test = TRUE)").unwrap();
        let environ = directory.path().join(".Renviron");
        let nested_directory = directory.path().join("not-a-file");
        std::fs::create_dir(&nested_directory).unwrap();

        assert_eq!(
            existing_startup_file(profile.to_string_lossy().into_owned()),
            Some(profile)
        );
        assert_eq!(
            existing_startup_file(environ.to_string_lossy().into_owned()),
            None
        );
        assert_eq!(
            existing_startup_file(nested_directory.to_string_lossy().into_owned()),
            None
        );
    }

    #[test]
    fn disables_missing_user_startup_files_without_placeholder_environment_paths() {
        let mut command = Command::new("Rscript");
        let empty_site = configure_user_startup(
            &mut command,
            RUserStartupFiles {
                profile: None,
                environ: None,
            },
        )
        .unwrap();
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environment = command
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(empty_site.is_none());
        assert!(arguments.contains(&"--no-init-file".to_string()));
        assert!(arguments.contains(&"--no-environ".to_string()));
        assert!(!environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(!environment.contains(&"R_ENVIRON_USER".to_string()));
    }

    #[test]
    fn binds_each_existing_user_startup_file_independently() {
        let mut profile_only = Command::new("Rscript");
        configure_user_startup(
            &mut profile_only,
            RUserStartupFiles {
                profile: Some(Path::new("C:/Users/test/.Rprofile")),
                environ: None,
            },
        )
        .unwrap();
        let profile_arguments = profile_only
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let profile_environment = profile_only
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!profile_arguments.contains(&"--no-init-file".to_string()));
        assert!(profile_arguments.contains(&"--no-environ".to_string()));
        assert!(profile_environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(!profile_environment.contains(&"R_ENVIRON_USER".to_string()));

        let mut environ_only = Command::new("Rscript");
        let empty_site = configure_user_startup(
            &mut environ_only,
            RUserStartupFiles {
                profile: None,
                environ: Some(Path::new("C:/Users/test/.Renviron")),
            },
        )
        .unwrap();
        let environ_arguments = environ_only
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environ_environment = environ_only
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(empty_site.is_some());
        assert!(environ_arguments.contains(&"--no-init-file".to_string()));
        assert!(!environ_arguments.contains(&"--no-environ".to_string()));
        assert!(!environ_environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(environ_environment.contains(&"R_ENVIRON_USER".to_string()));
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
    fn classifies_macos_architecture_mismatch_with_stable_recovery_code() {
        let issue = classify_startup_error(
            "R_ARCH_MISMATCH: Rho for Apple Silicon requires arm64 R; found `x86_64`",
        );
        assert_eq!(issue.code, "R_ARCH_MISMATCH");
        assert_eq!(issue.phase, "probing_base_r");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn startup_recovery_copy_uses_the_platform_rscript_name() {
        for detail in [
            "selected Rscript path does not point to a file",
            "Rscript was not found",
            "R runtime probe failed (exit_code=Some(1), timed_out=false): stdout= stderr=",
            "unclassified runtime failure",
        ] {
            let issue = classify_startup_error(detail);
            assert!(issue.message.contains(platform::rscript_display_name()));
            if !cfg!(windows) {
                assert!(!issue.message.contains("Rscript.exe"));
            }
        }
    }

    #[test]
    fn classifies_missing_ark_as_repairable_installation_failure() {
        let issue = classify_startup_error("bundled Ark executable was not found");
        assert_eq!(issue.code, "ARK_RESOURCE_MISSING");
        assert_eq!(issue.phase, "checking_installation");
        assert!(issue.actions.contains(&"retry".to_string()));
    }

    #[test]
    fn classifies_missing_r_as_recoverable_discovery_failure() {
        let issue = classify_startup_error("Rscript was not found");
        assert_eq!(issue.code, "R_NOT_FOUND");
        assert_eq!(issue.phase, "locating_r");
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
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &link);
        if let Err(error) = symlink_result {
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

    #[test]
    fn ensure_artifact_export_target_rejects_parent_escape_and_collisions() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let existing = root.join("plots").join("qc.png");
        std::fs::create_dir_all(existing.parent().unwrap()).unwrap();
        std::fs::write(&existing, [137_u8, 80, 78, 71, 13, 10, 26, 10]).unwrap();

        let escape = ensure_artifact_export_target(&root, "../outside.png", &["png"]).unwrap_err();
        assert!(escape.to_string().contains("parent, root or drive prefix"));

        let collision = ensure_artifact_export_target(&root, "plots/qc.png", &["png"]).unwrap_err();
        assert!(collision.to_string().contains("already exists"));
    }

    #[test]
    fn data_view_delimited_text_writes_exact_utf8_csv_with_crlf_and_quotes() {
        let page = json!({
            "columns": [
                { "name": "sample", "label": "sample" },
                { "name": "note", "label": "note" }
            ],
            "rows": [
                { "row_name": "row,1", "cells": ["plain", "line\r\nbreak"] },
                { "row_name": "第二行", "cells": [null, "He said \"hi\""] }
            ]
        });
        let output = data_view_delimited_text(&page, ',').unwrap();
        let expected = concat!(
            "row_name,sample,note\r\n",
            "\"row,1\",plain,\"line\r\nbreak\"\r\n",
            "第二行,,\"He said \"\"hi\"\"\"\r\n"
        );
        assert_eq!(output, expected);
        assert_eq!(output.as_bytes()[output.len() - 2..], [b'\r', b'\n']);
    }

    #[test]
    fn data_view_delimited_text_writes_exact_utf8_tsv_with_missing_values() {
        let page = json!({
            "columns": [
                { "name": "detected", "label": "detected" },
                { "name": "group", "label": "group\tlabel" }
            ],
            "rows": [
                { "row_name": "cell_1", "cells": ["A", "组1"] },
                { "row_name": "cell_2", "cells": [null, ""] }
            ]
        });
        let output = data_view_delimited_text(&page, '\t').unwrap();
        let expected = concat!(
            "row_name\tdetected\t\"group\tlabel\"\r\n",
            "cell_1\tA\t组1\r\n",
            "cell_2\t\t\r\n"
        );
        assert_eq!(output, expected);
        assert!(String::from_utf8(output.into_bytes()).is_ok());
    }

    #[test]
    fn data_view_delimited_text_preserves_empty_missing_and_non_finite_values() {
        let page = json!({
            "columns": [
                { "name": "empty" },
                { "name": "missing" },
                { "name": "nan" },
                { "name": "positive" },
                { "name": "negative" }
            ],
            "rows": [{
                "row_name": "sample_1",
                "cells": ["", null, "NaN", "Inf", "-Inf"],
                "cell_states": ["empty", "na", "nan", "pos_inf", "neg_inf"]
            }]
        });

        let output = data_view_delimited_text(&page, ',').unwrap();

        assert_eq!(
            output,
            "row_name,empty,missing,nan,positive,negative\r\nsample_1,,,NaN,Inf,-Inf\r\n"
        );
    }

    #[test]
    fn data_view_artifact_metadata_replays_normalized_query_sort_and_window() {
        let page = json!({
            "row_offset": 25,
            "rows": [{"row_name": "cell_35", "cells": ["S35"]}],
            "column_offset": 1,
            "columns": [{"index": 1, "name": "reads", "label": "reads"}],
            "query": "S",
            "sort_column": 1,
            "sort_direction": "desc"
        });

        let metadata = data_view_artifact_metadata(&page, "qc", "table", "table", "csv");

        assert_eq!(metadata["object_name"], "qc");
        assert_eq!(metadata["row_offset"], 25);
        assert_eq!(metadata["row_count"], 1);
        assert_eq!(metadata["column_offset"], 1);
        assert_eq!(metadata["column_count"], 1);
        assert_eq!(metadata["query"], "S");
        assert_eq!(metadata["sort_column"], 1);
        assert_eq!(metadata["sort_direction"], "desc");
        assert_eq!(metadata["format"], "csv");
    }

    #[test]
    fn validates_png_signature() {
        assert!(has_png_signature(&[137, 80, 78, 71, 13, 10, 26, 10, 0, 1]));
        assert!(!has_png_signature(b"not-a-png"));
    }

    #[test]
    fn decodes_padded_and_unpadded_plot_png_payloads() {
        assert_eq!(
            decode_plot_png_base64("iVBORw0KGgo=").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(
            decode_plot_png_base64("iVBORw0KGgo").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert!(decode_plot_png_base64("A").is_err());
        assert!(decode_plot_png_base64("not=base64").is_err());
    }

    fn render_job_fixture(job_id: &str, project_root: &str, status: &str) -> RenderJobState {
        RenderJobState {
            job_id: job_id.to_string(),
            project_root: project_root.to_string(),
            path: "report.Rmd".to_string(),
            document_version: Some(3),
            status: status.to_string(),
            artifact_id: None,
            output_path: None,
            tool: None,
            media_type: None,
            provenance_complete: None,
            message: None,
            terminal_reason: None,
            submitted_at: "2026-08-03T00:00:00Z".to_string(),
            completed_at: None,
        }
    }

    #[test]
    fn render_job_terminal_transitions_are_monotonic() {
        let mut job = render_job_fixture("render_1", "D:/project", "running");
        finish_render_job(&mut job, "completed", None, Some("completed"));
        assert!(render_job_is_terminal(&job.status));
        finish_render_job(
            &mut job,
            "interrupted",
            Some("late cancellation".to_string()),
            Some("user_interrupt"),
        );
        assert_eq!(job.status, "completed");
        assert_eq!(job.terminal_reason.as_deref(), Some("completed"));
        assert!(job.message.is_none());
    }

    #[test]
    fn render_job_restart_reconciliation_distinguishes_run_truth() {
        let mut before_start = render_job_fixture("render_1", "D:/project", "cancel_requested");
        reconcile_render_job(&mut before_start, None, None, None);
        assert_eq!(before_start.status, "interrupted");
        assert_eq!(
            before_start.terminal_reason.as_deref(),
            Some("workspace_restart_before_start")
        );

        let mut completed = render_job_fixture("render_2", "D:/project", "cancel_requested");
        reconcile_render_job(&mut completed, Some("completed"), None, Some("completed"));
        assert_eq!(completed.status, "completed");

        let mut failed = render_job_fixture("render_3", "D:/project", "cancel_requested");
        reconcile_render_job(
            &mut failed,
            Some("failed"),
            Some("render error".to_string()),
            Some("r_error"),
        );
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.message.as_deref(), Some("render error"));

        let mut interrupted = render_job_fixture("render_4", "D:/project", "cancel_requested");
        reconcile_render_job(
            &mut interrupted,
            Some("interrupted"),
            None,
            Some("cancelled_during_restart"),
        );
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(
            interrupted.terminal_reason.as_deref(),
            Some("cancelled_during_restart")
        );
    }

    #[test]
    fn render_job_serialization_keeps_project_and_document_identity() {
        let job = render_job_fixture("render_1", "D:/project-a", "submitted");
        let value = serde_json::to_value(job).unwrap();
        assert_eq!(value["job_id"], "render_1");
        assert_eq!(value["project_root"], "D:/project-a");
        assert_eq!(value["path"], "report.Rmd");
        assert_eq!(value["document_version"], 3);
        assert_eq!(value["status"], "submitted");
        assert!(value["artifact_id"].is_null());
    }

    #[test]
    fn render_job_attaches_only_the_exact_artifact_projection() {
        let mut job = render_job_fixture("render_1", "D:/project-a", "running");
        let artifact = ArtifactRecordSummary {
            artifact_id: "artifact_render_1_render".to_string(),
            artifact_kind: "render_output".to_string(),
            run_id: Some("render_1".to_string()),
            project_root: "D:/project-a".to_string(),
            output_path: "report.html".to_string(),
            source_path: Some("report.Rmd".to_string()),
            execution_mode: Some("render".to_string()),
            document_version: Some(3),
            workspace_id: Some("ws-1".to_string()),
            state_revision: Some(2),
            project_revision: Some(4),
            media_type: "text/html".to_string(),
            metadata_json: "{}".to_string(),
            provenance_complete: true,
            incomplete_reason: None,
            created_at: "2026-08-03T00:00:00Z".to_string(),
        };

        attach_render_artifact(&mut job, &artifact);

        assert_eq!(job.artifact_id.as_deref(), Some("artifact_render_1_render"));
        assert_eq!(job.output_path.as_deref(), Some("report.html"));
        assert_eq!(job.media_type.as_deref(), Some("text/html"));
        assert_eq!(job.provenance_complete, Some(true));
    }
}

async fn smoke_test(include_agent: bool) -> Result<Value> {
    let smoke_root = std::env::temp_dir().join(format!("rho-desktop-smoke-{}", Uuid::new_v4()));
    let data_dir = smoke_root.join("data");
    let project_a_root = smoke_root.join("project-a");
    let project_b_root = smoke_root.join("project-b");
    std::fs::create_dir_all(&project_a_root)?;
    std::fs::create_dir_all(&project_b_root)?;
    let ark = development_ark_path()?;
    let config = prepare_runtime_files(data_dir, ark)?;
    git::set_process_path(config.process_path.clone());
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
    let mut store = Store::open(&config.store_path)?;
    let mut broker = BrokerState::new("desktop_smoke");
    store.set_project_root(Some(project_a_root.to_string_lossy().as_ref()))?;
    store.save_identity(broker.identity())?;
    bootstrap_bridge(&session, &mut broker, &mut store, &config.bridge_package).await?;
    set_smoke_project_root(&session, &mut broker, &mut store, &project_a_root).await?;
    let mut interrupt_requested = false;
    session
        .execute_with_options(
            "Sys.sleep(30)",
            |event| {
                interrupt_requested |= matches!(event.event, KernelEvent::InterruptRequested);
                Ok(())
            },
            |prompt, _| bail!("unexpected smoke-test input request: {prompt}"),
            Some(Duration::from_millis(150)),
        )
        .await?;
    ensure!(
        interrupt_requested,
        "desktop smoke did not request an Ark interrupt"
    );
    session
        .execute("stopifnot(identical(1L + 1L, 2L))", |_| Ok(()))
        .await?;
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
    let viewer_identity = broker.identity().clone();
    let inspect_data_payload = json!({
        "arguments": {
            "object_name": "rho_desktop_smoke"
        },
        "expected_workspace": viewer_identity
    });
    let inspect_data = dispatch_workspace_request(
        "workspace.inspect_data_object",
        &inspect_data_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let view_token = inspect_data["execution"]["view_token"]
        .as_str()
        .context("desktop smoke viewer did not return view_token")?
        .to_string();
    let page_payload = json!({
        "arguments": {
            "object_name": "rho_desktop_smoke",
            "view_token": view_token,
            "view_kind": "table",
            "view_key": "table",
            "row_offset": 0,
            "row_limit": 5,
            "column_offset": 0,
            "column_limit": 2
        },
        "expected_workspace": viewer_identity
    });
    let page = dispatch_workspace_request(
        "workspace.read_data_view",
        &page_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let page_row_count = page["execution"]["page"]["rows"]
        .as_array()
        .map(|rows| rows.len())
        .unwrap_or_default();
    ensure!(
        page_row_count > 0,
        "desktop smoke data viewer returned no rows"
    );
    let mutate_payload = json!({
        "arguments": {
            "code": "rho_desktop_smoke$z <- rho_desktop_smoke$x + rho_desktop_smoke$y"
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.execute",
        &mutate_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let stale_page = dispatch_workspace_request(
        "workspace.read_data_view",
        &page_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &mut store,
    )
    .await;
    ensure!(
        stale_page.is_err(),
        "desktop smoke stale data viewer request unexpectedly succeeded"
    );
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
    let project_a = normalize_project_root(project_a_root.to_string_lossy().as_ref());
    let initial_a_runs = store.list_runs(&project_a, Some(10))?;
    let project_a_run = initial_a_runs
        .iter()
        .find(|run| run.request_type == "workspace.execute")
        .context("desktop smoke did not persist a project A execution run")?
        .run_id
        .clone();

    set_smoke_project_root(&session, &mut broker, &mut store, &project_b_root).await?;
    let project_b_payload = json!({
        "arguments": {
            "code": "rho_desktop_smoke_b <- data.frame(group = c('b1', 'b2'), value = c(10, 20))"
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.execute",
        &project_b_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let project_b = normalize_project_root(project_b_root.to_string_lossy().as_ref());
    let project_b_runs = store.list_runs(&project_b, Some(10))?;
    let project_b_run = project_b_runs
        .iter()
        .find(|run| run.request_type == "workspace.execute")
        .context("desktop smoke did not persist a project B execution run")?
        .run_id
        .clone();
    ensure!(
        store.get_run_detail(&project_a, &project_b_run)?.is_none(),
        "project B run leaked into project A detail lookup"
    );
    ensure!(
        store.get_run_detail(&project_b, &project_a_run)?.is_none(),
        "project A run leaked into project B detail lookup"
    );

    session.shutdown().await?;
    #[allow(unused_mut)]
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
    let mut broker = BrokerState::new("desktop_smoke_restart");
    store.save_identity(broker.identity())?;
    bootstrap_bridge(&session, &mut broker, &mut store, &config.bridge_package).await?;
    set_smoke_project_root(&session, &mut broker, &mut store, &project_a_root).await?;
    let restart_payload = json!({
        "arguments": {
            "code": "rho_desktop_restart <- nrow(rho_desktop_smoke)"
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.execute",
        &restart_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &mut store,
    )
    .await?;
    let project_a_runs_after_restart = store.list_runs(&project_a, Some(10))?;
    let project_a_restart_run = project_a_runs_after_restart
        .iter()
        .find(|run| {
            run.request_type == "workspace.execute"
                && run.code_preview.contains("rho_desktop_restart")
        })
        .context("desktop smoke restart execution was not recorded under project A")?
        .run_id
        .clone();
    ensure!(
        store
            .get_run_detail(&project_b, &project_a_restart_run)?
            .is_none(),
        "project A restart run leaked into project B after Workspace R restart"
    );

    let context = Arc::new(Mutex::new(CoordinatorRuntime { broker, store }));
    let agent = if include_agent {
        let turn_id = format!("smoke_turn_{}", Uuid::new_v4());
        let conversation_id = format!("conversation_{turn_id}");
        let prompt =
            "请检查 rho_desktop_smoke 对象，告诉我它有多少行和多少列。不要修改工作区。".to_string();
        let resolved_model = agent_llm::resolve_model_for_turn(&config.data_dir, None, "ask")?;
        {
            let mut context_guard = context.lock().await;
            let identity = context_guard.broker.identity().clone();
            let project_root = context_guard
                .store
                .active_project_root()?
                .context("Cannot run Agent smoke without an active project identity")?;
            context_guard.store.create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.clone(),
                project_root,
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
            Some(config.process_path.clone()),
            config.agent_package.clone(),
            resolved_model.effective_model_ref.clone(),
            Some(resolved_model.runtime_profile),
            None,
            None,
            prompt,
            "ask".to_string(),
            turn_id,
            conversation_id,
            Arc::new(PendingApprovalRegistry::default()),
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
    #[cfg(unix)]
    let crash_recovered = {
        session.terminate_process_group().await?;
        drop(session);
        let mut recovered = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
        recovered
            .execute("stopifnot(identical(2L + 2L, 4L))", |_| Ok(()))
            .await?;
        recovered.shutdown().await?;
        true
    };
    #[cfg(not(unix))]
    let crash_recovered = {
        session.shutdown().await?;
        false
    };
    let report = {
        let context = context.lock().await;
        json!({
            "type": "rho_desktop_smoke",
            "workspace": context.broker.identity(),
            "plot_count": plot_count,
            "environment_object_found": object_found,
            "data_view_rows": page_row_count,
            "stale_view_rejected": true,
            "project_switch_isolated": true,
            "workspace_restart_project_isolated": true,
            "interrupt_recovered": interrupt_requested,
            "crash_recovered": crash_recovered,
            "project_a_run_count": initial_a_runs.len(),
            "project_b_run_count": project_b_runs.len(),
            "agent": agent,
            "event_count": context.store.event_count()?,
            "python_required": false
        })
    };
    Ok(report)
}

async fn set_smoke_project_root(
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
    root: &Path,
) -> Result<()> {
    store.set_project_root(Some(root.to_string_lossy().as_ref()))?;
    let payload = json!({
        "arguments": {
            "code": workspace_project_root_code(root)?
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.set_project_root",
        &payload,
        ExecutionOrigin::System,
        session,
        broker,
        store,
    )
    .await?;
    Ok(())
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
                environment_approvals: Arc::new(PendingApprovalRegistry::default()),
                agent_tasks: Arc::new(Mutex::new(HashMap::new())),
                agent_llm_test_control: AgentModelTestControl::default(),
                switch_test_control: SwitchTestControl::default(),
                shutdown_started: AtomicBool::new(false),
                render_jobs: Arc::new(Mutex::new(HashMap::new())),
                render_tasks: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            check_for_updates,
            open_rho_website,
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
            viewer_read_file,
            project_write_file,
            project_create_file,
            project_delete_file,
            execute_r,
            snapshot_workspace,
            inspect_object,
            inspect_data_object,
            read_data_view,
            render_document,
            render_document_job,
            render_job_status,
            cancel_render_job,
            request_environment_operation_preview,
            list_environment_operation_requests,
            get_environment_operation_request,
            respond_environment_operation,
            list_installed_packages,
            list_lockfile_packages,
            list_runs,
            list_plot_artifacts,
            export_plot_artifact,
            export_data_view_artifact,
            list_artifact_records,
            get_artifact_record,
            prune_plot_payloads,
            get_project_retention_summary,
            list_project_skills,
            clear_artifact_records,
            clear_plot_artifacts,
            list_problems,
            get_run_detail,
            compare_runs,
            audit_reproducibility,
            editor_package_functions,
            editor_function_help,
            editor_function_documentation,
            editor_lint_file,
            editor_format_source,
            editor_goto_definition,
            editor_find_project_references,
            editor_discover_chunks,
            retry_run,
            run_agent,
            agent_llm_settings,
            agent_llm_save_provider,
            agent_llm_delete_provider,
            agent_llm_set_credential,
            agent_llm_delete_credential,
            agent_llm_save_model,
            agent_llm_delete_model,
            agent_llm_select_model,
            agent_llm_save_capability_route,
            agent_llm_delete_capability_route,
            agent_llm_declare_model_capabilities,
            agent_llm_refresh_credentials,
            agent_llm_test_model,
            agent_llm_cancel_test,
            agent_llm_catalog,
            agent_llm_discover_models,
            list_agent_conversations,
            create_agent_conversation,
            list_agent_turns,
            clear_agent_history,
            list_approval_requests,
            get_agent_turn_detail,
            respond_approval,
            interrupt_r,
            cancel_run,
            cancel_agent_turn,
            restart_workspace,
            git_status,
            git_log,
            git_diff,
            git_stage,
            git_commit,
            git_diff_unified,
            git_hunk_stage,
            git_hunk_unstage,
            git_restore_file,
            git_unstage_file,
            git_staged_revision,
            git_list_conflicts,
            git_resolve_conflict,
            targets_status,
            resolve_doi,
            create_evidence_entry,
            list_evidence_entries,
            get_evidence_entry,
            delete_evidence_entry,
            create_evidence_claim,
            list_evidence_claims,
            review_evidence_claim,
            delete_evidence_claim,
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
                        let _ = shutdown_application(&state).await;
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
