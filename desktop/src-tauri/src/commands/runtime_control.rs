use std::sync::atomic::Ordering;

use anyhow::{Context, Result, ensure};
use rho_core::ExecutionOrigin;
use rho_extension_runtime::InternalExtensionRuntimeMode;
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::normalize_project_root;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;

use crate::commands::agent_execution::interrupt_all_agent_tasks;
use crate::commands::render::{
    attach_render_artifact, reconcile_render_job, render_job_is_terminal,
};
use crate::startup_runtime::{AgentRuntimeStatus, write_startup_event};
use crate::{
    AppState, active_context, active_session, display_error, finalize_workspace_start,
    start_workspace, store_executor, teardown_workspace_plugins_for_boundary,
};

#[derive(Serialize, specta::Type)]
pub(crate) struct WorkspaceStatus {
    pub(crate) status: &'static str,
    pub(crate) r_version: String,
    pub(crate) r_home: String,
    #[specta(type = Option<rho_ui_contract::UiIpcNumber>)]
    pub(crate) kernel_pid: Option<u32>,
    #[specta(type = rho_ui_contract::UiIpcUnknown)]
    pub(crate) workspace: Option<Value>,
    pub(crate) agent_runtime: AgentRuntimeStatus,
    pub(crate) python_required: bool,
}

// ── Workspace Runtime control ────────────────────────────────
#[tauri::command]
pub(crate) async fn interrupt_r(state: State<'_, AppState>) -> Result<Value, String> {
    request_run_interrupt(None, &state)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn cancel_run(
    run_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    request_run_interrupt(Some(run_id), &state)
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn restart_workspace(
    state: State<'_, AppState>,
) -> Result<WorkspaceStatus, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    restart_workspace_locked(&state).await
}

pub(crate) async fn restart_workspace_locked(state: &AppState) -> Result<WorkspaceStatus, String> {
    if state.shutdown_started.load(Ordering::SeqCst) {
        return Err("Rho is closing; Workspace R cannot restart".to_string());
    }
    interrupt_all_agent_tasks(
        state,
        "desktop_restart",
        "Agent turn interrupted because Workspace R is restarting.",
    )
    .await
    .map_err(display_error)?;

    let current_project_root = {
        let root = state.project_root.read().await.clone();
        normalize_project_root(root.to_string_lossy().as_ref())
    };
    teardown_workspace_plugins_for_boundary(
        state,
        &current_project_root,
        "project_teardown",
        "workspace_restarted",
    )
    .await;
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

    let active_run_id = store_executor(state)
        .await
        .map_err(display_error)?
        .run_repository()
        .request_cancel_latest(current_project_root.clone())
        .await
        .map_err(display_error)?
        .map(|outcome| outcome.run_id);

    if state.extension_host.mode() == InternalExtensionRuntimeMode::Candidate {
        let expected_workspace = state.extension_host.scopes().workspace();
        if let Some(report) = state
            .extension_host
            .clear_workspace_scope(expected_workspace)
            .await
            .map_err(display_error)?
        {
            write_startup_event(json!({
                "kind": "internal_extension_workspace_restart_dispose",
                "outcome": report.outcome,
                "scope_id": report.scope.id,
                "generation": report.scope.generation,
            }));
        }
    }

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
    start_workspace(state).await.map_err(display_error)?;
    let status = finalize_workspace_start(state, true)
        .await
        .map_err(display_error)?;
    if !render_job_ids.is_empty() {
        let reconciled = store_executor(state)
            .await
            .map_err(display_error)?
            .artifact_repository()
            .run_artifacts(
                current_project_root,
                render_job_ids,
                "render_output".to_string(),
            )
            .await
            .map_err(display_error)?;
        let mut jobs = state.render_jobs.lock().await;
        for projection in reconciled {
            if let Some(job) = jobs.get_mut(&projection.run_id) {
                if projection
                    .run
                    .as_ref()
                    .is_some_and(|run| run.status == "completed")
                {
                    if let Some(artifact) = projection.artifact.as_ref() {
                        attach_render_artifact(job, artifact);
                    }
                }
                reconcile_render_job(
                    job,
                    projection.run.as_ref().map(|run| run.status.as_str()),
                    projection
                        .run
                        .as_ref()
                        .and_then(|run| run.error_message.clone()),
                    projection
                        .run
                        .as_ref()
                        .and_then(|run| run.terminal_reason.as_deref()),
                );
            }
        }
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn targets_status(state: State<'_, AppState>) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = root.to_string_lossy().replace('\\', "/");
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
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
        executor,
    )
    .await
    .map_err(display_error)
}

async fn request_run_interrupt(run_id: Option<String>, state: &AppState) -> Result<Value> {
    let session = active_session(state).await?;
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let repository = store_executor(state).await?.run_repository();
    let (target, marked) = match run_id {
        Some(target) => {
            let marked = repository
                .request_cancel(project_root, target.clone())
                .await
                .context("marking run as cancel-requested")?;
            (target, marked)
        }
        None => {
            let outcome = repository
                .request_cancel_latest(project_root)
                .await
                .context("looking up active run")?
                .context("No active run is available to interrupt")?;
            (outcome.run_id, outcome.marked)
        }
    };
    ensure!(marked, "Run is not active: {target}");
    session
        .interrupt()
        .await
        .context("interrupting Workspace R")?;
    Ok(json!({
        "status": "interrupt_requested",
        "run_id": target
    }))
}
