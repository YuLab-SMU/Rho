use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{ArtifactDigest, ExecutionSpec, ResourceRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlurmSubmissionProfile {
    pub profile_id: String,
    pub runner_path: String,
    pub runner_digest: String,
    pub runner_config_path: String,
    pub partitions: BTreeSet<String>,
    pub accounts: BTreeSet<String>,
    pub max_cpu_cores: u32,
    pub max_memory_bytes: u64,
    pub max_gpus: u32,
    pub max_wall_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlurmEffectiveResources {
    pub cpu_cores: u32,
    pub memory_bytes: u64,
    pub gpu_count: u32,
    pub wall_time_seconds: u64,
    pub partition: String,
    pub account: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SlurmSubmissionBundle {
    pub operation_marker: String,
    pub spec_file_name: String,
    pub spec_bytes: Vec<u8>,
    pub spec_digest: ArtifactDigest,
    pub script_file_name: String,
    pub script_bytes: Vec<u8>,
    pub effective_resources: SlurmEffectiveResources,
    pub output_staging_handle: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SlurmBundleError {
    #[error("Slurm profile is invalid")]
    InvalidProfile,
    #[error("Slurm resource request is missing, unsupported, or exceeds profile")]
    InvalidResources,
    #[error("Slurm ExecutionSpec is invalid")]
    InvalidSpec,
}

pub fn build_slurm_submission(
    spec: &ExecutionSpec,
    profile: &SlurmSubmissionProfile,
    output_staging_handle: impl Into<String>,
) -> Result<SlurmSubmissionBundle, SlurmBundleError> {
    if spec.executor != rho_protocol::ExecutorKind::Slurm
        || !valid_digest(&profile.runner_digest)
        || !profile.runner_path.starts_with('/')
        || profile.runner_path.contains("..")
        || !profile.runner_config_path.starts_with('/')
        || profile.runner_config_path.contains("..")
        || !profile.runner_config_path.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '-' | '.')
        })
        || profile.partitions.is_empty()
        || profile.accounts.is_empty()
    {
        return Err(SlurmBundleError::InvalidProfile);
    }
    spec.validate(&BTreeSet::new())
        .map_err(|_| SlurmBundleError::InvalidSpec)?;
    let resources = normalize_resources(
        spec.resources
            .as_ref()
            .ok_or(SlurmBundleError::InvalidResources)?,
        profile,
    )?;
    let spec_bytes = spec
        .canonical_bytes(&BTreeSet::new())
        .map_err(|_| SlurmBundleError::InvalidSpec)?;
    let spec_digest = spec
        .digest(&BTreeSet::new())
        .map_err(|_| SlurmBundleError::InvalidSpec)?;
    let operation_marker = format!("rho-operation-{}", spec.operation_id.as_str());
    let spec_file_name = format!("{}.execution-spec-v1.json", spec.execution_id.as_str());
    let script_file_name = format!("{}.sbatch", spec.execution_id.as_str());
    let mut directives = BTreeMap::from([
        ("account", resources.account.clone()),
        ("cpus-per-task", resources.cpu_cores.to_string()),
        ("gres", format!("gpu:{}", resources.gpu_count)),
        ("mem", resources.memory_bytes.to_string()),
        ("partition", resources.partition.clone()),
        ("time", walltime_hms(resources.wall_time_seconds)),
    ]);
    if resources.gpu_count == 0 {
        directives.remove("gres");
    }
    let mut script = String::from("#!/bin/sh\n");
    for (key, value) in directives {
        script.push_str(&format!("#SBATCH --{key}={value}\n"));
    }
    script.push_str(&format!("#SBATCH --comment={operation_marker}\n"));
    script.push_str("set -eu\n");
    script.push_str("# Dynamic job argv is held only in the authenticated ExecutionSpec file.\n");
    script.push_str(&format!(
        "exec {} --execute-spec-file \"$RHO_EXECUTION_SPEC_FILE\" --expected-digest {} --config {}\n",
        profile.runner_path,
        spec_digest.as_str(),
        profile.runner_config_path
    ));
    Ok(SlurmSubmissionBundle {
        operation_marker,
        spec_file_name,
        spec_bytes,
        spec_digest,
        script_file_name,
        script_bytes: script.into_bytes(),
        effective_resources: resources,
        output_staging_handle: output_staging_handle.into(),
    })
}

fn normalize_resources(
    request: &ResourceRequest,
    profile: &SlurmSubmissionProfile,
) -> Result<SlurmEffectiveResources, SlurmBundleError> {
    let cpu = request
        .cpu_cores
        .ok_or(SlurmBundleError::InvalidResources)?;
    let memory = request
        .memory_bytes
        .ok_or(SlurmBundleError::InvalidResources)?;
    let gpu = request.gpu_count.unwrap_or(0);
    let wall = request
        .wall_time_seconds
        .ok_or(SlurmBundleError::InvalidResources)?;
    let partition = request
        .partition
        .clone()
        .ok_or(SlurmBundleError::InvalidResources)?;
    let account = request
        .account
        .clone()
        .ok_or(SlurmBundleError::InvalidResources)?;
    if cpu == 0
        || cpu > profile.max_cpu_cores
        || memory == 0
        || memory > profile.max_memory_bytes
        || gpu > profile.max_gpus
        || wall == 0
        || wall > profile.max_wall_seconds
        || !profile.partitions.contains(&partition)
        || !profile.accounts.contains(&account)
    {
        return Err(SlurmBundleError::InvalidResources);
    }
    Ok(SlurmEffectiveResources {
        cpu_cores: cpu,
        memory_bytes: memory,
        gpu_count: gpu,
        wall_time_seconds: wall,
        partition,
        account,
    })
}

fn walltime_hms(seconds: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.chars().all(|character| character.is_ascii_hexdigit())
    })
}

pub fn submission_bundle_digest(bundle: &SlurmSubmissionBundle) -> ArtifactDigest {
    let mut hasher = Sha256::new();
    hasher.update(&bundle.spec_bytes);
    hasher.update(&bundle.script_bytes);
    ArtifactDigest::new(format!("sha256:{:x}", hasher.finalize())).expect("sha256")
}

pub fn slurm_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "validated_directives",
            "spec_file",
            "operation_marker",
            "output_staging",
        ],
        &[
            "agent_text_interpolation",
            "arbitrary_login_script",
            "compute_node_ssh",
            "mutable_runner_identity",
        ],
    )
}
