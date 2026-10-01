use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
use sha2::{Digest, Sha256};

async fn fixture_assets(factory: Arc<Factory>, grants: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let project = root.join("project");
    let data = root.join("instance");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&data).unwrap();
    let environment = BackendEnvironment {
        project_root: project.to_str().unwrap().into(),
        data_root: data.to_str().unwrap().into(),
    };
    Fixture::open_with_factory(
        directory,
        environment,
        if grants { &["resources.read"] } else { &[] },
        factory,
    )
    .await
}
fn input(created: &Value, bytes: &[u8]) -> Value {
    json!({"request_id":uuid::Uuid::new_v4().to_string(),"control":control(created),"name":"完整数据.txt",
        "reference":{"owner":{"plugin":"org.fixture.resources","instance":"source-one","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},
        "resource":"source-resource","digest":format!("sha256:{:x}",Sha256::digest(bytes)),"bytes":bytes.len(),"media_type":"text/plain"}})
}
async fn answer(f: &mut Fixture, frame: RpcFrame, data: Value) {
    f.writer
        .send(
            frame.request,
            RpcBody::HostResult {
                result: json!({"status":"ready","completeness":"complete","data":data}),
            },
        )
        .await
        .unwrap();
}
async fn begin(f: &mut Fixture, input: &Value) -> PluginCall {
    let mut request = call(
        &format!("import-{}", uuid::Uuid::new_v4()),
        "agent.native.assets.import",
        input.clone(),
        false,
    );
    request.scopes.insert("resources.read".into());
    f.writer
        .send(request.request.clone(), RpcBody::Control(request.clone()))
        .await
        .unwrap();
    let frame = f.read().await;
    assert!(
        matches!(&frame.body, RpcBody::HostCall {capability,..} if capability==&manifest::key("views.caller")),
        "{:?}",
        frame.body
    );
    answer(f, frame, origin("view-one")).await;
    request
}
fn chunk(frame: &RpcFrame, input: &Value, bytes: &[u8]) -> Value {
    let RpcBody::HostCall {
        capability,
        arguments,
        ..
    } = &frame.body
    else {
        panic!("{:?}", frame.body)
    };
    assert_eq!(capability, &manifest::key("resources.read"));
    let read: ResourceRead = serde_json::from_value(arguments.clone()).unwrap();
    assert_eq!(json!(read.reference), input["reference"]);
    assert_eq!(read.limit, MAX_RESOURCE_READ_BYTES);
    let start = read.offset as usize;
    let end = (start + read.limit as usize).min(bytes.len());
    json!({"reference":read.reference,"offset":start,"base64":STANDARD.encode(&bytes[start..end]),"next":(end<bytes.len()).then_some(end)})
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
async fn resource_asset_imports_full_eight_mib_and_retries_without_source_or_native_start_after_reopen()
 {
    let factory = Arc::new(Factory::default());
    let mut f = fixture_assets(factory.clone(), true).await;
    let created = f.native_create().await;
    let bytes = vec![b'R'; 8 * 1024 * 1024];
    let input = input(&created, &bytes);
    let original = begin(&mut f, &input).await;
    let mut chunks = 0;
    loop {
        let frame = f.read().await;
        assert!(
            matches!(&frame.body,RpcBody::HostCall {parent_request,..} if parent_request==&original.request)
        );
        if matches!(&frame.body,RpcBody::HostCall {capability,..} if capability==&manifest::key("views.caller"))
        {
            answer(&mut f, frame, origin("view-one")).await;
            break;
        }
        let data = chunk(&frame, &input, &bytes);
        answer(&mut f, frame, data).await;
        chunks += 1;
    }
    assert_eq!(chunks, 32);
    // Simulate losing the successful reply at the observer, then reconnecting.
    let reply = f.read().await;
    assert_eq!(reply.request, original.request);
    let RpcBody::ControlResult { data } = reply.body else {
        panic!("{:?}", reply.body)
    };
    assert_eq!(data["receipt"]["status"], "succeeded");
    assert_eq!(data["detail"]["assets"][0]["bytes"], bytes.len());
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    {
        let (store, scope) = stored(&f);
        let (asset, actual) = store
            .agent_asset(
                &scope,
                input["control"]["task_id"].as_str().unwrap(),
                input["request_id"].as_str().unwrap(),
            )
            .unwrap();
        assert_eq!(asset.bytes, bytes.len() as u64);
        assert!(actual == bytes);
        let capture = store
            .agent_asset_import(&scope, input["request_id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(serde_json::to_vec(&capture).unwrap().len() < 2048);
        assert!(
            store
                .agent_native_admission(&scope, input["request_id"].as_str().unwrap())
                .unwrap()
                .is_none()
        );
    }
    let (directory, environment) = f.release().await;
    let reopened_factory = Arc::new(Factory::default());
    let mut f = Fixture::open_with_factory(
        directory,
        environment,
        &["resources.read"],
        reopened_factory.clone(),
    )
    .await;
    let repeat = begin(&mut f, &input).await;
    let reply = f.read().await;
    assert_eq!(reply.request, repeat.request);
    let RpcBody::ControlResult { data: observed } = reply.body else {
        panic!(
            "No resource read or native command is allowed: {:?}",
            reply.body
        )
    };
    assert_eq!(observed["receipt"], data["receipt"]);
    assert_eq!(observed["detail"]["assets"].as_array().unwrap().len(), 1);
    assert_eq!(reopened_factory.opens.load(Ordering::SeqCst), 0);
    let mut changed = input.clone();
    changed["reference"]["owner"]["instance"] = "substituted-owner".into();
    begin(&mut f, &changed).await;
    assert!(matches!(f.read().await.body,RpcBody::Error {code,..} if code=="request_conflict"));
    f.release().await;
}
#[tokio::test]
async fn resource_asset_refuses_malformed_partial_substituted_and_changed_caller_without_admission()
{
    let factory = Arc::new(Factory::default());
    let mut f = fixture_assets(factory.clone(), true).await;
    let created = f.native_create().await;
    for fault in [
        "offset",
        "next",
        "reference",
        "length",
        "base64",
        "digest",
        "partial",
        "cached",
        "caller",
    ] {
        let bytes = b"Original bytes";
        let mut input = input(&created, bytes);
        if fault == "digest" {
            input["reference"]["digest"] = format!("sha256:{}", "0".repeat(64)).into();
        }
        begin(&mut f, &input).await;
        let frame = f.read().await;
        let mut data = chunk(&frame, &input, bytes);
        match fault {
            "offset" => data["offset"] = 1.into(),
            "next" => data["next"] = 1.into(),
            "reference" => data["reference"]["owner"]["instance"] = "different-owner".into(),
            "length" => data["base64"] = STANDARD.encode(b"short").into(),
            "base64" => data["base64"] = "!".into(),
            _ => {}
        }
        if ["partial", "cached"].contains(&fault) {
            f.writer.send(frame.request,RpcBody::HostResult {result:json!({"status":if fault=="cached" {"cached"} else {"ready"},"completeness":if fault=="partial" {"partial"} else {"complete"},"data":data})}).await.unwrap();
        } else {
            answer(&mut f, frame, data).await;
        }
        if ["digest", "caller"].contains(&fault) {
            let frame = f.read().await;
            assert!(
                matches!(&frame.body,RpcBody::HostCall {capability,..} if capability==&manifest::key("views.caller"))
            );
            answer(
                &mut f,
                frame,
                origin(if fault == "caller" {
                    "replacement-view"
                } else {
                    "view-one"
                }),
            )
            .await;
        }
        assert!(
            matches!(f.read().await.body, RpcBody::Error { .. }),
            "fault {fault}"
        );
        let (store, scope) = stored(&f);
        assert!(
            store
                .agent_receipt(&scope, input["request_id"].as_str().unwrap())
                .unwrap()
                .is_none(),
            "fault {fault}"
        );
        assert!(
            store
                .agent_assets(&scope, input["control"]["task_id"].as_str().unwrap())
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    f.release().await;
}
#[tokio::test]
async fn resource_asset_requires_optional_grant_and_task_control_before_reading() {
    let factory = Arc::new(Factory::default());
    let mut f = fixture_assets(factory.clone(), false).await;
    let created = f.native_create().await;
    let input = input(&created, b"bytes");
    begin(&mut f, &input).await;
    assert!(matches!(f.read().await.body,RpcBody::Error {code,..} if code=="access_denied"));
    let (directory, environment) = f.release().await;
    let mut f =
        Fixture::open_with_factory(directory, environment, &["resources.read"], factory).await;
    let mut stale = input.clone();
    stale["control"]["generation"] = 999.into();
    begin(&mut f, &stale).await;
    assert!(matches!(f.read().await.body,RpcBody::Error {code,..} if code=="conflict"));
    let mut oversized = input.clone();
    oversized["reference"]["bytes"] = (8 * 1024 * 1024 + 1).into();
    begin(&mut f, &oversized).await;
    assert!(matches!(f.read().await.body,RpcBody::Error {code,..} if code=="invalid_input"));
    f.release().await;
}

#[tokio::test]
async fn resource_asset_empty_files_are_verified_and_prepared_imports_are_never_replayed() {
    let factory = Arc::new(Factory::default());
    let mut f = fixture_assets(factory.clone(), true).await;
    let created = f.native_create().await;
    let empty = input(&created, b"");
    begin(&mut f, &empty).await;
    let frame = f.read().await;
    let data = chunk(&frame, &empty, b"");
    answer(&mut f, frame, data).await;
    let frame = f.read().await;
    answer(&mut f, frame, origin("view-one")).await;
    assert!(
        matches!(f.read().await.body, RpcBody::ControlResult {data} if data["detail"]["assets"][0]["bytes"] == 0)
    );
    let pending = input(&created, b"original unconfirmed file");
    {
        let (store, scope) = stored(&f);
        let owner = rho_agent_owner::AgentTaskOwner::new(Arc::new(store));
        let controller: AgentControllerRef = serde_json::from_value(
            created["detail"]["summary"]["attachment"]["controller"].clone(),
        )
        .unwrap();
        let (_, admitted) = owner
            .admit_asset_import(
                &scope,
                serde_json::from_value(pending.clone()).unwrap(),
                controller,
                b"original unconfirmed file",
                100,
            )
            .unwrap();
        assert!(admitted.native);
        assert_eq!(admitted.receipt.status, "prepared");
        // Stop before runtime admission, preserving uncertainty for the next process.
    }
    let (directory, environment) = f.release().await;
    let mut f =
        Fixture::open_with_factory(directory, environment, &["resources.read"], factory.clone())
            .await;
    begin(&mut f, &pending).await;
    assert!(
        matches!(f.read().await.body, RpcBody::Error {code, ..} if code == "native_outcome_uncertain")
    );
    let receipt = f
        .query(
            "agent.native.receipt",
            json!({"request_id":pending["request_id"]}),
        )
        .await;
    assert_eq!(receipt["status"], "uncertain");
    let (store, scope) = stored(&f);
    assert_eq!(
        store
            .agent_assets(&scope, pending["control"]["task_id"].as_str().unwrap())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .agent_receipt(&scope, pending["request_id"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .status,
        "prepared"
    );
    assert_eq!(factory.opens.load(Ordering::SeqCst), 0);
    f.release().await;
}
