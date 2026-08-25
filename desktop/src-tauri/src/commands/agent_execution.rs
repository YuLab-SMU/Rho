use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use rho_extension_runtime::InternalExtensionRuntimeMode;
use rho_server::coordinator::{
    AgentContextPlanPreview, AgentExplicitContextItem, AgentPluginContributionAdapter,
    AgentRuntimeAdapters, ApprovalResponseInput, WorkspaceSnapshotAdapter,
    preview_agent_context_plan, run_agent_turn,
};
#[cfg(test)]
use rho_store::Store;
use rho_store::{
    AgentConversationDraft, AgentConversationSummary, AgentTurnContextItem,
    AgentTurnContextItemDraft, AgentTurnDetail, AgentTurnDraft, AgentTurnEvent,
    AgentTurnEventDraft, AgentTurnFinish, AgentTurnSummary, ApprovalRequestSummary,
    normalize_project_root,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::commands::workspace::{ExtensionWorkspaceSnapshotAdapter, WorkspacePluginAgentAdapter};
use crate::{
    AgentTaskEntry, AppState, active_context, active_session, agent_llm,
    agent_turn_admission_error, display_error, durable_project_root, runtime_config,
    runtime_registry, store_executor, workspace_plugins,
};

async fn resolve_agent_explicit_context(
    state: &AppState,
    reference: Option<&runtime_registry::RuntimeOutputReference>,
) -> Result<Option<AgentExplicitContextItem>> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    let resolved = runtime_registry::resolve_runtime_output_context(
        state,
        &runtime_registry::RuntimeOutputReferenceRequest {
            execution_id: reference.execution_id.clone(),
            start_sequence: Some(reference.start_sequence),
            end_sequence: Some(reference.end_sequence),
        },
        Some(&reference.project_id),
        Some(&reference.range_sha256),
    )
    .await?;
    let authoritative = &resolved.reference;
    Ok(Some(AgentExplicitContextItem {
        source_kind: "runtime_output".to_string(),
        source_id: format!(
            "{}:{}-{}",
            authoritative.execution_id, authoritative.start_sequence, authoritative.end_sequence
        ),
        source_revision: format!("sequence:{}", authoritative.end_sequence),
        source_sha256: authoritative.range_sha256.clone(),
        trust_class: "explicit_project_data".to_string(),
        original_bytes: authoritative.payload_bytes,
        content: resolved.content,
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub(crate) enum AgentJsonValue {
    Null(()),
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<AgentJsonValue>),
    Object(BTreeMap<String, AgentJsonValue>),
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub(crate) struct AgentEditorContext(#[specta(type = AgentJsonValue)] pub(crate) Value);

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentContextPlanPreviewView {
    pub(crate) plan_digest: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) context_window_tokens: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) reserved_output_tokens: u64,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) estimated_input_tokens: u64,
    pub(crate) capacity_source: String,
    pub(crate) items: Vec<AgentTurnContextItemDraft>,
    pub(crate) model_profile_id: String,
    pub(crate) model_display_name: String,
    #[specta(type = rho_store::RuntimeOutputIpcNumber)]
    pub(crate) settings_revision: u64,
    pub(crate) conversation_id: Option<String>,
    pub(crate) runtime_output_context: Option<runtime_registry::RuntimeOutputReference>,
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
    pub(crate) auto_approve: bool,
    pub(crate) task_kind: String,
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn agent_context_preview(
    prompt: String,
    mode: String,
    task_kind: Option<String>,
    model_id: Option<String>,
    editor_context: Option<AgentEditorContext>,
    conversation_id: Option<String>,
    runtime_output_context: Option<runtime_registry::RuntimeOutputReference>,
    state: State<'_, AppState>,
) -> Result<AgentContextPlanPreviewView, String> {
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
    let requested_conversation_id = conversation_id.map(|value| value.trim().to_string());
    if requested_conversation_id.as_deref() == Some("") {
        return Err("Agent Conversation identity cannot be empty".to_string());
    }
    let (resolved_model, _) = if task_kind == "problem_repair" {
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
    let explicit_context = resolve_agent_explicit_context(&state, runtime_output_context.as_ref())
        .await
        .map_err(display_error)?;
    let store_executor = store_executor(&state).await.map_err(display_error)?;
    let agent_store = store_executor.agent_repository();
    let _project_transition = state.project_transition_gate.lock().await;
    let identity = active_context(&state)
        .await
        .map_err(display_error)?
        .identity();
    let plugin_snapshot = workspace_plugins::agent_plugin_projection_snapshot(
        Arc::clone(&state.plugin_permissions),
        store_executor,
        config.data_dir.clone(),
        identity,
        "Cannot preview Agent context without an active project identity",
    )
    .await
    .map_err(display_error)?;
    let project_root = plugin_snapshot.project_root;
    let plugin_projection = plugin_snapshot.projection;
    let history = if let Some(conversation_id) = requested_conversation_id.as_deref() {
        agent_store
            .recent_conversation(
                project_root.clone(),
                conversation_id.to_string(),
                "preview".to_string(),
                100,
            )
            .await
            .map_err(display_error)?
    } else {
        Vec::new()
    };
    let mut runtime_profile = resolved_model.runtime_profile.clone();
    runtime_profile.plugin_tools = plugin_projection.tools.clone();
    let conversation_digest_id = requested_conversation_id
        .as_deref()
        .unwrap_or("new_conversation");
    let preview: AgentContextPlanPreview = preview_agent_context_plan(
        &prompt,
        &history,
        editor_context.as_ref().map(|context| &context.0),
        Some(&project_root),
        &plugin_projection.context,
        explicit_context.as_ref(),
        &runtime_profile,
        conversation_digest_id,
    )
    .map_err(display_error)?;
    Ok(AgentContextPlanPreviewView {
        plan_digest: preview.plan_digest,
        context_window_tokens: preview.context_window_tokens,
        reserved_output_tokens: preview.reserved_output_tokens,
        estimated_input_tokens: preview.estimated_input_tokens,
        capacity_source: preview.capacity_source,
        items: preview.items,
        model_profile_id: runtime_profile.profile_id,
        model_display_name: runtime_profile.model_display_name,
        settings_revision: runtime_profile.settings_revision,
        conversation_id: requested_conversation_id,
        runtime_output_context,
    })
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn run_agent(
    prompt: String,
    mode: String,
    task_kind: Option<String>,
    model_id: Option<String>,
    auto_approve: Option<bool>,
    editor_context: Option<AgentEditorContext>,
    conversation_id: Option<String>,
    runtime_output_context: Option<runtime_registry::RuntimeOutputReference>,
    context_plan_digest: Option<String>,
    app: AppHandle,
) -> Result<AgentTurnStartResponse, String> {
    let state = app.state::<AppState>();
    start_agent_turn(
        prompt,
        mode,
        task_kind,
        model_id,
        auto_approve,
        editor_context.map(|context| context.0),
        conversation_id,
        runtime_output_context,
        context_plan_digest,
        None,
        app.clone(),
        &state,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn start_agent_turn(
    prompt: String,
    mode: String,
    task_kind: Option<String>,
    model_id: Option<String>,
    auto_approve: Option<bool>,
    editor_context: Option<Value>,
    conversation_id: Option<String>,
    runtime_output_context: Option<runtime_registry::RuntimeOutputReference>,
    context_plan_digest: Option<String>,
    retry_of_turn_id: Option<String>,
    app: AppHandle,
    state: &AppState,
) -> Result<AgentTurnStartResponse, String> {
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
    let config = runtime_config(state).map_err(display_error)?;
    if !config.agent_runtime.available {
        return Err(config
            .agent_runtime
            .error
            .clone()
            .unwrap_or_else(|| "aisdk is unavailable in Agent R".to_string()));
    }
    let requested_conversation_id = conversation_id.map(|value| value.trim().to_string());
    if requested_conversation_id.as_deref() == Some("") {
        return Err("Agent Conversation identity cannot be empty".to_string());
    }
    if retry_of_turn_id.is_some() && requested_conversation_id.is_none() {
        return Err("Agent Retry requires its original Conversation identity".to_string());
    }
    let project_transition = state.project_transition_gate.lock().await;
    let mut tasks = state.agent_tasks.lock().await;
    if let Some(error) =
        agent_turn_admission_error(&tasks, requested_conversation_id.as_deref(), &mode)
    {
        return Err(error.to_string());
    }
    let session = active_session(state).await.map_err(display_error)?;
    let context = active_context(state).await.map_err(display_error)?;
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
    let explicit_context = resolve_agent_explicit_context(state, runtime_output_context.as_ref())
        .await
        .map_err(display_error)?;
    let store_executor = store_executor(state).await.map_err(display_error)?;
    let agent_store = store_executor.agent_repository();
    let conversation_id;
    let mut agent_runtime_profile = resolved_model.runtime_profile.clone();
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
    let plugin_runtime_context = plugin_snapshot.runtime_context;
    let plugin_projection = plugin_snapshot.projection;
    agent_runtime_profile.plugin_tools = plugin_projection.tools.clone();

    if explicit_context.is_some() || context_plan_digest.is_some() {
        let digest_conversation_id = requested_conversation_id
            .as_deref()
            .unwrap_or("new_conversation");
        let history = if let Some(conversation_id) = requested_conversation_id.as_deref() {
            agent_store
                .recent_conversation(
                    project_root.clone(),
                    conversation_id.to_string(),
                    "preview".to_string(),
                    100,
                )
                .await
                .map_err(display_error)?
        } else {
            Vec::new()
        };
        let current_plan = preview_agent_context_plan(
            &prompt,
            &history,
            editor_context.as_ref(),
            Some(&project_root),
            &plugin_projection.context,
            explicit_context.as_ref(),
            &agent_runtime_profile,
            digest_conversation_id,
        )
        .map_err(display_error)?;
        let expected = context_plan_digest.as_deref().ok_or_else(|| {
            "Explicit Agent context requires a reviewed context-plan digest".to_string()
        })?;
        if expected != current_plan.plan_digest {
            return Err(
                "Agent context changed after review. Review the current context plan and send again."
                    .to_string(),
            );
        }
    }
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
        agent_store
            .create_turn_in_conversation(
                conversation_id.clone(),
                retry_of_turn_id.clone(),
                turn_draft,
            )
            .await
            .map_err(display_error)?;
        conversation_id
    } else {
        let conversation_id = format!("agent_conversation_{}", Uuid::new_v4());
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
        conversation_id
    };
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
                "prompt": prompt,
                "mode": mode,
                "task_kind": task_kind,
                "conversation_id": conversation_id,
                "retry_of_turn_id": retry_of_turn_id,
                "auto_approve": auto_approve,
                "editor_context": editor_context.clone(),
                "runtime_output_context": runtime_output_context,
                "context_plan_digest": context_plan_digest.clone(),
                "model_profile_id": resolved_model.runtime_profile.profile_id,
                "model_display_name": resolved_model.model_display_name,
                "provider_display_name": resolved_model.provider_display_name,
                "effective_model": resolved_model.effective_model_ref,
                "model_settings_revision": resolved_model.settings_revision,
                "capability_route": resolved_model.route_capability,
                "plugin_tool_count": plugin_projection.tools.len(),
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

    let approvals = state.approvals.clone();
    let environment_approvals = state.environment_approvals.clone();
    let workspace_lane = state.agent_workspace_lane.clone();
    let rscript = config.rscript.clone();
    let process_path = config.process_path.clone();
    let agent_package = config.agent_package.clone();
    let task_turn_id = turn_id.clone();
    let task_conversation_id = conversation_id.clone();
    let task_agent_tasks = state.agent_tasks.clone();
    let workspace_snapshot_adapter: Option<Arc<dyn WorkspaceSnapshotAdapter>> =
        (state.extension_host.mode() == InternalExtensionRuntimeMode::Candidate).then(|| {
            Arc::new(ExtensionWorkspaceSnapshotAdapter::new(
                Arc::clone(&state.extension_host),
                Arc::clone(&context),
            )) as Arc<dyn WorkspaceSnapshotAdapter>
        });
    let plugin_contribution_adapter: Option<Arc<dyn AgentPluginContributionAdapter>> =
        (!agent_runtime_profile.plugin_tools.is_empty()).then(|| {
            Arc::new(WorkspacePluginAgentAdapter::new(
                Arc::clone(&state.plugin_permissions),
                plugin_runtime_context,
                store_executor.clone(),
            )) as Arc<dyn AgentPluginContributionAdapter>
        });
    let runtime_profile = agent_runtime_profile;
    let task_mode = mode.clone();
    let (registered_tx, registered_rx) = oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _ = registered_rx.await;
        let _ = run_agent_turn(
            session.as_ref(),
            context,
            agent_store,
            project_root,
            rscript,
            Some(process_path),
            agent_package,
            resolved_model.effective_model_ref,
            Some(runtime_profile),
            None,
            credential_override,
            prompt,
            task_mode,
            task_turn_id.clone(),
            task_conversation_id,
            workspace_lane,
            approvals,
            environment_approvals,
            auto_approve,
            editor_context,
            explicit_context,
            context_plan_digest,
            AgentRuntimeAdapters {
                workspace_snapshot: workspace_snapshot_adapter,
                plugin_contribution: plugin_contribution_adapter,
            },
            plugin_projection.context,
        )
        .await;
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
        auto_approve,
        task_kind,
    })
}

pub(crate) struct AgentRetrySource {
    pub(crate) prompt: String,
    pub(crate) mode: String,
    pub(crate) task_kind: String,
    pub(crate) editor_context: Option<Value>,
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
    let event_details: Value = serde_json::from_str(&user_event.details_json)
        .context("Agent Retry source metadata is malformed")?;
    let task_kind = event_details
        .get("task_kind")
        .and_then(Value::as_str)
        .unwrap_or("agent_turn")
        .to_string();
    Ok(AgentRetrySource {
        prompt,
        mode: detail.turn.mode,
        task_kind,
        editor_context: event_details.get("editor_context").cloned(),
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
        source.mode,
        Some(source.task_kind),
        None,
        Some(false),
        source.editor_context,
        Some(source.conversation_id),
        None,
        None,
        Some(turn_id),
        app,
        &state,
    )
    .await
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub(crate) struct ApprovalDecisionRequest {
    pub(crate) request_id: String,
    pub(crate) decision: String,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentApprovalDeliveryStatus {
    Delivered,
    NotDelivered,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentApprovalDeliveryResponse {
    pub(crate) status: AgentApprovalDeliveryStatus,
    pub(crate) request_id: String,
    pub(crate) turn_id: String,
}

#[tauri::command]
pub(crate) async fn list_approval_requests(
    limit: Option<usize>,
    status: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ApprovalRequestSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository()
        .list_approval_requests(project_root, limit, status)
        .await
        .map_err(display_error)
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct AgentTurnDetailView {
    pub(crate) turn: AgentTurnSummary,
    pub(crate) events: Vec<AgentTurnEvent>,
    pub(crate) approvals: Vec<ApprovalRequestSummary>,
    pub(crate) context_items: Vec<AgentTurnContextItem>,
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
    let context_items = agent_store
        .list_context_items(project_root, turn_id)
        .await
        .map_err(display_error)?;
    Ok(Some(AgentTurnDetailView {
        turn: detail.turn,
        events: detail.events,
        approvals: detail.approvals,
        context_items,
    }))
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn respond_approval(
    request: ApprovalDecisionRequest,
    state: State<'_, AppState>,
) -> Result<AgentApprovalDeliveryResponse, String> {
    if !matches!(request.decision.as_str(), "approve" | "reject" | "cancel") {
        return Err(format!(
            "unsupported approval decision `{}`",
            request.decision
        ));
    }
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let agent_store = store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository();
    let pending = agent_store
        .get_approval_request(project_root, request.request_id.clone())
        .await
        .map_err(display_error)?
        .filter(|item| item.status == "waiting")
        .context(format!(
            "Approval request not found or no longer waiting: {}",
            request.request_id
        ))
        .map_err(display_error)?;
    let delivered = state
        .approvals
        .respond_for_turn(
            &request.request_id,
            Some(&pending.turn_id),
            ApprovalResponseInput {
                decision: request.decision.clone(),
                reason: request.reason.clone(),
            },
        )
        .await;
    if !delivered {
        agent_store
            .resolve_approval_request(
                request.request_id.clone(),
                rho_store::ApprovalDecisionRecord {
                    decision: "cancel".to_string(),
                    status: "interrupted".to_string(),
                    reason: Some("Approval channel is no longer active.".to_string()),
                    continuation_outcome: Some("agent_unavailable".to_string()),
                },
            )
            .await
            .map_err(display_error)?;
    }
    Ok(AgentApprovalDeliveryResponse {
        status: if delivered {
            AgentApprovalDeliveryStatus::Delivered
        } else {
            AgentApprovalDeliveryStatus::NotDelivered
        },
        request_id: request.request_id,
        turn_id: pending.turn_id,
    })
}

pub(crate) async fn interrupt_all_agent_tasks(
    state: &AppState,
    terminal_reason: &str,
    message: &str,
) -> Result<usize> {
    state.approvals.cancel_all(message).await;
    state.environment_approvals.cancel_all(message).await;
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
            .interrupt_approvals(
                turn_id.clone(),
                message.to_string(),
                terminal_reason.to_string(),
            )
            .await?;
        agent_store
            .interrupt_environment_operations(
                turn_id.clone(),
                message.to_string(),
                terminal_reason.to_string(),
            )
            .await?;
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

#[tauri::command]
pub(crate) async fn clear_agent_history(state: State<'_, AppState>) -> Result<Value, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let tasks = state.agent_tasks.lock().await;
    if !tasks.is_empty() {
        return Err("Stop the active Agent turn before clearing its history.".to_string());
    }
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    if state.agent_file_mutations.blocker(&project_root).is_some() {
        return Err("Wait for Agent file operations before clearing history.".to_string());
    }
    let deleted = store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository()
        .clear_history(project_root)
        .await
        .map_err(display_error)?;
    drop(tasks);
    Ok(json!({"deleted": deleted}))
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
    let cancelled_approvals = state
        .approvals
        .cancel_turn(&turn_id, "Agent turn cancelled by the user.")
        .await;
    let cancelled_environment_approvals = state
        .environment_approvals
        .cancel_turn(&turn_id, "Agent turn cancelled by the user.")
        .await;
    let cancelled_file_mutations = state.agent_file_mutations.cancel_queued_turn(&turn_id);
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
        if let Ok(session) = active_session(&state).await {
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
            .interrupt_approvals(
                turn_id.clone(),
                "Agent turn cancelled by the user.".to_string(),
                "user_cancelled".to_string(),
            )
            .await
            .map_err(display_error)?;
        agent_store
            .interrupt_environment_operations(
                turn_id.clone(),
                "Agent turn cancelled by the user.".to_string(),
                "user_cancelled".to_string(),
            )
            .await
            .map_err(display_error)?;
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
                    "cancelled_approval_waiters": cancelled_approvals,
                    "cancelled_environment_waiters": cancelled_environment_approvals,
                    "cancelled_file_mutations": cancelled_file_mutations,
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
