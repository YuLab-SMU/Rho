//! Human-reviewed transfer into the existing draft owners, with one atomic receipt.
use crate::AgentTaskScope as ApplicationScope;
use crate::component::{ComponentActor, ComponentTaskError as ApplicationError, component_digest};
use rho_agent_api::component::{Diagnostic, DiagnosticCode, DiagnosticContinuation};
use rho_agent_api::handoff::*;
use rho_agent_api::{
    AgentContextSelection, AgentControllerRef as ApplicationWindowRef, AgentDraftContent,
    ProjectAgentTaskRef,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

pub const MAX_HANDOFF_BODY_BYTES: usize = 16 * 1024;
pub const MAX_HANDOFF_CONTEXT: usize = 16;

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
    store: Arc<dyn AgentHandoffRepository>,
}

pub fn handoff_context_key(selection: &AgentContextSelection) -> Result<String, ApplicationError> {
    component_digest(&(
        &selection.source,
        &selection.reference,
        &selection.inclusion,
    ))
}

pub fn handoff_source_fingerprint(
    source: &AgentHandoffSourceSnapshot,
) -> Result<String, ApplicationError> {
    component_digest(&(
        &source.source,
        &source.title,
        &source.body,
        &source.context,
        source.truncated,
        &source.notices,
    ))
}

pub fn handoff_source_expired() -> ApplicationError {
    ApplicationError::Diagnostic(Box::new(Diagnostic {
        code: DiagnosticCode::ObservationExpired,
        continuation: DiagnosticContinuation::RefreshObservation,
        message: "The source task changed; refresh its handoff material before transferring".into(),
        next_reads: vec![],
    }))
}

fn valid_ref(reference: &ProjectAgentTaskRef) -> bool {
    let id = match reference {
        ProjectAgentTaskRef::Native { task_id } => task_id,
        ProjectAgentTaskRef::Rho { conversation_id } => conversation_id,
    };
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

impl AgentHandoffOwner {
    pub fn new(store: Arc<dyn AgentHandoffRepository>) -> Self {
        Self { store }
    }

    /// extra_context is supplied only by Host after reading the real scientific
    /// owners. It is not a field in the browser command or model output.
    pub fn source(
        &self,
        scope: &ApplicationScope,
        source: &ProjectAgentTaskRef,
        extra_context: &[AgentContextSelection],
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
        if !valid_ref(source) {
            return Err(ApplicationError::NotFound);
        }
        let material = self.store.handoff_source(scope, source)?;
        Self::include_context(material, extra_context)
    }

    fn include_context(
        mut material: AgentHandoffSourceSnapshot,
        extra_context: &[AgentContextSelection],
    ) -> Result<AgentHandoffSourceSnapshot, ApplicationError> {
        let mut seen = material
            .context
            .iter()
            .map(handoff_context_key)
            .collect::<Result<BTreeSet<_>, _>>()?;
        for selection in extra_context {
            if selection.source == "attachments" {
                continue;
            }
            if !seen.insert(handoff_context_key(selection)?) {
                continue;
            }
            if material.context.len() >= MAX_HANDOFF_CONTEXT {
                material.truncated = true;
                break;
            }
            material.context.push(selection.clone());
        }
        material.revision = handoff_source_fingerprint(&material)?;
        Ok(material)
    }

    pub fn target(
        &self,
        scope: &ApplicationScope,
        target: &ProjectAgentTaskRef,
        window: &ApplicationWindowRef,
    ) -> Result<AgentHandoffTargetSnapshot, ApplicationError> {
        if !valid_ref(target) {
            return Err(ApplicationError::NotFound);
        }
        self.store.handoff_target(scope, target, window)
    }

    pub fn receipt(
        &self,
        scope: &ApplicationScope,
        request_id: &str,
    ) -> Result<Option<AgentHandoffReceipt>, ApplicationError> {
        self.store
            .handoff_receipt(scope, request_id)
            .map(|record| record.map(|record| record.receipt))
    }

    pub fn transfer(
        &self,
        actor: &ComponentActor,
        request: &AgentHandoffCommand,
        extra_context: &[AgentContextSelection],
        now: u64,
    ) -> Result<AgentHandoffReceipt, ApplicationError> {
        actor.validate(now)?;
        if request.project_root != actor.scope().project || request.window != *actor.window() {
            return Err(ApplicationError::Conflict);
        }
        if request.request_id.is_empty()
            || request.request_id.len() > 160
            || !request
                .request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        {
            return Err(ApplicationError::InvalidInput(
                "Invalid handoff request identity".into(),
            ));
        }
        let digest = component_digest(request)?;
        if let Some(saved) = self
            .store
            .handoff_receipt(actor.scope(), &request.request_id)?
        {
            if saved.input_digest != digest {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(saved.receipt);
        }
        if request.source == request.target
            || !valid_ref(&request.source)
            || !valid_ref(&request.target)
            || request.body.trim().is_empty()
            || request.body.contains('\0')
            || request.body.len() > MAX_HANDOFF_BODY_BYTES
            || request.context.len() > MAX_HANDOFF_CONTEXT
            || serde_json::to_vec(request)
                .map_err(|e| ApplicationError::Storage(e.to_string()))?
                .len()
                > 48 * 1024
        {
            return Err(ApplicationError::InvalidInput(
                "Handoff content is empty, invalid or exceeds its bound".into(),
            ));
        }
        let base = self.store.handoff_source(actor.scope(), &request.source)?;
        let material = Self::include_context(base.clone(), extra_context)?;
        if material.revision != request.source_revision {
            return Err(handoff_source_expired());
        }
        let allowed = material
            .context
            .iter()
            .map(handoff_context_key)
            .collect::<Result<BTreeSet<_>, _>>()?;
        for selection in &request.context {
            if selection.source == "attachments"
                || !allowed.contains(&handoff_context_key(selection)?)
            {
                return Err(ApplicationError::InvalidInput(
                    "A handoff reference is not in the source owner's readable material".into(),
                ));
            }
        }
        let target = self
            .store
            .handoff_target(actor.scope(), &request.target, actor.window())?;
        if !target.writable
            || target.draft_version != request.target_draft_version
            || target.control_generation != request.target_control_generation
        {
            return Err(ApplicationError::Conflict);
        }
        let mut content = target.draft;
        if !content.text.is_empty() {
            content.text.push_str("\n\n");
        }
        content.text.push_str(&request.body);
        let mut seen = content
            .context
            .iter()
            .map(handoff_context_key)
            .collect::<Result<BTreeSet<_>, _>>()?;
        for selection in &request.context {
            if seen.insert(handoff_context_key(selection)?) {
                content.context.push(selection.clone());
            }
        }
        let (context_limit, byte_limit) = match request.target {
            ProjectAgentTaskRef::Native { .. } => (20, 256 * 1024),
            ProjectAgentTaskRef::Rho { .. } => (16, 48 * 1024),
        };
        if content.text.len() > 32 * 1024
            || content.context.len() > context_limit
            || serde_json::to_vec(&content)
                .map_err(|e| ApplicationError::Storage(e.to_string()))?
                .len()
                > byte_limit
        {
            return Err(ApplicationError::Budget(
                "The merged target draft exceeds its existing owner limit".into(),
            ));
        }
        let receipt = AgentHandoffReceipt {
            request_id: request.request_id.clone(),
            source: request.source.clone(),
            target: request.target.clone(),
            target_draft_version: target
                .draft_version
                .checked_add(1)
                .ok_or(ApplicationError::Conflict)?,
            created_at_ms: now,
        };
        self.store.commit_handoff(
            actor.scope(),
            AgentHandoffWrite {
                request,
                source_fingerprint: &base.revision,
                input_digest: &digest,
                draft: &content,
                receipt: &receipt,
            },
        )
    }
}

#[cfg(test)]
mod tests;
