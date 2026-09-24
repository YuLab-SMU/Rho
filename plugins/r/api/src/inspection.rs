//! Read-only R inspection envelopes and contributed capability identities.
use crate::{NativeCompleteness, WorkspaceQueryKind};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum RInspectionStatus {
    Ready,
    Busy,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RInspectionDiagnostic {
    pub code: String,
    pub message: String,
}

/// A successful RPC can report a busy or unavailable native observation. No
/// cached value is presented as current, and continuation errors keep their code.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RInspection<T> {
    pub session_id: String,
    pub status: RInspectionStatus,
    pub source: String,
    pub observed_at_ms: i64,
    pub completeness: NativeCompleteness,
    pub data: Option<T>,
    pub notices: Vec<String>,
    pub diagnostic: Option<RInspectionDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RInspectionStateArguments {
    /// Null observes an unstarted instance; a supplied session must match exactly.
    pub expected_session: Option<String>,
}

/// A cheap observation of this R owner's inspection readiness. The cache key is
/// scoped to the exact instance and session. It invalidates presentation caches,
/// never serves as a scientific precondition or establishes an Operation outcome.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RInspectionState {
    pub session_id: Option<String>,
    pub status: RInspectionStatus,
    /// Changes before and after native execution, even if polling misses the run.
    /// Read-only inspections do not change it. None means no session exists.
    pub cache_key: Option<String>,
    pub observed_at_ms: i64,
    pub notices: Vec<String>,
}

pub fn r_inspection_kind(capability: &str) -> Option<WorkspaceQueryKind> {
    Some(match capability {
        "r.list_objects" => WorkspaceQueryKind::ListObjects,
        "r.observe_object" => WorkspaceQueryKind::ObserveObject,
        "r.read_object" => WorkspaceQueryKind::ReadObject,
        "r.inspect_object" => WorkspaceQueryKind::InspectObject,
        "r.packages" => WorkspaceQueryKind::Packages,
        "r.package_index" => WorkspaceQueryKind::PackageIndex,
        "r.read_help" => WorkspaceQueryKind::ReadHelp,
        _ => return None,
    })
}
