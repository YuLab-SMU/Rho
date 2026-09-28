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
