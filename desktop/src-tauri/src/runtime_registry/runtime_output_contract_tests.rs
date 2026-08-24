use super::*;

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
fn runtime_output_ipc_serialization_matches_generated_contract() {
    let execution = RuntimeExecution {
        execution_id: "execution.1".to_string(),
        project_root: "/project-a".to_string(),
        run_id: None,
        runtime_provider_id: "rho.runtime.r".to_string(),
        runtime_instance_id: "runtime.1".to_string(),
        runtime_activation_generation: 4,
        console_instance_id: "console.1".to_string(),
        submitted_code: "summary(model)".to_string(),
        workspace_id: Some("workspace.1".to_string()),
        source_path: None,
        execution_mode: Some("expression".to_string()),
        document_version: None,
        status: "completed".to_string(),
        terminal_reason: None,
        output_state: "complete".to_string(),
        last_sequence: 2,
        output_bytes: 16,
        started_at: "2026-08-24T00:00:00Z".to_string(),
        finished_at: Some("2026-08-24T00:00:01Z".to_string()),
    };
    let execution_json = serde_json::to_value(&execution).unwrap();
    assert_eq!(
        execution_json,
        serde_json::json!({
            "execution_id": "execution.1",
            "project_root": "/project-a",
            "run_id": null,
            "runtime_provider_id": "rho.runtime.r",
            "runtime_instance_id": "runtime.1",
            "runtime_activation_generation": 4,
            "console_instance_id": "console.1",
            "submitted_code": "summary(model)",
            "workspace_id": "workspace.1",
            "source_path": null,
            "execution_mode": "expression",
            "document_version": null,
            "status": "completed",
            "terminal_reason": null,
            "output_state": "complete",
            "last_sequence": 2,
            "output_bytes": 16,
            "started_at": "2026-08-24T00:00:00Z",
            "finished_at": "2026-08-24T00:00:01Z"
        })
    );

    let requests = serde_json::json!({
        "identity": serde_json::to_value(RuntimeExecutionIdentityRequest {
            execution_id: "execution.1".to_string(),
        }).unwrap(),
        "list": serde_json::to_value(RuntimeExecutionListRequest {
            limit: Some(50),
            before_started_at: None,
            before_execution_id: None,
        }).unwrap(),
        "page": serde_json::to_value(RuntimeOutputPageRequest {
            execution_id: "execution.1".to_string(),
            after_sequence: 0,
            before_sequence: None,
            page_size: Some(100),
            byte_limit: Some(524_288),
        }).unwrap(),
        "reference": serde_json::to_value(RuntimeOutputReferenceRequest {
            execution_id: "execution.1".to_string(),
            start_sequence: None,
            end_sequence: Some(2),
        }).unwrap(),
    });
    assert_eq!(
        requests,
        serde_json::json!({
            "identity": {"execution_id": "execution.1"},
            "list": {
                "limit": 50,
                "before_started_at": null,
                "before_execution_id": null
            },
            "page": {
                "execution_id": "execution.1",
                "after_sequence": 0,
                "before_sequence": null,
                "page_size": 100,
                "byte_limit": 524288
            },
            "reference": {
                "execution_id": "execution.1",
                "start_sequence": null,
                "end_sequence": 2
            }
        })
    );

    assert_eq!(
        serde_json::to_value(RuntimeOutputFollowFrame::Gap {
            project_id: "project-a".to_string(),
            execution_id: "execution.1".to_string(),
            expected_sequence: 3,
            committed_through: 5,
        })
        .unwrap(),
        serde_json::json!({
            "type": "gap",
            "project_id": "project-a",
            "execution_id": "execution.1",
            "expected_sequence": 3,
            "committed_through": 5
        })
    );
    assert_eq!(
        serde_json::to_value(RuntimeExecutionMutationOutcome::NotActive).unwrap(),
        serde_json::json!("not_active")
    );
    assert_javascript_safe_numbers(&execution_json);
    assert_javascript_safe_numbers(&requests);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn runtime_output_typescript_export() {
    let output_path = std::env::var_os("RHO_RUNTIME_OUTPUT_BINDINGS_PATH")
        .expect("RHO_RUNTIME_OUTPUT_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            runtime_execution_get,
            runtime_execution_list,
            runtime_output_search,
            runtime_output_policy_get,
            runtime_output_policy_update,
            runtime_output_page,
            runtime_output_reference,
            runtime_output_prune,
            runtime_execution_delete,
            runtime_output_follow,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Runtime Output TypeScript export must succeed");
}
