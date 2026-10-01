//! Static package-copy evidence, bound to the Workspace package observation.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
fn limit() -> u32 {
    100
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageIndexArguments {
    pub expected_session: String,
    pub observation_id: String,
    pub package: String,
    pub library_path: String,
    #[serde(default)]
    pub index_ref: Option<String>,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "limit")]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageIndexEntry {
    pub kind: String,
    pub name: String,
    pub topic: Option<String>,
    pub title: Option<String>,
    pub declaration: Option<String>,
    pub resolved: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageFileIdentity {
    pub path: String,
    pub digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageDescriptionField {
    pub name: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct PackageIndexPage {
    pub index_ref: String,
    pub observation_id: String,
    pub package: String,
    pub library_path: String,
    pub version: String,
    pub files: Vec<PackageFileIdentity>,
    pub description: Vec<PackageDescriptionField>,
    pub entries: Vec<PackageIndexEntry>,
    pub total: u32,
    pub offset: u32,
    pub next_offset: Option<u32>,
    pub observed_at_ms: i64,
    pub complete: bool,
    pub notices: Vec<String>,
}
