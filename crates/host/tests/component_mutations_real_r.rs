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
    session: ComponentAgentSession,
    results: Arc<Mutex<Vec<Value>>>,
}
impl Fixture {
    async fn new(code: &str, repeat: bool) -> Self {
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
            Arc::new(RunEngine {
                code: code.into(),
                repeat,
                results: results.clone(),
            }),
        );
        let window = registration.session.window;
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
                    connection: Some(ComponentModelConnection {
                        protocol: ComponentModelProtocol::Anthropic,
                        base_url: "https://unused.example".into(),
                        model: "fixture-engine".into(),
                        credential,
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
