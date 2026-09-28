use rho_application::*;
use rho_contract::*;
use rho_sqlite::ApplicationStore;
use serde_json::json;
use std::sync::Arc;

struct Fixture {
    _directory: tempfile::TempDir,
    path: std::path::PathBuf,
    store: Arc<ApplicationStore>,
    application: ApplicationOwner,
    owner: ComponentAgentOwner,
    context: CallContext,
    actor: ComponentActor,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("application.sqlite");
        let store = Arc::new(ApplicationStore::open(&path).unwrap());
        let application = ApplicationOwner::new("/project".into(), store.clone());
        let owner = ComponentAgentOwner::new(store.clone(), "component-host".into());
        let context = CallContext {
            view_scope: None,
            caller: CallerIdentity {
                kind: CallerKind::Human,
                id: "local".into(),
            },
            principal: None,
            scopes: Default::default(),
            connection_id: "studio:one".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        };
        let actor = actor(&application, &context, "window", 1);
        Self {
            _directory: directory,
            path,
            store,
            application,
            owner,
            context,
            actor,
        }
    }
    fn configure(&self) -> u64 {
        self.owner
            .configure(
                &self.actor,
                &ComponentModelSettings {
                    version: 0,
                    enabled: true,
                    connection: Some(model()),
                },
                2,
            )
            .unwrap()
            .version
    }
    fn request(
        &self,
        conversation: &str,
        profile: ComponentAgentProfile,
        mode: ComponentAgentMode,
    ) -> ComponentAgentStart {
        let conversation = self
            .owner
            .create(&self.actor, conversation, profile, 2)
            .unwrap();
        ComponentAgentStart { assets: None,
            continuation: None,
            request_id: format!("start-{}", conversation.conversation_id),
            conversation_id: conversation.conversation_id,
            conversation_version: conversation.version,
            window: self.actor.window().clone(),
            model_settings_version: 1,
            text: "Explain this fixture".into(),
            grant: ComponentAgentGrant {
                permission_policy: None,
                mode,
                session: Some(ComponentAgentSession {
                    workspace_instance_id: "main".into(),
                    session_id: "native-one".into(),
                }),
                documents: vec![],
                files: vec![],
            },
            sources: vec![],
        }
    }
    fn running(&self, profile: ComponentAgentProfile, mode: ComponentAgentMode) -> String {
        self.configure();
        let request = self.request("conversation", profile, mode);
        let run = self.owner.start(&self.actor, request, 3).unwrap().run;
        self.owner
            .claim(self.actor.scope(), &run.run.run_id, 4)
            .unwrap();
        self.owner
            .begin_model_call(self.actor.scope(), &run.run.run_id, 5)
            .unwrap();
        run.run.run_id
    }
}
fn actor(
    application: &ApplicationOwner,
    context: &CallContext,
    id: &str,
    now: u64,
) -> ComponentActor {
    let ApplicationBridgeReply::Registered(registered) = application
        .bridge(
            context,
            ApplicationBridgeRequest::Register {
                window_id: id.into(),
                incarnation: format!("{id}-life"),
                label: id.into(),
                previous_session: None,
            },
            now,
        )
        .unwrap()
    else {
        panic!()
    };
    application
        .component_actor(context, &registered.session.window, now)
        .unwrap()
}
fn model() -> ComponentModelConnection {
    ComponentModelConnection {
        protocol: ComponentModelProtocol::Anthropic,
        base_url: "https://model.example".into(),
        model: "fixture".into(),
        credential: ComponentCredentialRef::Environment {
            name: "RHO_TEST_KEY".into(),
        },
    }
}
fn query() -> ComponentToolAction {
    ComponentToolAction::Query(QueryRequest {
        capability: CapabilityRef::new("workspace.list_objects", 1).unwrap(),
        arguments: json!({"workspace_instance_id":"main"}),
    })
}
fn mutation() -> ComponentToolAction {
    ComponentToolAction::Invoke(Invocation {
        client_request_id: "model-supplied-request".into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"workspace_instance_id":"main","code":"counter <- counter + 1"}),
        preconditions: vec![Precondition {
            kind: "workspace.session".into(),
            subject: "active".into(),
            expected: json!("native-one"),
        }],
    })
}

#[test]
fn task_intent_and_permission_are_frozen_durable_and_fenced_before_dispatch() {
    let f = Fixture::new();
    f.configure();
    let mut request = f.request("permissions", ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    request.grant.permission_policy = Some(ComponentPermissionPolicy::Ask);
    request.text = "Explain this object".into();
    let run = f.owner.start(&f.actor, request.clone(), 3).unwrap().run.run;
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    f.owner.begin_model_call(f.actor.scope(), &run.run_id, 5).unwrap();
    let intent = ComponentAgentTaskIntent {request_id: request.request_id.clone(),
        request_excerpt:request.text.clone(),actions:vec![]};
    let mut forged = intent.clone();
    forged.request_excerpt = "Run this code".into();
    assert!(f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &forged, 6).is_err());
    f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &intent, 6).unwrap();
    let mut expanded = intent.clone();
    expanded.actions.push(ComponentIntentAction {action:ComponentRequestedAction::Execute, document_id:None,path:None});
    assert!(f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &expanded, 7).is_err());
    let tool = f.owner.admit_tool(f.actor.scope(), &run.run_id, 1, "additional-r", mutation(), 7).unwrap();
    assert!(f.owner.check_tool_dispatch(f.actor.scope(), &run.run_id, &tool.tool.receipt.receipt_id, 8).is_err());
    let permission = f.owner.record_permission(f.actor.scope(), &run.run_id, &tool.tool.receipt.receipt_id,
        "workspace_run_r", ComponentTaskAuthorization::Additional, false, 8).unwrap();
    assert_eq!(permission.state, ComponentPermissionState::Pending);
    assert_eq!(permission.title, "Run R code in Main");
    assert!(f.owner.begin_model_call(f.actor.scope(), &run.run_id, 9).is_err());
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let waiting = reopened.component_run(f.actor.scope(), &run.run_id).unwrap().unwrap();
    assert_eq!(waiting.run.state, ComponentAgentRunState::WaitingForPermission);
    assert_eq!(waiting.run.permissions[0].action_digest, tool.tool.receipt.action_digest);
    let other = actor(&f.application, &f.context, "other-window", 9);
    assert!(f.owner.decide_permission(&other, &run.run_id, &permission.decision_id, true, 10).is_err());
    f.owner.decide_permission(&f.actor, &run.run_id, &permission.decision_id, true, 10).unwrap();
    f.owner.decide_permission(&f.actor, &run.run_id, &permission.decision_id, true, 11).unwrap();
    assert!(f.owner.decide_permission(&f.actor, &run.run_id, &permission.decision_id, false, 11).is_err());
    f.owner.check_tool_dispatch(f.actor.scope(), &run.run_id, &tool.tool.receipt.receipt_id, 12).unwrap();
    f.owner.stop(&f.actor, &run.run_id, 13).unwrap();
    assert!(f.owner.check_tool_dispatch(f.actor.scope(), &run.run_id, &tool.tool.receipt.receipt_id, 14).is_err());
}

#[test]
fn task_intent_paths_are_finite_and_native_session_cannot_be_invented() {
    let f = Fixture::new(); f.configure();
    let mut request = f.request("new-script", ComponentAgentProfile::Plots, ComponentAgentMode::Explain);
    request.grant.permission_policy = Some(ComponentPermissionPolicy::FullAccess);
    request.grant.session = None;
    request.text = "Create a script to explain this plot".into();
    let run = f.owner.start(&f.actor, request.clone(), 3).unwrap().run.run;
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    let mut intent = ComponentAgentTaskIntent {request_id:request.request_id,request_excerpt:request.text,
        actions:vec![ComponentIntentAction {action:ComponentRequestedAction::Create,document_id:None,path:Some("../escape.R".into())}]};
    assert!(f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &intent, 5).is_err());
    intent.actions[0].path = Some("analysis/new-script.R".into());
    intent.actions.push(ComponentIntentAction {action:ComponentRequestedAction::Execute,document_id:None,path:None});
    assert!(f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &intent, 5).is_err());
    intent.actions.pop();
    f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &intent, 5).unwrap();
    assert_eq!(run.budget.model_calls,12); assert_eq!(run.budget.tool_calls,16); assert_eq!(run.budget.duration_ms,600_000);
}

#[test]
fn opened_document_receipt_binds_a_new_target_before_task_intent_without_a_write_approval() {
    let f=Fixture::new(); f.configure();
    let mut request=f.request("open-target",ComponentAgentProfile::Objects,ComponentAgentMode::Explain);
    request.grant.permission_policy=Some(ComponentPermissionPolicy::Ask);
    let run=f.owner.start(&f.actor,request.clone(),3).unwrap().run.run;
    f.owner.claim(f.actor.scope(),&run.run_id,4).unwrap();
    f.owner.begin_model_call(f.actor.scope(),&run.run_id,5).unwrap();
    let tool=f.owner.admit_tool(f.actor.scope(),&run.run_id,1,"open",ComponentToolAction::Control(
        ApplicationCommandRequest {window:f.actor.window().clone(),request_id:"prepared".into(),execution_target:None,
            action:ApplicationAction::OpenDocument{path:"analysis.R".into(),expected_context_version:"view-v1".into()}}),6).unwrap().tool;
    f.owner.check_tool_dispatch(f.actor.scope(),&run.run_id,&tool.receipt.receipt_id,6).unwrap();
    f.owner.record_tool(f.actor.scope(),&run.run_id,&tool.receipt.receipt_id,ComponentToolUpdate::Accepted{
        operation_id:None,application_request_id:Some(tool.receipt.client_request_id.clone())},7).unwrap();
    let document=ApplicationDocumentRef{document_id:"opened".into(),document_version:"v1".into(),selection_version:"s1".into()};
    let result=json!({"window":f.actor.window(),"request_id":tool.receipt.client_request_id,
        "actor":{"kind":"agent","id":format!("component:{}",run.run_id)},"state":"applied",
        "created_at_ms":6,"claim_expires_at_ms":30006,"applied_documents":[document],
        "applied_document_summaries":[{"document":document,"path":"analysis.R","sha256":"a".repeat(64),
            "base_text_present":true,"utf8_bytes":12,"dirty":false,"selection":{"anchor":0,"head":0,"version":"s1"}}]});
    f.owner.record_tool(f.actor.scope(),&run.run_id,&tool.receipt.receipt_id,
        ComponentToolUpdate::Resolved{result,evidence:vec![]},8).unwrap();
    let saved=f.store.component_run(f.actor.scope(),&run.run_id).unwrap().unwrap();
    assert_eq!(component_document_reference(&saved.run,"opened"),Some(&document));
    assert_eq!(component_document_grant(&saved.run,"opened").unwrap().path.as_deref(),Some("analysis.R"));
    assert!(saved.run.permissions.is_empty());
    f.owner.capture_task_intent(f.actor.scope(),&run.run_id,&ComponentAgentTaskIntent{
        request_id:request.request_id,request_excerpt:request.text,actions:vec![]},9).unwrap();
}

#[test]
fn declining_or_stopping_a_permission_never_releases_its_native_action() {
    for stop in [false,true] {
        let f=Fixture::new(); f.configure();
        let mut request=f.request("pending",ComponentAgentProfile::Objects,ComponentAgentMode::Explain);
        request.grant.permission_policy=Some(ComponentPermissionPolicy::Ask);
        let run=f.owner.start(&f.actor,request.clone(),3).unwrap().run.run;
        f.owner.claim(f.actor.scope(),&run.run_id,4).unwrap();
        f.owner.begin_model_call(f.actor.scope(),&run.run_id,5).unwrap();
        f.owner.capture_task_intent(f.actor.scope(),&run.run_id,&ComponentAgentTaskIntent{
            request_id:request.request_id,request_excerpt:request.text,actions:vec![]},6).unwrap();
        let tool=f.owner.admit_tool(f.actor.scope(),&run.run_id,1,"additional",mutation(),7).unwrap().tool;
        let permission=f.owner.record_permission(f.actor.scope(),&run.run_id,&tool.receipt.receipt_id,
            "workspace_run_r",ComponentTaskAuthorization::Additional,false,8).unwrap();
        if stop {
            f.owner.stop(&f.actor,&run.run_id,9).unwrap();
            assert!(f.owner.decide_permission(&f.actor,&run.run_id,&permission.decision_id,true,10).is_err());
        } else {
            let decided=f.owner.decide_permission(&f.actor,&run.run_id,&permission.decision_id,false,9).unwrap();
            assert_eq!(decided.permissions[0].state,ComponentPermissionState::Denied);
            let receipt=&f.store.component_tools(f.actor.scope(),&run.run_id).unwrap()[0].receipt;
            assert_eq!(receipt.phase,ComponentToolPhase::Resolved);
            assert_eq!(receipt.result.as_ref().unwrap()["accepted"],false);
            assert!(receipt.operation_id.is_none());
        }
        assert!(f.owner.check_tool_dispatch(f.actor.scope(),&run.run_id,&tool.receipt.receipt_id,10).is_err());
    }
}

#[test]
fn offline_controller_cannot_approve_a_pending_native_action() {
    let f=Fixture::new();f.configure();
    let mut request=f.request("offline-permission",ComponentAgentProfile::Objects,ComponentAgentMode::Explain);
    request.grant.permission_policy=Some(ComponentPermissionPolicy::Ask);
    let run=f.owner.start(&f.actor,request.clone(),3).unwrap().run.run;
    f.owner.claim(f.actor.scope(),&run.run_id,4).unwrap();f.owner.begin_model_call(f.actor.scope(),&run.run_id,5).unwrap();
    f.owner.capture_task_intent(f.actor.scope(),&run.run_id,&ComponentAgentTaskIntent{request_id:request.request_id,request_excerpt:request.text,actions:vec![]},6).unwrap();
    let tool=f.owner.admit_tool(f.actor.scope(),&run.run_id,1,"extra",mutation(),7).unwrap().tool;
    let permission=f.owner.record_permission(f.actor.scope(),&run.run_id,&tool.receipt.receipt_id,"workspace_run_r",ComponentTaskAuthorization::Additional,false,8).unwrap();
    assert!(matches!(f.owner.decide_permission(&f.actor,&run.run_id,&permission.decision_id,true,20_000),Err(ApplicationError::Offline)));
    let saved=f.store.component_run(f.actor.scope(),&run.run_id).unwrap().unwrap();
    assert_eq!(saved.run.state,ComponentAgentRunState::WaitingForPermission);
    assert_eq!(saved.run.permissions[0].state,ComponentPermissionState::Pending);
    assert!(f.store.component_tools(f.actor.scope(),&run.run_id).unwrap()[0].receipt.operation_id.is_none());
}

#[test]
fn continue_retains_the_original_task_intent_without_accepting_broader_permissions() {
    let f=Fixture::new();f.configure();
    let mut request=f.request("intent-continuation",ComponentAgentProfile::Objects,ComponentAgentMode::Explain);
    request.grant.permission_policy=Some(ComponentPermissionPolicy::Ask);
    request.text="Create one script".into();
    let first=f.owner.start(&f.actor,request.clone(),3).unwrap().run.run;
    f.owner.claim(f.actor.scope(),&first.run_id,4).unwrap();
    let intent=ComponentAgentTaskIntent{request_id:request.request_id.clone(),request_excerpt:request.text.clone(),
        actions:vec![ComponentIntentAction{action:ComponentRequestedAction::Create,document_id:None,path:Some("one.R".into())}]};
    f.owner.capture_task_intent(f.actor.scope(),&first.run_id,&intent,5).unwrap();
    f.owner.finish(f.actor.scope(),&first.run_id,ComponentAgentRunState::Interrupted,None,6).unwrap();
    let checked=f.owner.record_recovery(f.actor.scope(),&first.run_id,vec![],7).unwrap();
    request.continuation=Some(ComponentContinuation{run_id:first.run_id,recovery_digest:checked.recovery.unwrap().digest});
    request.request_id="continue-intent".into();request.text="Continue".into();
    request.conversation_version=f.store.component_conversation(f.actor.scope(),&request.conversation_id).unwrap().unwrap().version;
    let mut broader=request.clone();broader.grant.permission_policy=Some(ComponentPermissionPolicy::FullAccess);
    assert!(f.owner.start(&f.actor,broader,8).is_err());
    let next=f.owner.start(&f.actor,request.clone(),8).unwrap().run.run;
    assert_eq!(next.task_intent.as_ref(),Some(&intent));
    f.owner.claim(f.actor.scope(),&next.run_id,9).unwrap();
    assert!(f.owner.capture_task_intent(f.actor.scope(),&next.run_id,&ComponentAgentTaskIntent{
        request_id:request.request_id,request_excerpt:request.text,
        actions:vec![ComponentIntentAction{action:ComponentRequestedAction::Create,document_id:None,path:Some("another.R".into())}]},10).is_err());
}

#[test]
fn run_identity_survives_reopen_and_changed_reuse_is_rejected() {
    let f = Fixture::new();
    f.configure();
    let request = f.request(
        "conversation",
        ComponentAgentProfile::Objects,
        ComponentAgentMode::Explain,
    );
    let first = f.owner.start(&f.actor, request.clone(), 3).unwrap();
    assert!(!first.repeated);
    let repeated = f.owner.start(&f.actor, request.clone(), 4).unwrap();
    assert!(repeated.repeated);
    assert_eq!(first.run.run.run_id, repeated.run.run.run_id);
    let mut changed = request.clone();
    changed.text = "Run instead".into();
    assert!(matches!(
        f.owner.start(&f.actor, changed, 5),
        Err(ApplicationError::RequestConflict)
    ));
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let stored = reopened
        .component_run_by_request(f.actor.scope(), &request.request_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.run.run_id, first.run.run.run_id);
    assert_eq!(stored.run.model.model, "fixture");
    assert!(stored.run.input_tokens.is_none());
    let other = ApplicationScope {
        project: "/other".into(),
        principal: f.actor.scope().principal.clone(),
    };
    assert!(
        reopened
            .component_run_by_request(&other, &request.request_id)
            .unwrap()
            .is_none()
    );
    let other = ApplicationScope {
        project: "/project".into(),
        principal: "other".into(),
    };
    assert!(
        reopened
            .component_run(&other, &first.run.run.run_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn configuration_is_explicit_cas_and_cannot_store_embedded_secrets() {
    let f = Fixture::new();
    let request = f.request(
        "conversation",
        ComponentAgentProfile::Objects,
        ComponentAgentMode::Explain,
    );
    assert!(f.owner.start(&f.actor, request.clone(), 3).is_err());
    assert!(
        f.store
            .component_run_by_request(f.actor.scope(), &request.request_id)
            .unwrap()
            .is_none()
    );
    f.configure();
    assert!(matches!(
        f.owner.configure(
            &f.actor,
            &ComponentModelSettings {
                version: 0,
                enabled: false,
                connection: None
            },
            4
        ),
        Err(ApplicationError::Conflict)
    ));
    for endpoint in [
        "http://remote.example",
        "https://user:secret@model.example",
        "https://model.example?api_key=secret",
        "https://model.example#secret",
        "file:///tmp/model",
        "http://localhost.evil",
    ] {
        let mut connection = model();
        connection.base_url = endpoint.into();
        assert!(validate_component_model(&connection).is_err(), "{endpoint}");
    }
    for endpoint in [
        "http://127.0.0.1:8000/v1",
        "http://[::1]:8000",
        "https://model.example/v1",
    ] {
        let mut connection = model();
        connection.base_url = endpoint.into();
        validate_component_model(&connection).unwrap();
    }
    let bytes = serde_json::to_vec(&f.store.component_settings(f.actor.scope()).unwrap()).unwrap();
    assert!(String::from_utf8(bytes).unwrap().contains("RHO_TEST_KEY"));
    assert!(
        serde_json::from_value::<ComponentModelSettings>(
            json!({"version":0,"enabled":true,"connection":null,"api_key":"secret"})
        )
        .is_err()
    );
}

#[test]
fn cross_window_and_expired_actor_cannot_change_draft_or_stop_run() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let other = actor(&f.application, &f.context, "other-window", 6);
    assert!(matches!(
        f.owner.stop(&other, &run, 7),
        Err(ApplicationError::Conflict)
    ));
    let conversation = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap();
    assert!(
        f.owner
            .save_draft(
                &other,
                "conversation",
                conversation.draft_version,
                "forged".into(),
                7
            )
            .is_err()
    );
    f.owner
        .save_draft(
            &f.actor,
            "conversation",
            conversation.draft_version,
            "later user input".into(),
            7,
        )
        .unwrap();
    assert!(matches!(
        f.owner.save_draft(
            &f.actor,
            "conversation",
            conversation.draft_version,
            "stale overwrite".into(),
            8
        ),
        Err(ApplicationError::Conflict)
    ));
    assert!(matches!(
        f.owner.stop(&f.actor, &run, 20_000),
        Err(ApplicationError::Offline)
    ));
    assert_eq!(
        f.store
            .component_conversation(f.actor.scope(), "conversation")
            .unwrap()
            .unwrap()
            .draft,
        "later user input"
    );
}

#[test]
fn tool_intent_is_durable_and_repeated_mutation_returns_original_identity() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let first = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "call-one", mutation(), 6)
        .unwrap();
    assert!(!first.repeated);
    assert_ne!(
        first.tool.receipt.client_request_id,
        "model-supplied-request"
    );
    let reopened = ApplicationStore::open(&f.path).unwrap();
    assert_eq!(
        reopened
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .len(),
        1
    );
    let repeated = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "new-provider-call", mutation(), 7)
        .unwrap();
    assert!(repeated.repeated);
    assert_eq!(
        repeated.tool.receipt.receipt_id,
        first.tool.receipt.receipt_id
    );
    let mut altered = mutation();
    if let ComponentToolAction::Invoke(i) = &mut altered {
        i.arguments["code"] = json!("different_code()");
    }
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "call-one", altered, 8),
        Err(ApplicationError::RequestConflict)
    ));
    let state = f
        .store
        .component_run(f.actor.scope(), &run)
        .unwrap()
        .unwrap();
    assert_eq!(state.run.tool_calls, 2);
}

#[test]
fn forged_tools_session_and_document_permissions_have_no_receipts() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    assert!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "forged", mutation(), 6)
            .is_err()
    );
    let mut wrong = query();
    if let ComponentToolAction::Query(q) = &mut wrong {
        q.arguments["workspace_instance_id"] = json!("another-session");
    }
    assert!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "wrong-session", wrong, 6)
            .is_err()
    );
    let mut install = query();
    if let ComponentToolAction::Query(q) = &mut install {
        q.capability.id = "environment.realize".into();
    }
    assert!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "install", install, 6)
            .is_err()
    );
    assert!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .is_empty()
    );
    let f = Fixture::new();
    f.configure();
    let mut request = f.request(
        "document",
        ComponentAgentProfile::Documents,
        ComponentAgentMode::Edit,
    );
    let document = ApplicationDocumentRef {
        document_id: "script".into(),
        document_version: "v1".into(),
        selection_version: "s1".into(),
    };
    request.grant.documents = vec![ComponentDocumentGrant {
        document: document.clone(),
        allow_save: false,
        path: Some("script.R".into()),
    }];
    let run = f.owner.start(&f.actor, request, 3).unwrap().run.run.run_id;
    f.owner.claim(f.actor.scope(), &run, 4).unwrap();
    f.owner.begin_model_call(f.actor.scope(), &run, 5).unwrap();
    for action in [
        ApplicationAction::Save {
            document: document.clone(),
            target_path: None,
        },
        ApplicationAction::RunFile {
            document: document.clone(),
            target_path: None,
        },
        ApplicationAction::EditDocument {
            document: ApplicationDocumentRef {
                document_version: "v2".into(),
                ..document.clone()
            },
            edits: vec![],
        },
    ] {
        let action = ComponentToolAction::Control(ApplicationCommandRequest {
            execution_target: None,
            window: f.actor.window().clone(),
            request_id: "forged".into(),
            action,
        });
        assert!(
            f.owner
                .admit_tool(f.actor.scope(), &run, 1, "call", action, 6)
                .is_err()
        );
    }
    assert!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn stop_fences_model_and_tool_calls_but_preserves_late_owner_receipt() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "call", mutation(), 6)
        .unwrap()
        .tool;
    f.owner.stop(&f.actor, &run, 7).unwrap();
    assert!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "late-call", mutation(), 8)
            .is_err()
    );
    assert!(f.owner.begin_model_call(f.actor.scope(), &run, 8).is_err());
    assert!(
        f.owner
            .finish(
                f.actor.scope(),
                &run,
                ComponentAgentRunState::Completed,
                None,
                9
            )
            .is_err()
    );
    let op = OperationId::new("native-operation").unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(op.clone()),
                application_request_id: None,
            },
            9,
        )
        .unwrap();
    let result = json!({"status":"uncertain","operation_id":op});
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: result.clone(),
                evidence: vec![],
            },
            10,
        )
        .unwrap();
    f.owner
        .finish(
            f.actor.scope(),
            &run,
            ComponentAgentRunState::Stopped,
            Some("Model stopped; native operation remains uncertain".into()),
            11,
        )
        .unwrap();
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let retained = reopened.component_tools(f.actor.scope(), &run).unwrap();
    assert_eq!(retained[0].receipt.result, Some(result));
    assert_eq!(
        reopened
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Stopped
    );
}

#[test]
fn disable_and_budgets_fail_before_admitting_new_work() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    for i in 0..16 {
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, &format!("call-{i}"), query(), 6)
            .unwrap();
    }
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "over-budget", query(), 6),
        Err(ApplicationError::Budget(_))
    ));
    for _ in 0..11 {
        f.owner.begin_model_call(f.actor.scope(), &run, 7).unwrap();
    }
    assert!(matches!(
        f.owner.begin_model_call(f.actor.scope(), &run, 8),
        Err(ApplicationError::Budget(_))
    ));
    let mut settings = f.store.component_settings(f.actor.scope()).unwrap();
    settings.enabled = false;
    f.owner.configure(&f.actor, &settings, 8).unwrap();
    assert!(f.owner.begin_model_call(f.actor.scope(), &run, 9).is_err());
    assert!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 4, "disabled", query(), 9)
            .is_err()
    );
}

#[test]
fn event_pruning_keeps_durable_tool_receipts_and_reports_a_history_gap() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "call", query(), 6)
        .unwrap()
        .tool;
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: json!({"status":"busy","data":null,"completeness":"partial"}),
                evidence: vec![],
            },
            7,
        )
        .unwrap();
    for _ in 0..505 {
        f.owner
            .append_text(f.actor.scope(), &run, "A bounded observation".into(), 8)
            .unwrap();
    }
    f.owner
        .finish(
            f.actor.scope(),
            &run,
            ComponentAgentRunState::Completed,
            None,
            9,
        )
        .unwrap();
    let page = f
        .store
        .component_events(f.actor.scope(), &run, 0, 128)
        .unwrap();
    assert!(page.history_gap);
    assert_eq!(page.events.len(), 128);
    let mut cursor = page.cursor;
    let mut count = page.events.len();
    loop {
        let page = f
            .store
            .component_events(f.actor.scope(), &run, cursor, 128)
            .unwrap();
        if page.events.is_empty() {
            break;
        }
        assert!(!page.history_gap);
        cursor = page.cursor;
        count += page.events.len();
    }
    assert_eq!(count, MAX_COMPONENT_EVENTS);
    assert_eq!(cursor, 507);
    assert_eq!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn separate_owner_instances_enforce_atomic_conversation_cas_and_running_quota() {
    let f = Fixture::new();
    f.configure();
    let mut runs = vec![];
    for i in 0..3 {
        let request = f.request(
            &format!("conversation-{i}"),
            ComponentAgentProfile::Objects,
            ComponentAgentMode::Explain,
        );
        runs.push(f.owner.start(&f.actor, request, 3).unwrap().run.run.run_id);
    }
    let other = ComponentAgentOwner::new(
        Arc::new(ApplicationStore::open(&f.path).unwrap()),
        "component-host".into(),
    );
    f.owner.claim(f.actor.scope(), &runs[0], 4).unwrap();
    other.claim(f.actor.scope(), &runs[1], 4).unwrap();
    assert!(matches!(
        other.claim(f.actor.scope(), &runs[2], 4),
        Err(ApplicationError::Budget(_))
    ));
    let conversation = f
        .store
        .component_conversation(f.actor.scope(), "conversation-0")
        .unwrap()
        .unwrap();
    f.owner
        .save_draft(
            &f.actor,
            "conversation-0",
            conversation.draft_version,
            "first writer".into(),
            5,
        )
        .unwrap();
    assert!(matches!(
        other.save_draft(
            &f.actor,
            "conversation-0",
            conversation.draft_version,
            "lost writer".into(),
            5
        ),
        Err(ApplicationError::Conflict)
    ));
    assert_eq!(
        f.store
            .component_conversation(f.actor.scope(), "conversation-0")
            .unwrap()
            .unwrap()
            .draft,
        "first writer"
    );
}

#[test]
fn repeated_mutation_call_aliases_are_durable_and_consume_the_tool_budget() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let original = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "call-0", mutation(), 6)
        .unwrap();
    for i in 1..16 {
        let repeated = f
            .owner
            .admit_tool(
                f.actor.scope(),
                &run,
                1,
                &format!("call-{i}"),
                mutation(),
                6,
            )
            .unwrap();
        assert!(repeated.repeated);
        assert_eq!(
            original.tool.receipt.receipt_id,
            repeated.tool.receipt.receipt_id
        );
    }
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "call-16", mutation(), 6),
        Err(ApplicationError::Budget(_))
    ));
    let reopened = ComponentAgentOwner::new(
        Arc::new(ApplicationStore::open(&f.path).unwrap()),
        "component-host".into(),
    );
    let mut changed = mutation();
    if let ComponentToolAction::Invoke(i) = &mut changed {
        i.arguments["code"] = json!("second_write()");
    }
    assert!(matches!(
        reopened.admit_tool(f.actor.scope(), &run, 1, "call-15", changed, 7),
        Err(ApplicationError::RequestConflict)
    ));
    assert_eq!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .tool_calls,
        16
    );
}

#[test]
fn failed_intent_transaction_rolls_back_run_counter_and_conversation_version() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let before = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap()
        .version;
    let connection = rusqlite::Connection::open(&f.path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_component_intent BEFORE INSERT ON component_agent_tools BEGIN SELECT RAISE(ABORT,'fixture store failure'); END;").unwrap();
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "failed-call", mutation(), 6),
        Err(ApplicationError::Storage(_))
    ));
    assert!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        f.store
            .component_conversation(f.actor.scope(), "conversation")
            .unwrap()
            .unwrap()
            .version,
        before
    );
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .tool_calls,
        0
    );
    connection
        .execute_batch("DROP TRIGGER reject_component_intent")
        .unwrap();
    assert!(
        !f.owner
            .admit_tool(f.actor.scope(), &run, 1, "failed-call", mutation(), 7)
            .unwrap()
            .repeated
    );
}

#[test]
fn accepted_model_scope_is_fixed_and_new_host_cannot_dispatch_an_old_run() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let mut settings = f.store.component_settings(f.actor.scope()).unwrap();
    settings.connection.as_mut().unwrap().model = "later-model".into();
    f.owner.configure(&f.actor, &settings, 6).unwrap();
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .model
            .model,
        "fixture"
    );
    let new_host = ComponentAgentOwner::new(f.store.clone(), "replacement-host".into());
    assert!(new_host.begin_model_call(f.actor.scope(), &run, 7).is_err());
    assert!(
        new_host
            .admit_tool(f.actor.scope(), &run, 1, "old-run", mutation(), 7)
            .is_err()
    );
    assert!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn streaming_observations_do_not_invalidate_the_users_draft_version() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    let observed = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap();
    f.owner
        .append_text(
            f.actor.scope(),
            &run,
            "model text arriving while the user types".into(),
            6,
        )
        .unwrap();
    f.owner
        .save_draft(
            &f.actor,
            "conversation",
            observed.draft_version,
            "new user draft".into(),
            7,
        )
        .unwrap();
    let current = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap();
    assert_eq!(current.draft, "new user draft");
    assert_eq!(current.draft_version, observed.draft_version + 1);
    assert!(current.version > observed.version + 1);
}

#[test]
fn queue_resume_scope_requires_native_operations_recorded_in_this_run() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let resume = |ids: Vec<&str>| {
        ComponentToolAction::Invoke(Invocation {
            client_request_id: "provider-id".into(),
            capability: CapabilityRef::new("workspace.resume_queue", 1).unwrap(),
            arguments: json!({"workspace_instance_id":"main","session_id":"native-one","pause_id":"pause-1","only_operation_ids":ids}),
            preconditions: vec![Precondition {
                kind: "workspace.session".into(),
                subject: "active".into(),
                expected: json!("native-one"),
            }],
        })
    };
    assert!(
        f.owner
            .admit_tool(
                f.actor.scope(),
                &run,
                1,
                "forged-resume",
                resume(vec!["foreign"]),
                6
            )
            .is_err()
    );
    assert!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .is_empty()
    );
    let original = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "run", mutation(), 7)
        .unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &original.tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(OperationId::new("own-operation").unwrap()),
                application_request_id: None,
            },
            8,
        )
        .unwrap();
    assert!(
        f.owner
            .admit_tool(
                f.actor.scope(),
                &run,
                1,
                "mixed-resume",
                resume(vec!["own-operation", "foreign"]),
                9
            )
            .is_err()
    );
    let accepted = f
        .owner
        .admit_tool(
            f.actor.scope(),
            &run,
            1,
            "own-resume",
            resume(vec!["own-operation"]),
            10,
        )
        .unwrap();
    assert_eq!(accepted.tool.receipt.phase, ComponentToolPhase::Intent);
    assert_eq!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn measured_run_budget_still_fences_the_next_model_call() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    for expected in 2..=12 {
        assert_eq!(
            f.owner.begin_model_call(f.actor.scope(), &run, 6).unwrap(),
            expected
        );
    }
    assert!(matches!(
        f.owner.begin_model_call(f.actor.scope(), &run, 7),
        Err(ApplicationError::Budget(_))
    ));
    let stored = f
        .store
        .component_run(f.actor.scope(), &run)
        .unwrap()
        .unwrap();
    assert_eq!(stored.run.model_calls, 12);
    assert_eq!(stored.run.budget.tool_calls, 16);
    assert_eq!(stored.run.budget.context_bytes, 65536);
}

#[test]
fn rejected_argument_attempts_are_durable_and_consume_tool_budget_without_native_identity() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    let rejected = ComponentToolAction::Rejected {
        capability: CapabilityRef::new("workspace.list_objects", 1).unwrap(),
        arguments_digest: "0".repeat(64),
        feedback: json!({"status":"rejected","accepted":false,"error":"Invalid parameters"}),
    };
    for call in 0..16 {
        let admission = f
            .owner
            .admit_tool(
                f.actor.scope(),
                &run,
                1,
                &format!("invalid-{call}"),
                rejected.clone(),
                6,
            )
            .unwrap();
        assert_eq!(admission.tool.receipt.phase, ComponentToolPhase::Resolved);
        assert!(!admission.tool.receipt.mutation);
        assert!(admission.tool.receipt.operation_id.is_none());
    }
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "invalid-over-budget", rejected, 7),
        Err(ApplicationError::Budget(_))
    ));
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let tools = reopened.component_tools(f.actor.scope(), &run).unwrap();
    assert_eq!(tools.len(), 16);
    assert!(
        tools
            .iter()
            .all(|t| t.receipt.result.as_ref().unwrap()["accepted"] == false)
    );
    assert!(
        reopened
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .tool_result_bytes
            > 0
    );
}

#[test]
fn orphan_takeover_is_atomic_preserves_drafts_and_fences_old_model_output() {
    let f = Fixture::new();
    let id = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &id, 1, "native", mutation(), 6)
        .unwrap();
    f.owner
        .save_draft(&f.actor, "conversation", 1, "retained user draft".into(), 7)
        .unwrap();
    let previous = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap();
    let next = actor(&f.application, &f.context, "new-window", 8);
    let owner = ComponentAgentOwner::new(f.store.clone(), "replacement-host".into());
    let stored = f
        .store
        .component_run(f.actor.scope(), &id)
        .unwrap()
        .unwrap();
    assert_eq!(
        owner.observed_run(stored).state,
        ComponentAgentRunState::Interrupted
    );
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &id)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Running
    );
    assert!(
        owner
            .take_control(&next, "conversation", previous.version - 1, 9)
            .is_err()
    );
    let controlled = owner
        .take_control(&next, "conversation", previous.version, 9)
        .unwrap();
    assert_eq!(controlled.controller, *next.window());
    assert_eq!(controlled.draft, "retained user draft");
    assert_eq!(controlled.draft_version, previous.draft_version);
    assert!(controlled.active_run_id.is_none());
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &id)
            .unwrap()
            .unwrap()
            .run
            .request
            .window,
        *f.actor.window()
    );
    assert!(
        f.owner
            .append_text(f.actor.scope(), &id, "late model text".into(), 10)
            .is_err()
    );
    assert!(
        f.owner
            .save_draft(
                &f.actor,
                "conversation",
                controlled.draft_version,
                "overwrite".into(),
                10
            )
            .is_err()
    );
    // An already accepted native fact may arrive late; it cannot change control.
    f.owner
        .record_tool(
            f.actor.scope(),
            &id,
            &tool.tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(OperationId::new("original-operation").unwrap()),
                application_request_id: None,
            },
            10,
        )
        .unwrap();
    assert_eq!(
        f.store
            .component_conversation(f.actor.scope(), "conversation")
            .unwrap()
            .unwrap()
            .controller,
        *next.window()
    );
}

#[test]
fn reconciliation_metadata_is_bounded_idempotent_and_retained_across_reopen() {
    let f = Fixture::new();
    let id = f.running(ComponentAgentProfile::Objects, ComponentAgentMode::Explain);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &id, 1, "read", query(), 6)
        .unwrap();
    let owner = ComponentAgentOwner::new(f.store.clone(), "replacement-host".into());
    owner.interrupt_abandoned(f.actor.scope(), &id, 7).unwrap();
    let entry = ComponentRecoveredTool {
        receipt_id: tool.tool.receipt.receipt_id.clone(),
        state: ComponentRecoveryState::ReadInterrupted,
        application_request_id: None,
        application_state: None,
        operations: vec![],
        documents: vec![],
        note: None,
    };
    let first = owner
        .record_recovery(f.actor.scope(), &id, vec![entry.clone()], 8)
        .unwrap();
    let repeated = owner
        .record_recovery(f.actor.scope(), &id, vec![entry.clone()], 9)
        .unwrap();
    assert_eq!(first.recovery, repeated.recovery);
    assert_eq!(first.event_cursor, repeated.event_cursor);
    assert_eq!(first.recovery.as_ref().unwrap().unresolved_mutations, 0);
    let mut wrong = entry.clone();
    wrong.receipt_id = "not-owned".into();
    assert!(
        owner
            .record_recovery(f.actor.scope(), &id, vec![wrong], 10)
            .is_err()
    );
    let mut changed = entry;
    changed.note = Some("Owner still has no read result".into());
    assert_eq!(
        owner
            .record_recovery(f.actor.scope(), &id, vec![changed], 11)
            .unwrap()
            .recovery
            .unwrap()
            .version,
        2
    );
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let retained = reopened
        .component_run(f.actor.scope(), &id)
        .unwrap()
        .unwrap();
    assert_eq!(retained.run.state, ComponentAgentRunState::Interrupted);
    assert_eq!(retained.run.recovery.unwrap().version, 2);
    assert_eq!(
        reopened.component_tools(f.actor.scope(), &id).unwrap()[0]
            .receipt
            .phase,
        ComponentToolPhase::Intent
    );
}

#[test]
fn continuation_requires_recovery_and_reuses_confirmed_prior_mutations() {
    let f = Fixture::new();
    let first = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let original = f
        .owner
        .admit_tool(f.actor.scope(), &first, 1, "run", mutation(), 6)
        .unwrap();
    let operation = OperationId::new("original-r").unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &first,
            &original.tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(operation.clone()),
                application_request_id: None,
            },
            7,
        )
        .unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &first,
            &original.tool.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: json!({"status":"succeeded"}),
                evidence: vec![],
            },
            8,
        )
        .unwrap();
    f.owner
        .finish(
            f.actor.scope(),
            &first,
            ComponentAgentRunState::Interrupted,
            Some("Model response lost".into()),
            9,
        )
        .unwrap();
    let previous = f
        .store
        .component_run(f.actor.scope(), &first)
        .unwrap()
        .unwrap();
    let mut request = previous.run.request.clone();
    request.request_id = "continued".into();
    request.conversation_version = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap()
        .version;
    request.continuation = Some(ComponentContinuation {
        run_id: first.clone(),
        recovery_digest: "not-reconciled".into(),
    });
    assert!(f.owner.start(&f.actor, request.clone(), 10).is_err());
    let observed = f
        .owner
        .record_recovery(
            f.actor.scope(),
            &first,
            vec![ComponentRecoveredTool {
                receipt_id: original.tool.receipt.receipt_id.clone(),
                state: ComponentRecoveryState::Confirmed,
                application_request_id: None,
                application_state: None,
                operations: vec![ComponentRecoveredOperation {
                    operation_id: operation,
                    status: OperationStatus::Succeeded,
                }],
                documents: vec![],
                note: None,
            }],
            11,
        )
        .unwrap();
    request.continuation.as_mut().unwrap().recovery_digest = observed.recovery.unwrap().digest;
    request.conversation_version = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap()
        .version;
    let mut retargeted = request.clone();
    retargeted.grant.session.as_mut().unwrap().session_id = "different-r".into();
    assert!(f.owner.start(&f.actor, retargeted, 12).is_err());
    let continued = f.owner.start(&f.actor, request.clone(), 12).unwrap().run;
    assert!(f.owner.start(&f.actor, request, 13).unwrap().repeated);
    f.owner
        .claim(f.actor.scope(), &continued.run.run_id, 14)
        .unwrap();
    f.owner
        .begin_model_call(f.actor.scope(), &continued.run.run_id, 15)
        .unwrap();
    let prior = f
        .owner
        .admit_tool(
            f.actor.scope(),
            &continued.run.run_id,
            1,
            "repeat-original",
            mutation(),
            16,
        )
        .unwrap();
    assert!(!prior.tool.receipt.mutation);
    assert!(
        matches!(prior.tool.action,ComponentToolAction::PreviousResult{run_id,..} if run_id==first)
    );
}

#[test]
fn continuation_cannot_expand_write_scope_or_ignore_unresolved_mutations() {
    let f = Fixture::new();
    let first = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &first, 1, "pending", mutation(), 6)
        .unwrap();
    f.owner
        .finish(
            f.actor.scope(),
            &first,
            ComponentAgentRunState::Interrupted,
            None,
            7,
        )
        .unwrap();
    let observed = f
        .owner
        .record_recovery(
            f.actor.scope(),
            &first,
            vec![ComponentRecoveredTool {
                receipt_id: tool.tool.receipt.receipt_id,
                state: ComponentRecoveryState::Uncertain,
                application_request_id: None,
                application_state: None,
                operations: vec![],
                documents: vec![],
                note: Some("Unconfirmed".into()),
            }],
            8,
        )
        .unwrap();
    let mut request = observed.request.clone();
    request.request_id = "continue-pending".into();
    request.conversation_version = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap()
        .version;
    request.continuation = Some(ComponentContinuation {
        run_id: first,
        recovery_digest: observed.recovery.unwrap().digest,
    });
    assert!(f.owner.start(&f.actor, request.clone(), 9).is_err());
    // Explicitly switching to explanation can retain the uncertainty without granting writes.
    request.grant.mode = ComponentAgentMode::Explain;
    assert!(f.owner.start(&f.actor, request, 10).is_ok());
}

#[test]
fn continued_document_versions_follow_confirmed_edits_and_saves_without_reapplying_them() {
    let f = Fixture::new();
    f.configure();
    let reference = |version: &str| ApplicationDocumentRef {
        document_id: "doc".into(),
        document_version: version.into(),
        selection_version: "selection".into(),
    };
    let mut request = f.request(
        "conversation",
        ComponentAgentProfile::Documents,
        ComponentAgentMode::Edit,
    );
    request.grant.documents = vec![ComponentDocumentGrant {
        document: reference("v1"),
        allow_save: true,
        path: Some("analysis.R".into()),
    }];
    let run = f.owner.start(&f.actor, request, 3).unwrap().run.run;
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    f.owner
        .begin_model_call(f.actor.scope(), &run.run_id, 5)
        .unwrap();
    let action = |document: ApplicationDocumentRef, save: bool| {
        ComponentToolAction::Control(ApplicationCommandRequest {
            window: f.actor.window().clone(),
            request_id: "prepared".into(),
            execution_target: None,
            action: if save {
                ApplicationAction::Save {
                    document,
                    target_path: Some("analysis.R".into()),
                }
            } else {
                ApplicationAction::EditDocument {
                    document,
                    edits: vec![ApplicationTextEdit {
                        from: 0,
                        to: 0,
                        insert: "# edit\n".into(),
                    }],
                }
            },
        })
    };
    let mut history = vec![];
    for (call, from, to, save) in [("edit", "v1", "v2", false), ("save", "v2", "v3", true)] {
        let tool = f
            .owner
            .admit_tool(
                f.actor.scope(),
                &run.run_id,
                1,
                call,
                action(reference(from), save),
                6,
            )
            .unwrap()
            .tool;
        f.owner
            .record_tool(
                f.actor.scope(),
                &run.run_id,
                &tool.receipt.receipt_id,
                ComponentToolUpdate::Accepted {
                    operation_id: None,
                    application_request_id: Some(tool.receipt.client_request_id.clone()),
                },
                7,
            )
            .unwrap();
        let result = json!({"window":f.actor.window(),"request_id":tool.receipt.client_request_id,"actor":{"kind":"agent","id":format!("component:{}",run.run_id)},
            "state":"applied","created_at_ms":6,"claim_expires_at_ms":30006,"applied_documents":[reference(to)],"save_synchronized":save});
        f.owner
            .record_tool(
                f.actor.scope(),
                &run.run_id,
                &tool.receipt.receipt_id,
                ComponentToolUpdate::Resolved {
                    result,
                    evidence: vec![],
                },
                8,
            )
            .unwrap();
        history.push(ComponentRecoveredTool {
            receipt_id: tool.receipt.receipt_id,
            state: ComponentRecoveryState::Confirmed,
            application_request_id: Some(tool.receipt.client_request_id),
            application_state: Some(ApplicationCommandState::Applied),
            operations: vec![],
            documents: vec![reference(to)],
            note: None,
        });
    }
    f.owner
        .finish(
            f.actor.scope(),
            &run.run_id,
            ComponentAgentRunState::Interrupted,
            None,
            9,
        )
        .unwrap();
    let previous = f
        .owner
        .record_recovery(f.actor.scope(), &run.run_id, history, 10)
        .unwrap();
    let mut continued = run.request.clone();
    continued.request_id = "continued-doc".into();
    continued.continuation = Some(ComponentContinuation {
        run_id: run.run_id.clone(),
        recovery_digest: previous.recovery.unwrap().digest,
    });
    continued.conversation_version = f
        .store
        .component_conversation(f.actor.scope(), "conversation")
        .unwrap()
        .unwrap()
        .version;
    continued.grant.documents[0].document = reference("user-edited-v4");
    assert!(f.owner.start(&f.actor, continued.clone(), 11).is_err());
    continued.grant.documents[0].document = reference("v3");
    let next = f.owner.start(&f.actor, continued, 11).unwrap().run.run;
    f.owner.claim(f.actor.scope(), &next.run_id, 12).unwrap();
    f.owner
        .begin_model_call(f.actor.scope(), &next.run_id, 13)
        .unwrap();
    for (call, save) in [("repeat-edit", false), ("repeat-save", true)] {
        let repeated = f
            .owner
            .admit_tool(
                f.actor.scope(),
                &next.run_id,
                1,
                call,
                action(reference("v3"), save),
                14,
            )
            .unwrap();
        assert!(matches!(
            repeated.tool.action,
            ComponentToolAction::PreviousResult { .. }
        ));
        assert!(!repeated.tool.receipt.mutation);
    }
}

#[test]
fn tool_origin_hashes_survive_aliases_and_reopen_without_storing_raw_model_arguments() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let origin = ComponentToolOrigin {
        name: "workspace_run_r".into(),
        arguments_digest: "a".repeat(64),
    };
    let first = f
        .owner
        .admit_tool_call(
            f.actor.scope(),
            &run,
            ComponentToolCall {
                model_call: 1,
                tool_call_id: "first".into(),
                origin: Some(origin.clone()),
            },
            mutation(),
            6,
        )
        .unwrap();
    let again = f
        .owner
        .admit_tool_call(
            f.actor.scope(),
            &run,
            ComponentToolCall {
                model_call: 1,
                tool_call_id: "again".into(),
                origin: Some(origin.clone()),
            },
            mutation(),
            7,
        )
        .unwrap();
    assert!(again.repeated);
    assert_eq!(
        again.tool.receipt.client_request_id,
        first.tool.receipt.client_request_id
    );
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let tools = reopened.component_tools(f.actor.scope(), &run).unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].calls.len(), 2);
    assert!(
        tools[0]
            .calls
            .iter()
            .all(|call| call.origin.as_ref() == Some(&origin))
    );
}

#[test]
fn byte_pruning_preserves_unconfirmed_tool_identity_and_late_native_result() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "original", mutation(), 6)
        .unwrap()
        .tool;
    let operation = OperationId::new("accepted-native-operation").unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(operation.clone()),
                application_request_id: None,
            },
            7,
        )
        .unwrap();
    let text = "测😀".repeat(1100);
    for _ in 0..150 {
        f.owner
            .append_text(f.actor.scope(), &run, text.clone(), 8)
            .unwrap();
    }
    let connection = rusqlite::Connection::open(&f.path).unwrap();
    let (count, bytes): (usize, usize) = connection
        .query_row(
            "SELECT COUNT(*),SUM(bytes) FROM component_agent_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(count < 150);
    assert!(bytes <= MAX_COMPONENT_EVENT_BYTES);
    let page = f
        .store
        .component_events(f.actor.scope(), &run, 0, 128)
        .unwrap();
    assert!(page.history_gap);
    let original = f.store.component_tools(f.actor.scope(), &run).unwrap();
    assert_eq!(original.len(), 1);
    assert_eq!(original[0].receipt.operation_id.as_ref(), Some(&operation));
    assert_eq!(original[0].receipt.phase, ComponentToolPhase::Accepted);
    f.owner.stop(&f.actor, &run, 9).unwrap();
    f.owner
        .finish(
            f.actor.scope(),
            &run,
            ComponentAgentRunState::Stopped,
            None,
            10,
        )
        .unwrap();
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: json!({"status":"succeeded","operation_id":operation}),
                evidence: vec![],
            },
            11,
        )
        .unwrap();
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let result = reopened.component_tools(f.actor.scope(), &run).unwrap();
    assert_eq!(result[0].receipt.phase, ComponentToolPhase::Resolved);
    assert_eq!(
        result[0].receipt.client_request_id,
        tool.receipt.client_request_id
    );
    assert_eq!(
        reopened
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Stopped
    );
}

// Populate valid inactive conversation payloads, as an existing store can contain.
// Triggers still account every byte; no scientific/application owner state is forged.
fn seed_inactive_payload(
    connection: &mut rusqlite::Connection,
    scope: &ApplicationScope,
    budget: usize,
) -> usize {
    let tx = connection.transaction().unwrap();
    let mut remaining = budget;
    let mut index = 0;
    loop {
        let mut value = ComponentAgentConversation {
            title: "Task".into(), archived: false, draft_content: AgentDraftContent::default(), draft_grant: None,
            conversation_id: format!("stored-{index}"),
            version: 1,
            draft_version: 1,
            controller: ApplicationWindowRef {
                window_id: "history".into(),
                incarnation: "history".into(),
            },
            profile: ComponentAgentProfile::Project,
            draft: String::new(),
            active_run_id: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        };
        let overhead = serde_json::to_vec(&value).unwrap().len();
        if remaining < overhead {
            break;
        }
        value.draft = "x".repeat((remaining - overhead).min(32 * 1024));
        let encoded = serde_json::to_string(&value).unwrap();
        remaining -= encoded.len();
        tx.execute(
            "INSERT INTO component_agent_conversations VALUES(?1,?2,?3,1,NULL,0,?4)",
            rusqlite::params![
                scope.project,
                scope.principal,
                value.conversation_id,
                encoded
            ],
        )
        .unwrap();
        index += 1;
    }
    tx.commit().unwrap();
    budget - remaining
}

#[test]
fn project_payload_quota_reserves_native_completion_and_rolls_back_new_intents() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let original = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "accepted", mutation(), 6)
        .unwrap()
        .tool;
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &original.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(OperationId::new("native-original").unwrap()),
                application_request_id: None,
            },
            7,
        )
        .unwrap();
    let mut connection = rusqlite::Connection::open(&f.path).unwrap();
    let events: usize = connection
        .query_row(
            "SELECT COALESCE(SUM(bytes),0) FROM component_agent_events",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let reserved = MAX_COMPONENT_SETTINGS_RECORD_BYTES
        + MAX_COMPONENT_CONVERSATION_RECORD_BYTES
        + MAX_COMPONENT_RUN_RECORD_BYTES
        + MAX_COMPONENT_TOOL_RECORD_BYTES
        + events;
    let other = ApplicationScope {
        project: f.actor.scope().project.clone(),
        principal: "another-principal".into(),
    };
    seed_inactive_payload(
        &mut connection,
        &other,
        MAX_COMPONENT_PROJECT_PAYLOAD_BYTES - reserved - 1024,
    );
    assert_eq!(
        f.store
            .component_conversations(f.actor.scope(), None, 128)
            .unwrap()
            .len(),
        1
    );
    let before = f
        .store
        .component_run(f.actor.scope(), &run)
        .unwrap()
        .unwrap();
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM component_payload_bytes", [], |r| {
            r.get(0)
        })
        .unwrap();
    let mut next = mutation();
    if let ComponentToolAction::Invoke(i) = &mut next {
        i.arguments["code"] = json!("different code");
    }
    assert!(matches!(
        f.owner
            .admit_tool(f.actor.scope(), &run, 1, "new-obligation", next, 8),
        Err(ApplicationError::Budget(_))
    ));
    assert_eq!(
        f.store
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .tool_calls,
        before.run.tool_calls
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM component_payload_bytes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        count
    );
    assert_eq!(
        f.store
            .component_tools(f.actor.scope(), &run)
            .unwrap()
            .len(),
        1
    );
    assert!(matches!(
        f.owner.begin_model_test(
            &f.actor,
            &ComponentModelTestRequest {
                project_root: f.actor.scope().project.clone(),
                window: f.actor.window().clone(),
                request_id: "over-budget-test".into(),
                model_settings_version: 1,
                kind: ComponentModelTestKind::Connection
            },
            8
        ),
        Err(ApplicationError::Budget(_))
    ));
    assert!(
        f.store
            .component_diagnostic(f.actor.scope(), "over-budget-test")
            .unwrap()
            .is_none()
    );
    f.owner.stop(&f.actor, &run, 9).unwrap();
    f.owner
        .finish(
            f.actor.scope(),
            &run,
            ComponentAgentRunState::Stopped,
            None,
            10,
        )
        .unwrap();
    let result = json!({"status":"succeeded","output":"r".repeat(200*1024)});
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &original.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: result.clone(),
                evidence: vec![],
            },
            11,
        )
        .unwrap();
    let mut settings = f.store.component_settings(f.actor.scope()).unwrap();
    settings.enabled = false;
    f.owner.configure(&f.actor, &settings, 12).unwrap();
    let reopened = ApplicationStore::open(&f.path).unwrap();
    assert_eq!(
        reopened.component_tools(f.actor.scope(), &run).unwrap()[0]
            .receipt
            .result
            .as_ref(),
        Some(&result)
    );
    let bytes: usize = connection
        .query_row("SELECT SUM(bytes) FROM component_payload_bytes", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(bytes < MAX_COMPONENT_PROJECT_PAYLOAD_BYTES);
}

#[test]
fn payload_ledger_bootstraps_current_records_and_counts_unicode_bytes() {
    let f = Fixture::new();
    f.configure();
    f.owner
        .create(&f.actor, "unicode", ComponentAgentProfile::Project, 3)
        .unwrap();
    f.owner
        .save_draft(&f.actor, "unicode", 1, "测😀".repeat(100), 4)
        .unwrap();
    let connection = rusqlite::Connection::open(&f.path).unwrap();
    for table in [
        "component_agent_conversations",
        "component_agent_runs",
        "component_agent_tools",
        "component_agent_settings",
        "component_model_diagnostics",
    ] {
        for event in ["insert", "update", "delete"] {
            connection
                .execute_batch(&format!("DROP TRIGGER {table}_payload_{event}"))
                .unwrap();
        }
    }
    connection
        .execute_batch("DROP TABLE component_payload_bytes")
        .unwrap();
    let reopened = ApplicationStore::open(&f.path).unwrap();
    assert_eq!(
        reopened
            .component_conversation(f.actor.scope(), "unicode")
            .unwrap()
            .unwrap()
            .draft,
        "测😀".repeat(100)
    );
    let (bytes,characters):(usize,usize)=connection.query_row("SELECT length(CAST(value AS BLOB)),length(value) FROM component_agent_conversations WHERE conversation_id='unicode'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    let charged:usize=connection.query_row("SELECT bytes FROM component_payload_bytes WHERE kind='conversation' AND identity='unicode'",[],|r|r.get(0)).unwrap();
    assert_eq!(charged, bytes);
    assert!(bytes > characters);
}

#[test]
fn an_existing_oversized_store_can_finish_reserved_work_and_disable_without_losing_history() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let tool = f
        .owner
        .admit_tool(f.actor.scope(), &run, 1, "old-intent", mutation(), 6)
        .unwrap()
        .tool;
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Accepted {
                operation_id: Some(OperationId::new("old-native").unwrap()),
                application_request_id: None,
            },
            7,
        )
        .unwrap();
    let mut connection = rusqlite::Connection::open(&f.path).unwrap();
    seed_inactive_payload(
        &mut connection,
        &ApplicationScope {
            project: f.actor.scope().project.clone(),
            principal: "old-data".into(),
        },
        MAX_COMPONENT_PROJECT_PAYLOAD_BYTES,
    );
    assert!(matches!(
        f.owner.create(
            &f.actor,
            "new-obligation",
            ComponentAgentProfile::Project,
            8
        ),
        Err(ApplicationError::Budget(_))
    ));
    f.owner
        .record_tool(
            f.actor.scope(),
            &run,
            &tool.receipt.receipt_id,
            ComponentToolUpdate::Resolved {
                result: json!({"status":"succeeded","output":"r".repeat(200*1024)}),
                evidence: vec![],
            },
            9,
        )
        .unwrap();
    f.owner
        .finish(
            f.actor.scope(),
            &run,
            ComponentAgentRunState::Completed,
            None,
            10,
        )
        .unwrap();
    let mut settings = f.store.component_settings(f.actor.scope()).unwrap();
    settings.enabled = false;
    f.owner.configure(&f.actor, &settings, 11).unwrap();
    let reopened = ApplicationStore::open(&f.path).unwrap();
    assert_eq!(
        reopened
            .component_run(f.actor.scope(), &run)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Completed
    );
    assert_eq!(
        reopened.component_tools(f.actor.scope(), &run).unwrap()[0]
            .receipt
            .operation_id
            .as_ref()
            .unwrap()
            .as_str(),
        "old-native"
    );
    let retained: usize = connection
        .query_row(
            "SELECT COUNT(*) FROM component_agent_conversations WHERE principal='old-data'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(retained > 1000);
}

#[test]
fn all_seven_profiles_reject_unconfigured_and_insufficient_scope_requests() {
    for profile in [
        ComponentAgentProfile::Objects,
        ComponentAgentProfile::Packages,
        ComponentAgentProfile::Plots,
        ComponentAgentProfile::Documents,
        ComponentAgentProfile::Workspace,
        ComponentAgentProfile::Project,
        ComponentAgentProfile::Environment,
    ] {
        let f = Fixture::new();
        let unavailable = f.request("unconfigured", profile, ComponentAgentMode::Explain);
        assert!(
            f.owner.start(&f.actor, unavailable.clone(), 3).is_err(),
            "{profile:?}"
        );
        assert!(
            f.store
                .component_run_by_request(f.actor.scope(), &unavailable.request_id)
                .unwrap()
                .is_none()
        );
        f.configure();
        let mut forbidden = f.request("insufficient", profile, ComponentAgentMode::Run);
        if matches!(
            profile,
            ComponentAgentProfile::Documents
                | ComponentAgentProfile::Workspace
                | ComponentAgentProfile::Project
        ) {
            forbidden.grant.session = None;
        }
        assert!(
            f.owner.start(&f.actor, forbidden.clone(), 4).is_err(),
            "{profile:?}"
        );
        assert!(
            f.store
                .component_run_by_request(f.actor.scope(), &forbidden.request_id)
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn native_precondition_blocks_new_work_but_preserves_admitted_identity() {
    let f = Fixture::new();
    let run = f.running(ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let call = |id: &str| ComponentToolCall {
        model_call: 1, tool_call_id: id.into(), origin: None,
    };
    let blocked = f.owner.admit_tool_call_with_precondition(
        f.actor.scope(), &run, call("paused"), mutation(), Some("Queue paused"), 6,
    ).unwrap();
    assert!(!blocked.tool.receipt.mutation);
    assert_eq!(blocked.tool.receipt.phase, ComponentToolPhase::Resolved);
    assert_eq!(blocked.tool.receipt.result.as_ref().unwrap()["accepted"], false);
    assert!(blocked.tool.receipt.operation_id.is_none());
    let admitted = f.owner.admit_tool_call(
        f.actor.scope(), &run, call("resumed"), mutation(), 7,
    ).unwrap();
    assert!(admitted.tool.receipt.mutation);
    assert!(!admitted.repeated);
    let repeated = f.owner.admit_tool_call_with_precondition(
        f.actor.scope(), &run, call("repeat-after-pause"), mutation(), Some("Queue paused again"), 8,
    ).unwrap();
    assert!(repeated.repeated);
    assert_eq!(repeated.tool.receipt.receipt_id, admitted.tool.receipt.receipt_id);
    assert_eq!(repeated.tool.receipt.client_request_id, admitted.tool.receipt.client_request_id);
    let original_rejection = f.owner.admit_tool_call(
        f.actor.scope(), &run, call("paused"), mutation(), 9,
    ).unwrap();
    assert!(original_rejection.repeated);
    assert_eq!(original_rejection.tool.receipt.receipt_id, blocked.tool.receipt.receipt_id);
}

#[test]
fn run_history_is_scoped_bounded_and_stable_across_tied_timestamps() {
    let f = Fixture::new();
    f.configure();
    let mut request = f.request("history", ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let mut expected = Vec::new();
    for (index, now) in [10, 10, 11].into_iter().enumerate() {
        request.request_id = format!("history-{index}");
        request.text = "中文🧬".repeat(120);
        request.conversation_version = f.store.component_conversation(f.actor.scope(), "history").unwrap().unwrap().version;
        let run = f.owner.start(&f.actor, request.clone(), now).unwrap().run.run;
        f.owner.claim(f.actor.scope(), &run.run_id, now + 1).unwrap();
        f.owner.finish(f.actor.scope(), &run.run_id, ComponentAgentRunState::Completed, None, now + 2).unwrap();
        expected.push((now, run.run_id));
    }
    expected.sort_by(|a, b| b.cmp(a));
    let before_bytes = std::fs::read(&f.path).unwrap();
    let mut cursor = None;
    for (_, id) in &expected {
        let page = f.store.component_run_history(f.actor.scope(), "history", cursor.as_deref(), 1).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(&page[0].0.run_id, id);
        assert_eq!(page[0].0.state, ComponentAgentRunState::Completed);
        assert_eq!(page[0].0.text_excerpt.chars().count(), 240);
        assert!(serde_json::to_vec(&page[0].0).unwrap().len() < 2048);
        cursor = Some(id.clone());
    }
    assert!(f.store.component_run_history(f.actor.scope(), "history", cursor.as_deref(), 1).unwrap().is_empty());
    assert_eq!(std::fs::read(&f.path).unwrap(), before_bytes);
    assert!(f.store.component_run_history(f.actor.scope(), "history", None, 33).is_err());
    let mut hidden = f.actor.scope().clone(); hidden.principal = "another-principal".into();
    assert!(matches!(f.store.component_run_history(&hidden, "history", None, 1), Err(ApplicationError::NotFound)));
    hidden = f.actor.scope().clone(); hidden.project = "/another-project".into();
    assert!(matches!(f.store.component_run_history(&hidden, "history", None, 1), Err(ApplicationError::NotFound)));
    let other = f.request("other", ComponentAgentProfile::Workspace, ComponentAgentMode::Run);
    let other = f.owner.start(&f.actor, other, 15).unwrap().run.run;
    assert!(matches!(f.store.component_run_history(f.actor.scope(), "history", Some(&other.run_id), 1), Err(ApplicationError::NotFound)));
}

#[test]
fn structured_diagnostic_events_survive_owner_restart_with_original_next_reads() {
    let f = Fixture::new();
    let run_id = f.running(ComponentAgentProfile::Project, ComponentAgentMode::Explain);
    let diagnostic = Diagnostic { code: DiagnosticCode::ContentChanged, message: "The captured document changed".into(),
        continuation: DiagnosticContinuation::RefreshObservation,
        next_reads: vec![NextRead::query("application.read_document", "Inspect the identified document", json!({"document_id":"doc-one"}))] };
    f.owner.record_diagnostic(f.actor.scope(), &run_id, diagnostic.clone(), 6).unwrap();
    f.owner.finish(f.actor.scope(), &run_id, ComponentAgentRunState::Failed, Some(diagnostic.message.clone()), 7).unwrap();
    let reopened = ApplicationStore::open(&f.path).unwrap();
    let page = reopened.component_events(f.actor.scope(), &run_id, 0, 100).unwrap();
    let saved = page.events.into_iter().find_map(|event| match event.content {
        ComponentAgentEventContent::Diagnostic { diagnostic } => Some(diagnostic), _ => None,
    }).unwrap();
    assert_eq!(saved, diagnostic);
}

#[test]
fn full_task_draft_and_metadata_share_existing_cas_and_survive_reopen() {
    let f=Fixture::new();
    let conversation=f.owner.create(&f.actor,"full-draft",ComponentAgentProfile::Workspace,2).unwrap();
    let content=AgentDraftContent{text:"Compare the selected plot".into(),assets:vec![],context:vec![AgentContextSelection{source:"plots".into(),label:"Original plot".into(),reference:json!({"operation_id":"original-operation","sequence":1}),inclusion:"summary".into()}]};
    let grant=ComponentAgentGrant{mode:ComponentAgentMode::Explain,permission_policy:Some(ComponentPermissionPolicy::Ask),session:Some(ComponentAgentSession{workspace_instance_id:"main".into(),session_id:"native-one".into()}),documents:vec![],files:vec![]};
    f.owner.save_draft_content(&f.actor,"full-draft",conversation.draft_version,content.clone(),Some(grant.clone()),3).unwrap();
    assert!(matches!(f.owner.save_draft_content(&f.actor,"full-draft",conversation.draft_version,AgentDraftContent::default(),None,4),Err(ApplicationError::Conflict)));
    let saved=f.store.component_conversation(f.actor.scope(),"full-draft").unwrap().unwrap();
    f.owner.update_task_metadata(&f.actor,"full-draft",saved.version,Some("Plot comparison".into()),Some(true),5).unwrap();
    let reopened=ApplicationStore::open(&f.path).unwrap();
    let actual=reopened.component_conversation(f.actor.scope(),"full-draft").unwrap().unwrap();
    assert_eq!(actual.title,"Plot comparison"); assert!(actual.archived);
    assert_eq!(actual.draft,content.text); assert_eq!(actual.draft_version,saved.draft_version);
    assert_eq!(serde_json::to_value(&actual.draft_content).unwrap(),serde_json::to_value(content).unwrap());
    assert_eq!(serde_json::to_value(actual.draft_grant).unwrap(),serde_json::to_value(Some(grant)).unwrap());
    assert!(reopened.component_conversation(&ApplicationScope{project:"/other".into(),principal:f.actor.scope().principal.clone()},"full-draft").unwrap().is_none());
}

#[test]
fn uploaded_assets_share_byte_storage_but_keep_owner_kind_scope_and_immutable_identity() {
    let f = Fixture::new();
    f.configure();
    let request = f.request("asset-conversation", ComponentAgentProfile::Project, ComponentAgentMode::Explain);
    let asset = AgentAsset { asset_id: "uploaded-one".into(), name: "notes.txt".into(), mime_type: "text/plain".into(), bytes: 3, sha256: "fixture-hash".into() };
    f.owner.put_asset(&f.actor, "asset-conversation", &asset, b"one", 3).unwrap();
    f.owner.put_asset(&f.actor, "asset-conversation", &asset, b"one", 4).unwrap();
    assert!(matches!(f.owner.put_asset(&f.actor, "asset-conversation", &asset, b"two", 5), Err(ApplicationError::RequestConflict)));
    assert_eq!(f.store.component_asset(f.actor.scope(), "asset-conversation", &asset.asset_id).unwrap().1, b"one");
    assert!(matches!(f.store.agent_asset(&f.actor.scope().into(), "component:asset-conversation", &asset.asset_id), Err(AgentTaskError::NotFound)));
    let foreign = ApplicationScope { project: f.actor.scope().project.clone(), principal: "another-principal".into() };
    assert!(matches!(f.store.component_asset(&foreign, "asset-conversation", &asset.asset_id), Err(ApplicationError::NotFound)));
    f.owner.save_draft_content(&f.actor, "asset-conversation", 1, AgentDraftContent { text: "read upload".into(), assets: vec![asset.asset_id.clone()], context: vec![] }, None, 6).unwrap();
    let current = f.store.component_conversation(f.actor.scope(), "asset-conversation").unwrap().unwrap();
    assert!(f.owner.remove_asset(&f.actor, "asset-conversation", &asset.asset_id, 1, 7).is_err());
    f.owner.remove_asset(&f.actor, "asset-conversation", &asset.asset_id, current.draft_version, 8).unwrap();
    assert!(f.store.component_conversation(f.actor.scope(), "asset-conversation").unwrap().unwrap().draft_content.assets.is_empty());
    assert_eq!(f.store.component_asset(f.actor.scope(), &request.conversation_id, &asset.asset_id).unwrap().1, b"one");
}

#[test]
fn archived_rho_task_rejects_new_drafts_runs_and_uploads_but_can_be_unarchived() {
    let f=Fixture::new(); f.configure();
    let mut request=f.request("archived-task",ComponentAgentProfile::Workspace,ComponentAgentMode::Explain);
    f.owner.update_task_metadata(&f.actor,"archived-task",request.conversation_version,None,Some(true),3).unwrap();
    let archived=f.store.component_conversation(f.actor.scope(),"archived-task").unwrap().unwrap();
    request.conversation_version=archived.version;
    assert!(f.owner.start(&f.actor,request.clone(),4).is_err());
    assert!(f.owner.save_draft(&f.actor,"archived-task",archived.draft_version,"blocked".into(),4).is_err());
    let asset=AgentAsset{asset_id:"00000000-0000-0000-0000-000000000005".into(),name:"a.txt".into(),mime_type:"text/plain".into(),bytes:3,sha256:"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()};
    assert!(f.owner.put_asset(&f.actor,"archived-task",&asset,b"abc",4).is_err());
    assert!(f.store.component_run_by_request(f.actor.scope(),&request.request_id).unwrap().is_none());
    f.owner.update_task_metadata(&f.actor,"archived-task",archived.version,None,Some(false),5).unwrap();
    f.owner.save_draft(&f.actor,"archived-task",archived.draft_version,"Allowed after unarchive".into(),6).unwrap();
}


#[test]
fn pending_permission_summarizes_the_bound_file_target_without_changing_its_action() {
    let f = Fixture::new();
    f.configure();
    let document = ApplicationDocumentRef { document_id: "document-one".into(), document_version: "v1".into(), selection_version: "selection-one".into() };
    let mut request = f.request("target-summary", ComponentAgentProfile::Project, ComponentAgentMode::Explain);
    request.grant.permission_policy = Some(ComponentPermissionPolicy::Ask);
    request.grant.documents.push(ComponentDocumentGrant { document: document.clone(), allow_save: false, path: Some("scripts/analysis.R".into()) });
    let run = f.owner.start(&f.actor, request.clone(), 3).unwrap().run.run;
    f.owner.claim(f.actor.scope(), &run.run_id, 4).unwrap();
    f.owner.begin_model_call(f.actor.scope(), &run.run_id, 5).unwrap();
    f.owner.capture_task_intent(f.actor.scope(), &run.run_id, &ComponentAgentTaskIntent {
        request_id: request.request_id, request_excerpt: request.text, actions: vec![],
    }, 6).unwrap();
    let tool = f.owner.admit_tool(f.actor.scope(), &run.run_id, 1, "save-selected-file",
        ComponentToolAction::Control(ApplicationCommandRequest { window: f.actor.window().clone(), request_id: "input-id".into(), execution_target: None,
            action: ApplicationAction::Save { document, target_path: Some("scripts/analysis.R".into()) } }), 7).unwrap().tool;
    let original_action = serde_json::to_value(&tool.action).unwrap();
    let permission = f.owner.record_permission(f.actor.scope(), &run.run_id, &tool.receipt.receipt_id,
        "technical_tool_label", ComponentTaskAuthorization::Additional, false, 8).unwrap();
    assert_eq!(permission.title, "Save scripts/analysis.R");
    assert_eq!(permission.action_digest, tool.receipt.action_digest);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&permission.details).unwrap(), original_action);
    let saved = f.store.component_tools(f.actor.scope(), &run.run_id).unwrap();
    assert_eq!(serde_json::to_value(&saved[0].action).unwrap(), original_action);
    assert_eq!(saved[0].receipt.action_digest, tool.receipt.action_digest);
}
