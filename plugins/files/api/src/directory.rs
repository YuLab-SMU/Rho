use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Capacity of the filesystem containing the canonical project root, not project size.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ProjectStorage {
    pub project: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SearchFilesArguments {
    #[serde(default)]
    pub continuation: Option<crate::SearchFilesCursor>,
    pub text: String,
    #[serde(default)]
    pub show_hidden: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct FileSearchResult {
    pub continuation: Option<crate::SearchFilesCursor>,
    pub entries: Vec<crate::DirectoryEntry>,
    pub scanned_entries: u32,
    pub scanned_directories: u32,
    pub truncated: bool,
    pub notices: Vec<String>,
}
