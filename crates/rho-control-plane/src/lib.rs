#![forbid(unsafe_code)]
//! Typed capability dispatch, journaled project commits and passive observation.

pub mod capability_registry;
pub mod operation_monitor;
pub mod project_commit;

pub use capability_registry::*;
pub use operation_monitor::*;
pub use project_commit::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlPlaneBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> ControlPlaneBoundary {
    ControlPlaneBoundary {
        owns: &[
            "capability_contract_validation",
            "journaled_project_commit",
            "passive_operation_observation",
        ],
        does_not_own: &[
            "agent_strategy",
            "permission_decisions",
            "executor_mechanics",
            "ui_projection",
        ],
    }
}
