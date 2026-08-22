use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::*;

pub const RSR_FIXTURE_CONTRACT: &str = "rho.ui.contract.fixture.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContractLimitsV1 {
    pub max_id_bytes: usize,
    pub max_command_registry_bytes: usize,
    pub max_surface_view_state_bytes: usize,
    pub max_scene_json_bytes: usize,
    pub max_layout_depth: usize,
    pub max_layout_nodes: usize,
    pub max_surface_placements: usize,
    pub max_vibe_page_json_bytes: usize,
    pub max_vibe_sections: usize,
    pub max_vibe_blocks: usize,
    pub max_vibe_live_surfaces: usize,
    pub vibe_grid_columns: u8,
}

impl Default for ContractLimitsV1 {
    fn default() -> Self {
        Self {
            max_id_bytes: MAX_ID_BYTES,
            max_command_registry_bytes: MAX_COMMAND_REGISTRY_BYTES,
            max_surface_view_state_bytes: MAX_SURFACE_VIEW_STATE_BYTES,
            max_scene_json_bytes: MAX_SCENE_JSON_BYTES,
            max_layout_depth: MAX_LAYOUT_DEPTH,
            max_layout_nodes: MAX_LAYOUT_NODES,
            max_surface_placements: MAX_SURFACE_PLACEMENTS,
            max_vibe_page_json_bytes: MAX_VIBE_PAGE_JSON_BYTES,
            max_vibe_sections: MAX_VIBE_SECTIONS,
            max_vibe_blocks: MAX_VIBE_BLOCKS,
            max_vibe_live_surfaces: MAX_VIBE_LIVE_SURFACES,
            vibe_grid_columns: MAX_VIBE_GRID_COLUMNS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContractFixtureV1 {
    pub contract: String,
    pub contract_major: u16,
    pub limits: ContractLimitsV1,
    pub surfaces: Vec<SurfaceDefinitionV1>,
    pub runtimes: Vec<RuntimeDescriptorV1>,
    pub instances: Vec<SurfaceInstanceV1>,
    pub commands: Vec<CommandDefinitionV1>,
    pub scenes: Vec<SceneStateV1>,
    pub pages: Vec<VibePageV1>,
    pub kernel_snapshot: UiKernelSnapshotV1,
}

impl Validate for ContractFixtureV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != RSR_FIXTURE_CONTRACT || self.contract_major != RSR_CONTRACT_MAJOR {
            return Err(ContractError::InvalidValue {
                path: "fixture.contract".to_string(),
                reason: "unsupported fixture contract".to_string(),
            });
        }
        validate_unique(
            "fixture.surfaces",
            self.surfaces
                .iter()
                .map(|surface| surface.surface_id.as_ref()),
        )?;
        validate_unique(
            "fixture.runtimes",
            self.runtimes
                .iter()
                .map(|runtime| runtime.runtime_instance_id.as_ref()),
        )?;
        validate_unique(
            "fixture.instances",
            self.instances
                .iter()
                .map(|instance| instance.instance_id.as_ref()),
        )?;
        validate_unique(
            "fixture.commands",
            self.commands
                .iter()
                .map(|command| command.command_id.as_ref()),
        )?;
        validate_unique(
            "fixture.scenes",
            self.scenes.iter().map(|scene| scene.scene_id.as_ref()),
        )?;
        validate_unique(
            "fixture.pages",
            self.pages.iter().map(|page| page.page_id.as_ref()),
        )?;
        for surface in &self.surfaces {
            surface.validate()?;
        }
        for runtime in &self.runtimes {
            runtime.validate()?;
        }
        for instance in &self.instances {
            instance.validate()?;
        }
        SurfaceCatalogV1 {
            definitions: self.surfaces.clone(),
            instances: self.instances.clone(),
        }
        .validate()?;
        for command in &self.commands {
            command.validate()?;
        }
        for scene in &self.scenes {
            scene.validate()?;
        }
        for page in &self.pages {
            page.validate()?;
        }
        self.kernel_snapshot.validate()?;
        let surfaces = self
            .surfaces
            .iter()
            .map(|surface| surface.surface_id.as_str())
            .collect::<BTreeSet<_>>();
        let runtimes = self
            .runtimes
            .iter()
            .map(|runtime| runtime.runtime_instance_id.as_str())
            .collect::<BTreeSet<_>>();
        let instances = self
            .instances
            .iter()
            .map(|instance| instance.instance_id.as_str())
            .collect::<BTreeSet<_>>();
        for instance in &self.instances {
            if !surfaces.contains(instance.surface_id.as_str()) {
                return Err(ContractError::MissingReference {
                    path: "fixture.instances.surface_id".to_string(),
                    value: instance.surface_id.to_string(),
                });
            }
            if let Some(binding) = &instance.runtime_binding
                && !runtimes.contains(binding.runtime_instance_id.as_str())
            {
                return Err(ContractError::MissingReference {
                    path: "fixture.instances.runtime_binding".to_string(),
                    value: binding.runtime_instance_id.to_string(),
                });
            }
        }
        for scene in &self.scenes {
            let mut placed = Vec::new();
            collect_scene_instances(&scene.root, &mut placed);
            if let Some(stack) = &scene.utility_tray {
                placed.extend(stack.instances.iter());
            }
            for instance in placed {
                if !instances.contains(instance.as_str()) {
                    return Err(ContractError::MissingReference {
                        path: "fixture.scenes.instance_id".to_string(),
                        value: instance.to_string(),
                    });
                }
            }
        }
        for page in &self.pages {
            for section in &page.sections {
                for block in &section.blocks {
                    if let VibeBlockContentV1::SurfaceRef { instance_id, .. } = &block.content
                        && !instances.contains(instance_id.as_str())
                    {
                        return Err(ContractError::MissingReference {
                            path: "fixture.pages.surface_ref".to_string(),
                            value: instance_id.to_string(),
                        });
                    }
                }
            }
        }
        Ok(())
    }
}

fn collect_scene_instances<'a>(node: &'a LayoutNodeV1, output: &mut Vec<&'a SurfaceInstanceId>) {
    match node {
        LayoutNodeV1::Container { children, .. } => {
            for child in children {
                collect_scene_instances(&child.child, output);
            }
        }
        LayoutNodeV1::Stack(stack) => output.extend(stack.instances.iter()),
        LayoutNodeV1::Surface { instance_id, .. } => output.push(instance_id),
    }
}

fn application_origin(component: &str) -> SurfaceOriginV1 {
    SurfaceOriginV1::Application {
        component_id: ApplicationComponentId::new(component).unwrap(),
    }
}

fn sizing(strip: bool) -> SurfaceSizingHintsV1 {
    SurfaceSizingHintsV1 {
        min_inline: if strip { 120 } else { 240 },
        min_block: if strip { 28 } else { 120 },
        ideal_inline: Some(if strip { 260 } else { 640 }),
        ideal_block: Some(if strip { 36 } else { 420 }),
        max_inline: None,
        max_block: if strip { Some(64) } else { None },
        stretch_inline: true,
        stretch_block: !strip,
        presentation_classes: if strip {
            vec![SurfacePresentationClassV1::Strip]
        } else {
            vec![
                SurfacePresentationClassV1::Full,
                SurfacePresentationClassV1::Compact,
            ]
        },
    }
}

fn definition(
    surface_id: &str,
    label: &str,
    modes: &[(&str, &str)],
    strip: bool,
) -> SurfaceDefinitionV1 {
    SurfaceDefinitionV1 {
        surface_id: SurfaceId::new(surface_id).unwrap(),
        contract_major: RSR_CONTRACT_MAJOR,
        label: label.to_string(),
        purpose: format!("Render the {label} capability as an independent Rho Surface."),
        renderer_kind: SurfaceRendererKindV1::TrustedHost,
        scope: SurfaceScopeV1::Project,
        instance_policy: SurfaceInstancePolicyV1::MultiInstance,
        instance_quota_class: if strip {
            SurfaceInstanceQuotaClassV1::Strip
        } else {
            SurfaceInstanceQuotaClassV1::Standard
        },
        resource_kinds: if surface_id == "rho.file" {
            vec![ResourceKindId::new("project_file").unwrap()]
        } else {
            vec![]
        },
        modes: modes
            .iter()
            .map(|(mode_id, label)| SurfaceModeV1 {
                mode_id: SurfaceModeId::new(*mode_id).unwrap(),
                label: (*label).to_string(),
                interaction_kind: SurfaceInteractionKindV1::Interactive,
            })
            .collect(),
        sizing_hints: sizing(strip),
        accepted_contexts: vec!["project".to_string()],
        commands: vec![],
        origin: application_origin(surface_id),
    }
}

fn instance(
    id: &str,
    surface: &str,
    mode: Option<&str>,
    runtime: Option<RuntimeBindingV1>,
    resource: Option<ResourceBindingV1>,
) -> SurfaceInstanceV1 {
    SurfaceInstanceV1 {
        instance_id: SurfaceInstanceId::new(id).unwrap(),
        surface_id: SurfaceId::new(surface).unwrap(),
        project_id: ProjectId::new("project:fixture").unwrap(),
        origin: application_origin(surface),
        activation_generation: 1,
        surface_revision: 1,
        mode_id: mode.map(|mode| SurfaceModeId::new(mode).unwrap()),
        resource_binding: resource,
        runtime_binding: runtime,
        view_group_id: None,
        view_state: json!({}),
        lifecycle_state: SurfaceLifecycleStateV1::Active,
    }
}

fn scene_surface(node: &str, instance: &str) -> LayoutNodeV1 {
    LayoutNodeV1::Surface {
        node_id: LayoutNodeId::new(node).unwrap(),
        instance_id: SurfaceInstanceId::new(instance).unwrap(),
    }
}

pub fn golden_contract_fixture() -> ContractFixtureV1 {
    let project_id = ProjectId::new("project:fixture").unwrap();
    let runtime = RuntimeDescriptorV1 {
        runtime_provider_id: RuntimeProviderId::new("rho.workspace-r").unwrap(),
        runtime_instance_id: RuntimeInstanceId::new("runtime:workspace-r").unwrap(),
        runtime_kind: RuntimeKindId::new("r").unwrap(),
        project_id: project_id.clone(),
        activation_generation: 1,
        state_revision: 12,
        status: RuntimeStatusV1::Ready,
        attach_capabilities: vec![RuntimeCapabilityId::new("console.attach").unwrap()],
        persistence_class: RuntimePersistenceClassV1::ProjectPersistent,
        display_label: "Workspace R".to_string(),
        primary_scientific_runtime: true,
    };
    let file_binding = ResourceBindingV1 {
        resource_kind: ResourceKindId::new("project_file").unwrap(),
        resource_id: "analysis.R".to_string(),
        resource_revision: Some(4),
    };
    let instances = vec![
        instance(
            "instance:file-source",
            "rho.file",
            Some("source"),
            None,
            Some(file_binding.clone()),
        ),
        instance(
            "instance:file-preview",
            "rho.file",
            Some("preview"),
            None,
            Some(file_binding),
        ),
        instance(
            "instance:console-a",
            "rho.console",
            None,
            Some(runtime.binding()),
            None,
        ),
        instance(
            "instance:console-b",
            "rho.console",
            None,
            Some(runtime.binding()),
            None,
        ),
        instance("instance:status", "rho.status", None, None, None),
        instance("instance:check", "rho.check", None, None, None),
    ];
    let scene = SceneStateV1 {
        scene_id: SceneId::new("scene:rho-studio").unwrap(),
        label: "Rho Studio".to_string(),
        layout_revision: 1,
        root: LayoutNodeV1::Container {
            node_id: LayoutNodeId::new("node:root").unwrap(),
            axis: LayoutAxisV1::Horizontal,
            children: vec![
                LayoutChildV1 {
                    child: scene_surface("node:file", "instance:file-source"),
                    basis: LayoutBasisV1::Fraction { weight: 7 },
                    resizable: true,
                    collapse_priority: None,
                },
                LayoutChildV1 {
                    child: LayoutNodeV1::Container {
                        node_id: LayoutNodeId::new("node:right").unwrap(),
                        axis: LayoutAxisV1::Vertical,
                        children: vec![
                            LayoutChildV1 {
                                child: LayoutNodeV1::Stack(StackNodeV1 {
                                    node_id: LayoutNodeId::new("node:consoles").unwrap(),
                                    active_instance_id: SurfaceInstanceId::new(
                                        "instance:console-a",
                                    )
                                    .unwrap(),
                                    instances: vec![
                                        SurfaceInstanceId::new("instance:console-a").unwrap(),
                                        SurfaceInstanceId::new("instance:console-b").unwrap(),
                                    ],
                                }),
                                basis: LayoutBasisV1::Minmax {
                                    min_logical_pixels: 160,
                                    max_logical_pixels: 1_400,
                                    weight: 3,
                                },
                                resizable: true,
                                collapse_priority: None,
                            },
                            LayoutChildV1 {
                                child: scene_surface("node:status", "instance:status"),
                                basis: LayoutBasisV1::Intrinsic,
                                resizable: false,
                                collapse_priority: Some(1),
                            },
                        ],
                    },
                    basis: LayoutBasisV1::Fraction { weight: 3 },
                    resizable: true,
                    collapse_priority: None,
                },
            ],
        },
        focused_surface_instance_id: Some(SurfaceInstanceId::new("instance:file-source").unwrap()),
        utility_tray: None,
    };
    let page = VibePageV1 {
        page_id: PageId::new("page:project-review").unwrap(),
        project_id: project_id.clone(),
        label: "Project review".to_string(),
        page_revision: 1,
        sections: vec![VibeSectionV1 {
            section_id: SectionId::new("section:review").unwrap(),
            heading: Some("Review".to_string()),
            layout: VibeSectionLayoutV1::Grid {
                placements: vec![
                    VibeGridPlacementV1 {
                        block_id: BlockId::new("block:narrative").unwrap(),
                        row_start: 1,
                        column_start: 1,
                        column_span: 5,
                    },
                    VibeGridPlacementV1 {
                        block_id: BlockId::new("block:check").unwrap(),
                        row_start: 1,
                        column_start: 6,
                        column_span: 7,
                    },
                ],
            },
            blocks: vec![
                VibeBlockV1 {
                    block_id: BlockId::new("block:narrative").unwrap(),
                    content: VibeBlockContentV1::RichText {
                        text: "Review the project against explicit checks.".to_string(),
                    },
                },
                VibeBlockV1 {
                    block_id: BlockId::new("block:check").unwrap(),
                    content: VibeBlockContentV1::SurfaceRef {
                        instance_id: SurfaceInstanceId::new("instance:check").unwrap(),
                        live: true,
                    },
                },
            ],
        }],
        focused_block_id: Some(BlockId::new("block:narrative").unwrap()),
    };
    let command = CommandDefinitionV1 {
        command_id: CommandId::new("rho.surface.duplicate").unwrap(),
        label: "Duplicate view".to_string(),
        purpose: "Create another independent Surface instance with the selected bindings."
            .to_string(),
        input_schema: json!({"type": "object", "additionalProperties": false}),
        consequence: "Creates one new view; it does not create a runtime or copy resource truth."
            .to_string(),
        availability_predicate_id: PredicateId::new("rho.surface.can-duplicate").unwrap(),
        placement_tags: vec![
            CommandPlacementTagV1::Palette,
            CommandPlacementTagV1::SurfaceLocal,
        ],
        origin: application_origin("rho.surface-runtime"),
    };
    let context = UiContextV1 {
        project_id: project_id.clone(),
        project_revision: 7,
        scene_id: Some(SceneId::new("scene:rho-studio").unwrap()),
        page_id: None,
        focused_surface_instance_id: Some(SurfaceInstanceId::new("instance:file-source").unwrap()),
        selection: Some(UiSelectionV1::Resource {
            binding: ResourceBindingV1 {
                resource_kind: ResourceKindId::new("project_file").unwrap(),
                resource_id: "analysis.R".to_string(),
                resource_revision: Some(4),
            },
        }),
        workspace_health: HealthStateV1::Ready,
        agent_health: HealthStateV1::Degraded,
        active_operations: vec![ActiveOperationV1 {
            operation_id: OperationId::new("render:fixture").unwrap(),
            label: "Render analysis.qmd".to_string(),
            state: ActiveOperationStateV1::Running,
        }],
    };
    let mut command_registry = application_command_registry_v1(&context).unwrap();
    command_registry.registrations.push(CommandRegistrationV1 {
        definition: CommandDefinitionV1 {
            command_id: CommandId::new("ui.command.fixture-inspect").unwrap(),
            label: "Inspect fixture".to_string(),
            purpose: "Inspect the selected fixture through a workspace plugin.".to_string(),
            input_schema: json!({"type": "object", "properties": {}}),
            consequence: "Runs this workspace plugin command through broker admission.".to_string(),
            availability_predicate_id: PredicateId::new(PREDICATE_PLUGIN_READY).unwrap(),
            placement_tags: vec![
                CommandPlacementTagV1::Palette,
                CommandPlacementTagV1::SurfaceLocal,
            ],
            origin: SurfaceOriginV1::WorkspacePlugin {
                plugin_id: PluginId::new("fixture-plugin").unwrap(),
                package_digest: PackageDigest::new("a".repeat(64)).unwrap(),
            },
        },
        activation_generation: 3,
        availability: CommandAvailabilityV1::Unavailable {
            reason: "The fixture plugin host is unavailable.".to_string(),
        },
    });
    command_registry
        .registrations
        .sort_by(|left, right| left.definition.command_id.cmp(&right.definition.command_id));
    let kernel_snapshot = UiKernelSnapshotV1 {
        contract: UI_KERNEL_SNAPSHOT_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        snapshot_revision: 9,
        project: UiProjectV1 {
            project_id: project_id.clone(),
            display_label: "Surface Playground".to_string(),
            display_path: "/Users/rho/Projects/Surface Playground".to_string(),
        },
        context,
        health: UiHealthSnapshotV1 {
            workspace: UiHealthDetailV1 {
                state: HealthStateV1::Ready,
                label: "Workspace R ready".to_string(),
                detail: None,
            },
            agent: UiHealthDetailV1 {
                state: HealthStateV1::Degraded,
                label: "Agent runtime needs attention".to_string(),
                detail: Some(
                    "The scientific workbench remains available while Agent dependencies are repaired."
                        .to_string(),
                ),
            },
        },
        command_registry,
    };
    let fixture = ContractFixtureV1 {
        contract: RSR_FIXTURE_CONTRACT.to_string(),
        contract_major: RSR_CONTRACT_MAJOR,
        limits: ContractLimitsV1::default(),
        surfaces: vec![
            definition(
                "rho.file",
                "File",
                &[("source", "Source"), ("preview", "Preview")],
                false,
            ),
            definition("rho.console", "Console", &[], false),
            definition("rho.status", "Runtime status", &[], true),
            definition("rho.check", "Check project", &[], false),
        ],
        runtimes: vec![runtime],
        instances,
        commands: vec![command],
        scenes: vec![scene],
        pages: vec![page],
        kernel_snapshot,
    };
    fixture.validate().expect("golden fixture remains valid");
    fixture
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_fixture_is_valid_and_deterministic() {
        let first = serde_json::to_vec_pretty(&golden_contract_fixture()).unwrap();
        let second = serde_json::to_vec_pretty(&golden_contract_fixture()).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn fixture_proves_repeated_views_and_shared_runtime_are_independent() {
        let fixture = golden_contract_fixture();
        let consoles = fixture
            .instances
            .iter()
            .filter(|instance| instance.surface_id.as_str() == "rho.console")
            .collect::<Vec<_>>();
        assert_eq!(consoles.len(), 2);
        assert_ne!(consoles[0].instance_id, consoles[1].instance_id);
        assert_eq!(
            consoles[0]
                .runtime_binding
                .as_ref()
                .unwrap()
                .runtime_instance_id,
            consoles[1]
                .runtime_binding
                .as_ref()
                .unwrap()
                .runtime_instance_id
        );
        let files = fixture
            .instances
            .iter()
            .filter(|instance| instance.surface_id.as_str() == "rho.file")
            .collect::<Vec<_>>();
        assert_eq!(files[0].resource_binding, files[1].resource_binding);
        assert_ne!(files[0].mode_id, files[1].mode_id);
    }
}
