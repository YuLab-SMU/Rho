    #[tokio::test]
    async fn plugin_runtime_context_does_not_wait_for_workspace_lane() {
        let directory = tempfile::tempdir().unwrap();
        let project_root = directory.path().join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let store_path = directory.path().join("rho.sqlite");
        let state = test_app_state(directory.path(), &project_root, &store_path);
        install_test_context(&state, Store::open(&store_path).unwrap()).await;

        let lane = active_context(&state).await.unwrap();
        let held_workspace = lane.lock().await;
        let context = tokio::time::timeout(
            Duration::from_millis(250),
            crate::commands::plugins::runtime_context(&state),
        )
        .await
        .expect("plugin runtime context waited for the held Workspace lane")
        .unwrap();

        assert_eq!(
            context.project_root,
            normalize_project_root(project_root.to_string_lossy().as_ref())
        );
        assert_eq!(
            context.workspace.as_ref().unwrap().workspace_id,
            "ws-file-test"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), lane.lock())
                .await
                .is_err(),
            "test did not keep the Workspace broker lane contended"
        );
        drop(held_workspace);
    }

    fn create_run_fixture(store: &mut Store, project_root: &str, run_id: &str, code: &str) {
        store
            .create_run(&RunDraft {
                run_id: run_id.to_string(),
                parent_run_id: None,
                project_root: project_root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "state_capable".to_string(),
                code: code.to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("console".to_string()),
                document_version: Some(1),
                workspace_id: format!("ws-{run_id}"),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store.update_run_status(run_id, "completed", None).unwrap();
    }

    fn add_agent_file_proposal(
        store: &mut Store,
        project_root: &str,
        conversation_id: &str,
        turn_id: &str,
        path: &str,
        operation: &str,
        content: &str,
        editor_context: Option<serde_json::Value>,
    ) -> i64 {
        store
            .create_agent_turn_with_conversation(
                &AgentConversationDraft {
                    conversation_id: conversation_id.to_string(),
                    project_root: project_root.to_string(),
                    title: format!("Conversation {conversation_id}"),
                    legacy_unthreaded: false,
                },
                &AgentTurnDraft {
                    turn_id: turn_id.to_string(),
                    project_root: project_root.to_string(),
                    mode: "act".to_string(),
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
                turn_id: turn_id.to_string(),
                event_type: "agent.user_prompt".to_string(),
                title: "You".to_string(),
                body: Some(format!("Edit {path}")),
                status: "completed".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: json!({
                    "task_kind": "agent_turn",
                    "editor_context": editor_context
                })
                .to_string(),
            })
            .unwrap();
        let event_id = store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: turn_id.to_string(),
                event_type: "tool.call_completed".to_string(),
                title: "Tool completed · propose_file_edit".to_string(),
                body: Some(
                    json!({
                        "kind": "rho.file_edit_proposal",
                        "path": path,
                        "operation": operation,
                        "content": content
                    })
                    .to_string(),
                ),
                status: "completed".to_string(),
                tool: Some("propose_file_edit".to_string()),
                request_id: None,
                code: None,
                details_json: json!({"success": true}).to_string(),
            })
            .unwrap();
        store
            .finish_agent_turn(&AgentTurnFinish {
                turn_id: turn_id.to_string(),
                status: "completed".to_string(),
                terminal_reason: Some("completed".to_string()),
                workspace_id_after: Some("ws-file-test".to_string()),
                state_revision_after: Some(0),
                project_revision_after: Some(0),
                final_message: Some("Proposal ready".to_string()),
                error_message: None,
            })
            .unwrap();
        event_id
    }

    fn add_agent_file_mutation_start(
        store: &mut Store,
        turn_id: &str,
        path: &str,
        proposal_event_id: i64,
        mutation_id: &str,
        expected_before: &str,
        intended_after: &str,
    ) {
        append_agent_file_mutation_event(
            store,
            turn_id,
            "file_edit.mutation_started",
            "Agent file mutation admitted",
            "running",
            path,
            "append",
            proposal_event_id,
            json!({
                "mutation_id": mutation_id,
                "action": "apply",
                "path": path,
                "operation": "append",
                "proposal_event_id": proposal_event_id,
                "expected_before_sha256": text_sha256(expected_before),
                "expected_before_absent": false,
                "intended_after_sha256": text_sha256(intended_after),
                "intended_after_absent": false
            }),
        )
        .unwrap();
    }

    async fn install_test_context(state: &AppState, mut store: Store) {
        let broker = BrokerState::new("ws-file-test");
        store.save_identity(broker.identity()).unwrap();
        let executor = store_executor(state).await.unwrap().clone();
        *state.context.lock().await = Some(Arc::new(WorkspaceBrokerLane::new(broker, executor)));
    }

    #[test]
    fn project_identity_persistence_rejection_preserves_truth_and_worker_recovers() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let executor = StoreExecutor::open(&store_path).await.unwrap();
            let mut broker = BrokerState::new("revision-worker-test");
            let initial_identity = broker.identity().clone();
            persist_workspace_identity(&executor, initial_identity.clone())
                .await
                .unwrap();

            let connection = rusqlite::Connection::open(&store_path).unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_workspace_identity_update
                     BEFORE UPDATE ON workspace_identity
                     BEGIN
                       SELECT RAISE(ABORT, 'injected identity persistence failure');
                     END;",
                )
                .unwrap();

            broker.project_changed();
            let next_identity = broker.identity().clone();
            let error = persist_workspace_identity(&executor, next_identity.clone())
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("injected identity persistence failure")
            );
            let durable_after_rejection = executor
                .run_service(|store| store.load_identity())
                .await
                .unwrap();
            assert_eq!(durable_after_rejection, Some(initial_identity));

            connection
                .execute_batch("DROP TRIGGER reject_workspace_identity_update;")
                .unwrap();
            persist_workspace_identity(&executor, next_identity.clone())
                .await
                .unwrap();
            let durable_after_retry = executor
                .run_service(|store| store.load_identity())
                .await
                .unwrap();
            assert_eq!(durable_after_retry, Some(next_identity));
        });
    }

    #[test]
    fn file_proposal_structure_rejects_empty_selection_and_invalid_cursor_range() {
        let empty_selection = PersistedAgentFileProposal {
            path: "scatter_plot_example.R".to_string(),
            operation: "replace_selection".to_string(),
            content: "replacement".to_string(),
            editor_context: Some(json!({
                "active_path": "scatter_plot_example.R",
                "selection_start": 527,
                "selection_end": 527,
                "selection_text": ""
            })),
        };
        let error = validate_persisted_agent_file_proposal_structure(&empty_selection).unwrap_err();
        assert!(error.to_string().contains("AGENT_FILE_PROPOSAL_INVALID"));
        assert!(error.to_string().contains("non-empty text"));

        let invalid_cursor = PersistedAgentFileProposal {
            operation: "insert_at_cursor".to_string(),
            editor_context: Some(json!({
                "active_path": "scatter_plot_example.R",
                "selection_start": 10,
                "selection_end": 12,
                "selection_text": "ab"
            })),
            ..empty_selection.clone()
        };
        assert!(
            validate_persisted_agent_file_proposal_structure(&invalid_cursor)
                .unwrap_err()
                .to_string()
                .contains("empty captured range")
        );

        let valid = PersistedAgentFileProposal {
            editor_context: Some(json!({
                "active_path": "scatter_plot_example.R",
                "selection_start": 10,
                "selection_end": 12,
                "selection_text": "ab"
            })),
            ..empty_selection
        };
        validate_persisted_agent_file_proposal_structure(&valid).unwrap();
    }

    #[test]
    fn file_proposal_turn_must_be_terminal_before_mutation_admission() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project_root = "D:/Rho/project";
        store
            .create_agent_turn_with_conversation(
                &AgentConversationDraft {
                    conversation_id: "conversation-running-proposal".to_string(),
                    project_root: project_root.to_string(),
                    title: "Running proposal".to_string(),
                    legacy_unthreaded: false,
                },
                &AgentTurnDraft {
                    turn_id: "turn-running-proposal".to_string(),
                    project_root: project_root.to_string(),
                    mode: "act".to_string(),
                    prompt: "Edit the file".to_string(),
                    model: "test-model".to_string(),
                    workspace_id: "ws-file-test".to_string(),
                    state_revision_before: 0,
                    project_revision_before: 0,
                },
            )
            .unwrap();

        let error =
            ensure_agent_file_proposal_turn_terminal(&store, project_root, "turn-running-proposal")
                .unwrap_err();
        assert!(error.to_string().contains("AGENT_FILE_TURN_ACTIVE"));

        store
            .finish_agent_turn(&AgentTurnFinish {
                turn_id: "turn-running-proposal".to_string(),
                status: "completed".to_string(),
                terminal_reason: Some("completed".to_string()),
                workspace_id_after: Some("ws-file-test".to_string()),
                state_revision_after: Some(0),
                project_revision_after: Some(0),
                final_message: Some("Proposal ready".to_string()),
                error_message: None,
            })
            .unwrap();
        ensure_agent_file_proposal_turn_terminal(&store, project_root, "turn-running-proposal")
            .unwrap();
    }

    fn create_waiting_approval(
        store: &mut Store,
        project_root: &str,
        turn_id: &str,
        request_id: &str,
    ) {
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.to_string(),
                project_root: project_root.to_string(),
                mode: "ask".to_string(),
                prompt: "Need approval".to_string(),
                model: "test-model".to_string(),
                workspace_id: "ws-1".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
            })
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: request_id.to_string(),
                turn_id: turn_id.to_string(),
                project_root: project_root.to_string(),
                tool: "write_file".to_string(),
                policy: "ask".to_string(),
                arguments_json: "{}".to_string(),
                code: None,
                workspace_id: "ws-1".to_string(),
                state_revision: 1,
                project_revision: 1,
            })
            .unwrap();
    }

    fn assert_run_summaries_equal(
        actual: Vec<rho_store::RunSummary>,
        expected: &[rho_store::RunSummary],
    ) {
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    fn save_session_fixture(
        state: &AppState,
        root: &Path,
        active_document: &str,
        left_panel: u32,
    ) -> ProjectSessionSnapshot {
        let snapshot = ProjectSessionSnapshot {
            open_documents: vec![],
            closed_documents: vec![],
            active_document: Some(active_document.to_string()),
            selected_agent_conversation_id: None,
            panels: crate::project::PanelSizes {
                left: Some(left_panel),
                right: Some(300),
                dock: Some(240),
            },
        };
        state.project_store.save_session(root, &snapshot).unwrap();
        snapshot
    }

    #[test]
    fn project_switch_preflight_blocks_active_run() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            store
                .create_run(&RunDraft {
                    run_id: "run-active".to_string(),
                    parent_run_id: None,
                    project_root: normalized_root.clone(),
                    origin: "user".to_string(),
                    request_type: "workspace.execute".to_string(),
                    operation_class: "scientific".to_string(),
                    code: "x <- 1".to_string(),
                    arguments_json: "{}".to_string(),
                    source_path: None,
                    execution_mode: Some("console".to_string()),
                    document_version: None,
                    workspace_id: "ws-1".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 1,
                    environment_snapshot_id: None,
                })
                .unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::ActiveRun);
            assert_eq!(blocker.run_id.as_deref(), Some("run-active"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_only_current_project_render_jobs() {
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
            state.render_jobs.lock().await.insert(
                "render_foreign".to_string(),
                render_job_fixture("render_foreign", "D:/other-project", "submitted"),
            );
            assert!(project_switch_blocker(&state).await.unwrap().is_none());

            state.render_jobs.lock().await.insert(
                "render_current".to_string(),
                render_job_fixture("render_current", &normalized_root, "submitted"),
            );
            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::ActiveRun);
            assert_eq!(blocker.run_id.as_deref(), Some("render_current"));
            assert_eq!(blocker.operation_status.as_deref(), Some("submitted"));
        });
    }

    #[test]
    fn agent_admission_allows_two_read_only_conversations_and_rejects_a_third() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let first = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let second = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let mut tasks = HashMap::from([(
                "turn-a".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-a".to_string(),
                    handle: first,
                },
            )]);
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-b"), "plan"),
                None
            );
            tasks.insert(
                "turn-b".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-b".to_string(),
                    handle: second,
                },
            );
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-c"), "ask"),
                Some("AGENT_CONCURRENCY_LIMIT: At most two Agent turns can run at once.")
            );
            for (_, task) in tasks {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn agent_admission_rejects_same_conversation_but_allows_bounded_parallel_act() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let first = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let tasks = HashMap::from([(
                "turn-a".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-a".to_string(),
                    handle: first,
                },
            )]);
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-a"), "plan"),
                Some(
                    "AGENT_CONVERSATION_BUSY: This Conversation already has an active Agent turn."
                )
            );
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-b"), "act"),
                None
            );
            for (_, task) in tasks {
                task.handle.abort();
            }

            let act = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let act_tasks = HashMap::from([(
                "turn-act".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-act".to_string(),
                    handle: act,
                },
            )]);
            assert_eq!(
                agent_turn_admission_error(&act_tasks, Some("conversation-b"), "ask"),
                None
            );
            for (_, task) in act_tasks {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn agent_file_lanes_are_per_path_and_block_project_switch_until_released() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            drop(store);
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            let first_lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let same_lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let other_lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0report.R"))
                .await;
            assert!(Arc::ptr_eq(&first_lane, &same_lane));
            assert!(!Arc::ptr_eq(&first_lane, &other_lane));
            let _first_guard = first_lane.lock().await;
            assert!(same_lane.try_lock().is_err());
            assert!(other_lane.try_lock().is_ok());

            let claim =
                state
                    .agent_file_mutations
                    .register(&normalized_root, "turn-file", "analysis.R");
            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentFileMutation);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-file"));
            assert_eq!(
                blocker.operation_status.as_deref(),
                Some("queued:analysis.R")
            );
            drop(claim);
            assert!(project_switch_blocker(&state).await.unwrap().is_none());
        });
    }

    #[test]
    fn project_transition_orders_file_claim_before_switch_preflight() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let project_a = project_a.canonicalize().unwrap();
            let file = project_a.join("analysis.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-transition",
                "turn-transition",
                "analysis.R",
                "append",
                "changed <- TRUE\n",
                None,
            );
            drop(store);

            let state = Arc::new(test_app_state(tempdir.path(), &project_a, &store_path));
            let lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let lane_guard = lane.lock().await;

            let apply_state = state.clone();
            let (apply_started_tx, apply_started_rx) = oneshot::channel();
            let apply = tokio::spawn(async move {
                let _ = apply_started_tx.send(());
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-transition".to_string(),
                        proposal_event_id: event_id,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(before)),
                        before_content: before.to_string(),
                    },
                    &apply_state,
                )
                .await
            });
            apply_started_rx.await.unwrap();
            // Do not infer Tokio lock acquisition order from spawn order. The
            // product invariant starts only after Apply has registered its
            // queued claim while waiting for the per-file lane.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if state
                        .agent_file_mutations
                        .blocker(&normalized_root)
                        .is_some()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("Agent file mutation claim was not registered before project switch preflight");

            let switch_state = state.clone();
            let (switch_started_tx, switch_started_rx) = oneshot::channel();
            let switch = tokio::spawn(async move {
                let _ = switch_started_tx.send(());
                switch_project_with_watcher_factory(project_b, None, &switch_state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
            });
            switch_started_rx.await.unwrap();

            let response = tokio::time::timeout(Duration::from_secs(5), switch)
                .await
                .expect("project switch did not reach its preflight")
                .unwrap()
                .unwrap();
            assert_eq!(response.status, "blocked");
            let blocker = response.blocker.unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentFileMutation);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-transition"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);

            assert_eq!(
                state
                    .agent_file_mutations
                    .cancel_queued_turn("turn-transition"),
                1
            );
            drop(lane_guard);
            let error = apply.await.unwrap().unwrap_err().to_string();
            assert!(error.contains("AGENT_FILE_CANCELLED"), "{error}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_none()
            );
        });
    }

    #[test]
    fn different_agent_files_reach_disk_without_waiting_for_the_global_context_lock() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let first_path = project_root.join("first.R");
            let second_path = project_root.join("second.R");
            let first_before = "first <- 1\n";
            let second_before = "second <- 1\n";
            std::fs::write(&first_path, first_before).unwrap();
            std::fs::write(&second_path, second_before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let first_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-first-file",
                "turn-first-file",
                "first.R",
                "append",
                "first_done <- TRUE\n",
                None,
            );
            let second_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-second-file",
                "turn-second-file",
                "second.R",
                "append",
                "second_done <- TRUE\n",
                None,
            );
            let state = Arc::new(test_app_state(tempdir.path(), &project_root, &store_path));
            install_test_context(&state, store).await;

            let context = active_context(&state).await.unwrap();
            let context_guard = context.lock().await;
            let first_state = state.clone();
            let second_state = state.clone();
            let first = tokio::spawn(async move {
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-first-file".to_string(),
                        proposal_event_id: first_event,
                        path: "first.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(first_before)),
                        before_content: first_before.to_string(),
                    },
                    &first_state,
                )
                .await
            });
            let second = tokio::spawn(async move {
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-second-file".to_string(),
                        proposal_event_id: second_event,
                        path: "second.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(second_before)),
                        before_content: second_before.to_string(),
                    },
                    &second_state,
                )
                .await
            });

            tokio::time::timeout(
                Duration::from_secs(30),
                state
                    .agent_file_apply_test_control
                    .wait_for_completed_disk_writes(2),
            )
            .await
            .expect("different file lanes were serialized behind the global context lock");
            assert!(
                std::fs::read_to_string(&first_path)
                    .unwrap()
                    .contains("first_done")
            );
            assert!(
                std::fs::read_to_string(&second_path)
                    .unwrap()
                    .contains("second_done")
            );

            drop(context_guard);
            assert!(first.await.unwrap().is_ok());
            assert!(second.await.unwrap().is_ok());
            let context = context.lock().await;
            assert_eq!(context.broker.identity().project_revision, 2);
        });
    }

    #[test]
    fn concurrent_same_file_agent_proposals_apply_once_and_mark_the_other_stale() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("analysis.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let first_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-file-a",
                "turn-file-a",
                "analysis.R",
                "append",
                "first <- TRUE\n",
                None,
            );
            let second_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-file-b",
                "turn-file-b",
                "analysis.R",
                "append",
                "second <- TRUE\n",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;
            let expected = text_sha256(before);

            let (first, second) = tokio::join!(
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-file-a".to_string(),
                        proposal_event_id: first_event,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(expected.clone()),
                        before_content: before.to_string(),
                    },
                    &state,
                ),
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-file-b".to_string(),
                        proposal_event_id: second_event,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(expected),
                        before_content: before.to_string(),
                    },
                    &state,
                )
            );
            assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
            let stale = first.err().or_else(|| second.err()).unwrap().to_string();
            assert!(stale.contains("AGENT_FILE_RESOURCE_STALE"), "{stale}");
            let content = std::fs::read_to_string(&file).unwrap();
            assert!(
                content == "value <- 1\nfirst <- TRUE\n"
                    || content == "value <- 1\nsecond <- TRUE\n"
            );
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_none()
            );

            let repository = store_executor(&state).await.unwrap().agent_repository();
            let mut stale_events = 0;
            for turn_id in ["turn-file-a", "turn-file-b"] {
                if let Some(detail) = repository
                    .get_turn_detail(normalized_root.clone(), turn_id.to_string())
                    .await
                    .unwrap()
                {
                    stale_events += detail
                        .events
                        .iter()
                        .filter(|event| event.event_type == "file_edit.resource_stale")
                        .count();
                }
            }
            assert_eq!(stale_events, 1);
        });
    }

    #[test]
    fn cancelling_a_queued_agent_file_claim_prevents_mutation_and_releases_the_claim() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("analysis.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-cancel-file",
                "turn-cancel-file",
                "analysis.R",
                "append",
                "cancelled <- TRUE\n",
                None,
            );
            let state = Arc::new(test_app_state(tempdir.path(), &project_root, &store_path));
            install_test_context(&state, store).await;
            let lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let lane_guard = lane.lock().await;
            let task_state = state.clone();
            let task = tokio::spawn(async move {
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-cancel-file".to_string(),
                        proposal_event_id: event_id,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(before)),
                        before_content: before.to_string(),
                    },
                    &task_state,
                )
                .await
            });
            for _ in 0..100 {
                if state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_some(),
                "the file mutation did not reach the queued lane"
            );
            assert_eq!(
                state
                    .agent_file_mutations
                    .cancel_queued_turn("turn-cancel-file"),
                1
            );
            drop(lane_guard);
            let error = task.await.unwrap().unwrap_err().to_string();
            assert!(error.contains("AGENT_FILE_CANCELLED"), "{error}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_none()
            );
            let detail = store_executor(&state)
                .await
                .unwrap()
                .agent_repository()
                .get_turn_detail(normalized_root, "turn-cancel-file".to_string())
                .await
                .unwrap()
                .unwrap();
            assert!(
                detail
                    .events
                    .iter()
                    .any(|event| event.event_type == "file_edit.cancelled")
            );
        });
    }

    #[test]
    fn incomplete_agent_file_mutations_reconcile_from_disk_once_and_per_project() {
        let tempdir = TempDir::new().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let project_a = project_a.canonicalize().unwrap();
        let project_b = project_b.canonicalize().unwrap();
        let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
        let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
        std::fs::write(project_a.join("recovered.R"), "before\nafter\n").unwrap();
        std::fs::write(project_a.join("not-applied.R"), "before\n").unwrap();
        std::fs::write(project_a.join("uncertain.R"), "different\n").unwrap();
        std::fs::write(project_b.join("foreign.R"), "before\nafter\n").unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&root_a)).unwrap();

        for (root, conversation, turn, path, mutation) in [
            (
                root_a.as_str(),
                "conversation-recovered",
                "turn-recovered",
                "recovered.R",
                "mutation-recovered",
            ),
            (
                root_a.as_str(),
                "conversation-not-applied",
                "turn-not-applied",
                "not-applied.R",
                "mutation-not-applied",
            ),
            (
                root_a.as_str(),
                "conversation-uncertain",
                "turn-uncertain",
                "uncertain.R",
                "mutation-uncertain",
            ),
            (
                root_b.as_str(),
                "conversation-foreign-recovery",
                "turn-foreign-recovery",
                "foreign.R",
                "mutation-foreign",
            ),
        ] {
            let proposal_event_id = add_agent_file_proposal(
                &mut store,
                root,
                conversation,
                turn,
                path,
                "append",
                "after\n",
                None,
            );
            add_agent_file_mutation_start(
                &mut store,
                turn,
                path,
                proposal_event_id,
                mutation,
                "before\n",
                "before\nafter\n",
            );
        }

        drop(store);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executor = runtime.block_on(StoreExecutor::open(&store_path)).unwrap();
        let summary = runtime
            .block_on(recover_incomplete_agent_file_mutations(
                &executor, &project_a, &root_a,
            ))
            .unwrap();
        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.not_applied, 1);
        assert_eq!(summary.uncertain, 1);
        assert_eq!(
            runtime
                .block_on(recover_incomplete_agent_file_mutations(
                    &executor, &project_a, &root_a,
                ))
                .unwrap(),
            Default::default()
        );
        let store = Store::open(&store_path).unwrap();
        let recovered = store
            .get_agent_turn_detail(&root_a, "turn-recovered")
            .unwrap()
            .unwrap();
        assert!(
            recovered
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.recovered")
        );
        let not_applied = store
            .get_agent_turn_detail(&root_a, "turn-not-applied")
            .unwrap()
            .unwrap();
        assert!(
            not_applied
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.mutation_not_applied")
        );
        let uncertain = store
            .get_agent_turn_detail(&root_a, "turn-uncertain")
            .unwrap()
            .unwrap();
        assert!(
            uncertain
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.outcome_uncertain")
        );
        let foreign = store
            .get_agent_turn_detail(&root_b, "turn-foreign-recovery")
            .unwrap()
            .unwrap();
        assert!(!foreign.events.iter().any(|event| matches!(
            event.event_type.as_str(),
            "file_edit.recovered"
                | "file_edit.mutation_not_applied"
                | "file_edit.outcome_uncertain"
        )));
    }

    #[test]
    fn incomplete_agent_file_recovery_rejection_preserves_pending_truth_and_retries() {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let project_root = project_root.canonicalize().unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        std::fs::write(project_root.join("recovered.R"), "before\nafter\n").unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&normalized_root)).unwrap();
        let proposal_event_id = add_agent_file_proposal(
            &mut store,
            &normalized_root,
            "conversation-recovery-rejection",
            "turn-recovery-rejection",
            "recovered.R",
            "append",
            "after\n",
            None,
        );
        add_agent_file_mutation_start(
            &mut store,
            "turn-recovery-rejection",
            "recovered.R",
            proposal_event_id,
            "mutation-recovery-rejection",
            "before\n",
            "before\nafter\n",
        );
        drop(store);

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executor = runtime.block_on(StoreExecutor::open(&store_path)).unwrap();
        let connection = rusqlite::Connection::open(&store_path).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_agent_file_recovery
                 BEFORE INSERT ON agent_turn_events
                 WHEN NEW.event_type = 'file_edit.recovered'
                 BEGIN
                   SELECT RAISE(ABORT, 'injected recovery persistence failure');
                 END;",
            )
            .unwrap();

        let error = runtime
            .block_on(recover_incomplete_agent_file_mutations(
                &executor,
                &project_root,
                &normalized_root,
            ))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected recovery persistence failure")
        );
        let detail = runtime
            .block_on(executor.agent_repository().get_turn_detail(
                normalized_root.clone(),
                "turn-recovery-rejection".to_string(),
            ))
            .unwrap()
            .unwrap();
        assert!(
            !detail
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.recovered")
        );

        connection
            .execute_batch("DROP TRIGGER reject_agent_file_recovery;")
            .unwrap();
        let recovered = runtime
            .block_on(recover_incomplete_agent_file_mutations(
                &executor,
                &project_root,
                &normalized_root,
            ))
            .unwrap();
        assert_eq!(recovered.recovered, 1);
        assert_eq!(
            runtime
                .block_on(recover_incomplete_agent_file_mutations(
                    &executor,
                    &project_root,
                    &normalized_root,
                ))
                .unwrap(),
            Default::default()
        );
    }
