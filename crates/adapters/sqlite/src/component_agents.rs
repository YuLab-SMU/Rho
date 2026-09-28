//! Typed forwarding to the sole Agent-owned database implementation.
use crate::ApplicationStore;
use crate::agent_storage::wire;
use rho_application::*;
use rho_contract::*;
impl ComponentAgentRepository for ApplicationStore {
    fn component_assets(
        &self,
        scope: &ApplicationScope,
        conversation: &str,
    ) -> Result<Vec<AgentAsset>, ApplicationError> {
        rho_agent_owner::component::ComponentAgentRepository::component_assets(
            &self.1,
            &scope.into(),
            conversation,
        )
        .map_err(Into::into)
    }
    fn component_asset(
        &self,
        scope: &ApplicationScope,
        conversation: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
        rho_agent_owner::component::ComponentAgentRepository::component_asset(
            &self.1,
            &scope.into(),
            conversation,
            asset,
        )
        .map_err(Into::into)
    }
    fn put_component_asset(
        &self,
        scope: &ApplicationScope,
        conversation: &str,
        asset: &AgentAsset,
        bytes: &[u8],
    ) -> Result<(), ApplicationError> {
        rho_agent_owner::component::ComponentAgentRepository::put_component_asset(
            &self.1,
            &scope.into(),
            conversation,
            asset,
            bytes,
        )
        .map_err(Into::into)
    }
    fn component_diagnostic(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentModelDiagnostic>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_diagnostic(
                &self.1,
                &s.into(),
                id,
            )?,
        )
    }
    fn component_diagnostics(
        &self,
        s: &ApplicationScope,
    ) -> Result<Vec<ComponentModelDiagnostic>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_diagnostics(
                &self.1,
                &s.into(),
            )?,
        )
    }
    fn write_component_diagnostic(
        &self,
        s: &ApplicationScope,
        expected: Option<u64>,
        diagnostic: &ComponentModelDiagnostic,
    ) -> Result<(), ApplicationError> {
        rho_agent_owner::component::ComponentAgentRepository::write_component_diagnostic(
            &self.1,
            &s.into(),
            expected,
            &wire(diagnostic)?,
        )
        .map_err(Into::into)
    }
    fn component_conversation(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<ComponentAgentConversation>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_conversation(
                &self.1,
                &s.into(),
                id,
            )?,
        )
    }
    fn component_conversations(
        &self,
        s: &ApplicationScope,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ComponentAgentConversation>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_conversations(
                &self.1,
                &s.into(),
                after,
                limit,
            )?,
        )
    }
    fn component_run(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_run(
                &self.1,
                &s.into(),
                id,
            )?,
        )
    }
    fn component_run_by_request(
        &self,
        s: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredComponentRun>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_run_by_request(
                &self.1,
                &s.into(),
                id,
            )?,
        )
    }
    fn component_run_history(
        &self,
        scope: &ApplicationScope,
        conversation: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(ComponentAgentRunSummary, String)>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_run_history(
                &self.1,
                &scope.into(),
                conversation,
                before,
                limit,
            )?,
        )
    }
    fn component_tools(
        &self,
        s: &ApplicationScope,
        run: &str,
    ) -> Result<Vec<StoredComponentTool>, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_tools(
                &self.1,
                &s.into(),
                run,
            )?,
        )
    }
    fn component_events(
        &self,
        s: &ApplicationScope,
        run: &str,
        after: u64,
        limit: usize,
    ) -> Result<ComponentAgentEventPage, ApplicationError> {
        wire(
            &rho_agent_owner::component::ComponentAgentRepository::component_events(
                &self.1,
                &s.into(),
                run,
                after,
                limit,
            )?,
        )
    }
    fn component_settings(
        &self,
        s: &ApplicationScope,
    ) -> Result<ComponentModelSettings, ApplicationError> {
        rho_agent_owner::component::ComponentAgentRepository::component_settings(&self.1, &s.into())
            .map_err(Into::into)
    }
    fn write_component_settings(
        &self,
        s: &ApplicationScope,
        expected: u64,
        settings: &ComponentModelSettings,
    ) -> Result<(), ApplicationError> {
        rho_agent_owner::component::ComponentAgentRepository::write_component_settings(
            &self.1,
            &s.into(),
            expected,
            settings,
        )
        .map_err(Into::into)
    }
    fn commit_component(
        &self,
        s: &ApplicationScope,
        write: ComponentWrite<'_>,
    ) -> Result<(), ApplicationError> {
        let conversation = wire(write.conversation)?;
        let run: Option<_> = write.run.map(wire).transpose()?;
        let tools: Vec<_> = wire(write.tools)?;
        let events: Vec<_> = wire(write.events)?;
        rho_agent_owner::component::ComponentAgentRepository::commit_component(
            &self.1,
            &s.into(),
            rho_agent_owner::component::ComponentWrite {
                expected_version: write.expected_version,
                conversation: &conversation,
                run: run.as_ref(),
                tools: &tools,
                events: &events,
            },
        )
        .map_err(Into::into)
    }
}
