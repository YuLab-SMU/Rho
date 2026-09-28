//! Typed forwarding to the sole Agent-owned database implementation.
use crate::ApplicationStore;
use crate::agent_storage::wire;
use rho_application::*;
use rho_contract::*;
impl AgentHandoffRepository for ApplicationStore {
    fn handoff_source(
        &self,
        scope: &ApplicationScope,
        reference: &ProjectAgentTaskRef,
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
        wire(
            &rho_agent_owner::handoff::AgentHandoffRepository::handoff_source(
                &self.1,
                &scope.into(),
                reference,
            )?,
        )
    }
    fn handoff_target(
        &self,
        scope: &ApplicationScope,
        reference: &ProjectAgentTaskRef,
        window: &ApplicationWindowRef,
    ) -> Result<AgentHandoffTargetSnapshot, ApplicationError> {
        wire(
            &rho_agent_owner::handoff::AgentHandoffRepository::handoff_target(
                &self.1,
                &scope.into(),
                reference,
                &wire(window)?,
            )?,
        )
    }
    fn handoff_receipt(
        &self,
        scope: &ApplicationScope,
        id: &str,
    ) -> Result<Option<StoredAgentHandoff>, ApplicationError> {
        wire(
            &rho_agent_owner::handoff::AgentHandoffRepository::handoff_receipt(
                &self.1,
                &scope.into(),
                id,
            )?,
        )
    }
    fn commit_handoff(
        &self,
        scope: &ApplicationScope,
        write: AgentHandoffWrite<'_>,
    ) -> Result<AgentHandoffReceipt, ApplicationError> {
        wire(
            &rho_agent_owner::handoff::AgentHandoffRepository::commit_handoff(
                &self.1,
                &scope.into(),
                rho_agent_owner::handoff::AgentHandoffWrite {
                    request: &wire(write.request)?,
                    source_fingerprint: write.source_fingerprint,
                    input_digest: write.input_digest,
                    draft: write.draft,
                    receipt: &wire(write.receipt)?,
                },
            )?,
        )
    }
}
