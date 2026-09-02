use anyhow::{Result, ensure};
use rho_store::{AgentConversationDraft, AgentConversationSummary, AgentTurnSummary};
use serde_json::{Value, json};
use tauri::State;
use uuid::Uuid;

use crate::application_state::store_executor;
use crate::project::durable_project_root;
use crate::{AppState, display_error};

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_agent_conversations(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversationSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository()
        .list_conversations(project_root, limit.map(|value| value as usize))
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn create_agent_conversation(
    state: State<'_, AppState>,
) -> Result<AgentConversationSummary, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository()
        .create_conversation(AgentConversationDraft {
            conversation_id: format!("agent_conversation_{}", Uuid::new_v4()),
            project_root,
            title: "New conversation".to_string(),
            legacy_unthreaded: false,
        })
        .await
        .map_err(display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn list_agent_turns(
    conversation_id: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentTurnSummary>, String> {
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    store_executor(&state)
        .await
        .map_err(display_error)?
        .agent_repository()
        .list_turns(
            project_root,
            conversation_id,
            limit.map(|value| value as usize),
        )
        .await
        .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn delete_agent_conversation(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    delete_agent_conversation_state(&conversation_id, &state)
        .await
        .map_err(display_error)
}

pub(crate) async fn delete_agent_conversation_state(
    conversation_id: &str,
    state: &AppState,
) -> Result<Value> {
    let conversation_id = conversation_id.trim().to_string();
    ensure!(
        !conversation_id.is_empty(),
        "Agent Conversation identity is required"
    );
    let _project_transition = state.project_transition_gate.lock().await;
    let root = state.project_root.read().await.clone();
    let project_root = durable_project_root(&root);
    let tasks = state.agent_tasks.lock().await;
    ensure!(
        !tasks
            .values()
            .any(|task| task.conversation_id == conversation_id),
        "Stop the active Agent Conversation before deleting it."
    );
    let agent_store = store_executor(state).await?.agent_repository();
    let turn_ids = agent_store
        .conversation_turn_ids(project_root.clone(), conversation_id.clone())
        .await?;
    let deleted_turns = agent_store
        .delete_conversation(project_root, conversation_id.clone())
        .await?;
    drop(tasks);
    Ok(json!({
        "status": "deleted",
        "conversation_id": conversation_id,
        "deleted_turns": deleted_turns,
        "deleted_turn_ids": turn_ids
    }))
}
