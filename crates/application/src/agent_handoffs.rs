//! Typed forwarding to the public Agent handoff owner and original atomic repository.
use crate::component_agents::bridge::{native_scope, public_scope, wire};
use crate::{ApplicationError, ApplicationScope, ComponentActor};
use rho_agent_owner::component::ComponentTaskError;
use rho_agent_owner::handoff as public;
use rho_contract::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub use public::{MAX_HANDOFF_BODY_BYTES, MAX_HANDOFF_CONTEXT};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAgentHandoff {
    pub input_digest: String,
    pub receipt: AgentHandoffReceipt,
}

/// The repository checks this source fingerprint and the target draft/controller
/// in the same transaction that writes the target and receipt.
pub struct AgentHandoffWrite<'a> {
    pub request: &'a AgentHandoffCommand,
    pub source_fingerprint: &'a str,
    pub input_digest: &'a str,
    pub draft: &'a AgentDraftContent,
    pub receipt: &'a AgentHandoffReceipt,
}

pub trait AgentHandoffRepository: Send + Sync {
    fn handoff_source(
        &self,
        scope: &ApplicationScope,
        source: &ProjectAgentTaskRef,
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError>;
    fn handoff_target(
        &self,
        scope: &ApplicationScope,
        target: &ProjectAgentTaskRef,
        window: &ApplicationWindowRef,
    ) -> Result<AgentHandoffTargetSnapshot, ApplicationError>;
    fn handoff_receipt(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
    ) -> Result<Option<StoredAgentHandoff>, ApplicationError>;
    fn commit_handoff(
        &self,
        scope: &ApplicationScope,
        write: AgentHandoffWrite<'_>,
    ) -> Result<AgentHandoffReceipt, ApplicationError>;
}

pub struct AgentHandoffOwner {
    inner: public::AgentHandoffOwner,
}

pub fn handoff_context_key(selection: &AgentContextSelection) -> Result<String, ApplicationError> {
    public::handoff_context_key(selection).map_err(Into::into)
}

pub fn handoff_source_fingerprint(
    source: &AgentHandoffSourceSnapshot,
) -> Result<String, ApplicationError> {
    public::handoff_source_fingerprint(&wire(source)?).map_err(Into::into)
}

pub fn handoff_source_expired() -> ApplicationError {
    public::handoff_source_expired().into()
}

impl AgentHandoffOwner {
    pub fn new(store: Arc<dyn AgentHandoffRepository>) -> Self {
        Self {
            inner: public::AgentHandoffOwner::new(Arc::new(RepositoryAdapter(store))),
        }
    }
    pub fn source(
        &self,
        scope: &ApplicationScope,
        source: &ProjectAgentTaskRef,
        extra_context: &[AgentContextSelection],
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
        wire(
            &self
                .inner
                .source(&public_scope(scope), source, extra_context)?,
        )
    }
    pub fn target(
        &self,
        scope: &ApplicationScope,
        target: &ProjectAgentTaskRef,
        window: &ApplicationWindowRef,
    ) -> Result<AgentHandoffTargetSnapshot, ApplicationError> {
        wire(
            &self
                .inner
                .target(&public_scope(scope), target, &wire(window)?)?,
        )
    }
    pub fn receipt(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
    ) -> Result<Option<AgentHandoffReceipt>, ApplicationError> {
        wire(&self.inner.receipt(&public_scope(scope), request_id)?)
    }
    pub fn transfer(
        &self,
        actor: &ComponentActor,
        request: &AgentHandoffCommand,
        extra_context: &[AgentContextSelection],
        now: u64,
    ) -> Result<AgentHandoffReceipt, ApplicationError> {
        wire(
            &self
                .inner
                .transfer(&actor.public(), &wire(request)?, extra_context, now)?,
        )
    }
}

struct RepositoryAdapter(Arc<dyn AgentHandoffRepository>);
impl public::AgentHandoffRepository for RepositoryAdapter {
    fn handoff_source(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        source: &ProjectAgentTaskRef,
    ) -> Result<rho_agent_api::handoff::AgentHandoffSourceSnapshot, ComponentTaskError> {
        wire(&self.0.handoff_source(&native_scope(scope), source)?).map_err(Into::into)
    }
    fn handoff_target(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        target: &ProjectAgentTaskRef,
        window: &rho_agent_api::AgentControllerRef,
    ) -> Result<rho_agent_api::handoff::AgentHandoffTargetSnapshot, ComponentTaskError> {
        wire(
            &self
                .0
                .handoff_target(&native_scope(scope), target, &wire(window)?)?,
        )
        .map_err(Into::into)
    }
    fn handoff_receipt(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        request_id: &str,
    ) -> Result<Option<public::StoredAgentHandoff>, ComponentTaskError> {
        wire(&self.0.handoff_receipt(&native_scope(scope), request_id)?).map_err(Into::into)
    }
    fn commit_handoff(
        &self,
        scope: &rho_agent_owner::AgentTaskScope,
        write: public::AgentHandoffWrite<'_>,
    ) -> Result<rho_agent_api::handoff::AgentHandoffReceipt, ComponentTaskError> {
        wire(&self.0.commit_handoff(
            &native_scope(scope),
            AgentHandoffWrite {
                request: &wire(write.request)?,
                source_fingerprint: write.source_fingerprint,
                input_digest: write.input_digest,
                draft: write.draft,
                receipt: &wire(write.receipt)?,
            },
        )?)
        .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests;
