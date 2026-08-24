use super::*;
use rho_ui_contract::{
    LayoutBasisV1, RuntimeAttachmentRequestV1, RuntimeDetachRequestV1, RuntimeInstanceRequestV1,
    SceneEditRequestV1, SceneEditV1, StudioRevisionRequestV1, SurfaceInstanceDispositionV1,
    SurfaceInstanceMutationV1, SurfacePlacementIntentV1,
};

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
fn surface_studio_ipc_serialization_matches_generated_contract() {
    let fixture = rho_ui_contract::golden_contract_fixture();
    let surface = &fixture.surface_runtime_snapshot;
    let studio = &fixture.studio_runtime_snapshot;
    let factory = &surface.catalog.factories[0];
    let instance = &surface.catalog.instances[0];
    let target = SurfaceInstanceRequestV1 {
        project_id: surface.project_id.clone(),
        instance_id: instance.instance_id.clone(),
        activation_generation: instance.activation_generation,
        expected_project_revision: surface.project_revision,
        expected_surface_revision: instance.surface_revision,
    };
    let open = OpenSurfaceRequestV1 {
        surface_id: factory.definition.surface_id.clone(),
        project_id: surface.project_id.clone(),
        mode_id: None,
        resource_binding: None,
        runtime_binding: None,
        view_group_id: None,
        view_state: serde_json::json!({"selection": [1, 2]}),
        instance_disposition: SurfaceInstanceDispositionV1::NewInstance,
        placement_intent: SurfacePlacementIntentV1::Beside,
        expected_project_revision: surface.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
    };
    let update = UpdateSurfaceRequestV1 {
        target: target.clone(),
        mutation: SurfaceInstanceMutationV1::SetViewState {
            view_state: serde_json::json!({"zoom": 1.25}),
        },
    };
    let edit = SceneEditRequestV1 {
        project_id: studio.project_id.clone(),
        expected_project_revision: studio.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
        edit: SceneEditV1::SetChildBasis {
            container_node_id: studio.scene.root.node_id().clone(),
            child_index: 0,
            basis: LayoutBasisV1::Fraction { weight: 2 },
        },
    };
    let revision = StudioRevisionRequestV1 {
        project_id: studio.project_id.clone(),
        expected_project_revision: studio.project_revision,
        expected_layout_revision: studio.scene.layout_revision,
    };
    let runtime = RuntimeInstanceRequestV1 {
        project_id: surface.project_id.clone(),
        runtime_provider_id: rho_ui_contract::RuntimeProviderId::new("rho.ark-r").unwrap(),
        runtime_instance_id: rho_ui_contract::RuntimeInstanceId::new("runtime.workspace-r")
            .unwrap(),
        activation_generation: 3,
        expected_project_revision: surface.project_revision,
        expected_state_revision: 11,
    };
    let requests = serde_json::json!({
        "open": serde_json::to_value(open).unwrap(),
        "update": serde_json::to_value(update).unwrap(),
        "target": serde_json::to_value(&target).unwrap(),
        "edit": serde_json::to_value(edit).unwrap(),
        "revision": serde_json::to_value(revision).unwrap(),
        "attach": serde_json::to_value(RuntimeAttachmentRequestV1 {
            runtime,
            surface: target.clone(),
        }).unwrap(),
        "detach": serde_json::to_value(RuntimeDetachRequestV1 { surface: target }).unwrap(),
    });

    assert_eq!(requests["open"]["instance_disposition"], "new_instance");
    assert_eq!(requests["open"]["placement_intent"], "beside");
    assert_eq!(requests["update"]["mutation"]["kind"], "set_view_state");
    assert_eq!(requests["edit"]["edit"]["kind"], "set_child_basis");
    assert_eq!(requests["edit"]["edit"]["basis"]["kind"], "fraction");
    assert_eq!(
        requests["attach"]["surface"]["instance_id"],
        instance.instance_id.as_str()
    );

    let surface_json = serde_json::to_value(surface).unwrap();
    let studio_json = serde_json::to_value(studio).unwrap();
    assert_eq!(
        surface_json["contract"],
        "rho.ui.surface-runtime.snapshot.v1"
    );
    assert_eq!(studio_json["contract"], "rho.ui.studio-runtime.snapshot.v1");
    assert!(surface_json["catalog"]["factories"].is_array());
    assert!(studio_json["scene"]["root"]["kind"].is_string());
    assert_javascript_safe_numbers(&surface_json);
    assert_javascript_safe_numbers(&studio_json);
    assert_javascript_safe_numbers(&requests);
}

#[test]
#[ignore = "writes the requested generated TypeScript contract"]
fn surface_studio_typescript_export() {
    let output_path = std::env::var_os("RHO_SURFACE_STUDIO_BINDINGS_PATH")
        .expect("RHO_SURFACE_STUDIO_BINDINGS_PATH must name the generated file");
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::surface_runtime::surface_list,
            crate::surface_runtime::surface_open,
            crate::surface_runtime::surface_update,
            crate::surface_runtime::surface_close,
            crate::surface_runtime::surface_suspend,
            crate::surface_runtime::surface_resume,
            crate::studio_runtime::studio_scene,
            crate::studio_runtime::studio_apply,
            crate::studio_runtime::studio_undo,
            crate::studio_runtime::studio_redo,
            crate::runtime_registry::runtime_attach,
            crate::runtime_registry::runtime_detach,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .export(specta_typescript::Typescript::default(), output_path)
        .expect("Surface and Studio TypeScript export must succeed");
}
