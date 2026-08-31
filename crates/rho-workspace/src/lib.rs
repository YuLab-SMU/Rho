#![forbid(unsafe_code)]
//! Target owner for the authenticated Workspace R bridge and WorkspaceExecutor adapter.

pub mod executor;
pub mod revisions;

pub use executor::*;
pub use revisions::*;

use rho_protocol::{RUN_R_CAPABILITY, RevisionStamp};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> WorkspaceBoundary {
    WorkspaceBoundary {
        owns: &[
            "workspace_r_bridge",
            "revision_observation",
            "workspace_executor_adapter",
        ],
        does_not_own: &[
            "agent_credentials",
            "broker_policy",
            "project_patch_authority",
        ],
    }
}

pub fn run_r_capability_id() -> &'static str {
    RUN_R_CAPABILITY
}

pub fn revision_is_bound_to_kernel(revision: &RevisionStamp) -> bool {
    !revision.kernel_instance_id.as_str().is_empty()
}
