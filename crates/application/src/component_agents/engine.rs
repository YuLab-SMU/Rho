//! Engine-neutral execution ports. The Host implementation owns all native access.
use super::{ComponentToolAdmission, StoredComponentTool};
use crate::ApplicationError;
use async_trait::async_trait;
use rho_contract::ComponentAgentRun;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Ephemeral credential material. Deliberately neither Debug nor serializable.
pub struct ComponentModelKey(String);
impl ComponentModelKey {
    pub fn new(value: String) -> Result<Self, ApplicationError> {
        if value.is_empty() || value.len() > 16384 || !value.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(ApplicationError::InvalidInput(
                "Invalid model credential".into(),
            ));
        }
        Ok(Self(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

pub struct ComponentEngineExecution {
    pub run: ComponentAgentRun,
    pub context: String,
    pub images: Vec<ComponentImageInput>,
    pub tools: Vec<ComponentToolSpec>,
    pub key: ComponentModelKey,
    pub port: Arc<dyn ComponentRunPort>,
    pub cancellation: CancellationToken,
}
/// Verified image bytes are transient model input, never serialized in run records.
pub struct ComponentImageInput {
    pub reference: rho_contract::MediaReference,
    pub mime_type: String,
    pub base64: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentEngineOutcome {
    Completed,
    Stopped,
    Failed(String),
}

#[async_trait]
pub trait ComponentAgentEngine: Send + Sync {
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome;
}

#[async_trait]
pub trait ComponentRunPort: Send + Sync {
    async fn begin_model_call(&self) -> Result<u32, ApplicationError>;
    async fn prepare_tool(
        &self,
        model_call: u32,
        call_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<ComponentToolAdmission, ApplicationError>;
    async fn execute_tool(
        &self,
        admission: ComponentToolAdmission,
    ) -> Result<Value, ApplicationError>;
    async fn append_text(&self, text: String) -> Result<(), ApplicationError>;
    async fn record_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Result<(), ApplicationError>;
    /// The original receipt remains available if a tool future is interrupted.
    async fn interrupted_tool(&self, tool: &StoredComponentTool) -> Result<(), ApplicationError>;
}
