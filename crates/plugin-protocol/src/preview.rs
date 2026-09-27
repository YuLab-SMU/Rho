use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// An exact query fixture, never a backend reply or scientific evidence. Missing
/// arguments do not fall through to the real Host, even for read-only queries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginPreviewQuery {
    pub capability: CapabilityKey,
    pub arguments: Value,
    pub data: Value,
}

/// Create a disposable presentation instance of an existing immutable artifact.
/// It has no backend, Host grants, provider registrations or project data path.
/// Open/close its views and release it through the ordinary lifecycle ports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PreviewPlugin {
    pub revision: RevisionId,
    pub artifact: ArtifactId,
    pub alias: InstanceAlias,
    pub configuration: Value,
    #[schemars(length(max = 128))]
    pub queries: Vec<PluginPreviewQuery>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstancePurpose {
    #[default]
    Runtime,
    FixturePreview,
}
impl PluginInstancePurpose {
    pub fn is_runtime(&self) -> bool { *self == Self::Runtime }
}
