use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use rho_control_plane::{ProjectCommitOutcome, ProjectCommitter, stage_snapshot_delta};
use rho_protocol::{KernelInstanceId, ProjectRevision, RevisionStamp, StateRevision, WorkspaceId};
use rho_sandbox::snapshot::ProjectSnapshotDelta;
use rho_server::coordinator::run_external_acp_agent_turn;
#[cfg(test)]
use rho_store::Store;
use rho_store::{
    AgentConversationDraft, AgentConversationSummary, AgentRepository, AgentTurnDetail,
    AgentTurnDraft, AgentTurnEvent, AgentTurnEventDraft, AgentTurnFinish, AgentTurnSummary,
    normalize_project_root,
};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::application_state::{
    active_context, active_session, persist_workspace_identity, store_executor,
};
use crate::project::{PROJECT_FILES_CHANGED_EVENT, ProjectFileChangeEvent, durable_project_root};
use crate::startup_runtime::runtime_config;
use crate::{AppState, display_error, workspace_plugins};

const MAX_CONCURRENT_AGENT_TURNS: usize = 2;

pub(crate) struct AgentTaskEntry {
    pub(crate) conversation_id: String,
    pub(crate) handle: tauri::async_runtime::JoinHandle<()>,
}

pub(crate) fn agent_turn_admission_error(
    tasks: &HashMap<String, AgentTaskEntry>,
    conversation_id: Option<&str>,
) -> Option<&'static str> {
    if conversation_id.is_some_and(|conversation_id| {
        tasks
            .values()
            .any(|task| task.conversation_id == conversation_id)
    }) {
        return Some(
            "AGENT_CONVERSATION_BUSY: This Conversation already has an active Agent turn.",
        );
    }
    if tasks.len() >= MAX_CONCURRENT_AGENT_TURNS {
        return Some("AGENT_CONCURRENCY_LIMIT: At most two Agent turns can run at once.");
    }
    None
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentTurnStartStatus {
    Started,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentTurnStartResponse {
    pub(crate) status: AgentTurnStartStatus,
    pub(crate) turn_id: String,
    pub(crate) conversation_id: String,
    pub(crate) retry_of_turn_id: Option<String>,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn run_agent(
    prompt: String,
    conversation_id: Option<String>,
    app: AppHandle,
) -> Result<AgentTurnStartResponse, String> {
    let state = app.state::<AppState>();
    start_agent_turn(prompt, conversation_id, None, app.clone(), &state).await
}

enum AgentWorkspaceApplyOutcome {
    NoChanges,
    Committed {
        identity: rho_protocol::WorkspaceIdentity,
        paths: Vec<String>,
    },
    ReconcileRequired {
        journal_id: String,
        reason_code: String,
        applied_paths: Vec<String>,
        pending_paths: Vec<String>,
    },
}

fn revision_stamp(identity: &rho_protocol::WorkspaceIdentity) -> Result<RevisionStamp> {
    Ok(RevisionStamp {
        workspace_id: WorkspaceId::new(identity.workspace_id.clone())?,
        kernel_instance_id: KernelInstanceId::new(identity.kernel_instance_id.clone())?,
        state_revision: StateRevision(identity.state_revision),
        project_revision: ProjectRevision(identity.project_revision),
    })
}

async fn apply_agent_workspace_delta(
    context: &rho_server::workspace_lane::WorkspaceBrokerLane,
    agent_store: &AgentRepository,
    project_root: &str,
    turn_id: &str,
    delta: ProjectSnapshotDelta,
    staging_root: &Path,
) -> Result<AgentWorkspaceApplyOutcome> {
    if delta.changes.is_empty() {
        return Ok(AgentWorkspaceApplyOutcome::NoChanges);
    }
    let staged = stage_snapshot_delta(
        &delta,
        staging_root,
        format!("agent_patch_{}", Uuid::new_v4().simple()),
    )?;
    let prepared = staged.prepared();
    let mut workspace = context.lock().await;
    let before = workspace.broker.identity().clone();
    ensure!(
        before.project_revision == delta.base_project_revision.0,
        "Agent Workspace changes are stale after another project mutation"
    );
    let mut committer = ProjectCommitter::open(project_root, revision_stamp(&before)?)?;
    let outcome = committer.commit(&prepared)?;
    match outcome {
        ProjectCommitOutcome::Committed {
            transition,
            provenance,
            ..
        } => {
            let paths = provenance.applied_paths;
            workspace.broker.project_changed();
            let identity = workspace.broker.identity().clone();
            ensure!(
                identity.project_revision == transition.after.project_revision.0,
                "Agent project commit revision differs from Workspace authority"
            );
            persist_workspace_identity(&workspace.executor, identity.clone()).await?;
            drop(workspace);
            agent_store
                .append_turn_event(AgentTurnEventDraft {
                    turn_id: turn_id.to_string(),
                    event_type: "agent.workspace_committed".to_string(),
                    title: "Agent project changes committed".to_string(),
                    body: Some(format!(
                        "{} project path{} changed.",
                        paths.len(),
                        if paths.len() == 1 { "" } else { "s" }
                    )),
                    status: "completed".to_string(),
                    tool: Some("project.apply_patch".to_string()),
                    request_id: None,
                    code: None,
                    details_json: serde_json::to_string(&json!({
                        "patch_digest": provenance.patch_digest,
                        "base_project_revision": provenance.base_project_revision,
                        "applied_project_revision": provenance.applied_project_revision,
                        "paths": paths.clone(),
                        "base_snapshot_id": delta.base_snapshot_id,
                        "total_staged_bytes": delta.total_staged_bytes,
                    }))?,
                })
                .await?;
            Ok(AgentWorkspaceApplyOutcome::Committed { identity, paths })
        }
        ProjectCommitOutcome::ReconcileRequired {
            applied_paths,
            pending_paths,
            journal_id,
            reason_code,
            patch_digest,
        } => {
            drop(workspace);
            agent_store
                .append_turn_event(AgentTurnEventDraft {
                    turn_id: turn_id.to_string(),
                    event_type: "agent.workspace_reconcile_required".to_string(),
                    title: "Agent project changes require reconciliation".to_string(),
                    body: Some(
                        "Rho preserved the exact partial outcome and did not report success."
                            .to_string(),
                    ),
                    status: "uncertain".to_string(),
                    tool: Some("project.apply_patch".to_string()),
                    request_id: None,
                    code: None,
                    details_json: serde_json::to_string(&json!({
                        "patch_digest": patch_digest,
                        "journal_id": journal_id.clone(),
                        "reason_code": reason_code.clone(),
                        "applied_paths": applied_paths.clone(),
                        "pending_paths": pending_paths.clone(),
                        "base_snapshot_id": delta.base_snapshot_id,
                    }))?,
                })
                .await?;
            Ok(AgentWorkspaceApplyOutcome::ReconcileRequired {
                journal_id,
                reason_code,
                applied_paths,
                pending_paths,
            })
        }
    }
}

async fn update_agent_turn_after_workspace_effect(
    agent_store: &AgentRepository,
    project_root: &str,
    turn_id: &str,
    identity: &rho_protocol::WorkspaceIdentity,
    status: &str,
    terminal_reason: &str,
    error_message: Option<String>,
) -> Result<()> {
    let detail = agent_store
        .get_turn_detail(project_root.to_string(), turn_id.to_string())
        .await?
        .context("Agent turn disappeared before Workspace effect finalization")?;
    let error_message = error_message.or(detail.turn.error_message);
    agent_store
        .finish_turn(AgentTurnFinish {
            turn_id: turn_id.to_string(),
            status: status.to_string(),
            terminal_reason: Some(terminal_reason.to_string()),
            workspace_id_after: Some(identity.workspace_id.clone()),
            state_revision_after: Some(identity.state_revision as i64),
            project_revision_after: Some(identity.project_revision as i64),
            final_message: detail.turn.final_message,
            error_message,
        })
        .await?;
    Ok(())
}

async fn refresh_agent_turn_after_gateway(
    agent_store: &AgentRepository,
    project_root: &str,
    turn_id: &str,
    identity: &rho_protocol::WorkspaceIdentity,
    execution_succeeded: bool,
) -> Result<()> {
    update_agent_turn_after_workspace_effect(
        agent_store,
        project_root,
        turn_id,
        identity,
        if execution_succeeded {
            "completed"
        } else {
            "failed"
        },
        if execution_succeeded {
            "external_acp_completed"
        } else {
            "external_acp_failure"
        },
        None,
    )
    .await
}

async fn record_agent_workspace_uncertainty(
    agent_store: &AgentRepository,
    project_root: &str,
    turn_id: &str,
    identity: &rho_protocol::WorkspaceIdentity,
    event_type: &str,
    title: &str,
    message: &str,
    details: Value,
) -> Result<()> {
    agent_store
        .append_turn_event(AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: event_type.to_string(),
            title: title.to_string(),
            body: Some(message.to_string()),
            status: "uncertain".to_string(),
            tool: Some("project.apply_patch".to_string()),
            request_id: None,
            code: None,
            details_json: serde_json::to_string(&details)?,
        })
        .await?;
    update_agent_turn_after_workspace_effect(
        agent_store,
        project_root,
        turn_id,
        identity,
        "uncertain",
        "agent_workspace_reconcile_required",
        Some(message.to_string()),
    )
    .await
}

fn retained_agent_staging_id(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("retained-agent-turn")
        .to_string()
}

async fn capture_agent_exposed_state(
    state: &AppState,
    executor: &rho_store::StoreExecutor,
    project_root: &str,
) -> Result<Value> {
    const LIMIT: usize = 100;
    let runs = executor
        .run_repository()
        .list_runs(project_root.to_string(), Some(LIMIT))
        .await?;
    let problems = executor
        .run_repository()
        .list_problems(project_root.to_string(), Some(LIMIT))
        .await?;
    let artifacts = executor
        .artifact_repository()
        .list_records(project_root.to_string(), None, false, Some(LIMIT))
        .await?;
    let plots = executor
        .artifact_repository()
        .list_plots(project_root.to_string(), None, false, Some(LIMIT))
        .await?
        .into_iter()
        .map(|plot| {
            json!({
                "plot_id": plot.plot_id,
                "run_id": plot.run_id,
                "source_path": plot.source_path,
                "execution_mode": plot.execution_mode,
                "document_version": plot.document_version,
                "workspace_id": plot.workspace_id,
                "state_revision": plot.state_revision,
                "project_revision": plot.project_revision,
                "media_type": plot.media_type,
                "provenance_complete": plot.provenance_complete,
                "created_at": plot.created_at,
            })
        })
        .collect::<Vec<_>>();
    let runtime_executions = executor
        .runtime_output_repository()
        .list_executions(project_root.to_string(), Some(LIMIT), None)
        .await?
        .into_iter()
        .map(|execution| {
            json!({
                "execution_id": execution.execution_id,
                "run_id": execution.run_id,
                "runtime_provider_id": execution.runtime_provider_id,
                "runtime_instance_id": execution.runtime_instance_id,
                "console_instance_id": execution.console_instance_id,
                "workspace_id": execution.workspace_id,
                "source_path": execution.source_path,
                "execution_mode": execution.execution_mode,
                "document_version": execution.document_version,
                "status": execution.status,
                "terminal_reason": execution.terminal_reason,
                "output_state": execution.output_state,
                "last_sequence": execution.last_sequence,
                "output_bytes": execution.output_bytes,
                "started_at": execution.started_at,
                "finished_at": execution.finished_at,
            })
        })
        .collect::<Vec<_>>();
    let conversations = executor
        .agent_repository()
        .list_conversations(project_root.to_string(), Some(LIMIT))
        .await?;
    let environment = crate::commands::environment::environment_health_for_state(state)
        .await
        .map_err(anyhow::Error::msg)?;
    let graph_context = crate::evidence_graph_runtime::active_graph_context(state).await?;
    let evidence_graph = crate::evidence_graph_runtime::graph_health_view(&graph_context)?;
    Ok(json!({
        "runs": runs,
        "problems": problems,
        "artifacts": artifacts,
        "plots": plots,
        "runtime_executions": runtime_executions,
        "agent_conversations": conversations,
        "environment": environment,
        "evidence_graph": evidence_graph,
        "bounds": {"items_per_collection": LIMIT},
    }))
}

async fn start_agent_turn(
    prompt: String,
    conversation_id: Option<String>,
    retry_of_turn_id: Option<String>,
    app: AppHandle,
    state: &AppState,
) -> Result<AgentTurnStartResponse, String> {
    crate::commands::agent_events::ensure_agent_turn_event_forwarder(&app, state).await;
    if prompt.trim().is_empty() {
        return Err("Agent prompt is empty".to_string());
    }
    let config = runtime_config(state).map_err(display_error)?;
    let requested_conversation_id = conversation_id.map(|value| value.trim().to_string());
    if requested_conversation_id.as_deref() == Some("") {
        return Err("Agent Conversation identity cannot be empty".to_string());
    }
    if retry_of_turn_id.is_some() && requested_conversation_id.is_none() {
        return Err("Agent Retry requires its original Conversation identity".to_string());
    }
    let project_transition = state.project_transition_gate.lock().await;
    {
        let tasks = state.agent_tasks.lock().await;
        if let Some(error) =
            agent_turn_admission_error(&tasks, requested_conversation_id.as_deref())
        {
            return Err(error.to_string());
        }
    }
    let context = active_context(state).await.map_err(display_error)?;
    let turn_id = format!("agent_turn_{}", Uuid::new_v4());
    let store_executor = store_executor(state).await.map_err(display_error)?;
    let agent_store = store_executor.agent_repository();
    let identity = context.identity();
    let plugin_snapshot = workspace_plugins::agent_plugin_projection_snapshot(
        Arc::clone(&state.plugin_permissions),
        store_executor,
        config.data_dir.clone(),
        Arc::clone(&identity),
        "Cannot start Agent without an active project identity",
    )
    .await
    .map_err(display_error)?;
    let project_root = plugin_snapshot.project_root;
    let plugin_projection = plugin_snapshot.projection;
    let plugin_tool_count = plugin_projection.tools.len();
    let new_conversation = requested_conversation_id.is_none();
    let conversation_id = requested_conversation_id
        .clone()
        .unwrap_or_else(|| format!("agent_conversation_{}", Uuid::new_v4()));
    let prior_turns = if new_conversation {
        Vec::new()
    } else {
        agent_store
            .recent_conversation(
                project_root.clone(),
                conversation_id.clone(),
                turn_id.clone(),
                100,
            )
            .await
            .map_err(display_error)?
    };
    let mut exposed_state = capture_agent_exposed_state(state, store_executor, &project_root)
        .await
        .map_err(display_error)?;
    exposed_state["workspace_plugins"] = json!({
        "tools": &plugin_projection.tools,
        "context": &plugin_projection.context,
    });
    exposed_state["active_conversation"] = json!({
        "conversation_id": conversation_id,
        "prior_turns": prior_turns,
    });
    exposed_state["workbench"] = serde_json::to_value(
        crate::workbench_projection::capture_for_state(state)
            .await
            .map_err(display_error)?,
    )
    .map_err(display_error)?;
    exposed_state["live_capabilities"] = json!([
        "workspace.inspect",
        "workspace.inspect_object",
        rho_protocol::RUN_R_CAPABILITY,
        rho_protocol::ENVIRONMENT_INSPECT_CAPABILITY,
        rho_protocol::ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY,
        rho_protocol::ENVIRONMENT_OPERATION_INSPECT_CAPABILITY,
    ]);
    let gateway = crate::agent_gateway::start_agent_gateway(
        app.clone(),
        active_session(state).await.map_err(display_error)?,
        Arc::clone(&context),
    )
    .await
    .map_err(display_error)?;
    let mcp_environment = gateway.mcp_environment();
    let prepared_acp = crate::acp_runtime::prepare_acp_turn(
        &config.data_dir,
        &project_root,
        identity.as_ref(),
        exposed_state,
        mcp_environment,
        &config.process_path,
    )
    .map_err(display_error)?;
    let provider_label = prepared_acp.provider_label.clone();

    let mut tasks = state.agent_tasks.lock().await;
    let turn_draft = AgentTurnDraft {
        turn_id: turn_id.clone(),
        project_root: project_root.clone(),
        prompt: prompt.clone(),
        model: provider_label.clone(),
        workspace_id: identity.workspace_id.clone(),
        state_revision_before: identity.state_revision as i64,
        project_revision_before: identity.project_revision as i64,
    };
    if !new_conversation {
        agent_store
            .create_turn_in_conversation(
                conversation_id.clone(),
                retry_of_turn_id.clone(),
                turn_draft,
            )
            .await
            .map_err(display_error)?;
    } else {
        agent_store
            .create_turn_with_conversation(
                AgentConversationDraft {
                    conversation_id: conversation_id.clone(),
                    project_root: project_root.clone(),
                    title: "New conversation".to_string(),
                    legacy_unthreaded: false,
                },
                turn_draft,
            )
            .await
            .map_err(display_error)?;
    }
    let event_result = agent_store
        .append_turn_event(AgentTurnEventDraft {
            turn_id: turn_id.clone(),
            event_type: "agent.user_prompt".to_string(),
            title: "You".to_string(),
            body: Some(prompt.clone()),
            status: "completed".to_string(),
            tool: None,
            request_id: None,
            code: None,
            details_json: serde_json::to_string(&json!({
                "conversation_id": conversation_id,
                "retry_of_turn_id": retry_of_turn_id,
                "provider_display_name": provider_label,
                "plugin_tool_count": plugin_tool_count,
                "plugin_context_count": plugin_projection.context.len()
            }))
            .map_err(display_error)?,
        })
        .await;
    if let Err(error) = event_result {
        let _ = agent_store
            .finish_turn(AgentTurnFinish {
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
            })
            .await;
        return Err(display_error(error));
    }

    let task_turn_id = turn_id.clone();
    let task_conversation_id = conversation_id.clone();
    let task_agent_tasks = state.agent_tasks.clone();
    let task_agent_store = agent_store.clone();
    let task_project_root = project_root.clone();
    let task_context = Arc::clone(&context);
    let workspace_before = identity.as_ref().clone();
    let (registered_tx, registered_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _ = registered_rx.await;
        let mut prepared_acp = Some(prepared_acp);
        let process = prepared_acp.as_ref().unwrap().process.clone();
        let exposure = prepared_acp.as_ref().unwrap().exposure.clone();
        let execution_result = run_external_acp_agent_turn(
            agent_store,
            process,
            exposure,
            prompt,
            task_turn_id.clone(),
            task_conversation_id,
            workspace_before,
        )
        .await;
        gateway.shutdown().await;
        let workspace_delta = prepared_acp.as_ref().unwrap().workspace_delta();
        match workspace_delta {
            Ok(delta) if delta.changes.is_empty() => {
                let identity = task_context.identity();
                let _ = refresh_agent_turn_after_gateway(
                    &task_agent_store,
                    &task_project_root,
                    &task_turn_id,
                    identity.as_ref(),
                    execution_result.is_ok(),
                )
                .await;
            }
            Ok(delta) => {
                let staging_root = prepared_acp.as_ref().unwrap().commit_staging_root();
                match apply_agent_workspace_delta(
                    task_context.as_ref(),
                    &task_agent_store,
                    &task_project_root,
                    &task_turn_id,
                    delta,
                    &staging_root,
                )
                .await
                {
                    Ok(AgentWorkspaceApplyOutcome::NoChanges) => {
                        let identity = task_context.identity();
                        let _ = refresh_agent_turn_after_gateway(
                            &task_agent_store,
                            &task_project_root,
                            &task_turn_id,
                            identity.as_ref(),
                            execution_result.is_ok(),
                        )
                        .await;
                    }
                    Ok(AgentWorkspaceApplyOutcome::Committed { identity, paths }) => {
                        let _ = app.emit(
                            PROJECT_FILES_CHANGED_EVENT,
                            ProjectFileChangeEvent {
                                root: task_project_root.clone(),
                                changed_paths: paths,
                            },
                        );
                        let (status, terminal_reason) = if execution_result.is_ok() {
                            ("completed", "external_acp_completed_with_workspace_commit")
                        } else {
                            ("failed", "external_acp_failed_after_workspace_commit")
                        };
                        let _ = update_agent_turn_after_workspace_effect(
                            &task_agent_store,
                            &task_project_root,
                            &task_turn_id,
                            &identity,
                            status,
                            terminal_reason,
                            None,
                        )
                        .await;
                    }
                    Ok(AgentWorkspaceApplyOutcome::ReconcileRequired {
                        journal_id,
                        reason_code,
                        applied_paths,
                        pending_paths,
                    }) => {
                        let retained = prepared_acp.take().unwrap().retain_for_reconciliation();
                        let identity = task_context.identity();
                        let _ = record_agent_workspace_uncertainty(
                            &task_agent_store,
                            &task_project_root,
                            &task_turn_id,
                            identity.as_ref(),
                            "agent.workspace_staging_retained",
                            "Agent project staging retained",
                            "Agent project changes have a partial outcome and require reconciliation.",
                            json!({
                                "staging_id": retained_agent_staging_id(&retained),
                                "journal_id": journal_id,
                                "reason_code": reason_code,
                                "applied_paths": applied_paths,
                                "pending_paths": pending_paths,
                            }),
                        )
                        .await;
                    }
                    Err(error) => {
                        let retained = prepared_acp.take().unwrap().retain_for_reconciliation();
                        let identity = task_context.identity();
                        let _ = record_agent_workspace_uncertainty(
                            &task_agent_store,
                            &task_project_root,
                            &task_turn_id,
                            identity.as_ref(),
                            "agent.workspace_commit_failed",
                            "Agent project commit failed",
                            "Agent project changes were retained for reconciliation and were not reported as committed.",
                            json!({
                                "staging_id": retained_agent_staging_id(&retained),
                                "reason": error.to_string(),
                            }),
                        )
                        .await;
                    }
                }
            }
            Err(error) => {
                let retained = prepared_acp.take().unwrap().retain_for_reconciliation();
                let identity = task_context.identity();
                let _ = record_agent_workspace_uncertainty(
                    &task_agent_store,
                    &task_project_root,
                    &task_turn_id,
                    identity.as_ref(),
                    "agent.workspace_capture_failed",
                    "Agent project changes could not be captured",
                    "The disposable Agent Workspace was retained for reconciliation.",
                    json!({
                        "staging_id": retained_agent_staging_id(&retained),
                        "reason": error.to_string(),
                    }),
                )
                .await;
            }
        }
        task_agent_tasks.lock().await.remove(&task_turn_id);
        let _ = app.emit(
            "rho://agent-turn-updated",
            json!({ "turn_id": task_turn_id.clone() }),
        );
    });
    tasks.insert(
        turn_id.clone(),
        AgentTaskEntry {
            conversation_id: conversation_id.clone(),
            handle: task,
        },
    );
    drop(tasks);
    drop(project_transition);
    let _ = registered_tx.send(());
    Ok(AgentTurnStartResponse {
        status: AgentTurnStartStatus::Started,
        turn_id,
        conversation_id,
        retry_of_turn_id,
    })
}

pub(crate) struct AgentRetrySource {
    pub(crate) prompt: String,
    pub(crate) conversation_id: String,
}

#[cfg(test)]
pub(crate) fn agent_retry_source(
    store: &Store,
    project_root: &str,
    turn_id: &str,
) -> Result<AgentRetrySource> {
    let detail = store
        .get_agent_turn_detail(project_root, turn_id)?
        .with_context(|| {
            format!("Agent Retry source was not found in the active project: {turn_id}")
        })?;
    validate_agent_retry_detail(&detail)?;
    let conversation = store
        .get_agent_conversation(project_root, &detail.turn.conversation_id)?
        .context("Agent Retry Conversation was not found")?;
    project_agent_retry_source(detail, conversation)
}

fn project_agent_retry_source(
    detail: AgentTurnDetail,
    conversation: AgentConversationSummary,
) -> Result<AgentRetrySource> {
    validate_agent_retry_detail(&detail)?;
    ensure!(
        !conversation.legacy_unthreaded && conversation.archived_at.is_none(),
        "Legacy or archived Agent Conversations cannot be retried; start a new Conversation."
    );
    let user_event = detail
        .events
        .iter()
        .find(|event| event.event_type == "agent.user_prompt")
        .context("Agent Retry source has no immutable user prompt event")?;
    let prompt = user_event
        .body
        .clone()
        .filter(|prompt| !prompt.trim().is_empty())
        .context("Agent Retry source prompt is empty")?;
    Ok(AgentRetrySource {
        prompt,
        conversation_id: detail.turn.conversation_id,
    })
}

fn validate_agent_retry_detail(detail: &AgentTurnDetail) -> Result<()> {
    ensure!(
        !matches!(detail.turn.status.as_str(), "running" | "waiting"),
        "An active Agent turn cannot be retried"
    );
    Ok(())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn retry_agent_turn(
    turn_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentTurnStartResponse, String> {
    let turn_id = turn_id.trim().to_string();
    if turn_id.is_empty() {
        return Err("Agent Retry source identity is required".to_string());
    }
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let agent_store = store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository();
    let detail = agent_store
        .get_turn_detail(project_root.clone(), turn_id.clone())
        .await
        .map_err(display_error)?
        .with_context(|| {
            format!("Agent Retry source was not found in the active project: {turn_id}")
        })
        .map_err(display_error)?;
    validate_agent_retry_detail(&detail).map_err(display_error)?;
    let conversation = agent_store
        .get_conversation(project_root, detail.turn.conversation_id.clone())
        .await
        .map_err(display_error)?
        .context("Agent Retry Conversation was not found")
        .map_err(display_error)?;
    let source = project_agent_retry_source(detail, conversation).map_err(display_error)?;

    start_agent_turn(
        source.prompt,
        Some(source.conversation_id),
        Some(turn_id),
        app,
        &state,
    )
    .await
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentTurnDetailView {
    pub(crate) turn: AgentTurnSummary,
    pub(crate) events: Vec<AgentTurnEvent>,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn get_agent_turn_detail(
    turn_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentTurnDetailView>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let agent_store = store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository();
    let detail = agent_store
        .get_turn_detail(project_root.clone(), turn_id.clone())
        .await
        .map_err(display_error)?;
    let Some(detail) = detail else {
        return Ok(None);
    };
    Ok(Some(AgentTurnDetailView {
        turn: detail.turn,
        events: detail.events,
    }))
}

pub(crate) async fn interrupt_all_agent_tasks(
    state: &AppState,
    terminal_reason: &str,
    message: &str,
) -> Result<usize> {
    let tasks = {
        let mut tasks = state.agent_tasks.lock().await;
        tasks.drain().collect::<Vec<_>>()
    };
    let count = tasks.len();
    for (_, task) in tasks.iter() {
        task.handle.abort();
    }
    let mut turn_ids = Vec::with_capacity(count);
    for (turn_id, task) in tasks {
        let _ = task.handle.await;
        turn_ids.push(turn_id);
    }
    if count == 0 {
        return Ok(0);
    }

    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let agent_store = store_executor(state).await?.agent_repository();
    for turn_id in turn_ids {
        let Some(detail) = agent_store
            .get_turn_detail(project_root.clone(), turn_id.clone())
            .await?
        else {
            continue;
        };
        if !matches!(detail.turn.status.as_str(), "running" | "waiting") {
            continue;
        }
        agent_store
            .append_turn_event(AgentTurnEventDraft {
                turn_id: turn_id.clone(),
                event_type: "agent.interrupted".to_string(),
                title: "Agent turn interrupted".to_string(),
                body: Some(message.to_string()),
                status: "interrupted".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: serde_json::to_string(&json!({
                    "terminal_reason": terminal_reason
                }))?,
            })
            .await?;
        agent_store
            .finish_turn(AgentTurnFinish {
                turn_id,
                status: "interrupted".to_string(),
                terminal_reason: Some(terminal_reason.to_string()),
                workspace_id_after: None,
                state_revision_after: None,
                project_revision_after: None,
                final_message: None,
                error_message: Some(message.to_string()),
            })
            .await?;
    }
    Ok(count)
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentTurnCancelStatus {
    Cancelled,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentTurnCancelResponse {
    pub(crate) status: AgentTurnCancelStatus,
    pub(crate) turn_id: String,
}

pub(crate) async fn cancel_agent_turn_state(
    turn_id: String,
    state: &AppState,
) -> Result<AgentTurnCancelResponse, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let agent_store = store_executor(state)
        .await
        .map_err(display_error)?
        .agent_repository();
    let detail = agent_store
        .get_turn_detail(project_root.clone(), turn_id.clone())
        .await
        .map_err(display_error)?
        .context(format!(
            "Agent turn was not found in the active project: {turn_id}"
        ))
        .map_err(display_error)?;
    if !matches!(detail.turn.status.as_str(), "running" | "waiting") {
        return Err(format!("Agent turn is not active: {turn_id}"));
    }
    let mut task = state
        .agent_tasks
        .lock()
        .await
        .remove(&turn_id)
        .context(format!("Agent turn is not active: {turn_id}"))
        .map_err(display_error)?;
    let active_workspace_run = state.agent_workspace_lane.cancel_turn(&turn_id);
    let mut joined_after_interrupt = false;
    if let Some(run_id) = active_workspace_run.as_deref() {
        let cancel_requested = match store_executor(state).await {
            Ok(executor) => executor
                .run_repository()
                .request_cancel(project_root.clone(), run_id.to_string())
                .await
                .unwrap_or(false),
            Err(_) => false,
        };
        if let Ok(session) = active_session(state).await {
            let _ = session.interrupt().await;
        }
        if cancel_requested {
            joined_after_interrupt = tokio::time::timeout(Duration::from_secs(5), &mut task.handle)
                .await
                .is_ok();
        }
    }
    if !joined_after_interrupt {
        task.handle.abort();
        let _ = task.handle.await;
    }
    state.agent_workspace_lane.clear_turn_cancellation(&turn_id);

    let identity = match active_context(state).await {
        Ok(context) => Some(context.identity()),
        Err(_) => None,
    };
    let workspace_id_after = identity
        .as_ref()
        .map(|identity| identity.workspace_id.clone())
        .or_else(|| detail.turn.workspace_id_before.clone());
    let state_revision_after = identity
        .as_ref()
        .map(|identity| identity.state_revision as i64)
        .or(detail.turn.state_revision_before);
    let project_revision_after = identity
        .as_ref()
        .map(|identity| identity.project_revision as i64)
        .or(detail.turn.project_revision_before);
    if agent_store
        .get_turn_detail(project_root, turn_id.clone())
        .await
        .map_err(display_error)?
        .is_some()
    {
        agent_store
            .append_turn_event(AgentTurnEventDraft {
                turn_id: turn_id.clone(),
                event_type: "agent.cancelled".to_string(),
                title: "Agent turn cancelled".to_string(),
                body: Some("The user stopped this Agent turn.".to_string()),
                status: "interrupted".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: serde_json::to_string(&json!({
                    "workspace_run_id": active_workspace_run
                }))
                .map_err(display_error)?,
            })
            .await
            .map_err(display_error)?;
        agent_store
            .finish_turn(AgentTurnFinish {
                turn_id: turn_id.clone(),
                status: "interrupted".to_string(),
                terminal_reason: Some("user_cancelled".to_string()),
                workspace_id_after,
                state_revision_after,
                project_revision_after,
                final_message: None,
                error_message: Some("Agent turn cancelled by the user.".to_string()),
            })
            .await
            .map_err(display_error)?;
    }
    Ok(AgentTurnCancelResponse {
        status: AgentTurnCancelStatus::Cancelled,
        turn_id,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn cancel_agent_turn(
    turn_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentTurnCancelResponse, String> {
    let response = cancel_agent_turn_state(turn_id.clone(), &state).await?;
    let _ = app.emit("rho://agent-turn-updated", json!({ "turn_id": turn_id }));
    Ok(response)
}

#[cfg(all(test, unix))]
mod agent_workspace_tests {
    use super::*;
    use rho_core::BrokerState;
    use rho_sandbox::snapshot::{SnapshotLimits, build_project_snapshot, diff_project_snapshot};
    use rho_server::workspace_lane::WorkspaceBrokerLane;
    use rho_store::{AgentConversationDraft, AgentTurnDraft, StoreExecutor};

    #[tokio::test]
    async fn agent_workspace_delta_commits_through_the_live_workspace_revision_lane() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let workspace = directory.path().join("workspace");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(project.join("analysis.R"), "x <- 1\n").unwrap();
        std::fs::write(workspace.join("analysis.R"), "x <- 2\n").unwrap();
        std::fs::write(workspace.join("result.txt"), "done\n").unwrap();
        let baseline =
            build_project_snapshot(&project, ProjectRevision(0), SnapshotLimits::default())
                .unwrap();
        let delta =
            diff_project_snapshot(&baseline, &workspace, SnapshotLimits::default()).unwrap();

        let executor = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap();
        let agent_store = executor.agent_repository();
        let project_root = normalize_project_root(project.to_string_lossy().as_ref());
        agent_store
            .create_turn_with_conversation(
                AgentConversationDraft {
                    conversation_id: "conversation-agent-files".to_string(),
                    project_root: project_root.clone(),
                    title: "Agent files".to_string(),
                    legacy_unthreaded: false,
                },
                AgentTurnDraft {
                    turn_id: "turn-agent-files".to_string(),
                    project_root: project_root.clone(),
                    prompt: "Update the analysis".to_string(),
                    model: "external-acp".to_string(),
                    workspace_id: "workspace-agent-files".to_string(),
                    state_revision_before: 0,
                    project_revision_before: 0,
                },
            )
            .await
            .unwrap();
        let context = WorkspaceBrokerLane::new(BrokerState::new("workspace-agent-files"), executor);
        let staging = directory.path().join("staging");

        let outcome = apply_agent_workspace_delta(
            &context,
            &agent_store,
            &project_root,
            "turn-agent-files",
            delta,
            &staging,
        )
        .await
        .unwrap();
        let AgentWorkspaceApplyOutcome::Committed { identity, paths } = outcome else {
            panic!("Agent Workspace delta must commit");
        };
        assert_eq!(identity.project_revision, 1);
        assert_eq!(context.identity().project_revision, 1);
        assert_eq!(paths, vec!["analysis.R", "result.txt"]);
        assert_eq!(
            std::fs::read_to_string(project.join("analysis.R")).unwrap(),
            "x <- 2\n"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("result.txt")).unwrap(),
            "done\n"
        );
        let detail = agent_store
            .get_turn_detail(project_root, "turn-agent-files".to_string())
            .await
            .unwrap()
            .unwrap();
        assert!(
            detail
                .events
                .iter()
                .any(|event| event.event_type == "agent.workspace_committed")
        );
    }
}
