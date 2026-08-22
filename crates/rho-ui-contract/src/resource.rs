use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    ApplicationComponentId, ContractError, ProjectId, RSR_CONTRACT_MAJOR, ResourceCapabilityId,
    ResourceKindId, ResourceProviderId, Validate, encoded_json_len, validate_label,
    validate_opaque_text, validate_unique,
};

pub const MAX_RESOURCE_CAPABILITIES: usize = 32;
pub const MAX_RESOURCE_PROVIDERS: usize = 16;
pub const MAX_RESOURCE_KINDS: usize = 16;
pub const MAX_RESOURCE_INSTANCES: usize = 2_000;
pub const MAX_RESOURCE_SNAPSHOT_BYTES: usize = 1024 * 1024;
pub const MAX_RESOURCE_CONTENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RESOURCE_DOCUMENTS: usize = 128;
pub const RESOURCE_REGISTRY_SNAPSHOT_CONTRACT: &str = "rho.ui.resource-registry.snapshot.v1";
pub const RESOURCE_CONTENT_CONTRACT: &str = "rho.ui.resource-content.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceBindingV1 {
    pub resource_provider_id: ResourceProviderId,
    pub resource_kind: ResourceKindId,
    pub resource_id: String,
    pub resource_revision: Option<u64>,
}

impl Validate for ResourceBindingV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.resource_id, "resource_binding.resource_id")?;
        if self.resource_revision == Some(0) {
            return Err(ContractError::InvalidValue {
                path: "resource_binding.resource_revision".to_string(),
                reason: "resource revision must be positive when present".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceStatusV1 {
    Ready,
    Missing,
    Unsupported,
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
    pub status: ResourceStatusV1,
    pub media_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub content_sha256: Option<String>,
}

impl ResourceDescriptorV1 {
    pub fn binding(&self) -> ResourceBindingV1 {
        ResourceBindingV1 {
            resource_provider_id: self.resource_provider_id.clone(),
            resource_kind: self.resource_kind.clone(),
            resource_id: self.resource_id.clone(),
            resource_revision: Some(self.resource_revision),
        }
    }
}

impl Validate for ResourceDescriptorV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.resource_id, "resource.resource_id")?;
        validate_label(&self.label, "resource.label")?;
        if self.resource_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource.resource_revision".to_string(),
                reason: "resource revision must be positive".to_string(),
            });
        }
        if let Some(media_type) = &self.media_type {
            validate_label(media_type, "resource.media_type")?;
        }
        if let Some(digest) = &self.content_sha256
            && (digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err(ContractError::InvalidValue {
                path: "resource.content_sha256".to_string(),
                reason: "content digest must be lowercase or uppercase SHA-256 hex".to_string(),
            });
        }
        if self.status != ResourceStatusV1::Ready
            && (self.media_type.is_some()
                || self.size_bytes.is_some()
                || self.content_sha256.is_some())
        {
            return Err(ContractError::InvalidValue {
                path: "resource.status".to_string(),
                reason: "missing or unsupported resources cannot claim current content metadata"
                    .to_string(),
            });
        }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceProviderDefinitionV1 {
    pub resource_provider_id: ResourceProviderId,
    pub resource_kinds: Vec<ResourceKindId>,
    pub display_label: String,
    pub capabilities: Vec<ResourceCapabilityId>,
    pub application_component_id: ApplicationComponentId,
}

impl Validate for ResourceProviderDefinitionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.display_label, "resource_provider.display_label")?;
        if self.resource_kinds.is_empty() || self.resource_kinds.len() > MAX_RESOURCE_KINDS {
            return Err(ContractError::InvalidValue {
                path: "resource_provider.resource_kinds".to_string(),
                reason: format!("resource kinds must contain 1..={MAX_RESOURCE_KINDS} entries"),
            });
        }
        validate_unique(
            "resource_provider.resource_kinds",
            self.resource_kinds.iter().map(AsRef::as_ref),
        )?;
        validate_resource_capabilities(&self.capabilities, "resource_provider")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceProviderRegistrationV1 {
    pub definition: ResourceProviderDefinitionV1,
    pub activation_generation: u64,
}

impl Validate for ResourceProviderRegistrationV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.activation_generation == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_provider.activation_generation".to_string(),
                reason: "activation generation must be positive".to_string(),
            });
        }
        self.definition.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceRegistrySnapshotV1 {
    pub contract: String,
    pub contract_major: u16,
    pub snapshot_revision: u64,
    pub project_id: ProjectId,
    pub project_revision: u64,
    pub providers: Vec<ResourceProviderRegistrationV1>,
    pub resources: Vec<ResourceDescriptorV1>,
}

impl Validate for ResourceRegistrySnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != RESOURCE_REGISTRY_SNAPSHOT_CONTRACT
            || self.contract_major != RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "resource_registry.contract".to_string(),
                reason: "unsupported Resource Registry snapshot contract".to_string(),
            });
        }
        if self.snapshot_revision == 0 || self.project_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_registry.revision".to_string(),
                reason: "snapshot and project revisions must be positive".to_string(),
            });
        }
        if self.providers.len() > MAX_RESOURCE_PROVIDERS {
            return Err(ContractError::LimitExceeded {
                path: "resource_registry.providers".to_string(),
                limit: MAX_RESOURCE_PROVIDERS,
                actual: self.providers.len(),
            });
        }
        if self.resources.len() > MAX_RESOURCE_INSTANCES {
            return Err(ContractError::LimitExceeded {
                path: "resource_registry.resources".to_string(),
                limit: MAX_RESOURCE_INSTANCES,
                actual: self.resources.len(),
            });
        }
        validate_unique(
            "resource_registry.providers",
            self.providers
                .iter()
                .map(|provider| provider.definition.resource_provider_id.as_str()),
        )?;
        let mut resource_keys = BTreeSet::new();
        for resource in &self.resources {
            let key = format!(
                "{}:{}:{}",
                resource.resource_provider_id, resource.resource_kind, resource.resource_id
            );
            if !resource_keys.insert(key.clone()) {
                return Err(ContractError::Duplicate {
                    path: "resource_registry.resources".to_string(),
                    value: key,
                });
            }
        }
        for provider in &self.providers {
            provider.validate()?;
        }
        for resource in &self.resources {
            resource.validate()?;
            if resource.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "resource_registry.resources.project_id".to_string(),
                    reason: "resource belongs to another project".to_string(),
                });
            }
            let Some(provider) = self.providers.iter().find(|provider| {
                provider.definition.resource_provider_id == resource.resource_provider_id
            }) else {
                return Err(ContractError::MissingReference {
                    path: "resource_registry.resources.resource_provider_id".to_string(),
                    value: resource.resource_provider_id.to_string(),
                });
            };
            if !provider
                .definition
                .resource_kinds
                .contains(&resource.resource_kind)
            {
                return Err(ContractError::InvalidValue {
                    path: "resource_registry.resources.resource_kind".to_string(),
                    reason: "resource kind is not supplied by its provider".to_string(),
                });
            }
        }
        let encoded = encoded_json_len("resource_registry", self)?;
        if encoded > MAX_RESOURCE_SNAPSHOT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "resource_registry".to_string(),
                limit: MAX_RESOURCE_SNAPSHOT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceTargetV1 {
    pub project_id: ProjectId,
    pub resource_provider_id: ResourceProviderId,
    pub resource_kind: ResourceKindId,
    pub resource_id: String,
    pub expected_project_revision: u64,
    pub expected_resource_revision: u64,
}

impl Validate for ResourceTargetV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.resource_id, "resource_target.resource_id")?;
        if self.expected_project_revision == 0 || self.expected_resource_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_target.revision".to_string(),
                reason: "project and resource revisions must be positive".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceReadConsistencyV1 {
    SharedDocument,
    ImmutableSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceReadRequestV1 {
    pub target: ResourceTargetV1,
    pub consistency: ResourceReadConsistencyV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceResolveRequestV1 {
    pub project_id: ProjectId,
    pub resource_provider_id: ResourceProviderId,
    pub resource_kind: ResourceKindId,
    pub resource_id: String,
    pub expected_project_revision: u64,
    pub expected_snapshot_revision: u64,
}

impl Validate for ResourceResolveRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.resource_id, "resource_resolve.resource_id")?;
        if self.expected_project_revision == 0 || self.expected_snapshot_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_resolve.revision".to_string(),
                reason: "project and snapshot revisions must be positive".to_string(),
            });
        }
        Ok(())
    }
}

impl Validate for ResourceReadRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.target.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceContentV1 {
    pub contract: String,
    pub descriptor: ResourceDescriptorV1,
    pub consistency: ResourceReadConsistencyV1,
    pub document_revision: u64,
    pub base_resource_revision: u64,
    pub dirty: bool,
    pub stale: bool,
    pub content_encoding: String,
    pub content: String,
}

impl Validate for ResourceContentV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != RESOURCE_CONTENT_CONTRACT {
            return Err(ContractError::InvalidValue {
                path: "resource_content.contract".to_string(),
                reason: "unsupported Resource content contract".to_string(),
            });
        }
        self.descriptor.validate()?;
        if self.document_revision == 0 || self.base_resource_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_content.revision".to_string(),
                reason: "document and base revisions must be positive".to_string(),
            });
        }
        validate_label(&self.content_encoding, "resource_content.content_encoding")?;
        validate_resource_content(&self.content, "resource_content.content")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceDraftRequestV1 {
    pub target: ResourceTargetV1,
    pub expected_document_revision: u64,
    pub content: String,
}

impl Validate for ResourceDraftRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.target.validate()?;
        if self.expected_document_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_draft.document_revision".to_string(),
                reason: "document revision must be positive".to_string(),
            });
        }
        validate_resource_content(&self.content, "resource_draft.content")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceSaveRequestV1 {
    pub target: ResourceTargetV1,
    pub expected_document_revision: u64,
}

impl Validate for ResourceSaveRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.target.validate()?;
        if self.expected_document_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "resource_save.document_revision".to_string(),
                reason: "document revision must be positive".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceReloadRequestV1 {
    pub target: ResourceTargetV1,
    pub expected_document_revision: u64,
    pub discard_dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceRenameRequestV1 {
    pub target: ResourceTargetV1,
    pub expected_document_revision: Option<u64>,
    pub new_resource_id: String,
}

impl Validate for ResourceRenameRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.target.validate()?;
        validate_opaque_text(&self.new_resource_id, "resource_rename.new_resource_id")?;
        if self.expected_document_revision == Some(0) {
            return Err(ContractError::InvalidValue {
                path: "resource_rename.document_revision".to_string(),
                reason: "document revision must be positive when present".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceDeleteRequestV1 {
    pub target: ResourceTargetV1,
    pub expected_document_revision: Option<u64>,
    pub discard_dirty: bool,
}

impl Validate for ResourceDeleteRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.target.validate()?;
        if self.expected_document_revision == Some(0) {
            return Err(ContractError::InvalidValue {
                path: "resource_delete.document_revision".to_string(),
                reason: "document revision must be positive when present".to_string(),
            });
        }
        Ok(())
    }
}

impl Validate for ResourceReloadRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        ResourceSaveRequestV1 {
            target: self.target.clone(),
            expected_document_revision: self.expected_document_revision,
        }
        .validate()
    }
}

fn validate_resource_capabilities(
    capabilities: &[ResourceCapabilityId],
    path: &str,
) -> Result<(), ContractError> {
    if capabilities.len() > MAX_RESOURCE_CAPABILITIES {
        return Err(ContractError::LimitExceeded {
            path: format!("{path}.capabilities"),
            limit: MAX_RESOURCE_CAPABILITIES,
            actual: capabilities.len(),
        });
    }
    validate_unique(
        &format!("{path}.capabilities"),
        capabilities.iter().map(AsRef::as_ref),
    )
}

fn validate_resource_content(content: &str, path: &str) -> Result<(), ContractError> {
    let actual = content.len();
    if actual > MAX_RESOURCE_CONTENT_BYTES {
        return Err(ContractError::LimitExceeded {
            path: path.to_string(),
            limit: MAX_RESOURCE_CONTENT_BYTES,
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::golden_contract_fixture;

    #[test]
    fn repeated_bindings_are_valid_contract_values() {
        let binding = ResourceBindingV1 {
            resource_provider_id: ResourceProviderId::new("rho.project-files").unwrap(),
            resource_kind: ResourceKindId::new("project_file").unwrap(),
            resource_id: "analysis/data.csv".to_string(),
            resource_revision: Some(7),
        };
        binding.validate().unwrap();
        assert_eq!(binding.clone(), binding);
    }

    #[test]
    fn content_budget_accepts_the_exact_file_boundary() {
        let fixture = golden_contract_fixture();
        let descriptor = fixture.resources[0].clone();
        let content = |size| ResourceContentV1 {
            contract: RESOURCE_CONTENT_CONTRACT.to_string(),
            descriptor: descriptor.clone(),
            consistency: ResourceReadConsistencyV1::ImmutableSnapshot,
            document_revision: 1,
            base_resource_revision: descriptor.resource_revision,
            dirty: false,
            stale: false,
            content_encoding: "utf-8".to_string(),
            content: "x".repeat(size),
        };
        content(MAX_RESOURCE_CONTENT_BYTES).validate().unwrap();
        assert!(content(MAX_RESOURCE_CONTENT_BYTES + 1).validate().is_err());
    }

    #[test]
    fn registry_rejects_unknown_provider_cross_project_and_duplicate_identity() {
        let fixture = golden_contract_fixture();
        let mut snapshot = fixture.resource_registry_snapshot;
        snapshot.providers.clear();
        assert!(matches!(
            snapshot.validate(),
            Err(ContractError::MissingReference { .. })
        ));

        let mut snapshot = golden_contract_fixture().resource_registry_snapshot;
        snapshot.resources[0].project_id = ProjectId::new("project:other").unwrap();
        assert!(snapshot.validate().is_err());

        let mut snapshot = golden_contract_fixture().resource_registry_snapshot;
        snapshot.resources.push(snapshot.resources[0].clone());
        assert!(matches!(
            snapshot.validate(),
            Err(ContractError::Duplicate { .. })
        ));
    }

    #[test]
    fn unavailable_resources_cannot_claim_current_content_metadata() {
        let mut descriptor = golden_contract_fixture().resources[0].clone();
        descriptor.status = ResourceStatusV1::Missing;
        assert!(descriptor.validate().is_err());
        descriptor.media_type = None;
        descriptor.size_bytes = None;
        descriptor.content_sha256 = None;
        descriptor.validate().unwrap();
    }
}
