use super::*;
use rho_agent_owner::{AgentTaskScope, component::ComponentAgentRepository};
use rho_agent_store::AgentStore;

impl Fixture {
    pub(super) async fn run_input(&mut self) -> Value {
        let (native, reverse) = self
            .begin(
                "create-model-task",
                "agent.model.create",
                json!({"conversation_id":"task-one","profile":"project"}),
            )
            .await;
        let result = self.answer(reverse, origin("view-one")).await;
        assert_eq!(result.outcome, PluginOutcome::Succeeded);
        let conversation = result.output.unwrap();
        self.settle(&native, result.outcome).await;
        json!({"request_id":"original-model-run","conversation_id":"task-one","conversation_version":conversation["version"],"model_settings_version":1,"text":"Explain this analysis"})
    }
    async fn begin_run(&mut self, arguments: Value) -> PluginCall {
        let (native, reverse) = self.begin("run-model", "agent.model.run", arguments).await;
        self.writer.send(reverse.request, RpcBody::HostResult { result: json!({"status":"ready","completeness":"complete","data":origin("view-one")}) }).await.unwrap();
        native
    }
    pub(super) async fn original_run(&mut self) -> Value {
        self.query(
            "agent.model.run.request",
            json!({"request_id":"original-model-run"}),
        )
        .await
    }
}

#[tokio::test]
async fn model_run_retains_native_parent_text_events_and_original_request_without_replay() {
    let mut f = Fixture::start().await;
    let model = SyntheticModel::start().await;
    f.model_settings(&model).await;
    let input = f.run_input().await;
    let native = f.begin_run(input.clone()).await;
    model.entered().await;
    let running = f.original_run().await;
    assert_eq!(running["state"], "running");
    assert_eq!(running["model_calls"], 1);
    let tasks = f
        .query(
            "agent.tasks",
            json!({"archived":false,"before":null,"limit":20}),
        )
        .await;
    assert!(tasks.to_string().contains("running"), "{tasks}");
    let store =
        AgentStore::open(&std::path::Path::new(&f.environment.data_root).join("agent-v1.sqlite"))
            .unwrap();
    let scope = AgentTaskScope {
        project: f.environment.project_root.clone(),
        principal: instance().principal.to_string(),
    };
    let retained = store
        .component_run_by_request(&scope, "original-model-run")
        .unwrap()
        .unwrap();
    let parent = retained.native_origin.unwrap();
    assert_eq!(
        parent.operation.as_str(),
        native.operation_id.as_ref().unwrap()
    );
    assert_eq!(parent.request, native.request);
    assert_eq!(parent.binding, native.binding);
    drop(store);
    let (retry, reverse) = f
        .begin("repeat-run", "agent.model.run", input.clone())
        .await;
    let repeated = f.answer(reverse, origin("view-one")).await;
    assert_eq!(
        repeated.output.as_ref().unwrap()["run_id"],
        running["run_id"]
    );
    assert_eq!(repeated.output.as_ref().unwrap()["state"], "running");
    f.settle(&retry, repeated.outcome).await;
    f.writer
        .send(id("while-running"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    model.state.resume.notify_one();
    let frame = f.read().await;
    assert_eq!(frame.request, native.request);
    let RpcBody::CommitPlan(result) = frame.body else {
        panic!()
    };
    assert_eq!(result.outcome, PluginOutcome::Succeeded);
    assert_eq!(
        result.output.as_ref().unwrap()["state"],
        "completed",
        "{result:?}"
    );
    let events = f
        .query(
            "agent.model.run.events",
            json!({"run_id":running["run_id"],"after":0,"limit":100}),
        )
        .await;
    assert!(
        events.to_string().contains("Fixture model answer 中文"),
        "{events}"
    );
    assert!(!events.to_string().contains("diagnostic-fixture-key"));
    f.writer
        .send(id("awaiting-settlement"), RpcBody::Release)
        .await
        .unwrap();
    assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
    f.settle(&native, result.outcome).await;
    let (directory, environment) = f.release().await;
    // Repeated requests and reads must not even require the original key file.
    std::fs::remove_file(
        std::path::Path::new(&environment.data_root).join("model-credentials-v1.json"),
    )
    .unwrap();
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(reopened.original_run().await["state"], "completed");
    let (retry, reverse) = reopened
        .begin("repeat-after-reopen", "agent.model.run", input)
        .await;
    let repeated = reopened.answer(reverse, origin("view-one")).await;
    assert_eq!(
        repeated.output.as_ref().unwrap()["run_id"],
        running["run_id"]
    );
    assert_eq!(repeated.output.as_ref().unwrap()["state"], "completed");
    reopened.settle(&retry, repeated.outcome).await;
    assert_eq!(
        reopened
            .query(
                "agent.model.run.events",
                json!({"run_id":running["run_id"],"after":0,"limit":100})
            )
            .await,
        events
    );
    assert_eq!(model.count(), 1);
    reopened.release().await;
}

#[tokio::test]
async fn model_run_stop_disable_and_takeover_fence_the_original_loop() {
    for action in ["stop", "disable", "takeover"] {
        let mut f = Fixture::start().await;
        let model = SyntheticModel::start().await;
        let settings = f.model_settings(&model).await;
        let input = f.run_input().await;
        let native = f.begin_run(input).await;
        model.entered().await;
        let running = f.original_run().await;
        let (foreign, reverse) = f
            .begin(
                "foreign-stop",
                "agent.model.run.stop",
                json!({"run_id":running["run_id"]}),
            )
            .await;
        let denied = f.answer(reverse, origin("view-two")).await;
        assert_eq!(denied.outcome, PluginOutcome::Failed);
        f.settle(&foreign, denied.outcome).await;
        let (control, reverse) = match action {
            "stop" => {
                f.begin(
                    "stop-run",
                    "agent.model.run.stop",
                    json!({"run_id":running["run_id"]}),
                )
                .await
            }
            "disable" => {
                let mut settings = settings;
                settings["enabled"] = json!(false);
                f.begin("disable", "agent.model.configure", settings).await
            }
            _ => {
                let conversation = f
                    .query(
                        "agent.model.conversation",
                        json!({"conversation_id":"task-one"}),
                    )
                    .await;
                f.begin("takeover", "agent.model.take_control", json!({"conversation_id":"task-one","expected_version":conversation["version"]})).await
            }
        };
        let controller = if action == "takeover" {
            "view-two"
        } else {
            "view-one"
        };
        f.writer.send(reverse.request, RpcBody::HostResult { result: json!({"status":"ready","completeness":"complete","data":origin(controller)}) }).await.unwrap();
        for _ in 0..2 {
            let frame = f.read().await;
            let RpcBody::CommitPlan(result) = frame.body else {
                panic!()
            };
            assert_eq!(result.outcome, PluginOutcome::Succeeded, "{result:?}");
            if frame.request == native.request {
                assert_eq!(
                    result.output.unwrap()["state"],
                    if action == "takeover" {
                        "interrupted"
                    } else {
                        "stopped"
                    }
                );
            } else {
                assert_eq!(frame.request, control.request);
            }
        }
        f.settle(&native, PluginOutcome::Succeeded).await;
        f.settle(&control, PluginOutcome::Succeeded).await;
        assert_eq!(model.count(), 1);
        f.release().await;
    }
}

#[tokio::test]
async fn model_run_disconnect_reopens_original_observation_without_key_read_or_model_restart() {
    let mut f = Fixture::start().await;
    let model = SyntheticModel::start().await;
    f.model_settings(&model).await;
    let input = f.run_input().await;
    let native = f.begin_run(input.clone()).await;
    model.entered().await;
    let run = f.original_run().await;
    let Fixture {
        directory,
        environment,
        reader,
        writer,
        task,
    } = f;
    drop(reader);
    drop(writer);
    task.await.unwrap().unwrap();
    std::fs::remove_file(
        std::path::Path::new(&environment.data_root).join("model-credentials-v1.json"),
    )
    .unwrap();
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(reopened.original_run().await["state"], "interrupted");
    let (retry, reverse) = reopened
        .begin("repeated-abandoned", "agent.model.run", input)
        .await;
    let repeated = reopened.answer(reverse, origin("view-one")).await;
    assert_eq!(repeated.output.as_ref().unwrap()["run_id"], run["run_id"]);
    assert_eq!(repeated.output.as_ref().unwrap()["state"], "interrupted");
    reopened.settle(&retry, repeated.outcome).await;
    let store = AgentStore::open(
        &std::path::Path::new(&reopened.environment.data_root).join("agent-v1.sqlite"),
    )
    .unwrap();
    let scope = AgentTaskScope {
        project: reopened.environment.project_root.clone(),
        principal: instance().principal.to_string(),
    };
    let retained = store
        .component_run_by_request(&scope, "original-model-run")
        .unwrap()
        .unwrap();
    assert_eq!(
        retained.run.state,
        rho_agent_api::component::ComponentAgentRunState::Running
    );
    assert_eq!(retained.native_origin.unwrap().request, native.request);
    assert_eq!(model.count(), 1);
    drop(store);
    reopened.release().await;
}

#[tokio::test]
async fn model_run_refuses_uncaptured_authority_and_retains_preflight_failure_without_model_call() {
    let mut f = Fixture::start().await;
    let model = SyntheticModel::start().await;
    f.model_settings(&model).await;
    let input = f.run_input().await;
    let mut forged = input.clone();
    forged["grant"] =
        json!({"mode":"run","session":{"session_id":"forged","workspace_instance_id":"forged"}});
    let (invalid, reverse) = f.begin("forged-authority", "agent.model.run", forged).await;
    let refused = f.answer(reverse, origin("view-one")).await;
    assert_eq!(refused.outcome, PluginOutcome::Failed);
    assert_eq!(refused.recovery.unwrap()["code"], "invalid_input");
    f.settle(&invalid, refused.outcome).await;
    assert_eq!(
        f.query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"})
        )
        .await["active_run_id"],
        Value::Null
    );
    std::fs::remove_file(
        std::path::Path::new(&f.environment.data_root).join("model-credentials-v1.json"),
    )
    .unwrap();
    let (failed, reverse) = f
        .begin("missing-key", "agent.model.run", input.clone())
        .await;
    let outcome = f.answer(reverse, origin("view-one")).await;
    assert_eq!(outcome.outcome, PluginOutcome::Succeeded);
    assert_eq!(outcome.output.as_ref().unwrap()["state"], "failed");
    assert_eq!(outcome.output.as_ref().unwrap()["model_calls"], 0);
    f.settle(&failed, outcome.outcome).await;
    let original = f.original_run().await;
    let (retry, reverse) = f
        .begin("repeat-preflight-failure", "agent.model.run", input)
        .await;
    let repeated = f.answer(reverse, origin("view-one")).await;
    assert_eq!(repeated.output.unwrap()["run_id"], original["run_id"]);
    f.settle(&retry, repeated.outcome).await;
    assert_eq!(model.count(), 0);
    f.release().await;
}
