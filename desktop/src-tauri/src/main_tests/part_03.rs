    #[test]
    fn agent_file_write_failures_record_safe_or_uncertain_terminal_truth() {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let project_root = project_root.canonicalize().unwrap();
        let file = project_root.join("analysis.R");
        std::fs::write(&file, "before\n").unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        let mut store = Store::open(tempdir.path().join("rho.sqlite")).unwrap();
        store.set_project_root(Some(&normalized_root)).unwrap();
        let proposal_event_id = add_agent_file_proposal(
            &mut store,
            &normalized_root,
            "conversation-write-failure",
            "turn-write-failure",
            "analysis.R",
            "append",
            "after\n",
            None,
        );

        add_agent_file_mutation_start(
            &mut store,
            "turn-write-failure",
            "analysis.R",
            proposal_event_id,
            "mutation-safe-failure",
            "before\n",
            "before\nafter\n",
        );
        let injected = anyhow::anyhow!("injected atomic write failure");
        let (safe_event, safe_error) = classify_agent_file_write_failure(
            &project_root,
            "turn-write-failure",
            "analysis.R",
            "append",
            proposal_event_id,
            "mutation-safe-failure",
            "apply",
            Some(&text_sha256("before\n")),
            false,
            &injected,
        );
        persist_agent_file_mutation_event_to_store(&mut store, safe_event).unwrap();
        assert!(safe_error.to_string().contains("AGENT_FILE_WRITE_FAILED"));

        add_agent_file_mutation_start(
            &mut store,
            "turn-write-failure",
            "analysis.R",
            proposal_event_id,
            "mutation-uncertain-failure",
            "before\n",
            "before\nafter\n",
        );
        std::fs::write(&file, "different\n").unwrap();
        let (uncertain_event, uncertain_error) = classify_agent_file_write_failure(
            &project_root,
            "turn-write-failure",
            "analysis.R",
            "append",
            proposal_event_id,
            "mutation-uncertain-failure",
            "apply",
            Some(&text_sha256("before\n")),
            false,
            &injected,
        );
        persist_agent_file_mutation_event_to_store(&mut store, uncertain_event).unwrap();
        assert!(
            uncertain_error
                .to_string()
                .contains("AGENT_FILE_OUTCOME_UNCERTAIN")
        );

        add_agent_file_mutation_start(
            &mut store,
            "turn-write-failure",
            "analysis.R",
            proposal_event_id,
            "mutation-postwrite-failure",
            "different\n",
            "different\nafter\n",
        );
        let (postwrite_event, postwrite_error) = classify_agent_file_postwrite_failure(
            "turn-write-failure",
            "analysis.R",
            "append",
            proposal_event_id,
            "mutation-postwrite-failure",
            "apply",
            &injected,
        );
        persist_agent_file_mutation_event_to_store(&mut store, postwrite_event).unwrap();
        assert!(
            postwrite_error
                .to_string()
                .contains("AGENT_FILE_OUTCOME_UNCERTAIN")
        );

        let detail = store
            .get_agent_turn_detail(&normalized_root, "turn-write-failure")
            .unwrap()
            .unwrap();
        assert_eq!(
            detail
                .events
                .iter()
                .filter(|event| event.event_type == "file_edit.mutation_failed")
                .count(),
            1
        );
        assert_eq!(
            detail
                .events
                .iter()
                .filter(|event| event.event_type == "file_edit.outcome_uncertain")
                .count(),
            2
        );
        let store_path = tempdir.path().join("rho.sqlite");
        drop(store);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executor = runtime.block_on(StoreExecutor::open(&store_path)).unwrap();
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

    #[test]
    fn agent_file_edit_uses_utf16_ranges_and_stale_undo_preserves_later_content() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("unicode.R");
            let before = "a😀b";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-unicode",
                "turn-unicode",
                "unicode.R",
                "replace_selection",
                "替换",
                Some(json!({
                    "active_path": "unicode.R",
                    "selection_start": 1,
                    "selection_end": 3,
                    "selection_text": "😀"
                })),
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-unicode".to_string(),
                    proposal_event_id: event_id,
                    path: "unicode.R".to_string(),
                    expected_disk_sha256: Some(text_sha256(before)),
                    before_content: before.to_string(),
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(applied.content.as_deref(), Some("a替换b"));
            assert_eq!((applied.start, applied.end), (1, 3));
            let applied_digest = applied.after_sha256.unwrap();

            let forged_undo = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-unicode".to_string(),
                    proposal_event_id: event_id,
                    path: "unicode.R".to_string(),
                    expected_after_sha256: applied_digest.clone(),
                    before_content: "forged <- TRUE\n".to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(
                forged_undo.contains("durable pre-Apply editor snapshot"),
                "{forged_undo}"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "a替换b");

            std::fs::write(&file, "later <- TRUE\n").unwrap();
            let error = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-unicode".to_string(),
                    proposal_event_id: event_id,
                    path: "unicode.R".to_string(),
                    expected_after_sha256: applied_digest,
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(error.contains("AGENT_FILE_RESOURCE_STALE"), "{error}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "later <- TRUE\n");
        });
    }

    #[test]
    fn agent_file_undo_restores_the_exact_unsaved_editor_snapshot() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("draft.R");
            let disk_before = "value <- 1\n";
            let editor_before = "value <- 1\nunsaved <- TRUE\n";
            std::fs::write(&file, disk_before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-draft",
                "turn-draft",
                "draft.R",
                "append",
                "agent <- TRUE\n",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-draft".to_string(),
                    proposal_event_id: event_id,
                    path: "draft.R".to_string(),
                    expected_disk_sha256: Some(text_sha256(disk_before)),
                    before_content: editor_before.to_string(),
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(
                applied.content.as_deref(),
                Some("value <- 1\nunsaved <- TRUE\nagent <- TRUE\n")
            );

            let undone = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-draft".to_string(),
                    proposal_event_id: event_id,
                    path: "draft.R".to_string(),
                    expected_after_sha256: applied.after_sha256.unwrap(),
                    before_content: editor_before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(undone.status, "undone");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), editor_before);
        });
    }

    #[test]
    fn agent_create_undo_deletes_exact_file_and_rejects_invalid_targets() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            std::fs::write(project_root.join("existing.R"), "original\n").unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let create_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-create",
                "turn-create",
                "created.R",
                "create",
                "created <- TRUE\n",
                None,
            );
            let existing_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-existing",
                "turn-existing",
                "existing.R",
                "create",
                "overwrite <- TRUE\n",
                None,
            );
            let missing_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-missing",
                "turn-missing",
                "missing.R",
                "append",
                "append <- TRUE\n",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_disk_sha256: None,
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap();
            assert!(project_root.join("created.R").is_file());
            let applied_digest = applied.after_sha256.clone().unwrap();
            let replay_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_disk_sha256: None,
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(replay_error.contains("AGENT_FILE_ALREADY_DECIDED"));
            let forged_undo_error = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_after_sha256: applied_digest.clone(),
                    before_content: "forged".to_string(),
                    created: true,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(forged_undo_error.contains("durable pre-Apply editor snapshot"));
            assert!(project_root.join("created.R").is_file());
            let undone = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_after_sha256: applied_digest.clone(),
                    before_content: String::new(),
                    created: true,
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(undone.status, "undone");
            assert!(!project_root.join("created.R").exists());
            let repeated_undo_error = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_after_sha256: applied_digest,
                    before_content: String::new(),
                    created: true,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(repeated_undo_error.contains("AGENT_FILE_ALREADY_DECIDED"));

            let existing_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-existing".to_string(),
                    proposal_event_id: existing_event,
                    path: "existing.R".to_string(),
                    expected_disk_sha256: None,
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(existing_error.contains("AGENT_FILE_RESOURCE_STALE"));
            assert_eq!(
                std::fs::read_to_string(project_root.join("existing.R")).unwrap(),
                "original\n"
            );

            let missing_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-missing".to_string(),
                    proposal_event_id: missing_event,
                    path: "missing.R".to_string(),
                    expected_disk_sha256: Some(text_sha256("")),
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(missing_error.contains("AGENT_FILE_RESOURCE_STALE"));

            let wrong_event_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-existing".to_string(),
                    proposal_event_id: existing_event + 10_000,
                    path: "existing.R".to_string(),
                    expected_disk_sha256: Some(text_sha256("original\n")),
                    before_content: "original\n".to_string(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(wrong_event_error.contains("proposal event was not found"));
            assert_eq!(
                std::fs::read_to_string(project_root.join("existing.R")).unwrap(),
                "original\n"
            );
        });
    }

    #[test]
    fn durable_file_mutation_state_rejects_noop_replay_and_unapplied_or_forged_undo() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("noop.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-noop",
                "turn-noop",
                "noop.R",
                "append",
                "",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;
            let digest = text_sha256(before);

            let unapplied_undo = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest.clone(),
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(unapplied_undo.contains("AGENT_FILE_NOT_APPLIED"));

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_disk_sha256: Some(digest.clone()),
                    before_content: before.to_string(),
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(applied.after_sha256.as_deref(), Some(digest.as_str()));

            let replay = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_disk_sha256: Some(digest.clone()),
                    before_content: before.to_string(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(replay.contains("AGENT_FILE_ALREADY_DECIDED"));

            let forged = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest.clone(),
                    before_content: "forged <- TRUE\n".to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(forged.contains("durable pre-Apply editor snapshot"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);

            undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest.clone(),
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap();
            let repeated_undo = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest,
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(repeated_undo.contains("AGENT_FILE_ALREADY_DECIDED"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        });
    }

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
            add_agent_file_proposal(
                &mut store,
                &root_a,
                "conversation-delete",
                "turn-delete",
                "analysis.R",
                "append",
                "one\n",
                Some(json!({"active_path": "analysis.R", "selection_start": 0})),
            );
            add_agent_file_proposal(
                &mut store,
                &root_a,
                "conversation-keep",
                "turn-keep",
                "keep.R",
                "create",
                "keep\n",
                None,
            );
            add_agent_file_proposal(
                &mut store,
                &root_b,
                "conversation-other-project",
                "turn-other-project",
                "other.R",
                "create",
                "other\n",
                None,
            );

            let source = agent_retry_source(&store, &root_a, "turn-delete").unwrap();
            assert_eq!(source.prompt, "Edit analysis.R");
            assert_eq!(source.mode, "act");
            assert_eq!(source.task_kind, "agent_turn");
            assert_eq!(source.conversation_id, "conversation-delete");
            assert_eq!(source.editor_context.unwrap()["active_path"], "analysis.R");
            assert!(agent_retry_source(&store, &root_b, "turn-delete").is_err());
            drop(store);

            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let claim = state
                .agent_file_mutations
                .register(&root_a, "turn-delete", "analysis.R");
            let blocked = delete_agent_conversation_state("conversation-delete", &state)
                .await
                .unwrap_err()
                .to_string();
            assert!(blocked.contains("file operation"), "{blocked}");
            drop(claim);

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
