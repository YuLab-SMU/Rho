//! Transitional Host queries and admitted window envelopes for the Agent owner.
use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentTasksQuery {
    pub project_root: String,
    pub query: AgentTaskQuery,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentTaskQuery {
    ScientificWork { task_id: String, limit: u32 },
    ProjectList {
        archived: Option<bool>,
        before: Option<String>,
        limit: u32,
    },
    ContextSources,
    ContextSearch {
        window: ApplicationWindowRef,
        source: Option<String>,
        text: String,
        limit: u32,
    },
    ContextPreview {
        window: ApplicationWindowRef,
        selection: AgentContextSelection,
    },
    NativeHistory {
        task_id: String,
        cursor: Option<String>,
        limit: u32,
    },
    List {
        archived: Option<bool>,
        before: Option<String>,
        limit: u32,
    },
    Get {
        task_id: String,
    },
    Events {
        task_id: String,
        after: Option<u64>,
        before: Option<u64>,
        limit: u32,
    },
    Receipt {
        request_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentTaskQueryResult {
    ScientificWork { work: crate::AgentScientificWork },
    ProjectList { page: crate::ProjectAgentTaskPage },
    ContextSources {
        sources: Vec<AgentContextSource>,
    },
    ContextItems {
        items: Vec<AgentContextItem>,
        notices: Vec<String>,
    },
    ContextPreview {
        preview: AgentContextPreview,
    },
    NativeHistory {
        page: AgentNativeHistoryPage,
    },
    List {
        tasks: Vec<AgentTaskSummary>,
        attention: Vec<AgentTaskSummary>,
        next: Option<String>,
        running: u32,
        permissions: u32,
    },
    Detail {
        detail: Box<AgentTaskDetail>,
    },
    Events {
        page: AgentTaskEventPage,
    },
    Receipt {
        receipt: Option<AgentCommandReceipt>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct AgentTasksCommand {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub command: AgentTaskCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TestAgent {
    pub project_root: String,
    pub window: ApplicationWindowRef,
    pub request_id: String,
    pub provider: AgentProvider,
    pub model: String,
    pub effort: Option<String>,
    #[serde(default)]
    pub observe_only: bool,
}

impl From<AgentTasksCommand> for AgentTaskRequest {
    fn from(request: AgentTasksCommand) -> Self {
        Self { project_root: request.project_root, window: request.window.into(),
            request_id: request.request_id, command: request.command }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_agent_request_preserves_captured_wire_bytes_and_controller() {
        let request = AgentTasksCommand {
            project_root: "/study".into(),
            window: ApplicationWindowRef { window_id: "window".into(), incarnation: "incarnation".into() },
            request_id: "original-request".into(),
            command: AgentTaskCommand::SaveDraft {
                control: AgentTaskControl { task_id: "task".into(), generation: 7 },
                version: 3,
                content: AgentDraftContent { text: "编辑分支\n".into(), assets: vec![], context: vec![
                    AgentContextSelection { source: "plugins.source".into(), label: "Captured branch".into(),
                        reference: serde_json::json!({"draft":"source", "version":"observed"}), inclusion: "reference".into() }
                ] },
            },
        };
        let captured = serde_json::to_vec(&request).unwrap();
        let public = AgentTaskRequest::from(request);
        assert_eq!(serde_json::to_vec(&public).unwrap(), captured);
        assert_eq!(public.window.incarnation, "incarnation");
        let decoded: AgentTasksCommand = serde_json::from_slice(&captured).unwrap();
        assert_eq!(ApplicationWindowRef::from(public.window), decoded.window);
    }
}
