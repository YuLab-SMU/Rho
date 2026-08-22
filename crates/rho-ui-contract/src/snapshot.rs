use serde::{Deserialize, Serialize};

use crate::{
    CommandRegistryV1, ContractError, HealthStateV1, ProjectId, UiContextV1, Validate,
    encoded_json_len, validate_label, validate_opaque_text, validate_purpose,
};

pub const UI_KERNEL_SNAPSHOT_CONTRACT: &str = "rho.ui.kernel.snapshot.v1";
pub const MAX_UI_KERNEL_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiProjectV1 {
    pub project_id: ProjectId,
    pub display_label: String,
    pub display_path: String,
}

impl Validate for UiProjectV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.display_label, "ui_project.display_label")?;
        validate_opaque_text(&self.display_path, "ui_project.display_path")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiHealthDetailV1 {
    pub state: HealthStateV1,
    pub label: String,
    pub detail: Option<String>,
}

impl Validate for UiHealthDetailV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "ui_health.label")?;
        if let Some(detail) = &self.detail {
            validate_purpose(detail, "ui_health.detail")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiHealthSnapshotV1 {
    pub workspace: UiHealthDetailV1,
    pub agent: UiHealthDetailV1,
}

impl Validate for UiHealthSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.workspace.validate()?;
        self.agent.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiKernelSnapshotV1 {
    pub contract: String,
    pub contract_major: u16,
    pub snapshot_revision: u64,
    pub project: UiProjectV1,
    pub context: UiContextV1,
    pub health: UiHealthSnapshotV1,
    pub command_registry: CommandRegistryV1,
}

impl Validate for UiKernelSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != UI_KERNEL_SNAPSHOT_CONTRACT
            || self.contract_major != crate::RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "ui_kernel_snapshot.contract".to_string(),
                reason: "unsupported UI Kernel snapshot contract".to_string(),
            });
        }
        if self.snapshot_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "ui_kernel_snapshot.snapshot_revision".to_string(),
                reason: "snapshot revision must be positive".to_string(),
            });
        }
        if self.project.project_id != self.context.project_id {
            return Err(ContractError::InvalidValue {
                path: "ui_kernel_snapshot.project_id".to_string(),
                reason: "project identity differs from UI Context".to_string(),
            });
        }
        if self.health.workspace.state != self.context.workspace_health
            || self.health.agent.state != self.context.agent_health
        {
            return Err(ContractError::InvalidValue {
                path: "ui_kernel_snapshot.health".to_string(),
                reason: "health detail differs from UI Context".to_string(),
            });
        }
        self.project.validate()?;
        self.context.validate()?;
        self.health.validate()?;
        self.command_registry.validate()?;
        let encoded = encoded_json_len("ui_kernel_snapshot", self)?;
        if encoded > MAX_UI_KERNEL_SNAPSHOT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "ui_kernel_snapshot".to_string(),
                limit: MAX_UI_KERNEL_SNAPSHOT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_rejects_health_or_project_identity_drift() {
        let snapshot = crate::golden_contract_fixture().kernel_snapshot;
        snapshot.validate().unwrap();

        let mut health_drift = snapshot.clone();
        health_drift.health.agent.state = HealthStateV1::Ready;
        assert!(matches!(
            health_drift.validate(),
            Err(ContractError::InvalidValue { .. })
        ));

        let mut project_drift = snapshot;
        project_drift.context.project_id = ProjectId::new("project:other").unwrap();
        assert!(matches!(
            project_drift.validate(),
            Err(ContractError::InvalidValue { .. })
        ));
    }
}
