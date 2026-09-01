use std::{collections::BTreeMap, path::PathBuf};

use rho_acp_client::{AcpProcessSpec, VerifiedAcpSandbox, boundary};

#[test]
fn acp_client_is_not_an_agent_runtime_or_authority() {
    let boundary = boundary();
    assert!(boundary.owns.contains(&"acp_session_transport"));
    for forbidden in [
        "agent_implementation",
        "model_provider",
        "prompt_loop",
        "tool_harness",
        "policy_authority",
        "project_mutation",
        "store_append",
    ] {
        assert!(boundary.does_not_own.contains(&forbidden));
    }
}

#[test]
fn acp_client_rejects_authoritative_mounts_and_unresolved_executables() {
    let spec = AcpProcessSpec {
        executable: PathBuf::from("codex-acp"),
        arguments: Vec::new(),
        environment: BTreeMap::new(),
        sandbox: VerifiedAcpSandbox {
            working_directory: PathBuf::from("/tmp"),
            authoritative_project_mounted: true,
            workspace_socket_mounted: false,
            store_mounted: false,
            secret_store_mounted: false,
            network_denied: true,
        },
    };
    assert!(spec.validate().is_err());
}
