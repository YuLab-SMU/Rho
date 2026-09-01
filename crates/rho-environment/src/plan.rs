use std::path::Path;

use rho_protocol::{
    AuthorityDigest, EnvironmentContractError, EnvironmentRoleV1, MaterializedPackagePlanBodyV1,
    MaterializedPackagePlanV1, PackageIntentV1,
};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct EnvironmentPlanInput {
    pub body: MaterializedPackagePlanBodyV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectEnvironmentMode {
    NativeUser,
    ProjectRenv,
}

pub fn classify_project_environment(
    project_root: &Path,
    explicit_renv_adoption: bool,
) -> ProjectEnvironmentMode {
    if explicit_renv_adoption || project_root.join("renv.lock").is_file() {
        ProjectEnvironmentMode::ProjectRenv
    } else {
        ProjectEnvironmentMode::NativeUser
    }
}

pub fn normalize_materialized_plan(
    input: EnvironmentPlanInput,
) -> Result<MaterializedPackagePlanV1, EnvironmentContractError> {
    let body = input.body;
    validate_environment_mode(
        body.environment.role,
        body.intent,
        body.lockfile_action.is_some(),
    )?;
    if body.environment.role == EnvironmentRoleV1::Project {
        match body.intent {
            PackageIntentV1::RestoreLocked => {
                if body.expected_before.repository_profile_digest
                    != repository_profile_digest(&body)?
                {
                    return Err(EnvironmentContractError::Invariant(
                        "restore_locked RepositoryProfile differs from expected desired state"
                            .to_string(),
                    ));
                }
            }
            PackageIntentV1::AddDependency
            | PackageIntentV1::AdoptProjectEnvironment
            | PackageIntentV1::UpdateDependency
            | PackageIntentV1::RemoveDependency => {}
            _ => {}
        }
    }
    MaterializedPackagePlanV1::new(body)
}

fn validate_environment_mode(
    role: EnvironmentRoleV1,
    intent: PackageIntentV1,
    has_lockfile_action: bool,
) -> Result<(), EnvironmentContractError> {
    if role == EnvironmentRoleV1::NativeUser {
        if has_lockfile_action {
            return Err(EnvironmentContractError::Invariant(
                "Native User package plans cannot write a lockfile".to_string(),
            ));
        }
        if !matches!(
            intent,
            PackageIntentV1::InstallUserPackage
                | PackageIntentV1::InstallUnlocked
                | PackageIntentV1::RepairCore
        ) {
            return Err(EnvironmentContractError::Invariant(
                "Native User environment received a Project Renv intent".to_string(),
            ));
        }
    }
    if role == EnvironmentRoleV1::Project
        && matches!(
            intent,
            PackageIntentV1::AddDependency
                | PackageIntentV1::AdoptProjectEnvironment
                | PackageIntentV1::UpdateDependency
                | PackageIntentV1::RemoveDependency
        )
        && !has_lockfile_action
    {
        return Err(EnvironmentContractError::Invariant(
            "Project Renv desired-state mutation requires candidate lockfile action".to_string(),
        ));
    }
    Ok(())
}

fn repository_profile_digest(
    body: &MaterializedPackagePlanBodyV1,
) -> Result<AuthorityDigest, EnvironmentContractError> {
    let bytes = serde_json::to_vec(&body.repository_profile)
        .map_err(|error| EnvironmentContractError::Json(error.to_string()))?;
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| EnvironmentContractError::Invariant(error.to_string()))
}

#[cfg(test)]
mod tests {
    use rho_protocol::{EnvironmentRoleV1, PackageIntentV1};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn boundary_does_not_expose_authority_or_execution() {
        let text = crate::boundary();
        assert!(text.contains("does_not_own"));
        assert!(text.contains("approval"));
        assert!(text.contains("execution"));
    }

    #[test]
    fn native_user_contract_forbids_lockfile_mutation() {
        validate_environment_mode(
            EnvironmentRoleV1::NativeUser,
            PackageIntentV1::InstallUserPackage,
            false,
        )
        .unwrap();
        assert!(
            validate_environment_mode(
                EnvironmentRoleV1::NativeUser,
                PackageIntentV1::InstallUserPackage,
                true,
            )
            .is_err()
        );
        assert!(
            validate_environment_mode(
                EnvironmentRoleV1::NativeUser,
                PackageIntentV1::AdoptProjectEnvironment,
                false,
            )
            .is_err()
        );
        assert!(
            validate_environment_mode(
                EnvironmentRoleV1::Project,
                PackageIntentV1::AddDependency,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn ordinary_projects_remain_native_until_lock_or_explicit_adoption() {
        let project = tempdir().unwrap();
        std::fs::write(project.path().join("analysis.R"), "x <- 1\n").unwrap();
        assert_eq!(
            classify_project_environment(project.path(), false),
            ProjectEnvironmentMode::NativeUser
        );
        assert!(!project.path().join("renv.lock").exists());
        assert_eq!(
            classify_project_environment(project.path(), true),
            ProjectEnvironmentMode::ProjectRenv
        );
        std::fs::write(project.path().join("renv.lock"), "{}\n").unwrap();
        assert_eq!(
            classify_project_environment(project.path(), false),
            ProjectEnvironmentMode::ProjectRenv
        );
    }
}
