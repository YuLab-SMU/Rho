use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ApplicationComponentId, CommandId, ContractError, PackageDigest, PluginId, ProjectId,
    ResourceBindingV1, ResourceKindId, RuntimeBindingV1, SurfaceId, SurfaceInstanceId,
    SurfaceModeId, Validate, ViewGroupId, ensure_revision, next_revision, validate_json_value,
    validate_label, validate_purpose, validate_unique,
};

pub const MAX_SURFACE_MODES: usize = 32;
pub const MAX_SURFACE_RESOURCE_KINDS: usize = 64;
pub const MAX_SURFACE_COMMANDS: usize = 64;
pub const MAX_SURFACE_ACCEPTED_CONTEXTS: usize = 64;
pub const MAX_SURFACE_PRESENTATION_CLASSES: usize = 3;
pub const MAX_SURFACE_VIEW_STATE_BYTES: usize = 64 * 1024;
pub const MAX_SURFACE_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_LOGICAL_SURFACE_SIZE: u32 = 100_000;
pub const MAX_SURFACE_FACTORIES: usize = 256;
pub const MAX_SURFACE_INSTANCES: usize = 256;
pub const MAX_STRIP_SURFACE_INSTANCES: usize = 128;
pub const MAX_STANDARD_SURFACE_INSTANCES: usize = 128;
pub const MAX_HEAVY_SURFACE_INSTANCES: usize = 32;
pub const MAX_SURFACE_RUNTIME_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
pub const SURFACE_RUNTIME_SNAPSHOT_CONTRACT: &str = "rho.ui.surface-runtime.snapshot.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SurfaceOriginV1 {
    Application {
        component_id: ApplicationComponentId,
    },
    WorkspacePlugin {
        plugin_id: PluginId,
        package_digest: PackageDigest,
    },
}

impl Validate for SurfaceOriginV1 {
    fn validate(&self) -> Result<(), ContractError> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceRendererKindV1 {
    TrustedHost,
    DeclarativeDocument,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceScopeV1 {
    Application,
    Project,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceInstancePolicyV1 {
    Singleton,
    MultiInstance,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceInstanceQuotaClassV1 {
    Strip,
    Standard,
    Heavy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceInteractionKindV1 {
    ReadOnly,
    Interactive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceModeV1 {
    pub mode_id: SurfaceModeId,
    pub label: String,
    pub interaction_kind: SurfaceInteractionKindV1,
}

impl Validate for SurfaceModeV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "surface_mode.label")
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfacePresentationClassV1 {
    Full,
    Compact,
    Strip,
}

impl SurfacePresentationClassV1 {
    fn key(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Compact => "compact",
            Self::Strip => "strip",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceSizingHintsV1 {
    pub min_inline: u32,
    pub min_block: u32,
    pub ideal_inline: Option<u32>,
    pub ideal_block: Option<u32>,
    pub max_inline: Option<u32>,
    pub max_block: Option<u32>,
    pub stretch_inline: bool,
    pub stretch_block: bool,
    pub presentation_classes: Vec<SurfacePresentationClassV1>,
}

impl Validate for SurfaceSizingHintsV1 {
    fn validate(&self) -> Result<(), ContractError> {
        for (path, value) in [
            ("min_inline", Some(self.min_inline)),
            ("min_block", Some(self.min_block)),
            ("ideal_inline", self.ideal_inline),
            ("ideal_block", self.ideal_block),
            ("max_inline", self.max_inline),
            ("max_block", self.max_block),
        ] {
            if value.is_some_and(|value| value > MAX_LOGICAL_SURFACE_SIZE) {
                return Err(ContractError::LimitExceeded {
                    path: format!("surface_sizing.{path}"),
                    limit: MAX_LOGICAL_SURFACE_SIZE as usize,
                    actual: value.unwrap_or_default() as usize,
                });
            }
        }
        for (axis, minimum, ideal, maximum) in [
            (
                "inline",
                self.min_inline,
                self.ideal_inline,
                self.max_inline,
            ),
            ("block", self.min_block, self.ideal_block, self.max_block),
        ] {
            if maximum.is_some_and(|maximum| minimum > maximum)
                || ideal.is_some_and(|ideal| ideal < minimum)
                || ideal
                    .zip(maximum)
                    .is_some_and(|(ideal, maximum)| ideal > maximum)
            {
                return Err(ContractError::InvalidValue {
                    path: format!("surface_sizing.{axis}"),
                    reason: "minimum, ideal, and maximum are not ordered".to_string(),
                });
            }
        }
        if self.presentation_classes.is_empty() {
            return Err(ContractError::InvalidValue {
                path: "surface_sizing.presentation_classes".to_string(),
                reason: "at least one presentation class is required".to_string(),
            });
        }
        if self.presentation_classes.len() > MAX_SURFACE_PRESENTATION_CLASSES {
            return Err(ContractError::LimitExceeded {
                path: "surface_sizing.presentation_classes".to_string(),
                limit: MAX_SURFACE_PRESENTATION_CLASSES,
                actual: self.presentation_classes.len(),
            });
        }
        validate_unique(
            "surface_sizing.presentation_classes",
            self.presentation_classes.iter().map(|class| class.key()),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceDefinitionV1 {
    pub surface_id: SurfaceId,
    pub contract_major: u16,
    pub label: String,
    pub purpose: String,
    pub renderer_kind: SurfaceRendererKindV1,
    pub scope: SurfaceScopeV1,
    pub instance_policy: SurfaceInstancePolicyV1,
    pub instance_quota_class: SurfaceInstanceQuotaClassV1,
    pub resource_kinds: Vec<ResourceKindId>,
    pub modes: Vec<SurfaceModeV1>,
    pub sizing_hints: SurfaceSizingHintsV1,
    pub accepted_contexts: Vec<String>,
    pub commands: Vec<CommandId>,
    pub origin: SurfaceOriginV1,
}

impl Validate for SurfaceDefinitionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract_major == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface.contract_major".to_string(),
                reason: "contract major must be positive".to_string(),
            });
        }
        validate_label(&self.label, "surface.label")?;
        validate_purpose(&self.purpose, "surface.purpose")?;
        if self.resource_kinds.len() > MAX_SURFACE_RESOURCE_KINDS {
            return Err(ContractError::LimitExceeded {
                path: "surface.resource_kinds".to_string(),
                limit: MAX_SURFACE_RESOURCE_KINDS,
                actual: self.resource_kinds.len(),
            });
        }
        if self.modes.len() > MAX_SURFACE_MODES {
            return Err(ContractError::LimitExceeded {
                path: "surface.modes".to_string(),
                limit: MAX_SURFACE_MODES,
                actual: self.modes.len(),
            });
        }
        if self.commands.len() > MAX_SURFACE_COMMANDS {
            return Err(ContractError::LimitExceeded {
                path: "surface.commands".to_string(),
                limit: MAX_SURFACE_COMMANDS,
                actual: self.commands.len(),
            });
        }
        if self.accepted_contexts.len() > MAX_SURFACE_ACCEPTED_CONTEXTS {
            return Err(ContractError::LimitExceeded {
                path: "surface.accepted_contexts".to_string(),
                limit: MAX_SURFACE_ACCEPTED_CONTEXTS,
                actual: self.accepted_contexts.len(),
            });
        }
        validate_unique(
            "surface.resource_kinds",
            self.resource_kinds.iter().map(AsRef::as_ref),
        )?;
        validate_unique(
            "surface.modes",
            self.modes.iter().map(|mode| mode.mode_id.as_ref()),
        )?;
        validate_unique("surface.commands", self.commands.iter().map(AsRef::as_ref))?;
        for mode in &self.modes {
            mode.validate()?;
        }
        for (index, context) in self.accepted_contexts.iter().enumerate() {
            crate::validate_opaque_text(context, &format!("surface.accepted_contexts[{index}]"))?;
        }
        validate_unique(
            "surface.accepted_contexts",
            self.accepted_contexts.iter().map(String::as_str),
        )?;
        self.sizing_hints.validate()?;
        self.origin.validate()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceLifecycleStateV1 {
    Active,
    Hidden,
    Suspended,
    Failed,
    Placeholder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceInstanceV1 {
    pub instance_id: SurfaceInstanceId,
    pub surface_id: SurfaceId,
    pub project_id: ProjectId,
    pub origin: SurfaceOriginV1,
    pub activation_generation: u64,
    pub surface_revision: u64,
    pub mode_id: Option<SurfaceModeId>,
    pub resource_binding: Option<ResourceBindingV1>,
    pub runtime_binding: Option<RuntimeBindingV1>,
    pub view_group_id: Option<ViewGroupId>,
    pub view_state: Value,
    pub lifecycle_state: SurfaceLifecycleStateV1,
}

impl Validate for SurfaceInstanceV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface_instance.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        self.origin.validate()?;
        if let Some(binding) = &self.resource_binding {
            binding.validate()?;
        }
        if let Some(binding) = &self.runtime_binding {
            binding.validate()?;
            if binding.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "surface_instance.runtime_binding.project_id".to_string(),
                    reason: "runtime belongs to a different project".to_string(),
                });
            }
        }
        validate_json_value(
            "surface_instance.view_state",
            &self.view_state,
            MAX_SURFACE_VIEW_STATE_BYTES,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceCatalogV1 {
    pub factories: Vec<SurfaceFactoryRegistrationV1>,
    pub instances: Vec<SurfaceInstanceV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceFactoryRegistrationV1 {
    pub definition: SurfaceDefinitionV1,
    pub activation_generation: u64,
}

impl Validate for SurfaceFactoryRegistrationV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface_factory.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        self.definition.validate()
    }
}

impl Validate for SurfaceCatalogV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_unique(
            "surface_catalog.factories",
            self.factories
                .iter()
                .map(|factory| factory.definition.surface_id.as_ref()),
        )?;
        validate_unique(
            "surface_catalog.instances",
            self.instances
                .iter()
                .map(|instance| instance.instance_id.as_ref()),
        )?;
        if self.factories.len() > MAX_SURFACE_FACTORIES {
            return Err(ContractError::LimitExceeded {
                path: "surface_catalog.factories".to_string(),
                limit: MAX_SURFACE_FACTORIES,
                actual: self.factories.len(),
            });
        }
        if self.instances.len() > MAX_SURFACE_INSTANCES {
            return Err(ContractError::LimitExceeded {
                path: "surface_catalog.instances".to_string(),
                limit: MAX_SURFACE_INSTANCES,
                actual: self.instances.len(),
            });
        }
        let factories = self
            .factories
            .iter()
            .map(|factory| (factory.definition.surface_id.as_str(), factory))
            .collect::<BTreeMap<_, _>>();
        let mut singletons = BTreeSet::new();
        let mut quota_counts = BTreeMap::new();
        for factory in &self.factories {
            factory.validate()?;
        }
        for instance in &self.instances {
            instance.validate()?;
            let Some(factory) = factories.get(instance.surface_id.as_str()) else {
                if instance.lifecycle_state == SurfaceLifecycleStateV1::Placeholder {
                    continue;
                }
                return Err(ContractError::MissingReference {
                    path: "surface_catalog.instances.surface_id".to_string(),
                    value: instance.surface_id.to_string(),
                });
            };
            let definition = &factory.definition;
            if instance.lifecycle_state == SurfaceLifecycleStateV1::Placeholder
                && (instance.activation_generation != factory.activation_generation
                    || instance.origin != definition.origin)
            {
                continue;
            }
            if instance.origin != definition.origin {
                return Err(ContractError::InvalidValue {
                    path: "surface_catalog.instances.origin".to_string(),
                    reason: "instance origin does not match its factory".to_string(),
                });
            }
            if instance.activation_generation != factory.activation_generation
                && instance.lifecycle_state != SurfaceLifecycleStateV1::Placeholder
            {
                return Err(ContractError::StaleRevision {
                    path: "surface_catalog.instances.activation_generation".to_string(),
                    expected: instance.activation_generation,
                    actual: factory.activation_generation,
                });
            }
            if let Some(mode_id) = &instance.mode_id
                && !definition.modes.iter().any(|mode| mode.mode_id == *mode_id)
            {
                return Err(ContractError::MissingReference {
                    path: "surface_catalog.instances.mode_id".to_string(),
                    value: mode_id.to_string(),
                });
            }
            if let Some(binding) = &instance.resource_binding
                && !definition
                    .resource_kinds
                    .iter()
                    .any(|kind| kind == &binding.resource_kind)
            {
                return Err(ContractError::InvalidValue {
                    path: "surface_catalog.instances.resource_binding.resource_kind".to_string(),
                    reason: "factory does not accept this resource kind".to_string(),
                });
            }
            if definition.instance_policy == SurfaceInstancePolicyV1::Singleton
                && instance.lifecycle_state != SurfaceLifecycleStateV1::Placeholder
                && !singletons.insert((instance.project_id.as_str(), instance.surface_id.as_str()))
            {
                return Err(ContractError::Duplicate {
                    path: "surface_catalog.instances.singleton".to_string(),
                    value: format!("{}:{}", instance.project_id, instance.surface_id),
                });
            }
            *quota_counts
                .entry(definition.instance_quota_class)
                .or_insert(0_usize) += 1;
        }
        for (class, limit) in [
            (
                SurfaceInstanceQuotaClassV1::Strip,
                MAX_STRIP_SURFACE_INSTANCES,
            ),
            (
                SurfaceInstanceQuotaClassV1::Standard,
                MAX_STANDARD_SURFACE_INSTANCES,
            ),
            (
                SurfaceInstanceQuotaClassV1::Heavy,
                MAX_HEAVY_SURFACE_INSTANCES,
            ),
        ] {
            let actual = quota_counts.get(&class).copied().unwrap_or_default();
            if actual > limit {
                return Err(ContractError::LimitExceeded {
                    path: format!("surface_catalog.instances.{class:?}"),
                    limit,
                    actual,
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceInstanceDispositionV1 {
    ReuseExact,
    NewInstance,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfacePlacementIntentV1 {
    Current,
    Beside,
    Stack,
    Container,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenSurfaceRequestV1 {
    pub surface_id: SurfaceId,
    pub project_id: ProjectId,
    pub mode_id: Option<SurfaceModeId>,
    pub resource_binding: Option<ResourceBindingV1>,
    pub runtime_binding: Option<RuntimeBindingV1>,
    pub view_group_id: Option<ViewGroupId>,
    pub view_state: Value,
    pub instance_disposition: SurfaceInstanceDispositionV1,
    pub placement_intent: SurfacePlacementIntentV1,
    pub expected_project_revision: u64,
    pub expected_layout_revision: u64,
}

impl Validate for OpenSurfaceRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if let Some(binding) = &self.resource_binding {
            binding.validate()?;
        }
        if let Some(binding) = &self.runtime_binding {
            binding.validate()?;
            if binding.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "open_surface.runtime_binding.project_id".to_string(),
                    reason: "runtime belongs to a different project".to_string(),
                });
            }
        }
        validate_json_value(
            "open_surface.view_state",
            &self.view_state,
            MAX_SURFACE_VIEW_STATE_BYTES,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceInstanceRequestV1 {
    pub project_id: ProjectId,
    pub instance_id: SurfaceInstanceId,
    pub activation_generation: u64,
    pub expected_project_revision: u64,
    pub expected_surface_revision: u64,
}

impl Validate for SurfaceInstanceRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface_instance_request.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateSurfaceRequestV1 {
    pub target: SurfaceInstanceRequestV1,
    pub mutation: SurfaceInstanceMutationV1,
}

impl Validate for UpdateSurfaceRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.target.validate()?;
        match &self.mutation {
            SurfaceInstanceMutationV1::SetViewState { view_state } => validate_json_value(
                "update_surface.view_state",
                view_state,
                MAX_SURFACE_VIEW_STATE_BYTES,
            ),
            SurfaceInstanceMutationV1::BindResource {
                binding: Some(binding),
            } => binding.validate(),
            SurfaceInstanceMutationV1::BindRuntime {
                binding: Some(binding),
            } => binding.validate(),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SurfaceInstanceMutationV1 {
    SetMode { mode_id: Option<SurfaceModeId> },
    SetViewState { view_state: Value },
    SetLifecycle { state: SurfaceLifecycleStateV1 },
    BindResource { binding: Option<ResourceBindingV1> },
    BindRuntime { binding: Option<RuntimeBindingV1> },
    SetViewGroup { view_group_id: Option<ViewGroupId> },
}

pub fn apply_surface_instance_mutation(
    instance: &SurfaceInstanceV1,
    expected_revision: u64,
    mutation: SurfaceInstanceMutationV1,
) -> Result<SurfaceInstanceV1, ContractError> {
    ensure_revision(
        "surface_instance.surface_revision",
        expected_revision,
        instance.surface_revision,
    )?;
    let mut next = instance.clone();
    match mutation {
        SurfaceInstanceMutationV1::SetMode { mode_id } => next.mode_id = mode_id,
        SurfaceInstanceMutationV1::SetViewState { view_state } => next.view_state = view_state,
        SurfaceInstanceMutationV1::SetLifecycle { state } => next.lifecycle_state = state,
        SurfaceInstanceMutationV1::BindResource { binding } => next.resource_binding = binding,
        SurfaceInstanceMutationV1::BindRuntime { binding } => next.runtime_binding = binding,
        SurfaceInstanceMutationV1::SetViewGroup { view_group_id } => {
            next.view_group_id = view_group_id;
        }
    }
    next.surface_revision = next_revision("surface_instance.surface_revision", expected_revision)?;
    next.validate()?;
    Ok(next)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceEventKindV1 {
    Ready,
    Changed,
    Attention,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceRuntimeEventKindV1 {
    Opened,
    Updated,
    Closed,
    Suspended,
    Resumed,
    Reconciled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceRuntimeEventV1 {
    pub event_revision: u64,
    pub project_id: ProjectId,
    pub project_revision: u64,
    pub instance_id: Option<SurfaceInstanceId>,
    pub surface_revision: Option<u64>,
    pub activation_generation: Option<u64>,
    pub kind: SurfaceRuntimeEventKindV1,
}

impl Validate for SurfaceRuntimeEventV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.event_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface_runtime_event.event_revision".to_string(),
                reason: "event revision must be positive".to_string(),
            });
        }
        if self.instance_id.is_some()
            != (self.surface_revision.is_some() && self.activation_generation.is_some())
        {
            return Err(ContractError::InvalidValue {
                path: "surface_runtime_event.instance".to_string(),
                reason: "instance identity, revision, and generation must appear together"
                    .to_string(),
            });
        }
        if self.activation_generation == Some(0) {
            return Err(ContractError::InvalidValue {
                path: "surface_runtime_event.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceRuntimeSnapshotV1 {
    pub contract: String,
    pub contract_major: u16,
    pub snapshot_revision: u64,
    pub project_id: ProjectId,
    pub project_revision: u64,
    pub catalog: SurfaceCatalogV1,
}

impl Validate for SurfaceRuntimeSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != SURFACE_RUNTIME_SNAPSHOT_CONTRACT
            || self.contract_major != crate::RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "surface_runtime_snapshot.contract".to_string(),
                reason: "unsupported Surface Runtime snapshot contract".to_string(),
            });
        }
        if self.snapshot_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface_runtime_snapshot.snapshot_revision".to_string(),
                reason: "snapshot revision must be positive".to_string(),
            });
        }
        self.catalog.validate()?;
        for instance in &self.catalog.instances {
            if instance.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "surface_runtime_snapshot.instances.project_id".to_string(),
                    reason: "surface instance belongs to another project".to_string(),
                });
            }
        }
        let encoded = crate::encoded_json_len("surface_runtime_snapshot", self)?;
        if encoded > MAX_SURFACE_RUNTIME_SNAPSHOT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "surface_runtime_snapshot".to_string(),
                limit: MAX_SURFACE_RUNTIME_SNAPSHOT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceEventV1 {
    pub event_id: crate::OperationId,
    pub project_id: ProjectId,
    pub instance_id: SurfaceInstanceId,
    pub origin: SurfaceOriginV1,
    pub activation_generation: u64,
    pub expected_surface_revision: u64,
    pub expected_resource_revision: Option<u64>,
    pub expected_runtime_state_revision: Option<u64>,
    pub expected_layout_revision: Option<u64>,
    pub expected_page_revision: Option<u64>,
    pub kind: SurfaceEventKindV1,
    pub payload: Value,
}

impl Validate for SurfaceEventV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "surface_event.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        self.origin.validate()?;
        if self.expected_layout_revision.is_some() && self.expected_page_revision.is_some() {
            return Err(ContractError::InvalidValue {
                path: "surface_event.placement_revision".to_string(),
                reason: "one event cannot target Studio and Vibe placements simultaneously"
                    .to_string(),
            });
        }
        validate_json_value(
            "surface_event.payload",
            &self.payload,
            MAX_SURFACE_EVENT_PAYLOAD_BYTES,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance() -> SurfaceInstanceV1 {
        SurfaceInstanceV1 {
            instance_id: SurfaceInstanceId::new("instance:a").unwrap(),
            surface_id: SurfaceId::new("rho.console").unwrap(),
            project_id: ProjectId::new("project:a").unwrap(),
            origin: SurfaceOriginV1::Application {
                component_id: ApplicationComponentId::new("rho.console").unwrap(),
            },
            activation_generation: 1,
            surface_revision: 4,
            mode_id: None,
            resource_binding: None,
            runtime_binding: None,
            view_group_id: None,
            view_state: serde_json::json!({"draft": ""}),
            lifecycle_state: SurfaceLifecycleStateV1::Active,
        }
    }

    fn definition(policy: SurfaceInstancePolicyV1) -> SurfaceDefinitionV1 {
        SurfaceDefinitionV1 {
            surface_id: SurfaceId::new("rho.console").unwrap(),
            contract_major: 1,
            label: "Console".to_string(),
            purpose: "Project runtime console".to_string(),
            renderer_kind: SurfaceRendererKindV1::TrustedHost,
            scope: SurfaceScopeV1::Project,
            instance_policy: policy,
            instance_quota_class: SurfaceInstanceQuotaClassV1::Standard,
            resource_kinds: vec![],
            modes: vec![],
            sizing_hints: SurfaceSizingHintsV1 {
                min_inline: 160,
                min_block: 80,
                ideal_inline: None,
                ideal_block: None,
                max_inline: None,
                max_block: None,
                stretch_inline: true,
                stretch_block: true,
                presentation_classes: vec![SurfacePresentationClassV1::Full],
            },
            accepted_contexts: vec!["project".to_string()],
            commands: vec![],
            origin: SurfaceOriginV1::Application {
                component_id: ApplicationComponentId::new("rho.console").unwrap(),
            },
        }
    }

    #[test]
    fn mutation_is_stale_safe_and_does_not_change_the_input() {
        let original = instance();
        assert!(matches!(
            apply_surface_instance_mutation(
                &original,
                3,
                SurfaceInstanceMutationV1::SetLifecycle {
                    state: SurfaceLifecycleStateV1::Suspended,
                },
            ),
            Err(ContractError::StaleRevision { .. })
        ));
        assert_eq!(original.lifecycle_state, SurfaceLifecycleStateV1::Active);

        let changed = apply_surface_instance_mutation(
            &original,
            4,
            SurfaceInstanceMutationV1::SetLifecycle {
                state: SurfaceLifecycleStateV1::Suspended,
            },
        )
        .unwrap();
        assert_eq!(changed.surface_revision, 5);
        assert_eq!(original.surface_revision, 4);
    }

    #[test]
    fn view_state_and_event_payload_enforce_exact_byte_boundaries() {
        let mut instance = instance();
        instance.view_state =
            serde_json::json!({"value": "x".repeat(MAX_SURFACE_VIEW_STATE_BYTES)});
        assert!(instance.validate().is_err());

        let event = SurfaceEventV1 {
            event_id: crate::OperationId::new("event:1").unwrap(),
            project_id: ProjectId::new("project:a").unwrap(),
            instance_id: SurfaceInstanceId::new("instance:a").unwrap(),
            origin: SurfaceOriginV1::Application {
                component_id: ApplicationComponentId::new("rho.console").unwrap(),
            },
            activation_generation: 1,
            expected_surface_revision: 4,
            expected_resource_revision: None,
            expected_runtime_state_revision: None,
            expected_layout_revision: Some(2),
            expected_page_revision: None,
            kind: SurfaceEventKindV1::Changed,
            payload: serde_json::json!({"value": "ok"}),
        };
        event.validate().unwrap();
        let mut ambiguous = event;
        ambiguous.expected_page_revision = Some(3);
        assert!(ambiguous.validate().is_err());
    }

    #[test]
    fn factory_policy_allows_repeated_multi_instances_but_rejects_singleton_duplicates() {
        let first = instance();
        let mut second = first.clone();
        second.instance_id = SurfaceInstanceId::new("instance:b").unwrap();
        SurfaceCatalogV1 {
            factories: vec![SurfaceFactoryRegistrationV1 {
                definition: definition(SurfaceInstancePolicyV1::MultiInstance),
                activation_generation: 1,
            }],
            instances: vec![first.clone(), second.clone()],
        }
        .validate()
        .unwrap();
        assert!(matches!(
            SurfaceCatalogV1 {
                factories: vec![SurfaceFactoryRegistrationV1 {
                    definition: definition(SurfaceInstancePolicyV1::Singleton),
                    activation_generation: 1,
                }],
                instances: vec![first, second],
            }
            .validate(),
            Err(ContractError::Duplicate { .. })
        ));
    }

    #[test]
    fn replacement_placeholders_may_retain_exact_old_generation_and_origin() {
        let mut stale = instance();
        stale.lifecycle_state = SurfaceLifecycleStateV1::Placeholder;
        let mut replacement = definition(SurfaceInstancePolicyV1::MultiInstance);
        replacement.origin = SurfaceOriginV1::Application {
            component_id: ApplicationComponentId::new("rho.console-next").unwrap(),
        };
        SurfaceCatalogV1 {
            factories: vec![SurfaceFactoryRegistrationV1 {
                definition: replacement.clone(),
                activation_generation: 2,
            }],
            instances: vec![stale.clone()],
        }
        .validate()
        .unwrap();

        stale.lifecycle_state = SurfaceLifecycleStateV1::Active;
        assert!(
            SurfaceCatalogV1 {
                factories: vec![SurfaceFactoryRegistrationV1 {
                    definition: replacement,
                    activation_generation: 2,
                }],
                instances: vec![stale],
            }
            .validate()
            .is_err()
        );
    }
}
