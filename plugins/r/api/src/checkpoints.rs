use crate::OperationId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointCaptureArguments {
    pub expected_session: String,
    #[serde(default)]
    pub include_names: Option<Vec<String>>,
    #[serde(default)]
    pub exclude_names: Vec<String>,
    #[serde(default)]
    pub include_patterns: Vec<String>,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default = "capture_bytes")]
    pub max_bytes: u64,
    #[serde(default = "capture_seconds")]
    pub max_seconds: f64,
}
fn capture_bytes() -> u64 {
    2 * 1024 * 1024 * 1024
}
fn capture_seconds() -> f64 {
    2.0
}
impl CheckpointCaptureArguments {
    /// Validate byte/time and selection bounds before native capture.
    pub fn validate(&self) -> Result<(), String> {
        if self.expected_session.is_empty()
            || self.expected_session.len() > 160
            || self.expected_session.contains('\0')
            || !(1024..=16 * 1024 * 1024 * 1024).contains(&self.max_bytes)
            || !self.max_seconds.is_finite()
            || self.max_seconds <= 0.0
            || self.max_seconds > 300.0
        {
            return Err("Checkpoint capture requires an exact session, 1 KiB–16 GiB and a positive time bound of at most 300 seconds".into());
        }
        for names in [
            self.include_names.as_deref().unwrap_or(&[]),
            self.exclude_names.as_slice(),
        ] {
            if names.len() > 10000
                || names
                    .iter()
                    .any(|name| name.is_empty() || name.len() > 4096 || name.contains('\0'))
            {
                return Err("Checkpoint names exceed their byte or count bounds".into());
            }
        }
        for patterns in [&self.include_patterns, &self.exclude_patterns] {
            if patterns.len() > 32
                || patterns.iter().any(|pattern| {
                    pattern.is_empty() || pattern.len() > 1024 || pattern.contains('\0')
                })
            {
                return Err("Checkpoint patterns exceed their byte or count bounds".into());
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRestoreArguments {
    pub expected_session: String,
    #[serde(default)]
    pub source_workspace_instance_id: Option<String>,
    #[serde(default)]
    pub source_continuation_lineage_id: Option<String>,
    pub checkpoint_id: OperationId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointControlArguments {
    pub checkpoint_id: OperationId,
    #[serde(default)]
    pub pinned: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointListArguments {
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default = "list_limit")]
    pub limit: u32,
}
fn list_limit() -> u32 {
    20
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointCoverage {
    CompleteEligibleGraph,
    Partial,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointSkippedBinding {
    pub name: String,
    pub reason: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointSafeOptions {
    pub digits: Option<i32>,
    pub width: Option<i32>,
    pub scipen: Option<i32>,
    pub out_dec: Option<String>,
    pub warn: Option<i32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointNativeReport {
    pub saved_names: Vec<String>,
    pub skipped: Vec<CheckpointSkippedBinding>,
    pub r_version: String,
    pub platform: String,
    pub library_paths: Vec<String>,
    pub package_inventory_digest: String,
    pub working_directory: Option<String>,
    pub safe_options: CheckpointSafeOptions,
    pub context_notices: Vec<String>,
    pub required_core_namespaces: Vec<String>,
    pub required_class_namespaces: Vec<String>,
    pub coverage: CheckpointCoverage,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointManifest {
    pub source_operation_id: Option<OperationId>,
    pub runtime_binding: Option<crate::RuntimeLaunchBinding>,
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
pub struct CheckpointNativeRestoreReport {
    pub restored_names: Vec<String>,
    pub initialized_namespaces: Vec<String>,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointRestoreReport {
    pub initialized_namespaces: Vec<String>,
    pub notices: Vec<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointReconcileArguments {
    pub source_operation_id: OperationId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)] // Preserve the public serialized report DTO's Rust shape.
pub enum CheckpointReconcileReport {
    Adopted(CheckpointManifest),
    Incomplete {
        source_operation_id: OperationId,
        reason: String,
    },
}
