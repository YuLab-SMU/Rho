use super::*;
use crate::commands::agent_execution::{
    AgentApprovalDeliveryResponse, AgentApprovalDeliveryStatus, AgentContextPlanPreviewView,
    AgentTurnCancelResponse, AgentTurnCancelStatus, AgentTurnDetailView, AgentTurnStartResponse,
    AgentTurnStartStatus, ApprovalDecisionRequest,
};
use crate::commands::agent_files::{
    AgentFileApplyRequest, AgentFileMutationResponse, AgentFileUndoRequest,
};
use crate::project::ProjectState;
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
        status: "degraded".to_string(),
        rscript: Some("/opt/R/4.6.1/bin/Rscript".to_string()),
        r_version: Some("4.6.1".to_string()),
        aisdk_version: Some("1.5.0".to_string()),
        provider_adapters_available: false,
        provider_health: "dependency_unavailable".to_string(),
        dependencies: vec![AgentDependencyStatus {
            package: "aisdk.providers".to_string(),
            status: "missing".to_string(),
            installed_version: None,
            required_version: "0.1.0".to_string(),
            resolved_path: None,
            detail: Some("Registered Provider adapters are unavailable.".to_string()),
            remediation: Some(
                "Install the reviewed Agent dependency without changing Workspace R.".to_string(),
            ),
        }],
        error: Some("Agent Provider adapters need attention.".to_string()),
    }
}

#[test]
fn agent_runtime_ipc_serialization_matches_generated_contract() {
    let runtime =
        serde_json::to_value(AgentRuntimeStatusView::from(agent_runtime_fixture())).unwrap();

    assert_eq!(runtime["available"], true);
    assert_eq!(runtime["status"], "degraded");
    assert_eq!(runtime["rscript"], "/opt/R/4.6.1/bin/Rscript");
    assert_eq!(runtime["provider_adapters_available"], false);
    assert_eq!(runtime["provider_health"], "dependency_unavailable");
    assert_eq!(runtime["dependencies"][0]["package"], "aisdk.providers");
    assert!(runtime["dependencies"][0]["installed_version"].is_null());
    assert!(runtime["dependencies"][0]["resolved_path"].is_null());
    assert_eq!(
        runtime["dependencies"][0]["remediation"],
        "Install the reviewed Agent dependency without changing Workspace R."
    );
}

fn agent_settings_fixture() -> AgentLlmSettingsView {
    let provider = AgentProviderProfile {
        id: "provider:fixture".to_string(),
        display_name: "Fixture Provider".to_string(),
        kind: "openai_compatible".to_string(),
        registered_provider_id: None,
        api_key_env: Some("FIXTURE_API_KEY".to_string()),
        api_key_required: true,
        base_url: Some("https://example.invalid/v1".to_string()),
        base_url_env: None,
        wire_api: Some("chat_completions".to_string()),
        disable_stream_options: Some(false),
    };
    let model = AgentModelProfile {
        id: "model:fixture".to_string(),
        provider_id: provider.id.clone(),
        display_name: "Fixture Model".to_string(),
        model_id: "fixture-model".to_string(),
        enabled: true,
        model_type: agent_llm::AgentCapabilityValue {
            value: "language".to_string(),
            source: "aisdk_catalog".to_string(),
        },
        capabilities: [
            ("function_call", "yes", "aisdk_catalog"),
            ("reasoning", "unknown", "unknown"),
            ("vision_input", "unknown", "unknown"),
            ("image_output", "unknown", "unknown"),
            ("image_edit", "unknown", "unknown"),
            ("audio_input", "unknown", "unknown"),
            ("audio_output", "unknown", "unknown"),
            ("structured_output", "unknown", "unknown"),
            ("web_search", "unknown", "unknown"),
        ]
        .into_iter()
        .map(|(name, value, source)| {
            (
                name.to_string(),
                agent_llm::AgentCapabilityValue {
                    value: value.to_string(),
                    source: source.to_string(),
                },
            )
        })
        .collect(),
        context_window_tokens: 128_000,
        reserved_output_tokens: 8_192,
        context_capacity_source: "catalog".to_string(),
        last_test: Some(agent_llm::AgentModelTestResult {
            status: "ready".to_string(),
            checked_at: "2026-08-24T12:00:00Z".to_string(),
            latency_ms: Some(42),
            error_class: None,
            message: None,
        }),
    };
    AgentLlmSettingsView {
        schema_version: 6,
        revision: 9,
        selected_model_id: model.id.clone(),
        providers: vec![agent_llm::AgentProviderProfileView {
            profile: provider,
            credential_status: "unchecked".to_string(),
            credential_effective_source: "unchecked".to_string(),
            env_shadows_file: false,
            session_credential_present: false,
            config_file_credential_present: false,
            effective_base_url: Some("https://example.invalid/v1".to_string()),
            base_url_source: "configured".to_string(),
        }],
        models: vec![agent_llm::AgentModelProfileView {
            profile: model,
            provider_display_name: "Fixture Provider".to_string(),
            selected: true,
            selector_status: "ready".to_string(),
            act_enabled: true,
        }],
        selected_model: Some(agent_llm::AgentSelectedModelView {
            id: "model:fixture".to_string(),
            display_name: "Fixture Model".to_string(),
            provider_display_name: "Fixture Provider".to_string(),
            selector_status: "ready".to_string(),
            tool_calling: "yes".to_string(),
            act_enabled: true,
        }),
        capability_routes: vec![agent_llm::AgentCapabilityRouteView {
            capability: "agent.chat".to_string(),
            label: "Chat".to_string(),
            description: "Ordinary Agent conversation".to_string(),
            model_id: Some("model:fixture".to_string()),
            model_display_name: Some("Fixture Model".to_string()),
            provider_display_name: Some("Fixture Provider".to_string()),
            model_type: "language".to_string(),
            required_model_capabilities: Vec::new(),
            configured: true,
            inherited_from: None,
            compatibility: "ready".to_string(),
            credential_status: "unchecked".to_string(),
            consumer_status: "ready".to_string(),
        }],
        user_environ: agent_llm::AgentUserEnvironInfo {
            path: "/Users/fixture/.Renviron".to_string(),
            source: "not_used_for_agent_credentials".to_string(),
        },
        config_store: agent_llm::AgentConfigStoreView {
            home_path: Some("/Users/fixture/.rho".to_string()),
            config_path: Some("/Users/fixture/.rho/config.yaml".to_string()),
            status: "loaded".to_string(),
            detail: None,
            found_schema_version: Some(6),
            config_snapshot_id: "opaque-fixture".to_string(),
            permission_issues: Vec::new(),
        },
        validation_error: None,
    }
}

#[test]
fn agent_settings_ipc_serialization_matches_generated_contract() {
    let settings = serde_json::to_value(agent_settings_fixture()).unwrap();
    let request: AgentContextCapacityRequest = serde_json::from_value(serde_json::json!({
        "modelId": "model:fixture",
        "expectedRevision": 9,
        "expectedConfigSnapshotId": "opaque-fixture",
        "contextWindowTokens": 262144,
        "reservedOutputTokens": 16384
    }))
    .unwrap();

    assert_eq!(settings["schema_version"], 6);
    assert!(settings["providers"][0].get("credential_source").is_none());
    assert_eq!(
        settings["providers"][0]["credential_effective_source"],
        "unchecked"
    );
    assert_eq!(settings["revision"], 9);
    assert_eq!(settings["providers"][0]["id"], "provider:fixture");
    assert_eq!(settings["providers"][0]["credential_status"], "unchecked");
    assert_eq!(settings["models"][0]["context_window_tokens"], 128_000);
    assert_eq!(
        settings["models"][0]["capabilities"]["function_call"]["value"],
        "yes"
    );
    assert_eq!(settings["capability_routes"][0]["capability"], "agent.chat");
    assert!(settings["validation_error"].is_null());
    assert_eq!(request.expected_revision, 9);
    assert_eq!(request.context_window_tokens, 262_144);
    let encoded = serde_json::to_string(&settings).unwrap();
    assert!(!encoded.contains("fixture-secret"));
    assert_javascript_safe_numbers(&settings);
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
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_settings_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_SETTINGS_BINDINGS_PATH")
        .expect("RHO_AGENT_SETTINGS_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::agent_llm::agent_llm_settings,
            crate::commands::agent_llm::agent_llm_connect_provider,
            crate::commands::agent_llm::agent_llm_save_provider,
            crate::commands::agent_llm::agent_llm_delete_provider,
            crate::commands::agent_llm::agent_llm_discover_models,
            crate::commands::agent_llm::agent_llm_save_model,
            crate::commands::agent_llm::agent_llm_set_context_capacity,
            crate::commands::agent_llm::agent_llm_declare_model_capability,
            crate::commands::agent_llm::agent_llm_delete_model,
            crate::commands::agent_llm::agent_llm_set_credential,
            crate::commands::agent_llm::agent_llm_delete_credential,
            crate::commands::agent_llm::agent_llm_select_model,
            crate::commands::agent_llm::agent_llm_save_capability_route,
            crate::commands::agent_llm::agent_llm_delete_capability_route,
            crate::commands::agent_llm::agent_llm_declare_model_capabilities,
            crate::commands::agent_llm::agent_llm_test_model,
            crate::commands::agent_llm::agent_llm_view_credential,
            crate::commands::agent_llm::agent_llm_repair_config_permissions,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent settings TypeScript export must succeed");
}

#[test]
fn agent_file_contract_serializes_exact_wire_casing() {
    let apply = AgentFileApplyRequest {
        turn_id: "agent-turn:fixture".to_string(),
        proposal_event_id: 42,
        path: "analysis.R".to_string(),
        expected_disk_sha256: Some("a".repeat(64)),
        before_content: "before <- TRUE\n".to_string(),
    };
    let undo = AgentFileUndoRequest {
        turn_id: "agent-turn:fixture".to_string(),
        proposal_event_id: 42,
        path: "analysis.R".to_string(),
        expected_after_sha256: "b".repeat(64),
        before_content: "before <- TRUE\n".to_string(),
        created: false,
    };
    let response = AgentFileMutationResponse {
        status: "applied".to_string(),
        path: "analysis.R".to_string(),
        content: Some("after <- TRUE\n".to_string()),
        start: 0,
        end: 14,
        after_sha256: Some("b".repeat(64)),
        project: ProjectState {
            root: "/tmp/Project A".to_string(),
            files: vec![crate::project::ProjectFile {
                path: "analysis.R".to_string(),
                name: "analysis.R".to_string(),
                kind: "file",
                size_bytes: 14,
            }],
            truncated: false,
        },
        workspace: rho_protocol::WorkspaceIdentity {
            workspace_id: "workspace:a".to_string(),
            kernel_instance_id: "kernel:a".to_string(),
            execution_seq: 3,
            state_revision: 5,
            project_revision: 7,
        },
    };

    let apply = serde_json::to_value(apply).unwrap();
    let undo = serde_json::to_value(undo).unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert_eq!(apply["proposalEventId"], 42);
    assert_eq!(apply["expectedDiskSha256"], "a".repeat(64));
    assert!(apply.get("proposal_event_id").is_none());
    assert_eq!(undo["expectedAfterSha256"], "b".repeat(64));
    assert!(undo.get("expected_after_sha256").is_none());
    assert_eq!(response["afterSha256"], "b".repeat(64));
    assert!(response.get("after_sha256").is_none());
    assert_eq!(response["project"]["files"][0]["size_bytes"], 14);
    assert_eq!(response["workspace"]["project_revision"], 7);
    assert_javascript_safe_numbers(&apply);
    assert_javascript_safe_numbers(&undo);
    assert_javascript_safe_numbers(&response);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn agent_file_typescript_export() {
    let output_path = std::env::var_os("RHO_AGENT_FILE_BINDINGS_PATH")
        .expect("RHO_AGENT_FILE_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::agent_files::apply_agent_file_edit,
            crate::commands::agent_files::undo_agent_file_edit,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Agent file mutation TypeScript export must succeed");
}
