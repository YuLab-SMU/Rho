use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{
    AuthorityDigest, BaseEnvironmentPolicyV1, CondaPrefixRefV1, EnvironmentContractError,
    ExecutionProfileId, ExecutionProfileV1, ExecutionTargetV1, ImmutableImageRefV1,
    MaterializedPackagePlanV1, ModuleStackV1, NativeDependencyOwnershipV1, RPackageOwnershipV1,
    RepositoryProfileId, ResourceRequest, RuntimeOwnershipV1, RuntimeRealizationId,
    SchedulerProfileV1, StorageProfileV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_REMOTE_PROFILE_ENVIRONMENT_ITEMS: usize = 512;
pub const MAX_CONDA_EXPLICIT_SPEC_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LmodObservation {
    pub ordered_full_names: Vec<String>,
    pub lmod_version: String,
    pub environment_before: BTreeMap<String, String>,
    pub environment_after: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CondaObservation {
    pub target_id: String,
    pub canonical_prefix: String,
    pub manager_kind: String,
    pub manager_version: String,
    pub explicit_spec: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct RemoteExecutionProfileRequest {
    pub profile_id: ExecutionProfileId,
    pub target: ExecutionTargetV1,
    pub scheduler: SchedulerProfileV1,
    pub base_environment_policy: BaseEnvironmentPolicyV1,
    pub lmod: Option<LmodObservation>,
    pub conda: Option<CondaObservation>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteProfileCommand {
    pub executable: String,
    pub argv: Vec<String>,
    pub base_environment_policy: BaseEnvironmentPolicyV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImmutableImageRebuildPlanV1 {
    pub rebuild_id: String,
    pub environment_plan_id: String,
    pub execution_profile_id: ExecutionProfileId,
    pub execution_profile_digest: AuthorityDigest,
    pub base_image: ImmutableImageRefV1,
    pub package_artifact_digests: Vec<AuthorityDigest>,
    pub retrieval_secret_refs: Vec<String>,
    pub verification_probes: Vec<String>,
    pub output_image_locator: String,
    pub build_network_policy: String,
    pub mutation_mode: String,
    pub in_place_install: bool,
}

pub fn materialize_apptainer_rebuild(
    plan: &MaterializedPackagePlanV1,
    profile: &ExecutionProfileV1,
    output_image_locator: &str,
) -> Result<ImmutableImageRebuildPlanV1, EnvironmentContractError> {
    plan.validate()?;
    profile.validate()?;
    let base_image = profile.immutable_image.clone().ok_or_else(|| {
        EnvironmentContractError::Invariant(
            "Apptainer rebuild requires an immutable image ExecutionProfile".to_string(),
        )
    })?;
    if plan.body.environment.execution_profile_id != profile.profile_id
        || output_image_locator.is_empty()
        || output_image_locator.trim() != output_image_locator
        || output_image_locator.ends_with(":latest")
        || output_image_locator == base_image.image_locator
    {
        return Err(EnvironmentContractError::Invariant(
            "Apptainer rebuild output or ExecutionProfile does not match the Environment plan"
                .to_string(),
        ));
    }
    let mut rebuild = ImmutableImageRebuildPlanV1 {
        rebuild_id: String::new(),
        environment_plan_id: plan.plan_id.as_str().to_string(),
        execution_profile_id: profile.profile_id.clone(),
        execution_profile_digest: profile.digest()?,
        base_image,
        package_artifact_digests: plan.body.artifact_digests.clone(),
        retrieval_secret_refs: plan
            .body
            .secret_requirements
            .iter()
            .map(|requirement| requirement.secret_ref.clone())
            .collect(),
        verification_probes: plan
            .body
            .verification_probes
            .iter()
            .map(|probe| probe.probe_id.clone())
            .collect(),
        output_image_locator: output_image_locator.to_string(),
        build_network_policy: "deny".to_string(),
        mutation_mode: "rebuild_only".to_string(),
        in_place_install: false,
    };
    rebuild.package_artifact_digests.sort();
    rebuild.retrieval_secret_refs.sort();
    rebuild.verification_probes.sort();
    let bytes = serde_json::to_vec(&rebuild)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    rebuild.rebuild_id = format!("apptainer_rebuild_{:x}", Sha256::digest(bytes));
    Ok(rebuild)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteFingerprintPhase {
    Login,
    ScheduledCompute,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteExecutionFingerprint {
    pub profile_id: ExecutionProfileId,
    pub target_id: String,
    pub phase: RemoteFingerprintPhase,
    pub runtime_build_digest: AuthorityDigest,
    pub module_environment_delta_digest: Option<AuthorityDigest>,
    pub conda_explicit_spec_digest: Option<AuthorityDigest>,
    pub storage_filesystem_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFingerprintDifference {
    pub field: String,
    pub login: String,
    pub scheduled_compute: String,
    pub incident_kind: String,
}

pub fn compare_remote_fingerprints(
    login: &RemoteExecutionFingerprint,
    compute: &RemoteExecutionFingerprint,
) -> Result<Vec<RemoteFingerprintDifference>, EnvironmentContractError> {
    if login.phase != RemoteFingerprintPhase::Login
        || compute.phase != RemoteFingerprintPhase::ScheduledCompute
        || login.profile_id != compute.profile_id
        || login.target_id != compute.target_id
    {
        return Err(EnvironmentContractError::Invariant(
            "remote fingerprints are not the login/compute pair for one profile".to_string(),
        ));
    }
    let values = [
        (
            "runtime_build_digest",
            Some(&login.runtime_build_digest),
            Some(&compute.runtime_build_digest),
            "environment_not_propagated",
        ),
        (
            "module_environment_delta_digest",
            login.module_environment_delta_digest.as_ref(),
            compute.module_environment_delta_digest.as_ref(),
            "module_not_available",
        ),
        (
            "conda_explicit_spec_digest",
            login.conda_explicit_spec_digest.as_ref(),
            compute.conda_explicit_spec_digest.as_ref(),
            "environment_not_propagated",
        ),
    ];
    let mut differences = values
        .into_iter()
        .filter(|(_, left, right, _)| left != right)
        .map(
            |(field, left, right, incident_kind)| RemoteFingerprintDifference {
                field: field.to_string(),
                login: left.map_or("absent", AuthorityDigest::as_str).to_string(),
                scheduled_compute: right.map_or("absent", AuthorityDigest::as_str).to_string(),
                incident_kind: incident_kind.to_string(),
            },
        )
        .collect::<Vec<_>>();
    if login.storage_filesystem_identity != compute.storage_filesystem_identity {
        differences.push(RemoteFingerprintDifference {
            field: "storage_filesystem_identity".to_string(),
            login: login.storage_filesystem_identity.clone(),
            scheduled_compute: compute.storage_filesystem_identity.clone(),
            incident_kind: "environment_not_propagated".to_string(),
        });
    }
    Ok(differences)
}

pub fn resolve_execution_profile(
    request: RemoteExecutionProfileRequest,
) -> Result<ExecutionProfileV1, EnvironmentContractError> {
    let module_stack = request.lmod.map(resolve_lmod).transpose()?;
    let conda_prefix = request.conda.map(resolve_conda).transpose()?;
    let profile = ExecutionProfileV1 {
        contract_version: rho_protocol::ENVIRONMENT_CONTRACT_VERSION,
        profile_id: request.profile_id,
        target: request.target,
        scheduler: request.scheduler,
        base_environment_policy: request.base_environment_policy,
        module_stack,
        conda_prefix,
        immutable_image: request.immutable_image,
        runtime_id: request.runtime_id,
        runtime_ownership: request.runtime_ownership,
        native_ownership: request.native_ownership,
        r_package_ownership: request.r_package_ownership,
        repository_profile_id: request.repository_profile_id,
        repository_profile_digest: request.repository_profile_digest,
        storage: request.storage,
        resource_defaults: request.resource_defaults,
    };
    profile.validate()?;
    Ok(profile)
}

pub fn conda_run_command(
    manager_executable: &str,
    prefix: &CondaPrefixRefV1,
    executable: &str,
    argv: &[String],
) -> Result<RemoteProfileCommand, EnvironmentContractError> {
    if !manager_executable.starts_with('/')
        || manager_executable.contains("..")
        || executable.is_empty()
        || executable.chars().any(char::is_control)
        || argv.len() > 256
        || argv.iter().any(|argument| argument.contains('\0'))
    {
        return Err(EnvironmentContractError::Invariant(
            "Conda run command is not a bounded structured invocation".to_string(),
        ));
    }
    let mut command_argv = vec![
        "run".to_string(),
        "--no-capture-output".to_string(),
        "--prefix".to_string(),
        prefix.canonical_prefix.clone(),
        executable.to_string(),
    ];
    command_argv.extend_from_slice(argv);
    Ok(RemoteProfileCommand {
        executable: manager_executable.to_string(),
        argv: command_argv,
        base_environment_policy: BaseEnvironmentPolicyV1::Clean,
    })
}

fn resolve_lmod(observation: LmodObservation) -> Result<ModuleStackV1, EnvironmentContractError> {
    if observation.environment_before.len() > MAX_REMOTE_PROFILE_ENVIRONMENT_ITEMS
        || observation.environment_after.len() > MAX_REMOTE_PROFILE_ENVIRONMENT_ITEMS
        || observation.ordered_full_names.len() > 256
        || observation.lmod_version.is_empty()
    {
        return Err(EnvironmentContractError::Invariant(
            "Lmod observation exceeds bounds".to_string(),
        ));
    }
    let mut names = BTreeSet::new();
    for name in &observation.ordered_full_names {
        if name.len() > 256
            || name.split_once('/').is_none_or(|(module, version)| {
                module.is_empty() || version.is_empty() || version.contains('/')
            })
            || !names.insert(name.as_str())
        {
            return Err(EnvironmentContractError::Invariant(
                "Lmod observation must contain unique fully-qualified module names".to_string(),
            ));
        }
    }
    let keys = observation
        .environment_before
        .keys()
        .chain(observation.environment_after.keys())
        .collect::<BTreeSet<_>>();
    let mut delta = Vec::new();
    for key in keys {
        if sensitive_environment_key(key) {
            return Err(EnvironmentContractError::Invariant(
                "Lmod environment delta contains a secret-like variable".to_string(),
            ));
        }
        let before = observation.environment_before.get(key);
        let after = observation.environment_after.get(key);
        if before != after {
            if key.is_empty()
                || key.len() > 128
                || before
                    .into_iter()
                    .chain(after)
                    .any(|value| value.len() > 64 * 1024)
            {
                return Err(EnvironmentContractError::Invariant(
                    "Lmod environment delta is invalid".to_string(),
                ));
            }
            delta.push((key, before, after));
        }
    }
    let bytes = serde_json::to_vec(&delta)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    Ok(ModuleStackV1 {
        ordered_full_names: observation.ordered_full_names,
        lmod_version: observation.lmod_version,
        environment_delta_digest: authority_digest(&bytes)?,
    })
}

fn resolve_conda(
    observation: CondaObservation,
) -> Result<CondaPrefixRefV1, EnvironmentContractError> {
    if observation.explicit_spec.is_empty()
        || observation.explicit_spec.len() > MAX_CONDA_EXPLICIT_SPEC_BYTES
        || !observation.canonical_prefix.starts_with('/')
        || observation.canonical_prefix.contains("..")
    {
        return Err(EnvironmentContractError::Invariant(
            "Conda observation is invalid or unbounded".to_string(),
        ));
    }
    let text = String::from_utf8(observation.explicit_spec).map_err(|_| {
        EnvironmentContractError::Invariant("Conda explicit spec is not UTF-8".to_string())
    })?;
    let normalized = text.replace("\r\n", "\n");
    if !normalized.lines().any(|line| line.trim() == "@EXPLICIT") {
        return Err(EnvironmentContractError::Invariant(
            "Conda observation is not an explicit specification".to_string(),
        ));
    }
    for line in normalized.lines().map(str::trim) {
        let lowered = line.to_ascii_lowercase();
        if line.is_empty() || line.starts_with('#') || line == "@EXPLICIT" {
            continue;
        }
        if !(line.starts_with("https://") || line.starts_with("file://"))
            || line.contains('?')
            || lowered.contains("token")
            || lowered.contains("password")
            || lowered.contains("://t/")
            || line.split_once("://").is_some_and(|(_, authority)| {
                authority
                    .split('/')
                    .next()
                    .is_some_and(|host| host.contains('@'))
            })
        {
            return Err(EnvironmentContractError::Invariant(
                "Conda explicit spec contains an unsupported or credential-bearing locator"
                    .to_string(),
            ));
        }
    }
    Ok(CondaPrefixRefV1 {
        target_id: observation.target_id,
        canonical_prefix: observation.canonical_prefix,
        manager_kind: observation.manager_kind,
        manager_version: observation.manager_version,
        explicit_spec_digest: authority_digest(normalized.as_bytes())?,
    })
}

fn sensitive_environment_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "PRIVATE_KEY",
        "AUTHORIZATION",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn authority_digest(bytes: &[u8]) -> Result<AuthorityDigest, EnvironmentContractError> {
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| EnvironmentContractError::Invariant(error.to_string()))
}

pub fn remote_profile_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "ordered_fully_qualified_modules",
            "module_environment_delta_digest",
            "conda_explicit_spec_digest",
            "target_bound_profile",
            "structured_conda_run",
            "login_compute_fingerprint_diff",
        ],
        &[
            "conda_activate",
            "shell_startup_mutation",
            "persisted_environment_values",
            "repository_secret_material",
        ],
    )
}

#[cfg(test)]
mod tests {
    use rho_protocol::*;

    use super::*;

    fn digest(value: char) -> AuthorityDigest {
        AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
    }

    fn request() -> RemoteExecutionProfileRequest {
        RemoteExecutionProfileRequest {
            profile_id: ExecutionProfileId::new("execution_profile_yulab").unwrap(),
            target: ExecutionTargetV1 {
                target_id: "yulab".to_string(),
                kind: ExecutionTargetKindV1::Ssh,
                platform: "linux".to_string(),
                architecture: "x86_64".to_string(),
            },
            scheduler: SchedulerProfileV1 {
                kind: SchedulerKindV1::Slurm,
                implementation: "slurm".to_string(),
                version: "24.11".to_string(),
                submit_endpoint: "login-node".to_string(),
            },
            base_environment_policy: BaseEnvironmentPolicyV1::Clean,
            lmod: Some(LmodObservation {
                ordered_full_names: vec!["gcc/13.2.0".to_string(), "R/4.5.2".to_string()],
                lmod_version: "8.7.59".to_string(),
                environment_before: BTreeMap::from([(
                    "PATH".to_string(),
                    "/usr/bin".to_string(),
                )]),
                environment_after: BTreeMap::from([(
                    "PATH".to_string(),
                    "/opt/R/4.5.2/bin:/usr/bin".to_string(),
                )]),
            }),
            conda: Some(CondaObservation {
                target_id: "yulab".to_string(),
                canonical_prefix: "/shared/conda/rho".to_string(),
                manager_kind: "conda".to_string(),
                manager_version: "25.7.0".to_string(),
                explicit_spec: b"# platform: linux-64\r\n@EXPLICIT\r\nhttps://repo.anaconda.com/pkgs/main/linux-64/zlib-1.3.1.conda\r\n".to_vec(),
            }),
            immutable_image: None,
            runtime_id: RuntimeRealizationId::new("runtime_realization_yulab_r").unwrap(),
            runtime_ownership: RuntimeOwnershipV1::Conda,
            native_ownership: NativeDependencyOwnershipV1::Conda,
            r_package_ownership: RPackageOwnershipV1::ProjectRenv,
            repository_profile_id: RepositoryProfileId::new("repository_profile_yulab").unwrap(),
            repository_profile_digest: digest('a'),
            storage: StorageProfileV1 {
                remote_cas_locator: "/shared/rho/cas".to_string(),
                staging_locator: "/shared/rho/staging".to_string(),
                shared_library_locator: "/shared/rho/library".to_string(),
                filesystem_identity: "lustre:fs-rho".to_string(),
            },
            resource_defaults: Some(ResourceRequest {
                cpu_cores: Some(4),
                memory_bytes: Some(8 * 1024 * 1024 * 1024),
                wall_time_seconds: Some(3_600),
                gpu_count: Some(0),
                partition: Some("cpu".to_string()),
                account: Some("rho".to_string()),
            }),
        }
    }

    fn package_plan(execution_profile_id: ExecutionProfileId) -> MaterializedPackagePlanV1 {
        let environment_id = EnvironmentId::new("environment_apptainer").unwrap();
        MaterializedPackagePlanV1::new(MaterializedPackagePlanBodyV1 {
            contract_version: ENVIRONMENT_CONTRACT_VERSION,
            environment: EnvironmentIdentityV1 {
                environment_id: environment_id.clone(),
                role: EnvironmentRoleV1::NativeUser,
                project_id: Some(ProjectId::new("project_apptainer").unwrap()),
                target_id: "yulab".to_string(),
                execution_profile_id,
            },
            expected_before: ExpectedEnvironmentStateV1 {
                environment_id,
                desired_revision: EnvironmentDesiredRevisionId::new("env_desired_image_before")
                    .unwrap(),
                realization_revision: EnvironmentRealizationRevisionId::new(
                    "env_realized_image_before",
                )
                .unwrap(),
                project_revision: Some(1),
                repository_profile_digest: digest('a'),
            },
            intent: PackageIntentV1::InstallUserPackage,
            runtime: RuntimeRealizationV1 {
                runtime_id: RuntimeRealizationId::new("runtime_realization_image").unwrap(),
                requirement: RuntimeRequirementV1 {
                    distribution: RuntimeDistributionV1::R,
                    exact_version: "4.5.2".to_string(),
                    platform: "linux".to_string(),
                    architecture: "x86_64".to_string(),
                },
                ownership: RuntimeOwnershipV1::ImmutableImage,
                support_tier: RuntimeSupportTierV1::Verified,
                executable: "/usr/bin/Rscript".to_string(),
                runtime_home: "/usr/lib64/R".to_string(),
                executable_digest: digest('b'),
                build_fingerprint: digest('c'),
                compiler_fingerprint: None,
            },
            library_stack: LibraryStackV1::new(vec![LibraryLayerV1 {
                layer_id: LibraryLayerId::new("library_user_image").unwrap(),
                kind: LibraryLayerKindV1::User,
                owner: LibraryOwnerV1::User,
                mutability: LibraryMutabilityV1::UserWritable,
                canonical_path: "/opt/rho/image-library".to_string(),
                priority: 1,
                filesystem_identity: "image:library".to_string(),
            }])
            .unwrap(),
            repository_profile: RepositoryProfileV1 {
                profile_id: RepositoryProfileId::new("repository_profile_yulab").unwrap(),
                repositories: vec![RepositoryEndpointV1 {
                    name: "fixture".to_string(),
                    url: "file:///remote-cas/repository".to_string(),
                    priority: 1,
                }],
                bioconductor_version: None,
                snapshot: None,
                binary_preference: "source".to_string(),
                source_fallback_policy: "deny".to_string(),
                offline_policy: "retrieve_then_build_offline".to_string(),
                proxy_profile_ref: None,
                trust_bundle_ref: None,
                credential_refs: Vec::new(),
                allowed_origins: vec!["file:///remote-cas".to_string()],
            },
            package_actions: vec![PackageActionV1 {
                package: "DESeq2".to_string(),
                kind: PackageActionKindV1::Install,
                from_version: None,
                to_version: Some("1.50.0".to_string()),
                source: "file:///remote-cas/repository/DESeq2.tar.gz".to_string(),
                repository: Some("fixture".to_string()),
                form: PackageFormV1::Source,
                artifact_digest: digest('d'),
                artifact_byte_size: 42,
            }],
            native_requirement_actions: Vec::new(),
            toolchain_actions: Vec::new(),
            lockfile_action: None,
            artifact_digests: vec![digest('d')],
            network_intents: Vec::new(),
            secret_requirements: Vec::new(),
            verification_probes: vec![EnvironmentVerificationProbeV1 {
                probe_id: "probe_image_namespace".to_string(),
                kind: "namespace_load".to_string(),
                expected: "DESeq2@1.50.0".to_string(),
            }],
            restart_required: true,
            expires_at: "2026-09-02T00:00:00Z".to_string(),
        })
        .unwrap()
    }

    #[test]
    fn resolver_binds_ordered_lmod_delta_and_conda_explicit_spec_without_values() {
        let profile = resolve_execution_profile(request()).unwrap();
        assert_eq!(
            profile.module_stack.as_ref().unwrap().ordered_full_names,
            ["gcc/13.2.0", "R/4.5.2"]
        );
        assert!(
            profile
                .module_stack
                .as_ref()
                .unwrap()
                .environment_delta_digest
                .as_str()
                .starts_with("sha256:")
        );
        assert!(
            profile
                .conda_prefix
                .as_ref()
                .unwrap()
                .explicit_spec_digest
                .as_str()
                .starts_with("sha256:")
        );
        let encoded = serde_json::to_string(&profile).unwrap();
        assert!(!encoded.contains("/opt/R/4.5.2/bin:/usr/bin"));
        assert_eq!(
            decode_execution_profile_v1(encoded.as_bytes()).unwrap(),
            profile
        );
        profile.digest().unwrap();
        let command = conda_run_command(
            "/opt/conda/bin/conda",
            profile.conda_prefix.as_ref().unwrap(),
            "Rscript",
            &["--vanilla".to_string(), "build.R".to_string()],
        )
        .unwrap();
        assert_eq!(
            &command.argv[..4],
            [
                "run",
                "--no-capture-output",
                "--prefix",
                "/shared/conda/rho"
            ]
        );
        assert!(!command.argv.iter().any(|argument| argument == "activate"));
    }

    #[test]
    fn resolver_rejects_unqualified_modules_secret_delta_and_credential_conda_locator() {
        let mut bad = request();
        bad.lmod.as_mut().unwrap().ordered_full_names = vec!["R".to_string()];
        assert!(resolve_execution_profile(bad).is_err());

        let mut bad = request();
        bad.lmod
            .as_mut()
            .unwrap()
            .environment_after
            .insert("REPOSITORY_TOKEN".to_string(), "secret".to_string());
        assert!(resolve_execution_profile(bad).is_err());

        let mut bad = request();
        bad.conda.as_mut().unwrap().explicit_spec =
            b"@EXPLICIT\nhttps://token@example.invalid/pkg.conda\n".to_vec();
        assert!(resolve_execution_profile(bad).is_err());
    }

    #[test]
    fn remote_profile_boundary_forbids_activation_shell_mutation_and_secret_values() {
        let (_, forbidden) = remote_profile_boundary();
        assert!(forbidden.contains(&"conda_activate"));
        assert!(forbidden.contains(&"shell_startup_mutation"));
        assert!(forbidden.contains(&"persisted_environment_values"));
    }

    #[test]
    fn login_compute_fingerprint_diff_is_structured_and_never_claims_equivalence() {
        let profile_id = ExecutionProfileId::new("execution_profile_yulab").unwrap();
        let login = RemoteExecutionFingerprint {
            profile_id: profile_id.clone(),
            target_id: "yulab".to_string(),
            phase: RemoteFingerprintPhase::Login,
            runtime_build_digest: digest('1'),
            module_environment_delta_digest: Some(digest('2')),
            conda_explicit_spec_digest: Some(digest('3')),
            storage_filesystem_identity: "lustre:rho".to_string(),
        };
        let compute = RemoteExecutionFingerprint {
            profile_id,
            target_id: "yulab".to_string(),
            phase: RemoteFingerprintPhase::ScheduledCompute,
            runtime_build_digest: digest('1'),
            module_environment_delta_digest: Some(digest('9')),
            conda_explicit_spec_digest: Some(digest('3')),
            storage_filesystem_identity: "lustre:rho".to_string(),
        };
        let differences = compare_remote_fingerprints(&login, &compute).unwrap();
        assert_eq!(differences.len(), 1);
        assert_eq!(differences[0].field, "module_environment_delta_digest");
        assert_eq!(differences[0].incident_kind, "module_not_available");
    }

    #[test]
    fn apptainer_package_change_is_rebuild_only_and_never_installs_in_place() {
        let mut immutable = request();
        immutable.conda = None;
        immutable.lmod = None;
        immutable.runtime_ownership = RuntimeOwnershipV1::ImmutableImage;
        immutable.native_ownership = NativeDependencyOwnershipV1::ImmutableImage;
        immutable.r_package_ownership = RPackageOwnershipV1::ImmutableImage;
        immutable.immutable_image = Some(ImmutableImageRefV1 {
            image_locator: "/shared/images/rho-r-4.5.2@sha256:base.sif".to_string(),
            image_digest: digest('5'),
            definition_digest: digest('6'),
            apptainer_version: "1.3.2".to_string(),
            signature_digest: Some(digest('7')),
        });
        let profile = resolve_execution_profile(immutable).unwrap();
        let plan = package_plan(profile.profile_id.clone());
        let rebuild = materialize_apptainer_rebuild(
            &plan,
            &profile,
            "/shared/images/rho-r-4.5.2-deseq2@sha256:candidate.sif",
        )
        .unwrap();
        assert_eq!(rebuild.mutation_mode, "rebuild_only");
        assert_eq!(rebuild.build_network_policy, "deny");
        assert!(!rebuild.in_place_install);
        assert_eq!(rebuild.package_artifact_digests, vec![digest('d')]);
        assert!(
            materialize_apptainer_rebuild(
                &plan,
                &profile,
                &profile.immutable_image.as_ref().unwrap().image_locator,
            )
            .is_err()
        );
    }
}
