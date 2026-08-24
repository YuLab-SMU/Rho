use super::*;

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
        latest_mode: Some("ask".to_string()),
        latest_prompt_preview: Some("Review the model".to_string()),
        terminal_reason: Some("completed".to_string()),
        pending_request_id: None,
    }
}

fn turn() -> AgentTurnSummary {
    AgentTurnSummary {
        turn_id: "agent-turn:2".to_string(),
        conversation_id: "agent-conversation:fixture".to_string(),
        project_root: "/tmp/Project A".to_string(),
        mode: "ask".to_string(),
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
        pending_request_id: None,
        retry_of_turn_id: None,
        terminal_reason: Some("completed".to_string()),
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

#[test]
fn agent_conversation_ipc_serialization_matches_generated_contract() {
    let conversations = serde_json::to_value(vec![conversation()]).unwrap();
    let turns = serde_json::to_value(vec![turn()]).unwrap();

    assert_eq!(conversations[0]["turn_count"], 2);
    assert!(conversations[0]["archived_at"].is_null());
    assert_eq!(turns[0]["mode"], "ask");
    assert_eq!(turns[0]["state_revision_before"], 5);
    assert!(turns[0]["error_message"].is_null());
    assert_javascript_safe_numbers(&conversations);
    assert_javascript_safe_numbers(&turns);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_conversation_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_CONVERSATION_BINDINGS_PATH")
        .expect("RHO_AGENT_CONVERSATION_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::list_agent_conversations,
            crate::create_agent_conversation,
            crate::list_agent_turns,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent conversation TypeScript export must succeed");
}
