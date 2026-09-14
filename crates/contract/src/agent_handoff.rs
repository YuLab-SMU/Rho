//! Human-reviewed context transfer into an existing task draft. Never sends a turn.
use crate::{AgentContextSelection, AgentDraftContent, ApplicationWindowRef, ProjectAgentTaskRef};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentHandoffSourceSnapshot {
    pub source: ProjectAgentTaskRef,
    pub title: String,
    pub body: String,
    pub context: Vec<AgentContextSelection>,
    pub revision: String,
    pub truncated: bool,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentHandoffTargetSnapshot {
    pub target: ProjectAgentTaskRef,
    pub title: String,
    pub draft: AgentDraftContent,
    pub draft_version: u64,
    pub controller: ApplicationWindowRef,
    pub control_generation: Option<u64>,
    pub writable: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentHandoffsQuery {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub query: AgentHandoffQuery,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentHandoffQuery {
    Source { source: ProjectAgentTaskRef },
    Target { target: ProjectAgentTaskRef },
    Receipt { request_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentHandoffQueryResult {
    Source {
        source: AgentHandoffSourceSnapshot,
    },
    Target {
        target: AgentHandoffTargetSnapshot,
    },
    Receipt {
        receipt: Option<AgentHandoffReceipt>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentHandoffCommand {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub source: ProjectAgentTaskRef,
    pub source_revision: String,
    pub target: ProjectAgentTaskRef,
    pub target_draft_version: u64,
    pub target_control_generation: Option<u64>,
    pub body: String,
    pub context: Vec<AgentContextSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentHandoffReceipt {
    pub request_id: String,
    pub source: ProjectAgentTaskRef,
    pub target: ProjectAgentTaskRef,
    pub target_draft_version: u64,
    pub created_at_ms: u64,
}
