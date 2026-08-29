use std::sync::atomic::Ordering;
use std::time::Instant;

use rho_extension_runtime::InternalExtensionRuntimeMode;
use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::commands::runtime_control::WorkspaceStatus;
use crate::startup_runtime::{
    AgentRuntimeStatusView, StartupView, bootstrap_runtime, current_startup_view, display_error,
    display_error_chain, hide_console_window, probe_agent_runtime, runtime_config,
    startup_log_path, write_startup_log,
};
use crate::workspace_lifecycle::{finalize_workspace_start, start_workspace};
use crate::{AppState, platform, ui_runtime};

#[tauri::command]
pub(crate) async fn startup_status(state: State<'_, AppState>) -> Result<StartupView, String> {
    Ok(current_startup_view(&state))
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn startup_bootstrap(state: State<'_, AppState>) -> Result<StartupView, String> {
    Ok(bootstrap_runtime(&state, None).await)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn startup_choose_rscript(
    state: State<'_, AppState>,
) -> Result<StartupView, String> {
    let mut dialog = rfd::FileDialog::new().set_title(platform::rscript_picker_title());
    if let Some(extension) = platform::rscript_picker_extension() {
        dialog = dialog.add_filter("Rscript", &[extension]);
    }
    let Some(path) = dialog.pick_file() else {
        return Ok(current_startup_view(&state));
    };
    Ok(bootstrap_runtime(&state, Some(path)).await)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn startup_diagnostics(state: State<'_, AppState>) -> Result<String, String> {
    let path = startup_log_path();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let log_tail = startup_log_tail(&content);
    let view = serde_json::to_string_pretty(&current_startup_view(&state)).unwrap_or_default();
    Ok(format!(
        "Rho startup status\n{view}\n\nStartup log\n{log_tail}"
    ))
}

pub(crate) fn startup_log_tail(content: &str) -> String {
    content
        .chars()
        .rev()
        .take(65_536)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[tauri::command]
pub(crate) async fn startup_open_log_directory() -> Result<Value, String> {
    let path = startup_log_path();
    let mut command = platform::reveal_path_command(&path);
    hide_console_window(&mut command);
    command
        .spawn()
        .map_err(|error| format!("Could not open the startup log directory: {error}"))?;
    Ok(json!({"path": path}))
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) fn agent_runtime_status(
    state: State<'_, AppState>,
) -> Result<AgentRuntimeStatusView, String> {
    runtime_config(&state)
        .map(|config| config.agent_runtime)
        .map(AgentRuntimeStatusView::from)
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_runtime_retry(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentRuntimeStatusView, String> {
    let config = runtime_config(&state).map_err(display_error)?;
    let rscript = config.rscript.clone();
    let r_version = config.r_version.clone();
    let r_profile_user = config.r_profile_user.clone();
    let r_environ_user = config.r_environ_user.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        probe_agent_runtime(
            &rscript,
            &r_version,
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
    ui_runtime::emit_snapshot_invalidated(&app, "agent_runtime_status_changed");
    Ok(status.into())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn workspace_start(state: State<'_, AppState>) -> Result<WorkspaceStatus, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    if state.shutdown_started.load(Ordering::SeqCst) {
        return Err("Rho is closing; Workspace R cannot start".to_string());
    }
    let started = Instant::now();
    let already_running = state.session.read().await.is_some();
    let needs_extension_finalize = state.extension_host.mode()
        == InternalExtensionRuntimeMode::Candidate
        && state.extension_host.scopes().workspace().is_none();
    match start_workspace(&state).await {
        Ok(status) => {
            let status = if already_running && !needs_extension_finalize {
                status
            } else {
                finalize_workspace_start(&state, false)
                    .await
                    .map_err(display_error)?
            };
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
            Err(display_error_chain(&error))
        }
    }
}

#[tauri::command]
pub(crate) async fn workspace_status(state: State<'_, AppState>) -> Result<Value, String> {
    let session = state.session.read().await.clone();
    let context = state.context.lock().await.clone();
    let workspace = context
        .map(|context| serde_json::to_value(context.identity().as_ref()).unwrap_or(Value::Null));
    Ok(json!({
        "status": if session.is_some() { "idle" } else { "disconnected" },
        "kernel_pid": session.as_ref().and_then(|value| value.child_pid()),
        "workspace": workspace,
        "python_required": false
    }))
}
