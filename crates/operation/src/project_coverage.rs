use crate::{Clock, OperationError, OperationJournal, QueryHandler, SystemClock};
use async_trait::async_trait;
use rho_contract::*;
use schemars::schema_for;
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

/// Metadata only. The scientific owner interprets the separately scoped records.
pub struct OperationProjectCoverageHandler {
    journal: Arc<dyn OperationJournal>,
    project: String,
    descriptor: CapabilityDescriptor,
}
impl OperationProjectCoverageHandler {
    pub fn new(journal: Arc<dyn OperationJournal>, project: String) -> Self {
        Self {
            journal,
            project,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new("operation.project_coverage", 1).unwrap(),
                documentation: builtin_documentation("operation.project_coverage"),
                recovery_schema: serde_json::json!({"type":"null"}),
                domain: "operation".into(),
                input_schema: schema_for!(ProjectReadCoverageArguments).to_value(),
                output_schema: schema_for!(ProjectReadCoverage).to_value(),
                required_scopes: BTreeSet::from([
                    "operation.read".into(),
                    "project.references.read".into(),
                ]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl QueryHandler for OperationProjectCoverageHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: ProjectReadCoverageArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid("Authenticated caller context is required"))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        _: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let coverage = self
            .journal
            .project_read_coverage(&self.project, context.principal())
            .await?;
        Ok(QuerySnapshot {
            next_reads: vec![], diagnostics: vec![],
            target: TargetRef { kind: "project".into(), identity: self.project.clone() },
            source: "operation-journal".into(), observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready, completeness: ObservationCompleteness::Complete,
            data: Some(serde_json::to_value(coverage).map_err(invalid)?),
            notices: vec!["Coverage describes current visibility only. It does not freeze records, establish a native reference inventory or authorize material cleanup.".into()],
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
