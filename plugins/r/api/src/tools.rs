use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
fn default_package() -> String {
    "base".into()
}
fn default_help_limit() -> u32 {
    16384
}
fn default_lint_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HelpArguments {
    #[schemars(length(min = 1, max = 128))]
    pub topic: String,
    #[serde(default = "default_package")]
    #[schemars(length(min = 1, max = 128))]
    pub package: String,
    /// Exact installed copy from workspace.packages/package_index.
    #[serde(default)]
    pub library_path: Option<String>,
    #[serde(default)]
    pub observation_id: Option<String>,
    /// Static file identities returned by workspace.package_index.
    #[serde(default)]
    pub expected_index_files: Option<Vec<crate::PackageFileIdentity>>,
    #[serde(default = "default_help_limit")]
    #[schemars(range(min = 1, max = 32768))]
    pub max_chars: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LintArguments {
    #[schemars(length(max = 65536))]
    pub code: String,
    #[serde(default = "default_lint_limit")]
    #[schemars(range(min = 1, max = 200))]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FormatArguments {
    #[schemars(length(max = 65536))]
    pub code: String,
}

#[derive(Debug, Clone)]
pub enum WorkspaceToolRequest {
    Help(HelpArguments),
    Lint(LintArguments),
    Format(FormatArguments),
}
impl WorkspaceToolRequest {
    pub fn action(&self) -> &'static str {
        match self {
            Self::Help(_) => "help",
            Self::Lint(_) => "lint",
            Self::Format(_) => "format",
        }
    }
}
