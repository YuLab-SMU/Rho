use std::collections::BTreeSet;

use rho_execution::spec::*;
use rho_protocol::*;

fn spec(executor: ExecutorKind, label: &str) -> ExecutionSpec {
    ExecutionSpec::new(
        ExecutionId::new(format!("execution_spec_{label}")).unwrap(),
        OperationId::new(format!("operation_spec_{label}")).unwrap(),
        executor,
        vec!["approved-worker".to_string(), "analysis.R".to_string()],
    )
}

#[test]
fn spec_routes_same_v1_shape_to_local_oci_ssh_and_slurm_without_agent_or_ui_branch() {
    for (executor, route) in [
        (ExecutorKind::LocalProcess, ExecutionAdapterRoute::Local),
        (ExecutorKind::Oci, ExecutionAdapterRoute::Oci),
        (ExecutorKind::SshRunner, ExecutionAdapterRoute::SshRunner),
        (ExecutorKind::Slurm, ExecutionAdapterRoute::Slurm),
    ] {
        let prepared = prepare_adapter_input(
            spec(executor, &format!("{executor:?}").to_ascii_lowercase()),
            &BTreeSet::new(),
        )
        .unwrap();
        assert_eq!(prepared.route, route);
        assert!(prepared.canonical_digest.as_str().starts_with("sha256:"));
        assert_eq!(prepared.spec.schema_version, EXECUTION_SPEC_V1);
    }
}

#[test]
fn spec_unknown_extension_fails_before_adapter_routing() {
    let mut spec = spec(ExecutorKind::SshRunner, "unknown_extension");
    spec.extensions.insert(
        "remote.private_draft".to_string(),
        serde_json::json!({"x":1}),
    );
    assert!(prepare_adapter_input(spec, &BTreeSet::new()).is_err());
}

#[test]
fn spec_boundary_has_no_agent_ui_remote_shell_or_secret_material() {
    let source = include_str!("../src/spec.rs")
        .split("pub fn spec_boundary")
        .next()
        .unwrap();
    for forbidden in ["AgentProvider", "React", "sh -c", "SecretValue"] {
        assert!(!source.contains(forbidden));
    }
    let (_, does_not_own) = spec_boundary();
    assert!(does_not_own.contains(&"agent_provider_branch"));
    assert!(does_not_own.contains(&"remote_shell_string"));
}
