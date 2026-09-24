//! Real Console protocol through the unchanged generic Host ports.
use super::*;

async fn read(
    host: &NextHost,
    owner: &InstanceRef,
    capability: &str,
    arguments: Value,
) -> Result<QuerySnapshot, rho_operation::OperationError> {
    host.query_snapshot(&NextHost::local_context(), QueryRequest {
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments: json!({"binding":binding(host,owner,capability).await,"arguments":arguments}),
    }).await
}
pub async fn unstarted(host: &NextHost, owner: &InstanceRef) {
    for (capability, arguments) in [
        (
            "r.check_code",
            json!({"expected_session":"absent","code":"1"}),
        ),
        (
            "r.output_events",
            json!({"expected_session":"absent","operation_id":"absent","limit":1}),
        ),
    ] {
        assert!(read(host, owner, capability, arguments).await.is_err());
    }
    assert_eq!(
        native_query(host, owner, "r.session", json!({})).await["state"],
        "unstarted"
    );
}

pub async fn exercise(
    host: &Arc<NextHost>,
    owner: &InstanceRef,
    session: &Value,
    other: &InstanceRef,
    other_session: &Value,
) {
    queue::wait(host, owner, session, |value| {
        value["awaiting_commit"] == json!([])
    })
    .await;
    for (code, status) in [
        ("console_not_evaluated <- 42", "complete"),
        ("if (TRUE) {", "incomplete"),
    ] {
        let checked = read(
            host,
            owner,
            "r.check_code",
            json!({"expected_session":session,"code":code}),
        )
        .await
        .unwrap();
        assert_eq!(checked.data.unwrap()["status"], status);
    }
    assert!(
        read(
            host,
            owner,
            "r.check_code",
            json!({"expected_session":other_session,"code":"1"})
        )
        .await
        .is_err()
    );
    let scope = native_query(
        host,
        owner,
        "r.snapshot",
        json!({"expected_session":session,"limit":100}),
    )
    .await;
    assert!(
        !scope["data"]["objects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|object| object["name"] == "console_not_evaluated")
    );

    let binding = query(
        host,
        "plugins.resolve",
        json!({"instance":owner,"capability":{"id":"r.execute","version":2}}),
    )
    .await;
    let source = json!({"view_id":"document:console-protocol","label":"分析.R","kind":"selection"});
    let mut request = invocation(
        "console-versioned",
        "r.execute",
        json!({"binding":binding,"arguments":{"expected_session":session,
        "run":{"code":"cat('stream 中文\\n'); flush.console(); console_reply <- readline('Console protocol: '); 11; 22","output_mode":"console","source":source}}}),
    );
    request.capability.version = 2;
    let mut oversized = request.clone();
    oversized.client_request_id = "console-oversized".into();
    oversized.arguments["arguments"]["run"]["code"] = json!("中".repeat(100000));
    assert!(
        host.invoke(&NextHost::local_context(), oversized)
            .await
            .is_err(),
        "byte validation precedes native admission"
    );
    queue::control(host, owner, session, true, Value::Null, Value::Null)
        .await
        .unwrap();
    let running = queue::start(host, request.clone());
    let waiting = queue::wait(host, owner, session, |value| {
        value["console"]["pending"].as_array().unwrap().len() == 1
    })
    .await;
    let id: OperationId =
        serde_json::from_value(waiting["console"]["pending"][0]["operation_id"].clone()).unwrap();
    assert_eq!(waiting["console"]["pending"][0]["source"], source);

    let mut cancelled = request.clone();
    cancelled.client_request_id = "console-versioned-pending-cancel".into();
    cancelled.arguments["arguments"]["run"]["code"] =
        json!("stop('cancelled input must never run')");
    let cancelling = queue::start(host, cancelled);
    let pending = queue::wait(host, owner, session, |value| {
        value["console"]["pending"].as_array().unwrap().len() == 2
    })
    .await;
    let cancel_id: OperationId =
        serde_json::from_value(pending["console"]["pending"][1]["operation_id"].clone()).unwrap();
    assert!(
        host.request_cancellation(&NextHost::local_context(), &cancel_id)
            .await
            .unwrap()
            .accepted
    );
    let cancelled = queue::completed(cancelling).await;
    assert_eq!(
        cancelled.status,
        OperationStatus::Cancelled,
        "{cancelled:?}"
    );
    assert_eq!(
        cancelled.output.unwrap(),
        json!({"operation_id":cancel_id,"started":false})
    );
    queue::resume(host, owner, session, json!([id, cancel_id])).await;

    let waiting = queue::wait(host, owner, session, |value| {
        !value["console"]["input"].is_null()
    })
    .await;
    assert_eq!(waiting["console"]["current"]["source"], source);
    let input = waiting["console"]["input"].clone();
    assert_eq!(input["operation_id"], json!(id));
    assert!(
        read(
            host,
            owner,
            "r.check_code",
            json!({"expected_session":session,"code":"1"})
        )
        .await
        .is_err(),
        "busy code checks never compete with stdin"
    );
    let mut cursor = 0;
    let mut live_text = String::new();
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut interval = tokio::time::interval(Duration::from_millis(30));
        loop {
            interval.tick().await;
            let observed = read(
            host,
            owner,
            "r.output_events",
            json!({"expected_session":session,"operation_id":id,"after_sequence":cursor,"limit":1}),
        )
        .await
        .unwrap();
            assert_eq!(observed.completeness, ObservationCompleteness::Partial);
            let data = observed.data.unwrap();
            assert_eq!(data["session_id"], *session);
            let events = &data["output"];
            assert_eq!(events["operation_id"], json!(id));
            for event in events["events"].as_array().unwrap() {
                assert_eq!(event["operation_id"], json!(id));
                assert!(event["sequence"].as_u64().unwrap() > cursor);
                if let Some(text) = event["text"].as_str() {
                    live_text.push_str(text);
                }
            }
            cursor = events["next_sequence"].as_u64().unwrap();
            if live_text.contains("stream 中文") {
                break;
            }
        }
    })
    .await
    .expect("original live output did not arrive while stdin remained pending");
    assert!(live_text.contains("stream 中文"), "{live_text}");
    let original = host
        .invoke(&NextHost::local_context(), request.clone())
        .await
        .unwrap();
    assert_eq!(original.status, OperationStatus::Running);
    assert_eq!(original.operation.operation_id, id);
    assert!(
        read(
            host,
            other,
            "r.output_events",
            json!({"expected_session":other_session,"operation_id":id})
        )
        .await
        .is_err(),
        "another instance cannot read this original log"
    );
    assert!(
        read(
            host,
            owner,
            "r.output_events",
            json!({"expected_session":other_session,"operation_id":id})
        )
        .await
        .is_err()
    );
    let mut answer_binding = super::binding(host, owner, "r.respond_input").await;
    answer_binding["target"] = session.clone();
    host.dispatch(&NextHost::local_context(),HostRequest::Control(ControlRequest{
        capability:CapabilityRef::new("r.respond_input",1).unwrap(),arguments:json!({"binding":answer_binding,"arguments":{
            "session_id":session,"operation_id":id,"request_id":input["request_id"],"reply_id":"console-versioned-answer","value":"αβ"}}),
    })).await.unwrap();
    let completed = queue::completed(running).await;
    assert_eq!(
        completed.status,
        OperationStatus::Succeeded,
        "{completed:?}"
    );
    let output = completed.output.as_ref().unwrap();
    assert_eq!(output["source"], source);
    assert_eq!(output["output_mode"], "console");
    assert!(
        output["value"].is_null(),
        "Console prints visible expressions instead of returning a duplicate value"
    );
    assert!(output["stdout"].as_str().unwrap().contains("[1] 11"));
    assert!(output["stdout"].as_str().unwrap().contains("[1] 22"));
    assert_eq!(
        completed.operation.normalized_arguments["arguments"]["run"]["source"],
        source
    );
    assert_eq!(
        host.invoke(&NextHost::local_context(), request)
            .await
            .unwrap()
            .operation
            .operation_id,
        id
    );
    let future = read(
        host,
        owner,
        "r.output_events",
        json!({"expected_session":session,"operation_id":id,"after_sequence":u32::MAX,"limit":1}),
    )
    .await
    .unwrap();
    assert_eq!(future.data.unwrap()["output"]["gap"], true);
    queue::wait(host, owner, session, |value| {
        value["awaiting_commit"] == json!([])
    })
    .await;
}
