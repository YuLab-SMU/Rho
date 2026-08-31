#![forbid(unsafe_code)]
//! Target owner for Broker admission, policy authority and service orchestration.

pub mod agent_port;
pub mod broker;
pub mod capability_registry;
pub mod composition;
pub mod controlled_mutation;
pub mod information_flow;
pub mod policy;
pub mod policy_engine;
pub mod project_commit;
pub mod security;

pub use agent_port::*;
pub use broker::*;
pub use capability_registry::*;
pub use composition::*;
pub use controlled_mutation::*;
pub use information_flow::*;
pub use policy::*;
pub use policy_engine::*;
pub use project_commit::*;
pub use security::*;

use rho_protocol::{BrokerDecisionKind, PolicyDecision, PolicyInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlPlaneBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> ControlPlaneBoundary {
    ControlPlaneBoundary {
        owns: &[
            "broker_admission",
            "policy_decision",
            "capability_dispatch",
            "service_orchestration",
        ],
        does_not_own: &["agent_strategy", "executor_mechanics", "ui_projection"],
    }
}

pub fn deny_policy(input: &PolicyInput, reason_code: impl Into<String>) -> PolicyDecision {
    PolicyDecision::new(
        input.operation.operation_id.clone(),
        BrokerDecisionKind::Deny,
        reason_code,
    )
}
