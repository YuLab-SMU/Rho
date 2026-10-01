//! Native builds name immutable source, never a moving branch or active instance.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BuildPlugin {
    pub revision: RevisionId,
    #[serde(default = "default_build_timeout")]
    #[schemars(range(min = 1, max = 3600000))]
    pub timeout_ms: u64,
}
fn default_build_timeout() -> u64 {
    120_000
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginBuildResult {
    pub operation_id: OperationId,
    pub revision: RevisionId,
    pub artifact: Option<ArtifactId>,
    /// Bounded native evidence, not an independent Operation outcome.
    pub process: ProcessReport,
    pub diagnostic: Option<String>,
}
