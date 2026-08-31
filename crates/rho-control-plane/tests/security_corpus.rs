use rho_control_plane::*;
use rho_protocol::*;

#[test]
fn security_corpus_denied_attempt_is_p0_fact_without_attack_payload_or_secret() {
    let payload =
        security_violation_payload("external_observer_boundary", "mutation_capability_denied")
            .unwrap();
    assert_eq!(security_violation_priority(), EventPriority::P0);
    let encoded = serde_json::to_string(&payload).unwrap();
    assert!(encoded.contains("security_violation"));
    assert!(!encoded.contains("CANARY_SECURITY_SECRET"));
    assert!(!encoded.contains("rm -rf"));
    assert_eq!(
        security_violation_payload(
            "external_observer_boundary",
            "CANARY_SECURITY_SECRET raw attack payload",
        )
        .unwrap_err(),
        SecurityEventError::InvalidCode
    );
}
