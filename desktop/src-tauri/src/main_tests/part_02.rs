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

    #[allow(clippy::too_many_arguments)]


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
    fn agent_admission_allows_two_conversations_and_rejects_a_third() {
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
                agent_turn_admission_error(&tasks, Some("conversation-b")),
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
                agent_turn_admission_error(&tasks, Some("conversation-c")),
                Some("AGENT_CONCURRENCY_LIMIT: At most two Agent turns can run at once.")
            );
            for (_, task) in tasks {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn agent_admission_rejects_same_conversation_but_allows_bounded_parallel_turns() {
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
                agent_turn_admission_error(&tasks, Some("conversation-a")),
                Some(
                    "AGENT_CONVERSATION_BUSY: This Conversation already has an active Agent turn."
                )
            );
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-b")),
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
                agent_turn_admission_error(&act_tasks, Some("conversation-b")),
                None
            );
            for (_, task) in act_tasks {
                task.handle.abort();
            }
        });
    }





