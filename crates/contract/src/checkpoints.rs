//! Durable object protection belongs to a logical Workspace, not a native process.
use crate::OperationId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointCaptureArguments {
    pub expected_session: String,
    #[serde(default)] pub include_names: Option<Vec<String>>,
    #[serde(default)] pub exclude_names: Vec<String>,
    #[serde(default)] pub include_patterns: Vec<String>,
    #[serde(default)] pub exclude_patterns: Vec<String>,
    #[serde(default)] pub automatic: bool,
    #[serde(default = "capture_bytes")] pub max_bytes: u64,
    #[serde(default = "capture_seconds")] pub max_seconds: u32,
}
fn capture_bytes() -> u64 { 2 * 1024 * 1024 * 1024 }
fn capture_seconds() -> u32 { 2 }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRestoreArguments {
    pub expected_session: String,
    #[serde(default)] pub source_workspace_instance_id: Option<String>,
    #[serde(default)] pub source_continuation_lineage_id: Option<String>,
    pub checkpoint_id: OperationId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointControlArguments {
    pub checkpoint_id: OperationId,
    #[serde(default)] pub pinned: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointListArguments {
    #[serde(default)] pub before: Option<String>,
    #[serde(default = "list_limit")] pub limit: u32,
}
fn list_limit() -> u32 { 20 }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointCoverage { CompleteEligibleGraph, Partial }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointSkippedBinding { pub name: String, pub reason: String }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointNativeReport {
    pub saved_names: Vec<String>,
    pub skipped: Vec<CheckpointSkippedBinding>,
    pub r_version: String,
    pub platform: String,
    pub library_paths: Vec<String>,
    pub package_inventory_digest: String,
    pub coverage: CheckpointCoverage,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointManifest {
    pub checkpoint_id: OperationId,
    pub workspace_instance_id: String,
    pub native_session_id: String,
    pub continuation_lineage_id: String,
    pub environment_fingerprint: Option<String>,
    pub activity_boundary: u64,
    pub created_at_ms: i64,
    pub sha256: String,
    pub byte_size: u64,
    pub report: CheckpointNativeReport,
    pub automatic: bool,
    /// Byte integrity is verified; functional equivalence of arbitrary objects is not asserted.
    pub validation: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointEntry {
    pub manifest: CheckpointManifest,
    pub pinned: bool,
    pub available: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointList {
    pub entries: Vec<CheckpointEntry>,
    pub next: Option<String>,
    pub native_capture_available: bool,
    pub notice: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRestoreReport {
    pub checkpoint_id: OperationId,
    pub native_session_id: String,
    pub restored_names: Vec<String>,
    pub skipped: Vec<CheckpointSkippedBinding>,
    pub validation: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointControlReport {
    pub checkpoint_id: OperationId,
    pub pinned: bool,
    pub deleted: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRecovery {
    pub operation_id: OperationId,
    pub native_session_id: String,
    pub action: String,
    pub automatic_reexecution: bool,
}
