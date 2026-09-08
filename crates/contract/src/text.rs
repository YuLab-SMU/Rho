//! Version-bound project text investigation. All byte positions count original UTF-8 bytes.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TextIdentity {
    pub path: String,
    pub sha256: String,
    /// Native file identity, including replacement/change metadata; not an authorization token.
    pub native_identity: String,
    pub byte_size: u64,
    pub encoding: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct TextCursor {
    pub project: String,
    pub file: TextIdentity,
    pub byte_offset: u64,
    pub line: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadTextArguments {
    pub path: String,
    #[serde(default)]
    pub expected_sha256: Option<String>,
    #[serde(default = "first_line")]
    #[schemars(range(min = 1))]
    pub start_line: u64,
    #[serde(default = "text_lines")]
    #[schemars(range(min = 1, max = 200))]
    pub limit_lines: u32,
    #[serde(default)]
    pub continuation: Option<TextCursor>,
}
fn first_line() -> u64 {
    1
}
fn text_lines() -> u32 {
    200
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct TextFragment {
    /// File lines start at 1. A long line can span multiple fragments/pages.
    pub line: u64,
    pub byte_start: u64,
    pub byte_end: u64,
    /// Original text, including CR/LF if present. A UTF-8 BOM is metadata, not text.
    pub text: String,
    pub line_complete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct TextPage {
    pub file: Option<TextIdentity>,
    pub fragments: Vec<TextFragment>,
    pub skipped: Option<TextSkip>,
    pub continuation: Option<TextCursor>,
    pub complete: bool,
    pub limit_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum TextSkipReason {
    Binary,
    InvalidEncoding,
    Oversize,
    Unreadable,
    Symlink,
    Unsupported,
    InvalidPath,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct TextSkip {
    pub path: String,
    pub reason: TextSkipReason,
    pub detail: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DirectoryScanFrame {
    pub path: String,
    pub after_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SearchTextCursor {
    pub project: String,
    pub query_sha256: String,
    pub directories: Vec<DirectoryScanFrame>,
    pub active_file: Option<TextCursor>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SearchTextArguments {
    /// Literal UTF-8 text. Case-insensitive matching uses Unicode lowercase mapping (not locale-specific collation).
    #[schemars(length(min = 1, max = 1024))]
    pub text: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub directory: String,
    /// Literal substring of the file name (same case rule as text).
    #[serde(default)]
    pub filename_contains: Option<String>,
    #[serde(default)]
    pub show_hidden: bool,
    #[serde(default = "search_matches")]
    #[schemars(range(min = 1, max = 100))]
    pub limit_matches: u32,
    #[serde(default)]
    pub continuation: Option<SearchTextCursor>,
}
fn search_matches() -> u32 {
    100
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct TextMatch {
    pub file: TextIdentity,
    pub line: u64,
    pub byte_start: u64,
    pub byte_end: u64,
    pub snippet: String,
    pub read: ReadTextArguments,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SearchTextPage {
    pub matches: Vec<TextMatch>,
    pub skipped: Vec<TextSkip>,
    pub scanned_entries: u32,
    /// Bytes examined for literal matches, distinct from full-file identity verification.
    pub scanned_bytes: u64,
    pub verified_bytes: u64,
    pub continuation: Option<SearchTextCursor>,
    pub complete: bool,
    pub limit_reason: Option<String>,
    pub consistency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SearchFilesCursor {
    pub project: String,
    pub text: String,
    pub show_hidden: bool,
    pub directories: Vec<DirectoryScanFrame>,
}
