use rho_agent_host::*;
use rho_protocol::*;

#[derive(Default)]
struct HotSink {
    events: Vec<HotEventPayload>,
}

impl HotEventSink for HotSink {
    fn push_hot(
        &mut self,
        _turn_id: &TurnId,
        payload: HotEventPayload,
    ) -> Result<(), AgentRuntimeError> {
        self.events.push(payload);
        Ok(())
    }
}

#[derive(Default)]
struct DurableSink {
    events: Vec<SemanticEventPayload>,
}

impl DurableTransitionSink for DurableSink {
    fn push_semantic(
        &mut self,
        _turn_id: &TurnId,
        payload: SemanticEventPayload,
    ) -> Result<(), AgentRuntimeError> {
        self.events.push(payload);
        Ok(())
    }
}

fn turn_request(turn: &str) -> AgentTurnRequest {
    AgentTurnRequest {
        turn_id: TurnId::new(turn).unwrap(),
        prompt_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        deadline_epoch_ms: 10_000,
        event_quota: DEFAULT_TURN_EVENT_QUOTA,
    }
}

#[test]
fn runtime_routes_delta_to_hot_and_semantic_transitions_to_durable() {
    let mut runtime = AgentRuntime::new();
    let request = turn_request("turn_normal");
    let turn_id = request.turn_id.clone();
    runtime.open_turn(request.clone());
    let mut provider = FakeProvider::new(FakeProviderScenario::Normal);
    let mut hot = HotSink::default();
    let mut durable = DurableSink::default();

    for event in provider.start_turn(request) {
        runtime
            .process_event(&turn_id, event, &mut hot, &mut durable)
            .unwrap();
    }

    assert_eq!(hot.events.len(), 1);
    assert!(matches!(
        hot.events[0],
        HotEventPayload::MessageDelta { .. }
    ));
    assert!(
        durable
            .events
            .iter()
            .any(|event| matches!(event, SemanticEventPayload::CapabilityRequested { .. }))
    );
    assert!(
        durable
            .events
            .iter()
            .any(|event| matches!(event, SemanticEventPayload::TurnCompleted { .. }))
    );
    assert_eq!(
        runtime.turn(&turn_id).unwrap().terminal,
        Some(TurnTerminalOutcome::Completed)
    );
}

#[test]
fn runtime_rejects_duplicate_terminal_event_after_terminal_and_oversized_delta_with_bounded_diagnostics()
 {
    let mut runtime = AgentRuntime::new();
    let request = turn_request("turn_bad");
    let turn_id = request.turn_id.clone();
    runtime.open_turn(request);
    let mut hot = HotSink::default();
    let mut durable = DurableSink::default();

    runtime
        .process_event(
            &turn_id,
            ProviderRuntimeEvent::Terminal {
                outcome: TurnTerminalOutcome::Completed,
            },
            &mut hot,
            &mut durable,
        )
        .unwrap();
    assert_eq!(
        runtime
            .process_event(
                &turn_id,
                ProviderRuntimeEvent::Terminal {
                    outcome: TurnTerminalOutcome::Failed,
                },
                &mut hot,
                &mut durable,
            )
            .unwrap_err(),
        AgentRuntimeError::DuplicateTerminal
    );
    assert_eq!(
        runtime
            .process_event(
                &turn_id,
                ProviderRuntimeEvent::MessageDelta {
                    cursor: 99,
                    text: "late".to_string(),
                },
                &mut hot,
                &mut durable,
            )
            .unwrap_err(),
        AgentRuntimeError::EventAfterTerminal
    );

    let mut runtime = AgentRuntime::new();
    let request = turn_request("turn_oversized");
    let turn_id = request.turn_id.clone();
    runtime.open_turn(request);
    assert_eq!(
        runtime
            .process_event(
                &turn_id,
                ProviderRuntimeEvent::MessageDelta {
                    cursor: 0,
                    text: "x".repeat(MAX_DELTA_BYTES + 1),
                },
                &mut hot,
                &mut durable,
            )
            .unwrap_err(),
        AgentRuntimeError::OversizedDelta
    );
    assert!(
        runtime
            .diagnostics()
            .iter()
            .all(|diagnostic| diagnostic.detail.len() <= MAX_DIAGNOSTIC_BYTES)
    );
}

#[test]
fn runtime_cancel_distinguishes_requested_provider_confirmed_and_process_confirmed() {
    let mut runtime = AgentRuntime::new();
    let request = turn_request("turn_cancel");
    let turn_id = request.turn_id.clone();
    runtime.open_turn(request);
    let mut provider = FakeProvider::new(FakeProviderScenario::Slow);

    assert_eq!(
        runtime.request_cancel(&mut provider, &turn_id).unwrap(),
        ProviderCancelReply::Accepted
    );
    let cancel = &runtime.turn(&turn_id).unwrap().cancel;
    assert!(cancel.requested);
    assert!(cancel.provider_confirmed);
    assert!(!cancel.process_confirmed);
    runtime.confirm_process_cancelled(&turn_id).unwrap();
    assert!(runtime.turn(&turn_id).unwrap().cancel.process_confirmed);
}

#[test]
fn runtime_fake_provider_covers_adversarial_scenarios() {
    for scenario in [
        FakeProviderScenario::Normal,
        FakeProviderScenario::Slow,
        FakeProviderScenario::DuplicateTerminal,
        FakeProviderScenario::OutOfOrder,
        FakeProviderScenario::NoTerminal,
        FakeProviderScenario::Crash,
    ] {
        let mut provider = FakeProvider::new(scenario);
        let events = provider.start_turn(turn_request("turn_scenario"));
        assert!(!events.is_empty());
    }
}

#[test]
fn runtime_source_has_no_authority_handles_or_provider_specific_enums() {
    let source = include_str!("../src/lib.rs");
    for forbidden in [
        "SemanticStore",
        "ExecutorHandle",
        "WorkspaceExecutor",
        "SecretBroker",
        "StoreHandle",
        "ProviderSpecific",
        "aisdk",
        "Aisdk",
        "ACP",
    ] {
        assert!(
            !source.contains(forbidden),
            "runtime leaked forbidden token: {forbidden}"
        );
    }
    assert!(boundary().does_not_own.contains(&"store_handle"));
}
