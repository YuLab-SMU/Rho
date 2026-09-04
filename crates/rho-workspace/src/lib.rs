#![forbid(unsafe_code)]
//! Target owner for the authenticated Workspace R bridge.

pub mod environment;

pub use environment::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> WorkspaceBoundary {
    WorkspaceBoundary {
        owns: &["workspace_environment_binding_state"],
        does_not_own: &[
            "agent_credentials",
            "broker_policy",
            "project_patch_authority",
        ],
    }
}
