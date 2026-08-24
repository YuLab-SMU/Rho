use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    BlockId, CommandId, ContractError, PageId, PredicateId, ProjectId, ResourceBindingV1, SceneId,
    SurfaceInstanceId, SurfaceOriginV1, Validate, validate_json_value, validate_label,
    validate_purpose, validate_unique,
};

pub const MAX_COMMAND_SCHEMA_BYTES: usize = 64 * 1024;
pub const MAX_COMMAND_PLACEMENT_TAGS: usize = 8;
pub const MAX_REGISTERED_COMMANDS: usize = 512;
pub const MAX_COMMAND_REGISTRY_BYTES: usize = 1024 * 1024;

pub const PREDICATE_ALWAYS: &str = "rho.predicate.always";
pub const PREDICATE_PROJECT_READY: &str = "rho.predicate.project-ready";
pub const PREDICATE_WORKSPACE_PRESENT: &str = "rho.predicate.workspace-present";
pub const PREDICATE_ACTIVE_OPERATION: &str = "rho.predicate.active-operation";
pub const PREDICATE_AGENT_READY: &str = "rho.predicate.agent-ready";
pub const PREDICATE_PLUGIN_READY: &str = "rho.predicate.plugin-ready";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
enum UiContractJsonValue {
    Null(()),
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<UiContractJsonValue>),
    Object(BTreeMap<String, UiContractJsonValue>),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct CommandDefinitionV1 {
    pub command_id: CommandId,
    pub label: String,
    pub purpose: String,
    #[specta(type = UiContractJsonValue)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
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

/// One exact command registration. Availability is presentation state only:
/// execution must still pass the owning broker command's admission checks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct CommandRegistrationV1 {
    pub definition: CommandDefinitionV1,
    #[specta(type = crate::UiIpcNumber)]
    pub activation_generation: u64,
    pub availability: CommandAvailabilityV1,
}

impl Validate for CommandRegistrationV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "command_registration.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        self.definition.validate()?;
        self.availability.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct CommandRegistryV1 {
    pub registrations: Vec<CommandRegistrationV1>,
}

impl CommandRegistryV1 {
    pub fn for_placement(
        &self,
        placement: CommandPlacementTagV1,
    ) -> impl Iterator<Item = &CommandRegistrationV1> {
        self.registrations
            .iter()
            .filter(move |registration| registration.definition.placement_tags.contains(&placement))
    }
}

impl Validate for CommandRegistryV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.registrations.len() > MAX_REGISTERED_COMMANDS {
            return Err(ContractError::LimitExceeded {
                path: "command_registry.registrations".to_string(),
                limit: MAX_REGISTERED_COMMANDS,
                actual: self.registrations.len(),
            });
        }
        validate_unique(
            "command_registry.registrations",
            self.registrations
                .iter()
                .map(|registration| registration.definition.command_id.as_ref()),
        )?;
        for registration in &self.registrations {
            registration.validate()?;
        }
        let encoded = crate::encoded_json_len("command_registry", self)?;
        if encoded > MAX_COMMAND_REGISTRY_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "command_registry".to_string(),
                limit: MAX_COMMAND_REGISTRY_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

fn application_origin(component_id: &str) -> Result<SurfaceOriginV1, ContractError> {
    Ok(SurfaceOriginV1::Application {
        component_id: crate::ApplicationComponentId::new(component_id)?,
    })
}

fn application_command(
    command_id: &str,
    label: &str,
    purpose: &str,
    consequence: &str,
    predicate: &str,
    placements: Vec<CommandPlacementTagV1>,
    component_id: &str,
) -> Result<CommandDefinitionV1, ContractError> {
    Ok(CommandDefinitionV1 {
        command_id: CommandId::new(command_id)?,
        label: label.to_string(),
        purpose: purpose.to_string(),
        input_schema: serde_json::json!({"type": "object", "properties": {}}),
        consequence: consequence.to_string(),
        availability_predicate_id: PredicateId::new(predicate)?,
        placement_tags: placements,
        origin: application_origin(component_id)?,
    })
}

pub fn application_command_definitions_v1() -> Result<Vec<CommandDefinitionV1>, ContractError> {
    use CommandPlacementTagV1::{Keyboard, Menu, Palette, PrimaryCandidate, SurfaceLocal};

    let mut definitions = vec![
        application_command(
            "rho.command.search",
            "Search commands",
            "Find every command registered for the current project and context.",
            "Opens command search without executing a command.",
            PREDICATE_ALWAYS,
            vec![Palette, Menu, Keyboard],
            "rho.shell",
        )?,
        application_command(
            "rho.project.open",
            "Open project",
            "Choose and activate a local Rho project.",
            "Requests a project switch through the existing project transition gate.",
            PREDICATE_ALWAYS,
            vec![Palette, Menu, PrimaryCandidate],
            "rho.project",
        )?,
        application_command(
            "rho.workspace.restart",
            "Restart Workspace R",
            "Recover or replace the authoritative Workspace R process.",
            "Requests a supervised Workspace R restart; open Surfaces do not restart it implicitly.",
            PREDICATE_WORKSPACE_PRESENT,
            vec![Palette, Menu, SurfaceLocal],
            "rho.workspace",
        )?,
        application_command(
            "rho.workspace.interrupt",
            "Interrupt active operation",
            "Interrupt a running scientific operation in the active project.",
            "Requests cancellation through the operation's existing broker-owned lane.",
            PREDICATE_ACTIVE_OPERATION,
            vec![Palette, Menu, Keyboard, SurfaceLocal],
            "rho.workspace",
        )?,
        application_command(
            "rho.check.run",
            "Check project",
            "Review the current saved project snapshot for bounded reproducibility risks.",
            "Captures an immutable read-only project snapshot and opens a typed Check result.",
            PREDICATE_PROJECT_READY,
            vec![Palette, PrimaryCandidate, SurfaceLocal],
            "rho.check",
        )?,
        application_command(
            "rho.agent.new-conversation",
            "New Agent conversation",
            "Start an independent Agent conversation for the active project.",
            "Creates conversation state only after Agent runtime admission succeeds.",
            PREDICATE_AGENT_READY,
            vec![Palette, PrimaryCandidate, SurfaceLocal],
            "rho.agent",
        )?,
    ];
    for (suffix, label, purpose) in [
        (
            "agent",
            "Open Agent",
            "Open another independently bound Agent conversation view.",
        ),
        (
            "console",
            "Open Console",
            "Open another Console attached explicitly to a scientific runtime.",
        ),
        (
            "environment",
            "Open Environment",
            "Open the scientific environment broker view.",
        ),
        (
            "evidence",
            "Open Evidence",
            "Open durable evidence and provenance.",
        ),
        ("git", "Open Git", "Open project source-control state."),
        (
            "runs",
            "Open History",
            "Open scientific execution history and recovery actions.",
        ),
        (
            "artifacts",
            "Open Artifacts",
            "Open durable project outputs.",
        ),
        (
            "problems",
            "Open Problems",
            "Open actionable project diagnostics.",
        ),
        (
            "plots",
            "Open Plots",
            "Open plot artifacts in an independent view.",
        ),
        (
            "logs",
            "Open Logs",
            "Open bounded application and runtime diagnostics.",
        ),
        (
            "render-jobs",
            "Open Render jobs",
            "Open document rendering activity.",
        ),
        ("help", "Open Help", "Open contextual project guidance."),
    ] {
        definitions.push(application_command(
            &format!("rho.surface.open.{suffix}"),
            label,
            purpose,
            "Creates one new Surface instance and places it in the active Studio Scene or Vibe Page.",
            PREDICATE_PROJECT_READY,
            vec![Palette, SurfaceLocal],
            &format!("rho.{suffix}"),
        )?);
    }
    Ok(definitions)
}

pub fn evaluate_application_command_availability_v1(
    definition: &CommandDefinitionV1,
    context: &crate::UiContextV1,
) -> CommandAvailabilityV1 {
    match definition.availability_predicate_id.as_str() {
        PREDICATE_ALWAYS => CommandAvailabilityV1::Available,
        PREDICATE_PROJECT_READY if context.project_revision == 0 => {
            CommandAvailabilityV1::Unavailable {
                reason: "The active project is still being prepared.".to_string(),
            }
        }
        PREDICATE_PROJECT_READY => CommandAvailabilityV1::Available,
        PREDICATE_WORKSPACE_PRESENT
            if context.workspace_health == crate::HealthStateV1::Unavailable =>
        {
            CommandAvailabilityV1::Unavailable {
                reason: "Workspace R is unavailable.".to_string(),
            }
        }
        PREDICATE_WORKSPACE_PRESENT => CommandAvailabilityV1::Available,
        PREDICATE_ACTIVE_OPERATION if context.active_operations.is_empty() => {
            CommandAvailabilityV1::Unavailable {
                reason: "No active operation can be interrupted.".to_string(),
            }
        }
        PREDICATE_ACTIVE_OPERATION => CommandAvailabilityV1::Available,
        PREDICATE_AGENT_READY if context.agent_health != crate::HealthStateV1::Ready => {
            CommandAvailabilityV1::Unavailable {
                reason: "The Agent runtime is not ready.".to_string(),
            }
        }
        PREDICATE_AGENT_READY => CommandAvailabilityV1::Available,
        _ => CommandAvailabilityV1::Unavailable {
            reason: "The command availability predicate is not registered.".to_string(),
        },
    }
}

pub fn application_command_registry_v1(
    context: &crate::UiContextV1,
) -> Result<CommandRegistryV1, ContractError> {
    let mut registrations = application_command_definitions_v1()?
        .into_iter()
        .map(|definition| CommandRegistrationV1 {
            availability: evaluate_application_command_availability_v1(&definition, context),
            definition,
            activation_generation: 1,
        })
        .collect::<Vec<_>>();
    registrations
        .sort_by(|left, right| left.definition.command_id.cmp(&right.definition.command_id));
    let registry = CommandRegistryV1 { registrations };
    registry.validate()?;
    Ok(registry)
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

/// Checks the project-bound portion of an invocation before an owning service
/// performs its stricter Surface/layout/resource admission. This function does
/// not execute a command and placement tags are deliberately absent.
pub fn validate_command_invocation_context_v1(
    invocation: &CommandInvocationV1,
    context: &crate::UiContextV1,
) -> Result<(), ContractError> {
    invocation.validate()?;
    if invocation.project_id != context.project_id {
        return Err(ContractError::InvalidValue {
            path: "command_invocation.project_id".to_string(),
            reason: "invocation belongs to a different project".to_string(),
        });
    }
    crate::ensure_revision(
        "command_invocation.project_revision",
        invocation.expected_project_revision,
        context.project_revision,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HealthStateV1, UiContextV1};

    fn context() -> UiContextV1 {
        UiContextV1 {
            project_id: ProjectId::new("project:a").unwrap(),
            project_revision: 8,
            scene_id: None,
            page_id: None,
            focused_surface_instance_id: None,
            selection: None,
            workspace_health: HealthStateV1::Ready,
            agent_health: HealthStateV1::Degraded,
            active_operations: vec![],
        }
    }

    #[test]
    fn registry_has_exact_identity_and_truthful_unavailable_reasons() {
        let registry = application_command_registry_v1(&context()).unwrap();
        registry.validate().unwrap();
        let agent = registry
            .registrations
            .iter()
            .find(|registration| {
                registration.definition.command_id.as_str() == "rho.agent.new-conversation"
            })
            .unwrap();
        assert_eq!(
            agent.availability,
            CommandAvailabilityV1::Unavailable {
                reason: "The Agent runtime is not ready.".to_string()
            }
        );
        let interrupt = registry
            .registrations
            .iter()
            .find(|registration| {
                registration.definition.command_id.as_str() == "rho.workspace.interrupt"
            })
            .unwrap();
        assert_eq!(
            interrupt.availability,
            CommandAvailabilityV1::Unavailable {
                reason: "No active operation can be interrupted.".to_string()
            }
        );
    }

    #[test]
    fn stale_and_cross_project_invocations_are_rejected_independent_of_placement() {
        let invocation = CommandInvocationV1 {
            command_id: CommandId::new("rho.project.open").unwrap(),
            project_id: ProjectId::new("project:a").unwrap(),
            expected_project_revision: 7,
            instance_id: None,
            expected_surface_revision: None,
            resource_binding: None,
            scene_id: None,
            expected_layout_revision: None,
            page_id: None,
            expected_page_revision: None,
            block_id: None,
            input: serde_json::json!({}),
        };
        assert!(matches!(
            validate_command_invocation_context_v1(&invocation, &context()),
            Err(ContractError::StaleRevision { .. })
        ));
        let mut cross_project = invocation;
        cross_project.expected_project_revision = 8;
        cross_project.project_id = ProjectId::new("project:b").unwrap();
        assert!(matches!(
            validate_command_invocation_context_v1(&cross_project, &context()),
            Err(ContractError::InvalidValue { .. })
        ));
    }

    #[test]
    fn registry_enforces_an_encoded_snapshot_budget() {
        let template = application_command_definitions_v1().unwrap().remove(0);
        let registrations = (0..20)
            .map(|index| {
                let mut definition = template.clone();
                definition.command_id = CommandId::new(format!("rho.large.{index}")).unwrap();
                definition.input_schema = serde_json::json!({
                    "type": "object",
                    "description": "x".repeat(60_000)
                });
                CommandRegistrationV1 {
                    definition,
                    activation_generation: 1,
                    availability: CommandAvailabilityV1::Available,
                }
            })
            .collect();
        assert!(matches!(
            (CommandRegistryV1 { registrations }).validate(),
            Err(ContractError::LimitExceeded {
                path,
                limit: MAX_COMMAND_REGISTRY_BYTES,
                ..
            }) if path == "command_registry"
        ));
    }
}
