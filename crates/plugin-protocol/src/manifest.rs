use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilityKey {
    pub id: ContributionId,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub protocol_version: u32,
    pub id: PluginId,
    pub name: String,
    /// Human-readable only. All bindings use revision and artifact digests.
    pub version: String,
    pub description: String,
    pub license: String,
    pub source: SourceDeclaration,
    pub dependencies: BTreeMap<InstanceAlias, PluginDependency>,
    pub requires: Vec<CapabilityRequirement>,
    pub views: Vec<ViewContribution>,
    pub capabilities: Vec<CapabilityContribution>,
    pub contexts: Vec<ContextContribution>,
    pub backend: Option<BackendEntrypoint>,
    pub configuration_schema: Value,
    pub default_configuration: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SourceDeclaration {
    /// Every first-party source file must be included in the package snapshot.
    pub files: BTreeSet<PackagePath>,
    pub lockfiles: BTreeSet<PackagePath>,
    pub build_instructions: PackagePath,
    /// Executed only by an explicit development build, never by import or query.
    pub build: Option<BuildRecipe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BuildRecipe {
    /// Executable and literal arguments, without a shell interpolation layer.
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginDependency {
    pub plugin: PluginId,
    pub revision: RevisionId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilityRequirement {
    pub capability: CapabilityKey,
    pub scopes: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ViewContribution {
    pub id: ContributionId,
    pub title: String,
    pub entrypoint: PackagePath,
    pub state_schema: Value,
    pub configuration_schema: Value,
    pub resource_kinds: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    Query,
    Operation,
    Runtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum CancellationSupport {
    Unsupported,
    Request,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CapabilityContribution {
    pub capability: CapabilityKey,
    pub kind: CapabilityKind,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub recovery_schema: Value,
    pub required_scopes: BTreeSet<String>,
    pub effects: BTreeSet<String>,
    pub cancellation: CancellationSupport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextContribution {
    pub id: ContributionId,
    pub title: String,
    pub search: CapabilityKey,
    pub preview: CapabilityKey,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BackendEntrypoint {
    pub executable: PackagePath,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PackageFile {
    pub digest: ContentDigest,
    pub bytes: u64,
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginRevision {
    pub id: RevisionId,
    pub parent: Option<RevisionId>,
    pub manifest: PluginManifest,
    /// Includes plugin.json, declarations, lockfiles and all first-party source.
    pub files: BTreeMap<PackagePath, PackageFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct BuildArtifact {
    pub id: ArtifactId,
    pub revision: RevisionId,
    /// Examples: ui-web, aarch64-apple-darwin. No platform is selected implicitly.
    pub target: String,
    pub files: BTreeMap<PackagePath, PackageFile>,
}

/// A bounded, versioned local archive. Content-addressed blobs avoid duplicate bytes.
/// JSON plus base64 makes the import format independent of native archive extractors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginArchive {
    pub format_version: u32,
    pub revision: PluginRevision,
    pub artifacts: Vec<BuildArtifact>,
    pub blobs: BTreeMap<ContentDigest, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InstalledPluginRevision {
    pub revision: RevisionId,
    pub plugin: PluginId,
    pub name: String,
    pub version: String,
    pub description: String,
    pub artifacts: Vec<ArtifactId>,
    pub references: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginRevisionPage {
    pub revisions: Vec<InstalledPluginRevision>,
    pub next: Option<RevisionId>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RevisionDifference {
    pub before: RevisionId,
    pub after: RevisionId,
    pub files: Vec<SourceFileDifference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SourceFileDifference {
    pub path: PackagePath,
    pub before: Option<PackageFile>,
    pub after: Option<PackageFile>,
}

impl PluginManifest {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            self.protocol_version == PLUGIN_PROTOCOL_VERSION,
            "unsupported plugin protocol",
        )?;
        let bytes = serde_json::to_vec(self).map_err(|e| ProtocolError(e.to_string()))?;
        require(
            bytes.len() <= MAX_MANIFEST_BYTES,
            "manifest exceeds byte limit",
        )?;
        bounded_text(&self.name, 128, "plugin name")?;
        bounded_text(&self.version, 64, "display version")?;
        bounded_text(&self.description, 2048, "description")?;
        bounded_text(&self.license, 256, "license")?;
        require(
            !self.source.files.is_empty() && !self.source.lockfiles.is_empty(),
            "packages must declare first-party source and dependency locks",
        )?;
        require(
            self.source.files.len() + self.source.lockfiles.len() <= MAX_PACKAGE_FILES,
            "too many source declarations",
        )?;
        for path in self
            .source
            .files
            .iter()
            .chain(&self.source.lockfiles)
            .chain([&self.source.build_instructions])
        {
            require(
                !path.is_artifact(),
                "source and build instructions cannot live in dist/",
            )?;
        }
        if let Some(build) = &self.source.build {
            require(
                !build.command.is_empty() && build.command.len() <= 128,
                "invalid build command",
            )?;
            for arg in &build.command {
                require(
                    arg.len() <= 4096 && !arg.contains('\0'),
                    "invalid build argument",
                )?;
            }
            bounded_text(&build.command[0], 1024, "build executable")?;
        }
        require(
            self.dependencies.len() <= 128 && self.requires.len() <= 256,
            "too many dependencies or requirements",
        )?;
        require(
            self.views.len() + self.capabilities.len() + self.contexts.len() <= 512,
            "too many contributions",
        )?;
        require(
            self.backend.is_some() || self.capabilities.is_empty(),
            "capabilities require a backend entrypoint",
        )?;
        let mut views = BTreeSet::new();
        for view in &self.views {
            require(views.insert(&view.id), "duplicate view contribution")?;
            bounded_text(&view.title, 128, "view title")?;
            require(
                view.entrypoint.is_artifact(),
                "view entrypoints must be immutable dist/ artifacts",
            )?;
            schema_shape(&view.state_schema)?;
            schema_shape(&view.configuration_schema)?;
            for kind in &view.resource_kinds {
                bounded_text(kind, 128, "resource kind")?;
            }
        }
        let mut capabilities = BTreeMap::new();
        for cap in &self.capabilities {
            require(
                cap.capability.version > 0,
                "capability version must be positive",
            )?;
            require(
                capabilities.insert(&cap.capability, cap.kind).is_none(),
                "duplicate capability contribution",
            )?;
            bounded_text(&cap.title, 128, "capability title")?;
            bounded_text(&cap.description, 4096, "capability description")?;
            for schema in [&cap.input_schema, &cap.output_schema, &cap.recovery_schema] {
                schema_shape(schema)?;
            }
            for scope in &cap.required_scopes {
                bounded_text(scope, 128, "scope")?;
            }
            for effect in &cap.effects {
                bounded_text(effect, 128, "effect")?;
            }
            if cap.kind == CapabilityKind::Query {
                require(
                    cap.effects.is_empty() && cap.cancellation == CancellationSupport::Unsupported,
                    "queries cannot declare effects or cancellation",
                )?;
            }
        }
        let mut requirements = BTreeSet::new();
        for req in &self.requires {
            require(
                req.capability.version > 0 && requirements.insert(&req.capability),
                "invalid or duplicate capability requirement",
            )?;
            for scope in &req.scopes {
                bounded_text(scope, 128, "scope")?;
            }
        }
        let mut contexts = BTreeSet::new();
        for ctx in &self.contexts {
            require(contexts.insert(&ctx.id), "duplicate context contribution")?;
            bounded_text(&ctx.title, 128, "context title")?;
            for key in [&ctx.search, &ctx.preview] {
                require(
                    capabilities.get(key) == Some(&CapabilityKind::Query),
                    "context search and preview must be declared queries",
                )?;
            }
        }
        if let Some(backend) = &self.backend {
            require(
                backend.executable.is_artifact(),
                "backend must run an immutable dist/ artifact",
            )?;
            require(
                backend.arguments.len() <= 128
                    && backend
                        .arguments
                        .iter()
                        .all(|x| x.len() <= 4096 && !x.contains('\0')),
                "invalid backend arguments",
            )?;
        }
        schema_shape(&self.configuration_schema)
    }
}

pub(crate) fn schema_shape(value: &Value) -> Result<(), ProtocolError> {
    require(
        value.is_object() || value.is_boolean(),
        "schemas must be JSON Schema objects or booleans",
    )
}
