use rho_application::{ApplicationError, ApplicationOwner};
use rho_contract::*;
use rho_operation::{Clock, OperationError, QueryHandler, SystemClock};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

pub(crate) fn error(error: ApplicationError) -> OperationError {
    match error {
        ApplicationError::NotFound => OperationError::NotFound(error.to_string()),
        ApplicationError::Offline => OperationError::Unavailable(error.to_string()),
        ApplicationError::IncarnationChanged => OperationError::StaleSession(error.to_string()),
        ApplicationError::Conflict => OperationError::ContentChanged(error.to_string()),
        ApplicationError::RequestConflict => OperationError::IdempotencyConflict,
        ApplicationError::AccessDenied { missing } => OperationError::AccessDenied {
            capability: "application.control".into(),
            missing,
        },
        ApplicationError::Budget(_) => OperationError::BudgetExceeded(error.to_string()),
        ApplicationError::Storage(_) => OperationError::Storage(error.to_string()),
        _ => OperationError::InvalidInput(error.to_string()),
    }
}
pub(crate) fn now() -> Result<u64, OperationError> {
    Ok(SystemClock.now_ms()?.max(0) as u64)
}
pub(crate) fn scope(
    context: &CallContext,
    capability: &str,
    required: &str,
) -> Result<(), OperationError> {
    context.validate()?;
    if !context.scopes.contains(required) {
        return Err(OperationError::AccessDenied {
            capability: capability.into(),
            missing: vec![required.into()],
        });
    }
    Ok(())
}
pub(crate) fn studio(context: &CallContext) -> Result<(), OperationError> {
    scope(context, "application.bridge", "application.control")?;
    if context.caller.kind != CallerKind::Human || !context.connection_id.starts_with("studio:") {
        return Err(OperationError::AccessDenied {
            capability: "application.bridge".into(),
            missing: vec!["trusted Studio transport".into()],
        });
    }
    Ok(())
}
pub(crate) fn descriptor(id: &str) -> CapabilityDescriptor {
    let window = json!({"window_id":"window-example","incarnation":"incarnation-example"});
    let (summary, purpose, input, output, arguments) = match id {
        "application.windows" => (
            "Discover Studio windows",
            "Read principal-visible window incarnations, liveness and synchronized context identities. Multiple windows are never implicitly collapsed into one current window.",
            schema_for!(ApplicationWindowsArguments).to_value(),
            schema_for!(ApplicationWindows).to_value(),
            json!({"limit":20}),
        ),
        "application.context" => (
            "Inspect one window's work",
            "Read compact current document, dirty/selection identities, selected objects/packages/plots and view state. Live requests require a leased window; allow_offline explicitly reads synchronized history.",
            schema_for!(ApplicationContextArguments).to_value(),
            schema_for!(ApplicationContext).to_value(),
            json!({"window":window,"limit":20}),
        ),
        "application.read_document" => (
            "Read an identified draft or base",
            "Page an exact document version and expected digest. Draft and saved base content have distinct identities; positions use zero-based UTF-8 bytes for reading and zero-based UTF-16 for editor selection.",
            schema_for!(ApplicationReadDocumentArguments).to_value(),
            schema_for!(ApplicationDocumentPage).to_value(),
            json!({"window":window,"document":{"document_id":"document-example","document_version":"version-example","selection_version":"selection-example"},"expected_sha256":"sha256:example","offset_utf8":0,"limit_bytes":16384}),
        ),
        "application.command_status" => (
            "Verify an application command",
            "Read the original command receipt, including application synchronization, captured save/run steps and scientific operation IDs. A pending/claimed receipt is not proof of local application or scientific completion.",
            schema_for!(ApplicationCommandStatusArguments).to_value(),
            schema_for!(ApplicationCommandReceipt).to_value(),
            json!({"window":window,"request_id":"request-example"}),
        ),
        "application.control" => (
            "Control an explicit Studio window",
            "Admit a version-bound application command for one window incarnation. The resident bridge applies it through module commands. Saving/running captures immutable text and preserves original Agent identity through the shared scientific gateway. Offline commands are unavailable; unclaimed commands expire after 30 seconds.",
            schema_for!(ApplicationCommandRequest).to_value(),
            schema_for!(ApplicationCommandReceipt).to_value(),
            json!({"window":window,"request_id":"request-example","action":{"kind":"open_view","view_type":"console","view_id":null,"expected_context_version":"context-example"}}),
        ),
        _ => unreachable!(),
    };
    let control = id == "application.control";
    CapabilityDescriptor{kind:if control{CapabilityKind::Control}else{CapabilityKind::Query},capability:CapabilityRef::new(id,1).unwrap(),domain:"application".into(),input_schema:input,output_schema:output,recovery_schema:json!({"type":"null"}),required_scopes:BTreeSet::from([if control{"application.control"}else{"application.read"}.into()]),potential_effects:BTreeSet::new(),idempotency:if control{IdempotencyClass::CallerScoped}else{IdempotencyClass::Pure},retry:if control{RetryClass::ReconcileFirst}else{RetryClass::Safe},cancellation:CancellationClass::Unsupported,
    documentation:CapabilityDocumentation{summary:summary.into(),purpose:purpose.into(),owner:"application".into(),when_to_use:vec![purpose.into()],limitations:vec!["Activation selects a view inside Studio; it does not bring an operating-system window to the foreground.".into(),"A disconnected browser never automatically submits a previously unsubmitted scientific step. Accepted scientific work remains Host-owned. Content and Skills cannot change permissions.".into()],effects:if control{purpose.into()}else{"Read bounded application observations; never start R or run code.".into()},retry_rule:"Retain request_id and expected resource identities. A duplicate command retrieves its original receipt; changed input under the same request_id is rejected. On uncertainty, inspect the receipt and original scientific record without replaying.".into(),cancellation_rule:"No application command cancellation is promised. Scientific cancellation is requested by its original OperationId and requires an owner-confirmed outcome.".into(),preconditions:vec![CapabilityPrecondition{parameter:"window and resource versions".into(),requirement:"Read application.windows, then application.context to obtain the exact window incarnation and document/selection/context identities.".into(),read_from:Some(CapabilityRef::new("application.windows",1).unwrap())}],examples:vec![CapabilityExample{arguments,result_explanation:"Check window identity, liveness/source and exact receipt state. Capture, save, run, local apply and synchronized completion are distinct facts; only terminal scientific records establish scientific completion.".into()}],related_capabilities:vec![CapabilityRef::new("application.windows",1).unwrap(),CapabilityRef::new("application.context",1).unwrap(),CapabilityRef::new("application.command_status",1).unwrap()],related_skills:vec![],position_units:vec!["File lines and R indices start at 1; editor selections/edits use zero-based UTF-16 offsets. Document text paging uses UTF-8 byte offsets.".into()]}}
}
pub(crate) struct ApplicationHandler {
    pub(crate) owner: Arc<ApplicationOwner>,
    journal: Arc<dyn rho_operation::OperationJournal>,
    descriptor: CapabilityDescriptor,
    project: String,
}
impl ApplicationHandler {
    pub(crate) fn new(
        owner: Arc<ApplicationOwner>,
        journal: Arc<dyn rho_operation::OperationJournal>,
        project: String,
        id: &str,
    ) -> Self {
        Self {
            owner,
            journal,
            descriptor: descriptor(id),
            project,
        }
    }
}
#[async_trait::async_trait]
impl QueryHandler for ApplicationHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, args: &Value) -> Result<Value, OperationError> {
        Ok(args.clone())
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "caller context required".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        args: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let time = now()?;
        let data = match self.descriptor.capability.id.as_str() {
            "application.windows" => serde_json::to_value(
                self.owner
                    .windows(context, parse(args)?, time)
                    .map_err(error)?,
            ),
            "application.context" => serde_json::to_value(
                self.owner
                    .context(context, parse(args)?, time)
                    .map_err(error)?,
            ),
            "application.read_document" => serde_json::to_value(
                self.owner
                    .read_document(context, parse(args)?, time)
                    .map_err(error)?,
            ),
            "application.command_status" => {
                let arguments: ApplicationCommandStatusArguments = parse(args)?;
                for (request, lookup) in self
                    .owner
                    .status_executions(context, &arguments)
                    .map_err(error)?
                {
                    let record = if let Some(id) = lookup.operation_id {
                        self.journal.get(&id).await?
                    } else {
                        self.journal
                            .get_request(
                                &lookup.context.caller,
                                lookup.context.principal(),
                                Some(&self.project),
                                &lookup.client_request_id,
                            )
                            .await?
                    };
                    if let Some(record) = record {
                        if record.operation.principal() == lookup.context.principal()
                            && record.operation.idempotency_scope.as_deref()
                                == Some(self.project.as_str())
                        {
                            self.owner
                                .record_execution(context, &request, &record, time)
                                .map_err(error)?;
                        }
                    }
                }
                serde_json::to_value(
                    self.owner
                        .command_status(context, arguments, time)
                        .map_err(error)?,
                )
            }
            _ => unreachable!(),
        }
        .map_err(|e| OperationError::Contract(e.to_string()))?;
        let mut next_reads = Vec::new();
        let id = self.descriptor.capability.id.as_str();
        for (result_field, input_field) in [
            ("next_after_window_id", "after_window_id"),
            ("next_after_document_id", "after_document_id"),
            ("next_offset_utf8", "offset_utf8"),
        ] {
            if let Some(value) = data.get(result_field).filter(|v| !v.is_null()) {
                let mut next = args.clone();
                next[input_field] = value.clone();
                next_reads.push(NextRead::query(
                    id,
                    "Continue the same identified application observation",
                    next,
                ));
            }
        }
        let source = data
            .get("source")
            .and_then(Value::as_str)
            .map(|source| format!("application/{source}"))
            .unwrap_or_else(|| "application/owner".into());
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "project".into(),
                identity: self.project.clone(),
            },
            source,
            observed_at_ms: time as i64,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Partial,
            data: Some(data),
            notices: vec![],
            next_reads,
            diagnostics: vec![],
        })
    }
}
fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, OperationError> {
    serde_json::from_value(value.clone()).map_err(|e| OperationError::InvalidInput(e.to_string()))
}
