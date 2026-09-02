




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
                        turn_id: turn.to_string(),
                        event_type: "agent.user_prompt".to_string(),
                        title: "You".to_string(),
                        body: Some(format!("Edit {path}")),
                        status: "completed".to_string(),
                        tool: None,
                        request_id: None,
                        code: None,
                        details_json: json!({
                            "task_kind": "agent_turn",
                            "editor_context": if turn == "turn-delete" {
                                Some(json!({"active_path": "analysis.R", "selection_start": 0}))
                            } else {
                                None
                            }
                        })
                        .to_string(),
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
            assert_eq!(source.mode, "act");
            assert_eq!(source.task_kind, "agent_turn");
            assert_eq!(source.conversation_id, "conversation-delete");
            assert_eq!(source.editor_context.unwrap()["active_path"], "analysis.R");
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
    fn cancelling_one_agent_turn_preserves_the_other_task_and_waiter() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&normalized_root)).unwrap();
            for (turn_id, conversation_id, request_id) in [
                ("turn-cancel-a", "conversation-cancel-a", "request-cancel-a"),
                ("turn-cancel-b", "conversation-cancel-b", "request-cancel-b"),
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
                            mode: "ask".to_string(),
                            prompt: format!("prompt for {turn_id}"),
                            model: "test".to_string(),
                            workspace_id: "ws-test".to_string(),
                            state_revision_before: 1,
                            project_revision_before: 1,
                        },
                    )
                    .unwrap();
                store
                    .create_approval_request(&ApprovalRequestDraft {
                        request_id: request_id.to_string(),
                        turn_id: turn_id.to_string(),
                        project_root: normalized_root.clone(),
                        tool: "run_r".to_string(),
                        policy: "required".to_string(),
                        arguments_json: "{}".to_string(),
                        code: None,
                        workspace_id: "ws-test".to_string(),
                        state_revision: 1,
                        project_revision: 1,
                    })
                    .unwrap();
            }
            drop(store);

            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let receiver_a = state
                .approvals
                .register(
                    "request-cancel-a".to_string(),
                    Some("turn-cancel-a".to_string()),
                )
                .await;
            let mut receiver_b = state
                .approvals
                .register(
                    "request-cancel-b".to_string(),
                    Some("turn-cancel-b".to_string()),
                )
                .await;
            for (turn_id, conversation_id) in [
                ("turn-cancel-a", "conversation-cancel-a"),
                ("turn-cancel-b", "conversation-cancel-b"),
            ] {
                let handle =
                    tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
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
            assert_eq!(receiver_a.await.unwrap().decision, "cancel");
            assert!(state.agent_tasks.lock().await.contains_key("turn-cancel-b"));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), &mut receiver_b,)
                    .await
                    .is_err()
            );
            assert!(
                state
                    .approvals
                    .respond(
                        "request-cancel-b",
                        ApprovalResponseInput {
                            decision: "approve".to_string(),
                            reason: None,
                        },
                    )
                    .await
            );
            assert_eq!(receiver_b.await.unwrap().decision, "approve");

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
            assert_eq!(cancelled.approvals[0].status, "interrupted");
            let preserved = store
                .get_agent_turn_detail(&normalized_root, "turn-cancel-b")
                .unwrap()
                .unwrap();
            assert_eq!(preserved.turn.status, "running");
            assert_eq!(preserved.approvals[0].status, "waiting");
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
                        mode: "ask".to_string(),
                        prompt: format!("prompt for {turn_id}"),
                        model: "test".to_string(),
                        workspace_id: "ws-test".to_string(),
                        state_revision_before: 1,
                        project_revision_before: 1,
                    })
                    .unwrap();
            }
            store
                .create_approval_request(&ApprovalRequestDraft {
                    request_id: "request-shutdown-a".to_string(),
                    turn_id: "turn-shutdown-a".to_string(),
                    project_root: normalized_root.clone(),
                    tool: "run_r".to_string(),
                    policy: "required".to_string(),
                    arguments_json: "{}".to_string(),
                    code: None,
                    workspace_id: "ws-test".to_string(),
                    state_revision: 1,
                    project_revision: 1,
                })
                .unwrap();
            drop(store);

            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            for (turn_id, conversation_id) in [
                ("turn-shutdown-a", "conversation-a"),
                ("turn-shutdown-b", "conversation-b"),
            ] {
                let handle =
                    tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
                state.agent_tasks.lock().await.insert(
                    turn_id.to_string(),
                    AgentTaskEntry {
                        conversation_id: conversation_id.to_string(),
                        handle,
                    },
                );
            }

            assert_eq!(
                interrupt_all_agent_tasks(
                    &state,
                    "desktop_shutdown",
                    "Rho is closing for the test.",
                )
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
            let first = store
                .get_agent_turn_detail(&normalized_root, "turn-shutdown-a")
                .unwrap()
                .unwrap();
            assert_eq!(first.approvals[0].status, "interrupted");
            assert_eq!(
                first.approvals[0].continuation_outcome.as_deref(),
                Some("desktop_shutdown")
            );
            drop(store);

            assert_eq!(
                interrupt_all_agent_tasks(
                    &state,
                    "desktop_shutdown",
                    "Rho is closing for the test.",
                )
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
                let handle =
                    tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
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
    fn project_switch_preflight_blocks_waiting_approval() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            create_waiting_approval(
                &mut store,
                &normalized_root,
                "turn-approval",
                "req-approval",
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let _receiver = state
                .approvals
                .register(
                    "req-approval".to_string(),
                    Some("turn-approval".to_string()),
                )
                .await;

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::Approval);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-approval"));
            assert_eq!(blocker.request_id.as_deref(), Some("req-approval"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_canonical_environment_operation() {
        let durable = rho_store::ProjectTransitionSnapshot {
            active_project_root: "/projects/a".to_string(),
            active_run_id: None,
            waiting_approvals: Vec::new(),
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
    fn desktop_environment_apply_commits_receipt_and_stages_workspace_restart() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-environment-apply");
            let target_library = tempdir.path().join("user-library");
            std::fs::create_dir_all(&project_root).unwrap();
            std::fs::create_dir_all(&target_library).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&normalized_root)).unwrap();
            drop(store);
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let mut workspace_broker = rho_core::BrokerState::new("workspace_policy");
            for _ in 0..4 {
                let request = rho_core::ExecutionRequest::new(
                    rho_core::ExecutionOrigin::System,
                    rho_protocol::OperationClass::StateCapable,
                    rho_protocol::ExpectedWorkspace::default(),
                    "fixture",
                );
                workspace_broker.complete(&request);
            }
            workspace_broker.project_changed();
            workspace_broker.project_changed();
            let lane_executor = StoreExecutor::open(tempdir.path().join("lane.sqlite"))
                .await
                .unwrap();
            *state.context.lock().await = Some(Arc::new(WorkspaceBrokerLane::new(
                workspace_broker,
                lane_executor,
            )));
            let workspace = state.context.lock().await.as_ref().unwrap().identity();
            let plan = desktop_environment_plan_fixture(
                &normalized_root,
                target_library.to_string_lossy().as_ref(),
                2,
            );
            let review = crate::commands::environment::stage_environment_plan_for_review(
                &state,
                plan.clone(),
            )
            .await
            .unwrap();
            assert_eq!(
                review.pending_plan.as_ref().map(|plan| plan.plan_id.as_str()),
                Some(plan.plan_id.as_str())
            );
            assert!(review.latest_operation.is_none());
            let operation_id =
                rho_protocol::OperationId::new("operation_desktop_environment_apply").unwrap();
            let capability = rho_protocol::CapabilityId::new(
                rho_protocol::ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY,
            )
            .unwrap();
            let mut context =
                rho_control_plane::policy_context_fixture(capability, operation_id.clone());
            let expected = rho_protocol::ExpectedRevisions {
                workspace_id: rho_protocol::WorkspaceId::new(workspace.workspace_id.clone())
                    .unwrap(),
                kernel_instance_id: rho_protocol::KernelInstanceId::new(
                    workspace.kernel_instance_id.clone(),
                )
                .unwrap(),
                state_revision: rho_protocol::StateRevision(workspace.state_revision),
                project_revision: rho_protocol::ProjectRevision(workspace.project_revision),
            };
            context.expected_revisions = expected.clone();
            context.input.operation.expected_revisions = expected.clone();
            context.input.workspace_id = expected.workspace_id.clone();
            let arguments = rho_control_plane::environment_plan_arguments(&plan, &expected);
            context.input.arguments = arguments.clone();
            context.input.destination = rho_protocol::DestinationClass::LocalWorkspace;
            let semantic_path = tempdir.path().join("environment-semantic.sqlite");
            let (mut semantic, _) = rho_store::SemanticStore::open_app_local(
                tempdir.path(),
                &semantic_path,
            )
            .unwrap();
            let mut broker = rho_control_plane::BrokerAdmission::new(
                rho_control_plane::CapabilityRegistry::canonical().unwrap(),
                rho_protocol::StreamId::new("stream_desktop_environment_apply").unwrap(),
            );
            let outcome = broker
                .admit(
                    &mut semantic,
                    rho_control_plane::AdmissionRequest {
                        context,
                        normalized_arguments: arguments.clone(),
                        now_ms: 1_000,
                    },
                )
                .unwrap();
            let rho_control_plane::BrokerAdmissionOutcome::Ask {
                approval_binding, ..
            } = outcome
            else {
                panic!("Environment mutation must require exact approval")
            };
            let lease = broker
                .lease_from_approval(
                    &approval_binding.approval_id,
                    &arguments,
                    &expected,
                    rho_protocol::DestinationClass::LocalWorkspace,
                    1_001,
                )
                .unwrap();
            let health = crate::commands::environment::apply_environment_plan_with_ports(
                &state,
                lease,
                rho_control_plane::EnvironmentApplyRequest {
                    project_root: normalized_root.clone(),
                    plan,
                    expected_revisions: expected,
                    destination: rho_protocol::DestinationClass::LocalWorkspace,
                    now_ms: 1_002,
                },
                DesktopEnvironmentExecutionFixture,
                DesktopEnvironmentVerifierFixture {
                    project_root: normalized_root.clone(),
                    operation_id,
                },
            )
            .await
            .unwrap();

            assert_eq!(
                health.status,
                rho_ui_contract::EnvironmentHealthStatusViewV1::RestartRequired
            );
            assert!(health.workspace.restart_required);
            assert!(health.pending_plan.is_none());
            assert_eq!(
                health
                    .latest_operation
                    .as_ref()
                    .map(|operation| operation.status.as_str()),
                Some("succeeded")
            );
            let authority = Store::open(&store_path)
                .unwrap()
                .current_environment_state(&normalized_root)
                .unwrap()
                .unwrap();
            assert_eq!(
                authority.receipt.plan_id.as_str(),
                health
                    .latest_operation
                    .as_ref()
                    .unwrap()
                    .plan
                    .plan_id
            );
            assert_eq!(
                authority.binding.receipt_digest.as_str(),
                health
                    .workspace
                    .pending_receipt_digest
                    .as_deref()
                    .unwrap()
            );
        });
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
