//! Typed forwarding to the sole Agent-owned database implementation.
use crate::ApplicationStore;
use rho_application::*;
use rho_contract::*;
impl AgentTaskRepository for ApplicationStore {
    fn project_agent_tasks(
        &self,
        scope: &AgentTaskScope,
        archived: Option<bool>,
        before: Option<&str>,
        limit: usize,
        native_host: &str,
        rho_host: &str,
        rho_live: &[String],
    ) -> Result<ProjectAgentTaskPage, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::project_agent_tasks(
            &self.1,
            scope,
            archived,
            before,
            limit,
            native_host,
            rho_host,
            rho_live,
        )
    }
    fn agent_task(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<StoredAgentTask>, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_task(&self.1, scope, id)
    }
    fn agent_tasks(
        &self,
        scope: &AgentTaskScope,
        archived: Option<bool>,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<StoredAgentTask>, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_tasks(&self.1, scope, archived, before, limit)
    }
    fn agent_task_counts(
        &self,
        scope: &AgentTaskScope,
        host: &str,
    ) -> Result<(u32, u32), AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_task_counts(&self.1, scope, host)
    }
    fn agent_draft(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<AgentTaskDraft, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_draft(&self.1, scope, id)
    }
    fn agent_receipt(
        &self,
        scope: &AgentTaskScope,
        id: &str,
    ) -> Result<Option<AgentCommandReceipt>, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_receipt(&self.1, scope, id)
    }
    fn agent_receipts(
        &self,
        scope: &AgentTaskScope,
        task: &str,
    ) -> Result<Vec<AgentCommandReceipt>, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_receipts(&self.1, scope, task)
    }
    fn agent_events(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        after: Option<u64>,
        before: Option<u64>,
        limit: usize,
    ) -> Result<AgentTaskEventPage, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_events(
            &self.1, scope, task, after, before, limit,
        )
    }
    fn agent_assets(
        &self,
        scope: &AgentTaskScope,
        task: &str,
    ) -> Result<Vec<AgentAsset>, AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_assets(&self.1, scope, task)
    }
    fn agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::agent_asset(&self.1, scope, task, asset)
    }
    fn put_agent_asset(
        &self,
        scope: &AgentTaskScope,
        task: &str,
        asset: &AgentAsset,
        bytes: &[u8],
    ) -> Result<(), AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::put_agent_asset(&self.1, scope, task, asset, bytes)
    }
    fn commit_agent_task(
        &self,
        scope: &AgentTaskScope,
        write: AgentTaskWrite<'_>,
    ) -> Result<(), AgentTaskError> {
        rho_agent_owner::AgentTaskRepository::commit_agent_task(&self.1, scope, write)
    }
}
