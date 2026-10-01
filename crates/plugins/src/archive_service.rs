//! Public package transfer ports. Catalog publication and transfer receipts share
//! a transaction; only the original Operation journal establishes its outcome.
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
        PluginError::Missing(message) => OperationError::NotFound(message),
        PluginError::Invalid(message) => invalid(message),
        PluginError::Contract(message) => invalid(message),
        other => error(other),
    }
}
fn target(service: &PluginService, principal: &PrincipalId, identity: &str) -> host::TargetRef {
    host::TargetRef {
        kind: "plugin_archive".into(),
        identity: content_digest(format!("{}:{principal}:{identity}", service.project).as_bytes())
            .to_string(),
    }
}
pub(crate) fn register(
    service: &Arc<PluginService>,
    registry: &mut CapabilityRegistry,
) -> Result<(), OperationError> {
    for id in [
        "plugins.archive_progress",
        "plugins.archive_read",
        "plugins.archive_inspect",
        "plugins.archive_receipt",
    ] {
        registry.register_query(Arc::new(Read {
            service: service.clone(),
            descriptor: descriptor(id),
        }))?;
    }
    for id in ["plugins.archive_stage", "plugins.archive_discard"] {
        registry.register_control_handler(Arc::new(Stage {
            service: service.clone(),
            descriptor: descriptor(id),
        }))?;
    }
    for id in ["plugins.archive_import", "plugins.archive_export"] {
        registry.register(Arc::new(Write {
            service: service.clone(),
            descriptor: descriptor(id),
            context: None,
        }))?;
    }
    Ok(())
}
fn descriptor(id: &str) -> host::CapabilityDescriptor {
    let reference =
        json!({"archive":"archive-example","digest":content_digest(b"example"),"bytes":7});
    let (kind, input, output, summary, example) = match id {
        "plugins.archive_discard" => (
            host::CapabilityKind::Control,
            schema_for!(PluginArchiveArguments).to_value(),
            schema_for!(PluginArchiveDiscarded).to_value(),
            "Discard an exact unheld archive transfer",
            json!({"reference":reference}),
        ),
        "plugins.archive_stage" => (
            host::CapabilityKind::Control,
            schema_for!(StagePluginArchive).to_value(),
            schema_for!(PluginArchiveProgress).to_value(),
            "Stage an immutable package archive chunk",
            json!({"reference":reference,"offset":0,"base64":"ZXhhbXBsZQ=="}),
        ),
        "plugins.archive_progress" => (
            host::CapabilityKind::Query,
            schema_for!(PluginArchiveArguments).to_value(),
            schema_for!(PluginArchiveProgress).to_value(),
            "Observe retained archive upload progress",
            json!({"reference":reference}),
        ),
        "plugins.archive_read" => (
            host::CapabilityKind::Query,
            schema_for!(ReadPluginArchive).to_value(),
            schema_for!(PluginArchiveChunk).to_value(),
            "Read a bounded page of an exact package archive",
            json!({"reference":reference,"offset":0,"limit":65536}),
        ),
        "plugins.archive_inspect" => (
            host::CapabilityKind::Query,
            schema_for!(PluginArchiveArguments).to_value(),
            schema_for!(PluginArchiveInspection).to_value(),
            "Validate staged archive bytes and inspect package metadata",
            json!({"reference":reference}),
        ),
        "plugins.archive_receipt" => (
            host::CapabilityKind::Query,
            schema_for!(PluginArchiveOperationArguments).to_value(),
            schema_for!(Option<PluginArchiveReceipt>).to_value(),
            "Inspect an original archive catalog transaction receipt",
            json!({"operation_id":"operation-example"}),
        ),
        "plugins.archive_import" => (
            host::CapabilityKind::Operation,
            schema_for!(PluginArchiveArguments).to_value(),
            schema_for!(PluginArchiveReceipt).to_value(),
            "Import an exact verified archive into the package catalog",
            json!({"reference":reference}),
        ),
        "plugins.archive_export" => (
            host::CapabilityKind::Operation,
            schema_for!(ExportPluginArchive).to_value(),
            schema_for!(PluginArchiveReceipt).to_value(),
            "Prepare a downloadable archive of exact source and artifacts",
            json!({"revision":content_digest(b"revision"),"artifacts":[]}),
        ),
        _ => unreachable!(),
    };
    let operation = kind == host::CapabilityKind::Operation;
    host::CapabilityDescriptor {
        capability:key(id), kind, domain:"plugins".into(), input_schema:input, output_schema:output,
        recovery_schema:json!({"type":["object","null"]}),
        required_scopes:BTreeSet::from([if matches!(id,"plugins.archive_stage"|"plugins.archive_discard"|"plugins.archive_import") {PLUGINS_WRITE_SCOPE} else {PLUGINS_READ_SCOPE}.into()]),
        potential_effects:if id == "plugins.archive_export" {BTreeSet::from([host::EffectHint::ProducesArtifact])} else {BTreeSet::new()},
        idempotency:if operation {host::IdempotencyClass::CallerScoped} else {host::IdempotencyClass::Pure},
        retry:if operation {host::RetryClass::ReconcileFirst} else {host::RetryClass::Safe},
        cancellation:host::CancellationClass::Unsupported,
        documentation:host::CapabilityDocumentation {
            summary:summary.into(),purpose:summary.into(),owner:"plugins".into(),
            when_to_use:vec!["Transfer local packages through the same authenticated Host ports used by views, CLI and agents.".into()],
            limitations:vec![
                "Transfers belong to the native project and authenticated principal. A reference binds identity, exact length and SHA-256. No caller-supplied filesystem paths are accepted.".into(),
                "Staged completeness only counts immutable ranges. Inspection/import verifies the full checksum, source, artifacts, paths and package contract; it never builds or starts a plugin.".into(),
                "Export includes only the explicitly selected, sorted artifact identities. An empty selection exports source only. Preparation is not evidence that a browser saved a local file.".into(),
                "Explicit archive_discard removes only an unheld transfer, never package content, original receipts or accepted recovery bytes. Transfers expire 24 hours after their last stage or confirmed original settlement. Mutation collects expired unheld transfers; reads never renew or collect them. Accepted unresolved operations retain bytes and exact source protections.".into(),
                "Per principal: 16 transfers and twice the maximum archive size; per repository: 128 transfers and eight times that size. Declared lengths reserve capacity before upload.".into(),
                "Catalog receipts prove one atomic package/transfer transaction only. Missing receipt is not permission to replay; Operation remains authoritative about success, failure or uncertainty.".into(),
            ],
            effects:if operation {"Import publishes verified catalog bytes; export prepares immutable transfer bytes. Neither activates an instance, changes a scenario, runs build scripts or writes scientific results."} else {"Stage stores transient bytes; discard explicitly removes only unheld transfer bytes. Queries observe retained metadata/bytes without creating, installing or executing packages."}.into(),
            retry_rule:"Retain the original client_request_id and exact arguments. After a lost reply inspect operation.get/commit_status and the original archive receipt. Reconcile original settlement before releasing references; never replay uncertain work.".into(),
            cancellation_rule:"Disconnect is not rollback or cancellation confirmation.".into(),
            preconditions:vec![],examples:vec![host::CapabilityExample {arguments:example,result_explanation:"Scoped transfer state or the original archive receipt; it does not establish activation or local-file persistence.".into()}],
            related_capabilities:vec![key("plugins.archive_inspect"),key("plugins.archive_receipt"),key("operation.get"),key("operation.commit_status"),key("plugins.reconcile_references")],related_skills:vec![],
            position_units:vec![format!("Offsets and lengths are bytes. Upload chunks are exactly 64 KiB except the final chunk; read pages are at most 64 KiB. Maximum archive size is {MAX_PLUGIN_ARCHIVE_BYTES} bytes.")],
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
            "plugins.archive_read" => normalize::<ReadPluginArchive>(value),
            "plugins.archive_receipt" => normalize::<PluginArchiveOperationArguments>(value),
            _ => normalize::<PluginArchiveArguments>(value),
        }
    }
    async fn query(&self, _: &Value) -> Result<host::QuerySnapshot, OperationError> {
        Err(invalid("archive queries require authenticated context"))
    }
    async fn query_for(
        &self,
        context: &host::CallContext,
        value: &Value,
    ) -> Result<host::QuerySnapshot, OperationError> {
        let service = self.service.clone();
        let principal = plugin_principal_id(context.principal());
        let id = self.descriptor.capability.id.to_string();
        let value = value.clone();
        let (target, data) = tokio::task::spawn_blocking(move || -> Result<_, OperationError> {
            let repo = service.repository.lock().unwrap();
            let (identity, data) = match id.as_str() {
                "plugins.archive_receipt" => {
                    let args: PluginArchiveOperationArguments = decode(&value)?;
                    let data = repo
                        .archive_operation_receipt(&service.project, &principal, &args.operation_id)
                        .map_err(fault)?;
                    (args.operation_id.to_string(), json!(data))
                }
                "plugins.archive_read" => {
                    let args: ReadPluginArchive = decode(&value)?;
                    let data = repo
                        .read_archive_chunk(&service.project, &principal, &args)
                        .map_err(fault)?;
                    (args.reference.archive.to_string(), json!(data))
                }
                _ => {
                    let args: PluginArchiveArguments = decode(&value)?;
                    let data = if id == "plugins.archive_inspect" {
                        json!(
                            repo.inspect_archive(&service.project, &principal, &args.reference)
                                .map_err(fault)?
                        )
                    } else {
                        json!(
                            repo.archive_progress(&service.project, &principal, &args.reference)
                                .map_err(fault)?
                        )
                    };
                    (args.reference.archive.to_string(), data)
                }
            };
            Ok((target(&service, &principal, &identity), data))
        })
        .await
        .map_err(error)??;
        Ok(host::QuerySnapshot {
            target,
            source: "plugins/archive".into(),
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
        if self.descriptor.capability.id == "plugins.archive_discard" {
            let args: PluginArchiveArguments = decode(&value)?;
            let service = self.service.clone();
            let principal = plugin_principal_id(context.principal());
            let result = tokio::task::spawn_blocking(move || {
                service.repository.lock().unwrap().discard_archive(
                    &service.project,
                    &principal,
                    &args.reference,
                )
            })
            .await
            .map_err(error)?
            .map_err(fault)?;
            return Ok(json!(result));
        }
        let args: StagePluginArchive =
            decode(&value).map_err(|_| invalid("invalid archive chunk (arguments redacted)"))?;
        let service = self.service.clone();
        let principal = plugin_principal_id(context.principal());
        let now = now()?;
        let result = tokio::task::spawn_blocking(move || {
            service.repository.lock().unwrap().stage_archive(
                &service.project,
                &principal,
                &args,
                now,
            )
        })
        .await
        .map_err(error)?
        .map_err(fault)?;
        Ok(json!(result))
    }
}
struct Write {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    context: Option<host::CallContext>,
}
impl Write {
    fn importing(&self) -> bool {
        self.descriptor.capability.id == "plugins.archive_import"
    }
    fn principal(&self) -> Result<PrincipalId, OperationError> {
        self.context
            .as_ref()
            .map(|c| plugin_principal_id(c.principal()))
            .ok_or_else(|| invalid("archive operation was not bound"))
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
        if self.importing() {
            let args: PluginArchiveArguments = decode(value)?;
            args.reference.validate().map_err(invalid)?;
            Ok(json!(args))
        } else {
            let args: ExportPluginArchive = decode(value)?;
            args.validate().map_err(invalid)?;
            Ok(json!(args))
        }
    }
    fn resolve_target(&self, value: &Value) -> Result<host::TargetRef, OperationError> {
        let identity = if self.importing() {
            decode::<PluginArchiveArguments>(value)?
                .reference
                .archive
                .to_string()
        } else {
            decode::<ExportPluginArchive>(value)?.revision.to_string()
        };
        Ok(target(&self.service, &self.principal()?, &identity))
    }
    fn execution_context(&self) -> Value {
        json!({"archive_operation":true})
    }
    async fn bind(
        &self,
        context: &host::CallContext,
        value: &Value,
        preconditions: &[host::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !preconditions.is_empty() {
            return Err(invalid(
                "archive operations use exact content references, not unrelated native preconditions",
            ));
        }
        self.normalize_arguments(value)?;
        // Cheap admission checks only. Full package validation runs on a blocking
        // worker after the original operation owns the immutable capture.
        let repo = self.service.repository.lock().unwrap();
        if self.importing() {
            let args: PluginArchiveArguments = decode(value)?;
            if !repo
                .archive_progress(
                    &self.service.project,
                    &plugin_principal_id(context.principal()),
                    &args.reference,
                )
                .map_err(fault)?
                .complete
            {
                return Err(invalid("archive upload is incomplete"));
            }
        } else {
            let args: ExportPluginArchive = decode(value)?;
            repo.revision(&args.revision).map_err(fault)?;
            for id in args.artifacts {
                if repo.artifact(&id).map_err(fault)?.revision != args.revision {
                    return Err(invalid("export artifact belongs to another revision"));
                }
            }
        }
        Ok(Some(Arc::new(Self {
            service: self.service.clone(),
            descriptor: self.descriptor.clone(),
            context: Some(context.clone()),
        })))
    }
    fn admitted(&self, operation: &host::Operation) -> Result<(), HandlerError> {
        let retain = || -> Result<(), OperationError> {
            let mut repo = self.service.repository.lock().unwrap();
            if self.importing() {
                let args: PluginArchiveArguments = decode(&operation.normalized_arguments)?;
                repo.hold_archive(
                    &self.service.project,
                    &self.principal()?,
                    &OperationId::new(operation.operation_id.as_str()).map_err(invalid)?,
                    &args.reference,
                )
                .map_err(fault)
            } else {
                let args: ExportPluginArchive = decode(&operation.normalized_arguments)?;
                repo.retain(
                    "archive_export",
                    operation.operation_id.as_str(),
                    &args.revision,
                )
                .map_err(fault)
            }
        };
        retain().map_err(|e| HandlerError::before_effect(e.to_string()))
    }
    async fn acquire_execution(
        &self,
        _: &host::Operation,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(ArchiveLease {
            service: self.service.clone(),
        }))
    }
    async fn execute(&self, operation: &host::Operation) -> Result<CommitPlan, HandlerError> {
        let service = self.service.clone();
        let principal = self
            .principal()
            .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        let operation = operation.clone();
        let importing = self.importing();
        let recovery = json!({"kind":"plugin_archive","source_operation_id":operation.operation_id,"automatic_reexecution":false});
        let result =
            tokio::task::spawn_blocking(move || -> Result<PluginArchiveReceipt, OperationError> {
                let mut repo = service.repository.lock().unwrap();
                let id = OperationId::new(operation.operation_id.as_str()).map_err(invalid)?;
                if importing {
                    let args: PluginArchiveArguments = decode(&operation.normalized_arguments)?;
                    repo.import_archive_operation(
                        &service.project,
                        &principal,
                        &id,
                        &args.reference,
                    )
                    .map_err(fault)
                } else {
                    repo.export_archive_operation(
                        &service.project,
                        &principal,
                        &id,
                        &decode(&operation.normalized_arguments)?,
                        now()?,
                    )
                    .map_err(fault)
                }
            })
            .await
            .map_err(|e| {
                HandlerError::after_possible_effect(e.to_string(), Some(recovery.clone()))
            })?;
        result
            .map(|receipt| CommitPlan::succeeded(json!(receipt)))
            .map_err(|e| {
                if matches!(
                    &e,
                    OperationError::InvalidInput(_) | OperationError::NotFound(_)
                ) {
                    HandlerError::before_effect(e.to_string())
                } else {
                    HandlerError::after_possible_effect(e.to_string(), Some(recovery))
                }
            })
    }
}
struct ArchiveLease {
    service: Arc<PluginService>,
}
#[async_trait]
impl ExecutionLease for ArchiveLease {
    async fn completed(&mut self, result: &Result<host::OperationRecord, OperationError>) {
        if let Ok(record) = result
            && let Err(error) = self.service.complete_archive(record)
        {
            eprintln!("original archive retains its capture: {error}");
        }
    }
}
impl PluginService {
    pub(crate) fn complete_archive(
        &self,
        record: &host::OperationRecord,
    ) -> Result<(), OperationError> {
        if record.operation.capability.version != 1
            || record.operation.domain != "plugins"
            || record.operation.idempotency_scope.as_deref() != Some(self.scope.as_str())
            || !matches!(
                record.operation.capability.id.as_str(),
                "plugins.archive_import" | "plugins.archive_export"
            )
        {
            return Err(OperationError::NotFound(
                record.operation.operation_id.to_string(),
            ));
        }
        if !matches!(
            record.status,
            host::OperationStatus::Succeeded
                | host::OperationStatus::Failed
                | host::OperationStatus::Cancelled
        ) {
            return Err(OperationError::Unavailable(
                "original archive settlement is unresolved; retain transfer and source protections"
                    .into(),
            ));
        }
        let mut repo = self.repository.lock().unwrap();
        repo.release_archive(
            &self.project,
            &plugin_principal_id(record.operation.principal()),
            &OperationId::new(record.operation.operation_id.as_str()).map_err(invalid)?,
            now()?,
        )
        .map_err(fault)?;
        if record.operation.capability.id == "plugins.archive_export" {
            let args: ExportPluginArchive = decode(&record.operation.normalized_arguments)?;
            repo.release_reference(
                "archive_export",
                record.operation.operation_id.as_str(),
                &args.revision,
            )
            .map_err(fault)?;
        } else if let Some(receipt) = repo
            .archive_operation_receipt(
                &self.project,
                &plugin_principal_id(record.operation.principal()),
                &OperationId::new(record.operation.operation_id.as_str()).map_err(invalid)?,
            )
            .map_err(fault)?
        {
            repo.release_reference(
                "archive_import",
                record.operation.operation_id.as_str(),
                &receipt.revision,
            )
            .map_err(fault)?;
        }
        Ok(())
    }
}
