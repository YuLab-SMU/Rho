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
fn profile_ipc_serialization_matches_generated_contract() {
    let snapshot = rho_ui_contract::golden_contract_fixture().project_ui_profile_snapshot;
    let target = UiProfileRevisionRequestV1 {
        project_id: snapshot.profile.project_id.clone(),
        expected_profile_revision: snapshot.profile.revision,
    };
    let scene_id = snapshot.profile.studio_scenes[0].scene_id.clone();
    let page = &snapshot.profile.vibe_pages[0];
    let page_id = page.page_id.clone();
    let requests = serde_json::json!({
        "set_mode": serde_json::to_value(SetModeRequest {
            target: target.clone(),
            mode: UiProfileModeV1::Vibe,
        }).unwrap(),
        "select_scene": serde_json::to_value(SelectSceneRequest {
            target: target.clone(),
            scene_id: scene_id.clone(),
        }).unwrap(),
        "select_page": serde_json::to_value(SelectPageRequest {
            target: target.clone(),
            page_id: page_id.clone(),
        }).unwrap(),
        "scene_label": serde_json::to_value(SceneLabelRequest {
            target: target.clone(),
            scene_id: scene_id.clone(),
            label: "Exploration".to_string(),
        }).unwrap(),
        "scene_target": serde_json::to_value(SceneTargetRequest {
            target: target.clone(),
            scene_id,
        }).unwrap(),
        "page_mutation": serde_json::to_value(PageMutationRequest {
            target: target.clone(),
            page_id: page_id.clone(),
            expected_page_revision: page.page_revision,
            mutation: VibePageMutationV1::SetFocus { block_id: None },
        }).unwrap(),
        "page_export": serde_json::to_value(PageExportRequest {
            project_id: target.project_id,
            expected_profile_revision: target.expected_profile_revision,
            page_id,
            expected_page_revision: page.page_revision,
        }).unwrap(),
    });

    let snapshot_json = serde_json::to_value(snapshot).unwrap();
    assert_eq!(
        snapshot_json["contract"],
        "rho.ui.project-profile.snapshot.v1"
    );
    assert_eq!(snapshot_json["profile"]["schema_version"], 3);
    assert_eq!(requests["set_mode"]["mode"], "vibe");
    assert_eq!(requests["page_mutation"]["mutation"]["kind"], "set_focus");
    assert!(requests["page_mutation"]["mutation"]["block_id"].is_null());
    assert_eq!(
        requests["page_export"]["expected_profile_revision"],
        snapshot_json["profile"]["revision"]
    );
    assert_javascript_safe_numbers(&snapshot_json);
    assert_javascript_safe_numbers(&requests);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn profile_typescript_export() {
    let output_path = std::env::var_os("RHO_PROFILE_BINDINGS_PATH")
        .expect("RHO_PROFILE_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .typ::<ProjectUiProfileSnapshotV1>()
        .commands(tauri_specta::collect_commands![
            crate::ui_profile::ui_profile_snapshot,
            crate::ui_profile::ui_profile_set_mode,
            crate::ui_profile::ui_profile_select_scene,
            crate::ui_profile::ui_profile_select_page,
            crate::ui_profile::ui_profile_page_apply,
            crate::ui_profile::ui_profile_page_export,
            crate::ui_profile::ui_profile_scene_duplicate,
            crate::ui_profile::ui_profile_scene_save,
            crate::ui_profile::ui_profile_scene_rename,
            crate::ui_profile::ui_profile_scene_delete,
            crate::ui_profile::ui_profile_scene_reset,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Profile TypeScript export must succeed");
}
