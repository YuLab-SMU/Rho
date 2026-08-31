use rho_protocol::{DataClass, TurnId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EgressPolicyMode {
    Deny,
    ProviderOnly {
        configured_origin: String,
    },
    Allowlisted {
        origins: Vec<String>,
    },
    UnrestrictedWithExactApproval {
        approval_turn_id: TurnId,
        approval_origin: String,
        expires_at_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EgressPolicyRequest {
    pub turn_id: TurnId,
    pub destination_origin: String,
    pub data_class: DataClass,
    pub mode: EgressPolicyMode,
    pub now_ms: u64,
    pub platform_enforcement_available: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EgressDecisionKind {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EgressDecision {
    pub decision: EgressDecisionKind,
    pub reason_code: String,
    pub enforcement_required: bool,
    pub user_summary: String,
}

pub fn evaluate_egress(request: &EgressPolicyRequest) -> EgressDecision {
    if !request.platform_enforcement_available {
        return deny(
            "network_enforcement_unavailable",
            "Network remains denied because platform enforcement is unavailable",
        );
    }
    if request.destination_origin.is_empty() || !request.destination_origin.starts_with("https://")
    {
        return deny("invalid_destination", "Network destination is invalid");
    }
    if request.data_class == DataClass::RestrictedSecret {
        return deny(
            "restricted_secret_egress_denied",
            "Restricted secret data cannot leave the Broker",
        );
    }
    match &request.mode {
        EgressPolicyMode::Deny => deny("network_default_deny", "Network access is disabled"),
        EgressPolicyMode::ProviderOnly { configured_origin } => {
            if configured_origin == &request.destination_origin {
                allow(
                    "configured_provider_channel",
                    "Request uses the configured Provider channel",
                )
            } else {
                deny(
                    "provider_only_destination_mismatch",
                    "Provider-only access cannot contact an arbitrary destination",
                )
            }
        }
        EgressPolicyMode::Allowlisted { origins } => {
            if origins.contains(&request.destination_origin) {
                if request.data_class == DataClass::ProjectConfidential {
                    ask(
                        "confidential_allowlisted_egress_review",
                        "Review confidential project data before external transfer",
                    )
                } else {
                    allow("allowlisted_destination", "Destination is allowlisted")
                }
            } else if request.data_class >= DataClass::ProjectConfidential {
                ask(
                    "confidential_unapproved_destination",
                    "Confidential project data requires exact destination approval",
                )
            } else {
                deny(
                    "destination_not_allowlisted",
                    "Destination is not allowlisted",
                )
            }
        }
        EgressPolicyMode::UnrestrictedWithExactApproval {
            approval_turn_id,
            approval_origin,
            expires_at_ms,
        } => {
            if approval_turn_id == &request.turn_id
                && approval_origin == &request.destination_origin
                && request.now_ms <= *expires_at_ms
            {
                allow(
                    "exact_unrestricted_approval",
                    "Exact turn and destination approval is active",
                )
            } else {
                ask(
                    "unrestricted_approval_required",
                    "Unrestricted access requires a fresh exact approval",
                )
            }
        }
    }
}

fn allow(code: &str, summary: &str) -> EgressDecision {
    EgressDecision {
        decision: EgressDecisionKind::Allow,
        reason_code: code.to_string(),
        enforcement_required: true,
        user_summary: summary.to_string(),
    }
}

fn ask(code: &str, summary: &str) -> EgressDecision {
    EgressDecision {
        decision: EgressDecisionKind::Ask,
        reason_code: code.to_string(),
        enforcement_required: true,
        user_summary: summary.to_string(),
    }
}

fn deny(code: &str, summary: &str) -> EgressDecision {
    EgressDecision {
        decision: EgressDecisionKind::Deny,
        reason_code: code.to_string(),
        enforcement_required: true,
        user_summary: summary.to_string(),
    }
}
