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
