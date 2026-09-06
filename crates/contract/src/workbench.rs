use crate::{CapabilityDescriptor, SessionFrame};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Hosting metadata only. Scientific state is queried through HostRequest.
#[derive(Debug, Serialize, TS)]
pub struct WorkbenchInfo {
    pub project_root: Option<String>,
    pub runtime: String,
    pub capabilities: Vec<CapabilityDescriptor>,
}

/// A stale browser must not silently act on a newly selected project.
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkbenchFrame {
    pub project_root: String,
    pub frame: SessionFrame,
}

/// Changes hosting configuration, not a scientific capability or an Agent plan.
#[derive(Debug, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct SelectProject {
    pub project_root: String,
}
