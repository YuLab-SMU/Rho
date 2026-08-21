use rho_store::{
    PluginLifecycleMutationOutcome, PluginLifecycleMutationService, PluginLifecycleQueryService,
    Store, WorkspacePluginDiscoveredDraft, WorkspacePluginTransitionDraft,
};

fn digest(value: char) -> String {
    value.to_string().repeat(64)
}

fn discovered(project_root: &str) -> WorkspacePluginDiscoveredDraft {
    WorkspacePluginDiscoveredDraft {
        project_root: project_root.to_string(),
        plugin_id: "org.example.plugin".to_string(),
        directory_name: "example".to_string(),
        plugin_version: "1.0.0".to_string(),
        runtime_kind: "wasm".to_string(),
        discovered_digest: digest('a'),
    }
}

#[test]
fn lifecycle_service_isolates_two_projects_and_reopens_generation_truth() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("rho.sqlite");
    let mut store = Store::open(&database).unwrap();
    for project in ["/project/a", "/project/b"] {
        PluginLifecycleMutationService::new(&mut store)
            .discover(project, &discovered(project))
            .unwrap();
    }
    let transition = WorkspacePluginTransitionDraft {
        transition_id: "transition.enable.a".to_string(),
        project_root: "/project/a".to_string(),
        plugin_id: "org.example.plugin".to_string(),
        kind: "enable".to_string(),
        request_event_type: "user_requested".to_string(),
        desired_state: "enabled".to_string(),
        expected_old_digest: None,
        candidate_digest: Some(digest('a')),
        rollback_digest: None,
        backup_path_key: None,
    };
    assert_eq!(
        PluginLifecycleMutationService::new(&mut store)
            .request_transition("/project/a", &transition)
            .unwrap()
            .outcome,
        PluginLifecycleMutationOutcome::Applied
    );
    assert_eq!(
        PluginLifecycleMutationService::new(&mut store)
            .allocate_generation("/project/a", "org.example.plugin", "transition.enable.a", 0,)
            .unwrap()
            .generation,
        1
    );
    assert_eq!(
        PluginLifecycleQueryService::new(&store)
            .list_states("/project/a", None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        PluginLifecycleQueryService::new(&store)
            .list_states("/project/b", None)
            .unwrap()[0]
            .last_activation_generation,
        0
    );
    drop(store);

    let reopened = Store::open(&database).unwrap();
    assert_eq!(
        PluginLifecycleQueryService::new(&reopened)
            .get_state("/project/a", "org.example.plugin")
            .unwrap()
            .unwrap()
            .last_activation_generation,
        1
    );
    assert!(
        PluginLifecycleQueryService::new(&reopened)
            .get_transition("/project/b", "transition.enable.a")
            .unwrap()
            .is_none()
    );
}

#[test]
fn lifecycle_service_rejects_blank_and_mismatched_projects_without_rows() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
    let draft = discovered("/project/a");
    assert!(
        PluginLifecycleMutationService::new(&mut store)
            .discover("", &draft)
            .is_err()
    );
    assert!(
        PluginLifecycleMutationService::new(&mut store)
            .discover("/project/b", &draft)
            .is_err()
    );
    assert!(
        PluginLifecycleQueryService::new(&store)
            .list_states("/project/a", None)
            .unwrap()
            .is_empty()
    );
}
