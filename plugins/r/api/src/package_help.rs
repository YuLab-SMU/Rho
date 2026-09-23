//! Read-only help from one observed installed copy; no help-rendering Operation.
use crate::PackageFileIdentity;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
fn page_bytes() -> u32 {
    16384
}
/// Rendering format. HTML is produced by the static `tools::Rd2HTML` stage and is
/// suitable for a sanitized document view; text remains the bounded default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HelpFormat {
    #[default]
    Text,
    Html,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadPackageHelpArguments {
    pub expected_session: String,
    pub observation_id: String,
    pub package: String,
    pub library_path: String,
    pub topic: String,
    pub expected_index_files: Vec<PackageFileIdentity>,
    #[serde(default)]
    pub expected_help_files: Option<Vec<PackageFileIdentity>>,
    #[serde(default)]
    pub offset_utf8: u64,
    #[serde(default = "page_bytes")]
    pub limit_bytes: u32,
    #[serde(default)]
    pub format: HelpFormat,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageHelpPage {
    pub observation_id: String,
    pub package: String,
    pub library_path: String,
    pub topic: String,
    pub found: bool,
    pub text: String,
    pub offset_utf8: u64,
    pub next_offset_utf8: Option<u64>,
    pub total_bytes: u64,
    pub complete: bool,
    pub help_files: Vec<PackageFileIdentity>,
    #[serde(default)]
    pub format: HelpFormat,
    /// Present for HTML: the package version recorded in the observed copy.
    #[serde(default)]
    pub version: Option<String>,
}
