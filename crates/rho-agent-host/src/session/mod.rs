//! Durable logical sessions with replaceable provider-session associations.

use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{CapabilityId, ProviderId, ProviderSessionId, SessionId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionContinuity {
    ExactResume,
    NewProviderSessionRehydrated,
    ModelContextReset,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAssociationLifecycle {
    Active,
    Closing,
    Closed,
    Lost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderSessionAssociation {
    pub provider_session_id: ProviderSessionId,
    pub logical_session_id: SessionId,
    pub provider_id: ProviderId,
    pub protocol: String,
    pub provider_version: String,
    pub external_session_id: String,
    pub capability_snapshot_digest: String,
    pub capability_ids: Vec<CapabilityId>,
    pub supports_resume: bool,
    pub continuity: SessionContinuity,
    pub lifecycle: ProviderAssociationLifecycle,
    pub process_incarnation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LogicalSessionState {
    pub session_id: SessionId,
    pub durable_turn_ids: BTreeSet<String>,
    pub durable_job_ids: BTreeSet<String>,
    pub durable_artifact_ids: BTreeSet<String>,
    pub active_provider_session_id: Option<ProviderSessionId>,
}

impl LogicalSessionState {
    pub fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            durable_turn_ids: BTreeSet::new(),
            durable_job_ids: BTreeSet::new(),
            durable_artifact_ids: BTreeSet::new(),
            active_provider_session_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderSessionCreateRequest {
    pub logical_session_id: SessionId,
    pub rehydrated_context_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderSessionResumeRequest {
    pub logical_session_id: SessionId,
    pub external_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAttachmentRequest {
    pub logical_session_id: SessionId,
    pub provider_id: ProviderId,
    pub protocol: String,
    pub provider_version: String,
    pub capability_snapshot_digest: String,
    pub capability_ids: Vec<CapabilityId>,
    pub supports_resume: bool,
    pub process_incarnation: u64,
    pub context_digest: String,
}

pub trait ProviderSessionAdapter {
    fn create_session(
        &mut self,
        request: ProviderSessionCreateRequest,
    ) -> Result<String, ProviderSessionAdapterError>;

    fn resume_session(
        &mut self,
        request: ProviderSessionResumeRequest,
    ) -> Result<String, ProviderSessionAdapterError>;

    fn close_session(
        &mut self,
        external_session_id: &str,
    ) -> Result<(), ProviderSessionAdapterError>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProviderSessionAdapterError {
    #[error("provider session operation is unsupported")]
    Unsupported,
    #[error("provider session was lost")]
    Lost,
    #[error("provider session operation failed")]
    Failed,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SessionManagerError {
    #[error("logical session {0} is unknown")]
    UnknownLogicalSession(SessionId),
    #[error("provider session {0} is unknown")]
    UnknownProviderSession(ProviderSessionId),
    #[error("provider session belongs to another logical session")]
    WrongLogicalSession,
    #[error("provider session association is stale after process reincarnation")]
    StaleProviderSession,
    #[error("provider adapter failed: {0}")]
    Adapter(#[from] ProviderSessionAdapterError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseSessionOutcome {
    Closed,
    AlreadyClosed,
}

#[derive(Debug, Default)]
pub struct LogicalSessionManager {
    logical: BTreeMap<SessionId, LogicalSessionState>,
    providers: BTreeMap<ProviderSessionId, ProviderSessionAssociation>,
}

impl LogicalSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_logical(&mut self, session_id: SessionId) -> &LogicalSessionState {
        self.logical
            .entry(session_id.clone())
            .or_insert_with(|| LogicalSessionState::new(session_id))
    }

    pub fn record_durable_truth(
        &mut self,
        logical_session_id: &SessionId,
        turn_id: impl Into<String>,
        job_id: impl Into<String>,
        artifact_id: impl Into<String>,
    ) -> Result<(), SessionManagerError> {
        let logical = self.logical.get_mut(logical_session_id).ok_or_else(|| {
            SessionManagerError::UnknownLogicalSession(logical_session_id.clone())
        })?;
        logical.durable_turn_ids.insert(turn_id.into());
        logical.durable_job_ids.insert(job_id.into());
        logical.durable_artifact_ids.insert(artifact_id.into());
        Ok(())
    }

    pub fn attach_provider(
        &mut self,
        request: ProviderAttachmentRequest,
        adapter: &mut impl ProviderSessionAdapter,
    ) -> Result<ProviderSessionAssociation, SessionManagerError> {
        if !self.logical.contains_key(&request.logical_session_id) {
            return Err(SessionManagerError::UnknownLogicalSession(
                request.logical_session_id,
            ));
        }
        let external_session_id = adapter.create_session(ProviderSessionCreateRequest {
            logical_session_id: request.logical_session_id.clone(),
            rehydrated_context_digest: request.context_digest,
        })?;
        let association = ProviderSessionAssociation {
            provider_session_id: ProviderSessionId::generate(),
            logical_session_id: request.logical_session_id.clone(),
            provider_id: request.provider_id,
            protocol: request.protocol,
            provider_version: request.provider_version,
            external_session_id,
            capability_snapshot_digest: request.capability_snapshot_digest,
            capability_ids: request.capability_ids,
            supports_resume: request.supports_resume,
            continuity: SessionContinuity::NewProviderSessionRehydrated,
            lifecycle: ProviderAssociationLifecycle::Active,
            process_incarnation: request.process_incarnation,
        };
        if let Some(logical) = self.logical.get_mut(&request.logical_session_id) {
            logical.active_provider_session_id = Some(association.provider_session_id.clone());
        }
        self.providers
            .insert(association.provider_session_id.clone(), association.clone());
        Ok(association)
    }

    pub fn recover_after_process_restart(
        &mut self,
        logical_session_id: &SessionId,
        previous_provider_session_id: &ProviderSessionId,
        new_process_incarnation: u64,
        bounded_context_digest: impl Into<String>,
        adapter: &mut impl ProviderSessionAdapter,
    ) -> Result<ProviderSessionAssociation, SessionManagerError> {
        let previous = self
            .providers
            .get(previous_provider_session_id)
            .cloned()
            .ok_or_else(|| {
                SessionManagerError::UnknownProviderSession(previous_provider_session_id.clone())
            })?;
        if &previous.logical_session_id != logical_session_id {
            return Err(SessionManagerError::WrongLogicalSession);
        }
        if previous.process_incarnation >= new_process_incarnation {
            return Err(SessionManagerError::StaleProviderSession);
        }
        let (external_session_id, continuity) = if previous.supports_resume {
            match adapter.resume_session(ProviderSessionResumeRequest {
                logical_session_id: logical_session_id.clone(),
                external_session_id: previous.external_session_id.clone(),
            }) {
                Ok(external) => (external, SessionContinuity::ExactResume),
                Err(
                    ProviderSessionAdapterError::Lost | ProviderSessionAdapterError::Unsupported,
                ) => (
                    adapter.create_session(ProviderSessionCreateRequest {
                        logical_session_id: logical_session_id.clone(),
                        rehydrated_context_digest: bounded_context_digest.into(),
                    })?,
                    SessionContinuity::NewProviderSessionRehydrated,
                ),
                Err(error) => return Err(error.into()),
            }
        } else {
            (
                adapter.create_session(ProviderSessionCreateRequest {
                    logical_session_id: logical_session_id.clone(),
                    rehydrated_context_digest: bounded_context_digest.into(),
                })?,
                SessionContinuity::ModelContextReset,
            )
        };
        if let Some(previous) = self.providers.get_mut(previous_provider_session_id) {
            previous.lifecycle = ProviderAssociationLifecycle::Lost;
        }
        let association = ProviderSessionAssociation {
            provider_session_id: ProviderSessionId::generate(),
            logical_session_id: logical_session_id.clone(),
            provider_id: previous.provider_id,
            protocol: previous.protocol,
            provider_version: previous.provider_version,
            external_session_id,
            capability_snapshot_digest: previous.capability_snapshot_digest,
            capability_ids: previous.capability_ids,
            supports_resume: previous.supports_resume,
            continuity,
            lifecycle: ProviderAssociationLifecycle::Active,
            process_incarnation: new_process_incarnation,
        };
        self.providers
            .insert(association.provider_session_id.clone(), association.clone());
        self.logical
            .get_mut(logical_session_id)
            .expect("logical session checked")
            .active_provider_session_id = Some(association.provider_session_id.clone());
        Ok(association)
    }

    pub fn close_provider(
        &mut self,
        logical_session_id: &SessionId,
        provider_session_id: &ProviderSessionId,
        adapter: &mut impl ProviderSessionAdapter,
    ) -> Result<CloseSessionOutcome, SessionManagerError> {
        let association = self.providers.get_mut(provider_session_id).ok_or_else(|| {
            SessionManagerError::UnknownProviderSession(provider_session_id.clone())
        })?;
        if &association.logical_session_id != logical_session_id {
            return Err(SessionManagerError::WrongLogicalSession);
        }
        if association.lifecycle == ProviderAssociationLifecycle::Closed {
            return Ok(CloseSessionOutcome::AlreadyClosed);
        }
        association.lifecycle = ProviderAssociationLifecycle::Closing;
        match adapter.close_session(&association.external_session_id) {
            Ok(()) | Err(ProviderSessionAdapterError::Lost) => {
                association.lifecycle = ProviderAssociationLifecycle::Closed;
            }
            Err(error) => {
                association.lifecycle = ProviderAssociationLifecycle::Active;
                return Err(error.into());
            }
        }
        if self
            .logical
            .get(logical_session_id)
            .and_then(|logical| logical.active_provider_session_id.as_ref())
            == Some(provider_session_id)
        {
            self.logical
                .get_mut(logical_session_id)
                .expect("logical session exists")
                .active_provider_session_id = None;
        }
        Ok(CloseSessionOutcome::Closed)
    }

    pub fn logical(&self, session_id: &SessionId) -> Option<&LogicalSessionState> {
        self.logical.get(session_id)
    }

    pub fn provider(
        &self,
        provider_session_id: &ProviderSessionId,
    ) -> Option<&ProviderSessionAssociation> {
        self.providers.get(provider_session_id)
    }

    pub fn list_provider_sessions(
        &self,
        logical_session_id: &SessionId,
    ) -> Vec<&ProviderSessionAssociation> {
        self.providers
            .values()
            .filter(|association| &association.logical_session_id == logical_session_id)
            .collect()
    }
}

pub fn session_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "logical_identity",
            "provider_association",
            "continuity_mode",
        ],
        &[
            "conversation_identity_rewrite",
            "job_identity_rewrite",
            "artifact_identity_rewrite",
            "external_id_as_primary_key",
        ],
    )
}
