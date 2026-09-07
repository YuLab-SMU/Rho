use super::{WORKSPACE_READ_SCOPE, WorkspaceRunHandler};
use async_trait::async_trait;
use rho_contract::*;
use rho_operation::{Clock, OperationError, OperationRecords, QueryHandler, SystemClock};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

#[derive(Clone, Copy)]
pub enum OutputQueryKind {
    Events,
    Read,
    Status,
}
pub struct WorkspaceOutputHandler {
    owner: Arc<WorkspaceRunHandler>,
    records: Arc<dyn OperationRecords>,
    kind: OutputQueryKind,
    descriptor: CapabilityDescriptor,
}
impl WorkspaceOutputHandler {
    pub fn new(
        owner: Arc<WorkspaceRunHandler>,
        records: Arc<dyn OperationRecords>,
        kind: OutputQueryKind,
    ) -> Self {
        let (id, schema) = match kind {
            OutputQueryKind::Events => (
                "workspace.output_events",
                schema_for!(OutputEventsArguments).to_value(),
            ),
            OutputQueryKind::Read => (
                "workspace.read_output",
                schema_for!(ReadOutputArguments).to_value(),
            ),
            OutputQueryKind::Status => (
                "workspace.runtime_status",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
        };
        Self {
            owner,
            records,
            kind,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new(id, 1).unwrap(),
                domain: "workspace".into(),
                input_schema: schema,
                output_schema: schema_for!(QuerySnapshot).to_value(),
                required_scopes: BTreeSet::from([WORKSPACE_READ_SCOPE.into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
    async fn visible(&self, context: &CallContext, id: &OperationId) -> Result<(), OperationError> {
        let record = self
            .records
            .get(id.as_str())
            .await
            .map_err(invalid)?
            .ok_or_else(|| invalid("output operation is not visible"))?;
        if record.operation.principal() != context.principal()
            || record.operation.idempotency_scope.as_deref() != self.owner.runtime.project_root()
            || record.operation.domain != "workspace"
        {
            return Err(invalid("output belongs to another project or principal"));
        }
        Ok(())
    }
}
#[async_trait]
impl QueryHandler for WorkspaceOutputHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        match self.kind {
            OutputQueryKind::Events => {
                let args: OutputEventsArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                OperationId::new(args.operation_id.as_str())?;
                if !(1..=100).contains(&args.limit) {
                    return Err(invalid("output event limit must be 1..=100"));
                }
                serde_json::to_value(args).map_err(invalid)
            }
            OutputQueryKind::Read => {
                let args: ReadOutputArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                OperationId::new(args.reference.operation_id.as_str())?;
                if !(1..=65536).contains(&args.limit_bytes)
                    || args.reference.sequence == 0
                    || args.offset > args.reference.byte_size
                {
                    return Err(invalid("invalid media read bounds"));
                }
                serde_json::to_value(args).map_err(invalid)
            }
            OutputQueryKind::Status => {
                if value != &json!({}) {
                    return Err(invalid("runtime status accepts no arguments"));
                }
                Ok(value.clone())
            }
        }
    }
    async fn query(&self, _value: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid("caller context is required"))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let result = match self.kind {
            OutputQueryKind::Events => {
                let args: OutputEventsArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                self.visible(context, &args.operation_id).await?;
                self.owner
                    .runtime
                    .output_events(&args)
                    .await
                    .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
            }
            OutputQueryKind::Read => {
                let args: ReadOutputArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                self.visible(context, &args.reference.operation_id).await?;
                self.owner
                    .runtime
                    .read_output(&args)
                    .await
                    .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
            }
            OutputQueryKind::Status => {
                let mut status = self.owner.runtime.runtime_status();
                if self.owner.lane.try_lock().is_err() && status.state == "idle" {
                    status.state = "busy".into();
                }
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
        };
        let (status, data, notices) = match result {
            Ok(data) => (QueryStatus::Ready, Some(data), Vec::new()),
            Err(error) => (QueryStatus::Unavailable, None, vec![error]),
        };
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "workspace".into(),
                identity: self.owner.runtime.session_id().into(),
            },
            source: "ark/runtime-observation".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status,
            completeness: ObservationCompleteness::Partial,
            data,
            notices,
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
