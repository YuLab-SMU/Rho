use rho_control_plane::*;
use rho_protocol::*;
use serde_json::json;

fn context(capability: &str, operation: &str) -> PolicyEvaluationContext {
    policy_context_fixture(
        CapabilityId::new(capability).unwrap(),
        OperationId::new(operation).unwrap(),
    )
}

#[test]
fn policy_allows_pure_local_read_without_provider_hint() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut context = context("workspace.inspect", "operation_policy_read");
    context.input.destination = DestinationClass::LocalWorkspace;
    context.input.data_class = DataClass::ProjectConfidential;

    let decision = evaluate_policy(&registry, &context);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Allow);
    assert_eq!(
        stable_policy_reason(&decision),
        ("local_read", "Local read is allowed")
    );
    assert_eq!(decision.obligations.executor_network, NetworkPolicy::Deny);
}

#[test]
fn policy_provider_auto_approve_hint_never_becomes_allow_condition() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut context = context(RUN_R_CAPABILITY, "operation_policy_run_r");
    context.provider_auto_approve_hint = true;

    let decision = evaluate_policy(&registry, &context);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Ask);
    assert_eq!(decision.decision.reason_code, "mutation_requires_approval");
    assert_eq!(
        decision.obligations.approval_scope.as_deref(),
        Some("approve_exact_mutation")
    );
}

#[test]
fn policy_project_confidential_to_external_destination_requires_review() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut context = context("network.fetch", "operation_policy_network");
    context.input.destination = DestinationClass::AllowlistedDomain;
    context.input.data_class = DataClass::ProjectConfidential;

    let decision = evaluate_policy(&registry, &context);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Ask);
    assert_eq!(
        decision.decision.reason_code,
        "confidential_external_egress"
    );
    assert_eq!(
        decision.obligations.executor_network,
        NetworkPolicy::AllowlistedDomains
    );
}

#[test]
fn policy_unrestricted_network_and_unknown_provider_are_denied() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut unrestricted = context("network.fetch", "operation_policy_unrestricted");
    unrestricted.input.destination = DestinationClass::UnrestrictedNetwork;
    let decision = evaluate_policy(&registry, &unrestricted);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Deny);
    assert_eq!(decision.decision.reason_code, "unrestricted_network_denied");

    let mut unknown = context("workspace.inspect", "operation_policy_unknown_provider");
    unknown.provider_state = ProviderState::Unknown;
    let decision = evaluate_policy(&registry, &unknown);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Deny);
    assert_eq!(decision.decision.reason_code, "unknown_provider_state");
}

#[test]
fn policy_read_only_external_observer_cannot_mutate() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut context = context(RUN_R_CAPABILITY, "operation_policy_read_only");
    context.provider_state = ProviderState::ReadOnlyExternalObserver;

    let decision = evaluate_policy(&registry, &context);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Deny);
    assert_eq!(decision.decision.reason_code, "read_only_external_observer");
}

#[test]
fn policy_rule_order_independence_uses_explicit_precedence() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut context = context("network.fetch", "operation_policy_precedence");
    context.input.destination = DestinationClass::UnrestrictedNetwork;
    context.input.data_class = DataClass::ProjectConfidential;

    let forward = evaluate_policy_with_rules(&registry, &context, &DEFAULT_POLICY_RULES);
    let mut reversed = DEFAULT_POLICY_RULES.to_vec();
    reversed.reverse();
    let reverse = evaluate_policy_with_rules(&registry, &context, &reversed);
    assert_eq!(forward.decision.decision, reverse.decision.decision);
    assert_eq!(forward.decision.reason_code, reverse.decision.reason_code);
}

#[test]
fn policy_unknown_capability_is_default_hard_deny() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let context = context("workspace.unknown", "operation_policy_unknown_capability");

    let decision = evaluate_policy(&registry, &context);
    assert_eq!(decision.decision.decision, BrokerDecisionKind::Deny);
    assert_eq!(decision.decision.reason_code, "unsupported_capability");
}

#[test]
fn policy_reason_and_summary_are_stable_and_do_not_leak_secret_arguments() {
    let registry = CapabilityRegistry::canonical().unwrap();
    let mut context = context(RUN_R_CAPABILITY, "operation_policy_canary");
    context.input.arguments = json!({"code": "Sys.getenv('CANARY_SECRET_123')"});

    let decision = evaluate_policy(&registry, &context);
    let encoded = serde_json::to_string(&decision).unwrap();
    assert!(!encoded.contains("CANARY_SECRET_123"));
    assert_eq!(
        stable_policy_reason(&decision).0,
        "mutation_requires_approval"
    );
    assert!(!decision.user_summary.is_empty());
}

#[test]
fn policy_engine_has_no_network_store_mutation_or_agent_callback() {
    let source = include_str!("../src/policy_engine.rs");
    for forbidden in [
        "reqwest",
        "ureq",
        "rho_store::",
        "AgentCallback",
        ".execute(",
    ] {
        assert!(
            !source.contains(forbidden),
            "policy engine leaked side effect: {forbidden}"
        );
    }
}
