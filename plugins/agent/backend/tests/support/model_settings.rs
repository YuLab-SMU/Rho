use super::*;

async fn raw_status(f: &mut Fixture, version: u64) -> RpcBody {
    f.writer
        .send(
            id("status"),
            RpcBody::Query(call(
                "status",
                "agent.model.key.status",
                json!({"settings_version":version}),
                false,
            )),
        )
        .await
        .unwrap();
    let reply = f.read().await;
    assert_eq!(reply.request, id("status"));
    reply.body
}
async fn configured_key(f: &mut Fixture) -> Value {
    let reverse = f
        .begin_control(
            "key",
            json!({"request_id":"key-original","value":"synthetic-only-key"}),
        )
        .await;
    let RpcBody::ControlResult { data: reference } =
        f.control_answer(reverse, origin("view-one")).await
    else {
        panic!("Expected stored key reference")
    };
    let settings = json!({"version":0,"enabled":true,"connection":{"protocol":"openai_completions","base_url":"https://fixture.invalid/v1","model":"fixture-only","credential":reference}});
    let (call, reverse) = f
        .begin("configure", "agent.model.configure", settings)
        .await;
    let result = f.answer(reverse, origin("view-one")).await;
    assert_eq!(
        result.outcome,
        PluginOutcome::Succeeded,
        "{:?}",
        result.error
    );
    f.settle(&call, PluginOutcome::Succeeded).await;
    result.output.unwrap()
}

#[tokio::test]
async fn configured_key_status_is_bounded_read_only_and_requires_exact_settings() {
    let mut f = Fixture::start().await;
    let path = std::path::Path::new(&f.environment.data_root).join("model-credentials-v1.json");
    assert_eq!(
        f.query("agent.model.key.status", json!({"settings_version":0}))
            .await,
        json!({"credential":null,"available":false})
    );
    assert!(!path.exists());
    let settings = configured_key(&mut f).await;
    let status = f
        .query("agent.model.key.status", json!({"settings_version":1}))
        .await;
    assert_eq!(
        status,
        json!({"credential":settings["connection"]["credential"],"available":true})
    );
    assert!(!status.to_string().contains("synthetic-only-key"));
    assert!(
        matches!(raw_status(&mut f, 0).await, RpcBody::Error { code, .. } if code == "conflict")
    );
    assert_eq!(
        f.query("agent.tasks", json!({"limit":20})).await["tasks"],
        json!([])
    );
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, b"not valid credential storage").unwrap();
    assert!(
        matches!(raw_status(&mut f, 1).await, RpcBody::Error { code, .. } if code == "agent_storage_unavailable")
    );
    std::fs::write(&path, bytes).unwrap();
    f.release().await;
}

#[tokio::test]
async fn removal_fences_settings_and_key_replacement_and_retains_original_receipt() {
    let mut f = Fixture::start().await;
    let settings = configured_key(&mut f).await;
    let reference = settings["connection"]["credential"].clone();
    for (request, version, key) in [
        ("old-settings", 0, reference["key_id"].clone()),
        ("other-key", 1, json!("other-key")),
    ] {
        let reverse = f
            .begin_named_control(
                request,
                "agent.model.key.remove",
                json!({"settings_version":version,"key_id":key}),
            )
            .await;
        assert!(
            matches!(f.control_answer(reverse, origin("view-one")).await, RpcBody::Error { code, .. } if code == "conflict")
        );
        assert_eq!(
            f.query("agent.model.key.status", json!({"settings_version":1}))
                .await["available"],
            true
        );
    }
    for request in ["remove", "repeat-removal"] {
        let reverse = f
            .begin_named_control(
                request,
                "agent.model.key.remove",
                json!({"settings_version":1,"key_id":reference["key_id"]}),
            )
            .await;
        assert_eq!(
            f.control_answer(reverse, origin("view-one")).await,
            RpcBody::ControlResult {
                data: json!({"credential":reference,"available":false})
            }
        );
    }
    assert_eq!(f.query("agent.model.settings", json!({})).await, settings);
    assert_eq!(
        f.query(
            "agent.model.key.receipt",
            json!({"request_id":"key-original"})
        )
        .await,
        json!({"credential":reference,"available":false})
    );
    let reverse = f
        .begin_control(
            "late-original-store",
            json!({"request_id":"key-original","value":"synthetic-only-key"}),
        )
        .await;
    assert!(
        matches!(f.control_answer(reverse, origin("view-one")).await, RpcBody::Error { code, .. } if code == "conflict")
    );
    let mut replacement = settings;
    replacement["connection"]["credential"] =
        json!({"kind":"environment","name":"RHO_AGENT_FIXTURE_UNUSED_KEY"});
    let (call, reverse) = f
        .begin("replace", "agent.model.configure", replacement)
        .await;
    assert_eq!(
        f.answer(reverse, origin("view-one")).await.outcome,
        PluginOutcome::Succeeded
    );
    f.settle(&call, PluginOutcome::Succeeded).await;
    let reverse = f
        .begin_named_control(
            "cannot-remove-environment",
            "agent.model.key.remove",
            json!({"settings_version":2,"key_id":reference["key_id"]}),
        )
        .await;
    assert!(
        matches!(f.control_answer(reverse, origin("view-one")).await, RpcBody::Error { code, .. } if code == "conflict")
    );
    let (directory, environment) = f.release().await;
    let mut reopened = Fixture::open(directory, environment).await;
    assert_eq!(
        reopened
            .query(
                "agent.model.key.receipt",
                json!({"request_id":"key-original"})
            )
            .await,
        json!({"credential":reference,"available":false})
    );
    reopened.release().await;
}
