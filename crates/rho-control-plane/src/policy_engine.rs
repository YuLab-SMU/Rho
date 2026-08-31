use rho_protocol::{
    BrokerDecisionKind, CapabilityId, DataClass, DestinationClass, ExpectedRevisions,
    NetworkPolicy, OperationId, PermissionPosture, PolicyDecision, PolicyInput, SecretPurpose,
};
use serde::{Deserialize, Serialize};

use crate::{CapabilityRegistry, CapabilityRegistryError};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderState {
    Ready,
    ReadOnlyExternalObserver,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum PolicyPrecedence {
    Allow = 0,
    Ask = 1,
    Deny = 2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyObligations {
    pub approval_scope: Option<String>,
    pub redaction_required: bool,
    pub executor_network: NetworkPolicy,
    pub secret_purpose: Option<SecretPurpose>,
    pub audit_priority: rho_protocol::EventPriority,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyDecisionReport {
    pub decision: PolicyDecision,
    pub user_summary: String,
    pub obligations: PolicyObligations,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyEvaluationContext {
    pub input: PolicyInput,
    pub expected_revisions: ExpectedRevisions,
    pub provider_state: ProviderState,
    pub provider_auto_approve_hint: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyRuleId {
    UnknownProviderState,
    UnsupportedCapability,
    ReadOnlyExternalObserver,
    UnrestrictedNetworkDenied,
    ConfidentialExternalEgress,
    MutationNeedsApproval,
    ExternalEffectNeedsApproval,
    PureLocalReadAllowed,
    DefaultDeny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuleOutcome {
    precedence: PolicyPrecedence,
    decision: BrokerDecisionKind,
    reason_code: &'static str,
    user_summary: &'static str,
    obligations: PolicyObligations,
}

pub const DEFAULT_POLICY_RULES: [PolicyRuleId; 9] = [
    PolicyRuleId::UnknownProviderState,
    PolicyRuleId::UnsupportedCapability,
    PolicyRuleId::ReadOnlyExternalObserver,
    PolicyRuleId::UnrestrictedNetworkDenied,
    PolicyRuleId::ConfidentialExternalEgress,
    PolicyRuleId::MutationNeedsApproval,
    PolicyRuleId::ExternalEffectNeedsApproval,
    PolicyRuleId::PureLocalReadAllowed,
    PolicyRuleId::DefaultDeny,
];

pub fn evaluate_policy(
    registry: &CapabilityRegistry,
    context: &PolicyEvaluationContext,
) -> PolicyDecisionReport {
    evaluate_policy_with_rules(registry, context, &DEFAULT_POLICY_RULES)
}

pub fn evaluate_policy_with_rules(
    registry: &CapabilityRegistry,
    context: &PolicyEvaluationContext,
    rules: &[PolicyRuleId],
) -> PolicyDecisionReport {
    let capability = registry.descriptor(&context.input.capability_id).ok();
    let mut best = None::<RuleOutcome>;
    for rule in rules {
        if let Some(outcome) = evaluate_rule(registry, capability, context, *rule) {
            let replace = best
                .as_ref()
                .is_none_or(|current| outcome.precedence > current.precedence);
            if replace {
                best = Some(outcome);
            }
        }
    }
    let outcome = best.unwrap_or_else(|| default_deny(context.input.destination));
    let mut decision = PolicyDecision::new(
        context.input.operation.operation_id.clone(),
        outcome.decision,
        outcome.reason_code,
    );
    if outcome.decision == BrokerDecisionKind::Ask {
        decision.required_user_facts.push(
            outcome
                .obligations
                .approval_scope
                .clone()
                .unwrap_or_else(|| "review_exact_effect".to_string()),
        );
    }
    PolicyDecisionReport {
        decision,
        user_summary: outcome.user_summary.to_string(),
        obligations: outcome.obligations,
    }
}

fn evaluate_rule(
    registry: &CapabilityRegistry,
    capability: Option<&crate::RegisteredCapability>,
    context: &PolicyEvaluationContext,
    rule: PolicyRuleId,
) -> Option<RuleOutcome> {
    match rule {
        PolicyRuleId::UnknownProviderState if context.provider_state == ProviderState::Unknown => {
            Some(deny(
                "unknown_provider_state",
                "Provider state is unknown",
                context.input.destination,
            ))
        }
        PolicyRuleId::UnsupportedCapability
            if unsupported_capability(registry, &context.input.capability_id) =>
        {
            Some(deny(
                "unsupported_capability",
                "Capability is not registered",
                context.input.destination,
            ))
        }
        PolicyRuleId::ReadOnlyExternalObserver
            if context.provider_state == ProviderState::ReadOnlyExternalObserver
                && capability.is_some_and(|entry| {
                    entry.descriptor.effect_class != rho_protocol::EffectClass::Read
                }) =>
        {
            Some(deny(
                "read_only_external_observer",
                "Read-only external observers cannot perform mutations",
                context.input.destination,
            ))
        }
        PolicyRuleId::UnrestrictedNetworkDenied
            if context.input.destination == DestinationClass::UnrestrictedNetwork =>
        {
            Some(deny(
                "unrestricted_network_denied",
                "Unrestricted network access requires an explicit higher-level authorization",
                context.input.destination,
            ))
        }
        PolicyRuleId::ConfidentialExternalEgress
            if context.input.data_class >= DataClass::ProjectConfidential
                && matches!(
                    context.input.destination,
                    DestinationClass::AllowlistedDomain | DestinationClass::ConfiguredProvider
                ) =>
        {
            Some(ask(
                "confidential_external_egress",
                "Project-confidential data may leave the workspace only after exact review",
                "approve_confidential_egress",
                context.input.destination,
            ))
        }
        PolicyRuleId::MutationNeedsApproval
            if context.input.permission_posture == PermissionPosture::AskBeforeChanges
                && capability.is_some_and(|entry| {
                    entry.descriptor.effect_class != rho_protocol::EffectClass::Read
                }) =>
        {
            Some(ask(
                "mutation_requires_approval",
                "Workspace or project mutation requires approval",
                "approve_exact_mutation",
                context.input.destination,
            ))
        }
        PolicyRuleId::ExternalEffectNeedsApproval
            if capability.is_some_and(|entry| {
                entry.descriptor.effect_class == rho_protocol::EffectClass::ExternalEffect
            }) =>
        {
            Some(ask(
                "external_effect_requires_approval",
                "External effects require review",
                "approve_external_effect",
                context.input.destination,
            ))
        }
        PolicyRuleId::PureLocalReadAllowed
            if capability.is_some_and(|entry| {
                entry.descriptor.effect_class == rho_protocol::EffectClass::Read
            }) && matches!(
                context.input.destination,
                DestinationClass::LocalWorkspace | DestinationClass::LocalSandbox
            ) =>
        {
            Some(allow(
                "local_read",
                "Local read is allowed",
                context.input.destination,
            ))
        }
        PolicyRuleId::DefaultDeny => None,
        _ => None,
    }
}

fn unsupported_capability(registry: &CapabilityRegistry, id: &CapabilityId) -> bool {
    matches!(
        registry.descriptor(id),
        Err(CapabilityRegistryError::NotFound(_))
    )
}

fn allow(
    reason_code: &'static str,
    summary: &'static str,
    destination: DestinationClass,
) -> RuleOutcome {
    RuleOutcome {
        precedence: PolicyPrecedence::Allow,
        decision: BrokerDecisionKind::Allow,
        reason_code,
        user_summary: summary,
        obligations: obligations(None, false, destination, rho_protocol::EventPriority::P2),
    }
}

fn ask(
    reason_code: &'static str,
    summary: &'static str,
    approval_scope: &'static str,
    destination: DestinationClass,
) -> RuleOutcome {
    RuleOutcome {
        precedence: PolicyPrecedence::Ask,
        decision: BrokerDecisionKind::Ask,
        reason_code,
        user_summary: summary,
        obligations: obligations(
            Some(approval_scope.to_string()),
            true,
            destination,
            rho_protocol::EventPriority::P0,
        ),
    }
}

fn deny(
    reason_code: &'static str,
    summary: &'static str,
    destination: DestinationClass,
) -> RuleOutcome {
    RuleOutcome {
        precedence: PolicyPrecedence::Deny,
        decision: BrokerDecisionKind::Deny,
        reason_code,
        user_summary: summary,
        obligations: obligations(None, true, destination, rho_protocol::EventPriority::P0),
    }
}

fn default_deny(destination: DestinationClass) -> RuleOutcome {
    deny(
        "default_deny",
        "No policy rule allowed the effect",
        destination,
    )
}

fn obligations(
    approval_scope: Option<String>,
    redaction_required: bool,
    destination: DestinationClass,
    audit_priority: rho_protocol::EventPriority,
) -> PolicyObligations {
    PolicyObligations {
        approval_scope,
        redaction_required,
        executor_network: match destination {
            DestinationClass::LocalWorkspace | DestinationClass::LocalSandbox => {
                NetworkPolicy::Deny
            }
            DestinationClass::ConfiguredProvider => NetworkPolicy::ProviderOnly,
            DestinationClass::AllowlistedDomain => NetworkPolicy::AllowlistedDomains,
            DestinationClass::UnrestrictedNetwork => NetworkPolicy::UnrestrictedWithApproval,
            DestinationClass::RemoteExecutor => NetworkPolicy::Deny,
        },
        secret_purpose: None,
        audit_priority,
    }
}

pub fn stable_policy_reason(decision: &PolicyDecisionReport) -> (&str, &str) {
    (&decision.decision.reason_code, &decision.user_summary)
}

pub fn policy_context_fixture(
    capability_id: CapabilityId,
    operation_id: OperationId,
) -> PolicyEvaluationContext {
    let provider = rho_protocol::ProviderCapabilitySnapshot {
        provider_id: rho_protocol::ProviderId::new("provider_main").unwrap(),
        snapshot_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            .to_string(),
        capability_ids: vec![capability_id.clone()],
    };
    let expected_revisions = ExpectedRevisions {
        workspace_id: rho_protocol::WorkspaceId::new("workspace_policy").unwrap(),
        kernel_instance_id: rho_protocol::KernelInstanceId::new("kernel_policy").unwrap(),
        state_revision: rho_protocol::StateRevision(4),
        project_revision: rho_protocol::ProjectRevision(2),
    };
    let operation = rho_protocol::OperationContext {
        operation_id,
        expected_revisions: expected_revisions.clone(),
        causality: rho_protocol::Causality {
            correlation_id: rho_protocol::CorrelationId::new("correlation_policy").unwrap(),
            causation_id: None,
            trace_id: rho_protocol::TraceId::new("trace_policy").unwrap(),
        },
    };
    PolicyEvaluationContext {
        input: PolicyInput::new(
            rho_protocol::Actor {
                kind: rho_protocol::ActorKind::User,
                id: "user".to_string(),
            },
            operation,
            capability_id,
            serde_json::json!({"code": "x <- 1"}),
            rho_protocol::WorkspaceId::new("workspace_policy").unwrap(),
            provider,
        ),
        expected_revisions,
        provider_state: ProviderState::Ready,
        provider_auto_approve_hint: false,
    }
}
