//! Durable object protection belongs to a logical Workspace, not a native process.
pub use rho_r_api::checkpoints::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointEntry {
    pub saved_count: u32,
    pub skipped_count: u32,
    /// Catalog copies may shorten manifest arrays; the immutable operation retains all metadata.
    pub details_complete: bool,
    pub detail_read: crate::NextRead,
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
