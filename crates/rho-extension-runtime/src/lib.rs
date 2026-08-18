//! Pure contracts for Rho's compiled-in, first-party extension runtime.
//!
//! P1-0 intentionally contains no activation, effects, broker integration,
//! persistence, dynamic discovery, or user-visible runtime behavior.

#![forbid(unsafe_code)]

mod error;
mod id;
mod model;
mod resolver;

pub use error::{
    DescriptorErrorReason, DiagnosticCode, DiagnosticSeverity, ExtensionDiagnostic, ExtensionError,
    IdentifierCharacterClass, IdentifierErrorReason, IdentifierKind, InvalidParentContext,
    InvalidParentReason, InvalidScopePolicyReason, InvalidScopeReason, LimitKind,
};
pub use id::{ActivationGeneration, CapabilityId, OperationId, PluginId, ScopeId, ScopeKindId};
pub use model::{
    ActivationPlan, ActivationPolicy, BindingResolution, CapabilityContractMajor,
    CapabilityDeclaration, CapabilityRequirement, PluginDescriptor, PluginVersion,
    ProviderIdentity, RequirementBinding, RequirementKind, ScopeIdentity, ScopeKindRule,
    ScopePolicy,
};
pub use resolver::resolve_activation_plan;

pub const MAX_IDENTIFIER_BYTES: usize = 128;
pub const MAX_PLUGINS_PER_SCOPE: usize = 256;
pub const MAX_PROVIDES_PER_PLUGIN: usize = 64;
pub const MAX_REQUIRED_PER_PLUGIN: usize = 64;
pub const MAX_OPTIONAL_PER_PLUGIN: usize = 64;
pub const MAX_RESOLVED_EDGES: usize = 8192;
