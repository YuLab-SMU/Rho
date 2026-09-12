use async_trait::async_trait;
use rho_application::*;
use rho_contract::*;
use rho_host::{ApplicationStore, ArkConfig, ComponentAgentService, NextHost};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct RunEngine {
    code: String,
    repeat: bool,
    results: Arc<Mutex<Vec<Value>>>,
}
#[async_trait]
impl ComponentAgentEngine for RunEngine {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let cancellation = request.cancellation.clone();
        let work = async {
            let turn = request.port.begin_model_call().await?;
            let ticket = request
                .port
                .prepare_tool(
                    turn,
                    "run-one",
                    "workspace_run_r",
                    json!({"code":self.code}),
                )
                .await?;
            let original = ticket.tool.receipt.client_request_id.clone();
            let result = request.port.execute_tool(ticket).await?;
            self.results.lock().unwrap().push(result.clone());
            if self.repeat {
                let again = request
                    .port
                    .prepare_tool(
                        turn,
                        "run-new-call-id",
                        "workspace_run_r",
                        json!({"code":self.code}),
                    )
                    .await?;
                assert!(again.repeated);
                assert_eq!(again.tool.receipt.client_request_id, original);
                assert_eq!(request.port.execute_tool(again).await?, result);
            }
            Ok::<_, ApplicationError>(())
        };
        let result = tokio::select! {biased;_=cancellation.cancelled()=>return ComponentEngineOutcome::Stopped,result=work=>result};
        match result {
            Ok(()) => ComponentEngineOutcome::Completed,
            Err(error) => ComponentEngineOutcome::Failed(error.to_string()),
        }
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    host: Arc<NextHost>,
    service: Arc<ComponentAgentService>,
    context: CallContext,
    project: String,
    window: ApplicationWindowRef,
    bridge: ApplicationBridgeSession,
    application_context: ApplicationContextState,
    session: ComponentAgentSession,
    results: Arc<Mutex<Vec<Value>>>,
}
impl Fixture {
    async fn new(code: &str, repeat: bool) -> Self {
        Self::with_documents(code, repeat, false, false).await
    }
    async fn with_documents(code: &str, repeat: bool, documents: bool, real_model: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let project = root.to_string_lossy().into_owned();
        let host = Arc::new(
            NextHost::open_ark(
                root.join("journal.sqlite"),
                ArkConfig {
                    executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK")),
                    r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME")),
                    project_root: root.clone(),
                    data_root: root.join("runtime"),
                    execution_timeout: Duration::from_secs(60),
                    library_path: None,
                    checkpoint_helper_path: None,
                },
            )
            .await
            .unwrap(),
        );
        let mut context = NextHost::local_context();
        context.connection_id = "studio:mutation-test".into();
        let setup = host
            .invoke(&context, invoke("setup", "counter <- 0L; invisible(NULL)"))
            .await
            .unwrap();
        assert_eq!(setup.status, OperationStatus::Succeeded);
        let output: RunROutput = serde_json::from_value(setup.output.unwrap()).unwrap();
        let session = ComponentAgentSession {
            workspace_instance_id: "main".into(),
            session_id: output.session_id,
        };
        let ApplicationBridgeReply::Registered(registration) = serde_json::from_value(
            host.dispatch(
                &context,
                HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                    window_id: "mutation-window".into(),
                    incarnation: "mutation-life".into(),
                    label: "Mutation test".into(),
                    previous_session: None,
                }),
            )
            .await
            .unwrap(),
        )
        .unwrap() else {
            panic!()
        };
        let results = Arc::new(Mutex::new(Vec::new()));
        let service = ComponentAgentService::with_engine(
            Arc::new(ApplicationStore::open(&root.join("components.sqlite")).unwrap()),
            if real_model {
                Arc::new(rho_agents::RigComponentEngine::default()) as Arc<dyn ComponentAgentEngine>
            } else if documents {
                Arc::new(DocumentEngine) as Arc<dyn ComponentAgentEngine>
            } else {
                Arc::new(RunEngine {
                    code: code.into(),
                    repeat,
                    results: results.clone(),
                })
            },
        );
        let application_context = registration.context;
        let bridge = registration.session;
        let window = bridge.window.clone();
        let credential = service
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
                    connection: Some(if real_model {
                        ComponentModelConnection {
                            protocol: match std::env::var("RHO_COMPONENT_MODEL_PROTOCOL").as_deref()
                            {
                                Ok("anthropic") => ComponentModelProtocol::Anthropic,
                                _ => ComponentModelProtocol::OpenaiCompletions,
                            },
                            base_url: std::env::var("RHO_COMPONENT_MODEL_BASE_URL")
                                .expect("Explicit model URL"),
                            model: std::env::var("RHO_COMPONENT_MODEL_ID")
                                .expect("Explicit model ID"),
                            credential: ComponentCredentialRef::Environment {
                                name: std::env::var("RHO_COMPONENT_MODEL_KEY_ENV")
                                    .expect("Explicit credential environment reference"),
                            },
                        }
                    } else {
                        ComponentModelConnection {
                            protocol: ComponentModelProtocol::Anthropic,
                            base_url: "https://unused.example".into(),
                            model: "fixture-engine".into(),
                            credential,
                        }
                    }),
                },
            )
            .await
            .unwrap();
        Self {
            _temp: temp,
            host,
            service,
            context,
            project,
            window,
            bridge,
            application_context,
            session,
            results,
        }
    }
    async fn start(&self) -> ComponentAgentRun {
        let conversation = self
            .service
            .create(
                &self.host,
                &self.context,
                &self.project,
                &self.window,
                "run-test",
                ComponentAgentProfile::Workspace,
            )
            .unwrap();
        self.service
            .start(
                self.host.clone(),
                self.context.clone(),
                &self.project,
                ComponentAgentStart {
                    request_id: "run-request".into(),
                    conversation_id: conversation.conversation_id,
                    conversation_version: conversation.version,
                    window: self.window.clone(),
                    model_settings_version: 1,
                    text: "Run the authorized test".into(),
                    grant: ComponentAgentGrant {
                        mode: ComponentAgentMode::Run,
                        session: Some(self.session.clone()),
                        documents: vec![],
                        files: vec![],
                    },
                    sources: vec![],
                },
            )
            .await
            .unwrap()
    }
    async fn terminal(&self, id: &str) -> ComponentAgentRun {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let run = self
                    .service
                    .run(&self.host, &self.context, &self.project, id)
                    .unwrap();
                if run.state.is_terminal() {
                    return run;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
    }
}
fn invoke(id: &str, code: &str) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"workspace_instance_id":"main","code":code}),
        preconditions: vec![],
    }
}

#[tokio::test]
#[ignore = "requires real Ark/R; explicit component mutation acceptance"]
async fn authorized_r_is_committed_once_and_returns_the_original_operation() {
    let f = Fixture::new("counter <- counter + 1L; invisible(counter)", true).await;
    let run = f.start().await;
    let done = f.terminal(&run.run_id).await;
    assert_eq!(
        done.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        done.reason
    );
    let tools = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].phase, ComponentToolPhase::Resolved);
    let operation = f
        .host
        .get_operation(&f.context, tools[0].operation_id.as_ref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(operation.status, OperationStatus::Succeeded);
    assert_eq!(operation.operation.caller.kind, CallerKind::Agent);
    assert_eq!(
        f.results.lock().unwrap()[0],
        serde_json::to_value(operation).unwrap()
    );
    let proof = f
        .host
        .invoke(
            &f.context,
            invoke("verify-once", "stopifnot(counter == 1L); invisible(NULL)"),
        )
        .await
        .unwrap();
    assert_eq!(proof.status, OperationStatus::Succeeded);
    f.service.close().await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; explicit component mutation acceptance"]
async fn stop_tracks_and_cancels_the_original_r_operation() {
    let f = Fixture::new(
        "counter <- counter + 1L; Sys.sleep(30); counter <- 99L",
        false,
    )
    .await;
    let run = f.start().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let tools = f
                .service
                .tools(&f.host, &f.context, &f.project, &run.run_id)
                .unwrap();
            if tools.first().is_some_and(|t| t.operation_id.is_some()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    f.service
        .stop(&f.host, &f.context, &f.project, &f.window, &run.run_id)
        .await
        .unwrap();
    assert_eq!(
        f.terminal(&run.run_id).await.state,
        ComponentAgentRunState::Stopped
    );
    let tools = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    let record = f
        .host
        .get_operation(&f.context, tools[0].operation_id.as_ref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.status, OperationStatus::Cancelled, "{record:?}");
    assert_eq!(tools[0].phase, ComponentToolPhase::Resolved);
    f.service.close().await;
}

struct DocumentEngine;
#[async_trait]
impl ComponentAgentEngine for DocumentEngine {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let result = async {
            let turn = request.port.begin_model_call().await?;
            let edit = json!({"document_id":"analysis","edits":[{"from":0,"to":0,"insert":"counter <- counter + 1L\n"}]});
            let ticket = request.port.prepare_tool(turn,"edit","application_edit_document",edit.clone()).await?;
            let original = ticket.tool.receipt.client_request_id.clone();
            let result = request.port.execute_tool(ticket).await?;
            assert_eq!(result["state"],"applied");
            let repeated = request.port.prepare_tool(turn,"edit-again","application_edit_document",edit).await?;
            assert!(repeated.repeated);
            assert_eq!(repeated.tool.receipt.client_request_id,original);
            assert_eq!(request.port.execute_tool(repeated).await?,result);
            for (id,name) in [("save","application_save_document"),("run","application_run_file")] {
                let ticket = request.port.prepare_tool(turn,id,name,json!({"document_id":"analysis"})).await?;
                let result = request.port.execute_tool(ticket).await?;
                assert_eq!(result["state"],"applied","{result}");
                assert_eq!(result["save_synchronized"],true);
            }
            Ok::<_, ApplicationError>(())
        }.await;
        match result {
            Ok(()) => ComponentEngineOutcome::Completed,
            Err(e) => ComponentEngineOutcome::Failed(e.to_string()),
        }
    }
}
fn doc_ref(d: &ApplicationDocument) -> ApplicationDocumentRef {
    ApplicationDocumentRef {
        document_id: d.document_id.clone(),
        document_version: d.version.clone(),
        selection_version: d.selection.version.clone(),
    }
}
async fn bridge(f: &Fixture, request: ApplicationBridgeRequest) -> ApplicationBridgeReply {
    serde_json::from_value(
        f.host
            .dispatch(&f.context, HostRequest::ApplicationBridge(request))
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn sync_document(f: &Fixture, old: &ApplicationDocument, new: &ApplicationDocument) {
    bridge(
        f,
        ApplicationBridgeRequest::Sync {
            session: f.bridge.clone(),
            sync_id: uuid::Uuid::new_v4().to_string(),
            changes: ApplicationChanges {
                documents: vec![ApplicationDocumentUpdate {
                    expected_version: Some(old.version.clone()),
                    expected_selection_version: Some(old.selection.version.clone()),
                    document: new.clone(),
                }],
                ..Default::default()
            },
        },
    )
    .await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; captured component document acceptance"]
async fn captured_document_edit_save_and_run_follow_confirmed_versions() {
    documents_acceptance(false).await;
}

#[tokio::test]
#[ignore = "requires explicitly configured real model and Ark/R"]
async fn real_model_captured_document_edit_save_and_run() {
    documents_acceptance(true).await;
}

async fn documents_acceptance(real_model: bool) {
    let f = Fixture::with_documents("", false, true, real_model).await;
    let text = "invisible(counter)\n";
    std::fs::write(f._temp.path().join("analysis.R"), text).unwrap();
    let mut document = ApplicationDocument {
        document_id: "analysis".into(),
        version: "initial".into(),
        path: Some("analysis.R".into()),
        text: text.into(),
        base_text: Some(text.into()),
        base_hash: Some(rho_application::sha256(text)),
        selection: ApplicationSelection {
            anchor: 0,
            head: 0,
            version: "selection".into(),
        },
        readonly_reason: None,
    };
    let mut context = f.application_context.clone();
    let previous = context.version.clone();
    context.version = "document-context".into();
    context.workspace_instance_id = Some("main".into());
    context.native_session_id = Some(f.session.session_id.clone());
    context.active_document_id = Some("analysis".into());
    bridge(
        &f,
        ApplicationBridgeRequest::Sync {
            session: f.bridge.clone(),
            sync_id: "initial-sync".into(),
            changes: ApplicationChanges {
                context: Some(ApplicationContextUpdate {
                    expected_version: previous,
                    context,
                }),
                documents: vec![ApplicationDocumentUpdate {
                    expected_version: None,
                    expected_selection_version: None,
                    document: document.clone(),
                }],
                removed_documents: vec![],
            },
        },
    )
    .await;
    let conversation = f
        .service
        .create(
            &f.host,
            &f.context,
            &f.project,
            &f.window,
            "documents",
            ComponentAgentProfile::Documents,
        )
        .unwrap();
    let run = f
        .service
        .start(
            f.host.clone(),
            f.context.clone(),
            &f.project,
            ComponentAgentStart {
                request_id: "document-request".into(),
                conversation_id: conversation.conversation_id,
                conversation_version: conversation.version,
                window: f.window.clone(),
                model_settings_version: 1,
                text: "Use the authorized document analysis (analysis.R) whose initial text is exactly invisible(counter) followed by a newline. First prepend counter <- counter + 1L followed by a newline using application_edit_document, then call application_save_document, then application_run_file. Execute exactly once. Wait for each native receipt and report whether it succeeded. Do not create another document or use direct R.".into(),
                grant: ComponentAgentGrant {
                    mode: ComponentAgentMode::Run,
                    session: Some(f.session.clone()),
                    documents: vec![ComponentDocumentGrant {
                        document: doc_ref(&document),
                        path: document.path.clone(),
                        allow_save: true,
                    }],
                    files: vec![],
                },
                sources: vec![],
            },
        )
        .await
        .unwrap();
    let mut edits = 0;
    let started = std::time::Instant::now();
    let mut renewed = std::time::Instant::now();
    tokio::time::timeout(
        Duration::from_secs(if real_model { 125 } else { 45 }),
        async {
            loop {
                if renewed.elapsed() >= Duration::from_secs(3) {
                    bridge(
                        &f,
                        ApplicationBridgeRequest::Renew {
                            session: f.bridge.clone(),
                        },
                    )
                    .await;
                    renewed = std::time::Instant::now();
                }
                let state = f
                    .service
                    .run(&f.host, &f.context, &f.project, &run.run_id)
                    .unwrap();
                if state.state.is_terminal() {
                    assert_eq!(
                        state.state,
                        ComponentAgentRunState::Completed,
                        "{:?}",
                        state.reason
                    );
                    break;
                }
                let claimed = bridge(
                    &f,
                    ApplicationBridgeRequest::Claim {
                        session: f.bridge.clone(),
                        claim_request_id: uuid::Uuid::new_v4().to_string(),
                    },
                )
                .await;
                let ApplicationBridgeReply::Claimed(Some(grant)) = claimed else {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    continue;
                };
                let mut changes = ApplicationChanges::default();
                if let ApplicationAction::EditDocument {
                    document: reference,
                    edits: changeset,
                } = &grant.request.action
                {
                    assert_eq!(*reference, doc_ref(&document));
                    let before = document.clone();
                    for edit in changeset.iter().rev() {
                        document
                            .text
                            .replace_range(edit.from as usize..edit.to as usize, &edit.insert);
                    }
                    document.version = uuid::Uuid::new_v4().to_string();
                    changes.documents.push(ApplicationDocumentUpdate {
                        expected_version: Some(before.version),
                        expected_selection_version: Some(before.selection.version),
                        document: document.clone(),
                    });
                    edits += 1;
                }
                bridge(
                    &f,
                    ApplicationBridgeRequest::Complete {
                        session: f.bridge.clone(),
                        completion: ApplicationCommandCompletion {
                            request_id: grant.request.request_id.clone(),
                            claim_id: grant.claim_id,
                            outcome: ApplicationLocalOutcome::Applied,
                            changes,
                            diagnostic: None,
                        },
                    },
                )
                .await;
                if let Some(execution_ref) = grant.execution_ref {
                    for step in [
                        ApplicationExecutionStep::Save,
                        ApplicationExecutionStep::Run,
                    ] {
                        if step == ApplicationExecutionStep::Run
                            && matches!(grant.request.action, ApplicationAction::Save { .. })
                        {
                            break;
                        }
                        let result: ApplicationExecuteReply = serde_json::from_value(
                            f.host
                                .dispatch(
                                    &f.context,
                                    HostRequest::ApplicationExecute(ApplicationExecuteRequest {
                                        session: f.bridge.clone(),
                                        request_id: grant.request.request_id.clone(),
                                        execution_ref: execution_ref.clone(),
                                        step,
                                    }),
                                )
                                .await
                                .unwrap(),
                        )
                        .unwrap();
                        let step_receipt = if step == ApplicationExecutionStep::Save {
                            result.receipt.save.as_ref()
                        } else {
                            result.receipt.run.as_ref()
                        }
                        .unwrap();
                        assert_eq!(
                            step_receipt.state,
                            ApplicationStepState::Succeeded,
                            "{:?}",
                            result.receipt
                        );
                        if step == ApplicationExecutionStep::Save {
                            let before = document.clone();
                            let capture = result.receipt.capture.unwrap();
                            document.base_text = Some(document.text.clone());
                            document.base_hash = Some(capture.sha256);
                            document.version = uuid::Uuid::new_v4().to_string();
                            sync_document(&f, &before, &document).await;
                            bridge(
                                &f,
                                ApplicationBridgeRequest::ConfirmSaved {
                                    session: f.bridge.clone(),
                                    request_id: grant.request.request_id.clone(),
                                    execution_ref: execution_ref.clone(),
                                    document: doc_ref(&document),
                                },
                            )
                            .await;
                        }
                    }
                }
            }
        },
    )
    .await
    .unwrap();
    assert_eq!(edits, 1);
    assert_eq!(
        std::fs::read_to_string(f._temp.path().join("analysis.R")).unwrap(),
        document.text
    );
    let proof = f
        .host
        .invoke(
            &f.context,
            invoke(
                "verify-doc-run",
                "stopifnot(counter == 1L); invisible(NULL)",
            ),
        )
        .await
        .unwrap();
    assert_eq!(proof.status, OperationStatus::Succeeded);
    let tools = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    let mutations: Vec<_> = tools.iter().filter(|t| t.mutation).collect();
    assert_eq!(mutations.len(), 3);
    assert!(
        mutations
            .iter()
            .all(|t| t.phase == ComponentToolPhase::Resolved && t.application_request_id.is_some())
    );
    println!(
        "document acceptance: real_model={real_model}, edits={edits}, mutations={}, elapsed_ms={}",
        mutations.len(),
        started.elapsed().as_millis()
    );
    f.service.close().await;
}
