use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub byte_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct DirectoryPage {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
    pub next_name: Option<String>,
    pub truncated: bool,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListDirectoryArguments {
    #[serde(default)]
    pub path: String,
    pub after_name: Option<String>,
    #[serde(default = "directory_limit")]
    pub limit: u32,
}
fn directory_limit() -> u32 {
    200
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct FormatResult {
    pub tool_version: String,
    pub code: String,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct FileObservation {
    pub path: String,
    pub kind: String,
    pub sha256: Option<String>,
    pub byte_size: u64,
    pub mode: Option<u32>,
    pub modified_at_ns: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct GitStatusEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct GitObservation {
    pub repository_root: String,
    pub head: Option<String>,
    pub changes: Vec<GitStatusEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectSnapshot {
    pub root: String,
    pub git: Option<GitObservation>,
    pub files: Vec<FileObservation>,
    pub entries: Vec<String>,
    pub entries_truncated: bool,
    pub observed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct FilePage {
    pub file: FileObservation,
    pub offset: u64,
    pub bytes: Vec<u8>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectPatchResult {
    pub before: ProjectSnapshot,
    pub after: ProjectSnapshot,
    pub affected_paths: Vec<String>,
    pub changed_paths: Vec<String>,
    pub git_exit_code: Option<i32>,
    pub diagnostic: String,
    pub committed_to_git: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BindingSummary {
    pub name: String,
    pub kind: String,
    pub object_type: Option<String>,
    pub classes: Vec<String>,
    pub length: Option<u64>,
    pub dimensions: Vec<u64>,
    pub preview: Option<Value>,
    pub truncated: bool,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSnapshotData {
    pub objects: Vec<BindingSummary>,
    pub total_bindings: u64,
    pub truncated: bool,
    pub working_directory: String,
    pub r_version: String,
    pub library_paths: Vec<String>,
    pub namespace_paths: Vec<String>,
    pub library_usage_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RunROutput {
    pub session_id: String,
    pub value: Value,
    pub stdout: String,
    pub stderr: String,
    pub conditions: Vec<Value>,
    pub output_references: Vec<Value>,
}
