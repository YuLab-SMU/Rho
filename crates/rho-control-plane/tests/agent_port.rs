use rho_control_plane::*;
use rho_protocol::*;
use serde_json::json;

#[test]
fn agent_port_contract_is_provider_neutral_and_separates_admission_from_terminal_truth() {
    let request = AgentEffectRequest {
        capability_id: CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
        operation_id: OperationId::new("operation_agent_port").unwrap(),
        normalized_arguments: json!({"code":"x <- 1"}),
        depends_on: ExpectedRevisions {
            workspace_id: WorkspaceId::new("workspace_agent_port").unwrap(),
            kernel_instance_id: KernelInstanceId::new("kernel_agent_port").unwrap(),
            state_revision: StateRevision(4),
            project_revision: ProjectRevision(2),
        },
    };
    let encoded = serde_json::to_string(&request).unwrap();
    assert!(!encoded.contains("aisdk"));
    assert!(!encoded.contains("acp"));
    assert!(!encoded.contains("private_thinking"));

    let (_, does_not_own) = agent_port_boundary();
    assert!(does_not_own.contains(&"execution_retry_policy"));
    assert!(does_not_own.contains(&"workspace_mutation"));
}
