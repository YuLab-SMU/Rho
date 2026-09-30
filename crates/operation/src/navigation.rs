use crate::{RegistrySnapshot, OperationError};
use rho_contract::*;
use serde_json::{Value, json};

impl RegistrySnapshot {
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
        let mut diagnostics = vec![];
        let (code, continuation, message) = match record.status {
            OperationStatus::Accepted => (DiagnosticCode::Busy, DiagnosticContinuation::ReadAgain, "The request is accepted, not necessarily running. Inspect the original record and the selected provider’s advertised state query. Do not resubmit.".into()),
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
