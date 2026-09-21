//! Shared annotation layer. Sources stay with their owners; freezing observes a
//! source once through the same validated preview path that Ask uses.
use crate::{ApplicationStore, NextHost};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_application::{AnnotationOwner, ApplicationError, ComponentActor, FrozenEvidence};
use rho_contract::*;
use serde_json::{Value, json};
use std::sync::Arc;

/// Per-Workbench service. It defers to the project Host's annotation owner so the
/// Agent context reader and Studio share one store and one write gate.
pub struct AnnotationService {
    fallback: AnnotationOwner,
}

fn invalid(message: impl Into<String>) -> ApplicationError {
    ApplicationError::InvalidInput(message.into())
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn text_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Owner-native lineage identity and content version derived from a normalized
/// preview. Returns `None` when the owner exposes no stable version.
pub(crate) fn source_identity(
    snapshot: &ComponentSourceSnapshot,
) -> Result<(AnnotationSourceOwner, String, String), ApplicationError> {
    let reference = &snapshot.selection.reference;
    let data = &snapshot.native_data;
    let missing = |what: &str| invalid(format!("The source owner did not expose its {what}"));
    Ok(match snapshot.selection.source.as_str() {
        "files" => {
            let path = text_of(reference, "path").ok_or_else(|| missing("path"))?;
            let hash = text_of(reference, "expected_sha256").ok_or_else(|| missing("content hash"))?;
            (AnnotationSourceOwner::File, format!("file:{path}"), hash)
        }
        "editor" => {
            let document = reference.get("document").ok_or_else(|| missing("document identity"))?;
            let id = text_of(document, "document_id").ok_or_else(|| missing("document identity"))?;
            let hash = text_of(reference, "expected_sha256").or_else(|| text_of(data, "sha256")).ok_or_else(|| missing("content hash"))?;
            (AnnotationSourceOwner::Editor, format!("document:{id}"), hash)
        }
        "plots" => {
            let media: MediaReference = serde_json::from_value(reference.clone()).map_err(|_| missing("media reference"))?;
            (AnnotationSourceOwner::Plot, format!("output:{}:{}", media.operation_id.as_str(), media.sequence), media.sha256)
        }
        "viewer" => {
            let media: MediaReference = serde_json::from_value(reference.get("reference").cloned().unwrap_or(reference.clone())).map_err(|_| missing("artifact reference"))?;
            (AnnotationSourceOwner::HtmlViewer, format!("output:{}:{}", media.operation_id.as_str(), media.sequence), media.sha256)
        }
        "objects" | "tables" => {
            let name = text_of(reference, "name").ok_or_else(|| missing("object name"))?;
            let instance = text_of(reference, "workspace_instance_id").unwrap_or_default();
            let object = text_of(reference, "object_ref").ok_or_else(|| missing("object observation"))?;
            let session = text_of(reference, "expected_session").unwrap_or_default();
            (AnnotationSourceOwner::Object, format!("object:{instance}:{name}"), format!("{session}:{object}"))
        }
        "packages" => {
            let package = text_of(reference, "package").ok_or_else(|| missing("package name"))?;
            let library = text_of(reference, "library_path").unwrap_or_default();
            let version = text_of(data, "version").ok_or_else(|| missing("package version"))?;
            let index = text_of(reference, "index_ref").unwrap_or_default();
            (AnnotationSourceOwner::Package, format!("package:{library}:{package}"), format!("{version}:{index}"))
        }
        "help" => {
            let package = text_of(reference, "package").ok_or_else(|| missing("package name"))?;
            let library = text_of(reference, "library_path").unwrap_or_default();
            let topic = text_of(reference, "topic").ok_or_else(|| missing("help topic"))?;
            let version = text_of(data, "version").unwrap_or_default();
            let files = data.get("help_files").map(|files| rho_application::sha256(files.to_string())).unwrap_or_default();
            (AnnotationSourceOwner::Help, format!("help:{library}:{package}:{topic}"), format!("{version}:{files}"))
        }
        "operations" => {
            let id = text_of(reference, "operation_id").ok_or_else(|| missing("operation identity"))?;
            let status = text_of(data, "status").unwrap_or_default();
            (AnnotationSourceOwner::Console, format!("operation:{id}"), format!("{id}:{status}"))
        }
        "workspace" | "environment" => {
            let instance = text_of(reference, "workspace_instance_id").unwrap_or_default();
            let session = text_of(reference, "expected_session").or_else(|| text_of(data, "native_session_id")).unwrap_or_default();
            (AnnotationSourceOwner::Workspace, format!("workspace:{instance}"), session)
        }
        other => return Err(invalid(format!("Annotations do not support the {other} source yet"))),
    })
}

/// A bounded excerpt of the observed source around the anchor. It is evidence of
/// what was selected, never a backup of the object.
fn fragment(snapshot: &ComponentSourceSnapshot, anchor: &AnnotationAnchor) -> Result<Value, ApplicationError> {
    let mut excerpt = match anchor {
        AnnotationAnchor::TextQuote { quote, .. } => {
            let text = snapshot.text.as_str();
            let found = text.contains(quote.as_str());
            json!({"quote": quote, "quote_found_in_observation": found})
        }
        AnnotationAnchor::WholeItem => {
            let mut text = snapshot.text.clone();
            if text.len() > 4096 {
                let mut end = 4096;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.push('…');
            }
            json!({"excerpt": text, "truncated": snapshot.truncated || snapshot.text.len() > 4096})
        }
        AnnotationAnchor::Structured { path, row, column, topic } => {
            json!({"path": path, "row": row, "column": column, "topic": topic})
        }
        AnnotationAnchor::CapturedView { capture } => {
            json!({"capture_id": capture.capture_id, "width": capture.width, "height": capture.height, "original_media": capture.original_media})
        }
    };
    if let Some(object) = excerpt.as_object_mut() {
        object.insert("title".into(), json!(snapshot.title));
        object.insert("description".into(), json!(snapshot.description));
    }
    if serde_json::to_vec(&excerpt).map_err(|e| ApplicationError::Storage(e.to_string()))?.len() > 32 * 1024 {
        return Err(ApplicationError::Budget("Select a smaller excerpt to annotate".into()));
    }
    Ok(excerpt)
}

impl AnnotationService {
    pub fn new(store: Arc<ApplicationStore>) -> Self {
        Self { fallback: AnnotationOwner::new(store) }
    }

    fn owner<'a>(&'a self, host: &'a NextHost) -> &'a AnnotationOwner {
        host.annotations().map(Arc::as_ref).unwrap_or(&self.fallback)
    }

    fn actor(host: &NextHost, context: &CallContext, project: &str, window: &ApplicationWindowRef)
        -> Result<ComponentActor, ApplicationError> {
        crate::application::studio(context).map_err(|error| Self::native_error(host, context, error))?;
        if !host.runtime._project_lease.as_ref().is_some_and(|lease| lease.root().to_str() == Some(project)) {
            return Err(ApplicationError::Diagnostic(Box::new(Diagnostic {
                code: DiagnosticCode::Unavailable, continuation: DiagnosticContinuation::ReadAgain,
                message: "The annotation belongs to a different project".into(), next_reads: vec![],
            })));
        }
        host.application_owner().map_err(|error| Self::native_error(host, context, error))?
            .component_actor(context, window, now())
    }

    fn native_error(host: &NextHost, context: &CallContext, error: rho_operation::OperationError) -> ApplicationError {
        ApplicationError::Diagnostic(Box::new(host.runtime.gateway.diagnostic(context, &error)))
    }

    async fn observe(
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        session: Option<ComponentAgentSession>,
        selection: &AgentContextSelection,
    ) -> Result<ComponentSourceSnapshot, ApplicationError> {
        let preview = crate::component_agents::context::preview(host, context, &ComponentSourcePreviewRequest {
            project_root: project.into(), window: window.clone(), session, selection: selection.clone(),
        }, false).await?;
        preview.snapshot.ok_or_else(|| ApplicationError::Diagnostic(Box::new(Diagnostic {
            code: DiagnosticCode::Unavailable, continuation: DiagnosticContinuation::ReadAgain,
            message: preview.error.unwrap_or_else(|| "The source is unavailable".into()), next_reads: vec![],
        })))
    }

    /// The frozen selection pins the observed version. To learn the owner's current
    /// version, re-observe the same lineage without that pin; the frozen record is unchanged.
    fn lineage_selection(evidence: &AnnotationEvidence) -> AgentContextSelection {
        let mut selection = evidence.selection.clone();
        if let Some(object) = selection.reference.as_object_mut() {
            match selection.source.as_str() {
                "files" => { object.remove("expected_sha256"); }
                "editor" => { object.remove("expected_sha256"); }
                "objects" | "tables" => { object.remove("object_ref"); }
                "packages" => { object.remove("index_ref"); }
                "help" => { object.remove("expected_help_files"); }
                _ => {}
            }
        }
        selection
    }

    pub async fn query(&self, host: &NextHost, context: &CallContext, request: AnnotationsQuery)
        -> Result<AnnotationQueryResult, ApplicationError> {
        let actor = Self::actor(host, context, &request.project_root, &request.window)?;
        let owner = self.owner(host);
        let scope = actor.scope();
        Ok(match request.query {
            AnnotationQuery::List { source_id, after, limit, include_deleted } => {
                let (items, next_after) = owner.list(scope, source_id.as_deref(), after.as_deref(), limit, include_deleted)?;
                AnnotationQueryResult::List { items, next_after }
            }
            AnnotationQuery::Read { annotation } => {
                let (revision, evidence) = owner.read(scope, &annotation)?;
                AnnotationQueryResult::Read { revision, evidence }
            }
            AnnotationQuery::Evidence { evidence_id } => AnnotationQueryResult::Evidence { evidence: owner.evidence(scope, &evidence_id)? },
            AnnotationQuery::CommandStatus { request_id } => AnnotationQueryResult::CommandStatus { receipt: owner.receipt(scope, &request_id)?.map(|saved| saved.receipt) },
            AnnotationQuery::Preview { annotation, session } => {
                let (revision, evidence) = owner.read(scope, &annotation)?;
                let session = session.or_else(|| evidence.session.clone());
                let mut notices = Vec::new();
                let lineage = Self::lineage_selection(&evidence);
                let (status, availability, current_version) = match Self::observe(host, context, &request.project_root, &request.window, session, &lineage).await {
                    Ok(snapshot) => match source_identity(&snapshot) {
                        Ok((_, id, version)) if id == evidence.source.source_id => {
                            let status = if version == evidence.source.source_version { AnnotationStatus::Current } else { AnnotationStatus::Historical };
                            if status == AnnotationStatus::Historical {
                                notices.push("The source has a newer version; this note stays with the version it was written on.".into());
                            }
                            (status, AnnotationAvailability::Available, Some(version))
                        }
                        Ok(_) => {
                            notices.push("The reference now resolves to a different item.".into());
                            (AnnotationStatus::Unknown, AnnotationAvailability::Unknown, None)
                        }
                        Err(error) => {
                            notices.push(error.to_string());
                            (AnnotationStatus::Unknown, AnnotationAvailability::Unknown, None)
                        }
                    },
                    Err(error) => {
                        notices.push(format!("Original source is unavailable: {}", error.diagnostic().message));
                        (AnnotationStatus::Unknown, AnnotationAvailability::Unavailable, None)
                    }
                };
                AnnotationQueryResult::Preview { preview: AnnotationPreview { revision, evidence, status, availability, current_version, notices } }
            }
        })
    }

    pub fn capture_bytes(&self, host: &NextHost, context: &CallContext, request: &ReadAnnotationCapture)
        -> Result<(AnnotationCaptureRef, Vec<u8>), ApplicationError> {
        let actor = Self::actor(host, context, &request.project_root, &request.window)?;
        self.owner(host).capture(actor.scope(), &request.capture_id)
    }

    pub async fn command(&self, host: &NextHost, context: &CallContext, request: &AnnotationsCommand)
        -> Result<AnnotationCommandReceipt, ApplicationError> {
        let actor = Self::actor(host, context, &request.project_root, &request.window)?;
        let owner = self.owner(host);
        // Exact replay is resolved before any source is observed again; a changed
        // request under the same identity is rejected by the owner.
        if let Some(saved) = owner.receipt(actor.scope(), &request.request_id)? {
            if owner.replay_matches(request, &saved)? {
                return Ok(saved.receipt);
            }
            return Err(ApplicationError::RequestConflict);
        }
        match &request.command {
            AnnotationCommand::Freeze { selection, session, anchor } => {
                rho_application::validate_anchor(anchor)?;
                let snapshot = Self::observe(host, context, &request.project_root, &request.window, session.clone(), selection).await?;
                let (source_owner, source_id, source_version) = source_identity(&snapshot)?;
                let frozen = FrozenEvidence {
                    source: AnnotationSourceRef { owner: source_owner, source_id, source_version, title: snapshot.title.chars().take(512).collect() },
                    fragment: fragment(&snapshot, anchor)?,
                    normalized_selection: Some(snapshot.selection),
                };
                owner.freeze(&actor, request, frozen, now())
            }
            AnnotationCommand::Capture { base64, .. } => {
                if base64.len() > MAX_ANNOTATION_CAPTURE_BYTES * 4 / 3 + 4 {
                    return Err(ApplicationError::Budget("A captured view holds at most 8 MiB".into()));
                }
                let bytes = STANDARD.decode(base64).map_err(|_| invalid("Captured view bytes are not valid base64"))?;
                let png = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
                let jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
                if !(png || jpeg) {
                    return Err(invalid("Captured view bytes are not a PNG or JPEG image"));
                }
                owner.store_capture(&actor, request, &bytes, now())
            }
            AnnotationCommand::Create { .. } | AnnotationCommand::Update { .. } | AnnotationCommand::Delete { .. } => {
                owner.write(&actor, context.principal(), request, now())
            }
        }
    }

}
