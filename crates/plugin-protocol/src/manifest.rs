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
    /// Available only when explicitly selected by the activation request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<_>", optional)]
    pub optional_requires: Vec<CapabilityRequirement>,
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
    Control,
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
    /// Valid scientific arguments used in discovery; the Host adds provider binding.
    pub examples: Vec<Value>,
    pub output_schema: Value,
    pub recovery_schema: Value,
    pub required_scopes: BTreeSet<String>,
    pub effects: BTreeSet<String>,
    pub cancellation: CancellationSupport,
    /// Optional read-only owner preflight, invoked before Operation admission.
    #[serde(default)]
    pub preflight: Option<CapabilityKey>,
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
    /// Selection does not grant authority: Host admission must still validate
    /// every selected contract and scope against the caller and registry.
    pub fn activation_requirements(
        &self,
        optional: &[CapabilityKey],
    ) -> Result<Vec<CapabilityRequirement>, ProtocolError> {
        require(
            optional.len() <= self.optional_requires.len(),
            "too many optional capability selections",
        )?;
        let mut seen = BTreeSet::new();
        let mut grants = self.requires.clone();
        for key in optional {
            require(seen.insert(key), "duplicate optional capability selection")?;
            let grant = self
                .optional_requires
                .iter()
                .find(|item| &item.capability == key)
                .ok_or_else(|| {
                    ProtocolError("optional capability is not declared by this revision".into())
                })?;
            grants.push(grant.clone());
        }
        Ok(grants)
    }
    pub fn validate_activation_grants(
        &self,
        grants: &[CapabilityRequirement],
    ) -> Result<(), ProtocolError> {
        let optional = grants
            .iter()
            .filter(|grant| !self.requires.contains(grant))
            .map(|grant| grant.capability.clone())
            .collect::<Vec<_>>();
        let expected = self.activation_requirements(&optional)?;
        require(
            grants.len() == expected.len()
                && expected
                    .iter()
                    .all(|grant| grants.iter().filter(|item| *item == grant).count() == 1),
            "activation grants do not match declared requirements",
        )
    }
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
            self.dependencies.len() <= 128
                && self.requires.len() + self.optional_requires.len() <= 256,
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
            require(
                !cap.examples.is_empty() && cap.examples.len() <= 16,
                "capabilities require 1–16 input examples",
            )?;
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
        for cap in &self.capabilities {
            if cap.kind == CapabilityKind::Control {
                require(
                    cap.cancellation == CancellationSupport::Unsupported,
                    "ephemeral controls cannot create a cancellable Operation",
                )?;
            }
            if let Some(preflight) = &cap.preflight {
                require(
                    matches!(
                        cap.kind,
                        CapabilityKind::Operation | CapabilityKind::Runtime
                    ) && capabilities.get(preflight) == Some(&CapabilityKind::Query),
                    "operation preflight must name a declared query in the same plugin",
                )?;
            }
        }
        for req in self.requires.iter().chain(&self.optional_requires) {
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

#[cfg(test)]
mod optional_tests {
    use super::*;
    use serde_json::json;
    fn manifest() -> PluginManifest {
        serde_json::from_value(json!({"protocol_version":1,"id":"example.editor","name":"Editor","version":"1","description":"Text editing","license":"MIT",
            "source":{"files":["src/editor.ts"],"lockfiles":["dependencies.lock"],"build_instructions":"BUILD.md","build":null},"dependencies":{},
            "requires":[{"capability":{"id":"files.read","version":1},"scopes":["project.read"]}],
            "optional_requires":[{"capability":{"id":"language.run","version":2},"scopes":["workspace.run"]},
                {"capability":{"id":"language.observe","version":1},"scopes":["workspace.read"]}],
            "views":[],"capabilities":[],"contexts":[],"backend":null,"configuration_schema":{},"default_configuration":{}})).unwrap()
    }
    #[test]
    fn optional_requirements_are_explicit_exact_and_cannot_change_required_scopes() {
        let manifest = manifest();
        manifest.validate().unwrap();
        assert_eq!(
            manifest.activation_requirements(&[]).unwrap(),
            manifest.requires
        );
        let selected = manifest.optional_requires[0].capability.clone();
        let grants = manifest
            .activation_requirements(std::slice::from_ref(&selected))
            .unwrap();
        assert_eq!(
            grants,
            vec![
                manifest.requires[0].clone(),
                manifest.optional_requires[0].clone()
            ]
        );
        manifest.validate_activation_grants(&grants).unwrap();
        assert!(
            manifest
                .activation_requirements(&[selected.clone(), selected.clone()])
                .is_err()
        );
        let mut wrong = selected;
        wrong.version += 1;
        assert!(manifest.activation_requirements(&[wrong]).is_err());
        assert!(
            manifest
                .activation_requirements(&[manifest.requires[0].capability.clone()])
                .is_err()
        );
        for index in 0..grants.len() {
            let mut weakened = grants.clone();
            weakened[index].scopes.clear();
            assert!(manifest.validate_activation_grants(&weakened).is_err());
            let mut enlarged = grants.clone();
            enlarged[index].scopes.insert("another.scope".into());
            assert!(manifest.validate_activation_grants(&enlarged).is_err());
        }
        assert!(manifest.validate_activation_grants(&grants[1..]).is_err());
        let mut duplicated = grants;
        duplicated.push(manifest.requires[0].clone());
        assert!(manifest.validate_activation_grants(&duplicated).is_err());
    }
    #[test]
    fn optional_declarations_share_bounds_and_do_not_change_omitted_defaults() {
        let mut manifest = manifest();
        manifest
            .optional_requires
            .push(manifest.requires[0].clone());
        assert!(manifest.validate().is_err());
        manifest.optional_requires.clear();
        let value = serde_json::to_value(&manifest).unwrap();
        assert!(!value.as_object().unwrap().contains_key("optional_requires"));
        let restored: PluginManifest = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), value);
        let optional: CapabilityRequirement =
            serde_json::from_value(json!({"capability":{"id":"optional","version":0},"scopes":[]}))
                .unwrap();
        manifest.optional_requires.push(optional);
        assert!(manifest.validate().is_err());
        manifest.optional_requires[0].capability.version = 1;
        manifest.optional_requires[0]
            .scopes
            .insert("bad\0scope".into());
        assert!(manifest.validate().is_err());
        manifest.optional_requires.clear();
        for version in 1..=256 {
            manifest.optional_requires.push(CapabilityRequirement {
                capability: CapabilityKey {
                    id: ContributionId::new("optional").unwrap(),
                    version,
                },
                scopes: BTreeSet::new(),
            });
        }
        assert!(
            manifest
                .validate()
                .unwrap_err()
                .to_string()
                .contains("too many dependencies")
        );
    }
}
