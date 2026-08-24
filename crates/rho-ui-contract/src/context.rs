use serde::{Deserialize, Serialize};

use crate::{
    BlockId, ContractError, OperationId, PageId, ProjectId, ResourceBindingV1, SceneId,
    SurfaceInstanceId, Validate, validate_label, validate_unique,
};

pub const MAX_ACTIVE_OPERATIONS: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum HealthStateV1 {
    Ready,
    Degraded,
    Unavailable,
    Restarting,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ActiveOperationStateV1 {
    Queued,
    Running,
    Waiting,
    Cancelling,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct ActiveOperationV1 {
    pub operation_id: OperationId,
    pub label: String,
    pub state: ActiveOperationStateV1,
}

impl Validate for ActiveOperationV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "active_operation.label")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiSelectionV1 {
    Resource {
        binding: ResourceBindingV1,
    },
    TextRange {
        binding: ResourceBindingV1,
        #[specta(type = crate::UiIpcNumber)]
        start: u64,
        #[specta(type = crate::UiIpcNumber)]
        end: u64,
    },
    Run {
        run_id: String,
    },
    Artifact {
        artifact_id: String,
    },
    Object {
        object_id: String,
    },
    Finding {
        finding_id: String,
    },
    Task {
        task_id: String,
    },
    VibeBlock {
        page_id: PageId,
        block_id: BlockId,
    },
}

impl Validate for UiSelectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::Resource { binding } => binding.validate(),
            Self::TextRange {
                binding,
                start,
                end,
            } => {
                binding.validate()?;
                if start > end {
                    return Err(ContractError::InvalidValue {
                        path: "selection.text_range".to_string(),
                        reason: "range start is after range end".to_string(),
                    });
                }
                Ok(())
            }
            Self::Run { run_id } => crate::validate_opaque_text(run_id, "selection.run_id"),
            Self::Artifact { artifact_id } => {
                crate::validate_opaque_text(artifact_id, "selection.artifact_id")
            }
            Self::Object { object_id } => {
                crate::validate_opaque_text(object_id, "selection.object_id")
            }
            Self::Finding { finding_id } => {
                crate::validate_opaque_text(finding_id, "selection.finding_id")
            }
            Self::Task { task_id } => crate::validate_opaque_text(task_id, "selection.task_id"),
            Self::VibeBlock { .. } => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct UiContextV1 {
    pub project_id: ProjectId,
    #[specta(type = crate::UiIpcNumber)]
    pub project_revision: u64,
    pub scene_id: Option<SceneId>,
    pub page_id: Option<PageId>,
    pub focused_surface_instance_id: Option<SurfaceInstanceId>,
    pub selection: Option<UiSelectionV1>,
    pub workspace_health: HealthStateV1,
    pub agent_health: HealthStateV1,
    pub active_operations: Vec<ActiveOperationV1>,
}

impl Validate for UiContextV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.scene_id.is_some() && self.page_id.is_some() {
            return Err(ContractError::InvalidValue {
                path: "ui_context".to_string(),
                reason: "Studio Scene and Vibe Page cannot both be active".to_string(),
            });
        }
        if self.active_operations.len() > MAX_ACTIVE_OPERATIONS {
            return Err(ContractError::LimitExceeded {
                path: "ui_context.active_operations".to_string(),
                limit: MAX_ACTIVE_OPERATIONS,
                actual: self.active_operations.len(),
            });
        }
        validate_unique(
            "ui_context.active_operations",
            self.active_operations
                .iter()
                .map(|operation| operation.operation_id.as_ref()),
        )?;
        for operation in &self.active_operations {
            operation.validate()?;
        }
        if let Some(selection) = &self.selection {
            selection.validate()?;
        }
        Ok(())
    }
}
