use crate::{CapabilityRegistry, OperationError};
use async_trait::async_trait;
use rho_contract::{CallContext, CapabilityDescriptor, ControlRequest};
use serde_json::Value;

/// Controls act on an already-owned native/application request. They have no
/// journal access; receipt/idempotency and native preconditions belong to owners.
#[async_trait]
pub trait ControlHandler: Send + Sync {
    fn descriptor(&self) -> &CapabilityDescriptor;
    async fn control(
        &self,
        context: &CallContext,
        arguments: Value,
    ) -> Result<Value, OperationError>;
}

impl CapabilityRegistry {
    pub async fn control(
        &self,
        context: &CallContext,
        request: ControlRequest,
    ) -> Result<Value, OperationError> {
        // Hold one immutable registration and its schemas across dispatch.
        let snapshot = self.snapshot();
        snapshot
            .validate_control_input(context, &request.capability, &request.arguments)
            .map_err(|error| match error {
                OperationError::InvalidInput(_) => OperationError::InvalidInput(
                    "Control arguments violate their contract (redacted)".into(),
                ),
                other => other,
            })?;
        if serde_json::to_vec(&request.arguments).map_or(true, |bytes| bytes.len() > 256 * 1024) {
            return Err(OperationError::InvalidInput(
                "Control arguments exceed the byte limit (redacted)".into(),
            ));
        }
        let handler = snapshot.control_handler(&request.capability)?;
        let output = handler.control(context, request.arguments).await?;
        if serde_json::to_vec(&output).map_or(true, |bytes| bytes.len() > 256 * 1024) {
            return Err(OperationError::Contract(
                "Control reply exceeds the byte limit (redacted)".into(),
            ));
        }
        snapshot
            .validate_control_output(&request.capability, &output)
            .map_err(|_| {
                OperationError::Contract("Control reply violates its contract (redacted)".into())
            })?;
        Ok(output)
    }
}
