//! Lost application acknowledgements are reconciled without model/native replay.
use async_trait::async_trait;
use rho_application::*;
use rho_contract::*;
use rho_host::{ApplicationStore, ComponentAgentService, NextHost};
use serde_json::json;
use std::sync::Arc;

struct IntentOnly;

struct CountReadOnlyCalls(Arc<std::sync::atomic::AtomicUsize>);
#[async_trait]
impl ComponentAgentEngine for CountReadOnlyCalls {
    async fn execute(&self,request:ComponentEngineExecution)->ComponentEngineOutcome {
        self.0.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
        request.port.begin_model_call().await.unwrap();
        request.port.append_text("Observed document".into()).await.unwrap();
        ComponentEngineOutcome::Completed
    }
}

#[tokio::test]
async fn new_policy_continue_rechecks_the_current_document_before_model_admission() {
    let directory=tempfile::tempdir().unwrap();let project=directory.path().canonicalize().unwrap().to_string_lossy().into_owned();
    let host=Arc::new(NextHost::open_project(directory.path().join("science.sqlite"),&project).await.unwrap());
    let mut context=NextHost::local_context();context.connection_id="studio:document-validation".into();
    let registered=register(&host,&context,"document-validation").await;
    let window=registered.session.window.clone();
    let mut document=ApplicationDocument{document_id:"selected".into(),version:"v1".into(),path:Some("analysis.R".into()),text:"x <- 1\n".into(),
        base_text:None,base_hash:None,selection:ApplicationSelection{anchor:0,head:0,version:"s1".into()},readonly_reason:None};
    recovery_bridge(&host,&context,ApplicationBridgeRequest::Sync{session:registered.session.clone(),sync_id:"document".into(),
        changes:ApplicationChanges{documents:vec![ApplicationDocumentUpdate{expected_version:None,expected_selection_version:None,document:document.clone()}],..Default::default()}}).await;
    let calls=Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let service=ComponentAgentService::with_engine(Arc::new(ApplicationStore::open(&directory.path().join("components.sqlite")).unwrap()),Arc::new(CountReadOnlyCalls(calls.clone())));
    let key=service.put_session_key(&host,&context,&project,&window,"fixture".into()).unwrap();
    service.configure(&host,&context,&project,&window,&ComponentModelSettings{version:0,enabled:true,connection:Some(ComponentModelConnection{
        protocol:ComponentModelProtocol::Anthropic,base_url:"https://unused.example".into(),model:"fixture".into(),credential:key})}).await.unwrap();
    let conversation=service.create(&host,&context,&project,&window,"task",ComponentAgentProfile::Documents).unwrap();
    let mut request=ComponentAgentStart{assets:None,continuation:None,request_id:"first".into(),conversation_id:conversation.conversation_id,
        conversation_version:conversation.version,window:window.clone(),model_settings_version:1,text:"Explain the selected document".into(),sources:vec![],
        grant:ComponentAgentGrant{permission_policy:Some(ComponentPermissionPolicy::Ask),mode:ComponentAgentMode::Explain,session:None,
            documents:vec![ComponentDocumentGrant{document:document_ref(&document),path:document.path.clone(),allow_save:false}],files:vec![]}};
    let first=service.start(host.clone(),context.clone(),&project,request.clone()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5),async{loop{
        if service.run(&host,&context,&project,&first.run_id).unwrap().state.is_terminal(){break;}
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }}).await.unwrap();
    let checked=service.reconcile(&host,&context,&project,&window,&first.run_id).await.unwrap();
    let previous=document.clone();document.version="v2".into();document.text.push_str("# later user edit\n");
    recovery_bridge(&host,&context,ApplicationBridgeRequest::Sync{session:registered.session,sync_id:"later-edit".into(),
        changes:ApplicationChanges{documents:vec![ApplicationDocumentUpdate{expected_version:Some(previous.version),expected_selection_version:Some(previous.selection.version),document}],..Default::default()}}).await;
    request.request_id="continue".into();request.text="Continue explaining".into();
    request.conversation_version=service.conversation(&host,&context,&project,&request.conversation_id).unwrap().version;
    request.continuation=Some(ComponentContinuation{run_id:first.run_id,recovery_digest:checked.recovery.unwrap().digest});
    let error=service.start(host.clone(),context,&project,request).await.unwrap_err();
    assert!(error.to_string().contains("continuation document"),"{error}");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),1);
    service.close().await;
}

struct LostDocumentResult {
    host: Arc<NextHost>,
    context: CallContext,
    applied: Arc<tokio::sync::Notify>,
    create: bool,
}
#[async_trait]
impl ComponentAgentEngine for LostDocumentResult {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let result = async {
            let call = request.port.begin_model_call().await?;
            let navigation = if self.create { "application_create_document" } else { "application_open_document" };
            if request.run.request.continuation.is_none() {
                let mut actions = vec![json!({"action":"edit","document_id":null,"path":"recovered.R"}),
                    json!({"action":"save","document_id":null,"path":"recovered.R"})];
                if self.create {actions.push(json!({"action":"create","document_id":null,"path":"recovered.R"}));}
                let intent = request.port.prepare_tool(call,"intent","rho_task_intent",
                    json!({"request_excerpt":request.run.request.text,"actions":actions})).await?;
                request.port.execute_tool(intent).await?;
                let prepared = request.port.prepare_tool(call,"navigation",navigation,json!({"path":"recovered.R"})).await?;
                let ComponentToolAction::Control(command) = prepared.tool.action else {panic!("Expected document action");};
                let mut native = self.context.clone();
                native.principal = Some(self.context.principal().clone());
                native.caller = CallerIdentity {kind:CallerKind::Agent,id:format!("component:{}",request.run.run_id)};
                native.connection_id = native.caller.id.clone();
                native.correlation_id = Some(request.run.run_id.clone());
                self.host.dispatch(&native,HostRequest::ApplicationControl(command)).await.unwrap();
                self.applied.notified().await;
                return Err(ApplicationError::InvalidInput("Injected lost component result after Application Applied".into()));
            }
            assert_eq!(request.run.document_grants.len(),1);
            let reference = request.run.document_grants[0].document.clone();
            let repeated = request.port.prepare_tool(call,"same-navigation",navigation,json!({"path":"recovered.R"})).await?;
            assert!(matches!(repeated.tool.action,ComponentToolAction::PreviousResult{..}));
            let previous = request.port.execute_tool(repeated).await?;
            assert_eq!(previous["executed_again"],false);
            for (name,args) in [
                ("application_edit_document",json!({"document_id":reference.document_id,"edits":[{"from":0,"to":0,"insert":"x <- 1\n"}]})),
                ("application_save_document",json!({"document_id":reference.document_id})),
            ] {
                let ticket = request.port.prepare_tool(call,name,name,args).await?;
                request.port.execute_tool(ticket).await?;
            }
            Ok::<_,ApplicationError>(())
        }.await;
        match result {Ok(())=>ComponentEngineOutcome::Completed,Err(error)=>ComponentEngineOutcome::Failed(error.to_string())}
    }
}

async fn recovery_bridge(host: &NextHost, context: &CallContext, request: ApplicationBridgeRequest) -> ApplicationBridgeReply {
    serde_json::from_value(host.dispatch(context,HostRequest::ApplicationBridge(request)).await.unwrap()).unwrap()
}

#[tokio::test]
async fn applied_document_with_lost_component_result_is_recovered_for_continue_edit_save_without_recreation() {
    for create in [false,true] { recover_lost_document_result(create,false).await; }
}

#[tokio::test]
async fn lost_document_result_does_not_adopt_unrelated_later_user_edits() {
    recover_lost_document_result(true,true).await;
}

async fn recover_lost_document_result(create: bool, user_edit: bool) {
    let directory=tempfile::tempdir().unwrap();
    let project=directory.path().canonicalize().unwrap().to_string_lossy().into_owned();
    let initial=if create {""} else {"# initial\n"};
    if !create {std::fs::write(directory.path().join("recovered.R"),initial).unwrap();}
    let host=Arc::new(NextHost::open_project(directory.path().join("science.sqlite"),&project).await.unwrap());
    let mut context=NextHost::local_context();context.connection_id="studio:lost-document".into();
    let registration=register(&host,&context,"lost-document").await;
    let bridge=registration.session.clone();let window=bridge.window.clone();
    let store=Arc::new(ApplicationStore::open(&directory.path().join("components.sqlite")).unwrap());
    let signal=Arc::new(tokio::sync::Notify::new());
    let service=ComponentAgentService::with_engine(store.clone(),Arc::new(LostDocumentResult{
        host:host.clone(),context:context.clone(),applied:signal.clone(),create}));
    let key=service.put_session_key(&host,&context,&project,&window,"fixture-only".into()).unwrap();
    service.configure(&host,&context,&project,&window,&ComponentModelSettings{version:0,enabled:true,
        connection:Some(ComponentModelConnection{protocol:ComponentModelProtocol::Anthropic,
            base_url:"https://unused.example".into(),model:"fixture".into(),credential:key})}).await.unwrap();
    let conversation=service.create(&host,&context,&project,&window,"lost-result",ComponentAgentProfile::Objects).unwrap();
    let request=ComponentAgentStart{ assets: None,continuation:None,request_id:"original-navigation".into(),
        conversation_id:conversation.conversation_id,conversation_version:conversation.version,
        window:window.clone(),model_settings_version:1,text:if create {"Create recovered.R, edit it and save it"}else{"Open recovered.R, edit it and save it"}.into(),
        grant:ComponentAgentGrant{permission_policy:Some(ComponentPermissionPolicy::Ask),mode:ComponentAgentMode::Explain,
            session:None,documents:vec![],files:vec![]},sources:vec![]};
    let first=service.start(host.clone(),context.clone(),&project,request.clone()).await.unwrap();
    let mut document=ApplicationDocument{document_id:"recovered-document".into(),version:"v1".into(),
        path:Some("recovered.R".into()),text:initial.into(),base_text:(!create).then(||initial.into()),
        base_hash:(!create).then(||sha256(initial)),selection:ApplicationSelection{anchor:0,head:0,version:"selection".into()},readonly_reason:None};
    let mut app_context=registration.context;
    let mut navigation_count=0;
    let mut edits=0;
    let mut saves=0;
    for stage in 0..2 {
        let current = if stage==0 {first.clone()} else {
            let reconciled=service.reconcile(&host,&context,&project,&window,&first.run_id).await.unwrap();
            if user_edit {
                assert_eq!(reconciled.recovery.as_ref().unwrap().unresolved_mutations,1);
                assert!(reconciled.document_grants.is_empty());
                break;
            }
            assert_eq!(reconciled.document_grants.len(),1,"{:#?}",reconciled.recovery);
            assert_eq!(reconciled.document_grants[0].document,document_ref(&document));
            assert_eq!(reconciled.document_grants[0].path.as_deref(),Some("recovered.R"));
            let report=reconciled.recovery.unwrap();assert_eq!(report.unresolved_mutations,0);
            let navigation=report.tools.iter().find(|tool|tool.application_state==Some(ApplicationCommandState::Applied)).unwrap();
            assert_eq!(navigation.documents,vec![document_ref(&document)]);
            let mut next=request.clone();next.request_id="continue-navigation".into();next.text="Continue".into();
            next.conversation_version=service.conversation(&host,&context,&project,&next.conversation_id).unwrap().version;
            next.continuation=Some(ComponentContinuation{run_id:first.run_id.clone(),recovery_digest:report.digest});
            service.start(host.clone(),context.clone(),&project,next).await.unwrap()
        };
        tokio::time::timeout(std::time::Duration::from_secs(10),async {
            loop {
                let observed=service.run(&host,&context,&project,&current.run_id).unwrap();
                if observed.state.is_terminal() {
                    assert_eq!(observed.state,if stage==0 {ComponentAgentRunState::Failed}else{ComponentAgentRunState::Completed},"{:?}",observed.reason);
                    if stage==0 {assert!(observed.document_grants.is_empty());}
                    break;
                }
                let claim=recovery_bridge(&host,&context,ApplicationBridgeRequest::Claim{session:bridge.clone(),claim_request_id:uuid::Uuid::new_v4().to_string()}).await;
                let ApplicationBridgeReply::Claimed(Some(grant))=claim else {tokio::time::sleep(std::time::Duration::from_millis(10)).await;continue;};
                let mut changes=ApplicationChanges::default();
                match &grant.request.action {
                    ApplicationAction::CreateDocument{..}|ApplicationAction::OpenDocument{..}=>{
                        navigation_count+=1;assert_eq!(navigation_count,1,"Original document action was replayed");
                        let expected=app_context.version.clone();app_context.version="opened-context".into();app_context.active_document_id=Some(document.document_id.clone());
                        changes.context=Some(ApplicationContextUpdate{expected_version:expected,context:app_context.clone()});
                        changes.documents.push(ApplicationDocumentUpdate{expected_version:None,expected_selection_version:None,document:document.clone()});
                    },
                    ApplicationAction::EditDocument{document:reference,edits:replacements}=>{
                        assert_eq!(reference,&document_ref(&document));let before=document.clone();
                        for replacement in replacements.iter().rev(){document.text.replace_range(replacement.from as usize..replacement.to as usize,&replacement.insert);}
                        document.version="edited".into();edits+=1;
                        changes.documents.push(ApplicationDocumentUpdate{expected_version:Some(before.version),expected_selection_version:Some(before.selection.version),document:document.clone()});
                    },
                    ApplicationAction::Save{..}=>{},other=>panic!("Unexpected action {other:?}"),
                }
                recovery_bridge(&host,&context,ApplicationBridgeRequest::Complete{session:bridge.clone(),completion:ApplicationCommandCompletion{
                    request_id:grant.request.request_id.clone(),claim_id:grant.claim_id,outcome:ApplicationLocalOutcome::Applied,changes,diagnostic:None}}).await;
                if stage==0 {signal.notify_one();}
                if let Some(execution_ref)=grant.execution_ref {
                    let result:ApplicationExecuteReply=serde_json::from_value(host.dispatch(&context,HostRequest::ApplicationExecute(ApplicationExecuteRequest{
                        session:bridge.clone(),request_id:grant.request.request_id.clone(),execution_ref:execution_ref.clone(),step:ApplicationExecutionStep::Save})).await.unwrap()).unwrap();
                    assert_eq!(result.receipt.save.as_ref().unwrap().state,ApplicationStepState::Succeeded);saves+=1;
                    let before=document.clone();document.base_text=Some(document.text.clone());document.base_hash=Some(result.receipt.capture.unwrap().sha256);document.version="saved".into();
                    recovery_bridge(&host,&context,ApplicationBridgeRequest::Sync{session:bridge.clone(),sync_id:uuid::Uuid::new_v4().to_string(),changes:ApplicationChanges{
                        documents:vec![ApplicationDocumentUpdate{expected_version:Some(before.version),expected_selection_version:Some(before.selection.version),document:document.clone()}],..Default::default()}}).await;
                    recovery_bridge(&host,&context,ApplicationBridgeRequest::ConfirmSaved{session:bridge.clone(),request_id:grant.request.request_id,execution_ref,document:document_ref(&document)}).await;
                }
            }
        }).await.unwrap();
        if stage==0 && user_edit {
            let before=document.clone();document.text.push_str("# user's later edit\n");document.version="user-edit".into();
            recovery_bridge(&host,&context,ApplicationBridgeRequest::Sync{session:bridge.clone(),sync_id:"later-user-edit".into(),changes:ApplicationChanges{
                documents:vec![ApplicationDocumentUpdate{expected_version:Some(before.version),expected_selection_version:Some(before.selection.version),document:document.clone()}],..Default::default()}}).await;
        }
    }
    assert_eq!(navigation_count,1);
    if !user_edit {assert_eq!((edits,saves),(1,1));assert_eq!(std::fs::read_to_string(directory.path().join("recovered.R")).unwrap(),document.text);}
    service.close().await;
}
#[async_trait]
impl ComponentAgentEngine for IntentOnly {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let result=async {
            let call=request.port.begin_model_call().await?;
            request.port.prepare_tool(call,"not-dispatched","application_edit_document",
                json!({"document_id":"doc","edits":[{"from":0,"to":0,"insert":"# proposed\n"}]})).await?;
            Ok::<_,ApplicationError>(())
        }.await;
        match result {
            Ok(()) => ComponentEngineOutcome::Failed("Injected exit after durable intent".into()),
            Err(e) => ComponentEngineOutcome::Failed(e.to_string()),
        }
    }
}
async fn register(
    host: &NextHost,
    context: &CallContext,
    id: &str,
) -> ApplicationBridgeRegistration {
    let value = host
        .dispatch(
            context,
            HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                window_id: id.into(),
                incarnation: format!("{id}-life"),
                label: id.into(),
                previous_session: None,
            }),
        )
        .await
        .unwrap();
    let ApplicationBridgeReply::Registered(r) = serde_json::from_value(value).unwrap() else {
        panic!()
    };
    r
}

#[tokio::test]
async fn orphaned_intent_is_not_dispatched_and_takeover_fences_the_old_window() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    std::fs::write(temp.path().join("analysis.R"), "x <- 1\n").unwrap();
    let host = Arc::new(
        NextHost::open_project(temp.path().join("science.sqlite"), &project)
            .await
            .unwrap(),
    );
    let store = Arc::new(ApplicationStore::open(&temp.path().join("components.sqlite")).unwrap());
    let service = ComponentAgentService::with_engine(store.clone(), Arc::new(IntentOnly));
    let mut context = NextHost::local_context();
    context.connection_id = "studio:recovery".into();
    let registration = register(&host, &context, "first").await;
    let window = registration.session.window.clone();
    let document = ApplicationDocument {
        document_id: "doc".into(),
        version: "v1".into(),
        path: Some("analysis.R".into()),
        text: "x <- 1\n".into(),
        base_text: Some("x <- 1\n".into()),
        base_hash: Some(sha256("x <- 1\n")),
        selection: ApplicationSelection {
            anchor: 0,
            head: 0,
            version: "s1".into(),
        },
        readonly_reason: None,
    };
    host.dispatch(
        &context,
        HostRequest::ApplicationBridge(ApplicationBridgeRequest::Sync {
            session: registration.session,
            sync_id: "initial".into(),
            changes: ApplicationChanges {
                documents: vec![ApplicationDocumentUpdate {
                    expected_version: None,
                    expected_selection_version: None,
                    document: document.clone(),
                }],
                ..Default::default()
            },
        }),
    )
    .await
    .unwrap();
    let key = service
        .put_session_key(&host, &context, &project, &window, "fixture-only".into())
        .unwrap();
    service
        .configure(
            &host,
            &context,
            &project,
            &window,
            &ComponentModelSettings {
                version: 0,
                enabled: true,
                connection: Some(ComponentModelConnection {
                    protocol: ComponentModelProtocol::Anthropic,
                    base_url: "https://unused.example".into(),
                    model: "no-provider".into(),
                    credential: key,
                }),
            },
        )
        .await
        .unwrap();
    let conversation = service
        .create(
            &host,
            &context,
            &project,
            &window,
            "recovery",
            ComponentAgentProfile::Documents,
        )
        .unwrap();
    service
        .save_draft(
            &host,
            &context,
            &project,
            &window,
            ComponentAgentDraftUpdate {
                content: None, grant: None,
                conversation_id: conversation.conversation_id.clone(),
                draft_version: 1,
                text: "Keep this user draft".into(),
            },
        )
        .unwrap();
    let conversation = service
        .conversation(&host, &context, &project, "recovery")
        .unwrap();
    let run = service
        .start(
            host.clone(),
            context.clone(),
            &project,
            ComponentAgentStart { assets: None, continuation: None,
                request_id: "original".into(),
                conversation_id: "recovery".into(),
                conversation_version: conversation.version,
                window: window.clone(),
                model_settings_version: 1,
                text: "Edit the selected document".into(),
                grant: ComponentAgentGrant {
                    permission_policy: None,
                    mode: ComponentAgentMode::Edit,
                    session: None,
                    documents: vec![ComponentDocumentGrant {
                        document: document_ref(&document),
                        allow_save: false,
                        path: document.path.clone(),
                    }],
                    files: vec![],
                },
                sources: vec![],
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if service
                .run(&host, &context, &project, &run.run_id)
                .unwrap()
                .state
                .is_terminal()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    service.close().await;
    let scope = ApplicationScope {
        project: project.clone(),
        principal: serde_json::to_string(context.principal()).unwrap(),
    };
    // Inject only the missing final application acknowledgement; no science is invented.
    let mut stored = store.component_run(&scope, &run.run_id).unwrap().unwrap();
    assert_eq!(store.component_tools(&scope, &run.run_id).unwrap().len(), 1);
    stored.run.state = ComponentAgentRunState::Running;
    let mut conversation = store
        .component_conversation(&scope, "recovery")
        .unwrap()
        .unwrap();
    let version = conversation.version;
    conversation.version += 1;
    conversation.active_run_id = Some(run.run_id.clone());
    store
        .commit_component(
            &scope,
            ComponentWrite {
                expected_version: Some(version),
                conversation: &conversation,
                run: Some(&stored),
                tools: &[],
                events: &[],
            },
        )
        .unwrap();

    assert_eq!(
        service
            .observe_run(&host, &context, &project, &run.run_id)
            .await
            .unwrap()
            .state,
        ComponentAgentRunState::Interrupted
    );
    let history = service.run_history(&host, &context, ComponentAgentsQuery {
        project_root: project.clone(), query: ComponentAgentQuery::Runs {
            conversation_id: run.request.conversation_id.clone(), before: None, limit: 32,
        },
    }).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].run_id, run.run_id);
    assert_eq!(history[0].state, ComponentAgentRunState::Interrupted);
    assert_eq!(
        store
            .component_run(&scope, &run.run_id)
            .unwrap()
            .unwrap()
            .run
            .state,
        ComponentAgentRunState::Running
    );
    let replacement = ComponentAgentService::new(store.clone());
    assert_eq!(
        replacement
            .run(&host, &context, &project, &run.run_id)
            .unwrap()
            .state,
        ComponentAgentRunState::Interrupted
    );
    let recovered = replacement
        .reconcile(&host, &context, &project, &window, &run.run_id)
        .await
        .unwrap();
    let report = recovered.recovery.unwrap();
    assert_eq!(report.unresolved_mutations, 0);
    assert_eq!(report.tools[0].state, ComponentRecoveryState::NotSubmitted);
    assert!(report.tools[0].operations.is_empty());
    assert_eq!(recovered.model_calls, stored.run.model_calls);
    assert_eq!(
        replacement
            .reconcile(&host, &context, &project, &window, &run.run_id)
            .await
            .unwrap()
            .recovery
            .unwrap(),
        report
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("analysis.R")).unwrap(),
        "x <- 1\n"
    );
    let second = register(&host, &context, "second").await.session.window;
    let before = replacement
        .conversation(&host, &context, &project, "recovery")
        .unwrap();
    assert!(
        replacement
            .take_control(
                &host,
                &context,
                &project,
                &second,
                "recovery",
                before.version - 1
            )
            .await
            .is_err()
    );
    let after = replacement
        .take_control(
            &host,
            &context,
            &project,
            &second,
            "recovery",
            before.version,
        )
        .await
        .unwrap();
    assert_eq!(after.controller, second);
    assert_eq!(after.draft, "Keep this user draft");
    assert!(
        replacement
            .save_draft(
                &host,
                &context,
                &project,
                &window,
                ComponentAgentDraftUpdate {
                content: None, grant: None,
                    conversation_id: "recovery".into(),
                    draft_version: after.draft_version,
                    text: "old window".into()
                }
            )
            .is_err()
    );
    assert!(host.is_idle());
    replacement.close().await;
}
