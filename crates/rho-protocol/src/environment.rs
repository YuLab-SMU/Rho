//! Canonical Environment Realization contracts.
//!
//! This module describes desired and realized state. It owns no discovery,
//! approval, process execution, filesystem mutation, network access, secret
//! materialization or Workspace restart authority.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    AuthorityDigest, EnvironmentDesiredRevisionId, EnvironmentId, EnvironmentPlanId,
    EnvironmentRealizationRevisionId, EnvironmentReceiptId, ExecutionId, ExecutionProfileId,
    LibraryLayerId, OperationId, ProjectId, RepositoryProfileId, ResourceRequest,
    RuntimeRealizationId,
};

pub const ENVIRONMENT_CONTRACT_VERSION: u16 = 1;
pub const MAX_ENVIRONMENT_TEXT_BYTES: usize = 4 * 1024;
pub const MAX_ENVIRONMENT_ITEMS: usize = 2_000;
pub const MAX_ENVIRONMENT_CONTRACT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ENVIRONMENT_JSON_DEPTH: usize = 24;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EnvironmentContractError {
    #[error("{field} must not be empty")]
    Empty { field: &'static str },
    #[error("{field} exceeds {limit} bytes")]
    TooLarge { field: &'static str, limit: usize },
    #[error("{field} contains invalid text")]
    InvalidText { field: &'static str },
    #[error("{field} contains duplicate identity {value}")]
    Duplicate { field: &'static str, value: String },
    #[error("{field} is not in canonical order")]
    NonCanonicalOrder { field: &'static str },
    #[error("environment contract invariant failed: {0}")]
    Invariant(String),
    #[error("environment plan identity mismatch")]
    PlanIdentityMismatch,
    #[error("environment contract JSON failed: {0}")]
    Json(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDistributionV1 {
    R,
    Python,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOwnershipV1 {
    System,
    UserSelected,
    Rig,
    Conda,
    Module,
    ImmutableImage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSupportTierV1 {
    Verified,
    Compatible,
    ObservedOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentRoleV1 {
    Core,
    Project,
    NativeUser,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LibraryLayerKindV1 {
    RhoCoreSupport,
    ProjectRenv,
    User,
    Site,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LibraryOwnerV1 {
    Rho,
    Project,
    User,
    SiteAdministrator,
    RDistribution,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum LibraryMutabilityV1 {
    RhoManaged,
    UserWritable,
    ReadOnly,
    ExternallyManaged,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PackageIntentV1 {
    RestoreLocked,
    AddDependency,
    InstallUserPackage,
    InstallUnlocked,
    AdoptProjectEnvironment,
    RepairCore,
    UpdateDependency,
    RemoveDependency,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PackageActionKindV1 {
    Install,
    Update,
    Remove,
    Restore,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormV1 {
    Binary,
    Source,
    ImmutableImage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentOperationOutcomeV1 {
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
    ReconcileRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRequirementV1 {
    pub distribution: RuntimeDistributionV1,
    pub exact_version: String,
    pub platform: String,
    pub architecture: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRealizationV1 {
    pub runtime_id: RuntimeRealizationId,
    pub requirement: RuntimeRequirementV1,
    pub ownership: RuntimeOwnershipV1,
    pub support_tier: RuntimeSupportTierV1,
    pub executable: String,
    pub runtime_home: String,
    pub executable_digest: AuthorityDigest,
    pub build_fingerprint: AuthorityDigest,
    pub compiler_fingerprint: Option<AuthorityDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LibraryLayerV1 {
    pub layer_id: LibraryLayerId,
    pub kind: LibraryLayerKindV1,
    pub owner: LibraryOwnerV1,
    pub mutability: LibraryMutabilityV1,
    pub canonical_path: String,
    pub priority: u16,
    pub filesystem_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LibraryStackV1 {
    pub ordered_layers: Vec<LibraryLayerV1>,
    pub effective_digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageInstallationV1 {
    pub name: String,
    pub version: String,
    pub library_layer_id: LibraryLayerId,
    pub built_runtime_version: String,
    pub source: String,
    pub repository: Option<String>,
    pub native_code: bool,
    pub loadable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentIdentityV1 {
    pub environment_id: EnvironmentId,
    pub role: EnvironmentRoleV1,
    pub project_id: Option<ProjectId>,
    pub target_id: String,
    pub execution_profile_id: ExecutionProfileId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentDesiredRevisionV1 {
    pub revision_id: EnvironmentDesiredRevisionId,
    pub core_manifest_digest: Option<AuthorityDigest>,
    pub renv_lock_digest: Option<AuthorityDigest>,
    pub repository_profile_digest: AuthorityDigest,
    pub execution_profile_digest: AuthorityDigest,
    pub ownership_policy_digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentRealizationRevisionV1 {
    pub revision_id: EnvironmentRealizationRevisionId,
    pub runtime_id: RuntimeRealizationId,
    pub library_stack_digest: AuthorityDigest,
    pub package_inventory_digest: AuthorityDigest,
    pub native_fingerprint: AuthorityDigest,
    pub target_realization_digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpectedEnvironmentStateV1 {
    pub environment_id: EnvironmentId,
    pub desired_revision: EnvironmentDesiredRevisionId,
    pub realization_revision: EnvironmentRealizationRevisionId,
    pub project_revision: Option<u64>,
    pub repository_profile_digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryEndpointV1 {
    pub name: String,
    pub url: String,
    pub priority: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryProfileV1 {
    pub profile_id: RepositoryProfileId,
    pub repositories: Vec<RepositoryEndpointV1>,
    pub bioconductor_version: Option<String>,
    pub snapshot: Option<String>,
    pub binary_preference: String,
    pub source_fallback_policy: String,
    pub offline_policy: String,
    pub proxy_profile_ref: Option<String>,
    pub trust_bundle_ref: Option<String>,
    pub credential_refs: Vec<String>,
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionTargetKindV1 {
    Local,
    Ssh,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerKindV1 {
    Direct,
    Slurm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BaseEnvironmentPolicyV1 {
    Clean,
    MinimalAllowlist,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeDependencyOwnershipV1 {
    System,
    Conda,
    Module,
    ImmutableImage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RPackageOwnershipV1 {
    NativeUser,
    ProjectRenv,
    Conda,
    ImmutableImage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionTargetV1 {
    pub target_id: String,
    pub kind: ExecutionTargetKindV1,
    pub platform: String,
    pub architecture: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchedulerProfileV1 {
    pub kind: SchedulerKindV1,
    pub implementation: String,
    pub version: String,
    pub submit_endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModuleStackV1 {
    pub ordered_full_names: Vec<String>,
    pub lmod_version: String,
    pub environment_delta_digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CondaPrefixRefV1 {
    pub target_id: String,
    pub canonical_prefix: String,
    pub manager_kind: String,
    pub manager_version: String,
    pub explicit_spec_digest: AuthorityDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorageProfileV1 {
    pub remote_cas_locator: String,
    pub staging_locator: String,
    pub shared_library_locator: String,
    pub filesystem_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImmutableImageRefV1 {
    pub image_locator: String,
    pub image_digest: AuthorityDigest,
    pub definition_digest: AuthorityDigest,
    pub apptainer_version: String,
    pub signature_digest: Option<AuthorityDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfileV1 {
    pub contract_version: u16,
    pub profile_id: ExecutionProfileId,
    pub target: ExecutionTargetV1,
    pub scheduler: SchedulerProfileV1,
    pub base_environment_policy: BaseEnvironmentPolicyV1,
    pub module_stack: Option<ModuleStackV1>,
    pub conda_prefix: Option<CondaPrefixRefV1>,
    pub immutable_image: Option<ImmutableImageRefV1>,
    pub runtime_id: RuntimeRealizationId,
    pub runtime_ownership: RuntimeOwnershipV1,
    pub native_ownership: NativeDependencyOwnershipV1,
    pub r_package_ownership: RPackageOwnershipV1,
    pub repository_profile_id: RepositoryProfileId,
    pub repository_profile_digest: AuthorityDigest,
    pub storage: StorageProfileV1,
    pub resource_defaults: Option<ResourceRequest>,
}

impl ExecutionProfileV1 {
    pub fn validate(&self) -> Result<(), EnvironmentContractError> {
        if self.contract_version != ENVIRONMENT_CONTRACT_VERSION {
            return Err(EnvironmentContractError::Invariant(format!(
                "unsupported ExecutionProfile contract version {}",
                self.contract_version
            )));
        }
        for (field, value) in [
            ("execution_target.target_id", self.target.target_id.as_str()),
            ("execution_target.platform", self.target.platform.as_str()),
            (
                "execution_target.architecture",
                self.target.architecture.as_str(),
            ),
            (
                "scheduler.implementation",
                self.scheduler.implementation.as_str(),
            ),
            ("scheduler.version", self.scheduler.version.as_str()),
            (
                "scheduler.submit_endpoint",
                self.scheduler.submit_endpoint.as_str(),
            ),
            (
                "storage.remote_cas_locator",
                self.storage.remote_cas_locator.as_str(),
            ),
            (
                "storage.staging_locator",
                self.storage.staging_locator.as_str(),
            ),
            (
                "storage.shared_library_locator",
                self.storage.shared_library_locator.as_str(),
            ),
            (
                "storage.filesystem_identity",
                self.storage.filesystem_identity.as_str(),
            ),
        ] {
            validate_text(field, value)?;
        }
        if self.scheduler.kind == SchedulerKindV1::Slurm
            && self.base_environment_policy != BaseEnvironmentPolicyV1::Clean
        {
            return Err(EnvironmentContractError::Invariant(
                "Slurm ExecutionProfile requires a clean base environment".to_string(),
            ));
        }
        if let Some(modules) = self.module_stack.as_ref() {
            validate_text("module_stack.lmod_version", &modules.lmod_version)?;
            validate_unique(
                "module_stack.ordered_full_names",
                modules.ordered_full_names.iter().map(String::as_str),
            )?;
            if modules.ordered_full_names.iter().any(|name| {
                name.split_once('/')
                    .is_none_or(|(module, version)| module.is_empty() || version.is_empty())
            }) {
                return Err(EnvironmentContractError::Invariant(
                    "Lmod stack must use ordered fully-qualified module names".to_string(),
                ));
            }
        }
        if let Some(conda) = self.conda_prefix.as_ref() {
            for (field, value) in [
                ("conda.target_id", conda.target_id.as_str()),
                ("conda.canonical_prefix", conda.canonical_prefix.as_str()),
                ("conda.manager_kind", conda.manager_kind.as_str()),
                ("conda.manager_version", conda.manager_version.as_str()),
            ] {
                validate_text(field, value)?;
            }
            if conda.target_id != self.target.target_id
                || !conda.canonical_prefix.starts_with('/')
                || !matches!(
                    conda.manager_kind.as_str(),
                    "conda" | "mamba" | "micromamba"
                )
            {
                return Err(EnvironmentContractError::Invariant(
                    "Conda prefix is not canonical or target-bound".to_string(),
                ));
            }
        }
        match (
            self.r_package_ownership,
            self.runtime_ownership,
            self.immutable_image.as_ref(),
        ) {
            (
                RPackageOwnershipV1::ImmutableImage,
                RuntimeOwnershipV1::ImmutableImage,
                Some(image),
            ) => {
                validate_text("immutable_image.locator", &image.image_locator)?;
                validate_text(
                    "immutable_image.apptainer_version",
                    &image.apptainer_version,
                )?;
                if image.image_locator.ends_with(":latest")
                    || image.image_locator.contains("../")
                    || self.conda_prefix.is_some()
                {
                    return Err(EnvironmentContractError::Invariant(
                        "immutable image profile must be digest-bound and cannot expose a mutable Conda prefix"
                            .to_string(),
                    ));
                }
            }
            (RPackageOwnershipV1::ImmutableImage, _, _)
            | (_, RuntimeOwnershipV1::ImmutableImage, _)
            | (_, _, Some(_)) => {
                return Err(EnvironmentContractError::Invariant(
                    "immutable image Runtime and R package ownership must be paired".to_string(),
                ));
            }
            _ => {}
        }
        Ok(())
    }

    pub fn digest(&self) -> Result<AuthorityDigest, EnvironmentContractError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
        AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
            .map_err(|error| EnvironmentContractError::Invariant(error.to_string()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageActionV1 {
    pub package: String,
    pub kind: PackageActionKindV1,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub source: String,
    pub repository: Option<String>,
    pub form: PackageFormV1,
    pub artifact_digest: AuthorityDigest,
    pub artifact_byte_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeRequirementActionV1 {
    pub requirement: String,
    pub provider: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolchainActionV1 {
    pub tool: String,
    pub action: String,
    pub expected_fingerprint: Option<AuthorityDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentNetworkIntentV1 {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub purpose: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentSecretRequirementV1 {
    pub secret_ref: String,
    pub purpose: String,
    pub audience: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentVerificationProbeV1 {
    pub probe_id: String,
    pub kind: String,
    pub expected: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MaterializedPackagePlanBodyV1 {
    pub contract_version: u16,
    pub environment: EnvironmentIdentityV1,
    pub expected_before: ExpectedEnvironmentStateV1,
    pub intent: PackageIntentV1,
    pub runtime: RuntimeRealizationV1,
    pub library_stack: LibraryStackV1,
    pub repository_profile: RepositoryProfileV1,
    pub package_actions: Vec<PackageActionV1>,
    pub native_requirement_actions: Vec<NativeRequirementActionV1>,
    pub toolchain_actions: Vec<ToolchainActionV1>,
    pub lockfile_action: Option<String>,
    pub artifact_digests: Vec<AuthorityDigest>,
    pub network_intents: Vec<EnvironmentNetworkIntentV1>,
    pub secret_requirements: Vec<EnvironmentSecretRequirementV1>,
    pub verification_probes: Vec<EnvironmentVerificationProbeV1>,
    pub restart_required: bool,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MaterializedPackagePlanV1 {
    pub plan_id: EnvironmentPlanId,
    pub body: MaterializedPackagePlanBodyV1,
}

impl MaterializedPackagePlanV1 {
    pub fn new(mut body: MaterializedPackagePlanBodyV1) -> Result<Self, EnvironmentContractError> {
        canonicalize_plan(&mut body);
        validate_plan_body(&body)?;
        let plan_id = EnvironmentPlanId::new(format!("environment_plan_{}", digest_json(&body)?))
            .map_err(|error| EnvironmentContractError::Invariant(error.to_string()))?;
        Ok(Self { plan_id, body })
    }

    pub fn validate(&self) -> Result<(), EnvironmentContractError> {
        validate_plan_body(&self.body)?;
        let expected = Self::new(self.body.clone())?;
        if expected.plan_id != self.plan_id {
            return Err(EnvironmentContractError::PlanIdentityMismatch);
        }
        Ok(())
    }
}

pub fn decode_materialized_package_plan_v1(
    bytes: &[u8],
) -> Result<MaterializedPackagePlanV1, EnvironmentContractError> {
    let value = decode_environment_value(bytes)?;
    let plan: MaterializedPackagePlanV1 = serde_json::from_value(value)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    plan.validate()?;
    Ok(plan)
}

pub fn decode_execution_profile_v1(
    bytes: &[u8],
) -> Result<ExecutionProfileV1, EnvironmentContractError> {
    let value = decode_environment_value(bytes)?;
    let profile: ExecutionProfileV1 = serde_json::from_value(value)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    profile.validate()?;
    Ok(profile)
}

fn decode_environment_value(bytes: &[u8]) -> Result<serde_json::Value, EnvironmentContractError> {
    if bytes.len() > MAX_ENVIRONMENT_CONTRACT_BYTES {
        return Err(EnvironmentContractError::TooLarge {
            field: "environment_contract",
            limit: MAX_ENVIRONMENT_CONTRACT_BYTES,
        });
    }
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    if environment_json_depth(&value) > MAX_ENVIRONMENT_JSON_DEPTH {
        return Err(EnvironmentContractError::Invariant(
            "Environment contract JSON exceeds depth bound".to_string(),
        ));
    }
    Ok(value)
}

fn environment_json_depth(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Array(values) => {
            1 + values.iter().map(environment_json_depth).max().unwrap_or(0)
        }
        serde_json::Value::Object(values) => {
            1 + values
                .values()
                .map(environment_json_depth)
                .max()
                .unwrap_or(0)
        }
        _ => 1,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentIncidentV1 {
    pub incident_id: String,
    pub environment_id: EnvironmentId,
    pub kind: String,
    pub subject: String,
    pub detail: String,
    pub observed_desired_revision: Option<EnvironmentDesiredRevisionId>,
    pub observed_realization_revision: Option<EnvironmentRealizationRevisionId>,
    pub detected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentCheckpointV1 {
    pub name: String,
    pub reached_at: String,
    pub digest: Option<AuthorityDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentOperationReceiptV1 {
    pub receipt_id: EnvironmentReceiptId,
    pub operation_id: OperationId,
    pub plan_id: EnvironmentPlanId,
    pub actor_id: String,
    pub approval_effect_digest: AuthorityDigest,
    pub desired_before: EnvironmentDesiredRevisionId,
    pub desired_after: Option<EnvironmentDesiredRevisionId>,
    pub realization_before: EnvironmentRealizationRevisionId,
    pub realization_after: Option<EnvironmentRealizationRevisionId>,
    pub checkpoints: Vec<EnvironmentCheckpointV1>,
    pub execution_refs: Vec<ExecutionId>,
    pub verification_refs: Vec<String>,
    pub outcome: EnvironmentOperationOutcomeV1,
    pub partial_effects_possible: bool,
    pub restart_required: bool,
    pub recorded_at: String,
}

impl EnvironmentOperationReceiptV1 {
    pub fn validate(&self) -> Result<(), EnvironmentContractError> {
        validate_text("receipt.actor_id", &self.actor_id)?;
        validate_text("receipt.recorded_at", &self.recorded_at)?;
        validate_unique(
            "receipt.checkpoints",
            self.checkpoints
                .iter()
                .map(|checkpoint| checkpoint.name.as_str()),
        )?;
        validate_unique(
            "receipt.execution_refs",
            self.execution_refs.iter().map(ExecutionId::as_str),
        )?;
        validate_unique(
            "receipt.verification_refs",
            self.verification_refs.iter().map(String::as_str),
        )?;
        if self.outcome == EnvironmentOperationOutcomeV1::Succeeded {
            if self.realization_after.is_none() || self.verification_refs.is_empty() {
                return Err(EnvironmentContractError::Invariant(
                    "successful Environment receipt requires realized state and verification refs"
                        .to_string(),
                ));
            }
            if self.partial_effects_possible {
                return Err(EnvironmentContractError::Invariant(
                    "successful Environment receipt cannot report partial effects possible"
                        .to_string(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEnvironmentBindingV1 {
    pub environment_id: EnvironmentId,
    pub desired_revision: EnvironmentDesiredRevisionId,
    pub realization_revision: EnvironmentRealizationRevisionId,
    pub receipt_digest: AuthorityDigest,
}

fn canonicalize_plan(body: &mut MaterializedPackagePlanBodyV1) {
    body.package_actions.sort_by(|left, right| {
        left.package
            .cmp(&right.package)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.source.cmp(&right.source))
    });
    body.native_requirement_actions.sort_by(|left, right| {
        left.requirement
            .cmp(&right.requirement)
            .then_with(|| left.provider.cmp(&right.provider))
    });
    body.toolchain_actions.sort_by(|left, right| {
        left.tool
            .cmp(&right.tool)
            .then_with(|| left.action.cmp(&right.action))
    });
    body.artifact_digests
        .sort_by(|left, right| left.as_str().cmp(right.as_str()));
    body.network_intents.sort_by(|left, right| {
        (
            left.scheme.as_str(),
            left.host.as_str(),
            left.port,
            left.purpose.as_str(),
        )
            .cmp(&(
                right.scheme.as_str(),
                right.host.as_str(),
                right.port,
                right.purpose.as_str(),
            ))
    });
    body.secret_requirements.sort_by(|left, right| {
        left.secret_ref
            .cmp(&right.secret_ref)
            .then_with(|| left.purpose.cmp(&right.purpose))
    });
    body.verification_probes
        .sort_by(|left, right| left.probe_id.cmp(&right.probe_id));
}

fn validate_plan_body(
    body: &MaterializedPackagePlanBodyV1,
) -> Result<(), EnvironmentContractError> {
    if body.contract_version != ENVIRONMENT_CONTRACT_VERSION {
        return Err(EnvironmentContractError::Invariant(format!(
            "unsupported Environment contract version {}",
            body.contract_version
        )));
    }
    if body.environment.environment_id != body.expected_before.environment_id {
        return Err(EnvironmentContractError::Invariant(
            "plan Environment identity differs from expected state".to_string(),
        ));
    }
    validate_text("environment.target_id", &body.environment.target_id)?;
    validate_runtime(&body.runtime)?;
    body.library_stack.validate()?;
    let expected_layer = match body.environment.role {
        EnvironmentRoleV1::Core => LibraryLayerKindV1::RhoCoreSupport,
        EnvironmentRoleV1::Project => LibraryLayerKindV1::ProjectRenv,
        EnvironmentRoleV1::NativeUser => LibraryLayerKindV1::User,
    };
    if body
        .library_stack
        .ordered_layers
        .iter()
        .filter(|layer| layer.kind == expected_layer)
        .count()
        != 1
    {
        return Err(EnvironmentContractError::Invariant(
            "Environment plan must bind exactly one writable role library layer".to_string(),
        ));
    }
    validate_repository_profile(&body.repository_profile)?;
    validate_unique(
        "plan.package_actions",
        body.package_actions
            .iter()
            .map(|action| format!("{}:{:?}", action.package, action.kind)),
    )?;
    validate_unique(
        "plan.artifact_digests",
        body.artifact_digests.iter().map(AuthorityDigest::as_str),
    )?;
    validate_unique(
        "plan.network_intents",
        body.network_intents.iter().map(|intent| {
            format!(
                "{}://{}:{}:{}",
                intent.scheme, intent.host, intent.port, intent.purpose
            )
        }),
    )?;
    validate_unique(
        "plan.secret_requirements",
        body.secret_requirements
            .iter()
            .map(|secret| secret.secret_ref.as_str()),
    )?;
    validate_unique(
        "plan.verification_probes",
        body.verification_probes
            .iter()
            .map(|probe| probe.probe_id.as_str()),
    )?;
    let action_count = body.package_actions.len()
        + body.native_requirement_actions.len()
        + body.toolchain_actions.len()
        + usize::from(body.lockfile_action.is_some());
    if action_count == 0 {
        return Err(EnvironmentContractError::Invariant(
            "materialized Environment plan has no action".to_string(),
        ));
    }
    if body.verification_probes.is_empty() {
        return Err(EnvironmentContractError::Invariant(
            "materialized Environment plan has no verification probe".to_string(),
        ));
    }
    if body.package_actions.len() > MAX_ENVIRONMENT_ITEMS
        || body.native_requirement_actions.len() > MAX_ENVIRONMENT_ITEMS
        || body.toolchain_actions.len() > MAX_ENVIRONMENT_ITEMS
        || body.artifact_digests.len() > MAX_ENVIRONMENT_ITEMS
        || body.network_intents.len() > MAX_ENVIRONMENT_ITEMS
        || body.secret_requirements.len() > MAX_ENVIRONMENT_ITEMS
        || body.verification_probes.len() > MAX_ENVIRONMENT_ITEMS
    {
        return Err(EnvironmentContractError::Invariant(
            "materialized Environment plan exceeds item bounds".to_string(),
        ));
    }
    validate_text("plan.expires_at", &body.expires_at)?;
    Ok(())
}

fn validate_runtime(runtime: &RuntimeRealizationV1) -> Result<(), EnvironmentContractError> {
    validate_text("runtime.exact_version", &runtime.requirement.exact_version)?;
    validate_text("runtime.platform", &runtime.requirement.platform)?;
    validate_text("runtime.architecture", &runtime.requirement.architecture)?;
    validate_text("runtime.executable", &runtime.executable)?;
    validate_text("runtime.runtime_home", &runtime.runtime_home)
}

fn validate_repository_profile(
    profile: &RepositoryProfileV1,
) -> Result<(), EnvironmentContractError> {
    if profile.repositories.is_empty() {
        return Err(EnvironmentContractError::Invariant(
            "RepositoryProfile has no repository".to_string(),
        ));
    }
    validate_unique(
        "repository_profile.repositories",
        profile
            .repositories
            .iter()
            .map(|repository| repository.name.as_str()),
    )?;
    let priorities = profile
        .repositories
        .iter()
        .map(|repository| repository.priority)
        .collect::<Vec<_>>();
    if priorities.windows(2).any(|values| values[0] >= values[1]) {
        return Err(EnvironmentContractError::NonCanonicalOrder {
            field: "repository_profile.repositories",
        });
    }
    for repository in &profile.repositories {
        validate_text("repository.name", &repository.name)?;
        validate_text("repository.url", &repository.url)?;
        if !repository.url.starts_with("https://") && !repository.url.starts_with("file://") {
            return Err(EnvironmentContractError::Invariant(
                "repository URL must be https or an admitted local file source".to_string(),
            ));
        }
    }
    Ok(())
}

impl LibraryStackV1 {
    pub fn new(mut ordered_layers: Vec<LibraryLayerV1>) -> Result<Self, EnvironmentContractError> {
        ordered_layers.sort_by_key(|layer| layer.priority);
        let effective_digest =
            AuthorityDigest::new(format!("sha256:{}", digest_json(&ordered_layers)?))
                .map_err(|error| EnvironmentContractError::Invariant(error.to_string()))?;
        let stack = Self {
            ordered_layers,
            effective_digest,
        };
        stack.validate()?;
        Ok(stack)
    }

    pub fn validate(&self) -> Result<(), EnvironmentContractError> {
        if self.ordered_layers.is_empty() {
            return Err(EnvironmentContractError::Invariant(
                "LibraryStack has no layer".to_string(),
            ));
        }
        validate_unique(
            "library_stack.layers",
            self.ordered_layers
                .iter()
                .map(|layer| layer.layer_id.as_str()),
        )?;
        if self
            .ordered_layers
            .windows(2)
            .any(|layers| layers[0].priority >= layers[1].priority)
        {
            return Err(EnvironmentContractError::NonCanonicalOrder {
                field: "library_stack.layers",
            });
        }
        for layer in &self.ordered_layers {
            validate_text("library_layer.path", &layer.canonical_path)?;
            validate_text(
                "library_layer.filesystem_identity",
                &layer.filesystem_identity,
            )?;
            match (layer.kind, layer.owner, layer.mutability) {
                (
                    LibraryLayerKindV1::RhoCoreSupport,
                    LibraryOwnerV1::Rho,
                    LibraryMutabilityV1::RhoManaged,
                )
                | (
                    LibraryLayerKindV1::ProjectRenv,
                    LibraryOwnerV1::Project,
                    LibraryMutabilityV1::RhoManaged,
                )
                | (
                    LibraryLayerKindV1::User,
                    LibraryOwnerV1::User,
                    LibraryMutabilityV1::UserWritable,
                )
                | (
                    LibraryLayerKindV1::Site,
                    LibraryOwnerV1::SiteAdministrator,
                    LibraryMutabilityV1::ExternallyManaged,
                )
                | (
                    LibraryLayerKindV1::System,
                    LibraryOwnerV1::RDistribution,
                    LibraryMutabilityV1::ReadOnly,
                ) => {}
                _ => {
                    return Err(EnvironmentContractError::Invariant(
                        "Library layer owner/mutability does not match its kind".to_string(),
                    ));
                }
            }
        }
        let expected =
            AuthorityDigest::new(format!("sha256:{}", digest_json(&self.ordered_layers)?))
                .map_err(|error| EnvironmentContractError::Invariant(error.to_string()))?;
        if self.effective_digest != expected {
            return Err(EnvironmentContractError::Invariant(
                "LibraryStack effective digest does not match its ordered layers".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_text(field: &'static str, value: &str) -> Result<(), EnvironmentContractError> {
    if value.is_empty() {
        return Err(EnvironmentContractError::Empty { field });
    }
    if value.len() > MAX_ENVIRONMENT_TEXT_BYTES {
        return Err(EnvironmentContractError::TooLarge {
            field,
            limit: MAX_ENVIRONMENT_TEXT_BYTES,
        });
    }
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(EnvironmentContractError::InvalidText { field });
    }
    Ok(())
}

fn validate_unique<I, S>(field: &'static str, values: I) -> Result<(), EnvironmentContractError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut seen = BTreeSet::new();
    for value in values {
        let value = value.as_ref();
        validate_text(field, value)?;
        if !seen.insert(value.to_string()) {
            return Err(EnvironmentContractError::Duplicate {
                field,
                value: value.to_string(),
            });
        }
    }
    Ok(())
}

fn digest_json(value: &impl Serialize) -> Result<String, EnvironmentContractError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(value: char) -> AuthorityDigest {
        AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
    }

    fn body() -> MaterializedPackagePlanBodyV1 {
        let environment_id = EnvironmentId::new("environment_project").unwrap();
        MaterializedPackagePlanBodyV1 {
            contract_version: ENVIRONMENT_CONTRACT_VERSION,
            environment: EnvironmentIdentityV1 {
                environment_id: environment_id.clone(),
                role: EnvironmentRoleV1::NativeUser,
                project_id: Some(ProjectId::new("project_test").unwrap()),
                target_id: "local".to_string(),
                execution_profile_id: ExecutionProfileId::new("execution_profile_local").unwrap(),
            },
            expected_before: ExpectedEnvironmentStateV1 {
                environment_id,
                desired_revision: EnvironmentDesiredRevisionId::new("env_desired_before").unwrap(),
                realization_revision: EnvironmentRealizationRevisionId::new("env_realized_before")
                    .unwrap(),
                project_revision: Some(7),
                repository_profile_digest: digest('a'),
            },
            intent: PackageIntentV1::InstallUserPackage,
            runtime: RuntimeRealizationV1 {
                runtime_id: RuntimeRealizationId::new("runtime_realization_r45").unwrap(),
                requirement: RuntimeRequirementV1 {
                    distribution: RuntimeDistributionV1::R,
                    exact_version: "4.5.2".to_string(),
                    platform: "darwin".to_string(),
                    architecture: "aarch64".to_string(),
                },
                ownership: RuntimeOwnershipV1::System,
                support_tier: RuntimeSupportTierV1::Verified,
                executable: "/Library/Frameworks/R.framework/Resources/bin/Rscript".to_string(),
                runtime_home: "/Library/Frameworks/R.framework/Resources".to_string(),
                executable_digest: digest('b'),
                build_fingerprint: digest('c'),
                compiler_fingerprint: None,
            },
            library_stack: LibraryStackV1::new(vec![LibraryLayerV1 {
                layer_id: LibraryLayerId::new("library_user_test").unwrap(),
                kind: LibraryLayerKindV1::User,
                owner: LibraryOwnerV1::User,
                mutability: LibraryMutabilityV1::UserWritable,
                canonical_path: "/Users/test/R/library".to_string(),
                priority: 1,
                filesystem_identity: "fs:user-library".to_string(),
            }])
            .unwrap(),
            repository_profile: RepositoryProfileV1 {
                profile_id: RepositoryProfileId::new("repository_profile_default").unwrap(),
                repositories: vec![RepositoryEndpointV1 {
                    name: "cran".to_string(),
                    url: "https://cloud.r-project.org".to_string(),
                    priority: 1,
                }],
                bioconductor_version: None,
                snapshot: None,
                binary_preference: "prefer_binary".to_string(),
                source_fallback_policy: "review".to_string(),
                offline_policy: "retrieve_then_build_offline".to_string(),
                proxy_profile_ref: None,
                trust_bundle_ref: None,
                credential_refs: Vec::new(),
                allowed_origins: vec!["https://cloud.r-project.org".to_string()],
            },
            package_actions: vec![PackageActionV1 {
                package: "DESeq2".to_string(),
                kind: PackageActionKindV1::Install,
                from_version: None,
                to_version: Some("1.50.0".to_string()),
                source: "bioconductor".to_string(),
                repository: Some("cran".to_string()),
                form: PackageFormV1::Binary,
                artifact_digest: digest('d'),
                artifact_byte_size: 42,
            }],
            native_requirement_actions: Vec::new(),
            toolchain_actions: Vec::new(),
            lockfile_action: None,
            artifact_digests: vec![digest('d')],
            network_intents: vec![EnvironmentNetworkIntentV1 {
                scheme: "https".to_string(),
                host: "cloud.r-project.org".to_string(),
                port: 443,
                purpose: "retrieve package".to_string(),
            }],
            secret_requirements: Vec::new(),
            verification_probes: vec![EnvironmentVerificationProbeV1 {
                probe_id: "probe_namespace_load".to_string(),
                kind: "namespace_load".to_string(),
                expected: "DESeq2@1.50.0".to_string(),
            }],
            restart_required: true,
            expires_at: "2026-09-01T23:59:00Z".to_string(),
        }
    }

    #[test]
    fn materialized_plan_identity_is_deterministic_and_order_independent() {
        let first = MaterializedPackagePlanV1::new(body()).unwrap();
        let mut reordered = body();
        reordered.artifact_digests.reverse();
        reordered.verification_probes.reverse();
        let second = MaterializedPackagePlanV1::new(reordered).unwrap();
        assert_eq!(first, second);
        first.validate().unwrap();
    }

    #[test]
    fn materialized_plan_decoder_rejects_unknown_depth_and_byte_overflow() {
        let plan = MaterializedPackagePlanV1::new(body()).unwrap();
        let encoded = serde_json::to_vec(&plan).unwrap();
        assert_eq!(decode_materialized_package_plan_v1(&encoded).unwrap(), plan);
        let mut unknown = serde_json::to_value(&plan).unwrap();
        unknown["unexpected"] = serde_json::json!(true);
        assert!(
            decode_materialized_package_plan_v1(&serde_json::to_vec(&unknown).unwrap()).is_err()
        );
        assert!(
            decode_materialized_package_plan_v1(&vec![b'x'; MAX_ENVIRONMENT_CONTRACT_BYTES + 1])
                .is_err()
        );
        let mut deep = serde_json::json!(null);
        for _ in 0..=MAX_ENVIRONMENT_JSON_DEPTH {
            deep = serde_json::json!({"nested": deep});
        }
        assert!(decode_materialized_package_plan_v1(&serde_json::to_vec(&deep).unwrap()).is_err());
    }

    #[test]
    fn successful_receipt_requires_realization_and_verification() {
        let receipt = EnvironmentOperationReceiptV1 {
            receipt_id: EnvironmentReceiptId::new("environment_receipt_test").unwrap(),
            operation_id: OperationId::new("operation_test").unwrap(),
            plan_id: MaterializedPackagePlanV1::new(body()).unwrap().plan_id,
            actor_id: "user".to_string(),
            approval_effect_digest: digest('e'),
            desired_before: EnvironmentDesiredRevisionId::new("env_desired_before").unwrap(),
            desired_after: Some(EnvironmentDesiredRevisionId::new("env_desired_after").unwrap()),
            realization_before: EnvironmentRealizationRevisionId::new("env_realized_before")
                .unwrap(),
            realization_after: None,
            checkpoints: Vec::new(),
            execution_refs: Vec::new(),
            verification_refs: Vec::new(),
            outcome: EnvironmentOperationOutcomeV1::Succeeded,
            partial_effects_possible: false,
            restart_required: true,
            recorded_at: "2026-09-01T12:00:00Z".to_string(),
        };
        assert!(receipt.validate().is_err());
    }

    #[test]
    fn library_stack_rejects_owner_or_order_drift() {
        let stack = LibraryStackV1 {
            ordered_layers: vec![LibraryLayerV1 {
                layer_id: LibraryLayerId::new("library_layer_system").unwrap(),
                kind: LibraryLayerKindV1::System,
                owner: LibraryOwnerV1::User,
                mutability: LibraryMutabilityV1::UserWritable,
                canonical_path: "/Library/Frameworks/R.framework/Resources/library".to_string(),
                priority: 1,
                filesystem_identity: "dev:1:inode:2".to_string(),
            }],
            effective_digest: digest('f'),
        };
        assert!(stack.validate().is_err());
    }
}
