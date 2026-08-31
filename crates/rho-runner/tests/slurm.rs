use std::collections::BTreeSet;

use rho_protocol::*;
use rho_runner::slurm::*;

fn profile() -> SlurmSubmissionProfile {
    SlurmSubmissionProfile {
        profile_id: "yulab_cpu".to_string(),
        runner_path: "/opt/rho/bin/rho-runner".to_string(),
        runner_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        runner_config_path: "/opt/rho/etc/runner-profile.json".to_string(),
        partitions: BTreeSet::from(["cpu".to_string(), "gpu".to_string()]),
        accounts: BTreeSet::from(["rho".to_string()]),
        max_cpu_cores: 32,
        max_memory_bytes: 128 * 1024 * 1024 * 1024,
        max_gpus: 4,
        max_wall_seconds: 86_400,
    }
}

fn spec() -> ExecutionSpec {
    let mut spec = ExecutionSpec::new(
        ExecutionId::new("execution_slurm_bundle").unwrap(),
        OperationId::new("operation_slurm_bundle").unwrap(),
        ExecutorKind::Slurm,
        vec![
            "analysis".to_string(),
            "--input".to_string(),
            "dataset".to_string(),
        ],
    );
    spec.resources = Some(ResourceRequest {
        cpu_cores: Some(4),
        memory_bytes: Some(8 * 1024 * 1024 * 1024),
        wall_time_seconds: Some(3600),
        gpu_count: Some(0),
        partition: Some("cpu".to_string()),
        account: Some("rho".to_string()),
    });
    spec
}

#[test]
fn slurm_bundle_uses_validated_directives_and_separate_authenticated_spec_file() {
    let spec = spec();
    let bundle = build_slurm_submission(&spec, &profile(), "staging_handle").unwrap();
    let script = String::from_utf8(bundle.script_bytes.clone()).unwrap();
    assert!(script.contains("#SBATCH --cpus-per-task=4"));
    assert!(script.contains("#SBATCH --partition=cpu"));
    assert!(script.contains("#SBATCH --account=rho"));
    assert!(script.contains("#SBATCH --comment=rho-operation-operation_slurm_bundle"));
    assert!(script.contains("$RHO_EXECUTION_SPEC_FILE"));
    assert!(!script.contains("--input"));
    assert!(!script.contains("dataset"));
    assert!(!script.contains("gpu:0"));
    assert_eq!(
        decode_execution_spec_v1(&bundle.spec_bytes, &BTreeSet::new()).unwrap(),
        spec
    );
    assert!(
        submission_bundle_digest(&bundle)
            .as_str()
            .starts_with("sha256:")
    );
}

#[test]
fn slurm_bundle_rejects_unapproved_partition_account_resources_and_mutable_runner() {
    let mut bad = spec();
    bad.resources.as_mut().unwrap().partition = Some("attacker;rm".to_string());
    assert_eq!(
        build_slurm_submission(&bad, &profile(), "staging").unwrap_err(),
        SlurmBundleError::InvalidSpec
    );
    let mut bad = spec();
    bad.resources.as_mut().unwrap().partition = Some("other".to_string());
    assert_eq!(
        build_slurm_submission(&bad, &profile(), "staging").unwrap_err(),
        SlurmBundleError::InvalidResources
    );
    let mut bad_profile = profile();
    bad_profile.runner_digest = "latest".to_string();
    assert_eq!(
        build_slurm_submission(&spec(), &bad_profile, "staging").unwrap_err(),
        SlurmBundleError::InvalidProfile
    );
}

#[test]
fn slurm_bundle_has_no_compute_node_ssh_or_agent_text_interpolation() {
    let script = String::from_utf8(
        build_slurm_submission(&spec(), &profile(), "staging")
            .unwrap()
            .script_bytes,
    )
    .unwrap();
    for forbidden in ["ssh ", "Agent", "user prompt", "eval ", "bash -c"] {
        assert!(!script.contains(forbidden));
    }
    let (_, does_not_own) = slurm_boundary();
    assert!(does_not_own.contains(&"compute_node_ssh"));
    assert!(does_not_own.contains(&"agent_text_interpolation"));
}
