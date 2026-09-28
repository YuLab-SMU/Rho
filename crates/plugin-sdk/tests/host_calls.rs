use rho_plugin_sdk::{protocol::*, *};
use serde_json::json;
use tokio::io::duplex;

fn id(value: &str) -> RequestId {
    RequestId::new(value).unwrap()
}
fn capability() -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new("source.read").unwrap(),
        version: 1,
    }
}
fn begin(client: &HostCallClient, request: &str) -> PendingHostCall {
    client
        .begin(
            id(request),
            id("original-parent"),
            capability(),
            json!({"selector": request}),
        )
        .unwrap()
}

#[tokio::test]
async fn replies_are_correlated_when_owner_callbacks_complete_out_of_order() {
    let (client, mut pump) = host_call_channel(2).unwrap();
    let first = begin(&client, "first");
    let second = begin(&client.clone(), "second");
    assert_eq!(first.request(), &id("first"));
    for name in ["first", "second"] {
        let outgoing = pump.next().await.unwrap();
        assert_eq!(outgoing.request, id(name));
        assert_eq!(
            outgoing.body,
            RpcBody::HostCall {
                parent_request: id("original-parent"),
                capability: capability(),
                arguments: json!({"selector":name})
            }
        );
    }
    pump.respond(&id("second"), RpcBody::HostResult { result: json!(2) })
        .unwrap();
    pump.respond(&id("first"), RpcBody::HostResult { result: json!(1) })
        .unwrap();
    assert_eq!(first.receive().await.unwrap(), json!(1));
    assert_eq!(second.receive().await.unwrap(), json!(2));
    assert_eq!(pump.pending(), 0);
}

#[tokio::test]
async fn abandoned_waits_retain_the_original_slot_until_a_reply_without_resending() {
    let (client, mut pump) = host_call_channel(1).unwrap();
    drop(begin(&client, "original-tool"));
    let request = pump.next().await.unwrap();
    assert!(
        client
            .begin(
                id("original-tool"),
                id("original-parent"),
                capability(),
                json!({})
            )
            .is_err()
    );
    assert!(
        client
            .begin(
                id("other-tool"),
                id("original-parent"),
                capability(),
                json!({})
            )
            .is_err()
    );
    assert_eq!(pump.pending(), 1);
    pump.respond(
        &request.request,
        RpcBody::HostResult {
            result: json!({"operation_id":"original-science-operation"}),
        },
    )
    .unwrap();
    assert_eq!(pump.pending(), 0);
    let next = begin(&client, "next-tool");
    assert_eq!(pump.next().await.unwrap().request, id("next-tool"));
    // Exactly the new request is queued; neither abandoned call nor acknowledgement is replayed.
    assert_eq!(pump.pending(), 1);
    pump.close();
    assert!(pump.next().await.is_none());
    assert!(matches!(
        next.receive().await,
        Err(HostCallError::Unconfirmed)
    ));
}

#[tokio::test]
async fn closing_or_dropping_the_pump_wakes_both_queued_and_dispatched_waiters() {
    for explicit in [true, false] {
        let (client, mut pump) = host_call_channel(2).unwrap();
        let sent = begin(&client, "sent");
        pump.next().await.unwrap();
        let queued = begin(&client, "queued");
        if explicit {
            pump.close();
        }
        drop(pump);
        assert!(matches!(
            sent.receive().await,
            Err(HostCallError::Unconfirmed)
        ));
        assert!(matches!(
            queued.receive().await,
            Err(HostCallError::Unconfirmed)
        ));
        assert!(
            client
                .begin(id("new"), id("parent"), capability(), json!({}))
                .is_err()
        );
    }
}

#[tokio::test]
async fn structured_rejections_retain_recovery_without_exposing_it_in_debug() {
    let (client, mut pump) = host_call_channel(1).unwrap();
    let pending = begin(&client, "inspect");
    pump.next().await.unwrap();
    let recovery =
        json!({"operation_id":"original-operation", "private_material":"private-recovery"});
    pump.respond(
        &id("inspect"),
        RpcBody::Error {
            code: "outcome_uncertain".into(),
            message: "Inspect original work".into(),
            recovery: Some(recovery.clone()),
        },
    )
    .unwrap();
    let error = pending.receive().await.unwrap_err();
    assert!(!format!("{error:?}").contains("private-recovery"));
    match error {
        HostCallError::Rejected {
            code,
            message,
            recovery: observed,
        } => {
            assert_eq!(code, "outcome_uncertain");
            assert_eq!(message, "Inspect original work");
            assert_eq!(observed, Some(recovery));
        }
        _ => panic!("a Host rejection was replaced with disconnect"),
    }
}

#[tokio::test]
async fn wrong_or_duplicate_reply_cannot_consume_another_original_call() {
    let (client, mut pump) = host_call_channel(1).unwrap();
    let pending = begin(&client, "original");
    assert!(
        pump.respond(
            &id("original"),
            RpcBody::HostResult {
                result: json!(false)
            }
        )
        .is_err()
    );
    assert!(pump.contains(&id("original")));
    pump.next().await.unwrap();
    assert!(
        pump.respond(
            &id("other"),
            RpcBody::HostResult {
                result: json!(false)
            }
        )
        .is_err()
    );
    assert!(pump.respond(&id("original"), RpcBody::Released).is_err());
    assert!(pump.contains(&id("original")));
    pump.respond(
        &id("original"),
        RpcBody::HostResult {
            result: json!(true),
        },
    )
    .unwrap();
    assert!(
        pump.respond(
            &id("original"),
            RpcBody::HostResult {
                result: json!(false)
            }
        )
        .is_err()
    );
    assert_eq!(pending.receive().await.unwrap(), json!(true));
}

#[tokio::test]
async fn admission_limits_do_not_leave_partial_requests_in_the_queue() {
    assert!(host_call_channel(0).is_err());
    assert!(host_call_channel(MAX_PENDING_HOST_CALLS + 1).is_err());
    let (client, mut pump) = host_call_channel(1).unwrap();
    assert!(
        client
            .begin(id("same"), id("same"), capability(), json!({}))
            .is_err()
    );
    assert!(
        client
            .begin(
                id("large"),
                id("parent"),
                capability(),
                json!("x".repeat(MAX_HOST_CALL_ARGUMENT_BYTES))
            )
            .is_err()
    );
    assert_eq!(pump.pending(), 0);
    let original = begin(&client, "first");
    assert!(
        client
            .begin(id("overflow"), id("parent"), capability(), json!({}))
            .is_err()
    );
    assert_eq!(pump.next().await.unwrap().request, id("first"));
    pump.close();
    assert!(pump.next().await.is_none());
    assert!(matches!(
        original.receive().await,
        Err(HostCallError::Unconfirmed)
    ));
}

#[tokio::test]
async fn original_ids_survive_real_framed_exchange_with_a_concurrent_reader() {
    let instance = PluginInstanceId::new("provider").unwrap();
    let connection = ConnectionId::new("connection").unwrap();
    let (output, input) = duplex(128);
    let (reply_output, reply_input) = duplex(128);
    let mut writer = RpcWriter::new(output, instance.clone(), connection.clone());
    let mut host_reader = RpcReader::new(input, instance.clone(), connection.clone());
    let mut host_writer = RpcWriter::new(reply_output, instance.clone(), connection.clone());
    let mut reader = RpcReader::new(reply_input, instance, connection);
    let host = tokio::spawn(async move {
        let call = host_reader.receive().await.unwrap().unwrap();
        assert_eq!(call.request, id("saved-tool-id"));
        assert!(
            matches!(call.body, RpcBody::HostCall { parent_request, .. } if parent_request == id("original-parent"))
        );
        host_writer
            .send(
                call.request,
                RpcBody::HostResult {
                    result: json!({"operation_id":"original-science-operation"}),
                },
            )
            .await
            .unwrap();
    });
    let reading = tokio::spawn(async move { reader.receive().await.unwrap().unwrap() });
    let (client, mut pump) = host_call_channel(1).unwrap();
    let pending = begin(&client, "saved-tool-id");
    let outgoing = pump.next().await.unwrap();
    writer.send(outgoing.request, outgoing.body).await.unwrap();
    let reply = reading.await.unwrap();
    pump.respond(&reply.request, reply.body).unwrap();
    assert_eq!(
        pending.receive().await.unwrap()["operation_id"],
        "original-science-operation"
    );
    host.await.unwrap();
}
