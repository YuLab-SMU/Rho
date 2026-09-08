use crate::execution::ProcessReport;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "manager", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlanArguments {
    Pak { packages: Vec<String> },
    Renv { lockfile: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RealizeArguments {
    pub plan_operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VerifyArguments {
    pub realization_operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReconcileArguments {
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ObserveArguments {
    #[serde(default)]
    pub realization_operation_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    200
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageVersion {
    pub name: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SourceDigest {
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct EnvironmentPlan {
    pub project_root: String,
    pub manager: String,
    pub lock_path: String,
    pub lock_digest: String,
    pub r_version: String,
    pub platform: String,
    pub packages: Vec<PackageVersion>,
    pub local_sources: Vec<SourceDigest>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct NamespaceProbe {
    pub name: String,
    pub version: Option<String>,
    pub library: Option<String>,
    pub loadable: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct EnvironmentRealization {
    pub project_root: String,
    pub plan_operation_id: String,
    pub manager: String,
    pub lock_digest: String,
    pub library_path: String,
    pub library_digest: String,
    pub renv_lockfile: String,
    pub r_version: String,
    pub platform: String,
    pub packages: Vec<PackageVersion>,
    pub probes: Vec<NamespaceProbe>,
    pub verified: bool,
    pub restart_required: bool,
    pub activation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct Verification {
    pub verified: bool,
    pub library_digest_matches: bool,
    pub probes: Vec<NamespaceProbe>,
    pub errors: Vec<String>,
}

/// Native configuration is established during explicit Host startup or an
/// Environment operation. Reading it never starts R or tests namespace loading.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct EnvironmentObservation {
    pub r_version: String,
    pub platform: String,
    pub r_home: String,
    pub library_paths: Vec<String>,
    pub packages: Vec<InstalledEnvironmentPackage>,
    pub truncated: bool,
    pub jsonlite_library: String,
    /// Cached startup/operation probe, not a current loadability guarantee.
    pub renv_available: bool,
    /// Cached startup/operation probe, not a current loadability guarantee.
    pub pak_available: bool,
    pub configuration_observed_at_ms: i64,
    pub configuration_source: String,
    pub inventory_observed_at_ms: i64,
    pub active_workspace_library: Option<String>,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct InstalledEnvironmentPackage {
    pub name: String,
    pub version: String,
    pub library: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentRuntimeRecovery {
    pub process: ProcessReport,
    pub process_tree_marker: String,
    pub tree_cleanup_confirmed: bool,
    pub action: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentStageRecovery {
    pub stage: String,
    pub plan_operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<EnvironmentRuntimeRecovery>,
    pub action: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum EnvironmentRealizeRecovery {
    Stage(EnvironmentStageRecovery),
    Runtime(EnvironmentRuntimeRecovery),
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentReconcileRecovery {
    pub source_operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_tree_marker: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct EnvironmentReconciliation {
    pub source_operation_id: String,
    pub project_root: String,
    pub native_marker: Option<String>,
    pub cleanup_confirmed: bool,
    pub stopped_pids: Vec<u32>,
    pub retained_stage_paths: Vec<String>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum MaterialKind {
    Plan,
    Realization,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum MaterialAction {
    Quarantine,
    Restore,
    Purge,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MaterialObject {
    pub path: String,
    pub fingerprint: String,
    pub bytes: u64,
    pub entries: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MaterialState {
    pub stage: Option<MaterialObject>,
    pub trash: Option<MaterialObject>,
    pub native_marker_present: bool,
    pub live_processes: Vec<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MaterialChange {
    pub source_operation_id: String,
    pub cleanup_operation_id: String,
    pub action: MaterialAction,
    pub stage_path: String,
    pub trash_path: String,
    pub bytes: u64,
    pub recoverable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct RetentionView {
    pub source_operation_id: String,
    pub material: MaterialState,
    pub can_quarantine: bool,
    pub can_restore: bool,
    pub can_purge: bool,
    pub retained_reasons: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentSourceArguments {
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentCleanupArguments {
    pub operation_id: String,
    pub expected_fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentTrashArguments {
    pub cleanup_operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentChangeTrashArguments {
    pub cleanup_operation_id: String,
    pub expected_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged, deny_unknown_fields)]
pub enum EnvironmentMaterialRecovery {
    Paths {
        source_operation_id: String,
        cleanup_operation_id: String,
        stage_path: String,
        trash_path: String,
        action: String,
    },
    Identity {
        cleanup_operation_id: String,
    },
}
