//! Phase 2 (P2-0) workspace plugin manifest validation.
//!
//! P2-0 owns the exact Manifest V1 schema, its fail-closed bounds, and the
//! capability/permission separation. A manifest *describes* requested
//! capabilities and permissions; it never grants authority. Validation runs
//! before any code is parsed or executed.

use std::{collections::BTreeSet, fmt, str::FromStr};

use serde::{Deserialize, Serialize};

use crate::{
    CapabilityDeclaration, CapabilityId, CapabilityRequirement, ExtensionError, PluginId,
    PluginVersion, ScopeKindId,
};

/// Maximum bytes for a single `rho-plugin.json` manifest before parsing.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
/// Maximum number of `provides` entries declared by one plugin manifest.
pub const MAX_MANIFEST_PROVIDES: usize = 64;
/// Maximum number of `requires` entries declared by one plugin manifest.
pub const MAX_MANIFEST_REQUIRES: usize = 64;
/// Maximum number of `optional` entries declared by one plugin manifest.
pub const MAX_MANIFEST_OPTIONAL: usize = 64;
/// Maximum number of permission requests declared by one plugin manifest.
pub const MAX_MANIFEST_PERMISSIONS: usize = 64;
/// Maximum depth of a package file tree during discovery.
pub const MAX_PACKAGE_DEPTH: usize = 32;
/// Maximum bytes of a single package file before it is rejected.
pub const MAX_PACKAGE_FILE_BYTES: usize = 4 * 1024 * 1024;
/// Maximum aggregate bytes across one plugin package.
pub const MAX_PACKAGE_AGGREGATE_BYTES: usize = 32 * 1024 * 1024;
/// Maximum number of files in one plugin package.
pub const MAX_PACKAGE_FILES: usize = 4096;
/// Maximum bytes of a single relative path component or full relative path.
pub const MAX_RELATIVE_PATH_BYTES: usize = 1024;

/// The schema version this manifest parser accepts.
pub const MANIFEST_SCHEMA_VERSION: u64 = 1;

/// Runtime kind declared by a plugin manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeKind {
    /// Control logic / UI-adjacent plugins via a restricted Web Worker.
    WebWorker,
    /// Bounded backend computation via a host-embedded WebAssembly instance.
    Wasm,
}

impl fmt::Display for RuntimeKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WebWorker => formatter.write_str("web-worker"),
            Self::Wasm => formatter.write_str("wasm"),
        }
    }
}

impl FromStr for RuntimeKind {
    type Err = ExtensionError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "web-worker" => Ok(Self::WebWorker),
            "wasm" => Ok(Self::Wasm),
            _ => Err(ExtensionError::UnsupportedRuntimeKind {
                runtime_kind: value.to_string(),
            }),
        }
    }
}

/// The `runtime` object of a manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDeclaration {
    pub kind: RuntimeKind,
    /// Relative entry path, e.g. `dist/plugin.js`.
    pub entry: String,
    /// The only executable scope in the initial Phase 2 version.
    pub scope: ScopeKindId,
}

/// A single `provides` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestProvide {
    pub capability: CapabilityId,
    #[serde(deserialize_with = "crate::manifest::deserialize_contract_major")]
    pub contract_major: u64,
    /// Optional relative path for declarative assets (e.g. a Skill pack).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// A single `requires` / `optional` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestRequire {
    pub capability: CapabilityId,
    #[serde(deserialize_with = "crate::manifest::deserialize_contract_major")]
    pub contract_major: u64,
}

/// A single permission request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub schemes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hosts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_response_bytes: Option<u64>,
}

/// The `ui` contribution surface.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiDeclaration {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub viewers: Vec<String>,
}

/// The fully validated Manifest V1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspacePluginManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u64,
    pub id: PluginId,
    pub name: String,
    pub version: PluginVersion,
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub runtime: RuntimeDeclaration,
    /// Activation events; `onCapability:...` strings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activation: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provides: Vec<ManifestProvide>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<ManifestRequire>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional: Vec<ManifestRequire>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<PermissionRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiDeclaration>,
}

impl WorkspacePluginManifest {
    /// Parse and validate raw manifest bytes, rejecting oversized input and any
    /// unknown security-relevant field before it can be silently ignored.
    pub fn parse(bytes: &[u8]) -> Result<Self, ExtensionError> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(ExtensionError::ManifestTooLarge {
                actual_bytes: bytes.len(),
                maximum_bytes: MAX_MANIFEST_BYTES,
            });
        }

        let manifest: WorkspacePluginManifest =
            serde_json::from_slice(bytes).map_err(|error| ExtensionError::ManifestParse {
                message: error.to_string(),
            })?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), ExtensionError> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(ExtensionError::UnsupportedManifestSchema {
                actual: self.schema_version,
                supported: MANIFEST_SCHEMA_VERSION,
            });
        }

        if self.name.is_empty() {
            return Err(ExtensionError::ManifestValidation {
                reason: "name must not be empty".to_string(),
            });
        }
        if self.api_version.is_empty() {
            return Err(ExtensionError::ManifestValidation {
                reason: "apiVersion must not be empty".to_string(),
            });
        }
        semver::VersionReq::parse(&self.api_version).map_err(|error| {
            ExtensionError::ManifestValidation {
                reason: format!("apiVersion must be a valid semver requirement: {error}"),
            }
        })?;
        if self.runtime.scope.as_str() != "project" {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("runtime scope must be project, got {}", self.runtime.scope),
            });
        }

        validate_relative_entry(&self.runtime.entry)?;
        validate_relative_paths(
            self.provides
                .iter()
                .filter_map(|provide| provide.path.as_deref()),
        )?;

        if self.provides.len() > MAX_MANIFEST_PROVIDES {
            return Err(ExtensionError::LimitExceeded {
                limit: crate::LimitKind::ProvidesPerPlugin,
                plugin_id: Some(self.id.clone()),
                actual: self.provides.len(),
                maximum: MAX_MANIFEST_PROVIDES,
            });
        }
        if self.requires.len() > MAX_MANIFEST_REQUIRES {
            return Err(ExtensionError::LimitExceeded {
                limit: crate::LimitKind::RequiredPerPlugin,
                plugin_id: Some(self.id.clone()),
                actual: self.requires.len(),
                maximum: MAX_MANIFEST_REQUIRES,
            });
        }
        if self.optional.len() > MAX_MANIFEST_OPTIONAL {
            return Err(ExtensionError::LimitExceeded {
                limit: crate::LimitKind::OptionalPerPlugin,
                plugin_id: Some(self.id.clone()),
                actual: self.optional.len(),
                maximum: MAX_MANIFEST_OPTIONAL,
            });
        }
        if self.permissions.len() > MAX_MANIFEST_PERMISSIONS {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("permissions exceed {} entries", MAX_MANIFEST_PERMISSIONS),
            });
        }

        let mut permission_names = BTreeSet::new();
        for permission in &self.permissions {
            if !permission_names.insert(permission.name.as_str()) {
                return Err(ExtensionError::ManifestValidation {
                    reason: format!("duplicate permission request: {}", permission.name),
                });
            }
            validate_permission_request(permission)?;
        }

        let mut activation_events = BTreeSet::new();
        for event in &self.activation {
            let Some(capability) = event.strip_prefix("onCapability:") else {
                return Err(ExtensionError::ManifestValidation {
                    reason: format!("unsupported activation event: {event}"),
                });
            };
            CapabilityId::new(capability.to_string()).map_err(|error| {
                ExtensionError::ManifestValidation {
                    reason: format!("invalid activation capability: {error}"),
                }
            })?;
            if !activation_events.insert(event.as_str()) {
                return Err(ExtensionError::ManifestValidation {
                    reason: format!("duplicate activation event: {event}"),
                });
            }
        }

        for provide in &self.provides {
            if provide.contract_major == 0 {
                return Err(ExtensionError::ManifestValidation {
                    reason: format!(
                        "capability {} declares contract major 0",
                        provide.capability
                    ),
                });
            }
        }

        Ok(())
    }

    /// Convert validated manifest entries into Phase 1 typed contracts, keeping
    /// capability and permission namespaces fully distinct. This is the only
    /// bridge P2-0 allows, and it produces descriptors, never granted handles.
    pub fn to_descriptor(&self) -> crate::PluginDescriptor {
        let mut descriptor = crate::PluginDescriptor::new(
            self.id.clone(),
            self.version.clone(),
            vec![self.runtime.scope.clone()],
        );
        descriptor.provides = self
            .provides
            .iter()
            .map(|provide| {
                CapabilityDeclaration::new(provide.capability.clone(), provide.contract_major)
            })
            .collect();
        descriptor.requires = self
            .requires
            .iter()
            .map(|require| {
                CapabilityRequirement::new(require.capability.clone(), require.contract_major)
            })
            .collect();
        descriptor.optional = self
            .optional
            .iter()
            .map(|require| {
                CapabilityRequirement::new(require.capability.clone(), require.contract_major)
            })
            .collect();
        descriptor
    }
}

fn validate_permission_request(permission: &PermissionRequest) -> Result<(), ExtensionError> {
    let invalid_shape = |expected: &str| ExtensionError::ManifestValidation {
        reason: format!(
            "permission {} has fields outside its {expected} constraint shape",
            permission.name
        ),
    };

    match permission.name.as_str() {
        "project.fs.read" => {
            if permission.paths.is_empty()
                || !permission.operations.is_empty()
                || !permission.schemes.is_empty()
                || !permission.hosts.is_empty()
                || !permission.methods.is_empty()
                || permission.max_response_bytes.is_some()
            {
                return Err(invalid_shape("project filesystem"));
            }
            validate_relative_paths(permission.paths.iter().map(String::as_str))?;
            validate_positive_bound(permission.max_bytes, "maxBytes")?;
        }
        "workspace.r.inspect" => {
            if permission.operations.is_empty()
                || !permission.paths.is_empty()
                || !permission.schemes.is_empty()
                || !permission.hosts.is_empty()
                || !permission.methods.is_empty()
                || permission.max_response_bytes.is_some()
            {
                return Err(invalid_shape("Workspace R inspection"));
            }
            if permission
                .operations
                .iter()
                .any(|operation| !matches!(operation.as_str(), "metadata" | "preview"))
            {
                return Err(ExtensionError::ManifestValidation {
                    reason: "workspace.r.inspect permits only metadata or preview".to_string(),
                });
            }
            validate_positive_bound(permission.max_bytes, "maxBytes")?;
        }
        "network.fetch" => {
            if permission.schemes.is_empty()
                || permission.hosts.is_empty()
                || permission.methods.is_empty()
                || !permission.paths.is_empty()
                || !permission.operations.is_empty()
                || permission.max_bytes.is_some()
            {
                return Err(invalid_shape("network fetch"));
            }
            if permission.schemes.iter().any(|scheme| scheme != "https") {
                return Err(ExtensionError::ManifestValidation {
                    reason: "network.fetch permits only https".to_string(),
                });
            }
            for host in &permission.hosts {
                validate_host_pattern(host)?;
            }
            if permission
                .methods
                .iter()
                .any(|method| !matches!(method.as_str(), "GET" | "HEAD"))
            {
                return Err(ExtensionError::ManifestValidation {
                    reason: "network.fetch permits only GET or HEAD".to_string(),
                });
            }
            validate_positive_bound(permission.max_response_bytes, "maxResponseBytes")?;
        }
        _ => {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("unsupported permission request: {}", permission.name),
            });
        }
    }
    Ok(())
}

fn validate_positive_bound(value: Option<u64>, name: &str) -> Result<(), ExtensionError> {
    if !matches!(value, Some(value) if value > 0) {
        return Err(ExtensionError::ManifestValidation {
            reason: format!("{name} must be a positive integer"),
        });
    }
    Ok(())
}

fn validate_host_pattern(host: &str) -> Result<(), ExtensionError> {
    let domain = host.strip_prefix("*.").unwrap_or(host);
    if domain.is_empty()
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains('*')
        || domain.contains(':')
        || domain.contains('/')
        || !domain.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
    {
        return Err(ExtensionError::ManifestValidation {
            reason: format!("invalid network host constraint: {host}"),
        });
    }
    Ok(())
}

/// Deserialize a stored major that is accepted as either an integer or a
/// `"N"` string, but reject zero and negative values.
fn deserialize_contract_major<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Visitor;

    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a positive integer contract major")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            if value == 0 {
                Err(E::custom("contract major must be positive"))
            } else {
                Ok(value)
            }
        }

        fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            if value <= 0 {
                Err(E::custom("contract major must be positive"))
            } else {
                Ok(value as u64)
            }
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            value
                .parse::<u64>()
                .map_err(|_| E::custom("contract major must be a positive integer"))
                .and_then(|parsed| {
                    if parsed == 0 {
                        Err(E::custom("contract major must be positive"))
                    } else {
                        Ok(parsed)
                    }
                })
        }
    }

    deserializer.deserialize_any(Visitor)
}

fn validate_relative_entry(entry: &str) -> Result<(), ExtensionError> {
    validate_relative_paths(std::iter::once(entry))
}

fn validate_relative_paths<'a>(
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<(), ExtensionError> {
    for path in paths {
        if path.is_empty() {
            return Err(ExtensionError::ManifestValidation {
                reason: "path must not be empty".to_string(),
            });
        }
        if path.len() > MAX_RELATIVE_PATH_BYTES {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("path exceeds {} bytes", MAX_RELATIVE_PATH_BYTES),
            });
        }
        if path.starts_with('/') || path.starts_with('\\') {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("absolute path is not allowed: {path}"),
            });
        }
        if path.contains('\\') {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("alternate path separators are not allowed: {path}"),
            });
        }
        for component in path.split(['/', '\\']) {
            match component {
                "" | "." => {
                    return Err(ExtensionError::ManifestValidation {
                        reason: format!("path must already be normalized: {path}"),
                    });
                }
                ".." => {
                    return Err(ExtensionError::ManifestValidation {
                        reason: format!("parent traversal is not allowed: {path}"),
                    });
                }
                component if component.contains(':') => {
                    return Err(ExtensionError::ManifestValidation {
                        reason: format!("device/colon component is not allowed: {path}"),
                    });
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_manifest_json() -> String {
        r#"{
            "schemaVersion": 1,
            "id": "org.example.rho-bioconductor",
            "name": "Rho Bioconductor",
            "version": "0.1.0",
            "apiVersion": "^1.0",
            "runtime": { "kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project" },
            "provides": [ { "capability": "tool.bio.enrichment", "contract_major": 1 } ]
        }"#
        .to_string()
    }

    #[test]
    fn parses_minimal_manifest() {
        let manifest = WorkspacePluginManifest::parse(minimal_manifest_json().as_bytes()).unwrap();
        assert_eq!(manifest.id.as_str(), "org.example.rho-bioconductor");
        assert_eq!(manifest.runtime.kind, RuntimeKind::Wasm);
        assert_eq!(manifest.provides.len(), 1);
    }

    #[test]
    fn rejects_unknown_security_field() {
        let json = r#"{
            "schemaVersion": 1,
            "id": "org.example.x",
            "name": "X",
            "version": "0.1.0",
            "apiVersion": "^1.0",
            "runtime": { "kind": "wasm", "entry": "a.wasm", "scope": "project" },
            "injectNativeScript": true
        }"#;
        // `injectNativeScript` is unknown, so serde must fail closed.
        assert!(WorkspacePluginManifest::parse(json.as_bytes()).is_err());
    }

    #[test]
    fn rejects_unknown_nested_security_fields() {
        let runtime = minimal_manifest_json().replace(
            "\"scope\": \"project\"",
            "\"scope\": \"project\", \"inheritEnvironment\": true",
        );
        assert!(WorkspacePluginManifest::parse(runtime.as_bytes()).is_err());

        let permission = minimal_manifest_json().replace(
            "\"provides\":",
            r#""permissions": [{
                "name": "network.fetch",
                "schemes": ["https"],
                "hosts": ["example.org"],
                "methods": ["GET"],
                "maxResponseBytes": 1024,
                "allowCredentials": true
            }],
            "provides":"#,
        );
        assert!(WorkspacePluginManifest::parse(permission.as_bytes()).is_err());
    }

    #[test]
    fn rejects_parent_traversal_entry() {
        let json = minimal_manifest_json().replace("dist/plugin.wasm", "../etc/passwd");
        assert!(WorkspacePluginManifest::parse(json.as_bytes()).is_err());
    }

    #[test]
    fn rejects_alternate_or_non_normalized_entry() {
        let alternate = minimal_manifest_json().replace("dist/plugin.wasm", "dist\\\\plugin.wasm");
        assert!(WorkspacePluginManifest::parse(alternate.as_bytes()).is_err());

        let repeated = minimal_manifest_json().replace("dist/plugin.wasm", "dist//plugin.wasm");
        assert!(WorkspacePluginManifest::parse(repeated.as_bytes()).is_err());
    }

    #[test]
    fn rejects_absolute_entry() {
        let json = minimal_manifest_json().replace("dist/plugin.wasm", "/etc/passwd");
        assert!(WorkspacePluginManifest::parse(json.as_bytes()).is_err());
    }

    #[test]
    fn rejects_zero_contract_major() {
        let json =
            minimal_manifest_json().replace("\"contract_major\": 1", "\"contract_major\": 0");
        assert!(WorkspacePluginManifest::parse(json.as_bytes()).is_err());
    }

    #[test]
    fn rejects_unsupported_schema() {
        let json = minimal_manifest_json().replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        assert!(WorkspacePluginManifest::parse(json.as_bytes()).is_err());
    }

    #[test]
    fn rejects_unsupported_runtime_kind() {
        let json = minimal_manifest_json().replace("\"kind\": \"wasm\"", "\"kind\": \"node\"");
        assert!(WorkspacePluginManifest::parse(json.as_bytes()).is_err());
    }

    #[test]
    fn rejects_non_project_scope_and_invalid_api_requirement() {
        let scope =
            minimal_manifest_json().replace("\"scope\": \"project\"", "\"scope\": \"application\"");
        assert!(WorkspacePluginManifest::parse(scope.as_bytes()).is_err());

        let api = minimal_manifest_json()
            .replace("\"apiVersion\": \"^1.0\"", "\"apiVersion\": \"not semver\"");
        assert!(WorkspacePluginManifest::parse(api.as_bytes()).is_err());
    }

    #[test]
    fn validates_permission_name_shape_and_bounds() {
        let valid = minimal_manifest_json().replace(
            "\"provides\":",
            r#""permissions": [{
                "name": "network.fetch",
                "schemes": ["https"],
                "hosts": ["example.org", "*.example.org"],
                "methods": ["GET"],
                "maxResponseBytes": 1024
            }],
            "provides":"#,
        );
        assert!(WorkspacePluginManifest::parse(valid.as_bytes()).is_ok());

        let unsupported = valid.replace("network.fetch", "process.spawn");
        assert!(WorkspacePluginManifest::parse(unsupported.as_bytes()).is_err());

        let missing_bound = valid.replace(",\n                \"maxResponseBytes\": 1024", "");
        assert!(WorkspacePluginManifest::parse(missing_bound.as_bytes()).is_err());
    }
}
