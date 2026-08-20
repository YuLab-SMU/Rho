//! Rho's compiled-in, first-party internal extension runtime.
//!
//! Phase 1 includes deterministic contracts, scoped activation, reversible
//! effects, and bounded host broker integration. It intentionally excludes
//! persistence, dynamic discovery, third-party loading, and a public SDK.
//!
//! Phase 2 (P2-0) adds disabled workspace-plugin discovery: manifest
//! validation, canonical package digests, and fail-closed, symlink-safe
//! enumeration. Discovery still executes no code and grants no authority.

#![forbid(unsafe_code)]

mod broker;
mod builder;
mod contribution;
mod contribution_call;
mod digest;
mod discovery;
mod error;
mod evaluation;
mod evolution;
mod gardener;
mod grant;
mod host;
mod id;
mod instance;
mod json_schema;
mod lifecycle;
mod manifest;
mod model;
mod observation;
mod resolver;
mod wasm_host;

pub use broker::{
    BoundedJson, BrokerError, BrokerFacade, BrokerPayloadError, BrokerRequest, BrokerResponse,
    BrokerResponseClass, DEFAULT_BROKER_PAYLOAD_BYTES, PROJECT_FILE_VIEWER_HTML_BYTES,
    RejectingBrokerFacade, WORKSPACE_SNAPSHOT_RESPONSE_BYTES,
};
pub use builder::{
    BuildProvenance, BuilderError, CandidateProfile, StagedCandidate, StagingLedger,
    StaticValidation, candidate_within_envelope,
};
pub use contribution::{
    Contribution, ContributionCandidate, ContributionDeclaration, ContributionError,
    ContributionInstanceIdentity, ContributionKind, ContributionRecord, ContributionStore,
    MAX_CONTRIBUTION_LABEL_BYTES, MAX_CONTRIBUTION_MEDIA_TYPE_BYTES, MAX_CONTRIBUTION_MEDIA_TYPES,
    MAX_CONTRIBUTION_PURPOSE_BYTES, MAX_CONTRIBUTIONS_PER_PACKAGE, MAX_CONTRIBUTIONS_PER_PROJECT,
    PLUGIN_DETAILS_PANEL_SLOT,
};
pub use contribution_call::{
    CONTRIBUTION_CALL_DEADLINE_MILLIS, ContributionCallError, ContributionCallErrorCode,
    ContributionCallOutcome, ContributionCallProvenance, ContributionCallRequest,
    ContributionCallSession, ContributionClock, ContributionInvocationOrigin,
    MAX_CONTRIBUTION_CALL_BYTES, MAX_CONTRIBUTION_CALL_HANDLES, MAX_VIEWER_DOCUMENT_BYTES,
    SystemContributionClock,
};
pub use digest::PackageDigest;
pub use discovery::{
    DiscoveredPlugin, DiscoveryFailure, DiscoveryReport, MANIFEST_NAME, PLUGINS_DIR,
    discover_workspace_plugins,
};
pub use error::{
    DescriptorErrorReason, DiagnosticCode, DiagnosticSeverity, ExtensionDiagnostic, ExtensionError,
    IdentifierCharacterClass, IdentifierErrorReason, IdentifierKind, InvalidParentContext,
    InvalidParentReason, InvalidScopePolicyReason, InvalidScopeReason, LimitKind,
};
pub use evaluation::{
    CaseResult, EvaluationDecision, EvaluationError, EvaluationEvidence, EvaluationPlan,
    LayerResult, ManualPromotion, SealedEvaluationPlan,
};
pub use evolution::{
    AutonomyLevel, DEFAULT_LINEAGE_AUTONOMY, EvolutionEnvelopes, FailureClass, GardenAction,
    LineageState, LineageVersion, PluginLineage, PolicyMatch, ProvenanceRef, StandingPolicy,
    VersionState, validate_candidate_against_policy,
};
pub use gardener::{
    GardenerProposal, ImprovementEntry, RegressionProposal, RepairCandidate,
    accepted_digest_is_preserved, autonomous_activation_allowed, merge_must_not_widen_permissions,
    repair_eligibility, repair_parent_must_match,
};
pub use grant::{
    CapabilityHandle, GrantClock, GrantErrorKind, GrantRequest, GrantSource, GrantStore,
    GrantTokenSource, MAX_ALLOW_ONCE_TTL, MAX_PROJECT_GRANT_TTL, OsGrantTokenSource,
    PermissionConstraints, PermissionKind, PermissionUse, PluginGrant, Revalidation,
    RevalidationRequest, SystemGrantClock, WorkspaceGrantIdentity,
};
pub use host::{
    DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_HEARTBEAT_TIMEOUT, HOST_PROTOCOL_VERSION,
    HeartbeatSupervisor, HostFrame, HostInstanceId, HostInstanceState, HostMessage,
    HostProtocolError, HostProtocolErrorCode, HostRequestId, HostResponse, MAX_ECHO_PAYLOAD_BYTES,
    MAX_HOST_FRAME_BYTES, SyntheticEchoHost, encode_host_frame,
};
pub use id::{ActivationGeneration, CapabilityId, OperationId, PluginId, ScopeId, ScopeKindId};
pub use instance::{
    AuditEvent, AuditLog, DiscoveryOutcome, MAX_AUDIT_EVENTS, MAX_AUDIT_REASON_BYTES,
    PluginInstance, PluginLifecycleState, PluginManager, PluginManagerError, allowed_transition,
};
pub use json_schema::{
    BoundedJsonSchema, JsonSchemaError, MAX_CONTRIBUTION_SCHEMA_BYTES,
    MAX_CONTRIBUTION_SCHEMA_DEPTH, MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES,
    MAX_CONTRIBUTION_SCHEMA_PROPERTIES,
};
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
pub use manifest::{
    MANIFEST_SCHEMA_VERSION, MAX_MANIFEST_BYTES, MAX_MANIFEST_OPTIONAL, MAX_MANIFEST_PERMISSIONS,
    MAX_MANIFEST_PROVIDES, MAX_MANIFEST_REQUIRES, MAX_PACKAGE_AGGREGATE_BYTES, MAX_PACKAGE_DEPTH,
    MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_FILES, MAX_PERMISSION_BYTES,
    MAX_PERMISSION_CONSTRAINT_ITEMS, MAX_PERMISSION_PURPOSE_BYTES, MAX_RELATIVE_PATH_BYTES,
    MIN_MANIFEST_SCHEMA_VERSION, ManifestProvide, ManifestRequire, PermissionRequest,
    RuntimeDeclaration, RuntimeKind, UiDeclaration, WorkspacePluginManifest,
};
pub use model::{
    ActivationPlan, ActivationPolicy, BindingResolution, CapabilityContractMajor,
    CapabilityDeclaration, CapabilityRequirement, PluginDescriptor, PluginVersion,
    ProviderIdentity, RequirementBinding, RequirementKind, ScopeIdentity, ScopeKindRule,
    ScopePolicy,
};
pub use observation::{
    ExperienceTraceRef, MAX_OBSERVATION_TEXT_BYTES, MAX_PATTERN_FEATURES, MAX_RECIPE_STEPS,
    MAX_SKILL_INSTRUCTION_BYTES, MAX_TRACE_REFERENCES, ObservationError, ObservationModel,
    OutcomeClass, PatternObservation, Recipe, RedactionProfile, SkillSuggestion,
    self_grant_attempt_rejected,
};
pub use resolver::resolve_activation_plan;
pub use wasm_host::{
    BrokerCallIdSource, DEFAULT_WASM_FUEL, GUEST_ABI_V1, GUEST_ABI_V2, GuestStep,
    MAX_GUEST_BROKER_RESULT_BYTES, MAX_GUEST_BROKER_RESUME_BYTES, MAX_GUEST_BROKER_STEPS,
    MAX_GUEST_CONTRIBUTION_ENVELOPE_BYTES, MAX_GUEST_CONTRIBUTION_RETURN_BYTES,
    MAX_GUEST_STEP_BYTES, MAX_PENDING_WASM_CANCELLATIONS, MAX_WASM_MEMORY_BYTES,
    MAX_WASM_MODULE_BYTES, MAX_WASM_TABLE_ELEMENTS, OsBrokerCallIdSource, P2_1_SMOKE_WASM,
    P2_1_WASI_IMPORT_SMOKE_WASM, P2_2_SMOKE_WASM, WasmCancellationHandle, WasmHostIdentity,
    WasmPluginHost,
};

pub const MAX_IDENTIFIER_BYTES: usize = 128;
pub const MAX_PLUGINS_PER_SCOPE: usize = 256;
pub const MAX_PROVIDES_PER_PLUGIN: usize = 64;
pub const MAX_REQUIRED_PER_PLUGIN: usize = 64;
pub const MAX_OPTIONAL_PER_PLUGIN: usize = 64;
pub const MAX_RESOLVED_EDGES: usize = 8192;
