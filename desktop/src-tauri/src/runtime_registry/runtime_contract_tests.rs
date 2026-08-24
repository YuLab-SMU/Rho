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

fn runtime_instance_request() -> RuntimeInstanceRequestV1 {
    RuntimeInstanceRequestV1 {
        project_id: rho_ui_contract::ProjectId::new("project-a").unwrap(),
        runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
        runtime_instance_id: RuntimeInstanceId::new("runtime.workspace-r").unwrap(),
        activation_generation: 3,
        expected_project_revision: 7,
        expected_state_revision: 11,
    }
}

#[test]
fn runtime_ipc_serialization_matches_generated_contract() {
    let fixture = rho_ui_contract::golden_contract_fixture();
    let snapshot_json = serde_json::to_value(&fixture.runtime_registry_snapshot).unwrap();
    assert_eq!(
        snapshot_json["contract"],
        "rho.ui.runtime-registry.snapshot.v1"
    );
    assert_eq!(snapshot_json["contract_major"], 1);
    assert!(snapshot_json["providers"].is_array());
    assert!(snapshot_json["instances"].is_array());

    let create = RuntimeCreateRequestV1 {
        project_id: rho_ui_contract::ProjectId::new("project-a").unwrap(),
        runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
        expected_project_revision: 7,
        expected_snapshot_revision: 13,
        display_label: None,
    };
    let execute = RuntimeExecuteRequestV1 {
        runtime: runtime_instance_request(),
        console_instance_id: rho_ui_contract::SurfaceInstanceId::new("console.main").unwrap(),
        expected_console_revision: 17,
        code: "summary(model)".to_string(),
        source_context: Some(rho_ui_contract::RuntimeExecutionSourceContextV1 {
            source_path: "analysis/model.R".to_string(),
            execution_mode: "expression".to_string(),
            document_version: Some(19),
            source_range: rho_ui_contract::RuntimeExecutionSourceRangeV1 {
                start_line: 4,
                start_column: 1,
                end_line: 4,
                end_column: 15,
            },
        }),
    };
    let requests_json = serde_json::json!({
        "create": serde_json::to_value(create).unwrap(),
        "instance": serde_json::to_value(runtime_instance_request()).unwrap(),
        "execute": serde_json::to_value(execute).unwrap(),
    });
    assert_eq!(
        requests_json,
        serde_json::json!({
            "create": {
                "project_id": "project-a",
                "runtime_provider_id": "rho.ark-r",
                "expected_project_revision": 7,
                "expected_snapshot_revision": 13,
                "display_label": null
            },
            "instance": {
                "project_id": "project-a",
                "runtime_provider_id": "rho.ark-r",
                "runtime_instance_id": "runtime.workspace-r",
                "activation_generation": 3,
                "expected_project_revision": 7,
                "expected_state_revision": 11
            },
            "execute": {
                "runtime": {
                    "project_id": "project-a",
                    "runtime_provider_id": "rho.ark-r",
                    "runtime_instance_id": "runtime.workspace-r",
                    "activation_generation": 3,
                    "expected_project_revision": 7,
                    "expected_state_revision": 11
                },
                "console_instance_id": "console.main",
                "expected_console_revision": 17,
                "code": "summary(model)",
                "source_context": {
                    "source_path": "analysis/model.R",
                    "execution_mode": "expression",
                    "document_version": 19,
                    "source_range": {
                        "start_line": 4,
                        "start_column": 1,
                        "end_line": 4,
                        "end_column": 15
                    }
                }
            }
        })
    );

    let response = RuntimeExecutionStartResponse {
        execution: RuntimeExecution {
            execution_id: "execution.1".to_string(),
            project_root: "/project-a".to_string(),
            run_id: None,
            runtime_provider_id: "rho.ark-r".to_string(),
            runtime_instance_id: "runtime.workspace-r".to_string(),
            runtime_activation_generation: 3,
            console_instance_id: "console.main".to_string(),
            submitted_code: "summary(model)".to_string(),
            workspace_id: None,
            source_path: Some("analysis/model.R".to_string()),
            execution_mode: Some("expression".to_string()),
            document_version: Some(19),
            status: "admitted".to_string(),
            terminal_reason: None,
            output_state: "collecting".to_string(),
            last_sequence: 0,
            output_bytes: 0,
            started_at: "2026-08-24T00:00:00Z".to_string(),
            finished_at: None,
        },
        committed_through: 0,
    };
    let response_json = serde_json::to_value(response).unwrap();
    assert_eq!(response_json["execution"]["status"], "admitted");
    assert_eq!(response_json["committed_through"], 0);
    assert_javascript_safe_numbers(&snapshot_json);
    assert_javascript_safe_numbers(&requests_json);
    assert_javascript_safe_numbers(&response_json);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn runtime_typescript_export() {
    let output_path = std::env::var_os("RHO_RUNTIME_BINDINGS_PATH")
        .expect("RHO_RUNTIME_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .typ::<rho_ui_contract::RuntimeBindingV1>()
        .commands(tauri_specta::collect_commands![
            runtime_list,
            runtime_create,
            runtime_interrupt,
            runtime_restart,
            runtime_stop,
            runtime_execution_start,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Runtime TypeScript export must succeed");
}
