use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ContractError, ProjectId, RuntimeCapabilityId, RuntimeInstanceId, RuntimeKindId,
    RuntimeProviderId, SurfaceInstanceId, SurfaceInstanceRequestV1, Validate, encoded_json_len,
    validate_json_value, validate_label, validate_unique,
};

pub const MAX_RUNTIME_ATTACH_CAPABILITIES: usize = 32;
pub const MAX_RUNTIME_PROVIDERS: usize = 16;
pub const MAX_RUNTIME_INSTANCES: usize = 32;
pub const MAX_AUXILIARY_RUNTIMES: u16 = 8;
pub const MAX_RUNTIME_SNAPSHOT_BYTES: usize = 512 * 1024;
pub const MAX_RUNTIME_CODE_BYTES: usize = 1024 * 1024;
pub const MAX_RUNTIME_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_RUNTIME_OUTPUT_EVENTS: usize = 2048;
pub const RUNTIME_REGISTRY_SNAPSHOT_CONTRACT: &str = "rho.ui.runtime-registry.snapshot.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatusV1 {
    Starting,
    Ready,
    Busy,
    Interrupting,
    Restarting,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePersistenceClassV1 {
    ProjectPersistent,
    ApplicationPersistent,
    ExplicitLease,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeBindingV1 {
    pub runtime_provider_id: RuntimeProviderId,
    pub runtime_instance_id: RuntimeInstanceId,
    pub runtime_kind: RuntimeKindId,
    pub project_id: ProjectId,
    pub activation_generation: u64,
    pub state_revision: u64,
    pub attach_capabilities: Vec<RuntimeCapabilityId>,
}

impl Validate for RuntimeBindingV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_binding.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        if self.state_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_binding.state_revision".to_string(),
                reason: "state revision must be positive".to_string(),
            });
        }
        validate_runtime_capabilities(&self.attach_capabilities, "runtime_binding")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeDescriptorV1 {
    pub runtime_provider_id: RuntimeProviderId,
    pub runtime_instance_id: RuntimeInstanceId,
    pub runtime_kind: RuntimeKindId,
    pub project_id: ProjectId,
    pub activation_generation: u64,
    pub state_revision: u64,
    pub status: RuntimeStatusV1,
    pub attach_capabilities: Vec<RuntimeCapabilityId>,
    pub persistence_class: RuntimePersistenceClassV1,
    pub display_label: String,
    pub primary_scientific_runtime: bool,
}

impl RuntimeDescriptorV1 {
    pub fn binding(&self) -> RuntimeBindingV1 {
        RuntimeBindingV1 {
            runtime_provider_id: self.runtime_provider_id.clone(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            runtime_kind: self.runtime_kind.clone(),
            project_id: self.project_id.clone(),
            activation_generation: self.activation_generation,
            state_revision: self.state_revision,
            attach_capabilities: self.attach_capabilities.clone(),
        }
    }
}

impl Validate for RuntimeDescriptorV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.display_label, "runtime.display_label")?;
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        if self.state_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime.state_revision".to_string(),
                reason: "state revision must be positive".to_string(),
            });
        }
        validate_runtime_capabilities(&self.attach_capabilities, "runtime")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeProviderDefinitionV1 {
    pub runtime_provider_id: RuntimeProviderId,
    pub runtime_kind: RuntimeKindId,
    pub display_label: String,
    pub create_supported: bool,
    pub max_instances: u16,
    pub attach_capabilities: Vec<RuntimeCapabilityId>,
    pub application_component_id: crate::ApplicationComponentId,
}

impl Validate for RuntimeProviderDefinitionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.display_label, "runtime_provider.display_label")?;
        if self.max_instances == 0 || usize::from(self.max_instances) > MAX_RUNTIME_INSTANCES {
            return Err(ContractError::InvalidValue {
                path: "runtime_provider.max_instances".to_string(),
                reason: format!("max instances must be 1..={MAX_RUNTIME_INSTANCES}"),
            });
        }
        validate_runtime_capabilities(&self.attach_capabilities, "runtime_provider")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeProviderRegistrationV1 {
    pub definition: RuntimeProviderDefinitionV1,
    pub activation_generation: u64,
}

impl Validate for RuntimeProviderRegistrationV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_provider_registration.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        self.definition.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeRegistrySnapshotV1 {
    pub contract: String,
    pub contract_major: u16,
    pub snapshot_revision: u64,
    pub project_id: ProjectId,
    pub project_revision: u64,
    pub providers: Vec<RuntimeProviderRegistrationV1>,
    pub instances: Vec<RuntimeDescriptorV1>,
}

impl Validate for RuntimeRegistrySnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != RUNTIME_REGISTRY_SNAPSHOT_CONTRACT
            || self.contract_major != crate::RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "runtime_registry.contract".to_string(),
                reason: "unsupported Runtime Registry snapshot contract".to_string(),
            });
        }
        if self.snapshot_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_registry.snapshot_revision".to_string(),
                reason: "snapshot revision must be positive".to_string(),
            });
        }
        if self.providers.len() > MAX_RUNTIME_PROVIDERS {
            return Err(ContractError::LimitExceeded {
                path: "runtime_registry.providers".to_string(),
                limit: MAX_RUNTIME_PROVIDERS,
                actual: self.providers.len(),
            });
        }
        if self.instances.len() > MAX_RUNTIME_INSTANCES {
            return Err(ContractError::LimitExceeded {
                path: "runtime_registry.instances".to_string(),
                limit: MAX_RUNTIME_INSTANCES,
                actual: self.instances.len(),
            });
        }
        validate_unique(
            "runtime_registry.providers",
            self.providers
                .iter()
                .map(|provider| provider.definition.runtime_provider_id.as_str()),
        )?;
        validate_unique(
            "runtime_registry.instances",
            self.instances
                .iter()
                .map(|runtime| runtime.runtime_instance_id.as_str()),
        )?;
        for provider in &self.providers {
            provider.validate()?;
        }
        for runtime in &self.instances {
            runtime.validate()?;
            if runtime.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "runtime_registry.instances.project_id".to_string(),
                    reason: "runtime belongs to another project".to_string(),
                });
            }
            let Some(provider) = self.providers.iter().find(|provider| {
                provider.definition.runtime_provider_id == runtime.runtime_provider_id
            }) else {
                return Err(ContractError::MissingReference {
                    path: "runtime_registry.instances.runtime_provider_id".to_string(),
                    value: runtime.runtime_provider_id.to_string(),
                });
            };
            if provider.definition.runtime_kind != runtime.runtime_kind {
                return Err(ContractError::InvalidValue {
                    path: "runtime_registry.instances".to_string(),
                    reason: "runtime provider kind does not match".to_string(),
                });
            }
        }
        let encoded = encoded_json_len("runtime_registry", self)?;
        if encoded > MAX_RUNTIME_SNAPSHOT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "runtime_registry".to_string(),
                limit: MAX_RUNTIME_SNAPSHOT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeCreateRequestV1 {
    pub project_id: ProjectId,
    pub runtime_provider_id: RuntimeProviderId,
    pub expected_project_revision: u64,
    pub expected_snapshot_revision: u64,
    pub display_label: Option<String>,
}

impl Validate for RuntimeCreateRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.expected_project_revision == 0 || self.expected_snapshot_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_create.revision".to_string(),
                reason: "project and snapshot revisions must be positive".to_string(),
            });
        }
        if let Some(label) = &self.display_label {
            validate_label(label, "runtime_create.display_label")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeInstanceRequestV1 {
    pub project_id: ProjectId,
    pub runtime_provider_id: RuntimeProviderId,
    pub runtime_instance_id: RuntimeInstanceId,
    pub activation_generation: u64,
    pub expected_project_revision: u64,
    pub expected_state_revision: u64,
}

impl Validate for RuntimeInstanceRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_instance_request.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        if self.expected_project_revision == 0 || self.expected_state_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_instance_request.revision".to_string(),
                reason: "project and state revisions must be positive".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeAttachmentRequestV1 {
    pub runtime: RuntimeInstanceRequestV1,
    pub surface: SurfaceInstanceRequestV1,
}

impl Validate for RuntimeAttachmentRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.runtime.validate()?;
        self.surface.validate()?;
        if self.runtime.project_id != self.surface.project_id
            || self.runtime.expected_project_revision != self.surface.expected_project_revision
        {
            return Err(ContractError::InvalidValue {
                path: "runtime_attachment.project_id".to_string(),
                reason: "Runtime and Surface targets must share one exact project revision"
                    .to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeDetachRequestV1 {
    pub surface: SurfaceInstanceRequestV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeExecuteRequestV1 {
    pub runtime: RuntimeInstanceRequestV1,
    pub console_instance_id: SurfaceInstanceId,
    pub expected_console_revision: u64,
    pub code: String,
}

impl Validate for RuntimeExecuteRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.runtime.validate()?;
        if self.expected_console_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_execute.expected_console_revision".to_string(),
                reason: "Console revision must be positive".to_string(),
            });
        }
        if self.code.trim().is_empty() {
            return Err(ContractError::InvalidValue {
                path: "runtime_execute.code".to_string(),
                reason: "code must not be empty".to_string(),
            });
        }
        if self.code.len() > MAX_RUNTIME_CODE_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "runtime_execute.code".to_string(),
                limit: MAX_RUNTIME_CODE_BYTES,
                actual: self.code.len(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeOutputEventV1 {
    pub sequence: u64,
    pub runtime_instance_id: RuntimeInstanceId,
    pub console_instance_id: SurfaceInstanceId,
    pub kind: String,
    pub payload: Value,
}

impl Validate for RuntimeOutputEventV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.sequence == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_output.sequence".to_string(),
                reason: "sequence must be positive".to_string(),
            });
        }
        validate_label(&self.kind, "runtime_output.kind")?;
        validate_json_value(
            "runtime_output.payload",
            &self.payload,
            MAX_RUNTIME_OUTPUT_BYTES,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeExecutionResultV1 {
    pub execution_id: String,
    pub runtime_instance_id: RuntimeInstanceId,
    pub runtime_activation_generation: u64,
    pub console_instance_id: SurfaceInstanceId,
    pub state_revision_after: u64,
    pub status: String,
    pub events: Vec<RuntimeOutputEventV1>,
}

impl Validate for RuntimeExecutionResultV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.execution_id, "runtime_execution.execution_id")?;
        validate_label(&self.status, "runtime_execution.status")?;
        if self.runtime_activation_generation == 0 || self.state_revision_after == 0 {
            return Err(ContractError::InvalidValue {
                path: "runtime_execution.revision".to_string(),
                reason: "runtime generation and state revision must be positive".to_string(),
            });
        }
        if self.events.len() > MAX_RUNTIME_OUTPUT_EVENTS {
            return Err(ContractError::LimitExceeded {
                path: "runtime_execution.events".to_string(),
                limit: MAX_RUNTIME_OUTPUT_EVENTS,
                actual: self.events.len(),
            });
        }
        for event in &self.events {
            event.validate()?;
            if event.runtime_instance_id != self.runtime_instance_id
                || event.console_instance_id != self.console_instance_id
            {
                return Err(ContractError::InvalidValue {
                    path: "runtime_execution.events".to_string(),
                    reason: "output origin does not match execution origin".to_string(),
                });
            }
        }
        let encoded = encoded_json_len("runtime_execution", self)?;
        if encoded > MAX_RUNTIME_OUTPUT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "runtime_execution".to_string(),
                limit: MAX_RUNTIME_OUTPUT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

fn validate_runtime_capabilities(
    capabilities: &[RuntimeCapabilityId],
    path: &str,
) -> Result<(), ContractError> {
    if capabilities.len() > MAX_RUNTIME_ATTACH_CAPABILITIES {
        return Err(ContractError::LimitExceeded {
            path: format!("{path}.attach_capabilities"),
            limit: MAX_RUNTIME_ATTACH_CAPABILITIES,
            actual: capabilities.len(),
        });
    }
    validate_unique(
        &format!("{path}.attach_capabilities"),
        capabilities.iter().map(AsRef::as_ref),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_binding_preserves_exact_runtime_identity() {
        let descriptor = RuntimeDescriptorV1 {
            runtime_provider_id: RuntimeProviderId::new("rho.workspace-r").unwrap(),
            runtime_instance_id: RuntimeInstanceId::new("runtime:workspace").unwrap(),
            runtime_kind: RuntimeKindId::new("r").unwrap(),
            project_id: ProjectId::new("project:a").unwrap(),
            activation_generation: 2,
            state_revision: 9,
            status: RuntimeStatusV1::Ready,
            attach_capabilities: vec![RuntimeCapabilityId::new("console.attach").unwrap()],
            persistence_class: RuntimePersistenceClassV1::ProjectPersistent,
            display_label: "Workspace R".to_string(),
            primary_scientific_runtime: true,
        };
        descriptor.validate().unwrap();
        let binding = descriptor.binding();
        assert_eq!(binding.runtime_instance_id, descriptor.runtime_instance_id);
        assert_eq!(binding.state_revision, 9);
    }

    fn provider() -> RuntimeProviderRegistrationV1 {
        RuntimeProviderRegistrationV1 {
            definition: RuntimeProviderDefinitionV1 {
                runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                runtime_kind: RuntimeKindId::new("r").unwrap(),
                display_label: "Ark R".to_string(),
                create_supported: true,
                max_instances: MAX_AUXILIARY_RUNTIMES,
                attach_capabilities: vec![RuntimeCapabilityId::new("console.attach").unwrap()],
                application_component_id: crate::ApplicationComponentId::new("rho.runtime.ark-r")
                    .unwrap(),
            },
            activation_generation: 2,
        }
    }

    fn registry() -> RuntimeRegistrySnapshotV1 {
        RuntimeRegistrySnapshotV1 {
            contract: RUNTIME_REGISTRY_SNAPSHOT_CONTRACT.to_string(),
            contract_major: crate::RSR_CONTRACT_MAJOR,
            snapshot_revision: 3,
            project_id: ProjectId::new("project:a").unwrap(),
            project_revision: 7,
            providers: vec![provider()],
            instances: vec![RuntimeDescriptorV1 {
                runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                runtime_instance_id: RuntimeInstanceId::new("runtime:workspace-r").unwrap(),
                runtime_kind: RuntimeKindId::new("r").unwrap(),
                project_id: ProjectId::new("project:a").unwrap(),
                activation_generation: 4,
                state_revision: 9,
                status: RuntimeStatusV1::Ready,
                attach_capabilities: vec![RuntimeCapabilityId::new("console.attach").unwrap()],
                persistence_class: RuntimePersistenceClassV1::ProjectPersistent,
                display_label: "Workspace R".to_string(),
                primary_scientific_runtime: true,
            }],
        }
    }

    #[test]
    fn registry_accepts_runtime_generation_independent_of_provider_activation() {
        registry().validate().unwrap();
    }

    #[test]
    fn registry_rejects_cross_project_and_unknown_provider_instances() {
        let mut cross_project = registry();
        cross_project.instances[0].project_id = ProjectId::new("project:b").unwrap();
        assert!(cross_project.validate().is_err());

        let mut unknown = registry();
        unknown.instances[0].runtime_provider_id =
            RuntimeProviderId::new("plugin.unknown").unwrap();
        assert!(unknown.validate().is_err());
    }

    #[test]
    fn execution_rejects_mismatched_output_origin() {
        let mut result = RuntimeExecutionResultV1 {
            execution_id: "execution:1".to_string(),
            runtime_instance_id: RuntimeInstanceId::new("runtime:workspace-r").unwrap(),
            runtime_activation_generation: 1,
            console_instance_id: SurfaceInstanceId::new("instance:console-a").unwrap(),
            state_revision_after: 2,
            status: "completed".to_string(),
            events: vec![RuntimeOutputEventV1 {
                sequence: 1,
                runtime_instance_id: RuntimeInstanceId::new("runtime:workspace-r").unwrap(),
                console_instance_id: SurfaceInstanceId::new("instance:console-a").unwrap(),
                kind: "stdout".to_string(),
                payload: serde_json::json!({"text": "ok"}),
            }],
        };
        result.validate().unwrap();
        result.events[0].console_instance_id =
            SurfaceInstanceId::new("instance:console-b").unwrap();
        assert!(result.validate().is_err());
    }

    #[test]
    fn cancelled_execution_keeps_exact_console_and_runtime_origin() {
        let result = RuntimeExecutionResultV1 {
            execution_id: "execution:cancelled".to_string(),
            runtime_instance_id: RuntimeInstanceId::new("runtime:workspace-r").unwrap(),
            runtime_activation_generation: 3,
            console_instance_id: SurfaceInstanceId::new("instance:console-a").unwrap(),
            state_revision_after: 8,
            status: "cancelled".to_string(),
            events: vec![RuntimeOutputEventV1 {
                sequence: 1,
                runtime_instance_id: RuntimeInstanceId::new("runtime:workspace-r").unwrap(),
                console_instance_id: SurfaceInstanceId::new("instance:console-a").unwrap(),
                kind: "cancelled".to_string(),
                payload: Value::String("interrupted".to_string()),
            }],
        };
        result.validate().unwrap();
    }
}
