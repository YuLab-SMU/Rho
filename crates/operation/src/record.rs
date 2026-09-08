use crate::{Clock, OperationError, OperationJournal, QueryHandler, SystemClock};
use async_trait::async_trait;
use rho_contract::*;
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

pub(crate) async fn visible_record(
    journal: &dyn OperationJournal,
    context: &CallContext,
    id: &OperationId,
    project: Option<&str>,
) -> Result<Option<OperationRecord>, OperationError> {
    context.validate()?;
    Ok(journal.get(id).await?.filter(|record| {
        record.operation.principal() == context.principal()
            && project
                .is_none_or(|scope| record.operation.idempotency_scope.as_deref() == Some(scope))
    }))
}

pub struct OperationGetHandler {
    journal: Arc<dyn OperationJournal>,
    project: Option<String>,
    known: BTreeSet<CapabilityRef>,
    descriptor: CapabilityDescriptor,
}
impl OperationGetHandler {
    pub fn new(
        journal: Arc<dyn OperationJournal>,
        project: Option<String>,
        descriptors: &[CapabilityDescriptor],
    ) -> Result<Self, OperationError> {
        let documentation = CapabilityDocumentation {
            summary: "Read one authoritative operation".into(),
            purpose: "Read an original operation by its exact identity with project/principal visibility, terminal or in-progress status, retained recovery and its recorded capability contract.".into(),
            when_to_use: vec!["Verify accepted execution, cancellation, a lost acknowledgement or an uncertain result without repeating the command.".into()],
            limitations: vec!["Historical output is preserved with its recorded capability identity even when that owner is unavailable in this Host. Querying never starts a runtime or performs recovery.".into(), "An accepted request or cancellation request is not proof of scientific completion or rollback.".into()],
            owner: "operation".into(), effects: "Read-only journal observation; no admission, execution or recovery mutation.".into(),
            retry_rule: "Read the same OperationId. Do not replay a command to discover its outcome.".into(), cancellation_rule: "Stopping this read does not stop scientific work.".into(),
            preconditions: vec![], examples: vec![CapabilityExample { arguments: json!({"operation_id":"operation-example"}), result_explanation: "record is null for an unavailable or invisible operation. Otherwise status and recovery describe the original action; output_contract binds polymorphic data to its exact recorded capability.".into() }],
            related_capabilities: vec![], related_skills: vec![], position_units: vec!["All returned byte budgets use UTF-8 bytes, not tokens.".into()],
        };
        let descriptor = CapabilityDescriptor {
            kind: CapabilityKind::Query,
            capability: CapabilityRef::new("operation.get", 1)?,
            domain: "operation".into(),
            input_schema: schema_for!(OperationGetArguments).to_value(),
            output_schema: operation_get_result_schema(descriptors),
            recovery_schema: json!({"type":"null"}),
            documentation,
            required_scopes: BTreeSet::from(["operation.read".into()]),
            potential_effects: BTreeSet::new(),
            idempotency: IdempotencyClass::Pure,
            retry: RetryClass::Safe,
            cancellation: CancellationClass::Unsupported,
        };
        Ok(Self {
            journal,
            project,
            known: descriptors
                .iter()
                .filter(|d| d.kind == CapabilityKind::Operation)
                .map(|d| d.capability.clone())
                .collect(),
            descriptor,
        })
    }
}
#[async_trait]
impl QueryHandler for OperationGetHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: OperationGetArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        OperationId::new(args.operation_id.as_str())?;
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
        let args: OperationGetArguments = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        let record = visible_record(
            self.journal.as_ref(),
            context,
            &args.operation_id,
            self.project.as_deref(),
        )
        .await?;
        let output_contract = record.as_ref().map(|r| RecordedOperationContract {
            capability: r.operation.capability.clone(),
            availability: if self.known.contains(&r.operation.capability) {
                RecordedContractAvailability::Registered
            } else {
                RecordedContractAvailability::OwnerUnavailableInThisHost
            },
            describe: None,
        });
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: if self.project.is_some() {
                    "project"
                } else {
                    "operation"
                }
                .into(),
                identity: self
                    .project
                    .clone()
                    .unwrap_or_else(|| args.operation_id.as_str().into()),
            },
            source: "operation-journal".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Complete,
            data: Some(
                serde_json::to_value(OperationGetResult {
                    record,
                    output_contract,
                })
                .map_err(|e| OperationError::Contract(e.to_string()))?,
            ),
            notices: vec![],
            next_reads: vec![],
            diagnostics: vec![],
        })
    }
}
