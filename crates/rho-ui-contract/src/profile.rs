use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    ContractError, PageId, ProjectId, ResourceBindingV1, RuntimeInstanceId, RuntimeKindId,
    RuntimeProviderId, SceneId, ScenePresetId, SceneStateV1, SurfaceId, SurfaceInstanceId,
    SurfaceModeId, SurfaceOriginV1, Validate, VibeBlockContentV1, VibePageV1, ViewGroupId,
    collect_scene_instance_ids, encoded_json_len, ensure_revision, next_revision,
    validate_json_value, validate_label, validate_text, validate_unique,
};

pub const PROJECT_UI_PROFILE_SCHEMA_VERSION: u16 = 2;
pub const PROJECT_UI_PROFILE_SNAPSHOT_CONTRACT: &str = "rho.ui.project-profile.snapshot.v1";
pub const MAX_UI_PROFILE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_UI_PROFILE_SCENES: usize = 32;
pub const MAX_UI_PROFILE_PAGES: usize = 32;
pub const MAX_UI_PROFILE_SURFACE_SPECS: usize = 256;
pub const MAX_UI_PROFILE_PRESETS: usize = 8;
pub const MAX_UI_PROFILE_RECOVERY_DETAIL_BYTES: usize = 2 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UiProfileModeV1 {
    Studio,
    Vibe,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UiProfileLoadStatusV1 {
    Created,
    Clean,
    RecoveredBackup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeAttachmentIntentV1 {
    pub runtime_provider_id: RuntimeProviderId,
    pub runtime_instance_id: RuntimeInstanceId,
    pub runtime_kind: RuntimeKindId,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SurfaceInstanceSpecV1 {
    pub instance_id: SurfaceInstanceId,
    pub surface_id: SurfaceId,
    pub origin: SurfaceOriginV1,
    pub mode_id: Option<SurfaceModeId>,
    pub resource_binding: Option<ResourceBindingV1>,
    pub runtime_attachment_intent: Option<RuntimeAttachmentIntentV1>,
    pub view_group_id: Option<ViewGroupId>,
    pub view_state: Value,
}

impl Validate for SurfaceInstanceSpecV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.origin.validate()?;
        if let Some(binding) = &self.resource_binding {
            binding.validate()?;
        }
        validate_json_value(
            "surface_instance_spec.view_state",
            &self.view_state,
            crate::MAX_SURFACE_VIEW_STATE_BYTES,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudioScenePresetV1 {
    pub preset_id: ScenePresetId,
    pub label: String,
    pub description: String,
    pub scene: SceneStateV1,
    pub surface_instance_specs: Vec<SurfaceInstanceSpecV1>,
}

impl Validate for StudioScenePresetV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "studio_scene_preset.label")?;
        validate_text(
            &self.description,
            "studio_scene_preset.description",
            4 * 1024,
            false,
            true,
        )?;
        self.scene.validate()?;
        validate_unique(
            "studio_scene_preset.surface_instance_specs",
            self.surface_instance_specs
                .iter()
                .map(|spec| spec.instance_id.as_ref()),
        )?;
        for spec in &self.surface_instance_specs {
            spec.validate()?;
        }
        let available = self
            .surface_instance_specs
            .iter()
            .map(|spec| spec.instance_id.as_str())
            .collect::<BTreeSet<_>>();
        let mut referenced = BTreeSet::new();
        collect_scene_instance_ids(&self.scene, &mut referenced);
        if let Some(missing) = referenced
            .into_iter()
            .find(|instance_id| !available.contains(*instance_id))
        {
            return Err(ContractError::MissingReference {
                path: "studio_scene_preset.surface_instance".to_string(),
                value: missing.to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectUiProfileV1 {
    pub schema_version: u16,
    pub project_id: ProjectId,
    pub revision: u64,
    pub active_mode: UiProfileModeV1,
    pub active_studio_scene_id: Option<SceneId>,
    pub active_vibe_page_id: Option<PageId>,
    pub studio_scenes: Vec<SceneStateV1>,
    pub vibe_pages: Vec<VibePageV1>,
    pub surface_instance_specs: Vec<SurfaceInstanceSpecV1>,
    pub last_focused_surface_instance_id: Option<SurfaceInstanceId>,
}

impl ProjectUiProfileV1 {
    pub fn active_scene(&self) -> Option<&SceneStateV1> {
        let active = self.active_studio_scene_id.as_ref()?;
        self.studio_scenes
            .iter()
            .find(|scene| &scene.scene_id == active)
    }

    pub fn active_page(&self) -> Option<&VibePageV1> {
        let active = self.active_vibe_page_id.as_ref()?;
        self.vibe_pages.iter().find(|page| &page.page_id == active)
    }
}

fn validate_surface_references(profile: &ProjectUiProfileV1) -> Result<(), ContractError> {
    let specs = profile
        .surface_instance_specs
        .iter()
        .map(|spec| spec.instance_id.as_str())
        .collect::<BTreeSet<_>>();
    for scene in &profile.studio_scenes {
        let mut referenced = BTreeSet::new();
        collect_scene_instance_ids(scene, &mut referenced);
        if let Some(missing) = referenced
            .into_iter()
            .find(|instance_id| !specs.contains(*instance_id))
        {
            return Err(ContractError::MissingReference {
                path: "project_ui_profile.studio_scenes.surface_instance".to_string(),
                value: missing.to_string(),
            });
        }
    }
    for page in &profile.vibe_pages {
        for section in &page.sections {
            for block in &section.blocks {
                if let VibeBlockContentV1::SurfaceRef { instance_id, .. } = &block.content
                    && !specs.contains(instance_id.as_str())
                {
                    return Err(ContractError::MissingReference {
                        path: "project_ui_profile.vibe_pages.surface_instance".to_string(),
                        value: instance_id.to_string(),
                    });
                }
            }
        }
    }
    if let Some(focused) = &profile.last_focused_surface_instance_id
        && !specs.contains(focused.as_str())
    {
        return Err(ContractError::MissingReference {
            path: "project_ui_profile.last_focused_surface_instance_id".to_string(),
            value: focused.to_string(),
        });
    }
    Ok(())
}

impl Validate for ProjectUiProfileV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.schema_version != PROJECT_UI_PROFILE_SCHEMA_VERSION {
            return Err(ContractError::InvalidValue {
                path: "project_ui_profile.schema_version".to_string(),
                reason: "unsupported Project UI Profile schema".to_string(),
            });
        }
        if self.revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "project_ui_profile.revision".to_string(),
                reason: "profile revision must be positive".to_string(),
            });
        }
        for (path, actual, limit) in [
            (
                "project_ui_profile.studio_scenes",
                self.studio_scenes.len(),
                MAX_UI_PROFILE_SCENES,
            ),
            (
                "project_ui_profile.vibe_pages",
                self.vibe_pages.len(),
                MAX_UI_PROFILE_PAGES,
            ),
            (
                "project_ui_profile.surface_instance_specs",
                self.surface_instance_specs.len(),
                MAX_UI_PROFILE_SURFACE_SPECS,
            ),
        ] {
            if actual > limit {
                return Err(ContractError::LimitExceeded {
                    path: path.to_string(),
                    limit,
                    actual,
                });
            }
        }
        validate_unique(
            "project_ui_profile.studio_scenes",
            self.studio_scenes
                .iter()
                .map(|scene| scene.scene_id.as_ref()),
        )?;
        validate_unique(
            "project_ui_profile.vibe_pages",
            self.vibe_pages.iter().map(|page| page.page_id.as_ref()),
        )?;
        validate_unique(
            "project_ui_profile.surface_instance_specs",
            self.surface_instance_specs
                .iter()
                .map(|spec| spec.instance_id.as_ref()),
        )?;
        for scene in &self.studio_scenes {
            if scene.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "project_ui_profile.studio_scenes.project_id".to_string(),
                    reason: "Scene belongs to another project".to_string(),
                });
            }
            scene.validate()?;
        }
        for page in &self.vibe_pages {
            if page.project_id != self.project_id {
                return Err(ContractError::InvalidValue {
                    path: "project_ui_profile.vibe_pages.project_id".to_string(),
                    reason: "Page belongs to another project".to_string(),
                });
            }
            page.validate()?;
        }
        for spec in &self.surface_instance_specs {
            spec.validate()?;
        }
        if let Some(active) = &self.active_studio_scene_id
            && !self
                .studio_scenes
                .iter()
                .any(|scene| &scene.scene_id == active)
        {
            return Err(ContractError::MissingReference {
                path: "project_ui_profile.active_studio_scene_id".to_string(),
                value: active.to_string(),
            });
        }
        if let Some(active) = &self.active_vibe_page_id
            && !self.vibe_pages.iter().any(|page| &page.page_id == active)
        {
            return Err(ContractError::MissingReference {
                path: "project_ui_profile.active_vibe_page_id".to_string(),
                value: active.to_string(),
            });
        }
        match self.active_mode {
            UiProfileModeV1::Studio if self.active_studio_scene_id.is_none() => {
                return Err(ContractError::MissingReference {
                    path: "project_ui_profile.active_studio_scene_id".to_string(),
                    value: "active Studio Scene".to_string(),
                });
            }
            UiProfileModeV1::Vibe if self.active_vibe_page_id.is_none() => {
                return Err(ContractError::MissingReference {
                    path: "project_ui_profile.active_vibe_page_id".to_string(),
                    value: "active Vibe Page".to_string(),
                });
            }
            _ => {}
        }
        validate_surface_references(self)?;
        let encoded = encoded_json_len("project_ui_profile", self)?;
        if encoded > MAX_UI_PROFILE_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "project_ui_profile".to_string(),
                limit: MAX_UI_PROFILE_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectUiProfileSnapshotV1 {
    pub contract: String,
    pub contract_major: u16,
    pub profile: ProjectUiProfileV1,
    pub immutable_scene_presets: Vec<StudioScenePresetV1>,
    pub load_status: UiProfileLoadStatusV1,
    pub recovery_detail: Option<String>,
}

impl Validate for ProjectUiProfileSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != PROJECT_UI_PROFILE_SNAPSHOT_CONTRACT
            || self.contract_major != crate::RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "project_ui_profile_snapshot.contract".to_string(),
                reason: "unsupported Project UI Profile snapshot contract".to_string(),
            });
        }
        self.profile.validate()?;
        if self.immutable_scene_presets.len() > MAX_UI_PROFILE_PRESETS {
            return Err(ContractError::LimitExceeded {
                path: "project_ui_profile_snapshot.immutable_scene_presets".to_string(),
                limit: MAX_UI_PROFILE_PRESETS,
                actual: self.immutable_scene_presets.len(),
            });
        }
        validate_unique(
            "project_ui_profile_snapshot.immutable_scene_presets",
            self.immutable_scene_presets
                .iter()
                .map(|preset| preset.preset_id.as_ref()),
        )?;
        for preset in &self.immutable_scene_presets {
            if preset.scene.project_id != self.profile.project_id {
                return Err(ContractError::InvalidValue {
                    path: "project_ui_profile_snapshot.immutable_scene_presets.project_id"
                        .to_string(),
                    reason: "preset belongs to another project".to_string(),
                });
            }
            preset.validate()?;
        }
        if let Some(detail) = &self.recovery_detail {
            validate_text(
                detail,
                "project_ui_profile_snapshot.recovery_detail",
                MAX_UI_PROFILE_RECOVERY_DETAIL_BYTES,
                false,
                true,
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiProfileRevisionRequestV1 {
    pub project_id: ProjectId,
    pub expected_profile_revision: u64,
}

impl Validate for UiProfileRevisionRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.expected_profile_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "ui_profile_request.expected_profile_revision".to_string(),
                reason: "profile revision must be positive".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiProfileMutationV1 {
    SetActiveMode {
        mode: UiProfileModeV1,
    },
    SelectScene {
        scene_id: SceneId,
    },
    SelectPage {
        page_id: PageId,
    },
    ReplaceScene {
        scene: SceneStateV1,
    },
    ReplacePage {
        page: VibePageV1,
    },
    DuplicateScene {
        source_scene_id: SceneId,
        scene: SceneStateV1,
    },
    RenameScene {
        scene_id: SceneId,
        label: String,
    },
    DeleteScene {
        scene_id: SceneId,
        next_active_scene_id: SceneId,
    },
    ResetScene {
        scene_id: SceneId,
        replacement: SceneStateV1,
        restore_surface_instance_specs: Vec<SurfaceInstanceSpecV1>,
    },
    CommitRuntimeState {
        active_scene: Option<SceneStateV1>,
        surface_instance_specs: Vec<SurfaceInstanceSpecV1>,
        last_focused_surface_instance_id: Option<SurfaceInstanceId>,
    },
}

pub fn apply_ui_profile_mutation(
    profile: &ProjectUiProfileV1,
    expected_revision: u64,
    mutation: UiProfileMutationV1,
) -> Result<ProjectUiProfileV1, ContractError> {
    ensure_revision(
        "project_ui_profile.revision",
        expected_revision,
        profile.revision,
    )?;
    let mut next = profile.clone();
    match mutation {
        UiProfileMutationV1::SetActiveMode { mode } => next.active_mode = mode,
        UiProfileMutationV1::SelectScene { scene_id } => {
            next.active_studio_scene_id = Some(scene_id);
        }
        UiProfileMutationV1::SelectPage { page_id } => {
            next.active_vibe_page_id = Some(page_id);
        }
        UiProfileMutationV1::ReplaceScene { scene } => {
            let target = next
                .studio_scenes
                .iter_mut()
                .find(|candidate| candidate.scene_id == scene.scene_id)
                .ok_or_else(|| ContractError::MissingReference {
                    path: "ui_profile_mutation.scene_id".to_string(),
                    value: scene.scene_id.to_string(),
                })?;
            *target = scene;
        }
        UiProfileMutationV1::ReplacePage { page } => {
            let target = next
                .vibe_pages
                .iter_mut()
                .find(|candidate| candidate.page_id == page.page_id)
                .ok_or_else(|| ContractError::MissingReference {
                    path: "ui_profile_mutation.page_id".to_string(),
                    value: page.page_id.to_string(),
                })?;
            *target = page;
        }
        UiProfileMutationV1::DuplicateScene {
            source_scene_id,
            scene,
        } => {
            if !next
                .studio_scenes
                .iter()
                .any(|candidate| candidate.scene_id == source_scene_id)
            {
                return Err(ContractError::MissingReference {
                    path: "ui_profile_mutation.source_scene_id".to_string(),
                    value: source_scene_id.to_string(),
                });
            }
            if next
                .studio_scenes
                .iter()
                .any(|candidate| candidate.scene_id == scene.scene_id)
            {
                return Err(ContractError::Duplicate {
                    path: "ui_profile_mutation.scene_id".to_string(),
                    value: scene.scene_id.to_string(),
                });
            }
            next.active_studio_scene_id = Some(scene.scene_id.clone());
            next.studio_scenes.push(scene);
        }
        UiProfileMutationV1::RenameScene { scene_id, label } => {
            validate_label(&label, "ui_profile_mutation.scene_label")?;
            let scene = next
                .studio_scenes
                .iter_mut()
                .find(|scene| scene.scene_id == scene_id)
                .ok_or_else(|| ContractError::MissingReference {
                    path: "ui_profile_mutation.scene_id".to_string(),
                    value: scene_id.to_string(),
                })?;
            scene.label = label;
        }
        UiProfileMutationV1::DeleteScene {
            scene_id,
            next_active_scene_id,
        } => {
            if scene_id == next_active_scene_id {
                return Err(ContractError::InvalidValue {
                    path: "ui_profile_mutation.next_active_scene_id".to_string(),
                    reason: "deleted Scene cannot remain active".to_string(),
                });
            }
            if !next
                .studio_scenes
                .iter()
                .any(|scene| scene.scene_id == next_active_scene_id)
            {
                return Err(ContractError::MissingReference {
                    path: "ui_profile_mutation.next_active_scene_id".to_string(),
                    value: next_active_scene_id.to_string(),
                });
            }
            let before = next.studio_scenes.len();
            next.studio_scenes
                .retain(|scene| scene.scene_id != scene_id);
            if next.studio_scenes.len() == before {
                return Err(ContractError::MissingReference {
                    path: "ui_profile_mutation.scene_id".to_string(),
                    value: scene_id.to_string(),
                });
            }
            next.active_studio_scene_id = Some(next_active_scene_id);
        }
        UiProfileMutationV1::ResetScene {
            scene_id,
            replacement,
            restore_surface_instance_specs,
        } => {
            if replacement.scene_id != scene_id {
                return Err(ContractError::InvalidValue {
                    path: "ui_profile_mutation.replacement.scene_id".to_string(),
                    reason: "reset must preserve the user Scene identity".to_string(),
                });
            }
            let target = next
                .studio_scenes
                .iter_mut()
                .find(|scene| scene.scene_id == scene_id)
                .ok_or_else(|| ContractError::MissingReference {
                    path: "ui_profile_mutation.scene_id".to_string(),
                    value: scene_id.to_string(),
                })?;
            *target = replacement;
            for spec in restore_surface_instance_specs {
                if let Some(existing) = next
                    .surface_instance_specs
                    .iter_mut()
                    .find(|existing| existing.instance_id == spec.instance_id)
                {
                    *existing = spec;
                } else {
                    next.surface_instance_specs.push(spec);
                }
            }
        }
        UiProfileMutationV1::CommitRuntimeState {
            active_scene,
            surface_instance_specs,
            last_focused_surface_instance_id,
        } => {
            if let Some(scene) = active_scene {
                let target = next
                    .studio_scenes
                    .iter_mut()
                    .find(|candidate| candidate.scene_id == scene.scene_id)
                    .ok_or_else(|| ContractError::MissingReference {
                        path: "ui_profile_mutation.active_scene".to_string(),
                        value: scene.scene_id.to_string(),
                    })?;
                *target = scene;
            }
            next.surface_instance_specs = surface_instance_specs;
            next.last_focused_surface_instance_id = last_focused_surface_instance_id;
        }
    }
    next.revision = next_revision("project_ui_profile.revision", expected_revision)?;
    next.validate()?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LayoutAxisV1, LayoutNodeId, LayoutNodeV1, SceneStateV1, SurfaceOriginV1};

    fn scene(project_id: &ProjectId, scene_id: &str, instance_id: &str) -> SceneStateV1 {
        SceneStateV1 {
            scene_id: SceneId::new(scene_id).unwrap(),
            project_id: project_id.clone(),
            label: scene_id.to_string(),
            layout_revision: 1,
            root: LayoutNodeV1::Surface {
                node_id: LayoutNodeId::new(format!("node:{scene_id}")).unwrap(),
                instance_id: SurfaceInstanceId::new(instance_id).unwrap(),
            },
            focused_surface_instance_id: Some(SurfaceInstanceId::new(instance_id).unwrap()),
            utility_tray: None,
        }
    }

    fn profile() -> ProjectUiProfileV1 {
        let project_id = ProjectId::new("project:a").unwrap();
        let instance_id = SurfaceInstanceId::new("instance:a").unwrap();
        ProjectUiProfileV1 {
            schema_version: PROJECT_UI_PROFILE_SCHEMA_VERSION,
            project_id: project_id.clone(),
            revision: 3,
            active_mode: UiProfileModeV1::Studio,
            active_studio_scene_id: Some(SceneId::new("scene:a").unwrap()),
            active_vibe_page_id: None,
            studio_scenes: vec![scene(&project_id, "scene:a", "instance:a")],
            vibe_pages: vec![],
            surface_instance_specs: vec![SurfaceInstanceSpecV1 {
                instance_id: instance_id.clone(),
                surface_id: SurfaceId::new("rho.fixture").unwrap(),
                origin: SurfaceOriginV1::Application {
                    component_id: crate::ApplicationComponentId::new("rho.fixture").unwrap(),
                },
                mode_id: None,
                resource_binding: None,
                runtime_attachment_intent: None,
                view_group_id: None,
                view_state: serde_json::json!({}),
            }],
            last_focused_surface_instance_id: Some(instance_id),
        }
    }

    #[test]
    fn profile_rejects_cross_project_missing_and_duplicate_references() {
        let mut candidate = profile();
        candidate.validate().unwrap();
        candidate.studio_scenes[0].project_id = ProjectId::new("project:b").unwrap();
        assert!(candidate.validate().is_err());
        let mut candidate = profile();
        candidate.surface_instance_specs.clear();
        assert!(matches!(
            candidate.validate(),
            Err(ContractError::MissingReference { .. })
        ));
        let mut candidate = profile();
        candidate
            .surface_instance_specs
            .push(candidate.surface_instance_specs[0].clone());
        assert!(matches!(
            candidate.validate(),
            Err(ContractError::Duplicate { .. })
        ));
    }

    #[test]
    fn mutations_are_stale_safe_and_scene_library_operations_are_explicit() {
        let original = profile();
        assert!(
            apply_ui_profile_mutation(
                &original,
                2,
                UiProfileMutationV1::SetActiveMode {
                    mode: UiProfileModeV1::Studio,
                },
            )
            .is_err()
        );
        let duplicate = scene(&original.project_id, "scene:b", "instance:a");
        let duplicated = apply_ui_profile_mutation(
            &original,
            3,
            UiProfileMutationV1::DuplicateScene {
                source_scene_id: SceneId::new("scene:a").unwrap(),
                scene: duplicate,
            },
        )
        .unwrap();
        assert_eq!(duplicated.revision, 4);
        assert_eq!(
            duplicated.active_studio_scene_id.unwrap().as_str(),
            "scene:b"
        );
        assert_eq!(duplicated.studio_scenes.len(), 2);
        assert_eq!(original.studio_scenes.len(), 1);
    }

    #[test]
    fn empty_recursive_studio_preset_remains_a_valid_profile_shape() {
        let mut candidate = profile();
        candidate.studio_scenes[0].root = LayoutNodeV1::Container {
            node_id: LayoutNodeId::new("node:empty").unwrap(),
            axis: LayoutAxisV1::Horizontal,
            children: vec![],
        };
        candidate.studio_scenes[0].focused_surface_instance_id = None;
        candidate.last_focused_surface_instance_id = None;
        candidate.validate().unwrap();
    }
}
