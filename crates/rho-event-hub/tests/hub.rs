use rho_event_hub::*;
use rho_protocol::*;

fn actor() -> Actor {
    Actor {
        kind: ActorKind::AgentProvider,
        id: "provider".to_string(),
    }
}

fn metadata(seq: u64) -> EventEnvelopeMetadata {
    EventEnvelopeMetadata::new(
        EventId::new(format!("event_hot_{seq}")).unwrap(),
        StreamId::new("stream_hot").unwrap(),
        StreamSeq(seq),
        actor(),
        CorrelationId::new("correlation_hot").unwrap(),
        TraceId::new("trace_hot").unwrap(),
    )
}

fn hot(seq: u64, payload: HotEventPayload) -> HotEvent {
    HotEvent::new(metadata(seq), payload).unwrap()
}

fn session(name: &str) -> SessionId {
    SessionId::new(format!("session_{name}")).unwrap()
}

#[test]
fn text_delta_coalesces_by_turn_and_uses_monotonic_hot_cursor() {
    let mut hub = HotEventHub::new(4096, 8192).unwrap();
    let session = session("main");
    let turn = TurnId::new("turn_main").unwrap();

    let first = hub
        .publish(
            session.clone(),
            hot(
                1,
                HotEventPayload::MessageDelta {
                    turn_id: turn.clone(),
                    cursor: 10,
                    text: "hel".to_string(),
                },
            ),
        )
        .unwrap();
    let second = hub
        .publish(
            session.clone(),
            hot(
                2,
                HotEventPayload::MessageDelta {
                    turn_id: turn,
                    cursor: 11,
                    text: "lo".to_string(),
                },
            ),
        )
        .unwrap();

    assert_eq!(first, HotCursor(1));
    assert_eq!(second, HotCursor(2));
    assert_eq!(hub.metrics().coalesced_deltas, 1);
    let read = hub.read(&session, HotCursor(0), 10);
    assert_eq!(read.events.len(), 1);
    assert_eq!(read.events[0].cursor, HotCursor(2));
    assert_eq!(read.events[0].payload["text"], "hello");
}

#[test]
fn progress_key_keeps_only_latest_usage_value() {
    let mut hub = HotEventHub::new(4096, 8192).unwrap();
    let session = session("main");
    let provider = ProviderId::new("provider_main").unwrap();

    hub.publish(
        session.clone(),
        hot(
            1,
            HotEventPayload::UsageUpdated {
                provider_id: provider.clone(),
                input_tokens: 10,
                output_tokens: 1,
            },
        ),
    )
    .unwrap();
    hub.publish(
        session.clone(),
        hot(
            2,
            HotEventPayload::UsageUpdated {
                provider_id: provider,
                input_tokens: 20,
                output_tokens: 2,
            },
        ),
    )
    .unwrap();

    let read = hub.read(&session, HotCursor(0), 10);
    assert_eq!(read.events.len(), 1);
    assert_eq!(hub.metrics().coalesced_progress, 1);
    assert_eq!(read.events[0].payload["input_tokens"], 20);
    assert_eq!(read.events[0].cursor, HotCursor(2));
}

#[test]
fn slow_or_absent_subscriber_gets_gap_and_projection_fallback() {
    let mut hub = HotEventHub::new(360, 4096).unwrap();
    let session = session("slow");
    let provider = ProviderId::new("provider_main").unwrap();

    for idx in 1..20 {
        hub.publish(
            session.clone(),
            hot(
                idx,
                HotEventPayload::ProviderDiagnostic {
                    provider_id: provider.clone(),
                    code: format!("diagnostic_{idx}"),
                },
            ),
        )
        .unwrap();
    }

    let read = hub.read(&session, HotCursor(0), 100);
    assert!(
        read.gap.is_some(),
        "old cursor should observe bounded-ring overflow"
    );
    assert!(read.completed_projection_fallback_required);
    assert!(hub.metrics().per_session_overflows > 0 || hub.metrics().global_overflows > 0);
}

#[test]
fn multiple_sessions_remain_independent_under_hot_storm() {
    let mut hub = HotEventHub::new(2048, 4096).unwrap();
    let a = session("a");
    let b = session("b");
    let provider = ProviderId::new("provider_main").unwrap();

    for idx in 1..30 {
        let target = if idx % 2 == 0 { a.clone() } else { b.clone() };
        hub.publish(
            target,
            hot(
                idx,
                HotEventPayload::ProviderDiagnostic {
                    provider_id: provider.clone(),
                    code: format!("storm_{idx}"),
                },
            ),
        )
        .unwrap();
    }

    assert!(!hub.read(&a, HotCursor(0), 10).events.is_empty());
    assert!(!hub.read(&b, HotCursor(0), 10).events.is_empty());
    assert_eq!(hub.metrics().sessions, 2);
}

#[test]
fn terminal_transitions_cannot_enter_hot_only_api() {
    let hub = HotEventHub::new(4096, 8192).unwrap();
    let semantic = SemanticEvent::new(
        metadata(1),
        SemanticEventPayload::TurnCompleted {
            turn_id: TurnId::new("turn_main").unwrap(),
        },
    )
    .unwrap();

    assert!(matches!(
        hub.reject_terminal_transition(&semantic),
        Err(HubError::TerminalRequiresDurableAppend(
            CanonicalEventType::TurnCompleted
        ))
    ));
}

#[test]
fn hot_event_hub_has_no_sqlite_dependency_or_durable_lock() {
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest.contains("rusqlite"));
    assert!(!manifest.contains("tokio-rusqlite"));
    assert!(boundary_hot_event_hub_does_not_own_durable_state().contains("hot-only"));
}
