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
    #[serde(default)]
    pub preview_kind: Option<String>,
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
    /// Intentionally open: bounded native R scalar values or safe metadata vary by executed code.
    pub value: Value,
    pub stdout: String,
    pub stderr: String,
    pub conditions: Vec<WorkspaceCondition>,
    pub output_references: Vec<crate::MediaReference>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceCondition { pub kind: String, pub message: String }
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HelpResult {
    pub topic: String,
    pub package: String,
    pub library_path: Option<String>,
    pub found: bool,
    pub text: String,
    pub text_reference: Option<crate::MediaReference>,
    pub preview_truncated: Option<bool>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LintDiagnostic {
    pub line: u32, pub column: u32,
    #[serde(rename = "type")] pub kind: String,
    pub message: String, pub linter: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct LintResult { pub tool_version: String, pub diagnostics: Vec<LintDiagnostic>, pub truncated: bool }

/// Bounded observation of the libraries and namespaces of the existing R session.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageQueryArguments {
    #[serde(default)]
    pub expected_session: Option<String>,
    #[serde(default)]
    #[schemars(length(max = 128))]
    pub filter: String,
    #[serde(default)]
    pub mode: PackageQueryMode,
    // Group installed copies by package name. Omission retains the flat query.
    #[serde(default)]
    pub grouped: bool,
    // Continue reading one bounded observation without resampling R or disk.
    #[serde(default)]
    #[schemars(length(max = 64))]
    pub observation_id: Option<String>,
    // Read the copies of an exact package within the observation.
    #[serde(default)]
    #[schemars(length(min = 1, max = 128))]
    pub package_name: Option<String>,
    #[serde(default)]
    #[schemars(range(max = 10000))]
    pub offset: u32,
    #[serde(default = "package_page_size")]
    #[schemars(range(min = 1, max = 200))]
    pub limit: u32,
}
fn package_page_size() -> u32 {
    100
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PackageQueryMode {
    #[default]
    Installed,
    Loaded,
    Attached,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageEntry {
    pub name: String,
    pub version: String,
    pub title: Option<String>,
    pub built: Option<String>,
    pub library_path: Option<String>,
    pub library_index: Option<u32>,
    pub first_in_library_path: bool,
    pub loaded_version: Option<String>,
    pub loaded_path: Option<String>,
    pub loaded_from_library: bool,
    pub attached: bool,
    #[serde(default)]
    pub source: Option<PackageSource>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageSnapshotData {
    pub r_version: String,
    pub r_home: String,
    pub platform: String,
    pub library_paths: Vec<String>,
    pub mode: PackageQueryMode,
    pub filter: String,
    pub offset: u32,
    pub next_offset: Option<u32>,
    pub packages: Vec<PackageEntry>,
    #[serde(default)]
    pub groups: Vec<PackageGroup>,
    #[serde(default)]
    pub counts: PackageCounts,
    #[serde(default)]
    pub libraries: Vec<PackageLibrary>,
    #[serde(default)]
    pub observation_id: String,
    #[serde(default)]
    pub observed_at_ms: i64,
    #[serde(default)]
    pub package_name: Option<String>,
    pub total_matches: u32,
    pub scanned: u32,
    pub scan_complete: bool,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageSourceField {
    pub field: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageProjectLink {
    pub label: String,
    pub url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageSource {
    pub kind: String,
    pub repository: Option<String>,
    pub repository_url: Option<String>,
    pub remote_host: Option<String>,
    pub remote_ref: Option<String>,
    pub remote_sha: Option<String>,
    pub delivery_url: Option<String>,
    pub provider: Option<String>,
    pub snapshot: Option<String>,
    pub evidence: Vec<PackageSourceField>,
    pub links: Vec<PackageProjectLink>,
    pub notice: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageCounts {
    pub all: u32,
    pub installed: u32,
    pub installations: u32,
    pub loaded: u32,
    pub attached: u32,
    pub multiple: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageLibrary {
    pub index: u32,
    pub path: String,
    pub status: String,
    pub notice: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageGroup {
    pub name: String,
    pub title: Option<String>,
    pub version: String,
    pub first_version: Option<String>,
    pub primary_library_path: Option<String>,
    pub copy_count: u32,
    pub loaded_version: Option<String>,
    pub loaded_path: Option<String>,
    pub loaded_copy_observed: bool,
    pub attached: bool,
    pub source_kind: String,
    pub source_count: u32,
}
