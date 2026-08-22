use serde::{Deserialize, Serialize};

use crate::{
    ContractError, ProjectId, ResourceCapabilityId, ResourceKindId, ResourceProviderId, Validate,
    validate_label, validate_opaque_text, validate_unique,
};

pub const MAX_RESOURCE_CAPABILITIES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceBindingV1 {
    pub resource_kind: ResourceKindId,
    pub resource_id: String,
    pub resource_revision: Option<u64>,
}

impl Validate for ResourceBindingV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.resource_id, "resource_binding.resource_id")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceDescriptorV1 {
    pub resource_provider_id: ResourceProviderId,
    pub project_id: ProjectId,
    pub resource_kind: ResourceKindId,
    pub resource_id: String,
    pub resource_revision: u64,
    pub label: String,
    pub capabilities: Vec<ResourceCapabilityId>,
}

impl Validate for ResourceDescriptorV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.resource_id, "resource.resource_id")?;
        validate_label(&self.label, "resource.label")?;
        if self.capabilities.len() > MAX_RESOURCE_CAPABILITIES {
            return Err(ContractError::LimitExceeded {
                path: "resource.capabilities".to_string(),
                limit: MAX_RESOURCE_CAPABILITIES,
                actual: self.capabilities.len(),
            });
        }
        validate_unique(
            "resource.capabilities",
            self.capabilities.iter().map(AsRef::as_ref),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_bindings_are_valid_contract_values() {
        let binding = ResourceBindingV1 {
            resource_kind: ResourceKindId::new("project_file").unwrap(),
            resource_id: "analysis/data.csv".to_string(),
            resource_revision: Some(7),
        };
        binding.validate().unwrap();
        assert_eq!(binding.clone(), binding);
    }
}
