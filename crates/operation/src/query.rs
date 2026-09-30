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
    async fn query_for(
        &self,
        _context: &CallContext,
        arguments: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        self.query(arguments).await
    }
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
        let registry = self.registry.snapshot();
        request.validate()?;
        let handler = registry.query_handler(&request.capability)?;
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
        registry
            .schemas
            .get(&request.capability)
            .expect("registered schema")
            .input(&request.arguments)?;
        let capability = request.capability.clone();
        let arguments = handler.normalize_arguments(&request.arguments)?;
        registry
            .schemas
            .get(&capability)
            .expect("registered schema")
            .input(&arguments)?;
        QueryRequest {
            arguments: arguments.clone(),
            ..request
        }
        .validate()?;
        let mut snapshot = handler.query_for(context, &arguments).await?;
        registry.prepare_query_result(context, &capability, &mut snapshot)?;
        snapshot.target.validate()?;
        if serde_json::to_vec(&snapshot).map_or(true, |bytes| bytes.len() > 1024 * 1024) {
            return Err(OperationError::InvalidInput(
                "query result exceeds the 1 MiB response bound".into(),
            ));
        }
        Ok(snapshot)
    }
}
