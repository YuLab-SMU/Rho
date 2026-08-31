use rho_control_plane::*;
use rho_protocol::*;

#[derive(Default)]
struct FakeDurableIntentStore {
    events: Vec<SemanticEvent>,
}

impl DurableIntentRecorder for FakeDurableIntentStore {
    fn append_broker_intent(
        &mut self,
        _expected_next_seq: StreamSeq,
        event: &SemanticEvent,
    ) -> Result<DurableIntentOutcome, BrokerError> {
        self.events.push(event.clone());
        Ok(DurableIntentOutcome::Appended)
    }
}

#[derive(Default)]
struct FakeWorkspace;

impl WorkspaceEffectPort for FakeWorkspace {
    fn execute_workspace_effect(
        &mut self,
        lease: &BrokerLease,
        context: &PolicyEvaluationContext,
        normalized_arguments: &serde_json::Value,
    ) -> Result<WorkspaceSliceObservation, CompositionError> {
        assert_eq!(lease.operation_id(), &context.input.operation.operation_id);
        assert_eq!(normalized_arguments["code"], "plot(1:3)");
        Ok(WorkspaceSliceObservation {
            terminal: ExecutionTerminalOutcome::Succeeded,
            state_revision_after: 5,
            stdout_digest:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            artifact_bytes: b"plot png bytes".to_vec(),
        })
    }
}

#[derive(Default)]
struct FakeArtifact;

impl ArtifactCommitPort for FakeArtifact {
    fn commit_artifact_bytes(
        &mut self,
        observation: &WorkspaceSliceObservation,
    ) -> Result<ArtifactDigest, CompositionError> {
        assert_eq!(observation.terminal, ExecutionTerminalOutcome::Succeeded);
        assert_eq!(observation.artifact_bytes, b"plot png bytes");
        Ok(ArtifactDigest::new(
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap())
    }
}

#[test]
fn composition_provider_neutral_vertical_slice_inspect_approval_workspace_artifact() {
    let mut durable = FakeDurableIntentStore::default();
    let broker = BrokerAdmission::new(
        composition_root_registry(),
        StreamId::new("stream_composition").unwrap(),
    );
    let mut composition = ControlPlaneComposition::new(broker, FakeWorkspace, FakeArtifact);
    let report = composition
        .provider_neutral_vertical_slice(&mut durable)
        .unwrap();

    assert_eq!(report.inspect_policy, BrokerDecisionKind::Allow);
    assert_eq!(report.approval_policy, BrokerDecisionKind::Ask);
    assert_eq!(
        report.execution_terminal,
        ExecutionTerminalOutcome::Succeeded
    );
    assert_eq!(
        report.artifact_digest.as_str(),
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(
        durable.events.len(),
        2,
        "inspect and run_r policy facts are durable"
    );
}

#[test]
fn composition_lifecycle_faults_cleanup_children_and_record_truthful_restart_state() {
    for point in [
        LifecycleFaultPoint::AfterStore,
        LifecycleFaultPoint::AfterEventHub,
        LifecycleFaultPoint::AfterPolicy,
        LifecycleFaultPoint::AfterBroker,
    ] {
        let error = LifecycleCoordinator::startup_with_fault(Some(point)).unwrap_err();
        assert!(matches!(error, CompositionError::LifecycleFault(p) if p == point));
    }
    let shutdown_error =
        LifecycleCoordinator::shutdown_with_fault(Some(LifecycleFaultPoint::DuringShutdown))
            .unwrap_err();
    assert!(matches!(
        shutdown_error,
        CompositionError::LifecycleFault(LifecycleFaultPoint::DuringShutdown)
    ));

    let submit = LifecycleCoordinator::truthful_restart_state_after_submit_or_commit_fault(
        LifecycleFaultPoint::DuringSubmit,
    );
    assert!(submit.restarted_truthful);
    assert_eq!(
        submit.state.durable_truth,
        "submitted_intent_may_need_reconcile"
    );
    let commit = LifecycleCoordinator::truthful_restart_state_after_submit_or_commit_fault(
        LifecycleFaultPoint::DuringCommit,
    );
    assert_eq!(
        commit.state.durable_truth,
        "commit_may_have_orphan_or_corrupt_record"
    );
}

#[test]
fn composition_enumerates_all_effect_ingress_as_broker_mediated() {
    let ingress = effect_ingress_registry();
    assert!(
        ingress
            .iter()
            .any(|entry| entry.starts_with("DesktopCommand"))
    );
    assert!(ingress.iter().any(|entry| entry.starts_with("CLICommand")));
    assert!(ingress.iter().any(|entry| entry.starts_with("McpTool")));
    assert!(
        ingress
            .iter()
            .any(|entry| entry.starts_with("AgentProviderToolCall"))
    );
    assert!(
        ingress
            .iter()
            .all(|entry| entry.contains("BrokerAdmission::admit"))
    );
}

#[test]
fn composition_source_has_no_provider_enum_old_broker_facade_or_runtime_side_effects() {
    let broker_source = include_str!("../src/broker.rs");
    assert!(!broker_source.contains("enum Provider"));
    assert!(!broker_source.contains("OldBroker"));
    assert!(!broker_source.contains("fallback"));

    let execution_source = include_str!("../../rho-execution/src/lib.rs");
    assert!(!execution_source.contains("AgentPlan"));

    let store_sources = [
        include_str!("../../rho-store/src/events/mod.rs"),
        include_str!("../../rho-store/src/semantic_schema.rs"),
    ];
    for source in store_sources {
        for forbidden in ["std::process::Command", "tokio::spawn", "reqwest", "ureq"] {
            assert!(
                !source.contains(forbidden),
                "store leaked runtime side effect {forbidden}"
            );
        }
    }
}
