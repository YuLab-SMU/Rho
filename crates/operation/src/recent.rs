use crate::{Clock, OperationError, OperationJournal, QueryHandler, SystemClock};
use async_trait::async_trait;
use rho_contract::*;
use schemars::schema_for;
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

pub struct RecentOperationsHandler {
    journal: Arc<dyn OperationJournal>,
    project: String,
    descriptor: CapabilityDescriptor,
}
impl RecentOperationsHandler {
    pub fn new(journal: Arc<dyn OperationJournal>, project: String) -> Self {
        Self {
            journal,
            project,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
                domain: "operation".into(),
                input_schema: schema_for!(RecentOperationsArguments).to_value(),
                output_schema: schema_for!(RecentOperations).to_value(),
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
impl QueryHandler for RecentOperationsHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: RecentOperationsArguments =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        validate_recent_arguments(&args)?;
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, _value: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid("caller context is required"))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let args = serde_json::from_value(value.clone()).map_err(invalid)?;
        let page = self
            .journal
            .list_recent(&self.project, context.principal(), &args)
            .await?;
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "project".into(),
                identity: self.project.clone(),
            },
            source: "operation-journal".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Partial,
            data: Some(serde_json::to_value(page).map_err(invalid)?),
            notices: Vec::new(),
        })
    }
}

pub fn validate_recent_arguments(args: &RecentOperationsArguments) -> Result<(), OperationError> {
    if !(1..=100).contains(&args.limit)
        || args.before_cursor.is_some_and(|c| c > i64::MAX as u64)
        || args
            .client_request_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > MAX_IDENTIFIER_BYTES)
    {
        return Err(invalid("invalid operation page bounds"));
    }
    if [
        args.before_cursor.is_some(),
        args.client_request_id.is_some(),
        args.operation_id.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count()
        > 1
    {
        return Err(invalid(
            "before_cursor, client_request_id and operation_id are mutually exclusive",
        ));
    }
    if let Some(id) = &args.operation_id {
        OperationId::new(id.as_str())?;
    }
    Ok(())
}

fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
