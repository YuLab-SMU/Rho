//! Environment realization semantics and provider request boundaries.
//!
//! This crate normalizes observations and plans. It deliberately owns no
//! approval, process spawning, secret materialization, Store connection,
//! Workspace restart or remote transport.

#![forbid(unsafe_code)]

mod core_pack;
mod local;
mod materialize;
mod plan;
mod provider;
mod remote;

pub use core_pack::{
    CoreSupportPackActivationV1, CoreSupportPackError, CoreSupportPackManifestV1,
    CoreSupportPackStore, CoreSupportPackageV1,
};
pub use local::{
    LocalPackageInventory, RigInstallationObservation, RuntimeProbeDifference,
    RuntimeProbeObservation, UserSessionObservation, build_library_stack, build_package_inventory,
    compare_runtime_probes, parse_rig_inventory, select_exact_rig_installation,
};
pub use materialize::{
    PackageArtifactResolutionV1, PackageMaterializationRequest, SystemRequirementResolutionV1,
    materialize_package_plan,
};
pub use plan::{
    EnvironmentPlanInput, ProjectEnvironmentMode, classify_project_environment,
    normalize_materialized_plan,
};
pub use provider::{
    EnvironmentProviderError, EnvironmentVerification, EnvironmentVerifier, PackagePlanProvider,
    PackageResolution, RuntimeCandidate, RuntimeProvider,
};
pub use remote::{
    CondaObservation, ImmutableImageRebuildPlanV1, LmodObservation, MAX_CONDA_EXPLICIT_SPEC_BYTES,
    MAX_REMOTE_PROFILE_ENVIRONMENT_ITEMS, RemoteExecutionFingerprint,
    RemoteExecutionProfileRequest, RemoteFingerprintDifference, RemoteFingerprintPhase,
    RemoteProfileCommand, compare_remote_fingerprints, conda_run_command,
    materialize_apptainer_rebuild, remote_profile_boundary, resolve_execution_profile,
};

pub fn boundary() -> &'static str {
    "rho-environment owns semantics and provider requests; it does_not_own approval, execution, persistence, secrets, or Workspace mutation"
}
