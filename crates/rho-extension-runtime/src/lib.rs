//! Pure contracts for Rho's compiled-in, first-party extension runtime.
//!
//! P1-0 intentionally contains no activation, effects, broker integration,
//! persistence, dynamic discovery, or user-visible runtime behavior.

#![forbid(unsafe_code)]

mod broker;
mod error;
mod id;
mod lifecycle;
mod model;
mod resolver;

pub use broker::{
    BoundedJson, BrokerError, BrokerFacade, BrokerPayloadError, BrokerRequest, BrokerResponse,
    BrokerResponseClass, DEFAULT_BROKER_PAYLOAD_BYTES, PROJECT_FILE_VIEWER_HTML_BYTES,
    RejectingBrokerFacade, WORKSPACE_SNAPSHOT_RESPONSE_BYTES,
};
pub use error::{
    DescriptorErrorReason, DiagnosticCode, DiagnosticSeverity, ExtensionDiagnostic, ExtensionError,
    IdentifierCharacterClass, IdentifierErrorReason, IdentifierKind, InvalidParentContext,
    InvalidParentReason, InvalidScopePolicyReason, InvalidScopeReason, LimitKind,
};
pub use id::{ActivationGeneration, CapabilityId, OperationId, PluginId, ScopeId, ScopeKindId};
pub use lifecycle::{
    ActivationError, CandidateBuildError, CandidatePublishError, CollectingDiagnosticSink,
    DiagnosticSink, Disposable, DisposeError, DisposeOutcome, EffectDisposeReport, EffectRecord,
    EffectSink, EffectStatus, ExtensionHost, ExtensionHostError, InternalExtensionRuntimeMode,
    InternalPlugin, LifecycleDeadlines, NoopDiagnosticSink, PluginContext, PluginInstanceIdentity,
    ProjectFileViewerContribution, ProjectFileViewerResolution, ProjectFileViewerResolveError,
    ProjectTreePublishError, ProjectTreePublishReport, PublishReport, RegistryError, RegistryHub,
    RegistryLease, RoutingError, ScopeDisposeReport, ScopeLifecycleState, ScopeManager, ScopeSlot,
    ScopeSnapshot, ScopeStateError, ScopedTaskTracker, SourceCallError, SourceCallResult,
    SourceHandler, StaleGenerationContext, StaleGenerationError, TaskAdmissionError,
    WorkspaceToolCallError, WorkspaceToolCallResult, WorkspaceToolHandler, build_scope_candidate,
};
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
