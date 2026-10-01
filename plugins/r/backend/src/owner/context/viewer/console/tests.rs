use super::super::super::tests::fixture;
use super::*;
fn record(owner: &InstanceRef) -> Value {
    json!({"operation":{"operation_id":"original","capability":{"id":"r.execute","version":2},"normalized_arguments":{"binding":{"provider":owner},"arguments":{"expected_session":"native","run":{"code":"cat('中文')"}}}},"status":"succeeded","output":{"operation_id":"original","session_id":"native","events":{"owner":owner,"resource":"events","digest":format!("sha256:{}","a".repeat(64)),"bytes":100,"media_type":"application/json"}}})
}
#[test]
fn original_console_requires_terminal_owner_session_and_event_identity() {
    let (_dir, owner, _, _) = fixture();
    let value = record(&owner.instance);
    let id = OperationId::new("original").unwrap();
    assert!(original(&owner.instance, &id, &value).unwrap().is_some());
    for change in ["id", "session", "event_owner", "media"] {
        let mut bad = value.clone();
        match change {
            "id" => bad["output"]["operation_id"] = json!("another"),
            "session" => bad["output"]["session_id"] = json!("another"),
            "event_owner" => bad["output"]["events"]["owner"]["instance"] = json!("another"),
            _ => bad["output"]["events"]["media_type"] = json!("text/html"),
        }
        assert!(original(&owner.instance, &id, &bad).is_err(), "{change}");
    }
    let mut live = value.clone();
    live["status"] = json!("running");
    assert!(original(&owner.instance, &id, &live).unwrap().is_none());
    let mut foreign = value;
    foreign["operation"]["normalized_arguments"]["binding"]["provider"]["instance"] =
        json!("another");
    assert!(original(&owner.instance, &id, &foreign).unwrap().is_none());
    assert!(decode::<Inclusion>(json!({"kind":"code","execute":true})).is_err());
}
#[test]
fn transcript_checks_digest_partial_flags_and_event_order() {
    let (_dir, owner, _, _) = fixture();
    let (mut source, _, _) = original(
        &owner.instance,
        &OperationId::new("original").unwrap(),
        &record(&owner.instance),
    )
    .unwrap()
    .unwrap();
    let page = json!({"operation_id":"original","events":[{"operation_id":"original","sequence":1,"kind":"stdout","text":"中文🙂","media":null,"observed_at_ms":0}],"next_sequence":1,"has_more":false,"truncated":false,"gap":false,"notices":[]});
    let encode = |source: &mut ConsoleSource, page: &Value| {
        let bytes = serde_json::to_vec(page).unwrap();
        source.events.bytes = bytes.len() as u64;
        source.events.digest =
            decode(json!(format!("sha256:{:x}", Sha256::digest(&bytes)))).unwrap();
        bytes
    };
    let bytes = encode(&mut source, &page);
    assert!(transcript(&source, &bytes).unwrap().contains("中文🙂"));
    assert!(transcript(&source, b"changed").is_err());
    for change in [
        "gap",
        "has_more",
        "truncated",
        "notices",
        "operation",
        "sequence",
        "order",
    ] {
        let mut bad = page.clone();
        match change {
            "notices" => bad["notices"] = json!(["partial"]),
            "operation" => bad["events"][0]["operation_id"] = json!("other"),
            "sequence" => bad["events"][0]["sequence"] = json!(2),
            "order" => {
                let event = bad["events"][0].clone();
                bad["events"].as_array_mut().unwrap().push(event);
            }
            key => bad[key] = json!(true),
        }
        let bytes = encode(&mut source, &bad);
        assert!(transcript(&source, &bytes).is_err(), "{change}");
    }
}
#[tokio::test]
async fn console_code_preview_rechecks_original_without_runtime_or_resource_reads() {
    let (_dir, owner, mut call, mut host) = fixture();
    let value = record(&owner.instance);
    let (source, code, status) = original(
        &owner.instance,
        &OperationId::new("original").unwrap(),
        &value,
    )
    .unwrap()
    .unwrap();
    let reference = source
        .item(
            &owner.instance,
            &WindowId::new("window").unwrap(),
            &code,
            &status,
        )
        .unwrap()
        .reference;
    call.binding.capability = environment_binding::key(PREVIEW, 1);
    call.arguments = json!({"reference":reference,"inclusion":{"kind":"code"},"max_bytes":16384});
    let (reply, ()) = tokio::join!(owner.query(&call), async {
        let request = host.recv().await.unwrap();
        assert_eq!(request.capability.id.as_str(), "operation.get");
        request
            .reply
            .send(Ok(
                json!({"status":"ready","completeness":"complete","data":{"record":value}}),
            ))
            .unwrap();
    });
    let preview: ContextPreview = decode(reply.unwrap()).unwrap();
    assert!(preview.text.contains("cat('中文')"));
    assert!(!preview.truncated);
    assert_eq!(
        preview.data["annotation_source"]["source_id"],
        "run:original"
    );
    assert_eq!(
        preview.data["annotation_source"]["source_version"],
        format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([code, status, null, source.events.digest])).unwrap()
            )
        )
    );
    assert_eq!(preview.item.reference, reference);
    assert!(owner.runtime.lock().unwrap().is_none());
    assert!(host.try_recv().is_err());
}
