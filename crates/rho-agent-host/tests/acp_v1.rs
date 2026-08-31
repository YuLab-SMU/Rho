use rho_agent_host::protocol::acp::v1::*;
use serde_json::json;

#[test]
fn acp_v1_golden_transcript_replays_offline_to_neutral_events() {
    let transcript = include_bytes!("transcripts/acp-v1-valid.jsonl");
    let mut codec = AcpV1Codec::new();
    codec.feed(transcript).unwrap();
    codec.finish().unwrap();
    let mut events = Vec::new();
    while let Some(event) = codec.pop_event() {
        events.push(event);
    }
    assert_eq!(events.len(), 6);
    assert!(matches!(events[0], NeutralAcpEvent::Initialized { .. }));
    assert!(matches!(events[1], NeutralAcpEvent::SessionCreated { .. }));
    assert!(matches!(events[2], NeutralAcpEvent::MessageDelta { .. }));
    assert!(matches!(events[3], NeutralAcpEvent::PlanReplaced { .. }));
    assert!(matches!(events[4], NeutralAcpEvent::ToolRequested { .. }));
    assert!(matches!(events[5], NeutralAcpEvent::Terminal { .. }));
    assert_eq!(codec.negotiated().unwrap().protocol, ACP_V1_PROTOCOL);
    assert_eq!(ACP_SDK_PIN, "agent-client-protocol@0.8.1");
}

#[test]
fn acp_v1_partial_frames_are_buffered_and_incomplete_finish_fails_closed() {
    let transcript = include_bytes!("transcripts/acp-v1-valid.jsonl");
    let split = transcript.len() / 3;
    let mut codec = AcpV1Codec::new();
    codec.feed(&transcript[..split]).unwrap();
    codec.feed(&transcript[split..split * 2]).unwrap();
    codec.feed(&transcript[split * 2..]).unwrap();
    codec.finish().unwrap();

    let mut incomplete = AcpV1Codec::new();
    incomplete.feed(b"{\"jsonrpc\":\"2.0\"").unwrap();
    assert_eq!(incomplete.finish().unwrap_err(), AcpV1CodecError::Malformed);
}

#[test]
fn acp_v1_unknown_extension_is_bounded_and_does_not_retain_raw_payload() {
    let transcript = include_bytes!("transcripts/acp-v1-extension.jsonl");
    let mut codec = AcpV1Codec::new();
    codec.feed(transcript).unwrap();
    let event = codec.pop_event().unwrap();
    let encoded = serde_json::to_string(&event).unwrap();
    assert!(encoded.contains("unsupported_extension"));
    assert!(!encoded.contains("CANARY_RAW_EXTENSION_PAYLOAD"));
    assert!(encoded.len() <= MAX_ACP_DIAGNOSTIC_BYTES + 256);
}

#[test]
fn acp_v1_rejects_malformed_oversized_deep_and_draft_v2_frames() {
    let mut codec = AcpV1Codec::new();
    assert_eq!(
        codec.feed(b"not-json\n").unwrap_err(),
        AcpV1CodecError::Malformed
    );

    let mut oversized = AcpV1Codec::new();
    assert_eq!(
        oversized
            .feed(&vec![b'x'; MAX_ACP_FRAME_BYTES + 1])
            .unwrap_err(),
        AcpV1CodecError::PartialFrameTooLarge
    );

    let mut deep = json!(null);
    for _ in 0..=MAX_ACP_DEPTH {
        deep = json!({"x": deep});
    }
    let mut deep_frame = serde_json::to_vec(&json!({
        "jsonrpc":"2.0", "method":"session/update", "params": deep
    }))
    .unwrap();
    deep_frame.push(b'\n');
    assert_eq!(
        AcpV1Codec::new().feed(&deep_frame).unwrap_err(),
        AcpV1CodecError::JsonBounds
    );

    let v2 = b"{\"jsonrpc\":\"2.0\",\"method\":\"initialized\",\"params\":{\"protocolVersion\":\"2-draft\"}}\n";
    assert_eq!(
        AcpV1Codec::new().feed(v2).unwrap_err(),
        AcpV1CodecError::UnsupportedProtocol("2-draft".to_string())
    );
}

#[test]
fn acp_v1_rejects_duplicate_ids_and_out_of_order_responses() {
    let duplicate = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":\"same\",\"method\":\"session/created\",\"params\":{\"sessionId\":\"a\"}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":\"same\",\"method\":\"session/closed\",\"params\":{\"sessionId\":\"a\"}}\n"
    );
    assert_eq!(
        AcpV1Codec::new().feed(duplicate.as_bytes()).unwrap_err(),
        AcpV1CodecError::DuplicateId
    );

    let mut codec = AcpV1Codec::new();
    codec
        .encode_request("request_1", "initialize", json!({}))
        .unwrap();
    codec
        .encode_request("request_2", "session/new", json!({}))
        .unwrap();
    assert_eq!(
        codec
            .feed(b"{\"jsonrpc\":\"2.0\",\"id\":\"request_2\",\"result\":{}}\n")
            .unwrap_err(),
        AcpV1CodecError::OutOfOrderResponse
    );
}

#[test]
fn acp_v1_queue_and_string_bounds_fail_closed() {
    let huge = "x".repeat(MAX_ACP_STRING_BYTES + 1);
    let mut frame = serde_json::to_vec(&json!({
        "jsonrpc":"2.0", "method":"session/update",
        "params":{"updateType":"message_delta", "text": huge}
    }))
    .unwrap();
    frame.push(b'\n');
    assert_eq!(
        AcpV1Codec::new().feed(&frame).unwrap_err(),
        AcpV1CodecError::JsonBounds
    );

    let mut many = Vec::new();
    for index in 0..=MAX_ACP_QUEUE {
        many.extend_from_slice(
            format!("{{\"jsonrpc\":\"2.0\",\"method\":\"vendor/{index}\",\"params\":{{}}}}\n")
                .as_bytes(),
        );
    }
    assert_eq!(
        AcpV1Codec::new().feed(&many).unwrap_err(),
        AcpV1CodecError::QueueOverflow
    );
}

#[test]
fn acp_v1_wire_dtos_are_private_and_codec_boundary_isolated() {
    let source = include_str!("../src/protocol/acp/v1/mod.rs");
    assert!(source.contains("struct WireMessage"));
    assert!(!source.contains("pub struct WireMessage"));
    assert!(!source.contains("pub enum Wire"));
    let (_, does_not_own) = codec_boundary();
    assert!(does_not_own.contains(&"ui_dto"));
    assert!(does_not_own.contains(&"store_dto"));
    assert!(does_not_own.contains(&"draft_v2_semantics"));
}
