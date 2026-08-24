//! Manifest V3 declarative workspace-plugin Surface factories.
//!
//! This module projects untrusted manifest metadata into the pure RSR Surface
//! contract. Geometry, placement, focus, runtime creation, credentials, and
//! trusted dialogs remain host-owned and are deliberately absent.

use std::collections::BTreeSet;

use rho_ui_contract::{
    MAX_STANDARD_SURFACE_INSTANCES, ResourceKindId, SurfaceDefinitionV1, SurfaceId,
    SurfaceInstancePolicyV1, SurfaceInstanceQuotaClassV1, SurfaceModeV1, SurfaceOriginV1,
    SurfaceRendererKindV1, SurfaceScopeV1, SurfaceSizingHintsV1, Validate,
};
use serde::{Deserialize, Serialize};

use crate::{BoundedJsonSchema, Contribution, PackageDigest, PluginId};

pub const WORKSPACE_SURFACE_CONTRACT_MAJOR: u16 = 1;
pub const MAX_WORKSPACE_SURFACE_RESOURCE_KINDS: usize = 16;

/// Surface-only declaration attached to one `ui.surface.*` contribution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSurfaceDeclarationV1 {
    pub instance_policy: SurfaceInstancePolicyV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_kinds: Vec<ResourceKindId>,
    pub modes: Vec<SurfaceModeV1>,
    pub sizing_hints: SurfaceSizingHintsV1,
    pub event_schema: BoundedJsonSchema,
}

impl WorkspaceSurfaceDeclarationV1 {
    pub fn validate(&self) -> Result<(), String> {
        if self.resource_kinds.len() > MAX_WORKSPACE_SURFACE_RESOURCE_KINDS {
            return Err("workspace Surface resourceKinds exceed their budget".to_string());
        }
        if self.modes.is_empty() {
            return Err("workspace Surface requires at least one mode".to_string());
        }
        let mut resources = BTreeSet::new();
        for resource in &self.resource_kinds {
            if !resources.insert(resource.as_str()) {
                return Err("workspace Surface resourceKinds contain a duplicate".to_string());
            }
        }
        let mut modes = BTreeSet::new();
        for mode in &self.modes {
            mode.validate().map_err(|error| error.to_string())?;
            if !modes.insert(mode.mode_id.as_str()) {
                return Err("workspace Surface modes contain a duplicate".to_string());
            }
        }
        self.sizing_hints
            .validate()
            .map_err(|error| error.to_string())
    }

    /// Convert one exact published contribution into a host-rendered Surface
    /// definition. The quota is fixed by the host, never chosen by the plugin.
    pub fn project_definition(
        &self,
        contribution: &Contribution,
        plugin_id: &PluginId,
        package_digest: &PackageDigest,
    ) -> Result<SurfaceDefinitionV1, String> {
        self.validate()?;
        let contract_major = u16::try_from(contribution.contract_major)
            .map_err(|_| "workspace Surface contractMajor exceeds u16".to_string())?;
        if contract_major != WORKSPACE_SURFACE_CONTRACT_MAJOR {
            return Err("workspace Surface contract major is unsupported".to_string());
        }
        let definition = SurfaceDefinitionV1 {
            surface_id: SurfaceId::new(contribution.capability.as_str())
                .map_err(|error| error.to_string())?,
            contract_major,
            label: contribution.label.clone(),
            purpose: contribution.purpose.clone(),
            icon: contribution.icon.clone(),
            renderer_kind: SurfaceRendererKindV1::DeclarativeDocument,
            scope: SurfaceScopeV1::Project,
            instance_policy: self.instance_policy,
            instance_quota_class: SurfaceInstanceQuotaClassV1::Standard,
            resource_kinds: self.resource_kinds.clone(),
            modes: self.modes.clone(),
            sizing_hints: self.sizing_hints.clone(),
            accepted_contexts: vec!["project".to_string()],
            commands: Vec::new(),
            origin: SurfaceOriginV1::WorkspacePlugin {
                plugin_id: rho_ui_contract::PluginId::new(plugin_id.as_str())
                    .map_err(|error| error.to_string())?,
                package_digest: rho_ui_contract::PackageDigest::new(package_digest.as_str())
                    .map_err(|error| error.to_string())?,
            },
        };
        definition.validate().map_err(|error| error.to_string())?;
        Ok(definition)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceSurfaceProjectionV1 {
    pub definition: SurfaceDefinitionV1,
    pub effective_max_instances: usize,
}

impl WorkspaceSurfaceProjectionV1 {
    pub fn from_contribution(
        contribution: &Contribution,
        plugin_id: &PluginId,
        package_digest: &PackageDigest,
    ) -> Result<Self, String> {
        let surface = contribution
            .surface
            .as_ref()
            .ok_or_else(|| "workspace Surface metadata is missing".to_string())?;
        Ok(Self {
            definition: surface.project_definition(contribution, plugin_id, package_digest)?,
            effective_max_instances: match surface.instance_policy {
                SurfaceInstancePolicyV1::Singleton => 1,
                SurfaceInstancePolicyV1::MultiInstance => MAX_STANDARD_SURFACE_INSTANCES,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{CapabilityId, ContributionKind};
    use rho_ui_contract::{SurfaceInteractionKindV1, SurfaceModeId, SurfacePresentationClassV1};

    fn declaration() -> WorkspaceSurfaceDeclarationV1 {
        WorkspaceSurfaceDeclarationV1 {
            instance_policy: SurfaceInstancePolicyV1::MultiInstance,
            resource_kinds: vec![ResourceKindId::new("project_file").unwrap()],
            modes: vec![SurfaceModeV1 {
                mode_id: SurfaceModeId::new("preview").unwrap(),
                label: "Preview".to_string(),
                interaction_kind: SurfaceInteractionKindV1::Interactive,
            }],
            sizing_hints: SurfaceSizingHintsV1 {
                min_inline: 180,
                min_block: 120,
                ideal_inline: Some(520),
                ideal_block: Some(360),
                max_inline: None,
                max_block: None,
                stretch_inline: true,
                stretch_block: true,
                presentation_classes: vec![SurfacePresentationClassV1::Full],
            },
            event_schema: BoundedJsonSchema::new(json!({
                "type": "object",
                "properties": {"control_id": {"type": "string", "maxLength": 128}},
                "required": ["control_id"]
            }))
            .unwrap(),
        }
    }

    fn contribution() -> Contribution {
        let mut contribution = Contribution::new(
            CapabilityId::new("ui.surface.analysis").unwrap(),
            ContributionKind::Surface,
            "Analysis",
            "Explore an analysis result",
        );
        contribution.surface = Some(declaration());
        contribution
    }

    #[test]
    fn projects_exact_plugin_origin_and_host_owned_quota() {
        let plugin_id = PluginId::new("org.example.analysis").unwrap();
        let digest = PackageDigest::from_inventory(&[(b"plugin.wasm", b"surface")]);
        let projection =
            WorkspaceSurfaceProjectionV1::from_contribution(&contribution(), &plugin_id, &digest)
                .unwrap();
        assert_eq!(
            projection.effective_max_instances,
            MAX_STANDARD_SURFACE_INSTANCES
        );
        assert_eq!(
            projection.definition.renderer_kind,
            SurfaceRendererKindV1::DeclarativeDocument
        );
        assert_eq!(projection.definition.scope, SurfaceScopeV1::Project);
        assert!(matches!(
            projection.definition.origin,
            SurfaceOriginV1::WorkspacePlugin { plugin_id: origin, package_digest }
                if origin.as_str() == plugin_id.as_str() && package_digest.as_str() == digest.as_str()
        ));
    }

    #[test]
    fn rejects_duplicate_resources_modes_and_plugin_chosen_geometry() {
        let mut duplicate_resource = declaration();
        duplicate_resource
            .resource_kinds
            .push(ResourceKindId::new("project_file").unwrap());
        assert!(duplicate_resource.validate().is_err());

        let mut duplicate_mode = declaration();
        duplicate_mode.modes.push(duplicate_mode.modes[0].clone());
        assert!(duplicate_mode.validate().is_err());

        let mut invalid_geometry = declaration();
        invalid_geometry.sizing_hints.min_inline = 600;
        invalid_geometry.sizing_hints.max_inline = Some(500);
        assert!(invalid_geometry.validate().is_err());
    }
}
