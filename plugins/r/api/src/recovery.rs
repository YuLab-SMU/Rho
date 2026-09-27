//! Ordinary R recovery contracts. A reference is an identity, not authority;
//! the provider must qualify its original core Operation before native access.
use crate::{CheckpointCoverage, CheckpointNativeReport, RSessionEnvironment};
use rho_plugin_protocol::{ContentDigest, InstanceRef, OperationId, ProjectId, ResourceReference};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointReference {
    pub project: ProjectId,
    pub provider: InstanceRef,
    pub operation_id: OperationId,
    pub digest: ContentDigest,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointLibraries {
    pub library_paths: Vec<String>,
    pub namespace_paths: Vec<String>,
    /// False retains unknown dependencies; an empty list cannot imply absence.
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointManifest {
    pub reference: RCheckpointReference,
    pub native_session_id: String,
    pub report: CheckpointNativeReport,
    pub environment: Option<RSessionEnvironment>,
    pub libraries: RCheckpointLibraries,
    pub source: Option<RCheckpointReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointResult {
    pub reference: RCheckpointReference,
    pub manifest: ResourceReference,
    pub native_session_id: String,
    pub saved_count: u32,
    pub skipped_count: u32,
    pub coverage: CheckpointCoverage,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointArguments {
    pub reference: RCheckpointReference,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointRead {
    pub reference: RCheckpointReference,
    pub offset: u64,
    #[schemars(range(min = 1, max = 65536))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointChunk {
    pub reference: RCheckpointReference,
    pub offset: u64,
    pub base64: String,
    pub next: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RestoreRCheckpoint {
    pub expected_session: String,
    pub reference: RCheckpointReference,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointRestored {
    pub operation_id: OperationId,
    pub session_id: String,
    pub reference: RCheckpointReference,
    pub report: ResourceReference,
    pub restored_count: u32,
    pub initialized_namespace_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileRCheckpoint {
    pub source_operation_id: OperationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PinRCheckpoint {
    pub reference: RCheckpointReference,
    pub expected_control: Option<OperationId>,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DeleteRCheckpoint {
    pub reference: RCheckpointReference,
    pub expected_control: Option<OperationId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PurgeRCheckpoint {
    pub reference: RCheckpointReference,
    pub deletion_operation_id: OperationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointPurged {
    pub operation_id: OperationId,
    pub reference: RCheckpointReference,
    #[schemars(extend("const" = true))]
    #[ts(type = "true")]
    pub payload_removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointControlResult {
    pub operation_id: OperationId,
    pub reference: RCheckpointReference,
    pub pinned: bool,
    /// Logical retirement is committed by the core. This does not claim that
    /// the post-commit disk cleanup has completed; observe the original copy.
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RCheckpointPayloadState {
    /// Length and native identity are present. This is not a fresh digest check.
    Present,
    Missing,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointObservation {
    pub checkpoint: RCheckpointResult,
    pub control_head: Option<OperationId>,
    pub pinned: bool,
    pub deleted: bool,
    pub payload: RCheckpointPayloadState,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointList {
    pub before_cursor: Option<u64>,
    #[serde(default = "page_limit")]
    #[schemars(range(min = 1, max = 32))]
    pub limit: u32,
}
fn page_limit() -> u32 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RCheckpointPage {
    /// Successful original capture/reconciliation results in this bounded journal
    /// page. Inspect each exact reference for current pin/deletion/native state.
    pub checkpoints: Vec<RCheckpointResult>,
    pub next_cursor: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum RCheckpointCaptureOutput {
    Captured(RCheckpointResult),
    NotStarted(crate::RExecutionNotStarted),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum RCheckpointRestoreOutput {
    Restored(RCheckpointRestored),
    NotStarted(crate::RExecutionNotStarted),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum RCheckpointControlOutput {
    Controlled(RCheckpointControlResult),
    NotStarted(crate::RExecutionNotStarted),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum RCheckpointPurgeOutput {
    Purged(RCheckpointPurged),
    NotStarted(crate::RExecutionNotStarted),
}

impl RCheckpointReference {
    pub fn validate(&self) -> Result<(), String> {
        if self.bytes == 0 || self.bytes > 16 * 1024 * 1024 * 1024 {
            return Err("Recovery reference exceeds the native payload bounds".into());
        }
        Ok(())
    }
}
