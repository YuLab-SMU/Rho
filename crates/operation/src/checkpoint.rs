use crate::{Clock, OperationError, OperationJournal, QueryHandler, SystemClock};
use async_trait::async_trait;
use rho_contract::*;
use schemars::schema_for;
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

pub struct OperationEventsCheckpointHandler {
    journal: Arc<dyn OperationJournal>,
    project: String,
    descriptor: CapabilityDescriptor,
}

impl OperationEventsCheckpointHandler {
    pub fn new(journal: Arc<dyn OperationJournal>, project: String) -> Self {
        Self {
            journal,
            project,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new("operation.events_checkpoint", 1).unwrap(),
                domain: "operation".into(),
                input_schema: schema_for!(OperationEventsCheckpointArguments).to_value(),
                output_schema: schema_for!(OperationEventsCheckpoint).to_value(),
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
impl QueryHandler for OperationEventsCheckpointHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: OperationEventsCheckpointArguments = serde_json::from_value(value.clone())
            .map_err(|error| OperationError::InvalidInput(error.to_string()))?;
        serde_json::to_value(args).map_err(|error| OperationError::InvalidInput(error.to_string()))
    }

    async fn query(&self, _value: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "caller context is required".into(),
        ))
    }

    async fn query_for(
        &self,
        context: &CallContext,
        _value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let checkpoint = self
            .journal
            .events_checkpoint(&self.project, context.principal())
            .await?;
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "project".into(),
                identity: self.project.clone(),
            },
            source: "operation-journal".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: ObservationCompleteness::Complete,
            data: Some(
                serde_json::to_value(checkpoint)
                    .map_err(|error| OperationError::Storage(error.to_string()))?,
            ),
            notices: Vec::new(),
        })
    }
}
