//! Lost application acknowledgements are reconciled without model/native replay.
use async_trait::async_trait;
use rho_application::*;
use rho_contract::*;
use rho_host::{ApplicationStore, ComponentAgentService, NextHost};
use serde_json::json;
use std::sync::Arc;

struct IntentOnly;
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
            ComponentAgentStart {
                request_id: "original".into(),
                conversation_id: "recovery".into(),
                conversation_version: conversation.version,
                window: window.clone(),
                model_settings_version: 1,
                text: "Edit the selected document".into(),
                grant: ComponentAgentGrant {
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
