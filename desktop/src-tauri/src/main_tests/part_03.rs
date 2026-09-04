
#[test]
fn retry_source_and_conversation_delete_are_exact_and_project_scoped() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let project_a = project_a.canonicalize().unwrap();
        let project_b = project_b.canonicalize().unwrap();
        let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
        let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&root_a)).unwrap();
        for (root, conversation, turn, path) in [
            (&root_a, "conversation-delete", "turn-delete", "analysis.R"),
            (&root_a, "conversation-keep", "turn-keep", "keep.R"),
            (
                &root_b,
                "conversation-other-project",
                "turn-other-project",
                "other.R",
            ),
        ] {
            store
                .create_agent_turn_with_conversation(
                    &AgentConversationDraft {
                        conversation_id: conversation.to_string(),
                        project_root: root.to_string(),
                        title: format!("Conversation {conversation}"),
                        legacy_unthreaded: false,
                    },
                    &AgentTurnDraft {
                        turn_id: turn.to_string(),
                        project_root: root.to_string(),
                        prompt: format!("Edit {path}"),
                        model: "test-model".to_string(),
                        workspace_id: "ws-file-test".to_string(),
                        state_revision_before: 0,
                        project_revision_before: 0,
                    },
                )
                .unwrap();
            store
                .append_agent_turn_event(&AgentTurnEventDraft {
                    turn_id: turn.to_string(),
                    event_type: "agent.user_prompt".to_string(),
                    title: "You".to_string(),
                    body: Some(format!("Edit {path}")),
                    status: "completed".to_string(),
                    tool: None,
                    request_id: None,
                    code: None,
                    details_json: json!({"conversation_id": conversation}).to_string(),
                })
                .unwrap();
            store
                .finish_agent_turn(&AgentTurnFinish {
                    turn_id: turn.to_string(),
                    status: "completed".to_string(),
                    terminal_reason: Some("completed".to_string()),
                    workspace_id_after: Some("ws-file-test".to_string()),
                    state_revision_after: Some(0),
                    project_revision_after: Some(0),
                    final_message: Some("Done".to_string()),
                    error_message: None,
                })
                .unwrap();
        }

        let source = agent_retry_source(&store, &root_a, "turn-delete").unwrap();
        assert_eq!(source.prompt, "Edit analysis.R");
        assert_eq!(source.conversation_id, "conversation-delete");
        assert!(agent_retry_source(&store, &root_b, "turn-delete").is_err());
        drop(store);

        let state = test_app_state(tempdir.path(), &project_a, &store_path);
        let deleted = delete_agent_conversation_state("conversation-delete", &state)
            .await
            .unwrap();
        assert_eq!(deleted["deleted_turns"], 1);
        let store = Store::open(&store_path).unwrap();
        assert!(
            store
                .get_agent_conversation(&root_a, "conversation-delete")
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .get_agent_conversation(&root_a, "conversation-keep")
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .get_agent_conversation(&root_b, "conversation-other-project")
                .unwrap()
                .is_some()
        );
        assert!(
            delete_agent_conversation_state("conversation-other-project", &state)
                .await
                .is_err()
        );
    });
}

#[test]
fn cancelling_one_agent_turn_preserves_the_other_task() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&normalized_root)).unwrap();
        for (turn_id, conversation_id) in [
            ("turn-cancel-a", "conversation-cancel-a"),
            ("turn-cancel-b", "conversation-cancel-b"),
        ] {
            store
                .create_agent_turn_with_conversation(
                    &AgentConversationDraft {
                        conversation_id: conversation_id.to_string(),
                        project_root: normalized_root.clone(),
                        title: format!("Conversation {conversation_id}"),
                        legacy_unthreaded: false,
                    },
                    &AgentTurnDraft {
                        turn_id: turn_id.to_string(),
                        project_root: normalized_root.clone(),
                        prompt: format!("prompt for {turn_id}"),
                        model: "test".to_string(),
                        workspace_id: "ws-test".to_string(),
                        state_revision_before: 1,
                        project_revision_before: 1,
                    },
                )
                .unwrap();
        }
        drop(store);

        let state = test_app_state(tempdir.path(), &project_root, &store_path);
        for (turn_id, conversation_id) in [
            ("turn-cancel-a", "conversation-cancel-a"),
            ("turn-cancel-b", "conversation-cancel-b"),
        ] {
            let handle = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            state.agent_tasks.lock().await.insert(
                turn_id.to_string(),
                AgentTaskEntry {
                    conversation_id: conversation_id.to_string(),
                    handle,
                },
            );
        }

        let response = cancel_agent_turn_state("turn-cancel-a".to_string(), &state)
            .await
            .unwrap();
        assert_eq!(response.turn_id, "turn-cancel-a");
        assert!(state.agent_tasks.lock().await.contains_key("turn-cancel-b"));

        let store = Store::open(&store_path).unwrap();
        let cancelled = store
            .get_agent_turn_detail(&normalized_root, "turn-cancel-a")
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.turn.status, "interrupted");
        assert_eq!(
            cancelled.turn.terminal_reason.as_deref(),
            Some("user_cancelled")
        );
        let preserved = store
            .get_agent_turn_detail(&normalized_root, "turn-cancel-b")
            .unwrap()
            .unwrap();
        assert_eq!(preserved.turn.status, "running");
        drop(store);

        if let Some(task) = state.agent_tasks.lock().await.remove("turn-cancel-b") {
            task.handle.abort();
        }
    });
}

#[test]
fn stopping_multiple_agent_tasks_persists_each_terminal_reason_once() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&normalized_root)).unwrap();
        for turn_id in ["turn-shutdown-a", "turn-shutdown-b"] {
            store
                .create_agent_turn(&AgentTurnDraft {
                    turn_id: turn_id.to_string(),
                    project_root: normalized_root.clone(),
                    prompt: format!("prompt for {turn_id}"),
                    model: "test".to_string(),
                    workspace_id: "ws-test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 1,
                })
                .unwrap();
        }
        drop(store);

        let state = test_app_state(tempdir.path(), &project_root, &store_path);
        for (turn_id, conversation_id) in [
            ("turn-shutdown-a", "conversation-a"),
            ("turn-shutdown-b", "conversation-b"),
        ] {
            let handle = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            state.agent_tasks.lock().await.insert(
                turn_id.to_string(),
                AgentTaskEntry {
                    conversation_id: conversation_id.to_string(),
                    handle,
                },
            );
        }

        assert_eq!(
            interrupt_all_agent_tasks(&state, "desktop_shutdown", "Rho is closing for the test.",)
                .await
                .unwrap(),
            2
        );
        assert!(state.agent_tasks.lock().await.is_empty());
        let store = Store::open(&store_path).unwrap();
        let first_finished_at = store
            .get_agent_turn_detail(&normalized_root, "turn-shutdown-a")
            .unwrap()
            .unwrap()
            .turn
            .finished_at
            .unwrap();
        for turn_id in ["turn-shutdown-a", "turn-shutdown-b"] {
            let detail = store
                .get_agent_turn_detail(&normalized_root, turn_id)
                .unwrap()
                .unwrap();
            assert_eq!(detail.turn.status, "interrupted");
            assert_eq!(
                detail.turn.terminal_reason.as_deref(),
                Some("desktop_shutdown")
            );
        }
        drop(store);

        assert_eq!(
            interrupt_all_agent_tasks(&state, "desktop_shutdown", "Rho is closing for the test.",)
                .await
                .unwrap(),
            0
        );
        let store = Store::open(&store_path).unwrap();
        assert_eq!(
            store
                .get_agent_turn_detail(&normalized_root, "turn-shutdown-a")
                .unwrap()
                .unwrap()
                .turn
                .finished_at
                .as_deref(),
            Some(first_finished_at.as_str())
        );
    });
}

#[test]
fn project_switch_preflight_blocks_active_agent_turn() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        store.set_project_root(Some(&normalized_root)).unwrap();
        let state = test_app_state(tempdir.path(), &project_root, &store_path);
        for (turn_id, conversation_id) in [
            ("turn-running-a", "conversation-running-a"),
            ("turn-running-b", "conversation-running-b"),
        ] {
            let handle = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            state.agent_tasks.lock().await.insert(
                turn_id.to_string(),
                AgentTaskEntry {
                    conversation_id: conversation_id.to_string(),
                    handle,
                },
            );
        }

        let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
        assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentTurn);
        assert_eq!(blocker.pending_count, 2);
        assert!(matches!(
            blocker.turn_id.as_deref(),
            Some("turn-running-a" | "turn-running-b")
        ));

        let tasks = state.agent_tasks.lock().await.drain().collect::<Vec<_>>();
        for (_, task) in tasks {
            task.handle.abort();
        }
    });
}

#[test]
fn project_switch_preflight_blocks_canonical_environment_operation() {
    let durable = rho_store::ProjectTransitionSnapshot {
        active_project_root: "/projects/a".to_string(),
        active_run_id: None,
        environment_operation: Some(rho_store::EnvironmentOperationActivity {
            operation_id: "environment-operation-1".to_string(),
            status: "reconcile_required".to_string(),
        }),
    };
    let blocker = environment_operation_switch_blocker(&durable).unwrap();
    assert_eq!(blocker.kind, ProjectSwitchBlockerKind::EnvironmentOperation);
    assert_eq!(
        blocker.request_id.as_deref(),
        Some("environment-operation-1")
    );
    assert_eq!(
        blocker.operation_status.as_deref(),
        Some("reconcile_required")
    );
}

#[test]
fn project_switch_preflight_allows_clean_project() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        store.set_project_root(Some(&normalized_root)).unwrap();
        let state = test_app_state(tempdir.path(), &project_root, &store_path);

        assert!(project_switch_blocker(&state).await.unwrap().is_none());
    });
}

#[test]
fn project_switch_commits_only_after_full_chain_success() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
        let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
        store.set_project_root(Some(&root_a)).unwrap();
        let state = test_app_state(tempdir.path(), &project_a, &store_path);
        save_session_fixture(&state, &project_a, "old.R", 210);
        let target_session = save_session_fixture(&state, &project_b, "new.R", 260);
        state
            .switch_test_control
            .succeed_without_running(SwitchTestStep::SyncWorkspace);

        let response = switch_project_with_watcher_factory(
            project_b.clone(),
            Some(target_session.clone()),
            &state,
            |_| Ok(ProjectWatcherControl::noop()),
        )
        .await
        .unwrap();

        assert_eq!(response.status, "ready");
        assert_eq!(response.session.active_document.as_deref(), Some("new.R"));
        assert_eq!(
            state
                .project_root
                .read()
                .await
                .to_string_lossy()
                .replace('\\', "/"),
            project_b.to_string_lossy().replace('\\', "/")
        );
        let active_root = Store::open(&store_path)
            .unwrap()
            .active_project_root()
            .unwrap()
            .unwrap();
        assert_eq!(active_root, root_b);
        let last_opened = state
            .project_store
            .last_opened_project()
            .unwrap()
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(last_opened, project_b.to_string_lossy().replace('\\', "/"));
        assert!(state.extension_host.scopes().project().is_none());
        assert_eq!(
            state.extension_host.scopes().application().state(),
            ScopeLifecycleState::Active
        );
    });
}

#[test]
fn candidate_project_scope_tracks_a_b_a_with_fresh_generations() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let tempdir = TempDir::new().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
        Store::open(&store_path)
            .unwrap()
            .set_project_root(Some(&root_a))
            .unwrap();
        let state = test_app_state_with_extension_mode(
            tempdir.path(),
            &project_a,
            &store_path,
            InternalExtensionRuntimeMode::Candidate,
        );

        for target in [&project_a, &project_b, &project_a] {
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            let response =
                switch_project_with_watcher_factory(target.to_path_buf(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();
            assert_eq!(response.status, "ready");
        }

        let final_scope = state.extension_host.scopes().project().unwrap();
        assert_eq!(final_scope.state(), ScopeLifecycleState::Active);
        let expected_id = format!("project.{}", text_sha256(&root_a));
        assert_eq!(final_scope.identity().id.as_str(), expected_id);
        assert_eq!(final_scope.identity().generation.get(), 4);
    });
}

#[test]
fn run_history_plugin_descriptor_is_fixed_and_permission_free() {
    let plugin = super::RunHistoryPlugin::new();
    let descriptor = plugin.descriptor();
    assert_eq!(descriptor.id.as_str(), "org.yulab.rho.run-history");
    assert_eq!(
        descriptor.allowed_scopes,
        vec![rho_extension_runtime::ScopePolicy::project_kind()]
    );
    assert_eq!(descriptor.provides.len(), 1);
    assert_eq!(
        descriptor.provides[0].capability_id.as_str(),
        "source.project.run-history"
    );
    assert_eq!(descriptor.provides[0].contract_major.get(), 1);
    assert_eq!(descriptor.requires.len(), 1);
    assert_eq!(
        descriptor.requires[0].capability_id.as_str(),
        "service.broker.runs"
    );
    assert_eq!(descriptor.requires[0].contract_major.get(), 1);
    let json = serde_json::to_value(descriptor).unwrap();
    assert!(json.get("permissions").is_none());
}
