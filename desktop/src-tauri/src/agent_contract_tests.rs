use super::*;
use crate::commands::agent_execution::{
    AgentTurnCancelResponse, AgentTurnCancelStatus, AgentTurnDetailView, AgentTurnStartResponse,
    AgentTurnStartStatus,
};
use rho_store::{AgentConversationSummary, AgentTurnEvent, AgentTurnSummary};

fn conversation() -> AgentConversationSummary {
    AgentConversationSummary {
        conversation_id: "agent-conversation:fixture".to_string(),
        project_root: "/tmp/Project A".to_string(),
        title: "Model review".to_string(),
        created_at: "2026-08-24T12:00:00Z".to_string(),
        updated_at: "2026-08-24T12:01:00Z".to_string(),
        archived_at: None,
        legacy_unthreaded: false,
        turn_count: 2,
        status: "completed".to_string(),
        latest_turn_id: Some("agent-turn:2".to_string()),
        latest_prompt_preview: Some("Review the model".to_string()),
        terminal_reason: Some("completed".to_string()),
    }
}

fn turn() -> AgentTurnSummary {
    AgentTurnSummary {
        turn_id: "agent-turn:2".to_string(),
        conversation_id: "agent-conversation:fixture".to_string(),
        project_root: "/tmp/Project A".to_string(),
        status: "completed".to_string(),
        started_at: "2026-08-24T12:00:00Z".to_string(),
        finished_at: Some("2026-08-24T12:01:00Z".to_string()),
        prompt_preview: "Review the model".to_string(),
        model: "model:fixture".to_string(),
        workspace_id_before: Some("workspace:a".to_string()),
        state_revision_before: Some(5),
        project_revision_before: Some(7),
        workspace_id_after: Some("workspace:a".to_string()),
        state_revision_after: Some(6),
        project_revision_after: Some(7),
        final_message: Some("Looks sound.".to_string()),
        error_message: None,
        retry_of_turn_id: None,
        terminal_reason: Some("completed".to_string()),
    }
}

fn turn_event() -> AgentTurnEvent {
    AgentTurnEvent {
        id: 42,
        turn_id: "agent-turn:2".to_string(),
        timestamp: "2026-08-24T12:00:30Z".to_string(),
        event_type: "tool.call_completed".to_string(),
        title: "Inspected model".to_string(),
        body: Some("Model structure is consistent.".to_string()),
        status: "completed".to_string(),
        tool: Some("inspect_model".to_string()),
        request_id: Some("agent-request:fixture".to_string()),
        code: None,
        details_json: "{\"success\":true}".to_string(),
    }
}

fn assert_javascript_safe_numbers(value: &serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                assert!(value.abs() <= 9_007_199_254_740_991);
            } else if let Some(value) = number.as_u64() {
                assert!(value <= 9_007_199_254_740_991);
            }
        }
        serde_json::Value::Array(values) => {
            values.iter().for_each(assert_javascript_safe_numbers);
        }
        serde_json::Value::Object(fields) => {
            fields.values().for_each(assert_javascript_safe_numbers);
        }
        _ => {}
    }
}

fn agent_runtime_fixture() -> AgentRuntimeStatus {
    AgentRuntimeStatus {
        available: true,
        status: "ready".to_string(),
        active_agent_id: Some("claude-code-acp".to_string()),
        active_agent_label: Some("Claude Code".to_string()),
        protocol: Some("acp/1".to_string()),
        executable: Some("/usr/local/bin/claude-code-acp".to_string()),
        candidates: vec![AcpAgentCandidateStatus {
            agent_id: "claude-code-acp".to_string(),
            display_name: "Claude Code".to_string(),
            status: "ready".to_string(),
            protocol: Some("acp/1".to_string()),
            executable: Some("/usr/local/bin/claude-code-acp".to_string()),
            detail: Some("External ACP Agent executable discovered.".to_string()),
        }],
        error: None,
    }
}

#[test]
fn agent_runtime_ipc_serialization_matches_generated_contract() {
    let runtime =
        serde_json::to_value(AgentRuntimeStatusView::from(agent_runtime_fixture())).unwrap();

    assert_eq!(runtime["available"], true);
    assert_eq!(runtime["status"], "ready");
    assert_eq!(runtime["active_agent_id"], "claude-code-acp");
    assert_eq!(runtime["active_agent_label"], "Claude Code");
    assert_eq!(runtime["protocol"], "acp/1");
    assert_eq!(runtime["executable"], "/usr/local/bin/claude-code-acp");
    assert_eq!(runtime["candidates"][0]["display_name"], "Claude Code");
    assert_eq!(runtime["candidates"][0]["protocol"], "acp/1");
    assert!(runtime["error"].is_null());
    assert_javascript_safe_numbers(&runtime);
}

#[test]
fn agent_conversation_ipc_serialization_matches_generated_contract() {
    let conversations = serde_json::to_value(vec![conversation()]).unwrap();
    let turns = serde_json::to_value(vec![turn()]).unwrap();

    assert_eq!(conversations[0]["turn_count"], 2);
    assert!(conversations[0]["archived_at"].is_null());
    assert_eq!(turns[0]["state_revision_before"], 5);
    assert!(turns[0]["error_message"].is_null());
    assert_javascript_safe_numbers(&conversations);
    assert_javascript_safe_numbers(&turns);
}

#[test]
fn agent_turn_detail_ipc_serialization_matches_generated_contract() {
    let detail = serde_json::to_value(AgentTurnDetailView {
        turn: turn(),
        events: vec![turn_event()],
    })
    .unwrap();

    assert_eq!(detail["events"][0]["id"], 42);
    assert!(detail["events"][0]["code"].is_null());
    assert_javascript_safe_numbers(&detail);
}

#[test]
fn agent_execution_ipc_serialization_matches_generated_contract() {
    let started = serde_json::to_value(AgentTurnStartResponse {
        status: AgentTurnStartStatus::Started,
        turn_id: "agent-turn:started".to_string(),
        conversation_id: "agent-conversation:fixture".to_string(),
        retry_of_turn_id: None,
    })
    .unwrap();
    let cancelled = serde_json::to_value(AgentTurnCancelResponse {
        status: AgentTurnCancelStatus::Cancelled,
        turn_id: "agent-turn:cancelled".to_string(),
    })
    .unwrap();
    assert_eq!(started["status"], "started");
    assert!(started["retry_of_turn_id"].is_null());
    assert_eq!(cancelled["status"], "cancelled");
    assert_javascript_safe_numbers(&started);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_conversation_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_CONVERSATION_BINDINGS_PATH")
        .expect("RHO_AGENT_CONVERSATION_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::agent_conversation::list_agent_conversations,
            crate::commands::agent_conversation::create_agent_conversation,
            crate::commands::agent_conversation::list_agent_turns,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent conversation TypeScript export must succeed");
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_turn_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_TURN_BINDINGS_PATH")
        .expect("RHO_AGENT_TURN_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::agent_execution::get_agent_turn_detail
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent turn detail TypeScript export must succeed");
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_execution_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_EXECUTION_BINDINGS_PATH")
        .expect("RHO_AGENT_EXECUTION_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::agent_execution::run_agent,
            crate::commands::agent_execution::retry_agent_turn,
            crate::commands::agent_execution::cancel_agent_turn,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent execution TypeScript export must succeed");
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_diagnostics_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_RUNTIME_BINDINGS_PATH")
        .expect("RHO_AGENT_RUNTIME_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::startup::agent_runtime_status,
            crate::commands::startup::agent_runtime_retry,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent runtime TypeScript export must succeed");
}
