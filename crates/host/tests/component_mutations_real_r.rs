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
        Self::with_documents(code, repeat, false, false, false).await
    }
    async fn with_documents(
        code: &str,
        repeat: bool,
        documents: bool,
        real_model: bool,
        repair: bool,
    ) -> Self {
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
        let policy = host.invoke(&context, Invocation {
            client_request_id: "fixture-manual-recovery".into(),
            capability: CapabilityRef::new("runtime.update_settings", 1).unwrap(),
            arguments: json!({"scope":"project","workspace_instance_id":null,"expected_version":null,"overrides":{"mode":"manual"}}),
            preconditions: vec![],
        }).await.unwrap();
        assert_eq!(policy.status, OperationStatus::Succeeded);

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
                Arc::new(DocumentEngine { repair }) as Arc<dyn ComponentAgentEngine>
            } else {
                Arc::new(RunEngine {
                    code: code.into(),
                    repeat,
                    results: results.clone(),
                })
            },
        );
        let mut application_context = registration.context;
        let bridge = registration.session;
        let window = bridge.window.clone();
        let expected = application_context.version.clone();
        application_context.version = uuid::Uuid::new_v4().to_string();
        application_context.workspace_instance_id = Some(session.workspace_instance_id.clone());
        application_context.native_session_id = Some(session.session_id.clone());
        host.dispatch(
            &context,
            HostRequest::ApplicationBridge(ApplicationBridgeRequest::Sync {
                session: bridge.clone(),
                sync_id: uuid::Uuid::new_v4().to_string(),
                changes: ApplicationChanges {
                    context: Some(ApplicationContextUpdate {
                        expected_version: expected,
                        context: application_context.clone(),
                    }),
                    ..Default::default()
                },
            }),
        )
        .await
        .unwrap();
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
                    continuation: None,
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
    assert!(
        f.service
            .reconcile(&f.host, &f.context, &f.project, &f.window, &run.run_id)
            .await
            .is_err()
    );

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

struct DocumentEngine {
    repair: bool,
}
const REPAIR_LINE: &str = "stop(\"component repair fixture\")\n";
#[async_trait]
impl ComponentAgentEngine for DocumentEngine {
    async fn test_model(
        &self,
        _: ComponentModelConnection,
        _: ComponentModelKey,
        _: ComponentModelTestKind,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let result = async {
            let turn = request.port.begin_model_call().await?;
            if request.run.profile==ComponentAgentProfile::Plots {
                if request.images.len()!=1 || !request.images[0].base64.starts_with("iVBOR") || request.context.contains(&request.images[0].base64) {
                    return Err(ApplicationError::InvalidInput("Verified plot bytes were not supplied separately".into()));
                }
                request.port.append_text("Verified selected image".into()).await?;
                return Ok(());
            }
            let interrupted_repair = request.run.request.text == "fixture-continue-repair";
            if request.run.request.continuation.is_some() && !interrupted_repair {
                let history=request.run.context.as_ref().unwrap().history.as_ref().unwrap();
                let resume=history["tools"].as_array().unwrap().iter().find(|t|t["capability"]=="workspace.resume_queue").unwrap();
                let pause=resume["result"]["operation"]["normalized_arguments"]["pause_id"].clone();
                let ticket=request.port.prepare_tool(turn,"prior-resume","workspace_resume_queue",json!({"pause_id":pause})).await?;
                let result=request.port.execute_tool(ticket).await?;
                if result["executed_again"]!=false || result["result"]["status"]!="succeeded" {return Err(ApplicationError::InvalidInput(format!("Prior resume was not reused: {result}")));}
                return Ok(());
            }
            if interrupted_repair {
                let previous=request.port.prepare_tool(turn,"repeat-parent-failure","application_run_file",json!({"document_id":"analysis"})).await?;
                assert!(!previous.tool.receipt.mutation);
                let result=request.port.execute_tool(previous).await?;
                assert_eq!(result["executed_again"],false);
                assert_eq!(result["result"]["state"],"failed");
            } else if self.repair {
                let first=request.port.prepare_tool(turn,"first-run","application_run_file",json!({"document_id":"analysis"})).await?;
                let original=first.tool.receipt.client_request_id.clone();
                let failed=request.port.execute_tool(first).await?;
                if failed["state"]!="failed" || failed["run"]["state"]!="failed" || failed["save_synchronized"]!=true {
                    return Err(ApplicationError::InvalidInput(format!("Expected a saved native failure: {failed}")));
                }
                let duplicate=request.port.prepare_tool(turn,"repeat-failed-run","application_run_file",json!({"document_id":"analysis"})).await?;
                if !duplicate.repeated || duplicate.tool.receipt.client_request_id!=original {
                    return Err(ApplicationError::InvalidInput("Repeated failed capture was admitted as new scientific work".into()));
                }
                if request.port.execute_tool(duplicate).await? != failed {
                    return Err(ApplicationError::InvalidInput("Repeated failure lost its original receipt".into()));
                }
            }
            if request.run.request.text == "fixture-model-interruption" {
                return Err(ApplicationError::InvalidInput("Injected model failure after confirmed R failure".into()));
            }
            let (edit_name,edit) = if self.repair { ("application_replace_text",json!({"document_id":"analysis","old_text":REPAIR_LINE.trim_end(),"new_text":""})) } else { ("application_edit_document",json!({"document_id":"analysis","edits":[{"from":0,"to":0,"insert":"counter <- counter + 1L\n"}]})) };
            let ticket = request.port.prepare_tool(turn,"edit",edit_name,edit.clone()).await?;
            let original = ticket.tool.receipt.client_request_id.clone();
            let result = request.port.execute_tool(ticket).await?;
            assert_eq!(result["state"],"applied");
            let repeated = request.port.prepare_tool(turn,"edit-again",edit_name,edit).await?;
            assert!(repeated.repeated);
            assert_eq!(repeated.tool.receipt.client_request_id,original);
            assert_eq!(request.port.execute_tool(repeated).await?,result);
            if self.repair {
                let blocked=request.port.prepare_tool(turn,"run-before-resume","application_run_file",json!({"document_id":"analysis"})).await?;
                assert!(!blocked.tool.receipt.mutation);
                assert!(blocked.tool.receipt.operation_id.is_none());
                assert!(blocked.tool.receipt.application_request_id.is_none());
                assert_eq!(request.port.execute_tool(blocked).await?["accepted"],false);
                let query=request.port.prepare_tool(turn,"queue","workspace_console_state",json!({})).await?;
                let queue=request.port.execute_tool(query).await?;
                let args=json!({"pause_id":queue["data"]["pause"]["id"]});
                let resume=request.port.prepare_tool(turn,"resume","workspace_resume_queue",args.clone()).await?;
                let original=resume.tool.receipt.client_request_id.clone();
                let resumed=request.port.execute_tool(resume).await?;
                if resumed["status"]!="succeeded" {return Err(ApplicationError::InvalidInput(format!("Resume failed: {resumed}")));}
                let duplicate=request.port.prepare_tool(turn,"resume-again","workspace_resume_queue",args).await?;
                if !duplicate.repeated || duplicate.tool.receipt.client_request_id!=original {return Err(ApplicationError::InvalidInput("Resume did not preserve its original identity".into()));}
                if request.port.execute_tool(duplicate).await?!=resumed {return Err(ApplicationError::InvalidInput("Resume receipt changed".into()));}
            }
            let steps = if self.repair { vec![("run","application_run_file")] } else { vec![("save","application_save_document"),("run","application_run_file")] };
            for (id,name) in steps {
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
    documents_acceptance(false, false, false, false, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires explicitly configured real model and Ark/R"]
async fn real_model_captured_document_edit_save_and_run() {
    documents_acceptance(true, false, false, false, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; failed captured execution and repair"]
async fn captured_document_failure_is_not_replayed_and_repair_uses_its_saved_version() {
    documents_acceptance(false, true, false, false, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires explicitly configured real model and Ark/R"]
async fn real_model_captured_document_failure_and_repair() {
    documents_acceptance(true, true, false, false, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires explicitly configured real model and Ark/R"]
async fn real_model_continues_original_document_result() {
    documents_acceptance(true, false, true, false, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; repaired analysis produces owner-verified media"]
async fn repaired_document_plot_is_verified_without_additional_science() {
    documents_acceptance(false, true, false, true, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires explicitly configured real model and Ark/R"]
async fn real_model_repairs_document_and_reads_its_produced_plot() {
    documents_acceptance(true, true, false, true, ComponentAgentProfile::Documents).await;
}

#[tokio::test]
#[ignore = "requires explicitly configured real model and Ark/R"]
async fn real_model_project_document_edit_save_and_run() {
    documents_acceptance(true, false, false, false, ComponentAgentProfile::Project).await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; Project profile uses authorized document execution"]
async fn project_profile_document_edit_save_and_run() {
    documents_acceptance(false, false, false, false, ComponentAgentProfile::Project).await;
}

async fn documents_acceptance(
    real_model: bool,
    repair: bool,
    continue_model: bool,
    produced_plot: bool,
    profile: ComponentAgentProfile,
) {
    documents_acceptance_with_interruption(real_model, repair, continue_model, produced_plot, profile, false).await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; explicit Continue after an injected model failure"]
async fn interrupted_document_repair_continues_without_replaying_the_failed_capture() {
    documents_acceptance_with_interruption(false, true, false, false, ComponentAgentProfile::Documents, true).await;
}

async fn documents_acceptance_with_interruption(
    real_model: bool, repair: bool, continue_model: bool, produced_plot: bool,
    profile: ComponentAgentProfile, interrupt_model: bool,
) {
    assert!(!interrupt_model || (!real_model && repair));
    let f = Fixture::with_documents("", false, true, real_model, repair).await;
    let (color, hex) = [
        ("red", "#D62424"),
        ("green", "#229C46"),
        ("blue", "#265ED8"),
    ][(uuid::Uuid::new_v4().as_bytes()[0] % 3) as usize];
    let tail = if produced_plot {
        format!(
            "counter <- counter + 1L\npar(mar=c(0,0,0,0)); plot.new(); rect(-1,-1,2,2,col='{hex}',border=NA)\ninvisible(counter)\n"
        )
    } else {
        "counter <- counter + 1L\ninvisible(counter)\n".into()
    };
    let initial = if repair {
        format!("{REPAIR_LINE}{tail}")
    } else {
        "invisible(counter)\n".into()
    };
    let text = initial.as_str();
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
    let preview=f.service.preview_source(&f.host,&f.context,ComponentSourcePreviewRequest{
        project_root:f.project.clone(),window:f.window.clone(),session:Some(f.session.clone()),
        selection:AgentContextSelection{source:"editor".into(),label:"analysis.R".into(),inclusion:"text".into(),
            reference:json!({"window":f.window,"document":doc_ref(&document),"expected_sha256":rho_application::sha256(&document.text),"selection":document.selection})}
    }).await.unwrap();
    assert!(preview.error.is_none(), "{:?}", preview.error);
    let sources = vec![preview.snapshot.unwrap().selection];
    let conversation = f
        .service
        .create(
            &f.host,
            &f.context,
            &f.project,
            &f.window,
            "documents",
            profile,
        )
        .unwrap();
    let mut run = f
        .service
        .start(
            f.host.clone(),
            f.context.clone(),
            &f.project,
            ComponentAgentStart { continuation: None,
                request_id: "document-request".into(),
                conversation_id: conversation.conversation_id,
                conversation_version: conversation.version,
                window: f.window.clone(),
                model_settings_version: 1,
                text: if interrupt_model { "fixture-model-interruption".into() } else if repair { "First run the authorized document analysis (analysis.R) using application_run_file to observe its failure. Then inspect its original native failure and current draft, repair only the failing first line, and use application_run_file again to save and run the corrected script. Keep the counter increment and other code unchanged. The counter must increment exactly once across the entire workflow. Do not repeat the failed execution and do not create another document or use direct R.".into() } else { "Use the authorized document analysis (analysis.R) whose initial text is exactly invisible(counter) followed by a newline. First prepend counter <- counter + 1L followed by a newline using application_edit_document, then call application_save_document, then application_run_file. Execute exactly once. Wait for each native receipt and report whether it succeeded. Do not create another document or use direct R.".into() },
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
                sources,
            },
        )
        .await
        .unwrap();
    let mut parents = Vec::new();
    let mut edits = 0;
    let mut native_runs = 0;
    let mut failures = 0;
    let started = std::time::Instant::now();
    let mut renewed = std::time::Instant::now();
    let completed = tokio::time::timeout(
        if real_model { Duration::from_millis(run.budget.duration_ms.saturating_add(15_000)) } else { Duration::from_secs(20) },
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
                    if interrupt_model && parents.is_empty() {
                        assert_eq!(state.state, ComponentAgentRunState::Failed);
                        assert!(state.reason.as_deref().unwrap().contains("Injected model failure"));
                        assert_eq!((edits, native_runs, failures), (0, 1, 1));
                        let reconciled = f.service.reconcile(&f.host, &f.context, &f.project, &f.window, &run.run_id).await.unwrap();
                        let recovery = reconciled.recovery.unwrap();
                        assert_eq!(recovery.unresolved_mutations, 0);
                        let mut next = run.request.clone();
                        next.request_id = "continue-interrupted-repair".into();
                        next.text = "fixture-continue-repair".into();
                        next.conversation_version = f.service.conversation(&f.host, &f.context, &f.project, &next.conversation_id).unwrap().version;
                        next.grant.documents[0].document = doc_ref(&document);
                        next.sources = vec![];
                        next.continuation = Some(ComponentContinuation { run_id: run.run_id.clone(), recovery_digest: recovery.digest });
                        parents.push(run.run_id.clone());
                        run = f.service.start(f.host.clone(), f.context.clone(), &f.project, next).await.unwrap();
                        continue;
                    }
                    if state.state != ComponentAgentRunState::Completed {
                        let scope = ApplicationScope {
                            project: f.project.clone(),
                            principal: serde_json::to_string(f.context.principal()).unwrap(),
                        };
                        let store =
                            ApplicationStore::open(&f._temp.path().join("components.sqlite"))
                                .unwrap();
                        for tool in store.component_tools(&scope, &run.run_id).unwrap() {
                            eprintln!(
                                "Synthetic probe tool {:?}: {:?}",
                                tool.action, tool.receipt.result
                            );
                        }
                    }
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
                eprintln!(
                    "Bridge applying {}",
                    serde_json::to_value(&grant.request.action).unwrap()["kind"]
                );
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
                        eprintln!("Native step {step:?}: {:?}", result.receipt.state);
                        let step_receipt = if step == ApplicationExecutionStep::Save {
                            result.receipt.save.as_ref()
                        } else {
                            result.receipt.run.as_ref()
                        }
                        .unwrap();
                        let expected = if repair
                            && step == ApplicationExecutionStep::Run
                            && native_runs == 0
                        {
                            failures += 1;
                            ApplicationStepState::Failed
                        } else {
                            ApplicationStepState::Succeeded
                        };
                        assert_eq!(step_receipt.state, expected, "{:?}", result.receipt);
                        if step == ApplicationExecutionStep::Run {
                            native_runs += 1;
                        }
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
    .await;
    if completed.is_err() {
        let run = f
            .service
            .run(&f.host, &f.context, &f.project, &run.run_id)
            .unwrap();
        let tools = f
            .service
            .tools(&f.host, &f.context, &f.project, &run.run_id)
            .unwrap();
        eprintln!(
            "Timed out component run: {}",
            serde_json::to_string(&run).unwrap()
        );
        for tool in tools {
            eprintln!("Tool: {}", serde_json::to_string(&tool).unwrap());
            if let Some(id) = tool.application_request_id {
                let state = f
                    .host
                    .query_snapshot(
                        &f.context,
                        QueryRequest {
                            capability: CapabilityRef::new("application.command_status", 1)
                                .unwrap(),
                            arguments: json!({"window":f.window,"request_id":id}),
                        },
                    )
                    .await;
                eprintln!("Application: {state:?}");
            }
        }
        bridge(
            &f,
            ApplicationBridgeRequest::Renew {
                session: f.bridge.clone(),
            },
        )
        .await;
        f.service
            .stop(&f.host, &f.context, &f.project, &f.window, &run.run_id)
            .await
            .unwrap();
        f.service.close().await;
        panic!("Document execution timed out; original receipts printed above");
    }
    assert_eq!(edits, 1);
    assert_eq!(native_runs, if repair { 2 } else { 1 });
    assert_eq!(failures, usize::from(repair));
    if repair {
        assert!(document.text.ends_with(&tail));
    }
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
    let mut tools = Vec::new();
    for id in parents.iter().chain(std::iter::once(&run.run_id)) {
        tools.extend(f.service.tools(&f.host, &f.context, &f.project, id).unwrap());
    }
    assert_eq!(parents.len(), usize::from(interrupt_model));
    let mutations: Vec<_> = tools.iter().filter(|t| t.mutation).collect();
    assert_eq!(mutations.len(), if repair { 4 } else { 3 });
    assert!(
        mutations
            .iter()
            .all(|t| t.phase == ComponentToolPhase::Resolved
                && (t.application_request_id.is_some() || t.operation_id.is_some()))
    );
    let mut native_ids = std::collections::BTreeSet::new();
    let mut failed_records = 0;
    for tool in mutations.iter() {
        if tool.capability == "workspace.resume_queue" {
            let record: OperationRecord =
                serde_json::from_value(tool.result.clone().unwrap()).unwrap();
            assert_eq!(record.status, OperationStatus::Succeeded);
            continue;
        }
        let receipt: ApplicationCommandReceipt =
            serde_json::from_value(tool.result.clone().unwrap()).unwrap();
        if let Some(step) = receipt.run {
            let id = step.operation_id.unwrap();
            assert!(native_ids.insert(id.clone()));
            let native = f
                .host
                .get_operation(&f.context, &id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(native.operation.caller.kind, CallerKind::Agent);
            if step.state == ApplicationStepState::Failed {
                assert_eq!(native.status, OperationStatus::Failed);
                assert!(native.error.is_some());
                failed_records += 1;
            } else {
                assert_eq!(native.status, OperationStatus::Succeeded);
            }
        }
    }
    assert_eq!(failed_records, usize::from(repair));
    assert_eq!(native_ids.len(), native_runs);
    let finished = f
        .service
        .run(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    println!(
        "model_calls={}, tool_calls={}, model_limit={}",
        finished.model_calls, finished.tool_calls, finished.budget.model_calls
    );
    println!(
        "document acceptance: real_model={real_model}, repair={repair}, edits={edits}, native_runs={native_runs}, failures={failures}, mutations={}, elapsed_ms={}",
        mutations.len(),
        started.elapsed().as_millis()
    );
    if produced_plot {
        inspect_produced_plot(&f, &run.run_id, color, hex, real_model).await;
    }
    if continue_model {
        let parent = f
            .service
            .reconcile(&f.host, &f.context, &f.project, &f.window, &run.run_id)
            .await
            .unwrap();
        let mut request = run.request.clone();
        request.request_id = "real-model-continue".into();
        request.text="Continue with a concise confirmation of the prior saved and executed result. Cite the original R execution operation ID from the prior receipts. Do not edit the document or execute any code again.".into();
        request.conversation_version = f
            .service
            .conversation(&f.host, &f.context, &f.project, &request.conversation_id)
            .unwrap()
            .version;
        request.grant.documents[0].document = doc_ref(&document);
        request.sources = vec![];
        request.continuation = Some(ComponentContinuation {
            run_id: run.run_id.clone(),
            recovery_digest: parent.recovery.unwrap().digest,
        });
        let child = f
            .service
            .start(f.host.clone(), f.context.clone(), &f.project, request)
            .await
            .unwrap();
        let mut heartbeat = std::time::Instant::now();
        let child = tokio::time::timeout(Duration::from_millis(child.budget.duration_ms.saturating_add(15_000)), async {
            loop {
                if heartbeat.elapsed() >= Duration::from_secs(3) {
                    bridge(
                        &f,
                        ApplicationBridgeRequest::Renew {
                            session: f.bridge.clone(),
                        },
                    )
                    .await;
                    heartbeat = std::time::Instant::now();
                }
                let observed = f
                    .service
                    .run(&f.host, &f.context, &f.project, &child.run_id)
                    .unwrap();
                if observed.state.is_terminal() {
                    break observed;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            child.state,
            ComponentAgentRunState::Completed,
            "{:?}",
            child.reason
        );
        let reused = f
            .service
            .tools(&f.host, &f.context, &f.project, &child.run_id)
            .unwrap();
        assert!(reused.iter().all(|t| !t.mutation));
        let original_operation = mutations
            .iter()
            .find_map(|t| {
                t.result
                    .as_ref()
                    .and_then(|r| r["run"]["operation_id"].as_str())
            })
            .unwrap();
        let events = f
            .service
            .events(&f.host, &f.context, &f.project, &child.run_id, 0, 128)
            .unwrap();
        let answer = events
            .events
            .into_iter()
            .filter_map(|e| match e.content {
                ComponentAgentEventContent::Text { text } => Some(text),
                _ => None,
            })
            .collect::<String>();
        assert!(
            answer.contains(original_operation),
            "Continue did not cite the original R record: {answer}"
        );
        let proof = f
            .host
            .invoke(
                &f.context,
                invoke(
                    "verify-real-continue",
                    "stopifnot(counter == 1L); invisible(NULL)",
                ),
            )
            .await
            .unwrap();
        assert_eq!(proof.status, OperationStatus::Succeeded);
        println!(
            "real continuation: model_calls={}, tool_calls={}, new_mutations=0",
            child.model_calls, child.tool_calls
        );
    }
    if repair && !real_model {
        let parent = f
            .service
            .reconcile(&f.host, &f.context, &f.project, &f.window, &run.run_id)
            .await
            .unwrap();
        let mut request = run.request.clone();
        request.request_id = "continue-resume".into();
        request.text = "Confirm the original resumed queue result without new actions.".into();
        request.conversation_version = f
            .service
            .conversation(&f.host, &f.context, &f.project, &request.conversation_id)
            .unwrap()
            .version;
        request.grant.documents[0].document = doc_ref(&document);
        request.sources = vec![];
        request.continuation = Some(ComponentContinuation {
            run_id: run.run_id.clone(),
            recovery_digest: parent.recovery.unwrap().digest,
        });
        let child = f
            .service
            .start(f.host.clone(), f.context.clone(), &f.project, request)
            .await
            .unwrap();
        let child = f.terminal(&child.run_id).await;
        assert_eq!(
            child.state,
            ComponentAgentRunState::Completed,
            "{:?}",
            child.reason
        );
        assert!(
            f.service
                .tools(&f.host, &f.context, &f.project, &child.run_id)
                .unwrap()
                .iter()
                .all(|t| !t.mutation)
        );
    }
    f.service.close().await;
    let replacement = ComponentAgentService::new(Arc::new(
        ApplicationStore::open(&f._temp.path().join("components.sqlite")).unwrap(),
    ));
    let observed = replacement
        .reconcile(&f.host, &f.context, &f.project, &f.window, &run.run_id)
        .await
        .unwrap();
    assert_eq!(observed.state, ComponentAgentRunState::Completed);
    let recovery = observed.recovery.unwrap();
    assert_eq!(recovery.unresolved_mutations, 0);
    assert!(
        recovery
            .tools
            .iter()
            .all(|t| t.state == ComponentRecoveryState::Confirmed)
    );
    let mut recoveries = vec![recovery];
    for parent in &parents {
        let restored = replacement.reconcile(&f.host, &f.context, &f.project, &f.window, parent).await.unwrap();
        assert_eq!(restored.state, ComponentAgentRunState::Failed);
        let original = restored.recovery.unwrap();
        assert_eq!(original.unresolved_mutations, 0);
        assert!(original.tools.iter().all(|tool| tool.state == ComponentRecoveryState::Confirmed));
        recoveries.push(original);
    }
    let failed_operations = recoveries.iter().flat_map(|report| &report.tools)
        .flat_map(|tool| &tool.operations).filter(|op| op.status == OperationStatus::Failed)
        .map(|op| op.operation_id.clone()).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(failed_operations.len(), usize::from(repair));
    replacement.close().await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; original operation acknowledgement recovery"]
async fn orphan_reconciliation_finds_the_original_r_result_without_reexecuting() {
    let f = Fixture::new("counter <- counter + 1L; invisible(counter)", false).await;
    let started = f.start().await;
    let completed = f.terminal(&started.run_id).await;
    assert_eq!(completed.state, ComponentAgentRunState::Completed);
    f.service.close().await;
    let store =
        Arc::new(ApplicationStore::open(&f._temp.path().join("components.sqlite")).unwrap());
    let scope = ApplicationScope {
        project: f.project.clone(),
        principal: serde_json::to_string(f.context.principal()).unwrap(),
    };
    let mut run = store
        .component_run(&scope, &started.run_id)
        .unwrap()
        .unwrap();
    let mut tools = store.component_tools(&scope, &started.run_id).unwrap();
    let original = tools[0].receipt.operation_id.clone().unwrap();
    // Simulate a crash before acceptance/result/final acknowledgement reached Application.
    tools[0].receipt.phase = ComponentToolPhase::Intent;
    tools[0].receipt.operation_id = None;
    tools[0].receipt.result = None;
    tools[0].receipt.evidence.clear();
    run.run.state = ComponentAgentRunState::Running;
    let mut conversation = store
        .component_conversation(&scope, &run.run.request.conversation_id)
        .unwrap()
        .unwrap();
    let expected = conversation.version;
    conversation.version += 1;
    conversation.active_run_id = Some(started.run_id.clone());
    store
        .commit_component(
            &scope,
            ComponentWrite {
                expected_version: Some(expected),
                conversation: &conversation,
                run: Some(&run),
                tools: &tools,
                events: &[],
            },
        )
        .unwrap();
    let replacement = ComponentAgentService::new(store);
    let recovered = replacement
        .reconcile(&f.host, &f.context, &f.project, &f.window, &started.run_id)
        .await
        .unwrap();
    assert_eq!(recovered.state, ComponentAgentRunState::Interrupted);
    assert_eq!(recovered.model_calls, completed.model_calls);
    let report = recovered.recovery.unwrap();
    assert_eq!(report.unresolved_mutations, 0);
    assert_eq!(report.tools.len(), 1);
    assert_eq!(report.tools[0].state, ComponentRecoveryState::Confirmed);
    assert_eq!(
        report.tools[0].operations,
        vec![ComponentRecoveredOperation {
            operation_id: original.clone(),
            status: OperationStatus::Succeeded
        }]
    );
    assert_eq!(
        replacement
            .reconcile(&f.host, &f.context, &f.project, &f.window, &started.run_id)
            .await
            .unwrap()
            .recovery
            .unwrap(),
        report
    );
    let proof = f
        .host
        .invoke(
            &f.context,
            invoke(
                "verify-recovered-once",
                "stopifnot(counter == 1L); invisible(NULL)",
            ),
        )
        .await
        .unwrap();
    assert_eq!(proof.status, OperationStatus::Succeeded);
    assert_eq!(
        f.host
            .get_operation(&f.context, &original)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Succeeded
    );
    replacement.close().await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; explicit continuation must not replay completed code"]
async fn continue_reuses_prior_r_result_but_a_fresh_request_can_run_again() {
    let f = Fixture::new("counter <- counter + 1L; invisible(counter)", false).await;
    let first = f.start().await;
    let completed = f.terminal(&first.run_id).await;
    assert_eq!(completed.state, ComponentAgentRunState::Completed);
    let store = ApplicationStore::open(&f._temp.path().join("components.sqlite")).unwrap();
    let scope = ApplicationScope {
        project: f.project.clone(),
        principal: serde_json::to_string(f.context.principal()).unwrap(),
    };
    let stored = store.component_run(&scope, &first.run_id).unwrap().unwrap();
    let mut lost = store.component_tools(&scope, &first.run_id).unwrap();
    lost[0].receipt.result = None;
    lost[0].receipt.operation_id = None;
    lost[0].receipt.phase = ComponentToolPhase::Intent;
    let mut saved = store
        .component_conversation(&scope, &first.request.conversation_id)
        .unwrap()
        .unwrap();
    let expected = saved.version;
    saved.version += 1;
    store
        .commit_component(
            &scope,
            ComponentWrite {
                expected_version: Some(expected),
                conversation: &saved,
                run: Some(&stored),
                tools: &lost,
                events: &[],
            },
        )
        .unwrap();
    let reconciled = f
        .service
        .reconcile(&f.host, &f.context, &f.project, &f.window, &first.run_id)
        .await
        .unwrap();
    let conversation = f
        .service
        .conversation(
            &f.host,
            &f.context,
            &f.project,
            &first.request.conversation_id,
        )
        .unwrap();
    let mut request = first.request.clone();
    request.request_id = "explicit-continue".into();
    request.conversation_version = conversation.version;
    request.continuation = Some(ComponentContinuation {
        run_id: first.run_id.clone(),
        recovery_digest: reconciled.recovery.unwrap().digest,
    });
    let second = f
        .service
        .start(
            f.host.clone(),
            f.context.clone(),
            &f.project,
            request.clone(),
        )
        .await
        .unwrap();
    let done = f.terminal(&second.run_id).await;
    assert_eq!(
        done.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        done.reason
    );
    let repeated = f
        .service
        .start(f.host.clone(), f.context.clone(), &f.project, request)
        .await
        .unwrap();
    assert_eq!(repeated.run_id, second.run_id);
    let results = f.results.lock().unwrap().clone();
    assert_eq!(results.len(), 2);
    assert_eq!(results[1]["executed_again"], false);
    assert_eq!(results[1]["result"], results[0]);
    assert!(
        done.context.as_ref().unwrap().history.as_ref().unwrap()["tools"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
    );
    let check = f
        .host
        .invoke(
            &f.context,
            invoke(
                "continued-once",
                "stopifnot(counter == 1L); invisible(NULL)",
            ),
        )
        .await
        .unwrap();
    assert_eq!(check.status, OperationStatus::Succeeded);

    let observed = f
        .service
        .reconcile(&f.host, &f.context, &f.project, &f.window, &second.run_id)
        .await
        .unwrap();
    let mut third = second.request.clone();
    third.request_id = "continue-again".into();
    third.conversation_version = f
        .service
        .conversation(&f.host, &f.context, &f.project, &third.conversation_id)
        .unwrap()
        .version;
    third.continuation = Some(ComponentContinuation {
        run_id: second.run_id.clone(),
        recovery_digest: observed.recovery.unwrap().digest,
    });
    let third = f
        .service
        .start(f.host.clone(), f.context.clone(), &f.project, third)
        .await
        .unwrap();
    let third = f.terminal(&third.run_id).await;
    assert_eq!(
        third.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        third.reason
    );
    assert_eq!(
        f.results.lock().unwrap().last().unwrap()["previous_run_id"],
        first.run_id
    );
    let mut fresh = first.request.clone();
    fresh.request_id = "new-explicit-action".into();
    fresh.continuation = None;
    fresh.conversation_version = f
        .service
        .conversation(&f.host, &f.context, &f.project, &fresh.conversation_id)
        .unwrap()
        .version;
    let next = f
        .service
        .start(f.host.clone(), f.context.clone(), &f.project, fresh)
        .await
        .unwrap();
    assert_eq!(
        f.terminal(&next.run_id).await.state,
        ComponentAgentRunState::Completed
    );
    let check = f
        .host
        .invoke(
            &f.context,
            invoke(
                "fresh-runs-again",
                "stopifnot(counter == 2L); invisible(NULL)",
            ),
        )
        .await
        .unwrap();
    assert_eq!(check.status, OperationStatus::Succeeded);
    f.service.close().await;
}

async fn recent_science(f: &Fixture) -> Value {
    f.host
        .query_snapshot(
            &f.context,
            QueryRequest {
                capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
                arguments: json!({"limit":32}),
            },
        )
        .await
        .unwrap()
        .data
        .unwrap()["operations"]
        .clone()
}
async fn inspect_produced_plot(
    f: &Fixture,
    run_id: &str,
    color: &str,
    hex: &str,
    real_model: bool,
) {
    let tools = f
        .service
        .tools(&f.host, &f.context, &f.project, run_id)
        .unwrap();
    let id = tools
        .iter()
        .find_map(|t| {
            t.result.as_ref().and_then(|r| {
                if r["run"]["state"] == "succeeded" {
                    r["run"]["operation_id"].as_str()
                } else {
                    None
                }
            })
        })
        .unwrap();
    let operation_id = OperationId::new(id).unwrap();
    let record = f
        .host
        .get_operation(&f.context, &operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded);
    let output: RunROutput = serde_json::from_value(record.output.unwrap()).unwrap();
    let media = output
        .output_references
        .into_iter()
        .rev()
        .find(|r| r.mime_type == "image/png")
        .expect("Successful analysis must produce a retained PNG");
    assert_eq!(media.operation_id, operation_id);
    let original = f.host.verified_output(&f.context, &media).await.unwrap();
    assert_eq!(original.len() as u64, media.byte_size);
    assert_eq!(rho_application::sha256(original.as_ref()), media.sha256);
    let before = recent_science(f).await;
    f.service
        .test_model(
            f.host.clone(),
            f.context.clone(),
            ComponentModelTestRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                request_id: "produced-image-test".into(),
                model_settings_version: 1,
                kind: ComponentModelTestKind::Images,
            },
        )
        .await
        .unwrap();
    let mut heartbeat = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(125), async {
        loop {
            if heartbeat.elapsed() >= Duration::from_secs(3) {
                bridge(
                    f,
                    ApplicationBridgeRequest::Renew {
                        session: f.bridge.clone(),
                    },
                )
                .await;
                heartbeat = std::time::Instant::now();
            }
            let test = f
                .service
                .diagnostic(&f.host, &f.context, &f.project, "produced-image-test")
                .unwrap()
                .unwrap();
            if !matches!(
                test.state,
                ComponentModelTestState::Queued | ComponentModelTestState::Running
            ) {
                assert_eq!(
                    test.state,
                    ComponentModelTestState::Passed,
                    "{:?}",
                    test.detail
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let selection = AgentContextSelection {
        source: "plots".into(),
        label: "Produced plot".into(),
        reference: serde_json::to_value(&media).unwrap(),
        inclusion: "image".into(),
    };
    let preview = f
        .service
        .preview_source(
            &f.host,
            &f.context,
            ComponentSourcePreviewRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                session: Some(f.session.clone()),
                selection: selection.clone(),
            },
        )
        .await
        .unwrap();
    assert!(preview.error.is_none(), "{:?}", preview.error);
    assert!(
        preview
            .image_base64
            .as_ref()
            .is_some_and(|s| s.starts_with("iVBOR"))
    );
    let snapshot = preview.snapshot.unwrap();
    assert!(
        !serde_json::to_string(&snapshot).unwrap().contains(hex),
        "The answer must not be available as source code text"
    );
    let mut forged = selection.clone();
    forged.reference["sha256"] = json!(format!("sha256:{}", "0".repeat(64)));
    let invalid = f
        .service
        .preview_source(
            &f.host,
            &f.context,
            ComponentSourcePreviewRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                session: Some(f.session.clone()),
                selection: forged,
            },
        )
        .await
        .unwrap();
    assert!(invalid.error.is_some());
    let conversation = f
        .service
        .create(
            &f.host,
            &f.context,
            &f.project,
            &f.window,
            "produced-plot",
            ComponentAgentProfile::Plots,
        )
        .unwrap();
    let run=f.service.start(f.host.clone(),f.context.clone(),&f.project,ComponentAgentStart{
        continuation:None,request_id:"inspect-produced-plot".into(),conversation_id:conversation.conversation_id,conversation_version:conversation.version,
        window:f.window.clone(),model_settings_version:1,
        text:"Inspect the actual selected image. Put its dominant fill color (one lowercase English word) on the first line. Then briefly cite the selected operation ID and output number. You may inspect image metadata with output_view if needed. Do not read the producing operation or source code, infer color from metadata, run R or modify anything.".into(),
        grant:ComponentAgentGrant{mode:ComponentAgentMode::Explain,session:Some(f.session.clone()),documents:vec![],files:vec![]},
        sources:vec![snapshot.selection]
    }).await.unwrap();
    let done = tokio::time::timeout(if real_model { Duration::from_millis(run.budget.duration_ms.saturating_add(15_000)) } else { Duration::from_secs(20) }, async {
        loop {
            if heartbeat.elapsed() >= Duration::from_secs(3) {
                bridge(
                    f,
                    ApplicationBridgeRequest::Renew {
                        session: f.bridge.clone(),
                    },
                )
                .await;
                heartbeat = std::time::Instant::now();
            }
            let done = f
                .service
                .run(&f.host, &f.context, &f.project, &run.run_id)
                .unwrap();
            if done.state.is_terminal() {
                break done;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        done.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        done.reason
    );
    let events = f
        .service
        .events(&f.host, &f.context, &f.project, &run.run_id, 0, 128)
        .unwrap();
    let answer = final_plot_answer(events.events);
    assert_eq!(recent_science(f).await, before);
    let reads = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap();
    assert!(reads.iter().all(|t| !t.mutation));
    assert!(
        reads.iter().all(|t| t
            .result
            .as_ref()
            .is_none_or(|r| !r.to_string().contains(hex))),
        "The color answer must not be disclosed by a tool's source-code result"
    );
    println!("{}",json!({"phase":"produced-plot-answer","expected":color,"answer":answer,"reference":media}));
    if real_model {
        assert_eq!(
            observed_color(&answer),
            Some(color),
            "Unexpected image interpretation: {answer}"
        );
        assert!(cites_plot(&answer, media.operation_id.as_str(), media.sequence), "Missing original plot citation: {answer}");
    } else {
        assert_eq!(answer.trim(), "Verified selected image");
    }
    println!(
        "plot interpretation: model_calls={}, readonly_tool_calls={}",
        done.model_calls, done.tool_calls
    );
    println!(
        "produced plot verified: operation={}, sequence={}, sha256={}, bytes={}, real_model={real_model}, added_science=0",
        media.operation_id.as_str(),
        media.sequence,
        media.sha256,
        media.byte_size
    );
}

#[tokio::test]
#[ignore = "requires real Ark/R; a saved image file is not a retained Plots output"]
async fn saved_image_file_cannot_be_forged_into_a_plots_artifact() {
    let f=Fixture::new("grDevices::png('saved-only.png', width=80, height=80); par(mar=c(0,0,0,0)); plot.new(); rect(-1,-1,2,2,col='red',border=NA); grDevices::dev.off(); invisible(NULL)",false).await;
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
    let operation_id = tools[0].operation_id.clone().unwrap();
    let record = f
        .host
        .get_operation(&f.context, &operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded);
    let output: RunROutput = serde_json::from_value(record.output.unwrap()).unwrap();
    assert!(
        output.output_references.is_empty(),
        "A file-only device unexpectedly created retained media: {:?}",
        output.output_references
    );
    let bytes = std::fs::read(f._temp.path().join("saved-only.png")).unwrap();
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let before = recent_science(&f).await;
    let invented = MediaReference {
        operation_id,
        sequence: 1,
        mime_type: "image/png".into(),
        byte_size: bytes.len() as u64,
        sha256: sha256(&bytes),
        display_id: None,
    };
    let preview = f
        .service
        .preview_source(
            &f.host,
            &f.context,
            ComponentSourcePreviewRequest {
                project_root: f.project.clone(),
                window: f.window.clone(),
                session: Some(f.session.clone()),
                selection: AgentContextSelection {
                    source: "plots".into(),
                    label: "Not a Plots artifact".into(),
                    reference: serde_json::to_value(invented).unwrap(),
                    inclusion: "image".into(),
                },
            },
        )
        .await
        .unwrap();
    assert!(preview.error.is_some());
    assert!(preview.snapshot.is_none() && preview.image_base64.is_none());
    assert_eq!(recent_science(&f).await, before);
    f.service.close().await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; SQLite failure injection around component acknowledgements"]
async fn injected_application_write_failures_preserve_native_facts_without_replay() {
    for phase in ["intent", "result", "terminal"] {
        let f = Fixture::new("counter <- counter + 1L; invisible(counter)", false).await;
        let database =
            rusqlite::Connection::open(f._temp.path().join("components.sqlite")).unwrap();
        let trigger = match phase {
            "intent" => {
                "CREATE TRIGGER fail_component BEFORE INSERT ON component_agent_tools BEGIN SELECT RAISE(ABORT,'injected intent failure'); END;"
            }
            "result" => {
                "CREATE TRIGGER fail_component BEFORE UPDATE ON component_agent_tools WHEN json_extract(NEW.value,'$.receipt.phase')='resolved' BEGIN SELECT RAISE(ABORT,'injected result failure'); END;"
            }
            _ => {
                "CREATE TRIGGER fail_component BEFORE UPDATE ON component_agent_runs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected terminal failure'); END;"
            }
        };
        database.execute_batch(trigger).unwrap();
        let run = f.start().await;
        let observed = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let value = f
                    .service
                    .observe_run(&f.host, &f.context, &f.project, &run.run_id)
                    .await
                    .unwrap();
                if value.state.is_terminal() {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            observed.state,
            if phase == "terminal" {
                ComponentAgentRunState::Interrupted
            } else {
                ComponentAgentRunState::Failed
            },
            "{phase}: {:?}",
            observed.reason
        );
        let tools = f
            .service
            .tools(&f.host, &f.context, &f.project, &run.run_id)
            .unwrap();
        assert_eq!(tools.len(), usize::from(phase != "intent"));
        if phase != "intent" {
            let record = f
                .host
                .get_operation(&f.context, tools[0].operation_id.as_ref().unwrap())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(record.status, OperationStatus::Succeeded);
            assert_eq!(
                tools[0].phase,
                if phase == "result" {
                    ComponentToolPhase::Accepted
                } else {
                    ComponentToolPhase::Resolved
                }
            );
        }
        if phase == "terminal" {
            let events = f
                .service
                .events(&f.host, &f.context, &f.project, &run.run_id, 0, 128)
                .unwrap();
            assert!(!events.events.iter().any(|e| matches!(
                e.content,
                ComponentAgentEventContent::State {
                    state: ComponentAgentRunState::Completed,
                    ..
                }
            )));
        }
        database
            .execute_batch("DROP TRIGGER fail_component")
            .unwrap();
        let recovered = f
            .service
            .reconcile(&f.host, &f.context, &f.project, &f.window, &run.run_id)
            .await
            .unwrap();
        assert_eq!(recovered.recovery.as_ref().unwrap().unresolved_mutations, 0);
        if phase != "intent" {
            assert_eq!(
                recovered.recovery.as_ref().unwrap().tools[0].state,
                ComponentRecoveryState::Confirmed
            );
            let mut continued = run.request.clone();
            continued.request_id = format!("continue-after-{phase}");
            continued.conversation_version = f
                .service
                .conversation(&f.host, &f.context, &f.project, &continued.conversation_id)
                .unwrap()
                .version;
            continued.continuation = Some(ComponentContinuation {
                run_id: run.run_id.clone(),
                recovery_digest: recovered.recovery.unwrap().digest,
            });
            let continued = f
                .service
                .start(f.host.clone(), f.context.clone(), &f.project, continued)
                .await
                .unwrap();
            let done = f.terminal(&continued.run_id).await;
            assert_eq!(
                done.state,
                ComponentAgentRunState::Completed,
                "{phase}: {:?}",
                done.reason
            );
            assert!(
                f.service
                    .tools(&f.host, &f.context, &f.project, &done.run_id)
                    .unwrap()
                    .iter()
                    .all(|t| !t.mutation)
            );
        }
        let expected = usize::from(phase != "intent");
        let check = f
            .host
            .invoke(
                &f.context,
                invoke(
                    "verify-failure-boundary",
                    &format!("stopifnot(counter == {expected}L); invisible(NULL)"),
                ),
            )
            .await
            .unwrap();
        assert_eq!(check.status, OperationStatus::Succeeded, "{phase}");
        f.service.close().await;
        println!("application failure boundary {phase}: native increments={expected}, replay=0");
    }
}

async fn console_state(f: &Fixture) -> ConsoleState {
    serde_json::from_value(
        f.host
            .query_snapshot(
                &f.context,
                QueryRequest {
                    capability: CapabilityRef::new("workspace.console_state", 1).unwrap(),
                    arguments: json!({"workspace_instance_id":"main"}),
                },
            )
            .await
            .unwrap()
            .data
            .unwrap(),
    )
    .unwrap()
}
async fn wait_input(f: &Fixture) -> InputRequest {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(input) = console_state(f).await.input {
                break input;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
async fn wait_operation(f: &Fixture, id: &OperationId) -> OperationRecord {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let record = f.host.get_operation(&f.context, id).await.unwrap().unwrap();
            if record.status.is_terminal() {
                break record;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires real Ark/R; native input stays with the user"]
async fn native_input_wait_is_visible_without_copying_input_into_assistant_records() {
    let f = Fixture::new(
        "invisible(readline(get('input_prompt'))); invisible(NULL)",
        false,
    )
    .await;
    let prompt = format!("private-prompt-{}", uuid::Uuid::new_v4());
    f.host
        .invoke(
            &f.context,
            invoke(
                "seed-input",
                &format!(
                    "input_prompt <- {}; invisible(NULL)",
                    serde_json::to_string(&prompt).unwrap()
                ),
            ),
        )
        .await
        .unwrap();
    let run = f.start().await;
    let input = wait_input(&f).await;
    assert_eq!(input.prompt, prompt);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.service
                .run(&f.host, &f.context, &f.project, &run.run_id)
                .unwrap()
                .state
                == ComponentAgentRunState::NeedsInput
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let answer = format!("private-answer-{}", uuid::Uuid::new_v4());
    f.host
        .dispatch(
            &f.context,
            HostRequest::RespondInput(RespondInput {
                session_id: input.session_id,
                operation_id: input.operation_id,
                request_id: input.request_id,
                reply_id: "user-answer".into(),
                value: answer.clone(),
            }),
        )
        .await
        .unwrap();
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
    let events = f
        .service
        .events(&f.host, &f.context, &f.project, &run.run_id, 0, 128)
        .unwrap();
    let records = serde_json::to_string(&(done, tools, events)).unwrap();
    assert!(
        !records.contains(&answer),
        "The user's input was copied into assistant history"
    );
    assert!(
        !records.contains(&prompt),
        "The native input prompt was copied into assistant history"
    );
    f.service.close().await;
}

#[tokio::test]
#[ignore = "requires real Ark/R; another caller's input must not belong to the assistant"]
async fn another_requests_input_does_not_mark_the_queued_assistant_as_needing_input() {
    let f = Fixture::new("counter <- counter + 1L; invisible(NULL)", false).await;
    let user = f
        .host
        .invoke_accepted(
            &f.context,
            invoke(
                "user-input",
                "invisible(readline('User input: ')); invisible(NULL)",
            ),
        )
        .await
        .unwrap();
    let input = wait_input(&f).await;
    let run = f.start().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.service
                .tools(&f.host, &f.context, &f.project, &run.run_id)
                .unwrap()
                .first()
                .is_some_and(|t| t.operation_id.is_some())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let waiting = f
        .service
        .run(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap()
        .state;
    f.service
        .stop(&f.host, &f.context, &f.project, &f.window, &run.run_id)
        .await
        .unwrap();
    assert_eq!(
        f.terminal(&run.run_id).await.state,
        ComponentAgentRunState::Stopped
    );
    assert_eq!(
        console_state(&f).await.input.as_ref().unwrap().operation_id,
        user.operation.operation_id
    );
    f.host
        .dispatch(
            &f.context,
            HostRequest::RespondInput(RespondInput {
                session_id: input.session_id,
                operation_id: input.operation_id,
                request_id: input.request_id,
                reply_id: "user-continues".into(),
                value: "okay".into(),
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        wait_operation(&f, &user.operation.operation_id)
            .await
            .status,
        OperationStatus::Succeeded
    );
    f.service.close().await;
    assert_eq!(waiting, ComponentAgentRunState::WaitingForR);
}

#[tokio::test]
#[ignore = "requires real Ark/R; stopping native input must preserve another R instance"]
async fn stop_native_input_preserves_work_in_another_r_session() {
    let f = Fixture::new(
        "invisible(readline('Assistant input: ')); invisible(NULL)",
        false,
    )
    .await;
    let main: WorkspaceInstance = serde_json::from_value(
        f.host
            .query_snapshot(
                &f.context,
                QueryRequest {
                    capability: CapabilityRef::new("runtime.instance", 1).unwrap(),
                    arguments: json!({"workspace_instance_id":"main"}),
                },
            )
            .await
            .unwrap()
            .data
            .unwrap(),
    )
    .unwrap();
    let created = f
        .host
        .invoke(
            &f.context,
            Invocation {
                client_request_id: "other-session".into(),
                capability: CapabilityRef::new("runtime.create_instance", 1).unwrap(),
                arguments: json!({"name":"Other work","binding":main.binding,"start":true}),
                preconditions: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        created.status,
        OperationStatus::Succeeded,
        "{:?}",
        created.error
    );
    let other: WorkspaceInstance = serde_json::from_value(created.output.unwrap()).unwrap();
    let independent=f.host.invoke_accepted(&f.context,Invocation{client_request_id:"independent-work".into(),capability:CapabilityRef::new("workspace.run_r",1).unwrap(),
        arguments:json!({"workspace_instance_id":other.workspace_instance_id,"code":"Sys.sleep(5); independent_value <- 42L; invisible(NULL)"}),
        preconditions:vec![Precondition{kind:"workspace.session".into(),subject:"active".into(),expected:json!(other.native_session_id)}]}).await.unwrap();
    let run = f.start().await;
    let input = wait_input(&f).await;
    let original = f
        .service
        .tools(&f.host, &f.context, &f.project, &run.run_id)
        .unwrap()[0]
        .operation_id
        .clone()
        .unwrap();
    assert_eq!(input.operation_id, original);
    f.service
        .stop(&f.host, &f.context, &f.project, &f.window, &run.run_id)
        .await
        .unwrap();
    assert_eq!(
        f.terminal(&run.run_id).await.state,
        ComponentAgentRunState::Stopped
    );
    assert_eq!(
        wait_operation(&f, &original).await.status,
        OperationStatus::Cancelled
    );
    let unaffected = wait_operation(&f, &independent.operation.operation_id).await;
    assert_eq!(
        unaffected.status,
        OperationStatus::Succeeded,
        "{:?}",
        unaffected.error
    );
    assert!(!unaffected.cancellation_requested);
    let proof=f.host.invoke(&f.context,Invocation{client_request_id:"verify-other-session".into(),capability:CapabilityRef::new("workspace.run_r",1).unwrap(),
        arguments:json!({"workspace_instance_id":other.workspace_instance_id,"code":"stopifnot(independent_value == 42L); invisible(NULL)"}),
        preconditions:vec![Precondition{kind:"workspace.session".into(),subject:"active".into(),expected:json!(other.native_session_id)}]}).await.unwrap();
    assert_eq!(proof.status, OperationStatus::Succeeded);
    f.service.close().await;
}

struct CapturedInputEngine;
#[async_trait]
impl ComponentAgentEngine for CapturedInputEngine {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let work = async {
            let turn = request.port.begin_model_call().await?;
            let ticket = request
                .port
                .prepare_tool(
                    turn,
                    "selection",
                    "application_run_selection",
                    json!({"document_id":"input-doc"}),
                )
                .await?;
            request.port.execute_tool(ticket).await?;
            Ok::<_, ApplicationError>(())
        };
        tokio::select! {biased;_=request.cancellation.cancelled()=>ComponentEngineOutcome::Stopped,result=work=>match result{
            Ok(())=>ComponentEngineOutcome::Completed,Err(e)=>ComponentEngineOutcome::Failed(e.to_string())
        }}
    }
}

#[tokio::test]
#[ignore = "requires real Ark/R; captured document input ownership"]
async fn captured_document_input_is_marked_and_cancelled_by_its_original_operation() {
    let mut f = Fixture::new("", false).await;
    f.service.close().await;
    f.service = ComponentAgentService::with_engine(
        Arc::new(ApplicationStore::open(&f._temp.path().join("components.sqlite")).unwrap()),
        Arc::new(CapturedInputEngine),
    );
    let key = f
        .service
        .put_session_key(
            &f.host,
            &f.context,
            &f.project,
            &f.window,
            "fixture-only".into(),
        )
        .unwrap();
    let mut settings = f.service.settings(&f.host, &f.context, &f.project).unwrap();
    settings.connection.as_mut().unwrap().credential = key;
    let version = f
        .service
        .configure(&f.host, &f.context, &f.project, &f.window, &settings)
        .await
        .unwrap()
        .version;
    let text = "invisible(readline('Captured input: ')); invisible(NULL)";
    let document = ApplicationDocument {
        document_id: "input-doc".into(),
        version: "v1".into(),
        path: Some("input.R".into()),
        text: text.into(),
        base_text: None,
        base_hash: None,
        selection: ApplicationSelection {
            anchor: 0,
            head: text.encode_utf16().count() as u32,
            version: "s1".into(),
        },
        readonly_reason: None,
    };
    bridge(
        &f,
        ApplicationBridgeRequest::Sync {
            session: f.bridge.clone(),
            sync_id: "input-document".into(),
            changes: ApplicationChanges {
                documents: vec![ApplicationDocumentUpdate {
                    expected_version: None,
                    expected_selection_version: None,
                    document: document.clone(),
                }],
                ..Default::default()
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
            "captured-input",
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
                continuation: None,
                request_id: "captured-input".into(),
                conversation_id: conversation.conversation_id,
                conversation_version: conversation.version,
                window: f.window.clone(),
                model_settings_version: version,
                text: "Run the captured selection".into(),
                grant: ComponentAgentGrant {
                    mode: ComponentAgentMode::Run,
                    session: Some(f.session.clone()),
                    documents: vec![ComponentDocumentGrant {
                        document: document_ref(&document),
                        allow_save: false,
                        path: document.path,
                    }],
                    files: vec![],
                },
                sources: vec![],
            },
        )
        .await
        .unwrap();
    let grant = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let ApplicationBridgeReply::Claimed(Some(grant)) = bridge(
                &f,
                ApplicationBridgeRequest::Claim {
                    session: f.bridge.clone(),
                    claim_request_id: uuid::Uuid::new_v4().to_string(),
                },
            )
            .await
            {
                break grant;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    bridge(
        &f,
        ApplicationBridgeRequest::Complete {
            session: f.bridge.clone(),
            completion: ApplicationCommandCompletion {
                request_id: grant.request.request_id.clone(),
                claim_id: grant.claim_id,
                outcome: ApplicationLocalOutcome::Applied,
                changes: ApplicationChanges::default(),
                diagnostic: None,
            },
        },
    )
    .await;
    let request = ApplicationExecuteRequest {
        session: f.bridge.clone(),
        request_id: grant.request.request_id,
        execution_ref: grant.execution_ref.unwrap(),
        step: ApplicationExecutionStep::Run,
    };
    let host = f.host.clone();
    let context = f.context.clone();
    let execution = tokio::spawn(async move {
        host.dispatch(&context, HostRequest::ApplicationExecute(request))
            .await
    });
    let input = wait_input(&f).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.service
                .run(&f.host, &f.context, &f.project, &run.run_id)
                .unwrap()
                .state
                == ComponentAgentRunState::NeedsInput
            {
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
    let returned: ApplicationExecuteReply =
        serde_json::from_value(execution.await.unwrap().unwrap()).unwrap();
    assert_eq!(returned.receipt.state, ApplicationCommandState::Cancelled);
    assert_eq!(
        returned.receipt.run.unwrap().operation_id.as_ref(),
        Some(&input.operation_id)
    );
    assert_eq!(
        wait_operation(&f, &input.operation_id).await.status,
        OperationStatus::Cancelled
    );
    f.service.close().await;
}

fn final_plot_answer(events: Vec<ComponentAgentEvent>) -> String {
    let mut answer = String::new();
    for event in events {
        match event.content {
            ComponentAgentEventContent::Text { text } => answer.push_str(&text),
            ComponentAgentEventContent::Tool { .. } => answer.clear(),
            _ => {}
        }
    }
    answer
}

fn cites_plot(answer: &str, operation: &str, sequence: u64) -> bool {
    let normalized = answer.replace(['*', '`'], "").to_ascii_lowercase();
    let words: Vec<_> = normalized.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty()).map(|word| word.trim_matches('_')).collect();
    words.contains(&operation) && words.iter().enumerate().any(|(index, word)| {
        if !matches!(*word, "output" | "sequence") { return false; }
        let mut next = index + 1;
        if words.get(next).is_some_and(|word| matches!(*word, "number" | "no")) { next += 1; }
        words.get(next).and_then(|word| word.parse::<u64>().ok()) == Some(sequence)
    })
}

#[test]
fn plot_citation_uses_exact_identity_and_sequence_with_natural_labels() {
    for text in ["red\nSource op_original output 2", "green\n`op_original`, output number 2", "green\nop_original, output/sequence 2"] {
        assert!(cites_plot(text, "op_original", 2));
    }
    assert!(!cites_plot("op_original output 20", "op_original", 2));
    assert!(!cites_plot("op_original_extra output 2", "op_original", 2));
    let events = [ComponentAgentEventContent::Text { text: "I will inspect".into() },
        ComponentAgentEventContent::Tool { receipt_id: "t".into(), phase: ComponentToolPhase::Resolved },
        ComponentAgentEventContent::Text { text: "green\nop_original output 2".into() }]
        .into_iter().enumerate().map(|(index, content)| ComponentAgentEvent { run_id: "run".into(), sequence: index as u64, created_at_ms: 0, content }).collect();
    assert_eq!(final_plot_answer(events), "green\nop_original output 2");
}

fn observed_color(raw: &str) -> Option<&'static str> {
    let mut text = raw.lines().find(|line| !line.trim().is_empty())?.trim();
    for marker in ["**", "__", "`", "\"", "'"] {
        if let Some(inner) = text
            .strip_prefix(marker)
            .and_then(|s| s.strip_suffix(marker))
        {
            text = inner.trim();
            break;
        }
    }
    let color = match text.to_ascii_lowercase().as_str() {
        "red" => "red", "green" => "green", "blue" => "blue", _ => return None,
    };
    let answer = raw.to_ascii_lowercase();
    if ["not red", "not green", "not blue", "cannot", "can't", "uncertain", "guess", "maybe", "perhaps", "no image"].iter().any(|word| answer.contains(word)) {
        return None;
    }
    if answer.split(|c: char| !c.is_ascii_alphabetic()).any(|word| matches!(word, "red" | "green" | "blue") && word != color) {
        return None;
    }
    Some(color)
}
#[test]
fn image_color_oracle_accepts_presentation_but_rejects_ambiguous_claims() {
    assert_eq!(observed_color("**blue**"), Some("blue"));
    assert_eq!(observed_color("`red`"), Some("red"));
    assert_eq!(observed_color(" green\n"), Some("green"));
    assert_eq!(observed_color("not blue"), None);
    assert_eq!(observed_color("red or blue"), None);
    assert_eq!(observed_color("**blue** but uncertain"), None);
    assert_eq!(observed_color("**green**\nSource: op_example, output 2. The fill is green."), Some("green"));
    assert_eq!(observed_color("green\nActually blue."), None);
    assert_eq!(observed_color("green\nIt is not green."), None);
    assert_eq!(observed_color("green\nI cannot see the image."), None);
}
