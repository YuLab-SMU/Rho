//! Temporary fixed-composition adapter to the annotation plugin owner.
//! Remove this adapter with the fixed Host annotation service in M6. No note domain
//! logic or storage lives here; the live Application bridge is checked before admission.
use crate::{ApplicationError, ApplicationScope, ComponentActor};
pub use public::AnnotationRepository;
use rho_annotation_owner as public;
use rho_contract::*;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::sync::Arc;

pub struct AnnotationOwner(public::AnnotationOwner);
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAnnotationReceipt {
    pub input_digest: String,
    pub receipt: AnnotationCommandReceipt,
}
pub struct FrozenEvidence {
    pub source: AnnotationSourceRef,
    pub fragment: Value,
    pub normalized_selection: Option<AgentContextSelection>,
}
fn wire<T: Serialize, U: DeserializeOwned>(value: &T) -> Result<U, ApplicationError> {
    serde_json::from_value(
        serde_json::to_value(value).map_err(|e| ApplicationError::Storage(e.to_string()))?,
    )
    .map_err(|e| ApplicationError::Storage(e.to_string()))
}
fn scope(value: &ApplicationScope) -> public::AnnotationScope {
    public::AnnotationScope {
        project: value.project.clone(),
        principal: value.principal.clone(),
    }
}
fn actor(value: &ComponentActor, now: u64) -> Result<public::AnnotationActor, ApplicationError> {
    value.validate(now)?;
    Ok(public::AnnotationActor::admitted(
        scope(value.scope()),
        wire(value.window())?,
    ))
}
impl From<public::AnnotationError> for ApplicationError {
    fn from(error: public::AnnotationError) -> Self {
        match error {
            public::AnnotationError::InvalidInput(message) => Self::InvalidInput(message),
            public::AnnotationError::NotFound => Self::NotFound,
            public::AnnotationError::Conflict => Self::Conflict,
            public::AnnotationError::RequestConflict => Self::RequestConflict,
            public::AnnotationError::Budget(message) => Self::Budget(message),
            public::AnnotationError::Storage(message) => Self::Storage(message),
        }
    }
}
impl AnnotationOwner {
    pub fn new(store: Arc<dyn AnnotationRepository>) -> Self {
        Self(public::AnnotationOwner::new(store))
    }
    pub fn receipt(
        &self,
        value: &ApplicationScope,
        request_id: &str,
    ) -> Result<Option<StoredAnnotationReceipt>, ApplicationError> {
        wire(&self.0.receipt(&scope(value), request_id)?)
    }
    pub fn replay_matches(
        &self,
        request: &AnnotationsCommand,
        saved: &StoredAnnotationReceipt,
    ) -> Result<bool, ApplicationError> {
        self.0
            .replay_matches(&wire(request)?, &wire(saved)?)
            .map_err(Into::into)
    }
    pub fn evidence(
        &self,
        value: &ApplicationScope,
        evidence_id: &str,
    ) -> Result<AnnotationEvidence, ApplicationError> {
        wire(&self.0.evidence(&scope(value), evidence_id)?)
    }
    pub fn capture(
        &self,
        value: &ApplicationScope,
        capture_id: &str,
    ) -> Result<(AnnotationCaptureRef, Vec<u8>), ApplicationError> {
        let (capture, bytes) = self.0.capture(&scope(value), capture_id)?;
        Ok((wire(&capture)?, bytes))
    }
    pub fn read(
        &self,
        value: &ApplicationScope,
        reference: &AnnotationRevisionRef,
    ) -> Result<(AnnotationRevision, AnnotationEvidence), ApplicationError> {
        wire(&self.0.read(&scope(value), &wire(reference)?)?)
    }
    pub fn head(
        &self,
        value: &ApplicationScope,
        annotation_id: &str,
    ) -> Result<Option<AnnotationRevision>, ApplicationError> {
        wire(&self.0.head(&scope(value), annotation_id)?)
    }
    pub fn list(
        &self,
        value: &ApplicationScope,
        source_id: Option<&str>,
        after: Option<&str>,
        limit: u32,
        include_deleted: bool,
    ) -> Result<(Vec<AnnotationListItem>, Option<String>), ApplicationError> {
        wire(
            &self
                .0
                .list(&scope(value), source_id, after, limit, include_deleted)?,
        )
    }
    pub fn freeze(
        &self,
        value: &ComponentActor,
        request: &AnnotationsCommand,
        frozen: FrozenEvidence,
        now: u64,
    ) -> Result<AnnotationCommandReceipt, ApplicationError> {
        let admitted = actor(value, now)?;
        let frozen = public::FrozenEvidence {
            source: wire(&frozen.source)?,
            fragment: frozen.fragment,
            normalized_selection: wire(&frozen.normalized_selection)?,
        };
        wire(&self.0.freeze(&admitted, &wire(request)?, frozen, now)?)
    }
    pub fn store_capture(
        &self,
        value: &ComponentActor,
        request: &AnnotationsCommand,
        bytes: &[u8],
        now: u64,
    ) -> Result<AnnotationCommandReceipt, ApplicationError> {
        let admitted = actor(value, now)?;
        wire(
            &self
                .0
                .store_capture(&admitted, &wire(request)?, bytes, now)?,
        )
    }
    pub fn write(
        &self,
        value: &ComponentActor,
        author: &CallerIdentity,
        request: &AnnotationsCommand,
        now: u64,
    ) -> Result<AnnotationCommandReceipt, ApplicationError> {
        let admitted = actor(value, now)?;
        author
            .validate()
            .map_err(|e| ApplicationError::InvalidInput(e.to_string()))?;
        wire(
            &self
                .0
                .write(&admitted, &wire(author)?, &wire(request)?, now)?,
        )
    }
}

pub fn validate_anchor(anchor: &AnnotationAnchor) -> Result<(), ApplicationError> {
    public::validate_anchor(&wire(anchor)?).map_err(Into::into)
}

pub fn validate_marks(marks: &[AnnotationMark]) -> Result<(), ApplicationError> {
    public::validate_marks(&wire::<_, Vec<_>>(&marks)?).map_err(Into::into)
}
