#![forbid(unsafe_code)]
//! Least-privileged snapshot, staging, process, and network boundary for Agents.

pub mod network;
pub mod platform;
pub mod process;
pub mod snapshot;
pub mod staging;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandboxBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> SandboxBoundary {
    SandboxBoundary {
        owns: &[
            "immutable_snapshot",
            "isolated_process",
            "staging",
            "network_enforcement",
        ],
        does_not_own: &[
            "broker_authority",
            "live_project_identity",
            "workspace_state",
            "secret_persistence",
        ],
    }
}
