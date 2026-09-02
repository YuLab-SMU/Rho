use super::*;
use crate::commands::agent_execution::{
    AgentApprovalDeliveryResponse, AgentApprovalDeliveryStatus, AgentContextPlanPreviewView,
    AgentTurnCancelResponse, AgentTurnCancelStatus, AgentTurnDetailView, AgentTurnStartResponse,
    AgentTurnStartStatus, ApprovalDecisionRequest,
};
use rho_store::{
    AgentConversationSummary, AgentTurnContextItem, AgentTurnContextItemDraft, AgentTurnEvent,
    AgentTurnSummary, ApprovalRequestSummary,
};

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

fn approval() -> ApprovalRequestSummary {
    ApprovalRequestSummary {
        request_id: "agent-request:fixture".to_string(),
        turn_id: "agent-turn:2".to_string(),
        project_root: "/tmp/Project A".to_string(),
        tool: "inspect_model".to_string(),
        policy: "ask".to_string(),
        status: "approved".to_string(),
        decision: Some("approve".to_string()),
        reason: None,
        arguments_json: "{\"path\":\"model.R\"}".to_string(),
        code: None,
        workspace_id: Some("workspace:a".to_string()),
        state_revision: Some(5),
        project_revision: Some(7),
        requested_at: "2026-08-24T12:00:20Z".to_string(),
        responded_at: Some("2026-08-24T12:00:25Z".to_string()),
        continuation_outcome: Some("resumed".to_string()),
    }
}

fn context_item() -> AgentTurnContextItem {
    AgentTurnContextItem {
        context_item_id: "agent-context:fixture".to_string(),
        turn_id: "agent-turn:2".to_string(),
        project_root: "/tmp/Project A".to_string(),
        ordinal: 1,
        source_kind: "runtime_output".to_string(),
        source_id: Some("runtime-output:fixture".to_string()),
        source_revision: Some("3".to_string()),
        source_sha256: "fixture-sha256".to_string(),
        trust_class: "project_owned".to_string(),
        capacity_source: "catalog".to_string(),
        original_bytes: 4_096,
        included_bytes: 2_048,
        estimated_tokens: 512,
        disposition: "included".to_string(),
        reason_code: None,
    }
}

fn context_item_draft() -> AgentTurnContextItemDraft {
    AgentTurnContextItemDraft {
        context_item_id: "agent-context-draft:fixture".to_string(),
        ordinal: 0,
        source_kind: "current_request".to_string(),
        source_id: None,
        source_revision: Some("1".to_string()),
        source_sha256: "draft-sha256".to_string(),
        trust_class: "user_instruction".to_string(),
        capacity_source: "catalog".to_string(),
        original_bytes: 256,
        included_bytes: 256,
        estimated_tokens: 64,
        disposition: "complete".to_string(),
        reason_code: None,
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
    assert_eq!(turns[0]["mode"], "ask");
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
        approvals: vec![approval()],
        context_items: vec![context_item()],
    })
    .unwrap();

    assert_eq!(detail["turn"]["mode"], "ask");
    assert_eq!(detail["events"][0]["id"], 42);
    assert!(detail["events"][0]["code"].is_null());
    assert_eq!(detail["approvals"][0]["state_revision"], 5);
    assert!(detail["approvals"][0]["reason"].is_null());
    assert_eq!(
        detail["context_items"][0]["context_item_id"],
        "agent-context:fixture"
    );
    assert_eq!(detail["context_items"][0]["included_bytes"], 2_048);
    assert_javascript_safe_numbers(&detail);
}

#[test]
fn agent_execution_ipc_serialization_matches_generated_contract() {
    let preview = serde_json::to_value(AgentContextPlanPreviewView {
        plan_digest: "plan-digest:fixture".to_string(),
        context_window_tokens: 128_000,
        reserved_output_tokens: 8_192,
        estimated_input_tokens: 1_024,
        capacity_source: "catalog".to_string(),
        items: vec![context_item_draft()],
        model_profile_id: "model-profile:fixture".to_string(),
        model_display_name: "Fixture model".to_string(),
        settings_revision: 9,
        conversation_id: None,
        runtime_output_context: Some(runtime_registry::RuntimeOutputReference {
            project_id: "project:fixture".to_string(),
            execution_id: "runtime-execution:fixture".to_string(),
            start_sequence: 1,
            end_sequence: 3,
            range_sha256: "range-sha256:fixture".to_string(),
            payload_bytes: 2_048,
            chunk_count: 3,
            status: "completed".to_string(),
            output_state: "complete".to_string(),
        }),
    })
    .unwrap();
    let started = serde_json::to_value(AgentTurnStartResponse {
        status: AgentTurnStartStatus::Started,
        turn_id: "agent-turn:started".to_string(),
        conversation_id: "agent-conversation:fixture".to_string(),
        retry_of_turn_id: None,
        auto_approve: false,
        task_kind: "agent_turn".to_string(),
    })
    .unwrap();
    let cancelled = serde_json::to_value(AgentTurnCancelResponse {
        status: AgentTurnCancelStatus::Cancelled,
        turn_id: "agent-turn:cancelled".to_string(),
    })
    .unwrap();
    let delivered = serde_json::to_value(AgentApprovalDeliveryResponse {
        status: AgentApprovalDeliveryStatus::NotDelivered,
        request_id: "agent-request:fixture".to_string(),
        turn_id: "agent-turn:started".to_string(),
    })
    .unwrap();
    let decision: ApprovalDecisionRequest = serde_json::from_value(serde_json::json!({
        "request_id": "agent-request:fixture",
        "decision": "reject",
        "reason": null
    }))
    .unwrap();

    assert_eq!(preview["context_window_tokens"], 128_000);
    assert_eq!(
        preview["items"][0]["context_item_id"],
        "agent-context-draft:fixture"
    );
    assert!(preview["conversation_id"].is_null());
    assert_eq!(preview["runtime_output_context"]["end_sequence"], 3);
    assert_eq!(started["status"], "started");
    assert!(started["retry_of_turn_id"].is_null());
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(delivered["status"], "not_delivered");
    assert_eq!(decision.decision, "reject");
    assert!(decision.reason.is_none());
    assert_javascript_safe_numbers(&preview);
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
            crate::commands::agent_execution::agent_context_preview,
            crate::commands::agent_execution::run_agent,
            crate::commands::agent_execution::retry_agent_turn,
            crate::commands::agent_execution::cancel_agent_turn,
            crate::commands::agent_execution::respond_approval,
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

#[test]
fn agent_file_contract_serializes_exact_wire_casing_placeholder() {
    // Retained intentionally empty: the file-proposal protocol was retired with
    // the in-process Agent host; external ACP agents emit standard patches.
}
