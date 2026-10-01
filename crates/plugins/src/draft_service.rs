//! Generic draft ports. Staging is transient; only an original Operation can
//! publish/discard a draft or release an accepted capture after settlement.
use crate::{service::*, *};
use async_trait::async_trait;
use rho_contract as host;
use rho_operation::*;
use rho_plugin_protocol::*;
use schemars::schema_for;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, OperationError> {
    serde_json::from_value(value.clone()).map_err(invalid)
}
fn normalize<T: DeserializeOwned + Serialize>(value: &Value) -> Result<Value, OperationError> {
    serde_json::to_value(decode::<T>(value)?).map_err(invalid)
}
fn key(id: &str) -> host::CapabilityRef {
    host::CapabilityRef::new(id, 1).unwrap()
}
fn now() -> Result<u64, OperationError> {
    SystemClock.now_ms()?.try_into().map_err(error)
}
fn fault(fault: PluginError) -> OperationError {
    match fault {
        PluginError::Conflict => OperationError::ContentChanged("document draft changed".into()),
        PluginError::Missing(message) => OperationError::NotFound(message),
        PluginError::Invalid(message) => invalid(message),
        PluginError::Contract(message) => invalid(message),
        other => error(other),
    }
}

/// Existing, explicitly granted self-draft storage remains usable by an open
/// document after its instance stops accepting calls. No provider is called.
pub(crate) fn view_persistence_capability(id: &str, version: u16) -> bool {
    version == 1
        && matches!(
            id,
            "documents.inspect" | "documents.read" | "documents.stage" | "documents.save"
        )
}
pub(crate) fn view_persistence_write(request: &PluginViewRequest) -> bool {
    match request {
        PluginViewRequest::Control { capability, .. } => {
            capability.version == 1 && capability.id.as_str() == "documents.stage"
        }
        PluginViewRequest::Invoke { capability, .. } => {
            capability.version == 1 && capability.id.as_str() == "documents.save"
        }
        _ => false,
    }
}
fn check_source(
    required: Option<&DraftSource>,
    source: Option<&DraftSource>,
) -> Result<(), OperationError> {
    if let (Some(required), Some(source)) = (required, source)
        && required != source
    {
        return Err(invalid(
            "a closing or inactive view can synchronize only its own draft encoding",
        ));
    }
    Ok(())
}

pub(crate) fn register(
    service: &Arc<PluginService>,
    registry: &mut CapabilityRegistry,
) -> Result<(), OperationError> {
    for id in ["documents.list", "documents.inspect", "documents.read"] {
        registry.register_query(Arc::new(Read {
            service: service.clone(),
            descriptor: descriptor(id),
        }))?;
    }
    registry.register_control_handler(Arc::new(Stage {
        service: service.clone(),
        descriptor: descriptor("documents.stage"),
    }))?;
    for id in ["documents.save", "documents.discard"] {
        registry.register(Arc::new(Write {
            service: service.clone(),
            descriptor: descriptor(id),
            context: None,
        }))?;
    }
    Ok(())
}

fn descriptor(id: &str) -> host::CapabilityDescriptor {
    let scope = if matches!(
        id,
        "documents.list" | "documents.inspect" | "documents.read"
    ) {
        DOCUMENTS_READ_SCOPE
    } else {
        DOCUMENTS_WRITE_SCOPE
    };
    let (kind, input, output, summary, example) = match id {
        "documents.list" => (
            host::CapabilityKind::Query,
            schema_for!(ListDocumentDrafts).to_value(),
            schema_for!(DocumentDraftPage).to_value(),
            "List bounded synchronized draft metadata in one window",
            json!({"window":"window-example","source":null,"after":null,"limit":20}),
        ),
        "documents.inspect" => (
            host::CapabilityKind::Query,
            schema_for!(DocumentDraftArguments).to_value(),
            schema_for!(Option<DocumentDraft>).to_value(),
            "Inspect a retained draft or its discard tombstone",
            json!({"window":"window-example","draft":"draft-example"}),
        ),
        "documents.read" => (
            host::CapabilityKind::Query,
            schema_for!(ReadDocumentDraft).to_value(),
            schema_for!(DocumentDraftChunk).to_value(),
            "Read a bounded byte page of one exact current draft version",
            json!({"window":"window-example","draft":"draft-example","expected_version":1,"offset":0,"limit":65536}),
        ),
        "documents.stage" => (
            host::CapabilityKind::Control,
            schema_for!(StageDraftChunk).to_value(),
            schema_for!(DraftChunkReference).to_value(),
            "Stage a verified bounded chunk for one captured draft save",
            json!({"window":"window-example","draft":"draft-example","upload":"capture-example","digest":content_digest(b"example"),"base64":"ZXhhbXBsZQ=="}),
        ),
        "documents.save" => (
            host::CapabilityKind::Operation,
            schema_for!(SaveDocumentDraft).to_value(),
            schema_for!(DocumentDraft).to_value(),
            "Publish one complete captured draft with its expected version",
            json!({"window":"window-example","draft":"draft-example","upload":"capture-example","source":{"revision":content_digest(b"source"),"contribution":"editor"},"expected_version":null,"content":{"digest":content_digest(b""),"bytes":0,"chunks":[]},"metadata":{}}),
        ),
        "documents.discard" => (
            host::CapabilityKind::Operation,
            schema_for!(DiscardDocumentDraft).to_value(),
            schema_for!(DocumentDraft).to_value(),
            "Explicitly discard one current draft after its accepted saves settle",
            json!({"window":"window-example","draft":"draft-example","source":{"revision":content_digest(b"source"),"contribution":"editor"},"expected_version":1}),
        ),
        _ => unreachable!(),
    };
    let operation = kind == host::CapabilityKind::Operation;
    host::CapabilityDescriptor {
        kind, capability: key(id), domain: "documents".into(), input_schema: input, output_schema: output,
        recovery_schema: json!({"type":["object","null"]}), required_scopes: BTreeSet::from([scope.into()]),
        potential_effects: BTreeSet::new(),
        idempotency: if operation { host::IdempotencyClass::CallerScoped } else { host::IdempotencyClass::Pure },
        retry: if operation { host::RetryClass::ReconcileFirst } else { host::RetryClass::Safe },
        cancellation: host::CancellationClass::Unsupported,
        documentation: host::CapabilityDocumentation {
            summary: summary.into(), purpose: summary.into(), owner: "documents".into(),
            when_to_use: vec!["Synchronize opaque document bytes independently of a view's small presentation-state record.".into()],
            limitations: vec![
                "Host project and authenticated principal define storage scope. A plugin view can address only its original window. Source revision/contribution describes the encoding owner; it is not authority supplied by the caller.".into(),
                "A draft version is current synchronized content, not a file-save receipt, immutable execution capture, scientific result or runtime checkpoint. Reads never start providers, create drafts or collect bytes.".into(),
                "Unaccepted chunks expire after ten minutes; accepted captures remain protected until original settlement. Discard leaves a tombstone and cannot erase a pending save. An uncertain original outcome retains recovery material.".into(),
                "Save/discard checks the exact document version and source inside the publication transaction; an absent version creates only an unused draft identity.".into(),
                "Listing excludes discarded drafts and returns at most 20 metadata summaries in lexical identity order. Its exclusive cursor is not a snapshot: subsequent pages can observe later changes. Inspect/read verifies an exact version before using content. Listing does not extend close-time or inactive-instance persistence grants.".into(),
            ],
            effects: match kind {
                host::CapabilityKind::Query => "Bounded read of retained metadata or exact current bytes.",
                host::CapabilityKind::Control => "Stage/renew this upload's immutable chunk lease; no saved draft or Operation is created. Explicit writes collect expired unaccepted chunks.",
                _ => "Change only the named scoped draft by native compare-and-swap through the shared Operation gateway. No filesystem, scientific runtime or backend is changed.",
            }.into(),
            retry_rule: if operation { "Keep the original client_request_id and arguments. Inspect operation.get/commit_status after lost acknowledgement; reconcile the original commit without replaying the save. plugins.reconcile_references can release a settled capture using its original authority." } else { "Repeat the same bounded observation or staging upload. Staging acknowledgement alone does not attest to a saved draft." }.into(),
            cancellation_rule: "Disconnect or timeout cannot undo a save, discard content or confirm cancellation.".into(),
            preconditions: vec![],
            examples: vec![host::CapabilityExample { arguments: example, result_explanation: "Scoped native draft metadata or bytes, distinct from the original Operation's authoritative outcome.".into() }],
            related_capabilities: vec![key("documents.list"), key("documents.inspect"), key("documents.read"), key("documents.save"), key("operation.get"), key("operation.commit_status")],
            related_skills: vec![],
            position_units: vec!["Offsets, limits and lengths are bytes. Chunks/read pages are at most 64 KiB, complete content at most 8 MiB, and metadata at most 32 KiB.".into()],
        },
    }
}

struct Read {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
}
#[async_trait]
impl QueryHandler for Read {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        match self.descriptor.capability.id.as_str() {
            "documents.list" => {
                let args: ListDocumentDrafts = decode(value)?;
                args.validate().map_err(invalid)?;
                serde_json::to_value(args).map_err(invalid)
            }
            "documents.inspect" => normalize::<DocumentDraftArguments>(value),
            _ => normalize::<ReadDocumentDraft>(value),
        }
    }
    async fn query(&self, _: &Value) -> Result<host::QuerySnapshot, OperationError> {
        Err(invalid("draft reads require authenticated caller context"))
    }
    async fn query_for(
        &self,
        context: &host::CallContext,
        value: &Value,
    ) -> Result<host::QuerySnapshot, OperationError> {
        let principal = plugin_principal_id(context.principal());
        let (target, data) = if self.descriptor.capability.id == "documents.list" {
            let mut args: ListDocumentDrafts = decode(value)?;
            if let Some(source) = self
                .service
                .draft_view_source(context, &args.window, false)?
            {
                check_source(Some(&source), args.source.as_ref())?;
                args.source = Some(source);
            }
            let data = self
                .service
                .repository
                .lock()
                .unwrap()
                .document_drafts(&self.service.project, &principal, &args)
                .map_err(fault)?;
            (
                host::TargetRef {
                    kind: "document_drafts".into(),
                    identity: content_digest(
                        format!("{}:{principal}:{}", self.service.project, args.window).as_bytes(),
                    )
                    .to_string(),
                },
                json!(data),
            )
        } else if self.descriptor.capability.id == "documents.inspect" {
            let args: DocumentDraftArguments = decode(value)?;
            let source = self
                .service
                .draft_view_source(context, &args.window, false)?;
            let data = self
                .service
                .repository
                .lock()
                .unwrap()
                .document_draft(&self.service.project, &principal, &args)
                .map_err(fault)?;
            check_source(source.as_ref(), data.as_ref().map(|draft| &draft.source))?;
            (
                target(&self.service, &principal, &args.window, &args.draft),
                json!(data),
            )
        } else {
            let args: ReadDocumentDraft = decode(value)?;
            let source = self
                .service
                .draft_view_source(context, &args.window, false)?;
            if source.is_some() {
                let current = self
                    .service
                    .repository
                    .lock()
                    .unwrap()
                    .document_draft(
                        &self.service.project,
                        &principal,
                        &DocumentDraftArguments {
                            window: args.window.clone(),
                            draft: args.draft.clone(),
                        },
                    )
                    .map_err(fault)?;
                check_source(source.as_ref(), current.as_ref().map(|draft| &draft.source))?;
            }
            let data = self
                .service
                .repository
                .lock()
                .unwrap()
                .read_document_draft(&self.service.project, &principal, args.clone())
                .map_err(fault)?;
            (
                target(&self.service, &principal, &args.window, &args.draft),
                json!(data),
            )
        };
        Ok(host::QuerySnapshot {
            target,
            source: "documents/retained-draft".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: host::QueryStatus::Ready,
            completeness: host::ObservationCompleteness::Complete,
            notices: vec![],
            next_reads: vec![],
            diagnostics: vec![],
            data: Some(data),
        })
    }
}
struct Stage {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
}
#[async_trait]
impl ControlHandler for Stage {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    async fn control(
        &self,
        context: &host::CallContext,
        value: Value,
    ) -> Result<Value, OperationError> {
        let args: StageDraftChunk = decode(&value)?;
        let source = self
            .service
            .draft_view_source(context, &args.window, true)?;
        if source.is_some() {
            let current = self
                .service
                .repository
                .lock()
                .unwrap()
                .document_draft(
                    &self.service.project,
                    &plugin_principal_id(context.principal()),
                    &DocumentDraftArguments {
                        window: args.window.clone(),
                        draft: args.draft.clone(),
                    },
                )
                .map_err(fault)?;
            check_source(source.as_ref(), current.as_ref().map(|draft| &draft.source))?;
        }
        // Keep transient content out of diagnostics just as at other Control edges.
        let result = self
            .service
            .repository
            .lock()
            .unwrap()
            .stage_draft_chunk(
                &self.service.project,
                &plugin_principal_id(context.principal()),
                args,
                now()?,
            )
            .map_err(|_| invalid("draft chunk could not be staged (arguments redacted)"))?;
        Ok(json!(result))
    }
}

fn target(
    service: &PluginService,
    principal: &PrincipalId,
    window: &WindowId,
    draft: &DraftId,
) -> host::TargetRef {
    host::TargetRef {
        kind: "document_draft".into(),
        identity: content_digest(
            format!("{}:{principal}:{window}:{draft}", service.project).as_bytes(),
        )
        .to_string(),
    }
}
struct Write {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    context: Option<host::CallContext>,
}
impl Write {
    fn saving(&self) -> bool {
        self.descriptor.capability.id == "documents.save"
    }
    fn context(&self) -> Result<&host::CallContext, OperationError> {
        self.context
            .as_ref()
            .ok_or_else(|| invalid("unbound draft operation"))
    }
    fn identity(
        &self,
        value: &Value,
    ) -> Result<(WindowId, DraftId, DraftSource, Option<u32>), OperationError> {
        if self.saving() {
            let args: SaveDocumentDraft = decode(value)?;
            args.validate().map_err(invalid)?;
            Ok((args.window, args.draft, args.source, args.expected_version))
        } else {
            let args: DiscardDocumentDraft = decode(value)?;
            Ok((
                args.window,
                args.draft,
                args.source,
                Some(args.expected_version),
            ))
        }
    }
}
#[async_trait]
impl OperationHandler for Write {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.service.scope.clone())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        if self.saving() {
            normalize::<SaveDocumentDraft>(value)
        } else {
            normalize::<DiscardDocumentDraft>(value)
        }
    }
    fn resolve_target(&self, value: &Value) -> Result<host::TargetRef, OperationError> {
        let (window, draft, _, _) = self.identity(value)?;
        Ok(target(
            &self.service,
            &plugin_principal_id(self.context()?.principal()),
            &window,
            &draft,
        ))
    }
    async fn bind(
        &self,
        context: &host::CallContext,
        value: &Value,
        preconditions: &[host::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !preconditions.is_empty() {
            return Err(invalid(
                "draft operations use their explicit source and document version",
            ));
        }
        let (window, draft, source, version) = self.identity(value)?;
        let required_source = self.service.draft_view_source(context, &window, true)?;
        check_source(required_source.as_ref(), Some(&source))?;
        let repo = self.service.repository.lock().unwrap();
        let revision = repo.revision(&source.revision).map_err(fault)?;
        if !revision
            .manifest
            .views
            .iter()
            .any(|view| view.id == source.contribution)
        {
            return Err(invalid("draft source must be an exact contributed view"));
        }
        let current = repo
            .document_draft(
                &self.service.project,
                &plugin_principal_id(context.principal()),
                &DocumentDraftArguments { window, draft },
            )
            .map_err(fault)?;
        match (current, version) {
            (None, None) if self.saving() => {}
            (Some(current), Some(version))
                if !current.discarded && current.version == version && current.source == source => {
            }
            _ => {
                return Err(OperationError::ContentChanged(
                    "document draft changed".into(),
                ));
            }
        }
        Ok(Some(Arc::new(Self {
            service: self.service.clone(),
            descriptor: self.descriptor.clone(),
            context: Some(context.clone()),
        })))
    }
    fn admitted(&self, operation: &host::Operation) -> Result<(), HandlerError> {
        if self.saving() {
            let retain = || -> Result<(), OperationError> {
                self.service
                    .repository
                    .lock()
                    .unwrap()
                    .retain_draft_upload(
                        &self.service.project,
                        &plugin_principal_id(self.context()?.principal()),
                        &OperationId::new(operation.operation_id.as_str()).map_err(invalid)?,
                        &decode(&operation.normalized_arguments)?,
                        now()?,
                    )
                    .map_err(fault)
            };
            retain().map_err(|e| HandlerError::before_effect(e.to_string()))?;
        }
        Ok(())
    }
    async fn acquire_execution(
        &self,
        _: &host::Operation,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(DraftLease {
            service: self.service.clone(),
            saving: self.saving(),
        }))
    }
    async fn execute(&self, operation: &host::Operation) -> Result<CommitPlan, HandlerError> {
        let run = || -> Result<Value, OperationError> {
            let principal = plugin_principal_id(self.context()?.principal());
            // Admission already fixed authority. An accepted save remains owned
            // by Host even if the requesting view closes or its instance exits.
            let mut repo = self.service.repository.lock().unwrap();
            let draft = if self.saving() {
                repo.save_document_draft(
                    &self.service.project,
                    &principal,
                    decode(&operation.normalized_arguments)?,
                    now()?,
                )
            } else {
                repo.discard_document_draft(
                    &self.service.project,
                    &principal,
                    decode(&operation.normalized_arguments)?,
                )
            }
            .map_err(fault)?;
            Ok(json!(draft))
        };
        run().map(CommitPlan::succeeded).map_err(|e| {
            if matches!(&e, OperationError::ContentChanged(_) | OperationError::InvalidInput(_) | OperationError::NotFound(_)) { HandlerError::before_effect(e.to_string()) }
            else { HandlerError::after_possible_effect(e.to_string(), Some(json!({"kind":"document_draft","target":operation.target,"automatic_reexecution":false}))) }
        })
    }
}
struct DraftLease {
    service: Arc<PluginService>,
    saving: bool,
}
#[async_trait]
impl ExecutionLease for DraftLease {
    async fn completed(&mut self, result: &Result<host::OperationRecord, OperationError>) {
        if self.saving
            && let Ok(record) = result
            && let Err(error) = self.service.complete_draft_save(record)
        {
            eprintln!("original draft save retains its capture: {error}");
        }
    }
}
impl PluginService {
    /// Native scope and lifetime, never a caller assertion of ownership. Normal
    /// active views keep their declared authority. Close-time/inactive-instance
    /// persistence is narrowed to the original view's exact encoding source.
    fn draft_view_source(
        &self,
        context: &host::CallContext,
        window: &WindowId,
        writing: bool,
    ) -> Result<Option<DraftSource>, OperationError> {
        self.check_window_context(context, window)?;
        let inherited = context
            .view_scope
            .as_ref()
            .and_then(|scope| scope.draft_source.clone());
        if context.caller.kind != host::CallerKind::Plugin {
            return Ok(inherited);
        }
        let Ok(view) = ViewInstanceId::new(&context.caller.id) else {
            return Ok(inherited);
        };
        let record = match self.view_record(context, &view) {
            Ok(record) => record,
            Err(OperationError::NotFound(_)) => return Ok(inherited),
            Err(error) => return Err(error),
        };
        if record.closed {
            return Err(invalid("view is closed"));
        }
        let closing = {
            let views = self.views.lock().unwrap();
            let live = views
                .get(&view)
                .ok_or_else(|| invalid("view connection is no longer present"))?;
            if writing
                && live
                    .closing
                    .as_ref()
                    .is_some_and(|close| close.sealed(live.renderers.len()))
            {
                return Err(OperationError::ContentChanged(
                    "view drafts are sealed for closure".into(),
                ));
            }
            live.closing.is_some()
        };
        let active = self.runtime.observe().iter().any(|observation| {
            observation.instance.identity == record.instance
                && observation.instance.state == InstanceState::Active
        });
        if closing || !active {
            let source = DraftSource {
                revision: record.instance.revision,
                contribution: record.contribution,
            };
            if inherited
                .as_ref()
                .is_some_and(|original| original != &source)
            {
                return Err(invalid("call is restricted to its original draft source"));
            }
            Ok(Some(source))
        } else {
            Ok(inherited)
        }
    }
    pub(crate) fn complete_draft_save(
        &self,
        record: &host::OperationRecord,
    ) -> Result<(), OperationError> {
        if record.operation.capability != key("documents.save")
            || record.operation.domain != "documents"
            || record.operation.idempotency_scope.as_deref() != Some(self.scope.as_str())
        {
            return Err(OperationError::NotFound(
                record.operation.operation_id.as_str().into(),
            ));
        }
        if !matches!(
            record.status,
            host::OperationStatus::Succeeded
                | host::OperationStatus::Failed
                | host::OperationStatus::Cancelled
        ) {
            return Err(OperationError::Unavailable(
                "original draft outcome is unresolved; retain its capture".into(),
            ));
        }
        self.repository
            .lock()
            .unwrap()
            .release_draft_upload(
                &self.project,
                &plugin_principal_id(record.operation.principal()),
                &OperationId::new(record.operation.operation_id.as_str()).map_err(invalid)?,
                now()?,
            )
            .map_err(fault)
    }
}
