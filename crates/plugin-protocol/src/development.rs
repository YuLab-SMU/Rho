//! Source editing is independent of build artifacts, activation and scientific work.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

pub const MAX_SOURCE_CHUNK_BYTES: u32 = 65_536;
pub const MAX_SOURCE_EDIT_BYTES: usize = 128 * 1024;
pub const MAX_SOURCE_CHECKPOINT_BYTES: usize = 256 * 1024;
pub const MAX_SOURCE_EDITS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListPluginSource {
    pub revision: RevisionId,
    pub after: Option<PackagePath>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginSourcePage {
    pub revision: RevisionId,
    pub files: BTreeMap<PackagePath, PackageFile>,
    pub total: u64,
    pub next: Option<PackagePath>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadPluginSource {
    pub revision: RevisionId,
    pub path: PackagePath,
    pub offset: u64,
    #[schemars(range(min = 1, max = 65536))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginSourceChunk {
    pub revision: RevisionId,
    pub path: PackagePath,
    pub file: PackageFile,
    pub offset: u64,
    /// Binary-safe bytes. The owner verifies the full stored file digest before returning.
    pub content_base64: String,
    pub next_offset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListPluginBranches {
    pub plugin: PluginId,
    pub after: Option<BranchId>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginBranch {
    pub id: BranchId,
    pub plugin: PluginId,
    pub name: String,
    pub head: RevisionId,
    /// The recorded branch point. Absent when no origin was recorded; never inferred.
    pub origin: Option<RevisionId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginBranchPage {
    pub branches: Vec<PluginBranch>,
    pub next: Option<BranchId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginSourceEdit {
    Put {
        content_base64: String,
        executable: bool,
    },
    Remove,
    /// Copy exact retained source bytes, including large/binary files, without rebuilding.
    Copy {
        revision: RevisionId,
        path: PackagePath,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CheckpointPlugin {
    pub branch: BranchId,
    pub expected_head: RevisionId,
    /// At most 128 edits and 128 KiB of decoded inline content per checkpoint.
    /// Manifest file declarations must describe the complete resulting source tree.
    pub changes: BTreeMap<PackagePath, PluginSourceEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginCheckpoint {
    pub branch: BranchId,
    pub revision: RevisionId,
    pub parent: RevisionId,
}
