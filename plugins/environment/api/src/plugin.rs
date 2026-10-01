//! Bounded ordinary-plugin results. Full native reports travel as resources.
use crate::EnvironmentObservation;
use rho_plugin_protocol::{
    ContentDigest, InstanceRef, OperationId, ProviderBinding, ResourceReference,
};
use rho_process_api::ProcessActivity;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentConfiguration {
    /// An explicit installed executable; activation never discovers or installs R.
    pub rscript: Option<String>,
    /// Reopen an existing material directory after its previous owner has exited.
    /// None uses this instance's Host-provided data directory.
    pub storage_root: Option<String>,
    /// Exact read-only R provider for retained checkpoints. None prefers the original
    /// active provider, then a unique active reader; ambiguity retains material.
    pub checkpoint_reader: Option<InstanceRef>,
    #[serde(default = "default_timeout")]
    #[schemars(range(min = 1, max = 86400))]
    pub timeout_seconds: u64,
}
fn default_timeout() -> u64 {
    300
}
impl Default for EnvironmentConfiguration {
    fn default() -> Self {
        Self {
            rscript: None,
            storage_root: None,
            checkpoint_reader: None,
            timeout_seconds: default_timeout(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentStatus {
    pub project_root: String,
    pub storage_root: String,
    pub rscript: Option<String>,
    pub target_key: Option<String>,
    pub activities: Vec<ProcessActivity>,
    pub capacity: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentSnapshotStatus {
    Ready,
    Busy,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentSnapshot {
    pub status: EnvironmentSnapshotStatus,
    pub observation: Option<EnvironmentObservation>,
    pub notices: Vec<String>,
}

/// Current read-only selection of an original, verified realization. This is not
/// a namespace probe or an authorization to change an existing R session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentLibrary {
    pub binding: ProviderBinding,
    pub realization: OperationId,
    pub source: ProviderBinding,
    pub report: ResourceReference,
    pub project_root: String,
    pub storage_root: String,
    pub rscript: String,
    pub library_path: String,
    pub library_digest: ContentDigest,
    pub r_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentReportKind {
    Plan,
    Realization,
    Verification,
    Reconciliation,
    Configuration,
    Material,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentResult {
    pub operation: OperationId,
    pub kind: EnvironmentReportKind,
    pub report: ResourceReference,
    /// None for planning/configuration; false never means successful verification.
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentRecovery {
    pub operation: OperationId,
    pub storage_root: String,
    pub native_recovery: Option<ResourceReference>,
    pub report_digest: Option<ContentDigest>,
    pub automatic_reexecution: bool,
    pub action: String,
}
