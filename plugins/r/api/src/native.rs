//! R owner port. It receives original operation identities, never a journal handle.
use crate::*;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeReport {
    pub session_id: String,
    pub value: Value,
    pub stdout: String,
    pub stderr: String,
    pub conditions: Vec<WorkspaceCondition>,
    pub output_references: Vec<MediaReference>,
    pub effect_observations: Vec<NativeEffect>,
    pub outcome: rho_plugin_protocol::PluginOutcome,
    pub error: Option<String>,
}
#[derive(
    Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum NativeCompleteness {
    Complete,
    Partial,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeEffect {
    pub kind: String,
    pub source: String,
    pub detail: Value,
    pub observed_at_ms: i64,
    pub completeness: NativeCompleteness,
}
pub struct NativeObservation {
    pub session_id: String,
    pub source: String,
    pub observed_at_ms: i64,
    pub data: Value,
    pub completeness: NativeCompleteness,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct NativeError {
    pub message: String,
    pub effect_may_have_occurred: bool,
    pub recovery: Option<Value>,
    pub query_code: Option<Box<str>>,
}

impl NativeError {
    pub fn query_error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            effect_may_have_occurred: false,
            recovery: None,
            query_code: Some(code.into().into_boxed_str()),
        }
    }
    pub fn before_effect(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            effect_may_have_occurred: false,
            recovery: None,
            query_code: None,
        }
    }

    pub fn after_possible_effect(message: impl Into<String>, recovery: Option<Value>) -> Self {
        Self {
            message: message.into(),
            effect_may_have_occurred: true,
            recovery,
            query_code: None,
        }
    }
}

#[async_trait]
pub trait NativeRuntime: Send + Sync {
    fn checkpoint_available(&self) -> bool {
        false
    }
    fn checkpoint_archive_only(&self) -> bool {
        false
    }
    fn process_identity(&self) -> Option<crate::RuntimeProcessIdentity> {
        None
    }
    fn installation_identity(&self) -> Option<crate::RuntimeInstallationIdentity> {
        None
    }
    async fn native_process_alive(&self) -> Result<Option<bool>, NativeError> {
        Ok(None)
    }
    async fn shutdown(&self) -> Result<(), NativeError> {
        Err(NativeError::before_effect(
            "Confirmed native shutdown unavailable",
        ))
    }
    async fn checkpoint_capture(
        &self,
        _operation: &OperationId,
        _args: &crate::CheckpointCaptureArguments,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CheckpointArtifact, NativeError> {
        Err(NativeError::before_effect(
            "Native checkpoint provider unavailable",
        ))
    }
    async fn checkpoint_artifact_lease(
        &self,
        _id: &crate::OperationId,
    ) -> Result<Box<dyn CheckpointArtifactLease>, NativeError> {
        Ok(Box::new(()))
    }
    async fn checkpoint_original_manifest(
        &self,
        _id: &crate::OperationId,
    ) -> Result<Option<crate::CheckpointManifest>, NativeError> {
        Ok(None)
    }
    async fn checkpoint_adopt(
        &self,
        _source: &crate::CheckpointManifest,
        _adopted: &crate::CheckpointManifest,
    ) -> Result<(), NativeError> {
        Err(NativeError::before_effect(
            "Checkpoint adoption unavailable",
        ))
    }
    async fn checkpoint_publish(
        &self,
        _manifest: &crate::CheckpointManifest,
    ) -> Result<(), NativeError> {
        Err(NativeError::before_effect("Checkpoint storage unavailable"))
    }
    async fn checkpoint_candidates(&self) -> Result<Vec<crate::CheckpointManifest>, NativeError> {
        Ok(Vec::new())
    }
    async fn checkpoint_control_evidence(
        &self,
        _checkpoint: &crate::OperationId,
    ) -> Result<Vec<CheckpointControlEvidence>, NativeError> {
        Ok(Vec::new())
    }
    async fn checkpoint_write_control(
        &self,
        _evidence: &CheckpointControlEvidence,
    ) -> Result<(), NativeError> {
        Err(NativeError::before_effect("Checkpoint storage unavailable"))
    }
    fn checkpoint_remove_payload(&self, _checkpoint: &crate::OperationId) -> Result<(), String> {
        Err("Checkpoint storage unavailable".into())
    }
    async fn checkpoint_present(
        &self,
        _manifest: &crate::CheckpointManifest,
    ) -> Result<bool, NativeError> {
        Ok(false)
    }
    async fn checkpoint_verify(
        &self,
        _manifest: &crate::CheckpointManifest,
    ) -> Result<bool, NativeError> {
        Ok(false)
    }
    async fn checkpoint_restore(
        &self,
        _operation: &OperationId,
        _manifest: &crate::CheckpointManifest,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<crate::CheckpointNativeRestoreReport, NativeError> {
        Err(NativeError::before_effect(
            "Native checkpoint restore unavailable",
        ))
    }

    fn begin_shutdown(&self) {}
    fn input_request(&self) -> Option<crate::InputRequest> {
        None
    }
    fn respond_input(&self, _reply: crate::RespondInput) -> Result<(), String> {
        Err("R input is unavailable".into())
    }
    async fn check_code(&self, _code: &str) -> Result<crate::CodeCompleteness, String> {
        Err("R code completeness is unavailable".into())
    }
    async fn output_events(
        &self,
        _args: &crate::OutputEventsArguments,
    ) -> Result<crate::OutputEvents, String> {
        Err("output observation log is unavailable".into())
    }
    async fn read_output(
        &self,
        _args: &crate::ReadOutputArguments,
    ) -> Result<crate::OutputPage, String> {
        Err("output content is unavailable".into())
    }
    fn execution_state(&self) -> String {
        self.runtime_status().state
    }
    fn runtime_status(&self) -> crate::RuntimeStatus {
        crate::RuntimeStatus {
            session_id: self.session_id().into(),
            state: "unavailable".into(),
            observed_at_ms: 0,
            processes: Vec::new(),
            notices: vec!["native runtime observations are unavailable".into()],
        }
    }
    fn session_id(&self) -> &str;
    fn project_root(&self) -> Option<&str> {
        None
    }

    async fn query(&self, _query: &WorkspaceQuery) -> Result<NativeObservation, NativeError> {
        Err(NativeError::before_effect(
            "this runtime does not support Workspace inspection",
        ))
    }

    async fn execute(
        &self,
        operation: &OperationId,
        request: &RunRArguments,
    ) -> Result<NativeReport, NativeError>;

    async fn execute_controlled(
        &self,
        operation: &OperationId,
        request: &RunRArguments,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<NativeReport, NativeError> {
        self.execute(operation, request).await
    }

    async fn execute_tool_controlled(
        &self,
        _operation: &OperationId,
        _request: &WorkspaceToolRequest,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<NativeReport, NativeError> {
        Err(NativeError::before_effect(
            "this runtime does not support R code tools",
        ))
    }
}

pub trait CheckpointArtifactLease: Send + Sync {}
impl<T: Send + Sync> CheckpointArtifactLease for T {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointArtifact {
    pub report: CheckpointNativeReport,
    pub sha256: String,
    pub byte_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointControlEvidence {
    pub operation_id: OperationId,
    pub report: CheckpointControlReport,
    pub at_ms: i64,
}
#[async_trait]
pub trait NativeOutputs: Send + Sync {
    async fn verified_original(&self, _reference: &MediaReference) -> Result<Arc<[u8]>, String> {
        Err("Verified original output reads are unavailable".into())
    }
    async fn output_events(&self, args: &OutputEventsArguments) -> Result<OutputEvents, String>;
    async fn read_output(&self, args: &ReadOutputArguments) -> Result<OutputPage, String>;
    async fn list_outputs(&self, args: &OutputEventsArguments) -> Result<MediaPage, String>;
}
