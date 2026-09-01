use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{
    EnvironmentContractError, EnvironmentNetworkIntentV1, EnvironmentSecretRequirementV1,
    EnvironmentVerificationProbeV1, MaterializedPackagePlanBodyV1, MaterializedPackagePlanV1,
    NativeRequirementActionV1, PackageActionKindV1, PackageActionV1, PackageFormV1,
};
use serde::{Deserialize, Serialize};

use crate::{EnvironmentPlanInput, normalize_materialized_plan};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SystemRequirementResolutionV1 {
    pub requirement: String,
    pub provider: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageArtifactResolutionV1 {
    pub package: String,
    pub version: String,
    pub action: PackageActionKindV1,
    pub requested_source: String,
    pub resolved_source: String,
    pub repository: String,
    pub form: PackageFormV1,
    pub artifact_digest: rho_protocol::AuthorityDigest,
    pub artifact_byte_size: u64,
    pub resolved_git_commit: Option<String>,
    pub credential_ref: Option<String>,
    pub system_requirements: Vec<SystemRequirementResolutionV1>,
}

#[derive(Debug, Clone)]
pub struct PackageMaterializationRequest {
    pub base_plan: MaterializedPackagePlanBodyV1,
    pub artifacts: Vec<PackageArtifactResolutionV1>,
}

pub fn materialize_package_plan(
    request: PackageMaterializationRequest,
) -> Result<MaterializedPackagePlanV1, EnvironmentContractError> {
    if request.artifacts.is_empty() || request.artifacts.len() > 2_000 {
        return Err(EnvironmentContractError::Invariant(
            "package materialization requires a bounded non-empty artifact set".to_string(),
        ));
    }
    let repositories = request
        .base_plan
        .repository_profile
        .repositories
        .iter()
        .map(|repository| (repository.name.as_str(), repository.url.as_str()))
        .collect::<BTreeMap<_, _>>();
    let allowed_origins = request
        .base_plan
        .repository_profile
        .allowed_origins
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut package_actions = Vec::new();
    let mut native_actions = Vec::new();
    let mut artifact_digests = Vec::new();
    let mut network_intents = Vec::new();
    let mut secret_requirements = Vec::new();
    let mut verification_probes = request.base_plan.verification_probes.clone();
    let mut identities = BTreeSet::new();

    for artifact in request.artifacts {
        validate_token("package", &artifact.package)?;
        validate_token("version", &artifact.version)?;
        if artifact.artifact_byte_size == 0 {
            return Err(EnvironmentContractError::Invariant(
                "package artifact byte size must be positive".to_string(),
            ));
        }
        if !identities.insert((artifact.package.clone(), artifact.action)) {
            return Err(EnvironmentContractError::Duplicate {
                field: "package_materialization.artifacts",
                value: artifact.package,
            });
        }
        let repository_url = repositories
            .get(artifact.repository.as_str())
            .ok_or_else(|| {
                EnvironmentContractError::Invariant(format!(
                    "package {} names unknown repository {}",
                    artifact.package, artifact.repository
                ))
            })?;
        let repository_origin = https_or_file_origin(repository_url)?;
        let artifact_origin = https_or_file_origin(&artifact.resolved_source)?;
        if repository_origin != artifact_origin
            || !allowed_origins.contains(artifact_origin.as_str())
        {
            return Err(EnvironmentContractError::Invariant(format!(
                "package {} resolved outside its admitted RepositoryProfile origin",
                artifact.package
            )));
        }
        if artifact.requested_source.starts_with("git+") {
            let commit = artifact.resolved_git_commit.as_deref().ok_or_else(|| {
                EnvironmentContractError::Invariant(
                    "Git package resolution requires an exact commit".to_string(),
                )
            })?;
            if !valid_git_commit(commit) {
                return Err(EnvironmentContractError::Invariant(
                    "Git package commit must be 40 or 64 lowercase hex characters".to_string(),
                ));
            }
        } else if artifact.resolved_git_commit.is_some() {
            return Err(EnvironmentContractError::Invariant(
                "non-Git package unexpectedly carries a Git commit".to_string(),
            ));
        }
        let (scheme, host, port) = split_origin(&artifact_origin)?;
        network_intents.push(EnvironmentNetworkIntentV1 {
            scheme,
            host,
            port,
            purpose: format!("retrieve {}@{}", artifact.package, artifact.version),
        });
        if let Some(secret_ref) = artifact.credential_ref.as_ref() {
            validate_token("credential ref", secret_ref)?;
            secret_requirements.push(EnvironmentSecretRequirementV1 {
                secret_ref: secret_ref.clone(),
                purpose: format!("retrieve {}", artifact.package),
                audience: artifact_origin.clone(),
            });
        }
        native_actions.extend(artifact.system_requirements.iter().map(|requirement| {
            NativeRequirementActionV1 {
                requirement: requirement.requirement.clone(),
                provider: requirement.provider.clone(),
                action: requirement.action.clone(),
            }
        }));
        verification_probes.push(EnvironmentVerificationProbeV1 {
            probe_id: format!("probe_namespace_{}", artifact.package),
            kind: "namespace_load".to_string(),
            expected: format!("{}@{}", artifact.package, artifact.version),
        });
        artifact_digests.push(artifact.artifact_digest.clone());
        package_actions.push(PackageActionV1 {
            package: artifact.package,
            kind: artifact.action,
            from_version: None,
            to_version: Some(artifact.version),
            source: artifact
                .resolved_git_commit
                .map_or(artifact.requested_source, |commit| {
                    format!("git_commit:{commit}")
                }),
            repository: Some(artifact.repository),
            form: artifact.form,
            artifact_digest: artifact.artifact_digest,
            artifact_byte_size: artifact.artifact_byte_size,
        });
    }

    let mut body = request.base_plan;
    body.package_actions = package_actions;
    body.native_requirement_actions = native_actions;
    body.artifact_digests = artifact_digests;
    body.network_intents = network_intents;
    body.secret_requirements = secret_requirements;
    body.verification_probes = verification_probes;
    normalize_materialized_plan(EnvironmentPlanInput { body })
}

fn https_or_file_origin(value: &str) -> Result<String, EnvironmentContractError> {
    let (scheme, remainder) = value.split_once("://").ok_or_else(|| {
        EnvironmentContractError::Invariant("repository source has no scheme".to_string())
    })?;
    if !matches!(scheme, "https" | "file") {
        return Err(EnvironmentContractError::Invariant(
            "repository source must use https or admitted local file".to_string(),
        ));
    }
    if scheme == "file" {
        if !remainder.starts_with('/') {
            return Err(EnvironmentContractError::Invariant(
                "local file repository must use an absolute file URL".to_string(),
            ));
        }
        return Ok("file://".to_string());
    }
    let authority = remainder.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || authority.chars().any(char::is_whitespace)
    {
        return Err(EnvironmentContractError::Invariant(
            "repository source authority is invalid".to_string(),
        ));
    }
    Ok(format!("{scheme}://{authority}"))
}

fn split_origin(origin: &str) -> Result<(String, String, u16), EnvironmentContractError> {
    let (scheme, authority) = origin
        .split_once("://")
        .ok_or_else(|| EnvironmentContractError::Invariant("origin has no scheme".to_string()))?;
    if scheme == "file" {
        return Ok((scheme.to_string(), String::new(), 0));
    }
    let (host, port) = authority
        .rsplit_once(':')
        .map(|(host, port)| {
            port.parse::<u16>()
                .map(|port| (host.to_string(), port))
                .map_err(|_| {
                    EnvironmentContractError::Invariant("repository port is invalid".to_string())
                })
        })
        .transpose()?
        .unwrap_or_else(|| (authority.to_string(), 443));
    Ok((scheme.to_string(), host, port))
}

fn valid_git_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_token(field: &'static str, value: &str) -> Result<(), EnvironmentContractError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        return Err(EnvironmentContractError::InvalidText { field });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rho_protocol::{
        AuthorityDigest, ENVIRONMENT_CONTRACT_VERSION, EnvironmentDesiredRevisionId, EnvironmentId,
        EnvironmentIdentityV1, EnvironmentRealizationRevisionId, EnvironmentRoleV1,
        ExecutionProfileId, ExpectedEnvironmentStateV1, PackageIntentV1, RepositoryEndpointV1,
        RepositoryProfileId, RepositoryProfileV1, RuntimeDistributionV1, RuntimeOwnershipV1,
        RuntimeRealizationId, RuntimeRealizationV1, RuntimeRequirementV1, RuntimeSupportTierV1,
    };

    use super::*;

    fn digest(value: char) -> AuthorityDigest {
        AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
    }

    fn base_plan() -> MaterializedPackagePlanBodyV1 {
        let profile = RepositoryProfileV1 {
            profile_id: RepositoryProfileId::new("repository_profile_materialize").unwrap(),
            repositories: vec![RepositoryEndpointV1 {
                name: "cran".to_string(),
                url: "https://repo.example.org/cran".to_string(),
                priority: 1,
            }],
            bioconductor_version: None,
            snapshot: Some("2026-09-01".to_string()),
            binary_preference: "prefer_binary".to_string(),
            source_fallback_policy: "review".to_string(),
            offline_policy: "retrieve_then_build_offline".to_string(),
            proxy_profile_ref: None,
            trust_bundle_ref: None,
            credential_refs: vec!["secret:repo".to_string()],
            allowed_origins: vec!["https://repo.example.org".to_string()],
        };
        MaterializedPackagePlanBodyV1 {
            contract_version: ENVIRONMENT_CONTRACT_VERSION,
            environment: EnvironmentIdentityV1 {
                environment_id: EnvironmentId::new("environment_materialize").unwrap(),
                role: EnvironmentRoleV1::NativeUser,
                project_id: None,
                target_id: "local".to_string(),
                execution_profile_id: ExecutionProfileId::new("execution_profile_materialize")
                    .unwrap(),
            },
            expected_before: ExpectedEnvironmentStateV1 {
                environment_id: EnvironmentId::new("environment_materialize").unwrap(),
                desired_revision: EnvironmentDesiredRevisionId::new("env_desired_materialize")
                    .unwrap(),
                realization_revision: EnvironmentRealizationRevisionId::new(
                    "env_realized_materialize",
                )
                .unwrap(),
                project_revision: Some(1),
                repository_profile_digest: digest('1'),
            },
            intent: PackageIntentV1::InstallUserPackage,
            runtime: RuntimeRealizationV1 {
                runtime_id: RuntimeRealizationId::new("runtime_realization_materialize").unwrap(),
                requirement: RuntimeRequirementV1 {
                    distribution: RuntimeDistributionV1::R,
                    exact_version: "4.5.2".to_string(),
                    platform: "darwin".to_string(),
                    architecture: "aarch64".to_string(),
                },
                ownership: RuntimeOwnershipV1::System,
                support_tier: RuntimeSupportTierV1::Verified,
                executable: "/R/Rscript".to_string(),
                runtime_home: "/R".to_string(),
                executable_digest: digest('2'),
                build_fingerprint: digest('3'),
                compiler_fingerprint: None,
            },
            library_stack: rho_protocol::LibraryStackV1::new(vec![rho_protocol::LibraryLayerV1 {
                layer_id: rho_protocol::LibraryLayerId::new("library_user_materialize").unwrap(),
                kind: rho_protocol::LibraryLayerKindV1::User,
                owner: rho_protocol::LibraryOwnerV1::User,
                mutability: rho_protocol::LibraryMutabilityV1::UserWritable,
                canonical_path: "/R/library".to_string(),
                priority: 1,
                filesystem_identity: "fs:materialize-user".to_string(),
            }])
            .unwrap(),
            repository_profile: profile,
            package_actions: Vec::new(),
            native_requirement_actions: Vec::new(),
            toolchain_actions: Vec::new(),
            lockfile_action: None,
            artifact_digests: Vec::new(),
            network_intents: Vec::new(),
            secret_requirements: Vec::new(),
            verification_probes: Vec::new(),
            restart_required: true,
            expires_at: "2026-09-01T23:59:00Z".to_string(),
        }
    }

    fn artifact(source: &str) -> PackageArtifactResolutionV1 {
        PackageArtifactResolutionV1 {
            package: "jsonlite".to_string(),
            version: "2.0.0".to_string(),
            action: PackageActionKindV1::Install,
            requested_source: "cran::jsonlite".to_string(),
            resolved_source: source.to_string(),
            repository: "cran".to_string(),
            form: PackageFormV1::Binary,
            artifact_digest: digest('4'),
            artifact_byte_size: 120,
            resolved_git_commit: None,
            credential_ref: Some("secret:repo".to_string()),
            system_requirements: vec![SystemRequirementResolutionV1 {
                requirement: "libcurl".to_string(),
                provider: "system".to_string(),
                action: "require_present".to_string(),
            }],
        }
    }

    #[test]
    fn materialization_freezes_artifact_network_secret_and_sysreq_facts() {
        let plan = materialize_package_plan(PackageMaterializationRequest {
            base_plan: base_plan(),
            artifacts: vec![artifact("https://repo.example.org/cran/jsonlite.tgz")],
        })
        .unwrap();
        plan.validate().unwrap();
        assert_eq!(plan.body.package_actions[0].artifact_byte_size, 120);
        assert_eq!(plan.body.network_intents[0].host, "repo.example.org");
        assert_eq!(plan.body.secret_requirements[0].secret_ref, "secret:repo");
        assert_eq!(
            plan.body.native_requirement_actions[0].requirement,
            "libcurl"
        );
        assert!(
            !serde_json::to_string(&plan)
                .unwrap()
                .contains("secret_value")
        );
    }

    #[test]
    fn materialization_rejects_unadmitted_origin_and_symbolic_git_ref() {
        assert!(
            materialize_package_plan(PackageMaterializationRequest {
                base_plan: base_plan(),
                artifacts: vec![artifact("https://evil.example.org/jsonlite.tgz")],
            })
            .is_err()
        );
        let mut git = artifact("https://repo.example.org/cran/jsonlite.tgz");
        git.requested_source = "git+https://repo.example.org/jsonlite@main".to_string();
        git.resolved_git_commit = Some("main".to_string());
        assert!(
            materialize_package_plan(PackageMaterializationRequest {
                base_plan: base_plan(),
                artifacts: vec![git],
            })
            .is_err()
        );
    }
}
