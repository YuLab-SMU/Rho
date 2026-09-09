use crate::{CapabilityRegistry, OperationError};
use rho_contract::*;
use serde_json::{Value, json};

impl CapabilityRegistry {
    /// Navigation is response metadata. A navigation defect cannot change the
    /// execution result, release an accepted action, or pause a native queue.
    pub(crate) fn public_record(
        &self,
        context: &CallContext,
        mut record: OperationRecord,
    ) -> OperationRecord {
        if let Err(error) = self.decorate_record(context, &mut record) {
            record.next_reads = Some(vec![]);
            record.diagnostics = Some(vec![error.diagnostic()]);
        }
        record
    }
    pub(crate) fn read_link(
        &self,
        context: &CallContext,
        id: &str,
        purpose: &str,
        arguments: Value,
    ) -> Result<Option<NextRead>, OperationError> {
        let capability = CapabilityRef::new(id, 1)?;
        let Some(descriptor) = self.descriptors.get(&capability) else {
            return Ok(None);
        };
        if descriptor.kind != CapabilityKind::Query
            || !descriptor.required_scopes.is_subset(&context.scopes)
        {
            return Ok(None);
        }
        let read = NextRead {
            purpose: purpose.into(),
            capability,
            arguments,
            missing_identity_fields: vec![],
        };
        self.schemas
            .get(&read.capability)
            .expect("registered schema")
            .read(&read)?;
        Ok(Some(read))
    }
    pub(crate) fn decorate_record(
        &self,
        context: &CallContext,
        record: &mut OperationRecord,
    ) -> Result<(), OperationError> {
        let mut reads = vec![];
        let id = &record.operation.operation_id;
        if let Some(read) = self.read_link(
            context,
            "operation.get",
            "Read the authoritative original operation and its recovery evidence",
            json!({"operation_id":id}),
        )? {
            reads.push(read);
        }
        if let Some(fault) = record
            .recovery
            .as_ref()
            .and_then(|value| serde_json::from_value::<ContractFailureRecovery>(value.clone()).ok())
            && let UncommittedCandidate::Evidence { reference } = fault.candidate
            && reference.operation_id == *id
            && let Some(read) = self.read_link(
                context,
                "operation.read_evidence",
                "Read the exact uncommitted owner candidate retained by this original operation",
                json!({"reference":reference,"offset":0,"limit_bytes":65536}),
            )?
        {
            reads.push(read);
        }
        let uncertain = record.status == OperationStatus::Uncertain;
        if record.operation.domain == "workspace" {
            if !record.status.is_terminal() || record.status == OperationStatus::Failed {
                if let Some(read) = self.read_link(
                    context, "workspace.console_state",
                    "Check whether this run is executing, queued, paused after an error, or waiting for input; acceptance alone does not mean execution started",
                    json!({}),
                )? { reads.push(read); }
            }
            for (capability, purpose) in [
                (
                    "workspace.output_events",
                    "Read original execution output observations",
                ),
                (
                    "workspace.list_outputs",
                    "Read the original operation's retained artifact references",
                ),
            ] {
                if let Some(read) = self.read_link(
                    context,
                    capability,
                    purpose,
                    json!({"operation_id":id,"after_sequence":0,"limit":100}),
                )? {
                    reads.push(read);
                }
            }
        }
        if !uncertain {
            if record.operation.capability.id == "slurm.submit"
                && let Some(read) = self.read_link(
                    context,
                    "slurm.snapshot",
                    "Observe the native job linked to this original submission",
                    json!({"submission_operation_id":id}),
                )?
            {
                reads.push(read);
            }
            if matches!(
                record.operation.capability.id.as_str(),
                "environment.plan" | "environment.realize"
            ) && record.status.is_terminal()
                && let Some(read) = self.read_link(
                    context,
                    "environment.retention",
                    "Inspect the retained environment material and its native identities",
                    json!({"operation_id":id}),
                )?
            {
                reads.push(read);
            }
            if record.status == OperationStatus::Succeeded {
                match record.operation.capability.id.as_str() {
                    "workspace.run_r" | "workspace.help" | "workspace.lint"
                    | "workspace.format" => {
                        if let Some(output) = record.output.as_ref().and_then(|value| {
                            serde_json::from_value::<RunROutput>(value.clone()).ok()
                        }) {
                            for reference in output
                                .output_references
                                .iter()
                                .filter(|r| &r.operation_id == id)
                                .take(4)
                            {
                                let (capability, purpose, arguments) = if reference
                                    .mime_type
                                    .starts_with("image/")
                                {
                                    (
                                        "output.view",
                                        "Inspect this retained original image",
                                        json!({"reference":reference}),
                                    )
                                } else if reference.mime_type == "text/plain" {
                                    (
                                        "output.read_text",
                                        "Read this retained text artifact without rendering or executing it again",
                                        json!({"reference":reference,"offset":0,"limit_bytes":65536}),
                                    )
                                } else {
                                    continue;
                                };
                                if let Some(read) =
                                    self.read_link(context, capability, purpose, arguments)?
                                {
                                    reads.push(read);
                                }
                            }
                        }
                    }
                    "project.apply_patch" => {
                        if let Some(result) = record.output.as_ref().and_then(|value| {
                            serde_json::from_value::<ProjectPatchResult>(value.clone()).ok()
                        }) {
                            for file in result
                                .after
                                .files
                                .iter()
                                .filter(|f| f.sha256.is_some())
                                .take(4)
                            {
                                if let Some(read) = self.read_link(context, "project.read_text", "Verify the resulting file at its recorded content version", json!({"path":file.path,"expected_sha256":file.sha256,"start_line":1,"limit_lines":200}))? { reads.push(read); }
                            }
                        }
                    }
                    _ => (),
                }
            }
        }
        let mut diagnostics = vec![];
        let (code, continuation, message) = match record.status {
            OperationStatus::Accepted => (DiagnosticCode::Busy, DiagnosticContinuation::ReadAgain, "The request is accepted, not necessarily running. For R work, inspect workspace.console_state for a queued run, pause or input request; waiting alone does not clear a queue pause. Do not resubmit.".into()),
            OperationStatus::Running => (DiagnosticCode::Busy, DiagnosticContinuation::ReadAgain, "Recorded lifecycle status is running; no terminal result has been committed.".into()),
            OperationStatus::Reconciling => (DiagnosticCode::Busy, DiagnosticContinuation::ReadAgain, "The owner is checking native evidence for this operation.".into()),
            OperationStatus::Failed => (DiagnosticCode::ExecutionFailed, DiagnosticContinuation::InspectOriginal, record.error.clone().unwrap_or_else(|| "The owner reported execution failure; inspect original evidence before deciding on another action.".into())),
            OperationStatus::Cancelled => (DiagnosticCode::Cancelled, DiagnosticContinuation::InspectOriginal, "The owner confirmed cancellation. Cancellation does not establish rollback of earlier effects.".into()),
            OperationStatus::Uncertain => (DiagnosticCode::OutcomeUncertain, DiagnosticContinuation::InspectOriginal, "The original outcome is uncertain. Read its record and retained evidence; do not replay the command.".into()),
            OperationStatus::Succeeded => (DiagnosticCode::Unavailable, DiagnosticContinuation::None, String::new()),
        };
        if record.status != OperationStatus::Succeeded {
            diagnostics.push(Diagnostic {
                code,
                continuation,
                message,
                next_reads: reads.clone(),
            });
        }
        if record.cancellation_requested && !record.status.is_terminal() {
            diagnostics.push(Diagnostic { code: DiagnosticCode::Busy, continuation: DiagnosticContinuation::ReadAgain,
                message: "Cancellation was requested; the owner has not confirmed that execution stopped.".into(), next_reads: reads.clone() });
        }
        if record
            .recovery
            .as_ref()
            .and_then(|r| r.get("kind"))
            .and_then(Value::as_str)
            == Some("owner_contract_violation")
        {
            diagnostics.push(Diagnostic { code: DiagnosticCode::ContractViolation, continuation: DiagnosticContinuation::InspectOriginal,
                message: "The owner returned a result outside its registered contract. The uncommitted candidate is retained as recovery evidence; its domain facts and events were not committed.".into(), next_reads: reads.clone() });
        }
        self.validate_reads(&reads)?;
        record.next_reads = Some(reads);
        record.diagnostics = Some(diagnostics);
        Ok(())
    }
}
