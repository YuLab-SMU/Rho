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

/// Ephemeral transport observations for the selected Host. No credentials,
/// conversation content or scientific operation results are stored here.
#[derive(Debug, Clone, Serialize, TS)]
pub struct WorkbenchAgentConnection {
    pub project_root: Option<String>,
    pub endpoint: String,
    pub suggested_server_name: String,
    pub observed_at_ms: u64,
    pub active_sessions: usize,
    /// At most 64 recent sessions. An open session is not proof of a live task.
    pub sessions: Vec<McpSessionObservation>,
    pub history_truncated: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct McpSessionObservation {
    /// A local display reference, never the MCP transport credential/session ID.
    pub connection_id: String,
    pub client_reported_name: Option<String>,
    pub client_reported_version: Option<String>,
    pub initialized_at_ms: u64,
    pub last_request_at_ms: u64,
    pub closed_at_ms: Option<u64>,
    /// Successful bounded response prepared for this client, not a delivery or
    /// model-consumption acknowledgement and not scientific verification.
    pub overview_served_at_ms: Option<u64>,
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
