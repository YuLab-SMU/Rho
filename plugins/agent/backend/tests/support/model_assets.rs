use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

fn upload(bytes: &[u8], mime: &str) -> Value {
    json!({"request_id":uuid::Uuid::new_v4().to_string(),"conversation_id":"task-one","name":"附件 Ω.txt","mime_type":mime,"bytes":bytes.len(),"sha256":format!("{:x}", Sha256::digest(bytes))})
}
async fn control(f: &mut Fixture, cap: &str, input: Value, view: &str) -> RpcBody {
    let call = call(&uuid::Uuid::new_v4().to_string(), cap, input, false);
    f.writer
        .send(call.request.clone(), RpcBody::Control(call.clone()))
        .await
        .unwrap();
    let reverse = f.read().await;
    assert!(
        matches!(&reverse.body, RpcBody::HostCall { capability, parent_request, .. } if capability == &manifest::key("views.caller") && parent_request == &call.request)
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
    let reply = f.read().await;
    assert_eq!(reply.request, call.request);
    reply.body
}
async fn stage(f: &mut Fixture, upload: &Value, bytes: &[u8]) {
    for (index, part) in bytes.chunks(65536).enumerate() {
        let reply = control(
            f,
            "agent.model.assets.stage",
            json!({"upload":upload,"offset":index*65536,"data":STANDARD.encode(part)}),
            "view-one",
        )
        .await;
        let RpcBody::ControlResult { data } = reply else {
            panic!("{reply:?}")
        };
        assert_eq!(data["upload"], *upload);
        assert_eq!(data["received"], (index * 65536 + part.len()) as u64);
    }
}
async fn finish(f: &mut Fixture, upload: &Value) -> Value {
    let reply = control(
        f,
        "agent.model.assets.finish",
        json!({"upload":upload}),
        "view-one",
    )
    .await;
    let RpcBody::ControlResult { data } = reply else {
        panic!("{reply:?}")
    };
    data
}

#[tokio::test]
async fn rho_attachments_reopen_with_original_identity_and_no_implicit_draft_or_model() {
    let mut f = Fixture::start().await;
    f.run_input().await;
    let bytes = "Immutable 中文 Ω attachment".as_bytes();
    let input = upload(bytes, "text/plain");
    stage(&mut f, &input, bytes).await;
    stage(&mut f, &input, bytes).await;
    let result = finish(&mut f, &input).await;
    assert_eq!(result["asset"]["asset_id"], input["request_id"]);
    let before = f
        .query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"}),
        )
        .await;
    assert_eq!(before["draft_content"]["assets"], json!([]));
    let (directory, environment) = f.release().await;
    let mut f = Fixture::open(directory, environment).await;
    assert_eq!(finish(&mut f, &input).await, result);
    let assets = f
        .query("agent.model.assets", json!({"conversation_id":"task-one"}))
        .await;
    assert_eq!(assets["assets"], json!([result["asset"]]));
    let mut changed = input.clone();
    changed["name"] = json!("different.txt");
    assert!(matches!(
        control(
            &mut f,
            "agent.model.assets.finish",
            json!({"upload":changed}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    assert!(matches!(
        control(
            &mut f,
            "agent.model.assets.stage",
            json!({"upload":input,"offset":0,"data":STANDARD.encode(bytes)}),
            "other-view"
        )
        .await,
        RpcBody::Error { .. }
    ));
    assert_eq!(
        f.query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"})
        )
        .await,
        before
    );
    f.release().await;
}

#[tokio::test]
async fn rho_confirmed_attachment_reselection_releases_transient_transfer_slots() {
    let mut f = Fixture::start().await;
    f.run_input().await;
    let bytes = b"original file";
    // Staging allows 16 in-flight files. Successfully finishing and then
    // reselecting files must not consume those slots permanently.
    for _ in 0..17 {
        let input = upload(bytes, "text/plain");
        stage(&mut f, &input, bytes).await;
        let original = finish(&mut f, &input).await;
        stage(&mut f, &input, bytes).await;
        assert_eq!(finish(&mut f, &input).await, original);
    }
    assert_eq!(
        f.query("agent.model.assets", json!({"conversation_id":"task-one"}))
            .await["assets"]
            .as_array()
            .unwrap()
            .len(),
        17
    );
    f.release().await;
}

#[tokio::test]
async fn rho_attachment_only_send_captures_full_text_and_original_retry_never_starts_another_model()
{
    let mut f = Fixture::start().await;
    let model = SyntheticModel::start().await;
    f.model_settings(&model).await;
    let mut input = f.run_input().await;
    let bytes = "Explain this analysis ".to_string() + &"a".repeat(18000) + " Unicode 中文 Ω";
    let upload = upload(bytes.as_bytes(), "text/plain");
    stage(&mut f, &upload, bytes.as_bytes()).await;
    finish(&mut f, &upload).await;
    let (draft, caller) = f.begin("attachment-draft", "agent.model.draft", json!({"conversation_id":"task-one","draft_version":1,"content":{"text":"","assets":[upload["request_id"]],"context":[]},"grant":null})).await;
    let saved = f.answer(caller, origin("view-one")).await;
    assert_eq!(saved.outcome, PluginOutcome::Succeeded);
    input["conversation_version"] = saved.output.as_ref().unwrap()["version"].clone();
    input["text"] = json!("");
    input["assets"] = json!([upload["request_id"]]);
    f.settle(&draft, saved.outcome).await;
    let native = f.begin_run(input.clone()).await;
    model.entered().await;
    let original = f.original_run().await;
    assert_eq!(original["context"]["sources"][0]["text"], bytes);
    assert_eq!(
        original["context"]["sources"][0]["evidence"][0]["asset"]["sha256"],
        upload["sha256"]
    );
    assert!(
        model.state.bodies.lock().unwrap()[0]
            .to_string()
            .contains("Unicode 中文 Ω")
    );
    model.state.resume.notify_one();
    let RpcBody::CommitPlan(done) = f.read().await.body else {
        panic!()
    };
    assert_eq!(done.outcome, PluginOutcome::Succeeded);
    f.settle(&native, done.outcome).await;
    let (directory, environment) = f.release().await;
    let mut f = Fixture::open(directory, environment).await;
    let (retry, caller) = f.begin("attachment-retry", "agent.model.run", input).await;
    let done = f.answer(caller, origin("view-one")).await;
    assert_eq!(done.outcome, PluginOutcome::Succeeded, "{done:?}");
    assert_eq!(
        done.output.as_ref().unwrap()["context"],
        original["context"]
    );
    assert_eq!(model.count(), 1);
    f.settle(&retry, done.outcome).await;
    f.release().await;
}

#[tokio::test]
async fn rho_invalid_attachment_and_unverified_image_preserve_draft_without_model_work() {
    let mut f = Fixture::start().await;
    let model = SyntheticModel::start().await;
    f.model_settings(&model).await;
    let mut input = f.run_input().await;
    let binary = upload(&[0xff], "text/plain");
    stage(&mut f, &binary, &[0xff]).await;
    assert!(matches!(
        control(
            &mut f,
            "agent.model.assets.finish",
            json!({"upload":binary}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    let bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    let image = upload(bytes, "image/png");
    stage(&mut f, &image, bytes).await;
    finish(&mut f, &image).await;
    let before = f
        .query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"}),
        )
        .await;
    for asset in [json!("missing"), image["request_id"].clone()] {
        input["assets"] = json!([asset]);
        let (native, caller) = f
            .begin(
                &uuid::Uuid::new_v4().to_string(),
                "agent.model.run",
                input.clone(),
            )
            .await;
        let result = f.answer(caller, origin("view-one")).await;
        assert_eq!(result.outcome, PluginOutcome::Failed, "{result:?}");
        f.settle(&native, result.outcome).await;
        assert_eq!(
            f.query(
                "agent.model.conversation",
                json!({"conversation_id":"task-one"})
            )
            .await,
            before
        );
    }
    assert_eq!(model.count(), 0);
    f.release().await;
}

#[tokio::test]
async fn rho_verified_image_bytes_reach_current_send_but_are_not_implicitly_replayed_in_history() {
    use rho_agent_api::{ComponentModelSettings, component::ComponentModelDiagnostic};
    use rho_agent_owner::{
        AgentTaskScope,
        component::{ComponentAgentRepository, component_digest},
    };
    let mut f = Fixture::start().await;
    let model = SyntheticModel::start().await;
    let settings: ComponentModelSettings =
        serde_json::from_value(f.model_settings(&model).await).unwrap();
    let mut input = f.run_input().await;
    // Seed an exact passing connection diagnostic to isolate input composition.
    // This is not an assertion of a real model's visual recognition quality.
    let connection = settings.connection.unwrap();
    let diagnostic: ComponentModelDiagnostic = serde_json::from_value(json!({
        "request_id":"verified-image-fixture","version":1,"window":{"window_id":"window-one","incarnation":"view:view-one"},
        "model_settings_version":1,"connection_digest":component_digest(&connection).unwrap(),"model":connection,
        "kind":"images","state":"passed","created_at_ms":1,"updated_at_ms":1,"detail":null
    })).unwrap();
    let store = rho_agent_store::AgentStore::open(
        &std::path::Path::new(&f.environment.data_root).join("agent-v1.sqlite"),
    )
    .unwrap();
    let scope = AgentTaskScope {
        project: f.environment.project_root.clone(),
        principal: instance().principal.to_string(),
    };
    store
        .write_component_diagnostic(&scope, None, &diagnostic)
        .unwrap();
    drop(store);
    let image = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
    let bytes = STANDARD.decode(image).unwrap();
    let upload = upload(&bytes, "image/png");
    stage(&mut f, &upload, &bytes).await;
    finish(&mut f, &upload).await;
    input["assets"] = json!([upload["request_id"]]);
    let first = f.begin_run(input.clone()).await;
    model.entered().await;
    assert!(
        model.state.bodies.lock().unwrap()[0]
            .to_string()
            .contains(image)
    );
    assert!(
        !f.original_run().await["context"]
            .to_string()
            .contains(image)
    );
    model.state.resume.notify_one();
    let RpcBody::CommitPlan(done) = f.read().await.body else {
        panic!()
    };
    assert_eq!(done.outcome, PluginOutcome::Succeeded);
    f.settle(&first, done.outcome).await;
    input["request_id"] = json!("followup-without-image");
    input["assets"] = Value::Null;
    input["conversation_version"] = f
        .query(
            "agent.model.conversation",
            json!({"conversation_id":"task-one"}),
        )
        .await["version"]
        .clone();
    let (second, caller) = f
        .begin("followup-image-history", "agent.model.run", input)
        .await;
    let done = f.answer(caller, origin("view-one")).await;
    assert_eq!(done.outcome, PluginOutcome::Succeeded, "{done:?}");
    assert_eq!(model.count(), 2);
    assert!(
        !model.state.bodies.lock().unwrap()[1]
            .to_string()
            .contains(image)
    );
    f.settle(&second, done.outcome).await;
    f.release().await;
}
