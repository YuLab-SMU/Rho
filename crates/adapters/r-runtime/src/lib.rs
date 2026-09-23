//! Transitional adapter for the existing Host composition. Scientific execution
//! is implemented solely in the independent R package's engine.
#![forbid(unsafe_code)]
use async_trait::async_trait;
use rho_contract::*;
use rho_r_api::NativeRuntime;
pub use rho_r_engine::{ArkConfig, recorded_process_alive, verify_checkpoint_helper};
use rho_workspace::*;
use std::{path::Path, sync::Arc};
pub struct Runtime<T>(T);
pub type ArkRuntime = Runtime<rho_r_engine::ArkRuntime>;
pub type CheckpointArchiveRuntime = Runtime<rho_r_engine::CheckpointArchiveRuntime>;
impl ArkRuntime {
    pub async fn launch(config: ArkConfig) -> Result<Self, String> {
        Ok(Self(rho_r_engine::ArkRuntime::launch(config).await?))
    }
}
impl CheckpointArchiveRuntime {
    pub fn open(project: &Path, data_root: &Path) -> Result<Self, String> {
        Ok(Self(rho_r_engine::CheckpointArchiveRuntime::open(
            project, data_root,
        )?))
    }
}
impl<T> std::ops::Deref for Runtime<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
fn completeness(value: rho_r_api::NativeCompleteness) -> ObservationCompleteness {
    match value {
        rho_r_api::NativeCompleteness::Complete => ObservationCompleteness::Complete,
        rho_r_api::NativeCompleteness::Partial => ObservationCompleteness::Partial,
        rho_r_api::NativeCompleteness::Unknown => ObservationCompleteness::Unknown,
    }
}
fn report(value: rho_r_api::NativeReport) -> WorkspaceRuntimeReport {
    WorkspaceRuntimeReport {
        session_id: value.session_id,
        value: value.value,
        stdout: value.stdout,
        stderr: value.stderr,
        conditions: value.conditions,
        output_references: value.output_references,
        error: value.error,
        outcome: match value.outcome {
            rho_plugin_protocol::PluginOutcome::Succeeded => OperationOutcome::Succeeded,
            rho_plugin_protocol::PluginOutcome::Failed => OperationOutcome::Failed,
            rho_plugin_protocol::PluginOutcome::Uncertain => OperationOutcome::Uncertain,
            rho_plugin_protocol::PluginOutcome::Cancelled => OperationOutcome::Cancelled,
        },
        effect_observations: value
            .effect_observations
            .into_iter()
            .map(|v| EffectObservation {
                kind: v.kind,
                source: v.source,
                detail: v.detail,
                observed_at_ms: v.observed_at_ms,
                completeness: completeness(v.completeness),
            })
            .collect(),
    }
}
#[async_trait]
impl<T: NativeRuntime> WorkspaceRuntime for Runtime<T> {
    fn checkpoint_available(&self) -> bool {
        self.0.checkpoint_available()
    }
    fn checkpoint_archive_only(&self) -> bool {
        self.0.checkpoint_archive_only()
    }
    fn process_identity(&self) -> Option<rho_contract::RuntimeProcessIdentity> {
        self.0.process_identity()
    }
    fn installation_identity(&self) -> Option<rho_contract::RuntimeInstallationIdentity> {
        self.0.installation_identity()
    }
    async fn native_process_alive(&self) -> Result<Option<bool>, WorkspaceRuntimeError> {
        self.0.native_process_alive().await
    }
    async fn shutdown(&self) -> Result<(), WorkspaceRuntimeError> {
        self.0.shutdown().await
    }
    async fn checkpoint_capture(
        &self,
        _operation: &Operation,
        _args: &rho_contract::CheckpointCaptureArguments,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CheckpointArtifact, WorkspaceRuntimeError> {
        self.0
            .checkpoint_capture(&_operation.operation_id, _args, _cancellation)
            .await
    }
    async fn checkpoint_artifact_lease(
        &self,
        _id: &rho_contract::OperationId,
    ) -> Result<Box<dyn CheckpointArtifactLease>, WorkspaceRuntimeError> {
        self.0.checkpoint_artifact_lease(_id).await
    }
    async fn checkpoint_original_manifest(
        &self,
        _id: &rho_contract::OperationId,
    ) -> Result<Option<rho_contract::CheckpointManifest>, WorkspaceRuntimeError> {
        self.0.checkpoint_original_manifest(_id).await
    }
    async fn checkpoint_adopt(
        &self,
        _source: &rho_contract::CheckpointManifest,
        _adopted: &rho_contract::CheckpointManifest,
    ) -> Result<(), WorkspaceRuntimeError> {
        self.0.checkpoint_adopt(_source, _adopted).await
    }
    async fn checkpoint_publish(
        &self,
        _manifest: &rho_contract::CheckpointManifest,
    ) -> Result<(), WorkspaceRuntimeError> {
        self.0.checkpoint_publish(_manifest).await
    }
    async fn checkpoint_candidates(
        &self,
    ) -> Result<Vec<rho_contract::CheckpointManifest>, WorkspaceRuntimeError> {
        self.0.checkpoint_candidates().await
    }
    async fn checkpoint_control_evidence(
        &self,
        _checkpoint: &rho_contract::OperationId,
    ) -> Result<Vec<CheckpointControlEvidence>, WorkspaceRuntimeError> {
        self.0.checkpoint_control_evidence(_checkpoint).await
    }
    async fn checkpoint_write_control(
        &self,
        _evidence: &CheckpointControlEvidence,
    ) -> Result<(), WorkspaceRuntimeError> {
        self.0.checkpoint_write_control(_evidence).await
    }
    fn checkpoint_remove_payload(
        &self,
        _checkpoint: &rho_contract::OperationId,
    ) -> Result<(), String> {
        self.0.checkpoint_remove_payload(_checkpoint)
    }
    async fn checkpoint_present(
        &self,
        _manifest: &rho_contract::CheckpointManifest,
    ) -> Result<bool, WorkspaceRuntimeError> {
        self.0.checkpoint_present(_manifest).await
    }
    async fn checkpoint_verify(
        &self,
        _manifest: &rho_contract::CheckpointManifest,
    ) -> Result<bool, WorkspaceRuntimeError> {
        self.0.checkpoint_verify(_manifest).await
    }
    async fn checkpoint_restore(
        &self,
        _operation: &Operation,
        _manifest: &rho_contract::CheckpointManifest,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<rho_contract::CheckpointNativeRestoreReport, WorkspaceRuntimeError> {
        self.0
            .checkpoint_restore(&_operation.operation_id, _manifest, _cancellation)
            .await
    }
    fn begin_shutdown(&self) {
        self.0.begin_shutdown()
    }
    fn input_request(&self) -> Option<rho_contract::InputRequest> {
        self.0.input_request()
    }
    fn respond_input(&self, _reply: rho_contract::RespondInput) -> Result<(), String> {
        self.0.respond_input(_reply)
    }
    async fn check_code(&self, _code: &str) -> Result<rho_contract::CodeCompleteness, String> {
        self.0.check_code(_code).await
    }
    async fn output_events(
        &self,
        _args: &rho_contract::OutputEventsArguments,
    ) -> Result<rho_contract::OutputEvents, String> {
        self.0.output_events(_args).await
    }
    async fn read_output(
        &self,
        _args: &rho_contract::ReadOutputArguments,
    ) -> Result<rho_contract::OutputPage, String> {
        self.0.read_output(_args).await
    }
    fn execution_state(&self) -> String {
        self.0.execution_state()
    }
    fn runtime_status(&self) -> rho_contract::RuntimeStatus {
        self.0.runtime_status()
    }
    fn session_id(&self) -> &str {
        self.0.session_id()
    }
    fn project_root(&self) -> Option<&str> {
        self.0.project_root()
    }
    async fn query(
        &self,
        _query: &WorkspaceQuery,
    ) -> Result<WorkspaceObservation, WorkspaceRuntimeError> {
        self.0.query(_query).await.map(|v| WorkspaceObservation {
            session_id: v.session_id,
            source: v.source,
            observed_at_ms: v.observed_at_ms,
            data: v.data,
            completeness: completeness(v.completeness),
            notices: v.notices,
        })
    }
    async fn execute(
        &self,
        operation: &Operation,
        request: &RunRArguments,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.0
            .execute(&operation.operation_id, request)
            .await
            .map(report)
    }
    async fn execute_controlled(
        &self,
        operation: &Operation,
        request: &RunRArguments,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.0
            .execute_controlled(&operation.operation_id, request, _cancellation)
            .await
            .map(report)
    }
    async fn execute_tool_controlled(
        &self,
        _operation: &Operation,
        _request: &WorkspaceToolRequest,
        _cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<WorkspaceRuntimeReport, WorkspaceRuntimeError> {
        self.0
            .execute_tool_controlled(&_operation.operation_id, _request, _cancellation)
            .await
            .map(report)
    }
}
pub struct OutputStore(rho_r_engine::OutputStore);
impl OutputStore {
    pub fn open(root: &Path, project: &str) -> Result<Self, String> {
        rho_r_engine::OutputStore::open(root, project).map(Self)
    }
    pub fn open_read_only(root: &Path, project: &str) -> Result<Option<Self>, String> {
        rho_r_engine::OutputStore::open_read_only(root, project).map(|value| value.map(Self))
    }
}
impl std::ops::Deref for OutputStore {
    type Target = rho_r_engine::OutputStore;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
#[async_trait]
impl WorkspaceOutputs for OutputStore {
    async fn verified_original(&self, reference: &MediaReference) -> Result<Arc<[u8]>, String> {
        self.0.verified_original(reference)
    }
    async fn output_events(&self, args: &OutputEventsArguments) -> Result<OutputEvents, String> {
        rho_r_api::NativeOutputs::output_events(&self.0, args).await
    }
    async fn read_output(&self, args: &ReadOutputArguments) -> Result<OutputPage, String> {
        rho_r_api::NativeOutputs::read_output(&self.0, args).await
    }
    async fn list_outputs(&self, args: &OutputEventsArguments) -> Result<MediaPage, String> {
        rho_r_api::NativeOutputs::list_outputs(&self.0, args).await
    }
}
