use crate::{CapabilityRegistry, OperationError};
use async_trait::async_trait;
use rho_contract::{CallContext, CapabilityDescriptor, QueryRequest, QuerySnapshot};
use serde_json::Value;
use std::sync::Arc;

#[async_trait]
pub trait QueryHandler: Send + Sync {
    fn descriptor(&self) -> &CapabilityDescriptor;
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError>;
    async fn query(&self, arguments: &Value) -> Result<QuerySnapshot, OperationError>;
}

/// No journal/ID generator: reading cannot accidentally create an Operation.
pub struct QueryGateway {
    registry: Arc<CapabilityRegistry>,
}
impl QueryGateway {
    pub fn new(registry: Arc<CapabilityRegistry>) -> Self {
        Self { registry }
    }
    pub async fn query(
        &self,
        context: &CallContext,
        request: QueryRequest,
    ) -> Result<QuerySnapshot, OperationError> {
        context.validate()?;
        request.validate()?;
        let handler = self.registry.query_handler(&request.capability)?;
        let missing = handler
            .descriptor()
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: request.capability.display_key(),
                missing,
            });
        }
        let arguments = handler.normalize_arguments(&request.arguments)?;
        QueryRequest {
            arguments: arguments.clone(),
            ..request
        }
        .validate()?;
        let snapshot = handler.query(&arguments).await?;
        snapshot.target.validate()?;
        if serde_json::to_vec(&snapshot).map_or(true, |bytes| bytes.len() > 1024 * 1024) {
            return Err(OperationError::InvalidInput(
                "query result exceeds the 1 MiB response bound".into(),
            ));
        }
        Ok(snapshot)
    }
}
