//! Standard Skill content and application method context; no new Skill package format.
use crate::{CapabilityRef, TargetRef};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;
fn list_limit() -> u32 {
    20
}
fn byte_limit() -> u32 {
    16384
}
fn resource_limit() -> u32 {
    50
}
fn root_directory() -> String {
    ".".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SkillListArguments {
    #[serde(default = "root_directory")]
    pub working_directory: String,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "list_limit")]
    pub limit: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SkillEnablement {
    Enabled,
    Disabled,
    Rejected,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillSourceRelation {
    pub source_id: String,
    /// Stable source-qualified package identity, including across content changes.
    pub source_ref: String,
    pub location: String,
    pub enablement: SkillEnablement,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub metadata: BTreeMap<String, String>,
    /// Preserved provider syntax. This field never grants a Rho scope.
    pub allowed_tools: Option<String>,
    /// Optional host fields are preserved as data; Rho does not infer requirements.
    pub extra: BTreeMap<String, serde_json::Value>,
    pub dependencies: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillResourceSummary {
    pub resource_ref: String,
    pub path: String,
    pub sha256: String,
    pub byte_size: u64,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillSummary {
    /// Observation identity bound to principal, project, scope and all package resources.
    pub skill_ref: String,
    pub source: SkillSourceRelation,
    pub available: bool,
    pub unavailable_reasons: Vec<String>,
    pub metadata: SkillMetadata,
    pub skill_digest: String,
    pub manifest_digest: String,
    pub resource_count: u32,
    pub equivalent_sources: Vec<SkillSourceRelation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillSourceNotice {
    pub source_id: String,
    pub location: String,
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillListPage {
    pub working_directory: String,
    pub skills: Vec<SkillSummary>,
    pub total: u32,
    pub next_cursor: Option<String>,
    pub source_notices: Vec<SkillSourceNotice>,
    pub notices_next_cursor: Option<String>,
    pub complete: bool,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SkillReadKind {
    Manifest,
    Text,
    Bytes,
}
fn text_kind() -> SkillReadKind {
    SkillReadKind::Text
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SkillReadArguments {
    #[serde(default = "root_directory")]
    pub working_directory: String,
    pub skill_ref: String,
    pub expected_digest: String,
    #[serde(default = "text_kind")]
    pub kind: SkillReadKind,
    /// Defaults to SKILL.md. Paths are package-relative, never expressions or absolute paths.
    #[serde(default)]
    pub resource_path: Option<String>,
    #[serde(default)]
    pub expected_resource_digest: Option<String>,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "byte_limit")]
    pub limit_bytes: u32,
    #[serde(default = "resource_limit")]
    pub resource_limit: u32,
    #[serde(default)]
    pub external_task_ref: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct SkillReadPage {
    pub skill_ref: String,
    pub source_ref: String,
    pub skill_digest: String,
    pub manifest_digest: String,
    pub kind: SkillReadKind,
    pub resource: Option<SkillResourceSummary>,
    pub resources: Vec<SkillResourceSummary>,
    pub text: Option<String>,
    pub bytes: Option<Vec<u8>>,
    /// UTF-8 byte offset for text, original byte offset for binary, entry offset for manifests.
    pub offset: u64,
    pub next_offset: Option<u64>,
    pub complete: bool,
    pub observed_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResolveContextArguments {
    #[serde(default = "root_directory")]
    pub working_directory: String,
    #[serde(default)]
    pub external_task_ref: Option<String>,
    #[serde(default)]
    pub target: Option<TargetRef>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default = "list_limit")]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MethodCondition {
    pub binding_id: String,
    pub code: String,
    pub message: String,
    pub capability: Option<CapabilityRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct MethodResolution {
    pub binding: crate::ApplicationMethodBinding,
    pub binding_id: String,
    pub version: String,
    pub source_ref: String,
    pub skill_ref: String,
    pub excluded: bool,
    pub valid: bool,
    pub target: Option<TargetRef>,
    pub conditions: Vec<MethodCondition>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct ResolvedSkillContext {
    pub working_directory: String,
    pub external_task_ref: Option<String>,
    pub target: Option<TargetRef>,
    pub discoverable: SkillListPage,
    pub methods: Vec<MethodResolution>,
    pub bindings_complete: bool,
    pub dependencies: String,
    pub notices: Vec<String>,
}

/// Host launch metadata referencing actual packages; never a new SKILL.md format.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostDiscoveredSkills {
    pub provider_id: String,
    pub skills: Vec<HostDiscoveredSkill>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum HostSkillSourceKind {
    Project,
    User,
    Plugin,
    Managed,
    Builtin,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostDiscoveredSkill {
    pub source_key: String,
    pub root_path: String,
    pub source_kind: HostSkillSourceKind,
    pub enablement: SkillEnablement,
    pub reason: Option<String>,
}
