//! Public core package/lifecycle requests. Scientific arguments remain owner-defined.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Current metadata coverage, not a lease or a claim that materials are unused.
/// Requires project.references.read in addition to the owner's normal read scope.
/// No foreign identities, counts, configuration or scientific data are disclosed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectReadCoverage {
    pub all_visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectReadCoverageArguments {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginCatalogArguments {
    pub after: Option<RevisionId>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginRevisionArguments {
    pub revision: RevisionId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginCatalogItem {
    pub revision: RevisionId,
    pub plugin: PluginId,
    pub name: String,
    pub version: String,
    pub description: String,
    pub artifacts: Vec<ArtifactId>,
    /// Counts protectors without exposing another principal's operation identities.
    pub reference_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginCatalogPage {
    pub items: Vec<PluginCatalogItem>,
    pub next: Option<RevisionId>,
    pub total: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArtifactSummary {
    pub id: ArtifactId,
    pub target: String,
    pub file_count: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginInspection {
    pub summary: PluginCatalogItem,
    pub manifest: PluginManifest,
    pub parent: Option<RevisionId>,
    pub source_file_count: u64,
    pub artifacts: Vec<PluginArtifactSummary>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginInstancesArguments {
    pub after: Option<PluginInstanceId>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
    /// Runtime discovery excludes fixture previews unless explicitly requested.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<_>", optional)]
    pub include_previews: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginInstanceArguments {
    pub instance: InstanceRef,
}

/// Resume one confirmed Host suspension. Configuration and grants are retained
/// by the Host; the caller cannot replace them through recovery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResumePlugin {
    pub instance: InstanceRef,
    pub suspension: RequestId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginInstanceObservation {
    pub instance: PluginInstance,
    /// Whether this Host owns the observation. Inspect state separately; a stored
    /// PID, failed instance or historical record is not evidence of a live process.
    pub observed_in_this_host: bool,
    pub process_id: Option<u32>,
    pub retained_calls: Option<u32>,
    pub pending_messages: Option<u32>,
    pub stderr: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginInstanceObservations {
    pub instances: Vec<PluginInstanceObservation>,
    pub next: Option<PluginInstanceId>,
    pub total: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginResolveArguments {
    pub capability: CapabilityKey,
    pub instance: Option<InstanceRef>,
    pub target: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ActivatePlugin {
    pub revision: RevisionId,
    pub artifact: ArtifactId,
    pub target: String,
    pub alias: InstanceAlias,
    pub configuration: Value,
    /// Exact optional declarations selected for this activation, never inferred
    /// from configuration, package availability or an eventual view request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<_>", optional)]
    pub optional_capabilities: Vec<CapabilityKey>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BranchPlugin {
    pub revision: RevisionId,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AdvancePluginBranch {
    pub branch: BranchId,
    pub expected: RevisionId,
    pub next: RevisionId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginBranchArguments {
    pub branch: BranchId,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ComparePluginRevisions {
    pub before: RevisionId,
    pub after: RevisionId,
}
