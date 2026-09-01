use rho_control_plane::*;
use rho_protocol::*;
use serde_json::json;

fn revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_flow").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_flow").unwrap(),
        state_revision: StateRevision(8),
        project_revision: ProjectRevision(3),
    }
}

fn result(id: &str, class: Option<DataClass>, payload: &str) -> UntrustedCapabilityResult {
    UntrustedCapabilityResult {
        result_id: id.to_string(),
        capability_id: CapabilityId::new("workspace.inspect").unwrap(),
        payload: json!({"text":payload}),
        data_class: class,
        provenance: vec![ResultSourceProvenance::Observation {
            event_id: EventId::new(format!("event_{id}")).unwrap(),
            revision: revision(),
        }],
    }
}

#[test]
fn information_flow_confidential_inspect_rewrite_cannot_launder_to_arbitrary_network() {
    let mut engine = InformationFlowEngine::new();
    engine
        .admit_result(result(
            "result_confidential",
            Some(DataClass::ProjectConfidential),
            "CANARY_CONFIDENTIAL_PROJECT_TEXT",
        ))
        .unwrap();
    let rewritten = engine
        .derive_result(
            "result_rewritten",
            CapabilityId::new("text.rewrite").unwrap(),
            json!({"text":"innocent-looking rewrite"}),
            &["result_confidential".to_string()],
        )
        .unwrap();
    assert_eq!(rewritten.data_class, DataClass::ProjectConfidential);

    let decision = engine
        .evaluate_egress(InformationFlowEgressRequest {
            read_result_ids: vec!["result_rewritten".to_string()],
            destination_origin: "https://arbitrary.example:443".to_string(),
            provider_id: "provider_external".to_string(),
            policy: EgressPolicyRequest {
                turn_id: TurnId::new("turn_flow").unwrap(),
                destination_origin: String::new(),
                data_class: DataClass::Public,
                mode: EgressPolicyMode::Allowlisted {
                    origins: vec!["https://approved.example:443".to_string()],
                },
                now_ms: 1000,
                platform_enforcement_available: true,
            },
        })
        .unwrap();
    assert_eq!(
        decision.effective_data_class,
        DataClass::ProjectConfidential
    );
    assert!(matches!(
        decision.decision,
        EgressDecisionKind::Ask | EgressDecisionKind::Deny
    ));
    let encoded = serde_json::to_string(&decision).unwrap();
    assert!(!encoded.contains("CANARY_CONFIDENTIAL_PROJECT_TEXT"));
}

#[test]
fn information_flow_derived_artifact_inherits_strictest_input_sensitivity() {
    let mut engine = InformationFlowEngine::new();
    engine
        .admit_result(result("result_public", Some(DataClass::Public), "public"))
        .unwrap();
    engine
        .admit_result(result(
            "result_secret",
            Some(DataClass::RestrictedSecret),
            "CANARY_RESTRICTED",
        ))
        .unwrap();
    let artifact = engine
        .artifact_sensitivity(
            "artifact_derived",
            &["result_public".to_string(), "result_secret".to_string()],
        )
        .unwrap();
    assert_eq!(artifact.data_class, DataClass::RestrictedSecret);
    assert_eq!(artifact.input_result_ids.len(), 2);
}

#[test]
fn information_flow_missing_unknown_label_and_missing_read_set_fail_closed() {
    let mut engine = InformationFlowEngine::new();
    assert_eq!(
        engine
            .admit_result(result("result_unknown", None, "unknown"))
            .unwrap_err(),
        InformationFlowError::InvalidResult
    );
    assert_eq!(
        engine
            .artifact_sensitivity("artifact_missing", &["missing".to_string()])
            .unwrap_err(),
        InformationFlowError::MissingReadResult("missing".to_string())
    );
    assert_eq!(
        engine
            .artifact_sensitivity("artifact_empty", &[])
            .unwrap_err(),
        InformationFlowError::EmptyReadSet
    );
}

#[test]
fn information_flow_only_explicit_reviewed_declassification_with_p0_p1_attestation_can_lower() {
    let mut engine = InformationFlowEngine::new();
    engine
        .admit_result(result(
            "result_original",
            Some(DataClass::ProjectConfidential),
            "confidential",
        ))
        .unwrap();
    let invalid = DeclassificationAttestation {
        attestation_id: "attestation_invalid".to_string(),
        capability_id: CapabilityId::new("text.rewrite").unwrap(),
        from: DataClass::ProjectConfidential,
        to: DataClass::ProjectInternal,
        priority: EventPriority::P1,
        policy_id: "policy_review".to_string(),
        reason_code: "reviewed".to_string(),
    };
    assert_eq!(
        engine
            .declassify("result_original", "result_invalid", &invalid)
            .unwrap_err(),
        InformationFlowError::Declassification
    );
    let valid = DeclassificationAttestation {
        attestation_id: "attestation_valid".to_string(),
        capability_id: CapabilityId::new(DECLASSIFICATION_CAPABILITY_ID).unwrap(),
        from: DataClass::ProjectConfidential,
        to: DataClass::ProjectInternal,
        priority: EventPriority::P0,
        policy_id: "policy_reviewed_declassification".to_string(),
        reason_code: "human_reviewed_public_aggregate".to_string(),
    };
    let declassified = engine
        .declassify("result_original", "result_valid", &valid)
        .unwrap();
    assert_eq!(declassified.data_class, DataClass::ProjectInternal);
    assert_eq!(
        declassified.source_classifications[0].source_id,
        "attestation_valid"
    );
}

#[test]
fn information_flow_telemetry_and_ui_explanation_exclude_payload_but_explain_reason() {
    let mut engine = InformationFlowEngine::new();
    engine
        .admit_result(result(
            "result_canary",
            Some(DataClass::ProjectConfidential),
            "CANARY_PAYLOAD_NOT_FOR_TELEMETRY",
        ))
        .unwrap();
    let decision = engine
        .evaluate_egress(InformationFlowEgressRequest {
            read_result_ids: vec!["result_canary".to_string()],
            destination_origin: "https://blocked.example:443".to_string(),
            provider_id: "provider_external".to_string(),
            policy: EgressPolicyRequest {
                turn_id: TurnId::new("turn_flow_summary").unwrap(),
                destination_origin: String::new(),
                data_class: DataClass::Public,
                mode: EgressPolicyMode::Deny,
                now_ms: 1000,
                platform_enforcement_available: true,
            },
        })
        .unwrap();
    let attributes = InformationFlowEngine::telemetry_attributes(&decision);
    let encoded = format!("{}{:?}", decision.user_summary, attributes);
    assert!(encoded.contains("project_confidential"));
    assert!(encoded.contains("network_default_deny"));
    assert!(!encoded.contains("CANARY_PAYLOAD_NOT_FOR_TELEMETRY"));
}

#[test]
fn information_flow_boundary_forbids_agent_override_unknown_allow_and_payload_leaks() {
    let (_, does_not_own) = information_flow_boundary();
    assert!(does_not_own.contains(&"agent_label_override"));
    assert!(does_not_own.contains(&"unknown_label_allow"));
    assert!(does_not_own.contains(&"telemetry_payload"));
    assert!(does_not_own.contains(&"ui_payload_explanation"));
}
