use async_trait::async_trait;
use rho_application::{ComponentAgentEngine, ComponentEngineExecution, ComponentEngineOutcome};
use rho_contract::*;
use rho_host::{ApplicationStore, ArkConfig, ComponentAgentService, NextHost};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Capture(Arc<Mutex<Option<(String, usize)>>>);
#[async_trait]
impl ComponentAgentEngine for Capture {
    async fn test_model(
        &self,
        _: ComponentModelConnection,
        _: rho_application::ComponentModelKey,
        _: ComponentModelTestKind,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        assert_eq!(request.images.len(), 1);
        assert!(request.images[0].base64.starts_with("iVBOR"));
        assert_eq!(request.images[0].mime_type, "image/png");
        assert!(!request.context.contains(&request.images[0].base64));
        *self.0.lock().unwrap() = Some((request.context, request.images.len()));
        ComponentEngineOutcome::Completed
    }
}

#[tokio::test]
#[ignore = "requires real Ark/R; explicit component source acceptance"]
async fn real_objects_packages_and_plot_sources_are_verified_without_new_operations() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().canonicalize().unwrap();
    let database = project.join("journal.sqlite");
    let host = Arc::new(
        NextHost::open_ark(
            &database,
            ArkConfig {
                executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK")),
                r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME")),
                project_root: project.clone(),
                data_root: project.join("runtime"),
                execution_timeout: Duration::from_secs(30),
                library_path: None,
                checkpoint_helper_path: None,
            },
        )
        .await
        .unwrap(),
    );
    let mut context = NextHost::local_context();
    context.connection_id = "studio:sources-test".into();
    let setup=host.invoke(&context,Invocation{client_request_id:"setup".into(),capability:CapabilityRef::new("workspace.run_r",1).unwrap(),arguments:json!({"workspace_instance_id":"main","code":"source_data <- data.frame(x = 1:3, y = c(7, 11, 19)); plot.new(); rect(0, 0, 1, 1, col = 'red', border = NA); invisible(NULL)"}),preconditions:vec![]}).await.unwrap();
    assert_eq!(setup.status, OperationStatus::Succeeded);
    let output: RunROutput = serde_json::from_value(setup.output.unwrap()).unwrap();
    let media = output
        .output_references
        .iter()
        .find(|r| r.mime_type.starts_with("image/"))
        .unwrap()
        .clone();
    let session = ComponentAgentSession {
        workspace_instance_id: "main".into(),
        session_id: output.session_id,
    };
    let ApplicationBridgeReply::Registered(registration) = serde_json::from_value(
        host.dispatch(
            &context,
            HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                window_id: "source-window".into(),
                incarnation: "source-life".into(),
                label: "Sources".into(),
                previous_session: None,
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap() else {
        panic!()
    };
    let window = registration.session.window;
    let captured = Arc::new(Mutex::new(None));
    let service = ComponentAgentService::with_engine(
        Arc::new(ApplicationStore::open(&project.join("components.sqlite")).unwrap()),
        Arc::new(Capture(captured.clone())),
    );
    let root = project.to_str().unwrap();
    let credential = service
        .put_session_key(&host, &context, root, &window, "fixture-only".into())
        .unwrap();
    service
        .configure(
            &host,
            &context,
            root,
            &window,
            &ComponentModelSettings {
                version: 0,
                enabled: true,
                connection: Some(ComponentModelConnection {
                    protocol: ComponentModelProtocol::Anthropic,
                    base_url: "https://unused.example".into(),
                    model: "capture-only".into(),
                    credential,
                }),
            },
        )
        .await
        .unwrap();
    service
        .test_model(
            host.clone(),
            context.clone(),
            ComponentModelTestRequest {
                project_root: root.into(),
                window: window.clone(),
                request_id: "verify-images".into(),
                model_settings_version: 1,
                kind: ComponentModelTestKind::Images,
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if service
                .diagnostic(&host, &context, root, "verify-images")
                .unwrap()
                .unwrap()
                .state
                == ComponentModelTestState::Passed
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    for (source, text) in [
        ("objects", "source_data"),
        ("tables", "source_data"),
        ("packages", "stats"),
        ("environment", "Main"),
        ("workspace", ""),
    ] {
        let found = service
            .search_sources(
                &host,
                &context,
                ComponentSourceSearch {
                    project_root: root.into(),
                    window: window.clone(),
                    session: Some(session.clone()),
                    source: source.into(),
                    text: text.into(),
                    limit: 10,
                },
            )
            .await
            .unwrap();
        assert!(!found.items.is_empty(), "{source}: {:?}", found.notices);
    }
    let inventory=host.dispatch(&context,HostRequest::QuerySnapshot(QueryRequest{capability:CapabilityRef::new("workspace.packages",1).unwrap(),arguments:json!({"workspace_instance_id":"main","expected_session":session.session_id,"package_name":"stats","mode":"installed"})})).await.unwrap();
    let copy = &inventory["data"]["packages"][0];
    let inputs = vec![
        AgentContextSelection {
            source: "objects".into(),
            label: "source_data".into(),
            reference: json!({"workspace_instance_id":"main","expected_session":session.session_id,"name":"source_data"}),
            inclusion: "selection".into(),
        },
        AgentContextSelection {
            source: "packages".into(),
            label: "stats".into(),
            reference: json!({"workspace_instance_id":"main","expected_session":session.session_id,"observation_id":inventory["data"]["observation_id"],"package":"stats","library_path":copy["library_path"]}),
            inclusion: "summary".into(),
        },
        AgentContextSelection {
            source: "plots".into(),
            label: "Plot".into(),
            reference: serde_json::to_value(&media).unwrap(),
            inclusion: "image".into(),
        },
    ];
    let connection = rusqlite::Connection::open(&database).unwrap();
    let count = || {
        connection
            .query_row("SELECT COUNT(*) FROM operations", [], |r| {
                r.get::<_, u64>(0)
            })
            .unwrap()
    };
    let before = count();
    let mut sources = vec![];
    for selection in inputs {
        let preview = service
            .preview_source(
                &host,
                &context,
                ComponentSourcePreviewRequest {
                    project_root: root.into(),
                    window: window.clone(),
                    session: Some(session.clone()),
                    selection,
                },
            )
            .await
            .unwrap();
        assert!(preview.error.is_none(), "{:?}", preview.error);
        sources.push(preview.snapshot.unwrap().selection);
    }
    let conversation = service
        .create(
            &host,
            &context,
            root,
            &window,
            "source-conversation",
            ComponentAgentProfile::Project,
        )
        .unwrap();
    let run = service
        .start(
            host.clone(),
            context.clone(),
            root,
            ComponentAgentStart { assets: None, continuation: None,
                request_id: "with-sources".into(),
                conversation_id: conversation.conversation_id,
                conversation_version: conversation.version,
                window: window.clone(),
                model_settings_version: 1,
                text: "Inspect selected context".into(),
                grant: ComponentAgentGrant {
                    permission_policy: None,
                    mode: ComponentAgentMode::Explain,
                    session: Some(session.clone()),
                    documents: vec![],
                    files: vec![],
                },
                sources,
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if service
                .run(&host, &context, root, &run.run_id)
                .unwrap()
                .state
                .is_terminal()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let final_run = service.run(&host, &context, root, &run.run_id).unwrap();
    assert_eq!(
        final_run.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        final_run.reason
    );
    let (text, images) = captured.lock().unwrap().clone().unwrap();
    assert_eq!(images, 1);
    assert!(text.contains("source_data") && text.contains("stats"));
    assert_eq!(final_run.context.unwrap().sources.len(), 3);
    assert_eq!(count(), before);
    let bad=service.preview_source(&host,&context,ComponentSourcePreviewRequest{project_root:root.into(),window,session:Some(session),selection:AgentContextSelection{source:"objects".into(),label:"wrong".into(),reference:json!({"workspace_instance_id":"another","expected_session":"another","name":"source_data"}),inclusion:"summary".into()}}).await;
    assert!(bad.is_err());
    service.close().await;
}
