//! One registered gateway path, dispatching to the real owner of an explicit R instance.
use crate::instances::{InstanceLive, InstanceOwner, RequestHold};
use async_trait::async_trait;
use rho_contract::*;
use rho_operation::*;
use serde_json::{Value, json};
use std::sync::Arc;

const INSTANCE: &str = "workspace_instance_id";
fn needs_instance(id: &str) -> bool {
    id.starts_with("workspace.")
        && !matches!(
            id,
            "workspace.list_outputs" | "workspace.read_output" | "workspace.output_events"
        )
}

fn split(arguments: &Value) -> Result<(String, Value), OperationError> {
    let mut arguments = arguments.as_object().cloned().ok_or_else(|| {
        OperationError::InvalidInput("Workspace arguments must be an object".into())
    })?;
    let id = arguments
        .remove(INSTANCE)
        .and_then(|id| id.as_str().map(str::to_owned))
        .ok_or_else(|| {
            OperationError::InvalidInput(
                "workspace_instance_id is required; read runtime.instances".into(),
            )
        })?;
    crate::instances::validate_id(&id)?;
    Ok((id, Value::Object(arguments)))
}

fn routed(mut arguments: Value, id: &str) -> Result<Value, OperationError> {
    arguments
        .as_object_mut()
        .ok_or_else(|| {
            OperationError::Contract("Workspace owner normalized non-object arguments".into())
        })?
        .insert(INSTANCE.into(), Value::String(id.into()));
    Ok(arguments)
}

fn descriptor(mut value: CapabilityDescriptor) -> CapabilityDescriptor {
    value.input_schema["properties"][INSTANCE] =
        json!({"type":"string","minLength":1,"maxLength":160});
    let required = value
        .input_schema
        .as_object_mut()
        .unwrap()
        .entry("required")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    required.push(json!(INSTANCE));
    for example in &mut value.documentation.examples {
        example.arguments[INSTANCE] = json!(MAIN_WORKSPACE_INSTANCE);
    }
    value.documentation.preconditions.insert(0, CapabilityPrecondition {
        parameter: INSTANCE.into(),
        requirement: "Capture the logical R instance when submitting; selection changes never retarget accepted work. Native session preconditions remain required where specified.".into(),
        read_from: Some(CapabilityRef::new("runtime.instances", 1).unwrap()),
    });
    value
}

pub(crate) fn register(
    registry: &mut CapabilityRegistry,
    owner: Arc<InstanceOwner>,
    prototype: &CapabilityRegistry,
) -> Result<(), OperationError> {
    for base in prototype.descriptors() {
        match base.kind {
            CapabilityKind::Operation => registry.register(Arc::new(RoutedOperation {
                descriptor: descriptor(base.clone()),
                prototype: prototype.handler(&base.capability)?,
                owner: owner.clone(),
            }))?,
            CapabilityKind::Query => registry.register_query(Arc::new(RoutedQuery {
                descriptor: descriptor(base.clone()),
                prototype: prototype.query_handler(&base.capability)?,
                owner: owner.clone(),
            }))?,
            CapabilityKind::Control => {
                return Err(OperationError::Contract(
                    "Instance prototype contains a transport control".into(),
                ));
            }
        }
    }
    Ok(())
}

struct RoutedOperation {
    descriptor: CapabilityDescriptor,
    prototype: Arc<dyn OperationHandler>,
    owner: Arc<InstanceOwner>,
}

fn native_operation(operation: &Operation) -> Result<Operation, HandlerError> {
    let (_, arguments) = split(&operation.normalized_arguments)
        .map_err(|error| HandlerError::before_effect(error.to_string()))?;
    Ok(Operation {
        normalized_arguments: arguments,
        ..operation.clone()
    })
}

impl RoutedOperation {
    fn admitted_owner(&self, operation: &Operation) -> Result<Arc<InstanceLive>, HandlerError> {
        self.owner
            .operation_live(&operation.operation_id)
            .ok_or_else(|| {
                HandlerError::before_effect(
                    "The original R instance admission is no longer available",
                )
            })
    }
    fn handler(&self, live: &InstanceLive) -> Result<Arc<dyn OperationHandler>, HandlerError> {
        live.registry
            .handler(&self.descriptor.capability)
            .map_err(|error| HandlerError::before_effect(error.to_string()))
    }
}

#[async_trait]
impl OperationHandler for RoutedOperation {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.project().into())
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        let (id, arguments) = split(arguments)?;
        routed(self.prototype.normalize_arguments(&arguments)?, &id)
    }
    fn resolve_target(&self, arguments: &Value) -> Result<TargetRef, OperationError> {
        let (id, arguments) = split(arguments)?;
        // This observation is rechecked atomically at admission before native work is enqueued.
        let live = self
            .owner
            .resolve_live(&id, &self.descriptor.capability.id)?;
        live.registry
            .handler(&self.descriptor.capability)?
            .resolve_target(&arguments)
    }
    fn admitted(&self, operation: &Operation) -> Result<(), HandlerError> {
        let (id, _) = split(&operation.normalized_arguments)
            .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        let live = self.owner.admit_operation(&id, operation)?;
        let result = self.handler(&live)?.admitted(&native_operation(operation)?);
        if result.is_err() {
            self.owner.release_operation(&operation.operation_id, false);
        }
        result
    }
    fn cancel_pending(&self, operation: &Operation) -> bool {
        self.admitted_owner(operation)
            .ok()
            .and_then(|live| self.handler(&live).ok())
            .zip(native_operation(operation).ok())
            .is_some_and(|(handler, native)| handler.cancel_pending(&native))
    }
    async fn acquire_execution(
        &self,
        operation: &Operation,
        cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        let live = self.admitted_owner(operation)?;
        let result = self
            .handler(&live)?
            .acquire_execution(&native_operation(operation)?, cancellation)
            .await;
        match result {
            Ok(inner) => Ok(Box::new(RoutedLease {
                inner,
                hold: self.owner.operation_hold(operation.operation_id.clone()),
                potentially_mutating: operation
                    .potential_effects
                    .contains(&EffectHint::MayMutateRuntime)
                    && !operation.capability.id.starts_with("workspace.checkpoint_"),
            })),
            Err(error) => {
                self.owner.release_operation(&operation.operation_id, false);
                Err(error)
            }
        }
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        self.execute_controlled(operation, tokio::sync::watch::channel(false).1)
            .await
    }
    async fn execute_controlled(
        &self,
        operation: &Operation,
        cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        let live = self.admitted_owner(operation)?;
        let mut plan = self
            .handler(&live)?
            .execute_controlled(&native_operation(operation)?, cancellation)
            .await?;
        let (id, _) = split(&operation.normalized_arguments)
            .map_err(|error| HandlerError::before_effect(error.to_string()))?;
        for event in &mut plan.events {
            if let Some(payload) = event.payload.as_object_mut() {
                payload.insert(INSTANCE.into(), json!(id));
            }
        }
        Ok(plan)
    }
}

struct RoutedLease {
    inner: Box<dyn ExecutionLease>,
    hold: RequestHold,
    potentially_mutating: bool,
}
#[async_trait::async_trait]
impl ExecutionLease for RoutedLease {
    async fn completed(&mut self, result: &Result<OperationRecord, OperationError>) {
        self.hold.mark_activity = self.potentially_mutating;
        // Activity is visible before the real owner's lane/queue permits a subsequent capture.
        self.hold.release_result(result);
        self.inner.completed(result).await;
    }
}
impl Drop for RoutedLease {
    fn drop(&mut self) {
        self.hold.release();
    }
}

struct RoutedQuery {
    descriptor: CapabilityDescriptor,
    prototype: Arc<dyn QueryHandler>,
    owner: Arc<InstanceOwner>,
}
#[async_trait]
impl QueryHandler for RoutedQuery {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        let (id, arguments) = split(arguments)?;
        routed(self.prototype.normalize_arguments(&arguments)?, &id)
    }
    async fn query(&self, _arguments: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "Caller context is required for an instance observation".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        arguments: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let (id, arguments) = split(arguments)?;
        let (live, _hold) = self
            .owner
            .admit_query(&id, &self.descriptor.capability.id)?;
        if self.descriptor.capability.id != "workspace.checkpoints"
            && live.runtime.runtime_status().state == "unavailable"
        {
            return Ok(QuerySnapshot {
                next_reads: Vec::new(),
                diagnostics: Vec::new(),
                target: TargetRef {
                    kind: "workspace".into(),
                    identity: live.runtime.session_id().into(),
                },
                source: "host/instance".into(),
                observed_at_ms: SystemClock.now_ms()?,
                status: QueryStatus::Unavailable,
                completeness: ObservationCompleteness::Unknown,
                data: None,
                notices: vec![
                    "The R session is unavailable after a transport loss; inspect recovery before retrying reads.".into(),
                ],
            });
        }
        let mut snapshot = live
            .registry
            .query_handler(&self.descriptor.capability)?
            .query_for(context, &arguments)
            .await?;
        if self.descriptor.capability.id == "workspace.checkpoints"
            && let Some(data) = &mut snapshot.data
        {
            let available = self.owner.capture_available(&id);
            data["native_capture_available"] = json!(available);
            if available {
                data["notice"] = Value::Null;
            }
        }
        // A continuation must not depend on whichever instance the window selects later.
        for next in &mut snapshot.next_reads {
            if needs_instance(&next.capability.id) {
                next.arguments[INSTANCE] = json!(id);
            }
        }
        for diagnostic in &mut snapshot.diagnostics {
            for next in &mut diagnostic.next_reads {
                if needs_instance(&next.capability.id) {
                    next.arguments[INSTANCE] = json!(id);
                }
            }
        }
        Ok(snapshot)
    }
}
