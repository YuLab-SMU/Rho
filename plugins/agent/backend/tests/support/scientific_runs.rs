use super::*;

fn scientific_call(
    request: &str,
    capability: &str,
    arguments: Value,
    operation: bool,
) -> PluginCall {
    let mut call = call(request, capability, arguments, operation);
    call.scopes.extend([
        "workspace.read".into(),
        "workspace.run_r".into(),
        "operation.read".into(),
    ]);
    call
}
fn selected_r() -> Value {
    json!({"capability":{"id":"r.execute","version":2},"provider":{"plugin":"org.fixture.r","instance":"r-one","revision":format!("sha256:{}","c".repeat(64)),"artifact":format!("sha256:{}","d".repeat(64))},"project":"project-one","target":"r-session-one"})
}
fn record(f: &Fixture, native: &PluginCall, request: &Value) -> Value {
    json!({"operation":{"operation_id":"original-scientific-operation","caller":{"kind":"plugin","id":"agent-one"},"causation_id":native.operation_id,"idempotency_scope":f.environment.project_root,"capability":request["binding"]["capability"],"normalized_arguments":request,"admission":{"owner_context":{"binding":request["binding"]}}},"status":"succeeded","output":{"value":"scientific result 中文"},"error":null,"recovery":null,"cancellation_requested":false})
}
impl Fixture {
    async fn answer_host(&mut self, frame: RpcFrame, result: Value) {
        self.writer
            .send(frame.request, RpcBody::HostResult { result })
            .await
            .unwrap();
    }
    async fn scientific_begin(&mut self, input: Value, scoped: bool) -> PluginCall {
        let native = if scoped {
            scientific_call("science-run", "agent.model.run", input, true)
        } else {
            call("science-run", "agent.model.run", input, true)
        };
        self.scientific_admit(native).await
    }
    async fn scientific_admit(&mut self, native: PluginCall) -> PluginCall {
        self.writer
            .send(native.request.clone(), RpcBody::Invoke(native.clone()))
            .await
            .unwrap();
        let frame = self.read().await;
        assert!(
            matches!(&frame.body, RpcBody::HostCall { capability, .. } if capability == &manifest::key("views.caller"))
        );
        self.answer_host(
            frame,
            json!({"status":"ready","completeness":"complete","data":origin("view-one")}),
        )
        .await;
        native
    }
    async fn science_input(&mut self, mode: &str) -> Value {
        let mut input = self.run_input().await;
        input["mode"] = json!(mode);
        input["r"] = selected_r();
        input
    }
    async fn session_observation(&mut self, native: &PluginCall) {
        let frame = self.read().await;
        let RpcBody::HostCall {
            parent_request,
            capability,
            arguments,
        } = &frame.body
        else {
            panic!("{frame:?}")
        };
        assert_eq!(parent_request, &native.request);
        assert_eq!(capability, &manifest::key("r.session"));
        let mut r = selected_r();
        r["capability"] = json!({"id":"r.session","version":1});
        assert_eq!(
            arguments,
            &json!({"binding":r,"arguments":{},"preconditions":null})
        );
        self.answer_host(frame, json!({"status":"ready","completeness":"complete","data":{"state":"idle","session_id":"r-session-one","queue_target":null,"checkpoint_available":false,"input":{"prompt":"PRIVATE NATIVE STDIN SENTINEL"}}})).await;
    }
    async fn scientific_receipts(&mut self, run: &Value) -> Value {
        self.query("agent.model.run.tools", json!({"run_id":run["run_id"]}))
            .await
    }
    async fn receive_run(&mut self, native: &PluginCall, state: &str) -> PluginCommitPlan {
        let frame = self.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!("{frame:?}")
        };
        assert_eq!(plan.outcome, PluginOutcome::Succeeded, "{plan:?}");
        assert_eq!(plan.output.as_ref().unwrap()["state"], state, "{plan:?}");
        plan
    }
    async fn inspect_begin(
        &mut self,
        run: &Value,
        receipt: &Value,
        native: &PluginCall,
    ) -> PluginCall {
        let query = scientific_call(
            "inspect-native",
            "agent.model.tool.operation",
            json!({"run_id":run["run_id"],"receipt_id":receipt["receipt_id"]}),
            false,
        );
        self.writer
            .send(query.request.clone(), RpcBody::Query(query.clone()))
            .await
            .unwrap();
        let frame = self.read().await;
        let RpcBody::HostCall {
            parent_request,
            capability,
            arguments,
        } = &frame.body
        else {
            panic!("{frame:?}")
        };
        assert_eq!(parent_request, &query.request);
        assert_eq!(capability, &manifest::key("plugins.delegated_operation"));
        assert_eq!(
            arguments,
            &json!({"parent_operation":native.operation_id,"request":receipt["client_request_id"]})
        );
        self.answer_host(frame, json!({"status":"ready","completeness":"complete","data":{"operation_id":"original-scientific-operation"}})).await;
        query
    }
}

#[tokio::test]
async fn scientific_tools_keep_native_identity_and_late_results_after_model_stop() {
    for stop in [false, true] {
        let mut f = Fixture::start_with_grants(true).await;
        let model = SyntheticModel::with_tool(Some((
            "r_execute".into(),
            json!({"code":"counter <- counter + 1"}),
        )))
        .await;
        f.model_settings(&model).await;
        let input = f.science_input("run").await;
        let native = f.scientific_begin(input, true).await;
        f.session_observation(&native).await;
        model.entered().await;
        let run = f.original_run().await;
        let admission = f
            .query("agent.model.run.admission", json!({"run_id":run["run_id"]}))
            .await;
        assert_eq!(
            admission,
            json!({"operation":native.operation_id,"request":native.request,"binding":native.binding,"r":selected_r()})
        );
        let body = model.state.bodies.lock().unwrap()[0].clone();
        assert!(!body.to_string().contains("PRIVATE NATIVE STDIN SENTINEL"));
        assert_eq!(body["tools"].as_array().unwrap().len(), 2);
        model.state.resume.notify_one();
        let frame = f.read().await;
        let RpcBody::HostCall {
            parent_request,
            capability,
            arguments,
        } = &frame.body
        else {
            panic!("{frame:?}")
        };
        assert_eq!(parent_request, &native.request);
        assert_eq!(capability.id.as_str(), "r.execute");
        assert_eq!(capability.version, 2);
        assert_eq!(
            arguments,
            &json!({"binding":selected_r(),"arguments":{"expected_session":"r-session-one","run":{"code":"counter <- counter + 1"}},"preconditions":null})
        );
        let original_record = record(&f, &native, arguments);
        let receipts = f.scientific_receipts(&run).await;
        assert_eq!(receipts.as_array().unwrap().len(), 1);
        assert_eq!(receipts[0]["client_request_id"], frame.request.as_str());
        if stop {
            let (stop_call, reverse) = f
                .begin(
                    "stop-science",
                    "agent.model.run.stop",
                    json!({"run_id":run["run_id"]}),
                )
                .await;
            let plan = f.answer(reverse, origin("view-one")).await;
            assert_eq!(plan.outcome, PluginOutcome::Succeeded);
            f.settle(&stop_call, plan.outcome).await;
            // The parent cannot commit while this original scientific reply is outstanding.
            f.writer
                .send(id("release-pending-science"), RpcBody::Release)
                .await
                .unwrap();
            assert!(matches!(f.read().await.body, RpcBody::Error { code, .. } if code == "busy"));
        }
        f.answer_host(frame, original_record).await;
        let plan = f
            .receive_run(&native, if stop { "stopped" } else { "completed" })
            .await;
        let receipts = f.scientific_receipts(&run).await;
        assert_eq!(receipts[0]["phase"], "resolved", "{receipts}");
        assert_eq!(receipts[0]["operation_id"], "original-scientific-operation");
        assert_eq!(receipts[0]["result"]["status"], "succeeded");
        assert_eq!(model.count(), if stop { 1 } else { 2 });
        f.settle(&native, plan.outcome).await;
        f.release().await;
    }
}

#[tokio::test]
async fn scientific_disconnect_only_observes_original_request_without_replay_or_store_rewrite() {
    let mut f = Fixture::start_with_grants(true).await;
    let model = SyntheticModel::with_tool(Some((
        "r_execute".into(),
        json!({"code":"counter <- counter + 1"}),
    )))
    .await;
    f.model_settings(&model).await;
    let input = f.science_input("run").await;
    let native = f.scientific_begin(input.clone(), true).await;
    f.session_observation(&native).await;
    model.entered().await;
    let run = f.original_run().await;
    model.state.resume.notify_one();
    let frame = f.read().await;
    let RpcBody::HostCall { arguments, .. } = &frame.body else {
        panic!("{frame:?}")
    };
    let original_record = record(&f, &native, arguments);
    let receipts = f.scientific_receipts(&run).await;
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
    let mut f = Fixture::open_with_grants(directory, environment, true).await;
    assert_eq!(f.original_run().await["state"], "interrupted");
    let admission = f
        .query("agent.model.run.admission", json!({"run_id":run["run_id"]}))
        .await;
    assert_eq!(admission["operation"], json!(native.operation_id));
    assert_eq!(admission["r"], selected_r());
    let before = f.scientific_receipts(&run).await;
    assert_eq!(before[0]["client_request_id"], frame.request.as_str());
    assert_eq!(receipts[0]["receipt_id"], before[0]["receipt_id"]);
    let events = f
        .query(
            "agent.model.run.events",
            json!({"run_id":run["run_id"],"after":0,"limit":100}),
        )
        .await;
    let (repeat, reverse) = f
        .begin("repeat-disconnected-science", "agent.model.run", input)
        .await;
    let repeated = f.answer(reverse, origin("view-one")).await;
    assert_eq!(repeated.output.as_ref().unwrap()["state"], "interrupted");
    f.settle(&repeat, repeated.outcome).await;
    // Query capacity cannot terminate the process or discard another original call.
    let mut pending = vec![];
    for index in 0..16 {
        let call = scientific_call(
            &format!("queued-inspect-{index}"),
            "agent.model.tool.operation",
            json!({"run_id":run["run_id"],"receipt_id":before[0]["receipt_id"]}),
            false,
        );
        f.writer
            .send(call.request.clone(), RpcBody::Query(call.clone()))
            .await
            .unwrap();
        pending.push((call.request, f.read().await));
    }
    let overflow = scientific_call(
        "inspection-overflow",
        "agent.model.tool.operation",
        json!({"run_id":run["run_id"],"receipt_id":before[0]["receipt_id"]}),
        false,
    );
    f.writer
        .send(overflow.request.clone(), RpcBody::Query(overflow))
        .await
        .unwrap();
    assert!(matches!(f.read().await.body,RpcBody::Error{code,..} if code == "busy"));
    let bounded = call(
        "mutation-with-full-reverse-channel",
        "agent.model.run.stop",
        json!({"run_id":run["run_id"]}),
        true,
    );
    f.writer
        .send(bounded.request.clone(), RpcBody::Invoke(bounded))
        .await
        .unwrap();
    assert!(matches!(f.read().await.body,RpcBody::Error{code,..} if code == "busy"));
    assert!(!f.task.is_finished());
    for (request, frame) in pending {
        f.answer_host(
            frame,
            json!({"status":"ready","completeness":"partial","data":{"operation_id":null}}),
        )
        .await;
        let reply = f.read().await;
        assert_eq!(reply.request, request);
        assert!(matches!(
            reply.body,
            RpcBody::QueryResult {
                completeness: ObservationCompleteness::Partial,
                ..
            }
        ));
    }
    // Absent original native evidence is partial. It is never a fresh dispatch.
    let query = scientific_call(
        "inspect-absent",
        "agent.model.tool.operation",
        json!({"run_id":run["run_id"],"receipt_id":before[0]["receipt_id"]}),
        false,
    );
    f.writer
        .send(query.request.clone(), RpcBody::Query(query.clone()))
        .await
        .unwrap();
    let frame = f.read().await;
    f.answer_host(
        frame,
        json!({"status":"ready","completeness":"partial","data":{"operation_id":null}}),
    )
    .await;
    let reply = f.read().await;
    assert_eq!(reply.request, query.request);
    assert!(matches!(
        reply.body,
        RpcBody::QueryResult {
            completeness: ObservationCompleteness::Partial,
            ..
        }
    ));
    for forged in [true, false] {
        let query = f.inspect_begin(&run, &before[0], &native).await;
        let frame = f.read().await;
        let RpcBody::HostCall {
            capability,
            arguments,
            ..
        } = &frame.body
        else {
            panic!("{frame:?}")
        };
        assert_eq!(capability, &manifest::key("operation.get"));
        assert_eq!(
            arguments,
            &json!({"operation_id":"original-scientific-operation"})
        );
        let mut observed = original_record.clone();
        if forged {
            observed["operation"]["causation_id"] = json!("foreign-parent");
        }
        f.answer_host(
            frame,
            json!({"status":"ready","completeness":"complete","data":{"record":observed}}),
        )
        .await;
        let reply = f.read().await;
        assert_eq!(reply.request, query.request);
        if forged {
            assert!(matches!(reply.body, RpcBody::Error { .. }));
        } else {
            let RpcBody::QueryResult {
                data, completeness, ..
            } = reply.body
            else {
                panic!("{reply:?}")
            };
            assert_eq!(completeness, ObservationCompleteness::Complete);
            assert_eq!(data["operation"]["status"], "succeeded");
        }
    }
    assert_eq!(f.scientific_receipts(&run).await, before);
    assert_eq!(
        f.query(
            "agent.model.run.events",
            json!({"run_id":run["run_id"],"after":0,"limit":100})
        )
        .await,
        events
    );
    assert_eq!(model.count(), 1);
    f.release().await;
}

#[tokio::test]
async fn scientific_admission_requires_captured_grants_and_exact_target_before_model() {
    for case in [
        "missing-grant",
        "missing-scope",
        "foreign-project",
        "no-target",
        "wrong-version",
        "query-binding-cannot-run",
        "unsupported-mode",
    ] {
        let mut f = Fixture::start_with_grants(case != "missing-grant").await;
        let model = SyntheticModel::start().await;
        f.model_settings(&model).await;
        let mut input = f.science_input("run").await;
        match case {
            "foreign-project" => input["r"]["project"] = json!("foreign"),
            "no-target" => input["r"]["target"] = Value::Null,
            "wrong-version" => input["r"]["capability"]["version"] = json!(1),
            "query-binding-cannot-run" => {
                input["r"]["capability"] = json!({"id":"r.session","version":1})
            }
            "unsupported-mode" => input["mode"] = json!("edit"),
            _ => {}
        }
        let native = f.scientific_begin(input, case != "missing-scope").await;
        let frame = f.read().await;
        assert_eq!(frame.request, native.request);
        let RpcBody::CommitPlan(plan) = frame.body else {
            panic!("{frame:?}")
        };
        assert_eq!(plan.outcome, PluginOutcome::Failed, "{case}: {plan:?}");
        assert_eq!(model.count(), 0);
        f.settle(&native, plan.outcome).await;
        f.release().await;
    }
}

#[tokio::test]
async fn scientific_model_cannot_expand_explain_or_choose_provider_via_tool_arguments() {
    for mode in ["explain", "run"] {
        let mut f = Fixture::start_with_grants(true).await;
        let arguments = if mode == "explain" {
            json!({"code":"counter <- 1"})
        } else {
            json!({"code":"counter <- 1","provider":selected_r()["provider"]})
        };
        let model = SyntheticModel::with_tool(Some(("r_execute".into(), arguments))).await;
        f.model_settings(&model).await;
        let input = f.science_input(mode).await;
        let native = f.scientific_begin(input, true).await;
        f.session_observation(&native).await;
        model.entered().await;
        let run = f.original_run().await;
        model.state.resume.notify_one();
        // No scientific HostCall may precede this failed task result.
        let plan = f.receive_run(&native, "failed").await;
        assert_eq!(f.scientific_receipts(&run).await, json!([]));
        assert_eq!(model.count(), 1);
        f.settle(&native, plan.outcome).await;
        f.release().await;
    }
}

#[tokio::test]
async fn scientific_explain_uses_only_the_original_readonly_r_query() {
    let mut f = Fixture::start_with_optional(&["r.session"]).await;
    let model = SyntheticModel::with_tool(Some(("r_session".into(), json!({})))).await;
    f.model_settings(&model).await;
    let mut input = f.science_input("explain").await;
    // A read-only provider need not advertise r.execute just to explain its session.
    input["r"]["capability"] = json!({"id":"r.session","version":1});
    let mut native = scientific_call("science-run", "agent.model.run", input, true);
    native.scopes.remove("workspace.run_r");
    native.scopes.remove("operation.read");
    let native = f.scientific_admit(native).await;
    f.session_observation(&native).await;
    model.entered().await;
    let run = f.original_run().await;
    assert_eq!(
        model.state.bodies.lock().unwrap()[0]["tools"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    model.state.resume.notify_one();
    f.session_observation(&native).await;
    let plan = f.receive_run(&native, "completed").await;
    let receipts = f.scientific_receipts(&run).await;
    assert_eq!(receipts.as_array().unwrap().len(), 1);
    assert_eq!(receipts[0]["mutation"], false);
    assert_eq!(receipts[0]["operation_id"], Value::Null);
    assert_eq!(receipts[0]["phase"], "resolved");
    assert!(
        !model.state.bodies.lock().unwrap()[1]
            .to_string()
            .contains("PRIVATE NATIVE STDIN SENTINEL")
    );
    f.settle(&native, plan.outcome).await;
    f.release().await;
}

#[tokio::test]
async fn scientific_stale_r_observation_fails_without_reading_key_or_starting_runtime() {
    let mut f = Fixture::start_with_grants(true).await;
    let model = SyntheticModel::start().await;
    f.model_settings(&model).await;
    let input = f.science_input("run").await;
    std::fs::remove_file(
        std::path::Path::new(&f.environment.data_root).join("model-credentials-v1.json"),
    )
    .unwrap();
    let native = f.scientific_begin(input, true).await;
    let frame = f.read().await;
    assert!(
        matches!(&frame.body,RpcBody::HostCall{capability,..} if capability == &manifest::key("r.session"))
    );
    f.answer_host(frame,json!({"status":"ready","completeness":"complete","data":{"state":"unstarted","session_id":null}})).await;
    let plan = f.receive_run(&native, "failed").await;
    assert_eq!(plan.output.as_ref().unwrap()["model_calls"], 0);
    assert!(
        plan.output.as_ref().unwrap()["reason"]
            .as_str()
            .unwrap()
            .contains("selected R session")
    );
    assert_eq!(model.count(), 0);
    f.settle(&native, plan.outcome).await;
    f.release().await;
}
