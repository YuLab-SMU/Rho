use proptest::prelude::*;
use rho_protocol::*;
use serde_json::json;

fn actor() -> Actor {
    Actor {
        kind: ActorKind::System,
        id: "system".to_string(),
    }
}

fn metadata(label: &str) -> EventEnvelopeMetadata {
    EventEnvelopeMetadata::new(
        EventId::new(format!("event_{label}")).unwrap(),
        StreamId::new("stream_main").unwrap(),
        StreamSeq(1),
        actor(),
        CorrelationId::new("correlation_main").unwrap(),
        TraceId::new("trace_main").unwrap(),
    )
}

fn expected_revisions() -> ExpectedRevisions {
    ExpectedRevisions {
        workspace_id: WorkspaceId::new("workspace_main").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_main").unwrap(),
        state_revision: StateRevision(10),
        project_revision: ProjectRevision(3),
    }
}

fn revision_transition() -> RevisionTransition {
    RevisionTransition {
        before: RevisionStamp {
            workspace_id: WorkspaceId::new("workspace_main").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_main").unwrap(),
            state_revision: StateRevision(10),
            project_revision: ProjectRevision(3),
        },
        after: RevisionStamp {
            workspace_id: WorkspaceId::new("workspace_main").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_main").unwrap(),
            state_revision: StateRevision(11),
            project_revision: ProjectRevision(3),
        },
    }
}

#[test]
fn generated_ids_use_ordered_uuid_v7_policy() {
    let event_id = EventId::generate();
    assert_eq!(
        EventId::generated_uses_ordered_uuid_policy(),
        ORDERED_ID_VERSION
    );
    let uuid_text = event_id.as_str().strip_prefix("event_").unwrap();
    let parsed = uuid::Uuid::parse_str(uuid_text).unwrap();
    assert_eq!(parsed.get_version_num(), 7);
}

#[test]
fn event_registry_classifies_every_canonical_type_without_caller_booleans() {
    assert_eq!(ALL_CANONICAL_EVENT_TYPES.len(), 17);
    let priorities = ALL_CANONICAL_EVENT_TYPES
        .into_iter()
        .map(|event_type| event_type.registry().priority)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        priorities,
        [
            EventPriority::P0,
            EventPriority::P1,
            EventPriority::P2,
            EventPriority::P3,
        ]
        .into_iter()
        .collect()
    );
    assert_eq!(
        CanonicalEventType::MessageDelta.registry().channel,
        EventChannel::HotOnly
    );
    assert_eq!(
        CanonicalEventType::RevisionAdvanced.registry().channel,
        EventChannel::SemanticDurable
    );
    assert_eq!(
        CanonicalEventType::RevisionAdvanced.registry().priority,
        EventPriority::P0
    );
}

#[test]
fn hot_text_delta_cannot_be_admitted_as_semantic_event() {
    let envelope = CanonicalEventEnvelope::new(
        EventId::new("event_delta").unwrap(),
        CanonicalEventType::MessageDelta,
        EventPriority::P3,
        StreamId::new("stream_main").unwrap(),
        StreamSeq(1),
        actor(),
        CorrelationId::new("correlation_main").unwrap(),
        TraceId::new("trace_main").unwrap(),
        json!({
            "kind": "message_delta",
            "turn_id": "turn_main",
            "cursor": 1,
            "text": "token"
        }),
    );

    assert!(matches!(
        SemanticEvent::try_from(envelope),
        Err(EventValidationError::WrongChannel {
            event_type: CanonicalEventType::MessageDelta,
            channel: EventChannel::SemanticDurable,
        })
    ));
}

#[test]
fn raw_provider_payload_cannot_be_semantic_payload() {
    let raw = RawProviderPayload {
        provider_id: ProviderId::new("provider_anthropic").unwrap(),
        method: "session/update".to_string(),
        body: json!({"acp": {"method": "session/update"}}),
    };
    assert!(matches!(
        SemanticEventPayload::try_from(raw),
        Err(EventValidationError::RawProviderPayloadRejected)
    ));
}

#[test]
fn semantic_event_sets_priority_and_sensitivity_from_payload_registry() {
    let expected = expected_revisions();
    let payload = SemanticEventPayload::CapabilityRequested {
        capability_id: CapabilityId::new("workspace.run_r").unwrap(),
        operation_id: OperationId::new("operation_run_r").unwrap(),
        expected_revisions: expected.clone(),
        normalized_arguments: json!({"code": "x <- 1"}),
    };
    let event = SemanticEvent::new(
        metadata("capability").with_expected_revisions(&expected),
        payload,
    )
    .unwrap();

    assert_eq!(event.event_type, CanonicalEventType::CapabilityRequested);
    assert_eq!(event.priority, EventPriority::P0);
    assert_eq!(event.sensitivity, DataClass::ProjectConfidential);
    assert!(event.encoded_payload_len().unwrap() < MAX_SEMANTIC_EVENT_PAYLOAD_BYTES);
}

#[test]
fn revision_bearing_events_validate_workspace_kernel_and_before_after_revisions() {
    let transition = revision_transition();
    let payload = SemanticEventPayload::RevisionAdvanced {
        transition: transition.clone(),
    };
    let event = SemanticEvent::new(
        metadata("revision").with_revision_transition(&transition),
        payload.clone(),
    )
    .unwrap();
    assert_eq!(event.event_type, CanonicalEventType::RevisionAdvanced);

    let mut bad_transition = transition;
    bad_transition.after.kernel_instance_id = KernelInstanceId::new("kernel_other").unwrap();
    let bad = SemanticEvent::new(
        metadata("revision_bad").with_revision_transition(&bad_transition),
        SemanticEventPayload::RevisionAdvanced {
            transition: bad_transition,
        },
    );
    assert!(matches!(
        bad,
        Err(EventValidationError::RevisionIdentityMismatch)
    ));
}

#[test]
fn unknown_schema_version_is_rejected_before_admission() {
    assert!(matches!(
        validate_supported_schema(CANONICAL_SCHEMA_VERSION + 1),
        Err(EventValidationError::UnsupportedSchemaVersion { .. })
    ));
}

#[test]
fn stream_sequence_overflow_is_explicit() {
    assert_eq!(StreamSeq(41).next().unwrap(), StreamSeq(42));
    assert!(matches!(
        StreamSeq(u64::MAX).next(),
        Err(StreamSeqError::Overflow)
    ));
}

proptest! {
    #[test]
    fn semantic_payload_serialization_has_calculable_size(reason in "[a-z0-9_]{1,64}") {
        let payload = SemanticEventPayload::TurnFailed {
            turn_id: TurnId::new("turn_property").unwrap(),
            reason_code: reason,
        };
        let len = encoded_payload_len(&payload).unwrap();
        prop_assert!(len < MAX_SEMANTIC_EVENT_PAYLOAD_BYTES);
        let round_trip: SemanticEventPayload = serde_json::from_slice(
            &serde_json::to_vec(&payload).unwrap()
        ).unwrap();
        prop_assert_eq!(round_trip.event_type(), CanonicalEventType::TurnFailed);
    }

    #[test]
    fn typed_ids_reject_invalid_text_before_they_enter_event_metadata(suffix in "[a-z0-9_]{1,16}") {
        let event = format!("event_{suffix}\n");
        let stream = format!(" stream_{suffix}");
        let operation = format!("operation_{suffix}");
        prop_assert!(EventId::new(event).is_err());
        prop_assert!(StreamId::new(stream).is_err());
        prop_assert!(OperationId::new(operation).is_ok());
    }
}
