//! In-process ports for a containing Agent backend, independent of its storage.
use async_trait::async_trait;
use rho_agent_api::*;
use rho_agent_owner::ComponentModelKey;
use serde_json::Value;
use std::{any::Any, sync::Arc};
use tokio_util::sync::CancellationToken;

/// A transient, owner-created handle. It cannot be serialized or reconstructed
/// from model arguments. The originating port still checks its durable intent.
#[derive(Clone)]
pub struct AgentToolTicket(Arc<dyn Any + Send + Sync>);
impl AgentToolTicket {
    pub fn new<T: Any + Send + Sync>(value: T) -> Self {
        Self(Arc::new(value))
    }
    pub fn get<T: Any + Send + Sync>(&self) -> Option<&T> {
        self.0.downcast_ref()
    }
}
pub enum AgentToolAdmission {
    Ready(AgentToolTicket),
    Rejected { feedback: Option<Value> },
}

/// Verified bytes and their owner-provided citation, not a live media handle.
pub struct AgentModelImage {
    pub label: String,
    pub mime_type: String,
    pub base64: String,
}
pub struct AgentModelExecution {
    pub run: AgentModelRun,
    pub context: String,
    pub images: Vec<AgentModelImage>,
    pub tools: Vec<ComponentToolSpec>,
    pub key: ComponentModelKey,
    pub port: Arc<dyn AgentModelPort>,
    pub cancellation: CancellationToken,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentModelOutcome {
    Completed,
    Stopped,
    Failed(String),
}

/// Admission, dispatch and interruption remain with one task owner. Admission and
/// execution errors must record any owner diagnostic before returning the error.
/// Returned messages are safe owner-authored diagnostics, never raw provider data.
#[async_trait]
pub trait AgentModelPort: Send + Sync {
    async fn begin_model_call(&self) -> Result<u32, String>;
    async fn prepare_tool(
        &self,
        model_call: u32,
        call_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<AgentToolAdmission, String>;
    async fn execute_tool(&self, ticket: AgentToolTicket) -> Result<Value, String>;
    async fn append_text(&self, text: String) -> Result<(), String>;
    async fn record_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Result<(), String>;
    /// The original receipt must remain available after an interrupted wait.
    async fn interrupted_tool(&self, ticket: &AgentToolTicket) -> Result<(), String>;
}
