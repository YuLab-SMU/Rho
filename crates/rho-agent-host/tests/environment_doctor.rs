use rho_agent_host::{
    AgentEnvironmentAuthorityInput, environment_doctor_capabilities, project_environment_doctor,
};
use rho_protocol::{EnvironmentId, EnvironmentIncidentV1};

#[test]
fn environment_doctor_cites_authority_and_exposes_only_typed_capabilities() {
    let incident = EnvironmentIncidentV1 {
        incident_id: "environment_incident_doctor".to_string(),
        environment_id: EnvironmentId::new("environment_doctor").unwrap(),
        kind: "missing_package".to_string(),
        subject: "DESeq2".to_string(),
        detail: "No loadable installation was observed.".to_string(),
        observed_desired_revision: None,
        observed_realization_revision: None,
        detected_at: "2026-09-01T12:00:00Z".to_string(),
    };
    let projection = project_environment_doctor(AgentEnvironmentAuthorityInput {
        environment_id: Some("environment_doctor".to_string()),
        receipt_id: Some("environment_receipt_doctor".to_string()),
        receipt_outcome: Some("succeeded".to_string()),
        workspace_phase: "blocked_by_incident".to_string(),
        incidents: vec![incident.clone()],
        limitations: vec!["namespace probe failed".to_string()],
    });
    assert!(projection.authority_source.contains("Authority receipt"));
    assert_eq!(projection.incidents, vec![incident]);
    let ids = projection
        .capability_ids
        .iter()
        .map(|id| id.as_str())
        .collect::<Vec<_>>();
    assert!(!ids.contains(&"environment.request_apply_plan"));
    for forbidden in [
        "environment.install",
        "environment.shell",
        "environment.secret",
        "evidence.promote",
    ] {
        assert!(!ids.contains(&forbidden));
    }
    assert_eq!(environment_doctor_capabilities().len(), 4);
}
