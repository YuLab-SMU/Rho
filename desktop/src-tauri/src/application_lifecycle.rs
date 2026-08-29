use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[cfg(windows)]
use std::process::{Command, Stdio};

use anyhow::Result;
#[cfg(windows)]
use anyhow::{Context, ensure};
use rho_extension_runtime::DisposeOutcome;
use rho_store::normalize_project_root;

use crate::commands::agent_execution::interrupt_all_agent_tasks;
use crate::startup_runtime::{display_error, write_startup_log};
use crate::workspace_lifecycle::teardown_workspace_plugins_for_boundary;
use crate::{AppState, agent_llm, runtime_registry};

pub(crate) async fn shutdown_application(state: &AppState) -> Result<(), String> {
    write_startup_log("Rho desktop shutdown started");
    state.shutdown_started.store(true, Ordering::SeqCst);
    let _project_transition = state.project_transition_gate.lock().await;
    interrupt_all_agent_tasks(
        state,
        "desktop_shutdown",
        "Agent turn interrupted because Rho is closing.",
    )
    .await
    .map_err(display_error)?;

    if let Err(error) = agent_llm::cancel_test(&state.agent_llm_test_control) {
        write_startup_log(&format!("Agent model test shutdown failed: {error:#}"));
    }
    agent_llm::clear_session_credentials();

    let plugin_project_root = {
        let root = state.project_root.read().await.clone();
        normalize_project_root(root.to_string_lossy().as_ref())
    };
    teardown_workspace_plugins_for_boundary(
        state,
        &plugin_project_root,
        "shutdown",
        "broker_shutdown",
    )
    .await;
    if let Err(error) = runtime_registry::teardown_auxiliary_runtimes(None, state).await {
        write_startup_log(&format!(
            "Auxiliary Runtime shutdown teardown failed: {error:#}"
        ));
    }

    if let Some(watcher) = state.project_watcher.lock().await.take() {
        watcher.stop();
    }

    let extension_report = state.extension_host.shutdown().await;
    if extension_report.outcome == DisposeOutcome::Failed {
        write_startup_log("Internal extension shutdown completed with leaked resources");
    }

    let context = state.context.lock().await.take();
    let session = state.session.write().await.take();
    #[cfg(windows)]
    let kernel_pid = session.as_ref().and_then(|session| session.child_pid());

    if let Some(session) = session.as_ref() {
        let _ = session.interrupt().await;
    }

    if let Some(context) = context.as_ref()
        && tokio::time::timeout(Duration::from_secs(5), context.lock())
            .await
            .is_err()
    {
        write_startup_log("Timed out waiting for Workspace R execution during shutdown");
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
