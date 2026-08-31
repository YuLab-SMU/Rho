use rho_control_plane::*;
use rho_protocol::*;

fn request(data_class: DataClass, mode: EgressPolicyMode) -> EgressPolicyRequest {
    EgressPolicyRequest {
        turn_id: TurnId::new("turn_egress").unwrap(),
        destination_origin: "https://target.example:443".to_string(),
        data_class,
        mode,
        now_ms: 1000,
        platform_enforcement_available: true,
    }
}

#[test]
fn egress_confidential_to_unapproved_destination_is_ask_or_deny() {
    let decision = evaluate_egress(&request(
        DataClass::ProjectConfidential,
        EgressPolicyMode::Allowlisted {
            origins: vec!["https://other.example:443".to_string()],
        },
    ));
    assert!(matches!(
        decision.decision,
        EgressDecisionKind::Ask | EgressDecisionKind::Deny
    ));
    assert_eq!(decision.reason_code, "confidential_unapproved_destination");
}

#[test]
fn egress_provider_only_is_not_arbitrary_network() {
    let denied = evaluate_egress(&request(
        DataClass::ProjectInternal,
        EgressPolicyMode::ProviderOnly {
            configured_origin: "https://provider.example:443".to_string(),
        },
    ));
    assert_eq!(denied.decision, EgressDecisionKind::Deny);
    assert_eq!(denied.reason_code, "provider_only_destination_mismatch");

    let mut allowed_request = request(
        DataClass::ProjectInternal,
        EgressPolicyMode::ProviderOnly {
            configured_origin: "https://provider.example:443".to_string(),
        },
    );
    allowed_request.destination_origin = "https://provider.example:443".to_string();
    assert_eq!(
        evaluate_egress(&allowed_request).decision,
        EgressDecisionKind::Allow
    );
}

#[test]
fn egress_unrestricted_approval_is_exact_turn_origin_and_time() {
    let mode = EgressPolicyMode::UnrestrictedWithExactApproval {
        approval_turn_id: TurnId::new("turn_egress").unwrap(),
        approval_origin: "https://target.example:443".to_string(),
        expires_at_ms: 2000,
    };
    assert_eq!(
        evaluate_egress(&request(DataClass::ProjectInternal, mode.clone())).decision,
        EgressDecisionKind::Allow
    );
    let mut stale = request(DataClass::ProjectInternal, mode);
    stale.now_ms = 3000;
    assert_eq!(evaluate_egress(&stale).decision, EgressDecisionKind::Ask);
}

#[test]
fn egress_restricted_secret_and_missing_platform_enforcement_fail_closed() {
    let restricted = evaluate_egress(&request(
        DataClass::RestrictedSecret,
        EgressPolicyMode::Allowlisted {
            origins: vec!["https://target.example:443".to_string()],
        },
    ));
    assert_eq!(restricted.decision, EgressDecisionKind::Deny);
    let mut unavailable = request(
        DataClass::Public,
        EgressPolicyMode::Allowlisted {
            origins: vec!["https://target.example:443".to_string()],
        },
    );
    unavailable.platform_enforcement_available = false;
    assert_eq!(
        evaluate_egress(&unavailable).decision,
        EgressDecisionKind::Deny
    );
    assert_eq!(
        evaluate_egress(&unavailable).reason_code,
        "network_enforcement_unavailable"
    );
}

#[test]
fn egress_policy_is_pure_and_has_no_socket_or_connector_side_effect() {
    let source = include_str!("../src/policy/egress.rs");
    for forbidden in [
        "TcpStream",
        "UdpSocket",
        "reqwest",
        "NetworkConnector",
        "SemanticStore",
    ] {
        assert!(
            !source.contains(forbidden),
            "egress policy leaked side effect {forbidden}"
        );
    }
}
