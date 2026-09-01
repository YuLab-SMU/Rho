//! Typed Environment context exposed to Agent providers. The projection only
//! cites Authority/Workspace observations; it cannot install, execute shell,
//! resolve secrets or promote Evidence.

use rho_protocol::{
    CapabilityId, ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY, ENVIRONMENT_INSPECT_CAPABILITY,
    ENVIRONMENT_OPERATION_INSPECT_CAPABILITY, ENVIRONMENT_PROPOSE_CHANGE_CAPABILITY,
    EnvironmentIncidentV1,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEnvironmentAuthorityInput {
    pub environment_id: Option<String>,
    pub receipt_id: Option<String>,
    pub receipt_outcome: Option<String>,
    pub workspace_phase: String,
    pub incidents: Vec<EnvironmentIncidentV1>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEnvironmentDoctorProjection {
    pub authority_source: String,
    pub environment_id: Option<String>,
    pub receipt_id: Option<String>,
    pub receipt_outcome: Option<String>,
    pub workspace_phase: String,
    pub incidents: Vec<EnvironmentIncidentV1>,
    pub limitations: Vec<String>,
    pub capability_ids: Vec<CapabilityId>,
}

pub fn environment_doctor_capabilities() -> Vec<CapabilityId> {
    [
        ENVIRONMENT_INSPECT_CAPABILITY,
        ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY,
        ENVIRONMENT_PROPOSE_CHANGE_CAPABILITY,
        ENVIRONMENT_OPERATION_INSPECT_CAPABILITY,
    ]
    .into_iter()
    .map(|id| CapabilityId::new(id).expect("canonical Environment capability ID"))
    .collect()
}

pub fn project_environment_doctor(
    input: AgentEnvironmentAuthorityInput,
) -> AgentEnvironmentDoctorProjection {
    AgentEnvironmentDoctorProjection {
        authority_source: "Environment Authority receipt + live Workspace observation".to_string(),
        environment_id: input.environment_id,
        receipt_id: input.receipt_id,
        receipt_outcome: input.receipt_outcome,
        workspace_phase: input.workspace_phase,
        incidents: input.incidents,
        limitations: input.limitations,
        capability_ids: environment_doctor_capabilities(),
    }
}
