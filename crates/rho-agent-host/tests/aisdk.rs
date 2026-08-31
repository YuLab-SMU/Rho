use std::collections::BTreeMap;

use rho_agent_host::{
    AgentProvider, AgentTurnRequest, ProviderRuntimeEvent, TurnTerminalOutcome, providers::aisdk::*,
};
use rho_protocol::{CapabilityId, TurnId};
use serde_json::json;

fn adapter() -> AisdkAdapter {
    AisdkAdapter::new(AisdkConfig {
        model: "local-test-model".to_string(),
        endpoint_origin: "http://127.0.0.1:9999".to_string(),
        capabilities: AisdkCapabilities {
            resume: true,
            plan: true,
            config: true,
            streaming: true,
        },
    })
}

#[test]
fn aisdk_snapshot_truthfully_reports_resume_plan_config_streaming_contract() {
    let adapter = adapter();
    let snapshot = adapter.snapshot();
    assert!(snapshot.supports_resume);
    assert!(snapshot.supports_cancel);
    assert_eq!(snapshot.provider_version, "aisdk-adapter-v1");
    for capability in [
        "workspace.inspect",
        rho_protocol::RUN_R_CAPABILITY,
        "project.apply_patch",
        "network.fetch",
        "artifact.read",
    ] {
        assert!(
            snapshot
                .capability_ids
                .contains(&CapabilityId::new(capability).unwrap())
        );
    }
}

#[test]
fn aisdk_mission_tool_and_stream_map_to_canonical_events() {
    let adapter = adapter();
    assert!(matches!(
        adapter
            .translate(AisdkWireEvent::TextDelta {
                cursor: 3,
                text: "visible".to_string()
            })
            .unwrap(),
        AisdkTranslation::Canonical(ProviderRuntimeEvent::MessageDelta { cursor: 3, .. })
    ));
    assert!(matches!(
        adapter.translate(AisdkWireEvent::MissionPlan {
            mission_id: "plan_1".to_string(),
            steps: vec!["inspect".to_string(), "run".to_string()],
        }).unwrap(),
        AisdkTranslation::Canonical(ProviderRuntimeEvent::PlanReplaced { plan_id }) if plan_id == "plan_1"
    ));
    assert!(matches!(
        adapter.translate(AisdkWireEvent::ToolRequest {
            tool: "run_r".to_string(),
            call_id: "call_1".to_string(),
            arguments: json!({"code":"mean(x)"}),
        }).unwrap(),
        AisdkTranslation::Canonical(ProviderRuntimeEvent::CapabilityRequest { capability_id, .. })
            if capability_id.as_str() == rho_protocol::RUN_R_CAPABILITY
    ));
}

#[test]
fn aisdk_private_thinking_is_never_canonical_or_logged() {
    let canary = "CANARY_PRIVATE_THINKING";
    let translated = adapter()
        .translate(AisdkWireEvent::PrivateThinking {
            text: canary.to_string(),
        })
        .unwrap();
    assert_eq!(translated, AisdkTranslation::IgnoredPrivate);
    assert!(!format!("{translated:?}").contains(canary));
}

#[test]
fn aisdk_child_environment_is_explicit_allowlist_only() {
    let adapter = adapter();
    let allowed = adapter
        .child_environment(BTreeMap::from([(
            "AISDK_PROVIDER_TOKEN".to_string(),
            "CANARY_SECRET".to_string(),
        )]))
        .unwrap();
    assert_eq!(allowed.len(), 1);
    assert!(!allowed.contains_key("R_HOME"));
    assert_eq!(
        adapter
            .child_environment(BTreeMap::from([(
                "DATABASE_URL".to_string(),
                "CANARY_DATABASE".to_string(),
            )]))
            .unwrap_err(),
        AisdkAdapterError::InvalidSecretEnvironment
    );
}

#[test]
fn aisdk_fake_and_local_json_transcripts_pass_same_contract() {
    let lines = concat!(
        "{\"type\":\"text_delta\",\"cursor\":0,\"text\":\"working\"}\n",
        "{\"type\":\"mission_plan\",\"mission_id\":\"plan_t\",\"steps\":[\"inspect\"]}\n",
        "{\"type\":\"tool_request\",\"tool\":\"inspect_workspace\",\"call_id\":\"1\",\"arguments\":{\"query\":\"objects\"}}\n",
        "{\"type\":\"complete\"}\n"
    );
    let translated = adapter().translate_transcript_json_lines(lines).unwrap();
    assert_eq!(translated.len(), 4);
    assert!(matches!(
        translated.last(),
        Some(AisdkTranslation::Canonical(
            ProviderRuntimeEvent::Terminal {
                outcome: TurnTerminalOutcome::Completed
            }
        ))
    ));

    let mut provider = adapter().with_transcript(vec![
        AisdkWireEvent::TextDelta {
            cursor: 0,
            text: "working".to_string(),
        },
        AisdkWireEvent::Complete,
    ]);
    let events = provider.start_turn(AgentTurnRequest {
        turn_id: TurnId::new("turn_aisdk").unwrap(),
        prompt_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        deadline_epoch_ms: 10_000,
        event_quota: 16,
    });
    assert!(matches!(
        events.last(),
        Some(ProviderRuntimeEvent::Terminal {
            outcome: TurnTerminalOutcome::Completed
        })
    ));
}

#[test]
fn aisdk_bounds_events_plans_and_context() {
    let adapter = adapter();
    assert_eq!(
        adapter
            .translate(AisdkWireEvent::TextDelta {
                cursor: 0,
                text: "x".repeat(AISDK_MAX_EVENT_BYTES + 1),
            })
            .unwrap_err(),
        AisdkAdapterError::EventTooLarge
    );
    assert_eq!(
        adapter
            .translate(AisdkWireEvent::MissionPlan {
                mission_id: "large".to_string(),
                steps: (0..AISDK_MAX_PLAN_STEPS + 1)
                    .map(|idx| idx.to_string())
                    .collect(),
            })
            .unwrap_err(),
        AisdkAdapterError::PlanTooLarge
    );
    assert_eq!(
        adapter.bounded_context(&(0..100).collect::<Vec<_>>()).len(),
        AISDK_MAX_CONTEXT_ITEMS
    );
}

#[test]
fn aisdk_has_no_direct_authority_or_scientific_environment_path() {
    let source = include_str!("../src/providers/aisdk/mod.rs");
    for forbidden in [
        "SemanticStore",
        "WorkspaceExecutor",
        "append_semantic_event",
        "std::process::Command",
        "R_HOME",
        "project_root",
    ] {
        assert!(
            !source.contains(forbidden),
            "aisdk adapter leaked direct path: {forbidden}"
        );
    }
    let (_, does_not_own) = adapter_boundary();
    assert!(does_not_own.contains(&"policy_authority"));
}
