use rho_agent_host::{ProviderRuntimeEvent, TurnTerminalOutcome, providers::provider_matrix::*};
use rho_protocol::{CapabilityId, OperationId, RUN_R_CAPABILITY};
use serde_json::json;

fn matrix() -> LiveProviderMatrix {
    LiveProviderMatrix::parse(include_bytes!("providers/live-matrix.json")).unwrap()
}

#[test]
fn provider_matrix_live_digests_versions_and_capabilities_are_truthful() {
    let matrix = matrix();
    let opencode = matrix.entry("opencode").unwrap();
    assert_eq!(opencode.protocol, "acp/1");
    assert!(opencode.live_probe_passed);
    assert_eq!(opencode.support_tier, ProviderSupportTier::ObserverOnly);
    assert!(opencode.observed.streaming);
    assert!(opencode.observed.resume);
    assert!(opencode.observed.close);
    assert!(opencode.observed.list);
    assert!(opencode.observed.mcp);
    assert!(!opencode.observed.filesystem);
    assert!(!opencode.observed.terminal);
    let snapshot = opencode.canonical_snapshot().unwrap();
    assert!(
        snapshot
            .capability_ids
            .contains(&CapabilityId::new("workspace.inspect").unwrap())
    );
    assert!(
        !snapshot
            .capability_ids
            .contains(&CapabilityId::new(RUN_R_CAPABILITY).unwrap())
    );
}

#[test]
fn provider_matrix_pi_and_commercial_agent_without_stable_acp_are_unsupported_not_quirked() {
    let matrix = matrix();
    for provider in ["pi", "claude_code"] {
        let entry = matrix.entry(provider).unwrap();
        assert_eq!(entry.support_tier, ProviderSupportTier::Unsupported);
        assert!(!entry.live_probe_passed);
        assert!(entry.canonical_snapshot().is_none());
        assert!(
            entry
                .reason
                .as_deref()
                .unwrap()
                .contains("No stable local stdio ACP v1")
        );
    }
    assert!(matrix.entry("claude_code").unwrap().commercial);
}

#[test]
fn provider_matrix_incorrect_live_declaration_downgrades_to_unsupported() {
    let mut entry = matrix().entry("opencode").unwrap().clone();
    entry.live_probe_passed = false;
    let downgraded = downgrade_incorrect_declaration(entry);
    assert_eq!(downgraded.support_tier, ProviderSupportTier::Unsupported);
    assert_eq!(downgraded.observed, ProviderObservedCapabilities::default());
    assert!(downgraded.reason.unwrap().contains("contradicted"));
}

#[test]
fn provider_matrix_same_golden_behavior_ignores_model_answer_text() {
    let first = vec![
        ProviderRuntimeEvent::MessageDelta {
            cursor: 0,
            text: "first provider wording".to_string(),
        },
        ProviderRuntimeEvent::CapabilityRequest {
            capability_id: CapabilityId::new("workspace.inspect").unwrap(),
            operation_id: OperationId::new("operation_matrix_one").unwrap(),
            normalized_arguments: json!({"query":"objects"}),
        },
        ProviderRuntimeEvent::Terminal {
            outcome: TurnTerminalOutcome::Completed,
        },
    ];
    let second = vec![
        ProviderRuntimeEvent::MessageDelta {
            cursor: 0,
            text: "different model answer quality and wording".to_string(),
        },
        ProviderRuntimeEvent::CapabilityRequest {
            capability_id: CapabilityId::new("workspace.inspect").unwrap(),
            operation_id: OperationId::new("operation_matrix_two").unwrap(),
            normalized_arguments: json!({"query":"objects"}),
        },
        ProviderRuntimeEvent::Terminal {
            outcome: TurnTerminalOutcome::Completed,
        },
    ];
    assert_eq!(
        canonical_transcript_behavior_key(&first),
        canonical_transcript_behavior_key(&second)
    );
}

#[test]
fn provider_matrix_unavailable_crash_and_invalid_config_use_common_lifecycle() {
    let matrix = matrix();
    let entry = matrix.entry("opencode").unwrap();
    assert_eq!(
        entry.lifecycle_after(false, false, true),
        MatrixLifecycleState::Unavailable
    );
    assert_eq!(
        entry.lifecycle_after(true, true, true),
        MatrixLifecycleState::Crashed
    );
    assert_eq!(
        entry.lifecycle_after(true, false, false),
        MatrixLifecycleState::ConfigInvalid
    );
    assert_eq!(
        entry.lifecycle_after(true, false, true),
        MatrixLifecycleState::Ready
    );
}

#[test]
fn provider_matrix_has_no_broker_store_or_ui_provider_identity_branch() {
    for source in [
        include_str!("../../rho-control-plane/src/broker.rs"),
        include_str!("../../rho-store/src/lib.rs"),
        include_str!("../../../desktop/ui/src/app/agent/ProviderControls.tsx"),
    ] {
        let lowered = source.to_ascii_lowercase();
        for forbidden in [
            "if provider ==",
            "match provider_id",
            "provider == \"opencode\"",
        ] {
            assert!(!lowered.contains(forbidden));
        }
    }
    let (_, does_not_own) = provider_matrix_boundary();
    assert!(does_not_own.contains(&"provider_authority"));
    assert!(does_not_own.contains(&"model_answer_quality_gate"));
}
