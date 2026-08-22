use serde::{Deserialize, Serialize};

use crate::{
    ContractError, ProjectId, RuntimeCapabilityId, RuntimeInstanceId, RuntimeKindId,
    RuntimeProviderId, Validate, validate_label, validate_unique,
};

pub const MAX_RUNTIME_ATTACH_CAPABILITIES: usize = 32;

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
        validate_runtime_capabilities(&self.attach_capabilities, "runtime")
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
}
