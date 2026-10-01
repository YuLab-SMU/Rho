use super::*;

pub(crate) async fn operation(
    f: &mut Fixture,
    name: &str,
    capability: &str,
    arguments: Value,
    view: &str,
) -> PluginCommitPlan {
    let (call, caller) = f.begin(name, capability, arguments).await;
    let result = f.answer(caller, origin(view)).await;
    f.settle(&call, result.outcome).await;
    result
}

pub(crate) async fn create(f: &mut Fixture, task: &str, text: &str, context: Value) {
    let created = operation(
        f,
        &format!("create-{task}"),
        "agent.model.create",
        json!({"conversation_id":task,"profile":"project"}),
        "view-one",
    )
    .await;
    assert_eq!(created.outcome, PluginOutcome::Succeeded, "{created:?}");
    let saved = operation(f, &format!("draft-{task}"), "agent.model.draft",
        json!({"conversation_id":task,"draft_version":1,"content":{"text":text,"context":context,"assets":[]},"grant":null}), "view-one").await;
    assert_eq!(saved.outcome, PluginOutcome::Succeeded, "{saved:?}");
}

async fn target(f: &mut Fixture, reference: Value, view: &str) -> Value {
    let request = call(
        "target-read",
        "agent.handoff.target",
        json!({"target":reference}),
        false,
    );
    f.writer
        .send(request.request.clone(), RpcBody::Query(request.clone()))
        .await
        .unwrap();
    let reverse = f.read().await;
    assert_eq!(
        reverse.body,
        RpcBody::HostCall {
            parent_request: request.request.clone(),
            capability: manifest::key("views.caller"),
            arguments: json!({}),
        }
    );
    f.writer
        .send(
            reverse.request,
            RpcBody::HostResult {
                result: json!({"status":"ready","completeness":"complete","data":origin(view)}),
            },
        )
        .await
        .unwrap();
    let result = f.read().await;
    assert_eq!(result.request, request.request);
    match result.body {
        RpcBody::QueryResult {
            data,
            completeness: ObservationCompleteness::Complete,
            ..
        } => data,
        other => panic!("{other:?}"),
    }
}

fn rho(task: &str) -> Value {
    json!({"kind":"rho","conversation_id":task})
}

pub(crate) fn append(source: &Value, target: &Value) -> Value {
    json!({"request_id":"handoff-original","source":source["source"],
        "source_revision":source["revision"],"target":target["target"],
        "target_draft_version":target["draft_version"],
        "target_control_generation":target["control_generation"],
        "body":"Goal:\nReview 科学🙂\n\nConfirmed:\nReviewed by user\n\nNext:\nCheck source",
        "context":source["context"]})
}

#[tokio::test]
async fn handoff_both_target_owners_append_once_and_reopen_receipt_without_sending() {
    for native in [false, true] {
        let mut f = Fixture::start().await;
        create(&mut f, "source", "Original source", json!([])).await;
        let reference = if native {
            let result = operation(
                &mut f,
                "native-create",
                "agent.native.command",
                json!({
                    "request_id":uuid::Uuid::new_v4().to_string(),
                    "command":{"kind":"create","provider":"kimi","model":"fixture","effort":null}
                }),
                "view-one",
            )
            .await;
            assert_eq!(result.outcome, PluginOutcome::Succeeded, "{result:?}");
            let detail = result.output.unwrap()["detail"].clone();
            let task = detail["summary"]["task"]["task_id"].clone();
            let saved = operation(&mut f, "native-draft", "agent.native.command", json!({
                "request_id":uuid::Uuid::new_v4().to_string(),
                "command":{"kind":"save_draft","control":{"task_id":task,"generation":detail["summary"]["attachment"]["generation"]},
                    "version":detail["draft"]["version"],"content":{"text":"Existing draft","context":[],"assets":[]}}
            }), "view-one").await;
            assert_eq!(saved.outcome, PluginOutcome::Succeeded, "{saved:?}");
            json!({"kind":"native","task_id":task})
        } else {
            create(&mut f, "target", "Existing draft", json!([])).await;
            rho("target")
        };
        let source = f
            .query("agent.handoff.source", json!({"source":rho("source")}))
            .await;
        let before = target(&mut f, reference.clone(), "view-one").await;
        let input = append(&source, &before);
        assert_eq!(
            target(&mut f, reference.clone(), "view-two").await["writable"],
            false
        );
        assert_eq!(
            operation(
                &mut f,
                "foreign-target",
                "agent.handoff.append",
                input.clone(),
                "view-two"
            )
            .await
            .outcome,
            PluginOutcome::Failed
        );
        let result = operation(
            &mut f,
            "append",
            "agent.handoff.append",
            input.clone(),
            "view-one",
        )
        .await;
        assert_eq!(result.outcome, PluginOutcome::Succeeded, "{result:?}");
        let receipt = result.output.unwrap();
        let after = target(&mut f, reference.clone(), "view-one").await;
        assert_eq!(
            after["draft"]["text"],
            format!("Existing draft\n\n{}", input["body"].as_str().unwrap())
        );
        assert_eq!(
            after["draft_version"].as_u64().unwrap(),
            before["draft_version"].as_u64().unwrap() + 1
        );
        assert_eq!(after["draft"]["assets"], before["draft"]["assets"]);
        assert_eq!(after["controller"], before["controller"]);
        if !native {
            assert_eq!(
                f.query(
                    "agent.model.history",
                    json!({"conversation_id":"target","limit":20})
                )
                .await["runs"],
                json!([])
            );
        }
        // Later source/target changes must not invalidate the original receipt.
        let changed = operation(&mut f, "source-changed", "agent.model.draft", json!({
            "conversation_id":"source","draft_version":2,"content":{"text":"Changed source","context":[],"assets":[]},"grant":null
        }), "view-one").await;
        assert_eq!(changed.outcome, PluginOutcome::Succeeded);
        let (directory, environment) = f.release().await;
        let mut f = Fixture::open(directory, environment).await;
        assert_eq!(
            f.query(
                "agent.handoff.receipt",
                json!({"request_id":"handoff-original"})
            )
            .await,
            receipt
        );
        let repeated = operation(
            &mut f,
            "retry-after-reopen",
            "agent.handoff.append",
            input.clone(),
            "view-one",
        )
        .await;
        assert_eq!(repeated.outcome, PluginOutcome::Succeeded, "{repeated:?}");
        assert_eq!(repeated.output.unwrap(), receipt);
        assert_eq!(target(&mut f, reference.clone(), "view-one").await, after);
        let mut altered = input;
        altered["body"] = json!("Different content with original identity");
        let rejected = operation(
            &mut f,
            "altered-retry",
            "agent.handoff.append",
            altered,
            "view-one",
        )
        .await;
        assert_eq!(rejected.outcome, PluginOutcome::Failed);
        assert_eq!(target(&mut f, reference.clone(), "view-one").await, after);
        if native {
            let material = f
                .query("agent.handoff.source", json!({"source":reference}))
                .await;
            let rho_target = target(&mut f, rho("source"), "view-one").await;
            let mut back = append(&material, &rho_target);
            back["request_id"] = json!("handoff-native-to-rho");
            let result = operation(
                &mut f,
                "native-to-rho",
                "agent.handoff.append",
                back.clone(),
                "view-one",
            )
            .await;
            assert_eq!(result.outcome, PluginOutcome::Succeeded, "{result:?}");
            assert_eq!(
                target(&mut f, rho("source"), "view-one").await["draft"]["text"],
                format!("Changed source\n\n{}", back["body"].as_str().unwrap())
            );
        }
        f.release().await;
    }
}

#[tokio::test]
async fn handoff_refuses_foreign_view_stale_source_and_target_without_a_receipt() {
    let mut f = Fixture::start().await;
    create(&mut f, "source", "Source", json!([])).await;
    create(&mut f, "target", "Target", json!([])).await;
    let source = f
        .query("agent.handoff.source", json!({"source":rho("source")}))
        .await;
    let before = target(&mut f, rho("target"), "view-one").await;
    assert_eq!(
        target(&mut f, rho("target"), "view-two").await["writable"],
        false
    );
    let input = append(&source, &before);
    for (name, view, field, value) in [
        ("foreign", "view-two", "body", input["body"].clone()),
        (
            "stale-source",
            "view-one",
            "source_revision",
            json!("stale"),
        ),
        ("stale-draft", "view-one", "target_draft_version", json!(0)),
        ("forged-window", "view-one", "window", origin("view-one")),
        (
            "forged-path",
            "view-one",
            "project_root",
            json!("/tmp/another-project"),
        ),
    ] {
        let mut invalid = input.clone();
        invalid[field] = value;
        assert_eq!(
            operation(&mut f, name, "agent.handoff.append", invalid, view)
                .await
                .outcome,
            PluginOutcome::Failed
        );
    }
    assert_eq!(target(&mut f, rho("target"), "view-one").await, before);
    f.writer
        .send(
            id("missing-receipt"),
            RpcBody::Query(call(
                "missing-receipt",
                "agent.handoff.receipt",
                json!({"request_id":"handoff-original"}),
                false,
            )),
        )
        .await
        .unwrap();
    assert!(
        matches!(f.read().await.body, RpcBody::QueryResult { data, completeness: ObservationCompleteness::Partial, .. } if data.is_null())
    );
    // Archived sources remain readable and usable; archived targets do not.
    for task in ["source", "target"] {
        let result = operation(
            &mut f,
            &format!("archive-{task}"),
            "agent.model.update",
            json!({"conversation_id":task,"expected_version":2,"archived":true}),
            "view-one",
        )
        .await;
        assert_eq!(result.outcome, PluginOutcome::Succeeded, "{result:?}");
    }
    assert_eq!(
        f.query("agent.handoff.source", json!({"source":rho("source")}))
            .await["revision"],
        source["revision"]
    );
    assert_eq!(
        target(&mut f, rho("target"), "view-one").await["writable"],
        false
    );
    assert_eq!(
        operation(
            &mut f,
            "archived-target",
            "agent.handoff.append",
            input,
            "view-one"
        )
        .await
        .outcome,
        PluginOutcome::Failed
    );
    f.release().await;
}
