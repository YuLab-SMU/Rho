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
fn resource_ipc_serialization_matches_generated_contract() {
    let fixture = rho_ui_contract::golden_contract_fixture();
    let snapshot = &fixture.resource_registry_snapshot;
    let descriptor = &snapshot.resources[0];
    let target = ResourceTargetV1 {
        project_id: snapshot.project_id.clone(),
        resource_provider_id: descriptor.resource_provider_id.clone(),
        resource_kind: descriptor.resource_kind.clone(),
        resource_id: descriptor.resource_id.clone(),
        expected_project_revision: snapshot.project_revision,
        expected_resource_revision: descriptor.resource_revision,
    };
    let resolve = ResourceResolveRequestV1 {
        project_id: snapshot.project_id.clone(),
        resource_provider_id: descriptor.resource_provider_id.clone(),
        resource_kind: descriptor.resource_kind.clone(),
        resource_id: descriptor.resource_id.clone(),
        expected_project_revision: snapshot.project_revision,
        expected_snapshot_revision: snapshot.snapshot_revision,
    };
    let requests = serde_json::json!({
        "resolve": serde_json::to_value(resolve).unwrap(),
        "read": serde_json::to_value(ResourceReadRequestV1 {
            target: target.clone(),
            consistency: ResourceReadConsistencyV1::SharedDocument,
        }).unwrap(),
        "draft": serde_json::to_value(ResourceDraftRequestV1 {
            target: target.clone(),
            expected_document_revision: 5,
            content: "model <- lm(y ~ x)\n".to_string(),
        }).unwrap(),
        "save": serde_json::to_value(ResourceSaveRequestV1 {
            target: target.clone(),
            expected_document_revision: 5,
        }).unwrap(),
        "reload": serde_json::to_value(ResourceReloadRequestV1 {
            target: target.clone(),
            expected_document_revision: 5,
            discard_dirty: true,
        }).unwrap(),
        "rename": serde_json::to_value(ResourceRenameRequestV1 {
            target: target.clone(),
            expected_document_revision: Some(5),
            new_resource_id: "R/model.R".to_string(),
        }).unwrap(),
        "delete": serde_json::to_value(ResourceDeleteRequestV1 {
            target,
            expected_document_revision: None,
            discard_dirty: false,
        }).unwrap(),
    });
    let content = ResourceContentV1 {
        contract: RESOURCE_CONTENT_CONTRACT.to_string(),
        descriptor: descriptor.clone(),
        consistency: ResourceReadConsistencyV1::SharedDocument,
        document_revision: 5,
        base_resource_revision: descriptor.resource_revision,
        dirty: true,
        stale: false,
        content_encoding: "utf8".to_string(),
        content: "model <- lm(y ~ x)\n".to_string(),
    };

    let snapshot_json = serde_json::to_value(snapshot).unwrap();
    let content_json = serde_json::to_value(content).unwrap();
    assert_eq!(
        snapshot_json["contract"],
        "rho.ui.resource-registry.snapshot.v1"
    );
    assert_eq!(content_json["contract"], "rho.ui.resource-content.v1");
    assert_eq!(requests["read"]["consistency"], "shared_document");
    assert_eq!(requests["reload"]["discard_dirty"], true);
    assert_eq!(requests["rename"]["expected_document_revision"], 5);
    assert!(requests["delete"]["expected_document_revision"].is_null());
    assert_javascript_safe_numbers(&snapshot_json);
    assert_javascript_safe_numbers(&content_json);
    assert_javascript_safe_numbers(&requests);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn resource_typescript_export() {
    let output_path = std::env::var_os("RHO_RESOURCE_BINDINGS_PATH")
        .expect("RHO_RESOURCE_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .typ::<rho_ui_contract::ResourceBindingV1>()
        .commands(tauri_specta::collect_commands![
            crate::resource_registry::resource_list,
            crate::resource_registry::resource_resolve,
            crate::resource_registry::resource_read,
            crate::resource_registry::resource_update_draft,
            crate::resource_registry::resource_save,
            crate::resource_registry::resource_reload,
            crate::resource_registry::resource_rename,
            crate::resource_registry::resource_delete,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Resource TypeScript export must succeed");
}
