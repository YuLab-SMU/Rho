use std::{collections::BTreeMap, path::Path};

use rho_protocol::{
    AuthorityDigest, EnvironmentId, EnvironmentIncidentV1, LibraryLayerV1, LibraryStackV1,
    PackageInstallationV1, RuntimeDistributionV1, RuntimeOwnershipV1, RuntimeRealizationId,
    RuntimeRealizationV1, RuntimeRequirementV1, RuntimeSupportTierV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{EnvironmentProviderError, RuntimeCandidate};

pub const MAX_RIG_INVENTORY_BYTES: usize = 1024 * 1024;
pub const MAX_RIG_INSTALLATIONS: usize = 256;
pub const MAX_LOCAL_PACKAGES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RigInstallationObservation {
    pub name: String,
    pub default: bool,
    pub version: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub path: String,
    pub binary: String,
}

pub fn parse_rig_inventory(
    source: &[u8],
) -> Result<Vec<RigInstallationObservation>, EnvironmentProviderError> {
    if source.len() > MAX_RIG_INVENTORY_BYTES {
        return Err(EnvironmentProviderError::BoundExceeded);
    }
    let mut installations: Vec<RigInstallationObservation> = serde_json::from_slice(source)
        .map_err(|error| EnvironmentProviderError::InvalidInput(error.to_string()))?;
    if installations.len() > MAX_RIG_INSTALLATIONS {
        return Err(EnvironmentProviderError::BoundExceeded);
    }
    for installation in &installations {
        validate_token("rig installation name", &installation.name)?;
        validate_exact_version(&installation.version)?;
        if installation.aliases.len() > 32
            || !Path::new(&installation.path).is_absolute()
            || !Path::new(&installation.binary).is_absolute()
        {
            return Err(EnvironmentProviderError::InvalidInput(
                "rig installation paths or aliases are invalid".to_string(),
            ));
        }
    }
    installations.sort_by(|left, right| {
        left.version
            .cmp(&right.version)
            .then_with(|| left.binary.cmp(&right.binary))
    });
    Ok(installations)
}

pub fn select_exact_rig_installation<'a>(
    installations: &'a [RigInstallationObservation],
    exact_version: &str,
) -> Result<&'a RigInstallationObservation, EnvironmentProviderError> {
    validate_exact_version(exact_version)?;
    let matching = installations
        .iter()
        .filter(|installation| installation.version == exact_version)
        .collect::<Vec<_>>();
    match matching.as_slice() {
        [installation] => Ok(*installation),
        [] => Err(EnvironmentProviderError::Unavailable(format!(
            "exact R {exact_version} is not installed"
        ))),
        _ => Err(EnvironmentProviderError::InvalidInput(format!(
            "exact R {exact_version} is ambiguous"
        ))),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeProbeObservation {
    pub executable: String,
    pub runtime_home: String,
    pub exact_version: String,
    pub platform: String,
    pub architecture: String,
    pub executable_digest: AuthorityDigest,
    pub build_fingerprint: AuthorityDigest,
    pub compiler_fingerprint: Option<AuthorityDigest>,
    pub ownership: RuntimeOwnershipV1,
    pub support_tier: RuntimeSupportTierV1,
}

impl RuntimeProbeObservation {
    pub fn into_candidate(self) -> Result<RuntimeCandidate, EnvironmentProviderError> {
        validate_exact_version(&self.exact_version)?;
        validate_path("runtime executable", &self.executable)?;
        validate_path("runtime home", &self.runtime_home)?;
        validate_token("runtime platform", &self.platform)?;
        validate_token("runtime architecture", &self.architecture)?;
        let identity = digest_json(&self)?;
        Ok(RuntimeCandidate {
            realization: RuntimeRealizationV1 {
                runtime_id: RuntimeRealizationId::new(format!(
                    "runtime_realization_{}",
                    identity.as_str().trim_start_matches("sha256:")
                ))
                .map_err(|error| EnvironmentProviderError::InvalidInput(error.to_string()))?,
                requirement: RuntimeRequirementV1 {
                    distribution: RuntimeDistributionV1::R,
                    exact_version: self.exact_version,
                    platform: self.platform,
                    architecture: self.architecture,
                },
                ownership: self.ownership,
                support_tier: self.support_tier,
                executable: self.executable,
                runtime_home: self.runtime_home,
                executable_digest: self.executable_digest,
                build_fingerprint: self.build_fingerprint,
                compiler_fingerprint: self.compiler_fingerprint,
            },
            observation_digest: identity,
            limitations: Vec::new(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserSessionObservation {
    pub runtime: RuntimeProbeObservation,
    pub library_paths: Vec<String>,
    pub rprofile_digest: Option<AuthorityDigest>,
    pub renviron_digest: Option<AuthorityDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeProbeDifference {
    pub field: String,
    pub controlled: String,
    pub user_session: String,
}

pub fn compare_runtime_probes(
    controlled: &RuntimeProbeObservation,
    user: &UserSessionObservation,
) -> Vec<RuntimeProbeDifference> {
    let mut differences = Vec::new();
    for (field, left, right) in [
        (
            "runtime_home",
            controlled.runtime_home.as_str(),
            user.runtime.runtime_home.as_str(),
        ),
        (
            "exact_version",
            controlled.exact_version.as_str(),
            user.runtime.exact_version.as_str(),
        ),
        (
            "build_fingerprint",
            controlled.build_fingerprint.as_str(),
            user.runtime.build_fingerprint.as_str(),
        ),
    ] {
        if left != right {
            differences.push(RuntimeProbeDifference {
                field: field.to_string(),
                controlled: left.to_string(),
                user_session: right.to_string(),
            });
        }
    }
    differences
}

pub fn build_library_stack(
    mut layers: Vec<LibraryLayerV1>,
) -> Result<LibraryStackV1, EnvironmentProviderError> {
    layers.sort_by_key(|layer| layer.priority);
    LibraryStackV1::new(layers)
        .map_err(|error| EnvironmentProviderError::InvalidInput(error.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalPackageInventory {
    pub installations: Vec<PackageInstallationV1>,
    pub inventory_digest: AuthorityDigest,
    pub incidents: Vec<EnvironmentIncidentV1>,
}

pub fn build_package_inventory(
    environment_id: &EnvironmentId,
    runtime_version: &str,
    layers: &LibraryStackV1,
    mut installations: Vec<PackageInstallationV1>,
    observed_at: &str,
) -> Result<LocalPackageInventory, EnvironmentProviderError> {
    validate_exact_version(runtime_version)?;
    if installations.len() > MAX_LOCAL_PACKAGES {
        return Err(EnvironmentProviderError::BoundExceeded);
    }
    layers
        .validate()
        .map_err(|error| EnvironmentProviderError::InvalidInput(error.to_string()))?;
    let layer_ids = layers
        .ordered_layers
        .iter()
        .map(|layer| layer.layer_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    installations.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.library_layer_id.cmp(&right.library_layer_id))
            .then_with(|| left.version.cmp(&right.version))
    });
    for installation in &installations {
        validate_token("package name", &installation.name)?;
        validate_token("package version", &installation.version)?;
        if !layer_ids.contains(installation.library_layer_id.as_str()) {
            return Err(EnvironmentProviderError::InvalidInput(format!(
                "package {} references an unknown library layer",
                installation.name
            )));
        }
    }
    let mut incidents = Vec::new();
    let mut by_name = BTreeMap::<&str, Vec<&PackageInstallationV1>>::new();
    for installation in &installations {
        by_name
            .entry(&installation.name)
            .or_default()
            .push(installation);
        if installation.built_runtime_version != runtime_version {
            incidents.push(incident(
                environment_id,
                "package_built_for_other_r",
                &installation.name,
                format!(
                    "Package {} was built for R {}, selected R is {}.",
                    installation.name, installation.built_runtime_version, runtime_version
                ),
                observed_at,
            ));
        }
        if !installation.loadable {
            incidents.push(incident(
                environment_id,
                "namespace_load_failure",
                &installation.name,
                format!(
                    "Package {} is not loadable in the selected Runtime.",
                    installation.name
                ),
                observed_at,
            ));
        }
    }
    for (name, candidates) in by_name {
        if candidates.len() > 1 {
            incidents.push(incident(
                environment_id,
                "shadowed_package",
                name,
                format!(
                    "Package {name} is installed in {} library layers.",
                    candidates.len()
                ),
                observed_at,
            ));
        }
    }
    incidents.sort_by(|left, right| left.incident_id.cmp(&right.incident_id));
    let inventory_digest = digest_json(&installations)?;
    Ok(LocalPackageInventory {
        installations,
        inventory_digest,
        incidents,
    })
}

fn incident(
    environment_id: &EnvironmentId,
    kind: &str,
    subject: &str,
    detail: String,
    observed_at: &str,
) -> EnvironmentIncidentV1 {
    let raw = format!("{}:{kind}:{subject}", environment_id.as_str());
    let suffix = format!("{:x}", Sha256::digest(raw.as_bytes()));
    EnvironmentIncidentV1 {
        incident_id: format!("environment_incident_{suffix}"),
        environment_id: environment_id.clone(),
        kind: kind.to_string(),
        subject: subject.to_string(),
        detail,
        observed_desired_revision: None,
        observed_realization_revision: None,
        detected_at: observed_at.to_string(),
    }
}

fn digest_json(value: &impl Serialize) -> Result<AuthorityDigest, EnvironmentProviderError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| EnvironmentProviderError::InvalidInput(error.to_string()))?;
    AuthorityDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| EnvironmentProviderError::InvalidInput(error.to_string()))
}

fn validate_path(label: &str, value: &str) -> Result<(), EnvironmentProviderError> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > 4_096
        || value.chars().any(char::is_control)
        || !Path::new(value).is_absolute()
    {
        return Err(EnvironmentProviderError::InvalidInput(format!(
            "{label} must be one absolute bounded path"
        )));
    }
    Ok(())
}

fn validate_token(label: &str, value: &str) -> Result<(), EnvironmentProviderError> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        return Err(EnvironmentProviderError::InvalidInput(format!(
            "{label} is invalid"
        )));
    }
    Ok(())
}

fn validate_exact_version(value: &str) -> Result<(), EnvironmentProviderError> {
    validate_token("exact version", value)?;
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() < 2
        || parts.len() > 4
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(EnvironmentProviderError::InvalidInput(
            "runtime version must be exact numeric components".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rho_protocol::{LibraryLayerId, LibraryLayerKindV1, LibraryMutabilityV1, LibraryOwnerV1};

    use super::*;

    fn digest(value: char) -> AuthorityDigest {
        AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
    }

    fn probe(version: &str, ownership: RuntimeOwnershipV1) -> RuntimeProbeObservation {
        RuntimeProbeObservation {
            executable: "/Library/Frameworks/R.framework/Resources/bin/Rscript".to_string(),
            runtime_home: "/Library/Frameworks/R.framework/Resources".to_string(),
            exact_version: version.to_string(),
            platform: "darwin".to_string(),
            architecture: "aarch64".to_string(),
            executable_digest: digest('a'),
            build_fingerprint: digest('b'),
            compiler_fingerprint: None,
            ownership,
            support_tier: RuntimeSupportTierV1::Verified,
        }
    }

    #[test]
    fn rig_inventory_selects_exact_version_and_never_alias() {
        let inventory = parse_rig_inventory(
            br#"[{"name":"release","default":true,"version":"4.5.2","aliases":["release"],"path":"/R/4.5","binary":"/R/4.5/R"}]"#,
        )
        .unwrap();
        assert_eq!(
            select_exact_rig_installation(&inventory, "4.5.2")
                .unwrap()
                .version,
            "4.5.2"
        );
        assert!(select_exact_rig_installation(&inventory, "release").is_err());
    }

    #[test]
    fn controlled_and_user_probes_preserve_runtime_differences() {
        let controlled = probe("4.5.2", RuntimeOwnershipV1::System);
        let mut user_runtime = controlled.clone();
        user_runtime.runtime_home = "/opt/conda/lib/R".to_string();
        let user = UserSessionObservation {
            runtime: user_runtime,
            library_paths: vec!["/users/me/R/library".to_string()],
            rprofile_digest: None,
            renviron_digest: None,
        };
        let differences = compare_runtime_probes(&controlled, &user);
        assert_eq!(differences.len(), 1);
        assert_eq!(differences[0].field, "runtime_home");
    }

    #[test]
    fn inventory_keeps_shadowed_installations_and_emits_incidents() {
        let user_layer = LibraryLayerV1 {
            layer_id: LibraryLayerId::new("library_layer_user").unwrap(),
            kind: LibraryLayerKindV1::User,
            owner: LibraryOwnerV1::User,
            mutability: LibraryMutabilityV1::UserWritable,
            canonical_path: "/users/me/R/library".to_string(),
            priority: 1,
            filesystem_identity: "dev:1:inode:1".to_string(),
        };
        let system_layer = LibraryLayerV1 {
            layer_id: LibraryLayerId::new("library_layer_system").unwrap(),
            kind: LibraryLayerKindV1::System,
            owner: LibraryOwnerV1::RDistribution,
            mutability: LibraryMutabilityV1::ReadOnly,
            canonical_path: "/Library/R/library".to_string(),
            priority: 2,
            filesystem_identity: "dev:1:inode:2".to_string(),
        };
        let stack = build_library_stack(vec![system_layer.clone(), user_layer.clone()]).unwrap();
        let installations = vec![
            PackageInstallationV1 {
                name: "jsonlite".to_string(),
                version: "2.0.0".to_string(),
                library_layer_id: user_layer.layer_id,
                built_runtime_version: "4.5.2".to_string(),
                source: "cran".to_string(),
                repository: Some("cran".to_string()),
                native_code: true,
                loadable: true,
            },
            PackageInstallationV1 {
                name: "jsonlite".to_string(),
                version: "1.8.9".to_string(),
                library_layer_id: system_layer.layer_id,
                built_runtime_version: "4.4.0".to_string(),
                source: "distribution".to_string(),
                repository: None,
                native_code: true,
                loadable: true,
            },
        ];
        let inventory = build_package_inventory(
            &EnvironmentId::new("environment_inventory_test").unwrap(),
            "4.5.2",
            &stack,
            installations,
            "2026-09-01T12:00:00Z",
        )
        .unwrap();
        assert_eq!(inventory.installations.len(), 2);
        assert!(
            inventory
                .incidents
                .iter()
                .any(|incident| incident.kind == "shadowed_package")
        );
        assert!(
            inventory
                .incidents
                .iter()
                .any(|incident| incident.kind == "package_built_for_other_r")
        );
    }
}
