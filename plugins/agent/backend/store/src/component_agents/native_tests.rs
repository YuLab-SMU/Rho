use super::*;
use std::sync::Arc;

struct Caller;
impl ComponentActorValidator for Caller {
    fn validate(&self, _: u64) -> Result<(), ComponentTaskError> {
        Ok(())
    }
}
fn origin() -> ComponentNativeRunOrigin {
    serde_json::from_value(serde_json::json!({
        "operation":"original-operation", "request":"original-request",
        "binding":{"capability":{"id":"agent.model.run","version":1},
            "provider":{"instance":"agent-one","plugin":"org.rho.agent",
                "revision":format!("sha256:{}", "a".repeat(64)),"artifact":format!("sha256:{}", "b".repeat(64))},
            "project":"native-project","target":null},
        "r":{"capability":{"id":"r.execute","version":2},
            "provider":{"instance":"r-instance","plugin":"org.fixture.runtime",
                "revision":format!("sha256:{}", "c".repeat(64)),"artifact":format!("sha256:{}", "d".repeat(64))},
            "project":"native-project","target":"r-session"}
    })).unwrap()
}
fn setup(store: Arc<AgentStore>) -> (ComponentAgentOwner, ComponentActor, StoredComponentRun) {
    let owner = ComponentAgentOwner::new(store, "process-one".into());
    let actor = ComponentActor::new(
        ApplicationScope {
            project: "/fixture".into(),
            principal: "user-one".into(),
        },
        ApplicationWindowRef {
            window_id: "window".into(),
            incarnation: "view-connection".into(),
        },
        Arc::new(Caller),
    );
    owner
        .configure(
            &actor,
            &ComponentModelSettings {
                version: 0,
                enabled: true,
                connection: Some(ComponentModelConnection {
                    protocol: ComponentModelProtocol::OpenaiCompletions,
                    base_url: "https://model.example/v1".into(),
                    model: "fixture".into(),
                    credential: ComponentCredentialRef::Environment {
                        name: "UNUSED_FIXTURE_KEY".into(),
                    },
                }),
            },
            1,
        )
        .unwrap();
    let conversation = owner
        .create(&actor, "task", ComponentAgentProfile::Project, 2)
        .unwrap();
    let request = ComponentAgentStart {
        request_id: "task-request".into(),
        conversation_id: conversation.conversation_id,
        conversation_version: conversation.version,
        window: actor.window().clone(),
        model_settings_version: 1,
        text: "Run the analysis".into(),
        assets: None,
        continuation: None,
        sources: vec![],
        grant: ComponentAgentGrant {
            mode: ComponentAgentMode::Run,
            permission_policy: None,
            session: Some(ComponentAgentSession {
                workspace_instance_id: "r-instance".into(),
                session_id: "r-session".into(),
            }),
            documents: vec![],
            files: vec![],
        },
    };
    let run = owner
        .start_native(&actor, request, origin(), 3)
        .unwrap()
        .run;
    (owner, actor, run)
}

#[test]
fn native_recovery_report_checks_controller_and_version_and_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent.sqlite");
    let store = Arc::new(AgentStore::open(&path).unwrap());
    let (owner, actor, run) = setup(store.clone());
    owner
        .finish(
            actor.scope(),
            &run.run.run_id,
            ComponentAgentRunState::Completed,
            None,
            4,
        )
        .unwrap();
    let conversation = store
        .component_conversation(actor.scope(), "task")
        .unwrap()
        .unwrap();
    let other = ComponentActor::new(
        actor.scope().clone(),
        ApplicationWindowRef {
            window_id: "another-window".into(),
            incarnation: "other-view".into(),
        },
        Arc::new(Caller),
    );
    assert!(matches!(
        owner.record_native_recovery(&other, &run.run.run_id, conversation.version, vec![], 5),
        Err(ComponentTaskError::Conflict)
    ));
    let saved = owner
        .save_draft_content(
            &actor,
            "task",
            conversation.draft_version,
            AgentDraftContent {
                text: "Retain next draft".into(),
                ..Default::default()
            },
            None,
            6,
        )
        .unwrap();
    assert!(matches!(
        owner.record_native_recovery(&actor, &run.run.run_id, conversation.version, vec![], 7),
        Err(ComponentTaskError::Conflict)
    ));
    assert!(
        store
            .component_run(actor.scope(), &run.run.run_id)
            .unwrap()
            .unwrap()
            .run
            .recovery
            .is_none()
    );
    let report = owner
        .record_native_recovery(&actor, &run.run.run_id, saved.version, vec![], 8)
        .unwrap();
    assert_eq!(report.recovery.as_ref().unwrap().unresolved_mutations, 0);
    let current = store
        .component_conversation(actor.scope(), "task")
        .unwrap()
        .unwrap();
    assert_eq!(current.draft_content.text, "Retain next draft");
    let repeated = owner
        .record_native_recovery(&actor, &run.run.run_id, current.version, vec![], 9)
        .unwrap();
    assert_eq!(repeated.event_cursor, report.event_cursor);
    drop(owner);
    drop(store);
    let reopened = AgentStore::open(&path).unwrap();
    assert_eq!(
        encode(
            &reopened
                .component_run(actor.scope(), &run.run.run_id)
                .unwrap()
                .unwrap()
                .run
                .recovery
        )
        .unwrap(),
        encode(&report.recovery).unwrap()
    );
}

#[test]
fn native_history_is_bounded_scoped_and_never_inherits_previous_authority() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let (owner, actor, mut previous) = setup(store.clone());
    let mut native_origin = origin();
    native_origin.r = None;
    for index in 0..10 {
        let at = 10 + index * 10;
        owner
            .claim(actor.scope(), &previous.run.run_id, at)
            .unwrap();
        owner
            .append_text(
                actor.scope(),
                &previous.run.run_id,
                "中文 Ω\n\"".repeat(600),
                at + 1,
            )
            .unwrap();
        owner
            .finish(
                actor.scope(),
                &previous.run.run_id,
                ComponentAgentRunState::Completed,
                None,
                at + 2,
            )
            .unwrap();
        let conversation = store
            .component_conversation(actor.scope(), "task")
            .unwrap()
            .unwrap();
        let mut request = previous.run.request.clone();
        request.request_id = format!("history-{index}");
        request.conversation_version = conversation.version;
        request.text = format!("Followup {index}: {}", "Ω\n\"".repeat(900));
        request.grant.mode = ComponentAgentMode::Explain;
        request.grant.session = None;
        let next = owner
            .start_native(&actor, request, native_origin.clone(), at + 3)
            .unwrap()
            .run;
        let history = next.run.context.as_ref().unwrap().history.as_ref().unwrap();
        let turns = history["turns"].as_array().unwrap();
        assert!(!turns.is_empty() && turns.len() <= 8);
        assert!(serde_json::to_vec(history).unwrap().len() <= 24 * 1024);
        assert_eq!(turns.last().unwrap()["run_id"], previous.run.run_id);
        assert_eq!(turns.last().unwrap()["text_truncated"], true);
        assert!(
            turns.last().unwrap()["assistant_text"]
                .as_str()
                .unwrap()
                .len()
                <= 4096
        );
        assert!(turns.last().unwrap()["user_text"].as_str().unwrap().len() <= 2048);
        assert!(next.run.task_intent.is_none());
        assert!(next.run.document_grants.is_empty());
        assert!(next.run.request.continuation.is_none());
        assert!(next.run.request.grant.session.is_none());
        assert!(next.native_origin.as_ref().unwrap().r.is_none());
        if index == 9 {
            assert_eq!(history["truncated"], true);
        }
        previous = next;
    }
    owner
        .finish(
            actor.scope(),
            &previous.run.run_id,
            ComponentAgentRunState::Completed,
            None,
            115,
        )
        .unwrap();
    let selections = (0..4)
        .map(|index| AgentContextSelection {
            source: "plugin".into(),
            label: format!("Source {index}"),
            reference: serde_json::json!({"version":7,"item":index}),
            inclusion: "{}".into(),
        })
        .collect::<Vec<_>>();
    let conversation = store
        .component_conversation(actor.scope(), "task")
        .unwrap()
        .unwrap();
    let saved = owner
        .save_draft_content(
            &actor,
            "task",
            conversation.draft_version,
            AgentDraftContent {
                text: "Keep this draft if the combined input is too large".into(),
                context: selections.clone(),
                assets: vec![],
            },
            None,
            116,
        )
        .unwrap();
    let context = ComponentAgentContext {
        history: None,
        sources: selections
            .iter()
            .map(|selection| ComponentSourceSnapshot {
                selection: selection.clone(),
                title: selection.label.clone(),
                description: String::new(),
                text: "x".repeat(15000),
                native_data: serde_json::Value::Null,
                truncated: false,
                observations: vec![],
                evidence: vec![],
            })
            .collect(),
    };
    assert!(serde_json::to_vec(&context).unwrap().len() < 65536);
    let mut oversized = previous.run.request.clone();
    oversized.request_id = "combined-context-budget".into();
    oversized.conversation_version = saved.version;
    oversized.text = saved.draft_content.text.clone();
    oversized.sources = selections;
    assert!(matches!(
        owner.start_native_captured(&actor, oversized, native_origin.clone(), context, 117),
        Err(ComponentTaskError::Budget(_))
    ));
    assert_eq!(
        encode(
            &store
                .component_conversation(actor.scope(), "task")
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        encode(&saved).unwrap()
    );
    assert!(
        store
            .component_run_by_request(actor.scope(), "combined-context-budget")
            .unwrap()
            .is_none()
    );
    // A different conversation shares the model settings, but no prior input.
    let isolated = owner
        .create(&actor, "separate", ComponentAgentProfile::Project, 120)
        .unwrap();
    let mut request = previous.run.request.clone();
    request.request_id = "isolated-request".into();
    request.conversation_id = isolated.conversation_id;
    request.conversation_version = isolated.version;
    let separate = owner
        .start_native(&actor, request, native_origin, 121)
        .unwrap()
        .run;
    assert!(separate.run.context.is_none());
}

#[test]
fn native_history_marks_unread_event_tail_without_inventing_a_storage_gap() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent.sqlite");
    let store = Arc::new(AgentStore::open(&path).unwrap());
    let (owner, actor, first) = setup(store.clone());
    owner.claim(actor.scope(), &first.run.run_id, 4).unwrap();
    owner
        .finish(
            actor.scope(),
            &first.run.run_id,
            ComponentAgentRunState::Completed,
            None,
            5,
        )
        .unwrap();
    let mut saved = store
        .component_run(actor.scope(), &first.run.run_id)
        .unwrap()
        .unwrap();
    saved.run.event_cursor = 513;
    // Inject a contiguous oversized event fixture without normal pruning. The
    // reader's four-page budget must be visible independently of storage gaps.
    let mut connection = rusqlite::Connection::open(&path).unwrap();
    let tx = connection.transaction().unwrap();
    tx.execute(
        "DELETE FROM component_agent_events WHERE run_id=?1",
        [&first.run.run_id],
    )
    .unwrap();
    tx.execute(
        "UPDATE component_agent_runs SET event_cursor=513,value=?1 WHERE run_id=?2",
        rusqlite::params![encode(&saved).unwrap(), first.run.run_id],
    )
    .unwrap();
    for sequence in 1..=513 {
        let event = serde_json::json!({"run_id":first.run.run_id,"sequence":sequence,"created_at_ms":5,"content":{"kind":"text","text":"Ω"}}).to_string();
        tx.execute("INSERT INTO component_agent_events(project,principal,conversation_id,run_id,sequence,bytes,value) VALUES(?1,?2,'task',?3,?4,?5,?6)", rusqlite::params![actor.scope().project,actor.scope().principal,first.run.run_id,sequence,event.len(),event]).unwrap();
    }
    tx.commit().unwrap();
    let conversation = store
        .component_conversation(actor.scope(), "task")
        .unwrap()
        .unwrap();
    let mut request = first.run.request.clone();
    request.request_id = "bounded-followup".into();
    request.conversation_version = conversation.version;
    let next = owner
        .start_native(&actor, request, origin(), 6)
        .unwrap()
        .run;
    let history = next.run.context.unwrap().history.unwrap();
    assert_eq!(history["turns"][0]["history_gap"], false);
    assert_eq!(history["turns"][0]["text_truncated"], true);
    assert_eq!(history["turns"][0]["assistant_text"], "Ω".repeat(512));
}

#[test]
fn native_parent_and_original_tool_request_survive_stop_late_receipt_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent.sqlite");
    let store = Arc::new(AgentStore::open(&path).unwrap());
    let (owner, actor, run) = setup(store.clone());
    let id = &run.run.run_id;
    owner.claim(actor.scope(), id, 4).unwrap();
    owner.begin_model_call(actor.scope(), id, 5).unwrap();
    let tool = owner.admit_tool(actor.scope(), id, 1, "model-tool-call", ComponentToolAction::PluginInvoke(PluginRequest {
        binding: origin().r.unwrap(),
        arguments: serde_json::json!({"expected_session":"r-session","run":{"code":"counter <- counter + 1"}}),
        preconditions: serde_json::Value::Null,
    }), 6).unwrap().tool;
    let reverse = RequestId::new(&tool.receipt.client_request_id).unwrap();
    assert_ne!(reverse.as_str(), "model-cannot-choose-this");
    owner.stop(&actor, id, 7).unwrap();
    owner
        .record_tool(
            actor.scope(),
            id,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(OperationId::new("child-operation").unwrap()),
                application_request_id: None,
            },
            8,
        )
        .unwrap();
    drop(owner);
    drop(store);
    let store = Arc::new(AgentStore::open(&path).unwrap());
    let reopened = ComponentAgentOwner::new(store.clone(), "process-two".into());
    let retained = store.component_run(actor.scope(), id).unwrap().unwrap();
    assert_eq!(retained.native_origin, Some(origin()));
    assert_eq!(retained.run.state, ComponentAgentRunState::Stopping);
    assert_eq!(
        reopened.observed_run(retained.clone()).state,
        ComponentAgentRunState::Interrupted
    );
    let tools = store.component_tools(actor.scope(), id).unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].receipt.client_request_id, reverse.as_str());
    assert_eq!(
        tools[0].receipt.operation_id.as_ref().unwrap().as_str(),
        "child-operation"
    );
    assert!(
        reopened
            .check_tool_dispatch(actor.scope(), id, &tool.receipt.receipt_id, 9)
            .is_err()
    );
    assert_eq!(
        encode(&store.component_run(actor.scope(), id).unwrap().unwrap()).unwrap(),
        encode(&retained).unwrap()
    );
    for foreign in [
        ApplicationScope {
            principal: "other-user".into(),
            ..actor.scope().clone()
        },
        ApplicationScope {
            project: "/other-project".into(),
            ..actor.scope().clone()
        },
    ] {
        assert!(store.component_run(&foreign, id).unwrap().is_none());
        assert!(store.component_tools(&foreign, id).unwrap().is_empty());
    }
}

#[test]
fn native_parent_cannot_be_replaced_or_removed_by_later_transaction() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let (_owner, actor, run) = setup(store.clone());
    let before = store
        .component_conversation(actor.scope(), "task")
        .unwrap()
        .unwrap();
    let mut conversation = before.clone();
    conversation.version += 1;
    conversation.title = "must roll back".into();
    for replacement in [
        None,
        Some(ComponentNativeRunOrigin {
            operation: OperationId::new("replacement-operation").unwrap(),
            ..origin()
        }),
    ] {
        let mut changed = run.clone();
        changed.native_origin = replacement;
        assert!(matches!(
            store.commit_component(
                actor.scope(),
                ComponentWrite {
                    expected_version: Some(before.version),
                    conversation: &conversation,
                    run: Some(&changed),
                    tools: &[],
                    events: &[],
                }
            ),
            Err(ApplicationError::RequestConflict)
        ));
        assert_eq!(
            encode(
                &store
                    .component_conversation(actor.scope(), "task")
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            encode(&before).unwrap()
        );
        assert_eq!(
            encode(
                &store
                    .component_run(actor.scope(), &run.run.run_id)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            encode(&run).unwrap()
        );
    }
}

#[test]
fn native_send_consumes_only_its_matching_draft_and_replay_preserves_next_input() {
    for matched in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent.sqlite");
        let store = Arc::new(AgentStore::open(&path).unwrap());
        let (owner, actor, original) = setup(store.clone());
        let conversation = owner
            .create(&actor, "draft-task", ComponentAgentProfile::Project, 4)
            .unwrap();
        let content = AgentDraftContent {
            text: "Submitted draft 中文 Ω".into(),
            ..Default::default()
        };
        owner
            .save_draft_content(
                &actor,
                "draft-task",
                conversation.draft_version,
                content.clone(),
                None,
                5,
            )
            .unwrap();
        let saved = store
            .component_conversation(actor.scope(), "draft-task")
            .unwrap()
            .unwrap();
        let request = ComponentAgentStart {
            request_id: "draft-request".into(),
            conversation_id: "draft-task".into(),
            conversation_version: saved.version,
            text: if matched {
                content.text.clone()
            } else {
                "Different explicitly submitted text".into()
            },
            ..original.run.request
        };
        let origin = ComponentNativeRunOrigin {
            operation: OperationId::new("draft-operation").unwrap(),
            request: RequestId::new("draft-request").unwrap(),
            ..origin()
        };
        let admitted = owner
            .start_native(&actor, request.clone(), origin.clone(), 6)
            .unwrap();
        let after = store
            .component_conversation(actor.scope(), "draft-task")
            .unwrap()
            .unwrap();
        assert_eq!(
            encode(&after.draft_content).unwrap(),
            encode(&if matched {
                AgentDraftContent::default()
            } else {
                content
            })
            .unwrap()
        );
        assert_eq!(
            after.draft_version,
            saved.draft_version + u64::from(matched)
        );
        assert_eq!(
            after.active_run_id.as_deref(),
            Some(admitted.run.run.run_id.as_str())
        );
        let next = AgentDraftContent {
            text: "Keep my next input".into(),
            ..Default::default()
        };
        owner
            .save_draft_content(
                &actor,
                "draft-task",
                after.draft_version,
                next.clone(),
                None,
                7,
            )
            .unwrap();
        let retained = store
            .component_conversation(actor.scope(), "draft-task")
            .unwrap()
            .unwrap();
        assert!(
            owner
                .start_native(&actor, request.clone(), origin.clone(), 8)
                .unwrap()
                .repeated
        );
        drop(owner);
        drop(store);
        let reopened = Arc::new(AgentStore::open(&path).unwrap());
        let owner = ComponentAgentOwner::new(reopened.clone(), "new-process".into());
        let repeated = owner.start_native(&actor, request, origin, 9).unwrap();
        assert!(repeated.repeated);
        assert_eq!(repeated.run.run.run_id, admitted.run.run.run_id);
        let current = reopened
            .component_conversation(actor.scope(), "draft-task")
            .unwrap()
            .unwrap();
        assert_eq!(
            encode(&current.draft_content).unwrap(),
            encode(&next).unwrap()
        );
        assert_eq!(current.version, retained.version);
        assert_eq!(current.draft_version, retained.draft_version);
    }
}

#[test]
fn native_capture_cannot_change_with_a_retained_request_digest() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(AgentStore::open(&directory.path().join("agent.sqlite")).unwrap());
    let (_owner, actor, run) = setup(store.clone());
    let before = store
        .component_conversation(actor.scope(), "task")
        .unwrap()
        .unwrap();
    let mut conversation = before.clone();
    conversation.version += 1;
    let mut changed = run.clone();
    changed
        .run
        .request
        .grant
        .session
        .as_mut()
        .unwrap()
        .session_id = "replacement-session".into();
    assert!(matches!(
        store.commit_component(
            actor.scope(),
            ComponentWrite {
                expected_version: Some(before.version),
                conversation: &conversation,
                run: Some(&changed),
                tools: &[],
                events: &[],
            }
        ),
        Err(ApplicationError::RequestConflict)
    ));
    assert_eq!(
        encode(
            &store
                .component_run(actor.scope(), &run.run.run_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        encode(&run).unwrap()
    );
    assert_eq!(
        encode(
            &store
                .component_conversation(actor.scope(), "task")
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        encode(&before).unwrap()
    );
}

#[test]
fn native_context_admission_consumes_matching_draft_and_retains_original_payload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent.sqlite");
    let store = Arc::new(AgentStore::open(&path).unwrap());
    let (owner, actor, original) = setup(store.clone());
    let conversation = owner
        .create(&actor, "context-task", ComponentAgentProfile::Project, 4)
        .unwrap();
    let selection = rho_agent_api::AgentContextSelection {
        source: "plugin".into(),
        label: "Captured source".into(),
        reference: serde_json::json!({"version":7}),
        inclusion: "{\"kind\":\"selection\"}".into(),
    };
    let draft = AgentDraftContent {
        text: "Explain captured text".into(),
        context: vec![selection.clone()],
        assets: vec![],
    };
    owner
        .save_draft_content(
            &actor,
            "context-task",
            conversation.draft_version,
            draft.clone(),
            None,
            5,
        )
        .unwrap();
    let saved = store
        .component_conversation(actor.scope(), "context-task")
        .unwrap()
        .unwrap();
    let request = ComponentAgentStart {
        request_id: "context-request".into(),
        conversation_id: "context-task".into(),
        conversation_version: saved.version,
        text: draft.text.clone(),
        sources: vec![selection.clone()],
        ..original.run.request
    };
    let context = ComponentAgentContext {
        history: None,
        sources: vec![ComponentSourceSnapshot {
            selection,
            title: "Source".into(),
            description: "Version 7".into(),
            text: "Original 中文 Ω".into(),
            native_data: serde_json::json!({"version":7}),
            truncated: false,
            observations: vec![],
            evidence: vec![],
        }],
    };
    let captured_origin = ComponentNativeRunOrigin {
        operation: OperationId::new("context-operation").unwrap(),
        request: RequestId::new("context-parent").unwrap(),
        ..origin()
    };
    let mut changed = context.clone();
    changed.sources[0].text = "X".repeat(65537);
    assert!(
        owner
            .start_native_captured(&actor, request.clone(), captured_origin.clone(), changed, 6)
            .is_err()
    );
    assert_eq!(
        encode(
            &store
                .component_conversation(actor.scope(), "context-task")
                .unwrap()
                .unwrap()
                .draft_content
        )
        .unwrap(),
        encode(&draft).unwrap()
    );
    let admitted = owner
        .start_native_captured(
            &actor,
            request.clone(),
            captured_origin.clone(),
            context.clone(),
            7,
        )
        .unwrap();
    let after = store
        .component_conversation(actor.scope(), "context-task")
        .unwrap()
        .unwrap();
    assert_eq!(
        encode(&after.draft_content).unwrap(),
        encode(&AgentDraftContent::default()).unwrap()
    );
    assert_eq!(after.draft_version, saved.draft_version + 1);
    let next = AgentDraftContent {
        text: "Keep next".into(),
        ..Default::default()
    };
    owner
        .save_draft_content(
            &actor,
            "context-task",
            after.draft_version,
            next.clone(),
            None,
            8,
        )
        .unwrap();
    drop(owner);
    drop(store);
    let store = Arc::new(AgentStore::open(&path).unwrap());
    let owner = ComponentAgentOwner::new(store.clone(), "reopened".into());
    let mut changed = context.clone();
    changed.sources[0].text = "Replacement".into();
    assert!(matches!(
        owner.start_native_captured(&actor, request.clone(), captured_origin.clone(), changed, 9),
        Err(ComponentTaskError::RequestConflict)
    ));
    let repeated = owner
        .start_native_captured(
            &actor,
            request,
            captured_origin.clone(),
            context.clone(),
            10,
        )
        .unwrap();
    assert!(repeated.repeated);
    assert_eq!(repeated.run.run.run_id, admitted.run.run.run_id);
    assert_eq!(
        encode(&repeated.run.run.context).unwrap(),
        encode(&Some(context)).unwrap()
    );
    assert_eq!(
        encode(
            &store
                .component_conversation(actor.scope(), "context-task")
                .unwrap()
                .unwrap()
                .draft_content
        )
        .unwrap(),
        encode(&next).unwrap()
    );
}
