use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
use sha2::{Digest, Sha256};

fn upload(created: &Value, bytes: &[u8]) -> Value {
    json!({"request_id":uuid::Uuid::new_v4().to_string(),"control":control(created),"name":"完整数据.txt","mime_type":"text/plain","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})
}
async fn transfer(f: &mut Fixture, capability: &str, input: Value, view: &str) -> RpcBody {
    let request = call(
        &format!("upload-{}", uuid::Uuid::new_v4()),
        capability,
        input,
        false,
    );
    f.writer
        .send(request.request.clone(), RpcBody::Control(request.clone()))
        .await
        .unwrap();
    let reverse = f.read().await;
    assert!(
        matches!(&reverse.body, RpcBody::HostCall {capability, parent_request, ..} if capability == &manifest::key("views.caller") && parent_request == &request.request),
        "{:?}",
        reverse.body
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
    assert_eq!(reply.request, request.request);
    reply.body
}
async fn stage(f: &mut Fixture, input: &Value, offset: usize, bytes: &[u8]) -> Value {
    match transfer(
        f,
        "agent.native.assets.stage",
        json!({"upload":input,"offset":offset,"data":STANDARD.encode(bytes)}),
        "view-one",
    )
    .await
    {
        RpcBody::ControlResult { data } => data,
        other => panic!("{other:?}"),
    }
}
fn stored(f: &Fixture) -> (rho_agent_store::AgentStore, AgentTaskScope) {
    (
        rho_agent_store::AgentStore::open(
            &std::path::Path::new(&f.environment.data_root).join("agent-v1.sqlite"),
        )
        .unwrap(),
        AgentTaskScope {
            project: f.environment.project_root.clone(),
            principal: instance().principal.to_string(),
        },
    )
}
#[tokio::test]
async fn browser_attachment_stages_eight_mib_then_confirms_one_native_receipt_without_an_agent() {
    let factory = Arc::new(Factory::default());
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    let bytes = vec![b'R'; 8 * 1024 * 1024];
    let input = upload(&created, &bytes);
    for (index, part) in bytes.chunks(65536).enumerate() {
        let progress = stage(&mut f, &input, index * 65536, part).await;
        assert_eq!(progress["upload"], input);
        assert_eq!(progress["received"], (index + 1) * 65536);
    }
    {
        let (store, scope) = stored(&f);
        assert!(
            store
                .agent_receipt(&scope, input["request_id"].as_str().unwrap())
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .agent_assets(&scope, input["control"]["task_id"].as_str().unwrap())
                .unwrap()
                .is_empty()
        );
    }
    let RpcBody::ControlResult { data } = transfer(
        &mut f,
        "agent.native.assets.finish",
        json!({"upload":input}),
        "view-one",
    )
    .await
    else {
        panic!("Attachment did not finish");
    };
    assert_eq!(data["receipt"]["request_id"], input["request_id"]);
    assert_eq!(data["receipt"]["status"], "succeeded");
    assert_eq!(data["detail"]["draft"]["content"]["assets"], json!([]));
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    let (directory, environment) = f.release().await;
    let mut f = Fixture::open_with_factory(directory, environment, &[], factory.clone()).await;
    let observed = f
        .query(
            "agent.native.receipt",
            json!({"request_id":input["request_id"]}),
        )
        .await;
    assert_eq!(observed["status"], "succeeded");
    let (store, scope) = stored(&f);
    let (asset, actual) = store
        .agent_asset(
            &scope,
            input["control"]["task_id"].as_str().unwrap(),
            input["request_id"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(actual, bytes);
    assert_eq!(asset.sha256, input["sha256"].as_str().unwrap());
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    f.release().await;
}
#[tokio::test]
async fn browser_attachment_rejects_changed_chunks_controller_range_and_checksum() {
    let mut f = fixture(Arc::new(Factory::default())).await;
    let created = f.native_create().await;
    let bytes = vec![1; 65537];
    let input = upload(&created, &bytes);
    stage(&mut f, &input, 0, &bytes[..65536]).await;
    stage(&mut f, &input, 0, &bytes[..65536]).await; // Same transient chunk is idempotent.
    for (value, view) in [
        (
            json!({"upload":input,"offset":0,"data":STANDARD.encode(vec![2;65536])}),
            "view-one",
        ),
        (
            json!({"upload":input,"offset":65536,"data":"AQ=="}),
            "other-view",
        ),
        (json!({"upload":input,"offset":1,"data":"AQ=="}), "view-one"),
    ] {
        assert!(matches!(
            transfer(&mut f, "agent.native.assets.stage", value, view).await,
            RpcBody::Error { .. }
        ));
    }
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.finish",
            json!({"upload":input}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    let mut changed = input.clone();
    changed["name"] = json!("changed.txt");
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.stage",
            json!({"upload":changed,"offset":65536,"data":"AQ=="}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    stage(&mut f, &input, 65536, &[2]).await; // Complete but different content.
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.finish",
            json!({"upload":input}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    let (store, scope) = stored(&f);
    assert!(
        store
            .agent_receipt(&scope, input["request_id"].as_str().unwrap())
            .unwrap()
            .is_none()
    );
    f.release().await;
}
#[tokio::test]
async fn incomplete_browser_attachment_can_be_reselected_after_backend_reopen_without_receipt_replay()
 {
    let factory = Arc::new(Factory::default());
    let mut f = fixture(factory.clone()).await;
    let created = f.native_create().await;
    let bytes = vec![9; 65537];
    let input = upload(&created, &bytes);
    stage(&mut f, &input, 0, &bytes[..65536]).await;
    let (directory, environment) = f.release().await;
    let mut f = Fixture::open_with_factory(directory, environment, &[], factory.clone()).await;
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.finish",
            json!({"upload":input}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    for (i, part) in bytes.chunks(65536).enumerate() {
        stage(&mut f, &input, i * 65536, part).await;
    }
    let RpcBody::ControlResult { data } = transfer(
        &mut f,
        "agent.native.assets.finish",
        json!({"upload":input}),
        "view-one",
    )
    .await
    else {
        panic!("Attachment did not finish");
    };
    assert_eq!(data["receipt"]["status"], "succeeded");
    // Explicit repetition reuses the same owner request after exact reselection.
    for (i, part) in bytes.chunks(65536).enumerate() {
        stage(&mut f, &input, i * 65536, part).await;
    }
    let RpcBody::ControlResult { data } = transfer(
        &mut f,
        "agent.native.assets.finish",
        json!({"upload":input}),
        "view-one",
    )
    .await
    else {
        panic!("Original attachment was not observed");
    };
    assert_eq!(data["detail"]["assets"].as_array().unwrap().len(), 1);
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    f.release().await;
}

#[tokio::test]
async fn browser_attachment_staging_reserves_a_bounded_total_and_accepts_an_empty_file() {
    let mut f = fixture(Arc::new(Factory::default())).await;
    let created = f.native_create().await;
    let empty = upload(&created, &[]);
    assert_eq!(stage(&mut f, &empty, 0, &[]).await["complete"], true);
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.finish",
            json!({"upload":empty}),
            "view-one"
        )
        .await,
        RpcBody::ControlResult { .. }
    ));
    let part = vec![1; 65536];
    for _ in 0..4 {
        let mut input = upload(&created, &part);
        input["bytes"] = json!(8 * 1024 * 1024);
        stage(&mut f, &input, 0, &part).await;
    }
    let input = upload(&created, &[1]);
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.stage",
            json!({"upload":input,"offset":0,"data":"AQ=="}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    let mut oversized = input.clone();
    oversized["bytes"] = json!(8 * 1024 * 1024 + 1);
    assert!(matches!(
        transfer(
            &mut f,
            "agent.native.assets.stage",
            json!({"upload":oversized,"offset":0,"data":"AQ=="}),
            "view-one"
        )
        .await,
        RpcBody::Error { .. }
    ));
    f.release().await;
}
