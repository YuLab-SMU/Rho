use std::sync::Arc;
use std::sync::atomic::Ordering;

use anyhow::{Context, Result};
use rho_core::BrokerState;
use rho_extension_runtime::{DEFAULT_HEARTBEAT_INTERVAL, InternalExtensionRuntimeMode};
use rho_kernel::{ArkLaunchConfig, ArkSession};
use rho_server::coordinator::bootstrap_bridge;
use rho_server::workspace_lane::WorkspaceBrokerLane;
use rho_store::{MigrationOutcome, StoreExecutor, StoreExecutorError, normalize_project_root};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::application_state::{
    active_context, active_session, persist_workspace_identity, run_store_executor_service,
    store_executor,
};
use crate::commands::runtime_control::WorkspaceStatus;
use crate::internal_extensions::{
    ensure_extension_project_scope, publish_extension_workspace_scope,
    workspace_plugin_runtime_context,
};
use crate::project_transition::{SwitchTestStep, sync_workspace_project_root};
use crate::startup_runtime::{
    RuntimeConfig, bounded_diagnostic, runtime_config, write_startup_event,
};
use crate::{AppState, workspace_plugins};

fn store_migration_outcome(error: &anyhow::Error) -> Option<&MigrationOutcome> {
    error.chain().find_map(|source| {
        source
            .downcast_ref::<StoreExecutorError>()
            .and_then(StoreExecutorError::migration_outcome)
    })
}

async fn recover_workspace_store(executor: &StoreExecutor, project_root: String) -> Result<()> {
    run_store_executor_service(executor, move |store| {
        store
            .set_project_root(Some(&project_root))
            .context("binding the active project identity")?;
        store
            .recover_incomplete_runs()
            .context("recovering incomplete runs after desktop restart")?;
        store
            .recover_incomplete_agent_turns()
            .context("recovering incomplete agent turns after desktop restart")?;
        store
            .recover_environment_operations_after_restart(&project_root)
            .context("marking incomplete Environment journals for reconciliation")?;
        store
            .recover_pending_plugin_permission_requests(&project_root, "broker_restart")
            .context("recovering pending workspace plugin permission requests")?;
        store
            .recover_transient_plugin_permission_grants(&project_root, "broker_restart")
            .context("recovering one-shot workspace plugin grants")?;
        Ok(())
    })
    .await
}

pub(crate) async fn teardown_workspace_plugins_for_boundary(
    state: &AppState,
    project_root: &str,
    kind: &str,
    trigger: &str,
) {
    let data_dir = match runtime_config(state) {
        Ok(config) => config.data_dir,
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_boundary_teardown_unavailable",
                "trigger": trigger,
                "reason_code": "runtime_config_unavailable",
                "message": bounded_diagnostic(&error.to_string()),
            }));
            state.plugin_permissions.invalidate_project(project_root);
            return;
        }
    };
    let context = match active_context(state).await {
        Ok(context) => context,
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_boundary_teardown_unavailable",
                "trigger": trigger,
                "reason_code": "workspace_context_unavailable",
                "message": bounded_diagnostic(&error.to_string()),
            }));
            state.plugin_permissions.invalidate_project(project_root);
            return;
        }
    };
    let identity = context.identity();
    let plugin_context =
        match workspace_plugin_runtime_context(data_dir, project_root.to_string(), &identity) {
            Ok(context) => context,
            Err(error) => {
                write_startup_event(json!({
                    "kind": "workspace_plugin_boundary_teardown_unavailable",
                    "trigger": trigger,
                    "reason_code": "plugin_context_unavailable",
                    "message": bounded_diagnostic(&error.to_string()),
                }));
                state.plugin_permissions.invalidate_project(project_root);
                return;
            }
        };
    let executor = match store_executor(state).await {
        Ok(executor) => executor,
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_boundary_teardown_unavailable",
                "trigger": trigger,
                "reason_code": "plugin_store_unavailable",
                "message": bounded_diagnostic(&error.to_string()),
            }));
            state.plugin_permissions.invalidate_project(project_root);
            return;
        }
    };
    let outcome = match workspace_plugins::teardown_plugin_boundary(
        Arc::clone(&state.plugin_permissions),
        executor,
        plugin_context,
        kind.to_string(),
        trigger.to_string(),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_boundary_teardown_unavailable",
                "trigger": trigger,
                "reason_code": "plugin_store_operation_failed",
                "message": bounded_diagnostic(&error.to_string()),
            }));
            state.plugin_permissions.invalidate_project(project_root);
            return;
        }
    };
    if let Some(error) = outcome.permission_recovery_error.as_deref() {
        write_startup_event(json!({
            "kind": "workspace_plugin_boundary_permission_recovery_failed",
            "trigger": trigger,
            "message": bounded_diagnostic(error),
        }));
    }
    if let Some(error) = outcome.grant_recovery_error.as_deref() {
        write_startup_event(json!({
            "kind": "workspace_plugin_boundary_grant_recovery_failed",
            "trigger": trigger,
            "message": bounded_diagnostic(error),
        }));
    }
    write_startup_event(json!({
        "kind": "workspace_plugin_boundary_teardown",
        "trigger": trigger,
        "report": outcome.report,
    }));
}

pub(crate) async fn reconcile_workspace_plugins_for_boundary(
    state: &AppState,
    project_root: &str,
    trigger: &str,
) {
    let data_dir = match runtime_config(state) {
        Ok(config) => config.data_dir,
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_reconciliation_unavailable",
                "trigger": trigger,
                "reason_code": "runtime_config_unavailable",
                "message": bounded_diagnostic(&error.to_string()),
            }));
            return;
        }
    };
    let context = match active_context(state).await {
        Ok(context) => context,
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_reconciliation_unavailable",
                "trigger": trigger,
                "reason_code": "workspace_context_unavailable",
                "message": bounded_diagnostic(&error.to_string()),
            }));
            return;
        }
    };
    let identity = context.identity();
    match workspace_plugin_runtime_context(data_dir, project_root.to_string(), &identity) {
        Ok(plugin_context) => {
            let executor = match store_executor(state).await {
                Ok(executor) => executor,
                Err(error) => {
                    write_startup_event(json!({
                        "kind": "workspace_plugin_reconciliation_unavailable",
                        "trigger": trigger,
                        "reason_code": "plugin_store_unavailable",
                        "message": bounded_diagnostic(&error.to_string()),
                    }));
                    return;
                }
            };
            let report = match workspace_plugins::reconcile_plugin_project(
                Arc::clone(&state.plugin_permissions),
                executor,
                plugin_context.clone(),
            )
            .await
            {
                Ok(report) => report,
                Err(error) => {
                    write_startup_event(json!({
                        "kind": "workspace_plugin_reconciliation_unavailable",
                        "trigger": trigger,
                        "reason_code": "plugin_store_operation_failed",
                        "message": bounded_diagnostic(&error.to_string()),
                    }));
                    return;
                }
            };
            let post_revision_report = if report.project_files_changed {
                let mut context = context.lock().await;
                context.broker.project_changed();
                let identity = context.broker.identity().clone();
                if let Err(error) = persist_workspace_identity(executor, identity.clone()).await {
                    write_startup_event(json!({
                        "kind": "workspace_plugin_recovery_revision_failed",
                        "trigger": trigger,
                        "message": bounded_diagnostic(&error.to_string()),
                    }));
                    None
                } else {
                    drop(context);
                    workspace_plugin_runtime_context(
                        plugin_context.app_data_dir.clone(),
                        project_root.to_string(),
                        &identity,
                    )
                    .ok()
                    .map(|fresh_context| (executor, fresh_context))
                }
            } else {
                None
            };
            let post_revision_report = match post_revision_report {
                Some((executor, fresh_context)) => {
                    match workspace_plugins::reconcile_plugin_project(
                        Arc::clone(&state.plugin_permissions),
                        executor,
                        fresh_context,
                    )
                    .await
                    {
                        Ok(report) => Some(report),
                        Err(error) => {
                            write_startup_event(json!({
                                "kind": "workspace_plugin_reconciliation_unavailable",
                                "trigger": trigger,
                                "reason_code": "post_revision_store_operation_failed",
                                "message": bounded_diagnostic(&error.to_string()),
                            }));
                            None
                        }
                    }
                }
                None => None,
            };
            write_startup_event(json!({
                "kind": "workspace_plugin_reconciliation",
                "trigger": trigger,
                "report": report,
                "post_revision_report": post_revision_report,
            }));
        }
        Err(error) => {
            write_startup_event(json!({
                "kind": "workspace_plugin_reconciliation_unavailable",
                "trigger": trigger,
                "reason_code": "runtime_context_unavailable",
                "message": bounded_diagnostic(&error.to_string()),
            }));
        }
    }
}

pub(crate) async fn monitor_workspace_plugin_heartbeats(app: AppHandle) {
    loop {
        tokio::time::sleep(DEFAULT_HEARTBEAT_INTERVAL).await;
        let state = app.state::<AppState>();
        if state.shutdown_started.load(Ordering::SeqCst) {
            break;
        }
        let _project_transition = state.project_transition_gate.lock().await;
        if state.shutdown_started.load(Ordering::SeqCst) {
            break;
        }
        let project_root = {
            let root = state.project_root.read().await.clone();
            normalize_project_root(root.to_string_lossy().as_ref())
        };
        let data_dir = match runtime_config(&state) {
            Ok(config) => config.data_dir,
            Err(_) => continue,
        };
        let context = match active_context(&state).await {
            Ok(context) => context,
            Err(_) => continue,
        };
        let identity = context.identity();
        let plugin_context =
            match workspace_plugin_runtime_context(data_dir, project_root, &identity) {
                Ok(context) => context,
                Err(_) => continue,
            };
        let executor = match store_executor(&state).await {
            Ok(executor) => executor,
            Err(_) => continue,
        };
        let report = match workspace_plugins::sweep_plugin_heartbeats(
            Arc::clone(&state.plugin_permissions),
            executor,
            plugin_context,
        )
        .await
        {
            Ok(report) => report,
            Err(_) => continue,
        };
        if report.checked > 0 || report.failures > 0 {
            write_startup_event(json!({
                "kind": "workspace_plugin_heartbeat_sweep",
                "report": report,
            }));
        }
    }
}

pub(crate) async fn start_workspace(state: &AppState) -> Result<WorkspaceStatus> {
    let config = runtime_config(state)?;
    if let Some(session) = state.session.read().await.clone() {
        crate::commands::environment::require_environment_execution_ready(state).await?;
        let context = state.context.lock().await.clone();
        let identity = context.map(|context| context.identity());
        return status_from(&config, &session, identity.as_deref());
    }

    let session = Arc::new(
        ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec))
            .await
            .context("starting Ark-backed Workspace R")?,
    );
    let executor = match store_executor(state).await {
        Ok(executor) => {
            write_startup_event(json!({
                "kind": "store_migration",
                "outcome": executor.migration_outcome(),
            }));
            executor.clone()
        }
        Err(error) => {
            if let Some(outcome) = store_migration_outcome(&error) {
                write_startup_event(json!({
                    "kind": "store_migration",
                    "outcome": outcome,
                }));
            }
            return Err(error).context("opening asynchronous Rho event store");
        }
    };
    let project_root = state.project_root.read().await.clone();
    let normalized_project_root = normalize_project_root(project_root.to_string_lossy().as_ref());
    recover_workspace_store(&executor, normalized_project_root.clone()).await?;
    let mut broker = BrokerState::new(format!("desktop_{}", Uuid::new_v4()));
    persist_workspace_identity(&executor, broker.identity().clone()).await?;
    bootstrap_bridge(
        session.as_ref(),
        &mut broker,
        &executor,
        &config.bridge_package,
    )
    .await?;
    let plugin_identity = broker.identity().clone();
    match workspace_plugin_runtime_context(
        config.data_dir.clone(),
        normalized_project_root.clone(),
        &plugin_identity,
    ) {
        Ok(plugin_context) => {
            let plugin_reconciliation = workspace_plugins::reconcile_plugin_project(
                Arc::clone(&state.plugin_permissions),
                &executor,
                plugin_context,
            )
            .await
            .context("reconciling Workspace plugins after startup recovery")?;
            let post_revision_reconciliation = if plugin_reconciliation.project_files_changed {
                broker.project_changed();
                persist_workspace_identity(&executor, broker.identity().clone()).await?;
                let fresh_context = workspace_plugin_runtime_context(
                    config.data_dir.clone(),
                    normalized_project_root.clone(),
                    broker.identity(),
                )?;
                Some(
                    workspace_plugins::reconcile_plugin_project(
                        Arc::clone(&state.plugin_permissions),
                        &executor,
                        fresh_context,
                    )
                    .await
                    .context("reconciling Workspace plugins after project revision change")?,
                )
            } else {
                None
            };
            write_startup_event(json!({
                "kind": "workspace_plugin_reconciliation",
                "trigger": "workspace_start",
                "report": plugin_reconciliation,
                "post_revision_report": post_revision_reconciliation,
            }));
        }
        Err(error) => write_startup_event(json!({
            "kind": "workspace_plugin_reconciliation_unavailable",
            "trigger": "workspace_start",
            "reason_code": "runtime_context_unavailable",
            "message": bounded_diagnostic(&error.to_string()),
        })),
    }
    let status = status_from(&config, &session, Some(broker.identity()))?;
    let context = Arc::new(WorkspaceBrokerLane::new(broker, executor));
    if state.extension_host.mode() == InternalExtensionRuntimeMode::Candidate {
        ensure_extension_project_scope(state, &normalized_project_root)
            .await?
            .context("candidate extension project scope is unavailable")?;
    }
    *state.context.lock().await = Some(context);
    *state.session.write().await = Some(session);
    Ok(status)
}

pub(crate) async fn finalize_workspace_start(
    state: &AppState,
    synchronize_project_root: bool,
) -> Result<WorkspaceStatus> {
    let candidate = state.extension_host.mode() == InternalExtensionRuntimeMode::Candidate;
    if synchronize_project_root {
        let root = state.project_root.read().await.clone();
        sync_workspace_project_root(state, &root, SwitchTestStep::SyncWorkspace).await?;
    }
    if candidate {
        let project =
            state.extension_host.scopes().project().context(
                "candidate extension project scope is unavailable after Workspace start",
            )?;
        let session = active_session(state).await?;
        let context = active_context(state).await?;
        publish_extension_workspace_scope(state, &project, session, context).await?;
    }
    let config = runtime_config(state)?;
    let session = active_session(state).await?;
    let context = active_context(state).await?;
    let identity = context.identity();
    status_from(&config, session.as_ref(), Some(identity.as_ref()))
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

#[cfg(test)]
mod tests {
    use rho_store::{RunDraft, Store};

    use super::*;

    #[tokio::test]
    async fn startup_recovery_runs_on_one_store_worker_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let project_root =
            normalize_project_root(directory.path().join("project").to_string_lossy().as_ref());
        let mut seed = Store::open(&database).unwrap();
        seed.create_run(&RunDraft {
            run_id: "startup-recovery-run".to_string(),
            parent_run_id: None,
            project_root: project_root.clone(),
            origin: "user".to_string(),
            request_type: "workspace.execute".to_string(),
            operation_class: "scientific".to_string(),
            code: "Sys.sleep(10)".to_string(),
            arguments_json: "{}".to_string(),
            source_path: None,
            execution_mode: Some("console".to_string()),
            document_version: None,
            workspace_id: "workspace-startup-recovery".to_string(),
            state_revision_before: 1,
            project_revision_before: 1,
            environment_snapshot_id: None,
        })
        .unwrap();
        drop(seed);

        let executor = StoreExecutor::open(&database).await.unwrap();
        recover_workspace_store(&executor, project_root.clone())
            .await
            .unwrap();
        recover_workspace_store(&executor, project_root.clone())
            .await
            .unwrap();

        let query_root = project_root.clone();
        let (active_root, runs) = run_store_executor_service(&executor, move |store| {
            Ok((
                store.active_project_root()?,
                store.list_runs(&query_root, Some(10))?,
            ))
        })
        .await
        .unwrap();
        assert_eq!(active_root.as_deref(), Some(project_root.as_str()));
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, "interrupted");
        assert_eq!(runs[0].terminal_reason.as_deref(), Some("broker_restart"));
    }
}
