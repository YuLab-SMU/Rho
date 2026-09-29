//! Version-bound notes on owner content. Evidence is frozen once; revisions append
//! under CAS; deletion is a tombstone. Nothing here observes or alters a source.
use crate::{AnnotationActor, AnnotationError, AnnotationScope, annotation_digest};
use rho_annotation_api::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAnnotationReceipt {
    pub input_digest: String,
    pub receipt: AnnotationCommandReceipt,
}

/// Bytes stored for one capture. The repository keeps them apart from JSON rows.
pub struct AnnotationCaptureWrite<'a> {
    pub capture: &'a AnnotationCaptureRef,
    pub bytes: &'a [u8],
}

pub struct AnnotationRevisionWrite<'a> {
    pub revision: &'a AnnotationRevision,
    /// The head revision this write replaces; `None` for a new annotation.
    pub expected: Option<&'a AnnotationRevisionRef>,
}

pub enum AnnotationWrite<'a> {
    Evidence(&'a AnnotationEvidence),
    Capture(AnnotationCaptureWrite<'a>),
    Revision(AnnotationRevisionWrite<'a>),
}

pub trait AnnotationRepository: Send + Sync {
    fn annotation_receipt(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
    ) -> Result<Option<StoredAnnotationReceipt>, AnnotationError>;
    fn annotation_evidence(
        &self,
        scope: &AnnotationScope,
        evidence_id: &str,
    ) -> Result<Option<AnnotationEvidence>, AnnotationError>;
    fn annotation_capture(
        &self,
        scope: &AnnotationScope,
        capture_id: &str,
    ) -> Result<Option<(AnnotationCaptureRef, Vec<u8>)>, AnnotationError>;
    /// The head revision of one annotation, including tombstones.
    fn annotation_head(
        &self,
        scope: &AnnotationScope,
        annotation_id: &str,
    ) -> Result<Option<AnnotationRevision>, AnnotationError>;
    fn annotation_revision(
        &self,
        scope: &AnnotationScope,
        reference: &AnnotationRevisionRef,
    ) -> Result<Option<AnnotationRevision>, AnnotationError>;
    fn annotation_list(
        &self,
        scope: &AnnotationScope,
        source_id: Option<&str>,
        after: Option<&str>,
        limit: u32,
        include_deleted: bool,
    ) -> Result<(Vec<AnnotationListItem>, Option<String>), AnnotationError>;
    /// Writes the payload and its receipt atomically, re-checking CAS and budgets.
    fn commit_annotation(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
        input_digest: &str,
        write: AnnotationWrite<'_>,
        receipt: &AnnotationCommandReceipt,
    ) -> Result<AnnotationCommandReceipt, AnnotationError>;
}

pub struct AnnotationOwner {
    store: Arc<dyn AnnotationRepository>,
    gate: Mutex<()>,
}

/// Frozen evidence resolved by the Host from the owner's current observation.
pub struct FrozenEvidence {
    pub source: AnnotationSourceRef,
    pub fragment: Value,
    /// The owner-normalized reference when it differs from the caller's draft.
    pub normalized_selection: Option<AnnotationSelection>,
}

fn invalid(message: &str) -> AnnotationError {
    AnnotationError::InvalidInput(message.into())
}

fn storage(error: impl std::fmt::Display) -> AnnotationError {
    AnnotationError::Storage(error.to_string())
}

fn fresh() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn token(value: &str, what: &str) -> Result<(), AnnotationError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
    {
        return Err(AnnotationError::InvalidInput(format!(
            "Invalid {what} identity"
        )));
    }
    Ok(())
}

fn finite(values: &[f64]) -> bool {
    values
        .iter()
        .all(|value| value.is_finite() && (-1.0..=2.0).contains(value))
}

pub fn validate_marks(marks: &[AnnotationMark]) -> Result<(), AnnotationError> {
    if marks.len() > MAX_ANNOTATION_MARKS {
        return Err(invalid("Too many marks in one annotation"));
    }
    for mark in marks {
        let ok = match mark {
            AnnotationMark::Pen { points } => {
                !points.is_empty()
                    && points.len() <= 4096
                    && points.iter().all(|point| finite(&[point.x, point.y]))
            }
            AnnotationMark::Rectangle {
                x,
                y,
                width,
                height,
            } => finite(&[*x, *y, *width, *height]) && *width >= 0.0 && *height >= 0.0,
            AnnotationMark::Arrow { from, to } => finite(&[from.x, from.y, to.x, to.y]),
            AnnotationMark::Text { x, y, text } => {
                finite(&[*x, *y]) && !text.trim().is_empty() && text.len() <= 1024
            }
        };
        if !ok {
            return Err(invalid(
                "A mark has coordinates outside the captured view or invalid text",
            ));
        }
    }
    Ok(())
}

pub fn validate_anchor(anchor: &AnnotationAnchor) -> Result<(), AnnotationError> {
    match anchor {
        AnnotationAnchor::WholeItem => Ok(()),
        AnnotationAnchor::TextQuote {
            quote, start, end, ..
        } => {
            if quote.is_empty() || quote.len() > MAX_ANNOTATION_TEXT_BYTES || start > end {
                return Err(invalid(
                    "A quotation must be non-empty, bounded and ordered",
                ));
            }
            Ok(())
        }
        AnnotationAnchor::Structured {
            path,
            column,
            topic,
            ..
        } => {
            if path.len() > 64
                || path.iter().any(|segment| segment.len() > 512)
                || column.as_ref().is_some_and(|c| c.len() > 512)
                || topic.as_ref().is_some_and(|t| t.len() > 512)
            {
                return Err(invalid("Structured anchor exceeds its bounds"));
            }
            Ok(())
        }
        AnnotationAnchor::CapturedView { capture } => {
            token(&capture.capture_id, "capture")?;
            if capture.width == 0 || capture.height == 0 || capture.byte_size == 0 {
                return Err(invalid("A captured view needs real dimensions"));
            }
            Ok(())
        }
    }
}

fn validate_note(note: &str, labels: &[String]) -> Result<(), AnnotationError> {
    if note.len() > MAX_ANNOTATION_TEXT_BYTES {
        return Err(AnnotationError::Budget("The note exceeds 16 KiB".into()));
    }
    if labels.len() > MAX_ANNOTATION_LABELS
        || labels.iter().any(|label| {
            label.trim().is_empty() || label.len() > 64 || label.chars().any(char::is_control)
        })
    {
        return Err(invalid("Labels must be short non-empty text"));
    }
    Ok(())
}

impl AnnotationOwner {
    pub fn new(store: Arc<dyn AnnotationRepository>) -> Self {
        Self {
            store,
            gate: Mutex::new(()),
        }
    }

    pub fn receipt(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
    ) -> Result<Option<StoredAnnotationReceipt>, AnnotationError> {
        self.store.annotation_receipt(scope, request_id)
    }

    pub fn replay_matches(
        &self,
        request: &AnnotationsCommand,
        saved: &StoredAnnotationReceipt,
    ) -> Result<bool, AnnotationError> {
        Ok(annotation_digest(request)? == saved.input_digest)
    }

    pub fn evidence(
        &self,
        scope: &AnnotationScope,
        evidence_id: &str,
    ) -> Result<AnnotationEvidence, AnnotationError> {
        token(evidence_id, "evidence")?;
        self.store
            .annotation_evidence(scope, evidence_id)?
            .ok_or(AnnotationError::NotFound)
    }

    pub fn capture(
        &self,
        scope: &AnnotationScope,
        capture_id: &str,
    ) -> Result<(AnnotationCaptureRef, Vec<u8>), AnnotationError> {
        token(capture_id, "capture")?;
        self.store
            .annotation_capture(scope, capture_id)?
            .ok_or(AnnotationError::NotFound)
    }

    /// One exact revision with its frozen evidence. Historical revisions stay readable.
    pub fn read(
        &self,
        scope: &AnnotationScope,
        reference: &AnnotationRevisionRef,
    ) -> Result<(AnnotationRevision, AnnotationEvidence), AnnotationError> {
        token(&reference.annotation_id, "annotation")?;
        let revision = self
            .store
            .annotation_revision(scope, reference)?
            .ok_or(AnnotationError::NotFound)?;
        let evidence = self.evidence(scope, &revision.evidence_id)?;
        Ok((revision, evidence))
    }

    pub fn head(
        &self,
        scope: &AnnotationScope,
        annotation_id: &str,
    ) -> Result<Option<AnnotationRevision>, AnnotationError> {
        token(annotation_id, "annotation")?;
        self.store.annotation_head(scope, annotation_id)
    }

    pub fn list(
        &self,
        scope: &AnnotationScope,
        source_id: Option<&str>,
        after: Option<&str>,
        limit: u32,
        include_deleted: bool,
    ) -> Result<(Vec<AnnotationListItem>, Option<String>), AnnotationError> {
        if limit == 0 || limit > MAX_ANNOTATION_PAGE {
            return Err(invalid("Annotation pages hold 1..=100 items"));
        }
        if source_id.is_some_and(|id| id.is_empty() || id.len() > 4096) {
            return Err(invalid("Invalid source identity filter"));
        }
        if after.is_some_and(|cursor| cursor.len() > 256) {
            return Err(invalid("Invalid annotation cursor"));
        }
        self.store
            .annotation_list(scope, source_id, after, limit, include_deleted)
    }

    fn prepare(
        &self,
        actor: &AnnotationActor,
        request: &AnnotationsCommand,
    ) -> Result<Result<String, AnnotationCommandReceipt>, AnnotationError> {
        if request.project_root != actor.scope().project || request.window != *actor.window() {
            return Err(AnnotationError::Conflict);
        }
        token(&request.request_id, "request")?;
        let digest = annotation_digest(request)?;
        if let Some(saved) = self
            .store
            .annotation_receipt(actor.scope(), &request.request_id)?
        {
            if saved.input_digest != digest {
                return Err(AnnotationError::RequestConflict);
            }
            return Ok(Err(saved.receipt));
        }
        Ok(Ok(digest))
    }

    /// Freeze evidence the Host already resolved from the owner. `frozen` must come
    /// from an owner observation performed for this request, never from the caller.
    pub fn freeze(
        &self,
        actor: &AnnotationActor,
        request: &AnnotationsCommand,
        frozen: FrozenEvidence,
        now: u64,
    ) -> Result<AnnotationCommandReceipt, AnnotationError> {
        let AnnotationCommand::Freeze {
            selection,
            session,
            anchor,
        } = &request.command
        else {
            return Err(invalid("Freeze expects a Freeze command"));
        };
        let digest = match self.prepare(actor, request)? {
            Ok(digest) => digest,
            Err(receipt) => return Ok(receipt),
        };
        validate_anchor(anchor)?;
        if frozen.source.source_id.is_empty()
            || frozen.source.source_id.len() > 4096
            || frozen.source.source_version.is_empty()
            || frozen.source.source_version.len() > 4096
            || frozen.source.title.len() > 1024
        {
            return Err(invalid("Owner source identity is missing or oversized"));
        }
        if let AnnotationAnchor::CapturedView { capture } = anchor {
            let (stored, _) = self.capture(actor.scope(), &capture.capture_id)?;
            if stored != *capture {
                return Err(AnnotationError::Conflict);
            }
        }
        let evidence = AnnotationEvidence {
            evidence_id: fresh(),
            source: frozen.source,
            selection: frozen
                .normalized_selection
                .unwrap_or_else(|| selection.clone()),
            session: session.clone(),
            anchor: anchor.clone(),
            fragment: frozen.fragment,
            observed_at_ms: now,
        };
        if serde_json::to_vec(&evidence).map_err(storage)?.len() > MAX_ANNOTATION_EVIDENCE_BYTES {
            return Err(AnnotationError::Budget(
                "Select a smaller excerpt to annotate".into(),
            ));
        }
        let receipt = AnnotationCommandReceipt {
            request_id: request.request_id.clone(),
            outcome: AnnotationCommandOutcome::Evidence {
                evidence_id: evidence.evidence_id.clone(),
            },
            created_at_ms: now,
        };
        let _guard = self.gate.lock().map_err(storage)?;
        self.store.commit_annotation(
            actor.scope(),
            &request.request_id,
            &digest,
            AnnotationWrite::Evidence(&evidence),
            &receipt,
        )
    }

    /// Store captured bytes. The caller supplies decoded bytes; the Host verified them.
    pub fn store_capture(
        &self,
        actor: &AnnotationActor,
        request: &AnnotationsCommand,
        bytes: &[u8],
        now: u64,
    ) -> Result<AnnotationCommandReceipt, AnnotationError> {
        let AnnotationCommand::Capture {
            mime_type,
            width,
            height,
            original_media,
            ..
        } = &request.command
        else {
            return Err(invalid("Capture expects a Capture command"));
        };
        let digest = match self.prepare(actor, request)? {
            Ok(digest) => digest,
            Err(receipt) => return Ok(receipt),
        };
        if !matches!(mime_type.as_str(), "image/png" | "image/jpeg") {
            return Err(invalid("Captured views are PNG or JPEG"));
        }
        if bytes.is_empty() || bytes.len() > MAX_ANNOTATION_CAPTURE_BYTES {
            return Err(AnnotationError::Budget(
                "A captured view holds 1 byte to 8 MiB".into(),
            ));
        }
        if *width == 0 || *height == 0 || *width > 16384 || *height > 16384 {
            return Err(invalid("Captured view dimensions are out of range"));
        }
        let capture = AnnotationCaptureRef {
            capture_id: fresh(),
            sha256: crate::sha256(bytes),
            width: *width,
            height: *height,
            mime_type: mime_type.clone(),
            byte_size: bytes.len() as u64,
            original_media: *original_media,
        };
        let receipt = AnnotationCommandReceipt {
            request_id: request.request_id.clone(),
            outcome: AnnotationCommandOutcome::Capture {
                capture: capture.clone(),
            },
            created_at_ms: now,
        };
        let _guard = self.gate.lock().map_err(storage)?;
        self.store.commit_annotation(
            actor.scope(),
            &request.request_id,
            &digest,
            AnnotationWrite::Capture(AnnotationCaptureWrite {
                capture: &capture,
                bytes,
            }),
            &receipt,
        )
    }

    /// Create, update or delete. Update/Delete require the current head revision.
    pub fn write(
        &self,
        actor: &AnnotationActor,
        author: &AnnotationAuthor,
        request: &AnnotationsCommand,
        now: u64,
    ) -> Result<AnnotationCommandReceipt, AnnotationError> {
        let digest = match self.prepare(actor, request)? {
            Ok(digest) => digest,
            Err(receipt) => return Ok(receipt),
        };
        if author.id.is_empty()
            || author.id.len() > 160
            || !author
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
        {
            return Err(invalid("Invalid author identity"));
        }
        let _guard = self.gate.lock().map_err(storage)?;
        let scope = actor.scope();
        let (revision, expected) = match &request.command {
            AnnotationCommand::Create {
                evidence_id,
                note,
                labels,
                marks,
                continued_from,
            } => {
                validate_note(note, labels)?;
                validate_marks(marks)?;
                let evidence = self.evidence(scope, evidence_id)?;
                if !marks.is_empty()
                    && !matches!(evidence.anchor, AnnotationAnchor::CapturedView { .. })
                {
                    return Err(invalid("Marks require a captured view anchor"));
                }
                if note.trim().is_empty() && marks.is_empty() {
                    return Err(invalid("Write a note or add a mark before saving"));
                }
                if let Some(previous) = continued_from {
                    token(&previous.annotation_id, "annotation")?;
                    let earlier = self
                        .store
                        .annotation_revision(scope, previous)?
                        .ok_or_else(|| {
                            invalid("The continued annotation revision is unavailable")
                        })?;
                    let previous_source = self.evidence(scope, &earlier.evidence_id)?.source;
                    if previous_source.owner == evidence.source.owner
                        && previous_source.source_id == evidence.source.source_id
                        && previous_source.source_version == evidence.source.source_version
                    {
                        return Err(invalid("Continue an idea on a different source version"));
                    }
                }
                (
                    AnnotationRevision {
                        annotation: AnnotationRevisionRef {
                            annotation_id: fresh(),
                            revision: 1,
                        },
                        author: author.clone(),
                        note: note.clone(),
                        labels: labels.clone(),
                        evidence_id: evidence_id.clone(),
                        marks: marks.clone(),
                        continued_from: continued_from.clone(),
                        created_at_ms: now,
                        updated_at_ms: now,
                        deleted: false,
                    },
                    None,
                )
            }
            AnnotationCommand::Update {
                expected,
                note,
                labels,
                marks,
            } => {
                validate_note(note, labels)?;
                validate_marks(marks)?;
                let head = self.head_for_write(scope, expected)?;
                if !marks.is_empty() {
                    let evidence = self.evidence(scope, &head.evidence_id)?;
                    if !matches!(evidence.anchor, AnnotationAnchor::CapturedView { .. }) {
                        return Err(invalid("Marks require a captured view anchor"));
                    }
                }
                if note.trim().is_empty() && marks.is_empty() {
                    return Err(invalid("Write a note or add a mark before saving"));
                }
                (
                    AnnotationRevision {
                        annotation: AnnotationRevisionRef {
                            annotation_id: expected.annotation_id.clone(),
                            revision: expected
                                .revision
                                .checked_add(1)
                                .ok_or(AnnotationError::Conflict)?,
                        },
                        author: author.clone(),
                        note: note.clone(),
                        labels: labels.clone(),
                        evidence_id: head.evidence_id,
                        marks: marks.clone(),
                        continued_from: head.continued_from,
                        created_at_ms: head.created_at_ms,
                        updated_at_ms: now,
                        deleted: false,
                    },
                    Some(expected),
                )
            }
            AnnotationCommand::Delete { expected } => {
                let head = self.head_for_write(scope, expected)?;
                (
                    AnnotationRevision {
                        annotation: AnnotationRevisionRef {
                            annotation_id: expected.annotation_id.clone(),
                            revision: expected
                                .revision
                                .checked_add(1)
                                .ok_or(AnnotationError::Conflict)?,
                        },
                        author: author.clone(),
                        note: String::new(),
                        labels: vec![],
                        evidence_id: head.evidence_id,
                        marks: vec![],
                        continued_from: head.continued_from,
                        created_at_ms: head.created_at_ms,
                        updated_at_ms: now,
                        deleted: true,
                    },
                    Some(expected),
                )
            }
            AnnotationCommand::Freeze { .. } | AnnotationCommand::Capture { .. } => {
                return Err(invalid(
                    "Freeze and Capture are resolved by the Host before writing",
                ));
            }
        };
        if serde_json::to_vec(&revision).map_err(storage)?.len() > MAX_ANNOTATION_REVISION_BYTES {
            return Err(AnnotationError::Budget(
                "The annotation exceeds 64 KiB".into(),
            ));
        }
        let receipt = AnnotationCommandReceipt {
            request_id: request.request_id.clone(),
            outcome: AnnotationCommandOutcome::Annotation {
                annotation: revision.annotation.clone(),
            },
            created_at_ms: now,
        };
        self.store.commit_annotation(
            scope,
            &request.request_id,
            &digest,
            AnnotationWrite::Revision(AnnotationRevisionWrite {
                revision: &revision,
                expected,
            }),
            &receipt,
        )
    }

    fn head_for_write(
        &self,
        scope: &AnnotationScope,
        expected: &AnnotationRevisionRef,
    ) -> Result<AnnotationRevision, AnnotationError> {
        token(&expected.annotation_id, "annotation")?;
        let head = self
            .store
            .annotation_head(scope, &expected.annotation_id)?
            .ok_or(AnnotationError::NotFound)?;
        if head.deleted {
            return Err(AnnotationError::Conflict);
        }
        if head.annotation != *expected {
            return Err(AnnotationError::Conflict);
        }
        Ok(head)
    }
}
