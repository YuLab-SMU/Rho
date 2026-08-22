use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    BlockId, CommandId, ContractError, PageId, PredicateId, ProjectId, ResourceBindingV1, SceneId,
    SurfaceInstanceId, SurfaceOriginV1, Validate, validate_json_value, validate_label,
    validate_purpose, validate_unique,
};

pub const MAX_COMMAND_SCHEMA_BYTES: usize = 64 * 1024;
pub const MAX_COMMAND_PLACEMENT_TAGS: usize = 8;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandPlacementTagV1 {
    Palette,
    SurfaceLocal,
    PrimaryCandidate,
    Menu,
    ContextMenu,
    Keyboard,
}

impl CommandPlacementTagV1 {
    fn key(self) -> &'static str {
        match self {
            Self::Palette => "palette",
            Self::SurfaceLocal => "surface_local",
            Self::PrimaryCandidate => "primary_candidate",
            Self::Menu => "menu",
            Self::ContextMenu => "context_menu",
            Self::Keyboard => "keyboard",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandDefinitionV1 {
    pub command_id: CommandId,
    pub label: String,
    pub purpose: String,
    pub input_schema: Value,
    pub consequence: String,
    pub availability_predicate_id: PredicateId,
    pub placement_tags: Vec<CommandPlacementTagV1>,
    pub origin: SurfaceOriginV1,
}

impl Validate for CommandDefinitionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "command.label")?;
        validate_purpose(&self.purpose, "command.purpose")?;
        validate_purpose(&self.consequence, "command.consequence")?;
        if !self.input_schema.is_object() {
            return Err(ContractError::InvalidValue {
                path: "command.input_schema".to_string(),
                reason: "command input schema must be a JSON object".to_string(),
            });
        }
        validate_json_value(
            "command.input_schema",
            &self.input_schema,
            MAX_COMMAND_SCHEMA_BYTES,
        )?;
        if self.placement_tags.len() > MAX_COMMAND_PLACEMENT_TAGS {
            return Err(ContractError::LimitExceeded {
                path: "command.placement_tags".to_string(),
                limit: MAX_COMMAND_PLACEMENT_TAGS,
                actual: self.placement_tags.len(),
            });
        }
        validate_unique(
            "command.placement_tags",
            self.placement_tags.iter().map(|tag| tag.key()),
        )?;
        self.origin.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CommandAvailabilityV1 {
    Available,
    Unavailable { reason: String },
}

impl Validate for CommandAvailabilityV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if let Self::Unavailable { reason } = self {
            validate_purpose(reason, "command_availability.reason")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommandInvocationV1 {
    pub command_id: CommandId,
    pub project_id: ProjectId,
    pub expected_project_revision: u64,
    pub instance_id: Option<SurfaceInstanceId>,
    pub expected_surface_revision: Option<u64>,
    pub resource_binding: Option<ResourceBindingV1>,
    pub scene_id: Option<SceneId>,
    pub expected_layout_revision: Option<u64>,
    pub page_id: Option<PageId>,
    pub expected_page_revision: Option<u64>,
    pub block_id: Option<BlockId>,
    pub input: Value,
}

impl Validate for CommandInvocationV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.expected_surface_revision.is_some() != self.instance_id.is_some() {
            return Err(ContractError::InvalidValue {
                path: "command_invocation.surface".to_string(),
                reason: "instance and expected Surface revision must be supplied together"
                    .to_string(),
            });
        }
        if self.expected_layout_revision.is_some() != self.scene_id.is_some() {
            return Err(ContractError::InvalidValue {
                path: "command_invocation.scene".to_string(),
                reason: "Scene and expected layout revision must be supplied together".to_string(),
            });
        }
        if self.expected_page_revision.is_some() != self.page_id.is_some() {
            return Err(ContractError::InvalidValue {
                path: "command_invocation.page".to_string(),
                reason: "Page and expected Page revision must be supplied together".to_string(),
            });
        }
        if self.scene_id.is_some() && self.page_id.is_some() {
            return Err(ContractError::InvalidValue {
                path: "command_invocation.placement".to_string(),
                reason: "one invocation cannot mutate Studio and Vibe placement simultaneously"
                    .to_string(),
            });
        }
        if self.block_id.is_some() && self.page_id.is_none() {
            return Err(ContractError::InvalidValue {
                path: "command_invocation.block_id".to_string(),
                reason: "a block reference requires a Page reference".to_string(),
            });
        }
        if let Some(binding) = &self.resource_binding {
            binding.validate()?;
        }
        validate_json_value(
            "command_invocation.input",
            &self.input,
            MAX_COMMAND_SCHEMA_BYTES,
        )
    }
}
