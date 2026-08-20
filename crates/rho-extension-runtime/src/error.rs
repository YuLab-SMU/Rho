use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{ActivationGeneration, CapabilityId, PluginId, ProviderIdentity, ScopeId, ScopeKindId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentifierKind {
    Plugin,
    Capability,
    Operation,
    ScopeKind,
    Scope,
}

impl fmt::Display for IdentifierKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Plugin => "plugin",
            Self::Capability => "capability",
            Self::Operation => "operation",
            Self::ScopeKind => "scope_kind",
            Self::Scope => "scope",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentifierCharacterClass {
    NonAscii,
    PathSeparator,
    Whitespace,
    Control,
    Uppercase,
    OtherAscii,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum IdentifierErrorReason {
    Empty,
    TooLong {
        actual_bytes: usize,
        max_bytes: usize,
    },
    InvalidCharacter {
        byte_index: usize,
        class: IdentifierCharacterClass,
    },
}

impl fmt::Display for IdentifierErrorReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("empty"),
            Self::TooLong {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "too_long({actual_bytes}_bytes,max_{max_bytes}_bytes)"
            ),
            Self::InvalidCharacter { byte_index, class } => {
                write!(formatter, "invalid_character({class:?},byte_{byte_index})")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum DescriptorErrorReason {
    NoAllowedScopes,
    DuplicateAllowedScope { scope_kind: ScopeKindId },
    DuplicateProvidedCapability { capability_id: CapabilityId },
    DuplicateRequiredCapability { capability_id: CapabilityId },
    DuplicateOptionalCapability { capability_id: CapabilityId },
    RequiredAndOptionalCapability { capability_id: CapabilityId },
    ScopeNotAllowed { scope_kind: ScopeKindId },
}

impl fmt::Display for DescriptorErrorReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoAllowedScopes => formatter.write_str("no_allowed_scopes"),
            Self::DuplicateAllowedScope { scope_kind } => {
                write!(formatter, "duplicate_allowed_scope({scope_kind})")
            }
            Self::DuplicateProvidedCapability { capability_id } => {
                write!(formatter, "duplicate_provided_capability({capability_id})")
            }
            Self::DuplicateRequiredCapability { capability_id } => {
                write!(formatter, "duplicate_required_capability({capability_id})")
            }
            Self::DuplicateOptionalCapability { capability_id } => {
                write!(formatter, "duplicate_optional_capability({capability_id})")
            }
            Self::RequiredAndOptionalCapability { capability_id } => {
                write!(
                    formatter,
                    "required_and_optional_capability({capability_id})"
                )
            }
            Self::ScopeNotAllowed { scope_kind } => {
                write!(formatter, "scope_not_allowed({scope_kind})")
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitKind {
    PluginsPerScope,
    ProvidesPerPlugin,
    RequiredPerPlugin,
    OptionalPerPlugin,
    ResolvedEdges,
}

impl fmt::Display for LimitKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PluginsPerScope => "plugins_per_scope",
            Self::ProvidesPerPlugin => "provides_per_plugin",
            Self::RequiredPerPlugin => "required_per_plugin",
            Self::OptionalPerPlugin => "optional_per_plugin",
            Self::ResolvedEdges => "resolved_edges",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidScopeReason {
    UnknownKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidParentReason {
    MissingParent,
    UnexpectedParent,
    ParentIdentityMissing,
    ParentIdMismatch,
    ParentKindMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidScopePolicyReason {
    DuplicateKind,
    MissingParentKind,
    ParentCycle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvalidParentContext {
    pub scope_id: ScopeId,
    pub scope_kind: ScopeKindId,
    pub parent_scope_id: Option<ScopeId>,
    pub parent_scope_kind: Option<ScopeKindId>,
    pub expected_parent_kind: Option<ScopeKindId>,
}

impl fmt::Display for InvalidParentContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.scope_id, self.scope_kind)
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum ExtensionError {
    #[error("invalid {kind} identifier: {reason}")]
    InvalidIdentifier {
        kind: IdentifierKind,
        reason: IdentifierErrorReason,
    },
    #[error("activation generation must be non-zero")]
    ZeroActivationGeneration,
    #[error("activation generation space is exhausted")]
    ActivationGenerationExhausted,
    #[error("invalid semantic plugin version")]
    InvalidPluginVersion,
    #[error("invalid descriptor for plugin {plugin_id}: {reason}")]
    InvalidDescriptor {
        plugin_id: PluginId,
        reason: DescriptorErrorReason,
    },
    #[error("{limit} limit exceeded: {actual} > {maximum}")]
    LimitExceeded {
        limit: LimitKind,
        plugin_id: Option<PluginId>,
        actual: usize,
        maximum: usize,
    },
    #[error("duplicate plugin {plugin_id}")]
    DuplicatePlugin { plugin_id: PluginId },
    #[error("duplicate provider for capability {capability_id}")]
    DuplicateProvider {
        capability_id: CapabilityId,
        providers: Vec<ProviderIdentity>,
    },
    #[error("plugin {plugin_id} requires missing capability {capability_id}@{required_major}")]
    MissingRequiredCapability {
        plugin_id: PluginId,
        capability_id: CapabilityId,
        required_major: u64,
    },
    #[error(
        "plugin {plugin_id} requires capability {capability_id}@{required_major}, but provider {provider_plugin_id} declares @{provided_major}"
    )]
    IncompatibleCapabilityMajor {
        plugin_id: PluginId,
        capability_id: CapabilityId,
        required_major: u64,
        provided_major: u64,
        provider_plugin_id: PluginId,
    },
    #[error("invalid scope {scope_id} ({scope_kind:?}): {reason:?}")]
    InvalidScope {
        scope_id: ScopeId,
        scope_kind: ScopeKindId,
        reason: InvalidScopeReason,
    },
    #[error("invalid parent for scope {context}: {reason:?}")]
    InvalidParent {
        context: Box<InvalidParentContext>,
        reason: InvalidParentReason,
    },
    #[error("invalid host scope policy for {scope_kind}: {reason:?}")]
    InvalidScopePolicy {
        scope_kind: ScopeKindId,
        reason: InvalidScopePolicyReason,
    },
    #[error("dependency cycle: {path:?}")]
    DependencyCycle { path: Vec<PluginId> },
    #[error("manifest exceeds {maximum_bytes} bytes: {actual_bytes}")]
    ManifestTooLarge {
        actual_bytes: usize,
        maximum_bytes: usize,
    },
    #[error("manifest parse failed: {message}")]
    ManifestParse { message: String },
    #[error("manifest validation failed: {reason}")]
    ManifestValidation { reason: String },
    #[error("unsupported manifest schema {actual}; supported {supported}")]
    UnsupportedManifestSchema { actual: u64, supported: u64 },
    #[error("unsupported runtime kind {runtime_kind}")]
    UnsupportedRuntimeKind { runtime_kind: String },
    #[error("workspace plugin discovery failed: {reason}")]
    DiscoveryFailure { reason: String },
    #[error("package file tree is invalid: {reason}")]
    InvalidPackageTree { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Error,
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCode {
    InvalidIdentifier,
    ZeroActivationGeneration,
    ActivationGenerationExhausted,
    InvalidPluginVersion,
    InvalidDescriptor,
    LimitExceeded,
    DuplicatePlugin,
    DuplicateProvider,
    MissingRequiredCapability,
    IncompatibleCapabilityMajor,
    InvalidScope,
    InvalidParent,
    InvalidScopePolicy,
    DependencyCycle,
    OptionalCapabilityAbsent,
    ManifestInvalid,
    ManifestUnsupportedSchema,
    UnsupportedRuntimeKind,
    WorkspaceDiscoveryFailed,
    InvalidPackageTree,
    InvalidRuntimeMode,
    ActivationStarted,
    ActivationSucceeded,
    ActivationFailed,
    ActivationRollbackFailed,
    CandidatePublished,
    CandidateCasRejected,
    QuiesceStarted,
    QuiesceTimeout,
    EffectDisposeFailed,
    ScopeDisposed,
    ScopeDisposeFailed,
    ContributionFallback,
    SourceCallFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtensionDiagnostic {
    pub code: DiagnosticCode,
    pub severity: DiagnosticSeverity,
    pub plugin_id: Option<PluginId>,
    pub capability_id: Option<CapabilityId>,
    pub scope_kind: Option<ScopeKindId>,
    pub scope_id: Option<ScopeId>,
    pub activation_generation: Option<ActivationGeneration>,
    pub effect_order: Option<u64>,
    pub related_plugins: Vec<PluginId>,
    pub cycle_path: Vec<PluginId>,
    pub message: String,
}

impl ExtensionDiagnostic {
    pub fn from_error(error: &ExtensionError) -> Self {
        let mut diagnostic = Self {
            code: error.diagnostic_code(),
            severity: DiagnosticSeverity::Error,
            plugin_id: None,
            capability_id: None,
            scope_kind: None,
            scope_id: None,
            activation_generation: None,
            effect_order: None,
            related_plugins: Vec::new(),
            cycle_path: Vec::new(),
            message: error.to_string(),
        };

        match error {
            ExtensionError::InvalidDescriptor { plugin_id, .. }
            | ExtensionError::DuplicatePlugin { plugin_id } => {
                diagnostic.plugin_id = Some(plugin_id.clone());
            }
            ExtensionError::LimitExceeded { plugin_id, .. } => {
                diagnostic.plugin_id.clone_from(plugin_id);
            }
            ExtensionError::DuplicateProvider {
                capability_id,
                providers,
            } => {
                diagnostic.capability_id = Some(capability_id.clone());
                diagnostic.related_plugins = providers
                    .iter()
                    .map(|item| item.plugin_id.clone())
                    .collect();
            }
            ExtensionError::MissingRequiredCapability {
                plugin_id,
                capability_id,
                ..
            }
            | ExtensionError::IncompatibleCapabilityMajor {
                plugin_id,
                capability_id,
                ..
            } => {
                diagnostic.plugin_id = Some(plugin_id.clone());
                diagnostic.capability_id = Some(capability_id.clone());
            }
            ExtensionError::InvalidScope {
                scope_id,
                scope_kind,
                ..
            } => {
                diagnostic.scope_kind = Some(scope_kind.clone());
                diagnostic.scope_id = Some(scope_id.clone());
            }
            ExtensionError::InvalidParent { context, .. } => {
                diagnostic.scope_kind = Some(context.scope_kind.clone());
                diagnostic.scope_id = Some(context.scope_id.clone());
            }
            ExtensionError::DependencyCycle { path } => {
                diagnostic.plugin_id = path.first().cloned();
                diagnostic.related_plugins = path.clone();
                diagnostic.related_plugins.sort();
                diagnostic.related_plugins.dedup();
                diagnostic.cycle_path = path.clone();
            }
            ExtensionError::InvalidScopePolicy { scope_kind, .. } => {
                diagnostic.scope_kind = Some(scope_kind.clone());
            }
            ExtensionError::InvalidIdentifier { .. }
            | ExtensionError::ZeroActivationGeneration
            | ExtensionError::ActivationGenerationExhausted
            | ExtensionError::InvalidPluginVersion
            | ExtensionError::ManifestTooLarge { .. }
            | ExtensionError::ManifestParse { .. }
            | ExtensionError::ManifestValidation { .. }
            | ExtensionError::UnsupportedManifestSchema { .. }
            | ExtensionError::UnsupportedRuntimeKind { .. }
            | ExtensionError::DiscoveryFailure { .. }
            | ExtensionError::InvalidPackageTree { .. } => {}
        }

        diagnostic.related_plugins.sort();
        diagnostic.related_plugins.dedup();
        diagnostic
    }

    pub(crate) fn optional_absent(
        plugin_id: PluginId,
        capability_id: CapabilityId,
        scope_id: ScopeId,
    ) -> Self {
        Self {
            code: DiagnosticCode::OptionalCapabilityAbsent,
            severity: DiagnosticSeverity::Warning,
            message: format!(
                "optional capability {capability_id} is absent for plugin {plugin_id}"
            ),
            plugin_id: Some(plugin_id),
            capability_id: Some(capability_id),
            scope_kind: None,
            scope_id: Some(scope_id),
            activation_generation: None,
            effect_order: None,
            related_plugins: Vec::new(),
            cycle_path: Vec::new(),
        }
    }
}

impl ExtensionError {
    pub fn diagnostic_code(&self) -> DiagnosticCode {
        match self {
            Self::InvalidIdentifier { .. } => DiagnosticCode::InvalidIdentifier,
            Self::ZeroActivationGeneration => DiagnosticCode::ZeroActivationGeneration,
            Self::ActivationGenerationExhausted => DiagnosticCode::ActivationGenerationExhausted,
            Self::InvalidPluginVersion => DiagnosticCode::InvalidPluginVersion,
            Self::InvalidDescriptor { .. } => DiagnosticCode::InvalidDescriptor,
            Self::LimitExceeded { .. } => DiagnosticCode::LimitExceeded,
            Self::DuplicatePlugin { .. } => DiagnosticCode::DuplicatePlugin,
            Self::DuplicateProvider { .. } => DiagnosticCode::DuplicateProvider,
            Self::MissingRequiredCapability { .. } => DiagnosticCode::MissingRequiredCapability,
            Self::IncompatibleCapabilityMajor { .. } => DiagnosticCode::IncompatibleCapabilityMajor,
            Self::InvalidScope { .. } => DiagnosticCode::InvalidScope,
            Self::InvalidParent { .. } => DiagnosticCode::InvalidParent,
            ExtensionError::InvalidScopePolicy { .. } => DiagnosticCode::InvalidScopePolicy,
            ExtensionError::DependencyCycle { .. } => DiagnosticCode::DependencyCycle,
            ExtensionError::ManifestTooLarge { .. }
            | ExtensionError::ManifestParse { .. }
            | ExtensionError::ManifestValidation { .. } => DiagnosticCode::ManifestInvalid,
            ExtensionError::UnsupportedManifestSchema { .. } => {
                DiagnosticCode::ManifestUnsupportedSchema
            }
            ExtensionError::UnsupportedRuntimeKind { .. } => DiagnosticCode::UnsupportedRuntimeKind,
            ExtensionError::DiscoveryFailure { .. } => DiagnosticCode::WorkspaceDiscoveryFailed,
            ExtensionError::InvalidPackageTree { .. } => DiagnosticCode::InvalidPackageTree,
        }
    }

    pub fn to_diagnostic(&self) -> ExtensionDiagnostic {
        ExtensionDiagnostic::from_error(self)
    }
}
