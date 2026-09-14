//! A read projection of existing task owners, not a third task lifecycle.
use crate::AgentProvider;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectAgentTaskRef {
    Native { task_id: String },
    Rho { conversation_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectAgentTaskSummary {
    pub reference: ProjectAgentTaskRef,
    /// None denotes Rho; native transport identity remains unchanged.
    pub provider: Option<AgentProvider>,
    pub title: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub archived: bool,
    pub state: String,
    pub has_draft: bool,
    pub permissions: u32,
    pub attention_reason: Option<String>,
    pub history_gap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProjectAgentTaskPage {
    pub attention_count: u32,
    pub tasks: Vec<ProjectAgentTaskSummary>,
    pub attention: Vec<ProjectAgentTaskSummary>,
    pub next: Option<String>,
    pub running: u32,
    pub permissions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentScientificWork {
    pub task_id: String,
    pub attributable: bool,
    pub operations: Vec<crate::OperationSummary>,
    pub has_more: bool,
}
