use crate::{Clock, OperationError, OperationJournal, QueryHandler, SystemClock};
use async_trait::async_trait;
use rho_contract::*;
use schemars::schema_for;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};

pub fn evidence_sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub struct OperationEvidenceHandler {
    journal: Arc<dyn OperationJournal>,
    project: Option<String>,
    descriptor: CapabilityDescriptor,
}
impl OperationEvidenceHandler {
    pub fn new(journal: Arc<dyn OperationJournal>, project: Option<String>) -> Self {
        let documentation = CapabilityDocumentation {
            summary: "Read retained uncommitted owner evidence".into(),
            purpose: "Read an exact, digest-bound byte page of original owner output/recovery/material that could not be accepted as a valid scientific result.".into(),
            when_to_use: vec!["An original operation's contract-failure recovery contains a candidate evidence reference.".into()],
            limitations: vec!["Evidence is unvalidated data, not committed domain facts, tool declarations or authority to replay work. Reassemble all bytes and verify the full digest before parsing the JSON candidate.".into()],
            owner: "operation".into(), effects: "Read-only access to existing operation-journal evidence; no runtime start, operation admission or recovery execution.".into(),
            retry_rule: "Repeat an identified byte read. Preserve OperationId, digest and size across pages; never replay the original scientific command.".into(), cancellation_rule: "Stopping this read does not cancel scientific work.".into(),
            preconditions: vec![CapabilityPrecondition { parameter: "reference".into(), requirement: "Use the exact candidate evidence reference in the original operation's recovery.".into(), read_from: Some(CapabilityRef::new("operation.get",1).unwrap()) }],
            examples: vec![CapabilityExample { arguments: json!({"reference":{"operation_id":"operation-example","kind":"uncommitted_owner_result","sha256":format!("sha256:{}","0".repeat(64)),"byte_size":4096},"offset":0,"limit_bytes":4096}), result_explanation: "bytes is one exact page. Continue with next_offset; the whole reconstructed UTF-8 JSON document must match reference.sha256.".into() }],
            related_capabilities: vec![], related_skills: vec![], position_units: vec!["Offsets, page limits and sizes are UTF-8 JSON bytes, starting at zero; a page may split a UTF-8 code point.".into()],
        };
        Self {
            journal,
            project,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new("operation.read_evidence", 1).unwrap(),
                domain: "operation".into(),
                input_schema: schema_for!(OperationReadEvidenceArguments).to_value(),
                output_schema: schema_for!(OperationEvidencePage).to_value(),
                recovery_schema: json!({"type":"null"}),
                documentation,
                required_scopes: BTreeSet::from(["operation.read".into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl QueryHandler for OperationEvidenceHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: OperationReadEvidenceArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        OperationId::new(args.reference.operation_id.as_str())?;
        if !(1..=OPERATION_EVIDENCE_CHUNK_BYTES as u32).contains(&args.limit_bytes)
            || args.offset > args.reference.byte_size
            || args.reference.sha256.len() != 71
            || !args.reference.sha256.starts_with("sha256:")
            || !args.reference.sha256[7..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(OperationError::InvalidInput(
                "invalid evidence identity or byte-page bounds".into(),
            ));
        }
        serde_json::to_value(args).map_err(|e| OperationError::InvalidInput(e.to_string()))
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "caller context is required".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let args: OperationReadEvidenceArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        let record = self
            .journal
            .get(&args.reference.operation_id)
            .await?
            .filter(|r| {
                r.operation.principal() == context.principal()
                    && self
                        .project
                        .as_ref()
                        .is_none_or(|p| r.operation.idempotency_scope.as_ref() == Some(p))
            })
            .ok_or_else(|| OperationError::NotFound(args.reference.operation_id.as_str().into()))?;
        let fault: ContractFailureRecovery =
            serde_json::from_value(record.recovery.unwrap_or_default()).map_err(|_| {
                OperationError::NotFound(
                    "the original operation has no contract-failure evidence reference".into(),
                )
            })?;
        if !matches!(fault.candidate, UncommittedCandidate::Evidence { reference } if reference == args.reference)
        {
            return Err(OperationError::ContentChanged(
                "evidence reference does not match this original operation".into(),
            ));
        }
        let page = self.journal.read_evidence(&args).await?;
        let mut next_reads = vec![];
        if let Some(offset) = page.next_offset {
            next_reads.push(NextRead::query(
                "operation.read_evidence",
                "Continue the original uncommitted evidence bytes",
                json!({"reference":page.reference,"offset":offset,"limit_bytes":args.limit_bytes}),
            ));
        }
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "operation".into(),
                identity: args.reference.operation_id.as_str().into(),
            },
            source: "operation-journal/evidence".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: if page.next_offset.is_some() {
                ObservationCompleteness::Partial
            } else {
                ObservationCompleteness::Complete
            },
            data: Some(
                serde_json::to_value(page).map_err(|e| OperationError::Contract(e.to_string()))?,
            ),
            notices: vec![],
            next_reads,
            diagnostics: vec![],
        })
    }
}
