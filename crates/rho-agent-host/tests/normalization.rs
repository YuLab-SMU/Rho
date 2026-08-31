use rho_agent_host::{normalization::*, protocol::acp::v1::*};
use rho_protocol::*;
use serde_json::json;

fn context() -> NormalizationContext {
    NormalizationContext {
        logical_session_id: SessionId::new("session_normalization").unwrap(),
        turn_id: TurnId::new("turn_normalization").unwrap(),
        provider_id: ProviderId::new("provider_external").unwrap(),
        expected_revisions: ExpectedRevisions {
            workspace_id: WorkspaceId::new("workspace_normalization").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_normalization").unwrap(),
            state_revision: StateRevision(8),
            project_revision: ProjectRevision(3),
        },
    }
}

#[test]
fn normalization_explicit_table_has_no_authoritative_execution_mapping() {
    assert_eq!(NORMALIZATION_MAPPING_TABLE.len(), 11);
    assert!(
        NORMALIZATION_MAPPING_TABLE
            .iter()
            .all(|entry| !entry.authoritative_execution)
    );
    let channels = NORMALIZATION_MAPPING_TABLE
        .iter()
        .map(|entry| entry.output_channel)
        .collect::<std::collections::BTreeSet<_>>();
    assert!(channels.contains(&NormalizedChannel::Hot));
    assert!(channels.contains(&NormalizedChannel::Durable));
    assert!(channels.contains(&NormalizedChannel::Interaction));
    assert!(channels.contains(&NormalizedChannel::ProviderObservation));
}

#[test]
fn normalization_delta_is_hot_and_plan_tool_terminal_are_durable() {
    let mut normalizer = ProviderEventNormalizer::new();
    let delta = normalizer.normalize(
        &context(),
        NeutralAcpEvent::MessageDelta {
            cursor: 0,
            text: "visible".to_string(),
        },
    );
    assert!(matches!(
        &delta[0],
        NormalizationOutput::Hot {
            payload: HotEventPayload::MessageDelta { .. }
        }
    ));
    let plan = normalizer.normalize(
        &context(),
        NeutralAcpEvent::PlanReplaced {
            plan_id: "plan_external".to_string(),
        },
    );
    assert!(matches!(
        &plan[0],
        NormalizationOutput::Durable {
            payload: SemanticEventPayload::PlanReplaced { .. }
        }
    ));
    let tool = normalizer.normalize(
        &context(),
        NeutralAcpEvent::ToolRequested {
            capability_id: CapabilityId::new("workspace.inspect").unwrap(),
            operation_id: OperationId::new("operation_normalized_inspect").unwrap(),
            arguments: json!({"query":"objects"}),
        },
    );
    assert!(matches!(
        &tool[0],
        NormalizationOutput::Durable {
            payload: SemanticEventPayload::CapabilityRequested { .. }
        }
    ));
    let terminal = normalizer.normalize(
        &context(),
        NeutralAcpEvent::Terminal {
            outcome: "completed".to_string(),
        },
    );
    assert!(matches!(
        &terminal[0],
        NormalizationOutput::Durable {
            payload: SemanticEventPayload::TurnCompleted { .. }
        }
    ));
}

#[test]
fn normalization_provider_tool_completion_is_non_authoritative_observation() {
    let mut normalizer = ProviderEventNormalizer::new();
    let output = normalizer.normalize(
        &context(),
        NeutralAcpEvent::ToolReportedTerminal {
            operation_id: OperationId::new("operation_provider_claim").unwrap(),
            outcome: "succeeded".to_string(),
        },
    );
    let NormalizationOutput::ProviderObservation { observation } = &output[0] else {
        panic!("provider tool terminal must remain observation");
    };
    assert!(!observation.authoritative_execution);
    let encoded = serde_json::to_string(&output).unwrap();
    assert!(!encoded.contains("execution_state_changed"));
    assert!(!encoded.contains("revision_advanced"));
}

#[test]
fn normalization_permission_is_hint_plus_broker_required_interaction_not_allow() {
    let mut normalizer = ProviderEventNormalizer::new();
    let output = normalizer.normalize(
        &context(),
        NeutralAcpEvent::ProviderPermissionHint {
            capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
            hint: "provider says auto approve".to_string(),
        },
    );
    assert_eq!(output.len(), 2);
    assert!(matches!(
        &output[0],
        NormalizationOutput::Hot {
            payload: HotEventPayload::ProviderPermissionHint { .. }
        }
    ));
    let NormalizationOutput::Interaction { request } = &output[1] else {
        panic!("permission must create interaction request");
    };
    assert!(request.broker_admission_required);
    assert!(!serde_json::to_string(request).unwrap().contains("allow"));

    let without_permission = ProviderEventNormalizer::new().normalize(
        &context(),
        NeutralAcpEvent::ToolRequested {
            capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
            operation_id: OperationId::new("operation_without_provider_permission").unwrap(),
            arguments: json!({"code":"x <- 1"}),
        },
    );
    assert!(matches!(
        &without_permission[0],
        NormalizationOutput::Durable {
            payload: SemanticEventPayload::CapabilityRequested { .. }
        }
    ));
}

#[test]
fn normalization_reorder_duplicate_gap_and_terminal_are_deterministic() {
    let mut normalizer = ProviderEventNormalizer::new();
    let first = NeutralAcpEvent::MessageDelta {
        cursor: 4,
        text: "first".to_string(),
    };
    assert!(matches!(
        &normalizer.normalize(&context(), first.clone())[0],
        NormalizationOutput::Hot { .. }
    ));
    assert!(matches!(
        &normalizer.normalize(&context(), first)[0],
        NormalizationOutput::Ignored { reason } if reason == "duplicate_provider_event"
    ));
    assert!(matches!(
        &normalizer.normalize(
            &context(),
            NeutralAcpEvent::MessageDelta { cursor: 3, text: "late".to_string() }
        )[0],
        NormalizationOutput::Diagnostic { code, .. } if code == "provider_delta_reordered"
    ));
    let gap = normalizer.normalize(
        &context(),
        NeutralAcpEvent::MessageDelta {
            cursor: 8,
            text: "after gap".to_string(),
        },
    );
    assert_eq!(gap.len(), 2);
    assert!(
        matches!(&gap[0], NormalizationOutput::Diagnostic { code, .. } if code == "provider_delta_gap")
    );
    assert!(matches!(&gap[1], NormalizationOutput::Hot { .. }));

    normalizer.normalize(
        &context(),
        NeutralAcpEvent::Terminal {
            outcome: "completed".to_string(),
        },
    );
    let second_terminal = normalizer.normalize(
        &context(),
        NeutralAcpEvent::Terminal {
            outcome: "failed".to_string(),
        },
    );
    assert!(matches!(
        &second_terminal[0],
        NormalizationOutput::Ignored { reason } if reason == "duplicate_terminal"
    ));
}

#[test]
fn normalization_usage_is_bounded_and_diagnostic_redacts_sensitive_payload() {
    let mut normalizer = ProviderEventNormalizer::new();
    let usage = normalizer.normalize(
        &context(),
        NeutralAcpEvent::Usage {
            input_tokens: u64::MAX,
            output_tokens: u64::MAX,
        },
    );
    assert!(matches!(
        &usage[0],
        NormalizationOutput::Hot {
            payload: HotEventPayload::UsageUpdated {
                input_tokens: MAX_NORMALIZED_USAGE_TOKENS,
                output_tokens: MAX_NORMALIZED_USAGE_TOKENS,
                ..
            }
        }
    ));
    let diagnostic = normalizer.normalize(
        &context(),
        NeutralAcpEvent::Diagnostic {
            code: "provider_error".to_string(),
            detail: "Authorization: Bearer CANARY_SECRET".to_string(),
        },
    );
    let encoded = serde_json::to_string(&diagnostic).unwrap();
    assert!(!encoded.contains("CANARY_SECRET"));
    assert!(encoded.contains("redacted"));
}

#[test]
fn normalization_output_has_no_wire_method_enum_or_raw_payload() {
    let output = ProviderEventNormalizer::new().normalize(
        &context(),
        NeutralAcpEvent::SessionCreated {
            external_session_id: "external_private_id".to_string(),
        },
    );
    let encoded = serde_json::to_string(&output).unwrap().to_ascii_lowercase();
    for forbidden in [
        "acp",
        "jsonrpc",
        "session/created",
        "external_private_id",
        "raw_payload",
    ] {
        assert!(!encoded.contains(forbidden));
    }
    let (_, does_not_own) = normalization_boundary();
    assert!(does_not_own.contains(&"execution_success_authority"));
    assert!(does_not_own.contains(&"broker_bypass"));
}
