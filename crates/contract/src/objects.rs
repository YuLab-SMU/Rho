//! Progressive, identity-bound R object observations. R indexes start at one.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

fn page_limit() -> u32 {
    100
}
fn one() -> u64 {
    1
}
fn column_limit() -> u32 {
    50
}
fn first_column() -> u32 { 1 }
fn text_limit() -> u32 {
    16384
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListObjectsArguments {
    pub expected_session: String,
    #[serde(default)]
    pub name_contains: String,
    /// Filter by native R typeof (for example double, character, list or closure); classes remain metadata.
    #[serde(default)]
    pub object_type: Option<String>,
    #[serde(default)]
    pub directory_ref: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "page_limit")]
    #[schemars(range(min = 1, max = 200))]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ObjectPathElement {
    Index { #[schemars(range(min = 1))] index: u64 },
    Name { name: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ObserveObjectArguments {
    pub expected_session: String,
    pub name: String,
    #[serde(default)]
    pub path: Vec<ObjectPathElement>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ObjectReadKind {
    Structure,
    Values,
    Children,
    Table,
    Text,
    Levels,
    Names,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadObjectArguments {
    pub expected_session: String,
    pub object_ref: String,
    pub kind: ObjectReadKind,
    #[serde(default)]
    pub path: Vec<ObjectPathElement>,
    #[serde(default = "one")]
    #[schemars(range(min = 1))]
    pub start: u64,
    #[serde(default = "page_limit")]
    #[schemars(range(min = 1, max = 200))]
    pub limit: u32,
    #[serde(default = "first_column")]
    #[schemars(range(min = 1))]
    pub column_start: u32,
    #[serde(default = "column_limit")]
    #[schemars(range(min = 1, max = 50))]
    pub column_limit: u32,
    /// For kind=text, select "names" or "levels" instead of character values.
    #[serde(default)]
    pub text_attribute: Option<String>,
    #[serde(default = "one")]
    #[schemars(range(min = 1))]
    pub text_start: u64,
    #[serde(default = "text_limit")]
    #[schemars(range(min = 1, max = 65536))]
    pub text_limit_bytes: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectMetadata {
    pub kind: String,
    pub object_type: Option<String>,
    pub classes: Vec<String>,
    pub length: Option<u64>,
    pub dimensions: Vec<u64>,
    pub supported_reads: Vec<ObjectReadKind>,
    pub attributes: Vec<ObjectAttribute>,
    pub notice: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectAttribute {
    pub name: String,
    pub values: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectDirectoryEntry {
    pub name: String,
    pub metadata: ObjectMetadata,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectDirectoryPage {
    pub directory_ref: String,
    pub entries: Vec<ObjectDirectoryEntry>,
    pub total: u32,
    pub offset: u32,
    pub next_offset: Option<u32>,
    pub observed_at_ms: i64,
    pub complete: bool,
    pub notices: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectObservation {
    pub object_ref: String,
    pub name: String,
    pub path: Vec<ObjectPathElement>,
    pub metadata: ObjectMetadata,
    pub observed_at_ms: i64,
    pub expires_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectScalar {
    pub kind: String,
    pub object_type: String,
    pub logical: Option<bool>,
    pub number: Option<f64>,
    pub imaginary: Option<f64>,
    pub text: Option<String>,
    pub label: Option<String>,
    pub text_characters: Option<u64>,
    pub next_text_start: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectChild {
    pub index: u64,
    pub name: Option<String>,
    pub metadata: ObjectMetadata,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectColumn {
    pub index: u32,
    pub name: Option<String>,
    pub metadata: ObjectMetadata,
    pub values: Vec<ObjectScalar>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ObjectReadPage {
    pub object_ref: String,
    pub root_name: String,
    /// Path fixed when the observation opened, separate from this read's relative path.
    pub observed_path: Vec<ObjectPathElement>,
    pub path: Vec<ObjectPathElement>,
    pub kind: ObjectReadKind,
    pub metadata: ObjectMetadata,
    pub values: Vec<ObjectScalar>,
    pub children: Vec<ObjectChild>,
    pub columns: Vec<ObjectColumn>,
    pub start: u64,
    pub next_start: Option<u64>,
    pub column_start: u32,
    pub next_column_start: Option<u32>,
    pub text_start: u64,
    pub next_text_start: Option<u64>,
    pub observed_at_ms: i64,
    pub complete: bool,
    pub notices: Vec<String>,
}
