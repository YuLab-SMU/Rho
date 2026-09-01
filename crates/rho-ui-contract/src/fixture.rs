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
    pub max_resource_providers: usize,
    pub max_resource_instances: usize,
    pub max_resource_content_bytes: usize,
    pub max_resource_documents: usize,
    pub max_ui_profile_bytes: usize,
    pub max_ui_profile_scenes: usize,
    pub max_ui_profile_pages: usize,
    pub max_ui_profile_surface_specs: usize,
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
            max_resource_providers: MAX_RESOURCE_PROVIDERS,
            max_resource_instances: MAX_RESOURCE_INSTANCES,
            max_resource_content_bytes: MAX_RESOURCE_CONTENT_BYTES,
            max_resource_documents: MAX_RESOURCE_DOCUMENTS,
            max_ui_profile_bytes: MAX_UI_PROFILE_BYTES,
            max_ui_profile_scenes: MAX_UI_PROFILE_SCENES,
            max_ui_profile_pages: MAX_UI_PROFILE_PAGES,
            max_ui_profile_surface_specs: MAX_UI_PROFILE_SURFACE_SPECS,
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
    pub runtime_registry_snapshot: RuntimeRegistrySnapshotV1,
    pub resources: Vec<ResourceDescriptorV1>,
    pub resource_registry_snapshot: ResourceRegistrySnapshotV1,
    pub instances: Vec<SurfaceInstanceV1>,
    pub commands: Vec<CommandDefinitionV1>,
    pub scenes: Vec<SceneStateV1>,
    pub pages: Vec<VibePageV1>,
    pub kernel_snapshot: UiKernelSnapshotV1,
    pub surface_runtime_snapshot: SurfaceRuntimeSnapshotV1,
    pub studio_runtime_snapshot: StudioRuntimeSnapshotV1,
    pub project_ui_profile_snapshot: ProjectUiProfileSnapshotV1,
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
        self.runtime_registry_snapshot.validate()?;
        validate_unique(
            "fixture.resources",
            self.resources
                .iter()
                .map(|resource| resource.resource_id.as_str()),
        )?;
        for resource in &self.resources {
            resource.validate()?;
        }
        self.resource_registry_snapshot.validate()?;
        for instance in &self.instances {
            instance.validate()?;
        }
        SurfaceCatalogV1 {
            factories: self
                .surfaces
                .iter()
                .cloned()
                .map(|definition| SurfaceFactoryRegistrationV1 {
                    definition,
                    activation_generation: 1,
                })
                .collect(),
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
        self.surface_runtime_snapshot.validate()?;
        self.studio_runtime_snapshot.validate()?;
        self.project_ui_profile_snapshot.validate()?;
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
        icon: None,
        renderer_kind: SurfaceRendererKindV1::TrustedHost,
        scope: SurfaceScopeV1::Project,
        instance_policy: SurfaceInstancePolicyV1::MultiInstance,
        instance_quota_class: if strip {
            SurfaceInstanceQuotaClassV1::Strip
        } else {
            SurfaceInstanceQuotaClassV1::Standard
        },
        resource_kinds: if matches!(
            surface_id,
            "rho.file-source" | "rho.file-preview" | "rho.surface-playground"
        ) {
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

fn singleton_definition(
    surface_id: &str,
    label: &str,
    modes: &[(&str, &str)],
) -> SurfaceDefinitionV1 {
    let mut value = definition(surface_id, label, modes, false);
    value.instance_policy = SurfaceInstancePolicyV1::Singleton;
    value
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
        runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
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
        resource_provider_id: ResourceProviderId::new("rho.project-files").unwrap(),
        resource_kind: ResourceKindId::new("project_file").unwrap(),
        resource_id: "analysis.R".to_string(),
        resource_revision: Some(4),
    };
    let project_file_provider = ResourceProviderRegistrationV1 {
        definition: ResourceProviderDefinitionV1 {
            resource_provider_id: ResourceProviderId::new("rho.project-files").unwrap(),
            resource_kinds: vec![ResourceKindId::new("project_file").unwrap()],
            display_label: "Project files".to_string(),
            capabilities: [
                "resource.delete",
                "resource.preview",
                "resource.read.document",
                "resource.read.snapshot",
                "resource.rename",
                "resource.write",
            ]
            .into_iter()
            .map(|value| ResourceCapabilityId::new(value).unwrap())
            .collect(),
            application_component_id: ApplicationComponentId::new("rho.resource.project-files")
                .unwrap(),
        },
        activation_generation: 1,
    };
    let file_resource = ResourceDescriptorV1 {
        resource_provider_id: ResourceProviderId::new("rho.project-files").unwrap(),
        project_id: project_id.clone(),
        resource_kind: ResourceKindId::new("project_file").unwrap(),
        resource_id: "analysis.R".to_string(),
        resource_revision: 4,
        label: "analysis.R".to_string(),
        capabilities: project_file_provider.definition.capabilities.clone(),
        status: ResourceStatusV1::Ready,
        media_type: Some("text/x-r".to_string()),
        size_bytes: Some(43),
        content_sha256: Some("b".repeat(64)),
    };
    let instances = vec![
        instance(
            "instance:navigator",
            "rho.navigator",
            Some("files"),
            None,
            None,
        ),
        instance(
            "instance:file-source",
            "rho.file-source",
            Some("source"),
            None,
            Some(file_binding.clone()),
        ),
        instance(
            "instance:file-preview",
            "rho.file-preview",
            Some("preview"),
            None,
            Some(file_binding.clone()),
        ),
        instance(
            "instance:playground-a",
            "rho.surface-playground",
            Some("notes"),
            None,
            Some(file_binding.clone()),
        ),
        instance(
            "instance:playground-b",
            "rho.surface-playground",
            Some("notes"),
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
        instance("instance:check", "rho.check-result", None, None, None),
        instance(
            "instance:environment",
            "rho.environment",
            Some("health"),
            None,
            None,
        ),
    ];
    let scene = SceneStateV1 {
        scene_id: SceneId::new("scene:rho-studio").unwrap(),
        project_id: project_id.clone(),
        label: "Rho Studio".to_string(),
        layout_revision: 1,
        root: LayoutNodeV1::Container {
            node_id: LayoutNodeId::new("node:root").unwrap(),
            axis: LayoutAxisV1::Horizontal,
            children: vec![
                LayoutChildV1 {
                    child: scene_surface("node:navigator", "instance:navigator"),
                    basis: LayoutBasisV1::Minmax {
                        min_logical_pixels: 240,
                        max_logical_pixels: 340,
                        weight: 1,
                    },
                    resizable: true,
                    collapse_priority: Some(30),
                },
                LayoutChildV1 {
                    child: LayoutNodeV1::Container {
                        node_id: LayoutNodeId::new("node:center").unwrap(),
                        axis: LayoutAxisV1::Vertical,
                        children: vec![
                            LayoutChildV1 {
                                child: scene_surface("node:file", "instance:file-source"),
                                basis: LayoutBasisV1::Fraction { weight: 7 },
                                resizable: true,
                                collapse_priority: None,
                            },
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
                        ],
                    },
                    basis: LayoutBasisV1::Fraction { weight: 7 },
                    resizable: true,
                    collapse_priority: None,
                },
                LayoutChildV1 {
                    child: LayoutNodeV1::Stack(StackNodeV1 {
                        node_id: LayoutNodeId::new("node:context").unwrap(),
                        active_instance_id: SurfaceInstanceId::new("instance:environment").unwrap(),
                        instances: vec![SurfaceInstanceId::new("instance:environment").unwrap()],
                    }),
                    basis: LayoutBasisV1::Minmax {
                        min_logical_pixels: 320,
                        max_logical_pixels: 520,
                        weight: 2,
                    },
                    resizable: true,
                    collapse_priority: Some(20),
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
                        document: VibeRichTextDocumentV1::plain_text(
                            "Review the project against explicit checks.",
                        ),
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
    let surface_specs = instances
        .iter()
        .map(|instance| SurfaceInstanceSpecV1 {
            instance_id: instance.instance_id.clone(),
            surface_id: instance.surface_id.clone(),
            origin: instance.origin.clone(),
            mode_id: instance.mode_id.clone(),
            resource_binding: instance.resource_binding.clone(),
            runtime_attachment_intent: instance.runtime_binding.as_ref().map(|binding| {
                RuntimeAttachmentIntentV1 {
                    runtime_provider_id: binding.runtime_provider_id.clone(),
                    runtime_instance_id: binding.runtime_instance_id.clone(),
                    runtime_kind: binding.runtime_kind.clone(),
                }
            }),
            view_group_id: instance.view_group_id.clone(),
            view_state: instance.view_state.clone(),
        })
        .collect::<Vec<_>>();
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
                resource_provider_id: ResourceProviderId::new("rho.project-files").unwrap(),
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
                "rho.file-source",
                "File Source",
                &[
                    ("source", "Source"),
                    ("diff", "Diff"),
                    ("outline", "Outline"),
                ],
                false,
            ),
            definition(
                "rho.file-preview",
                "File Preview",
                &[("preview", "Preview")],
                false,
            ),
            definition("rho.console", "Console", &[], false),
            singleton_definition(
                "rho.runtimes",
                "Runtime Center",
                &[("overview", "Overview")],
            ),
            definition("rho.status", "Runtime status", &[], true),
            definition("rho.check-result", "Check result", &[], false),
            definition(
                "rho.navigator",
                "Navigator",
                &[("files", "Files"), ("runs", "History")],
                false,
            ),
            definition(
                "rho.environment",
                "Environment",
                &[
                    ("health", "Health"),
                    ("plans", "Plans"),
                    ("activity", "Activity"),
                ],
                false,
            ),
            definition(
                "rho.surface-playground",
                "Surface Playground",
                &[("notes", "Notes"), ("inspect", "Inspect")],
                false,
            ),
        ],
        runtimes: vec![runtime.clone()],
        runtime_registry_snapshot: RuntimeRegistrySnapshotV1 {
            contract: RUNTIME_REGISTRY_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            snapshot_revision: 4,
            project_id: project_id.clone(),
            project_revision: 7,
            providers: vec![RuntimeProviderRegistrationV1 {
                definition: RuntimeProviderDefinitionV1 {
                    runtime_provider_id: RuntimeProviderId::new("rho.ark-r").unwrap(),
                    runtime_kind: RuntimeKindId::new("r").unwrap(),
                    display_label: "Ark R".to_string(),
                    create_supported: true,
                    max_instances: MAX_AUXILIARY_RUNTIMES,
                    attach_capabilities: vec![RuntimeCapabilityId::new("console.attach").unwrap()],
                    application_component_id: ApplicationComponentId::new("rho.runtime.ark-r")
                        .unwrap(),
                },
                activation_generation: 1,
            }],
            instances: vec![runtime],
        },
        resources: vec![file_resource.clone()],
        resource_registry_snapshot: ResourceRegistrySnapshotV1 {
            contract: RESOURCE_REGISTRY_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            snapshot_revision: 3,
            project_id: project_id.clone(),
            project_revision: 7,
            providers: vec![project_file_provider],
            resources: vec![file_resource],
        },
        instances: instances.clone(),
        commands: vec![command],
        scenes: vec![scene.clone()],
        pages: vec![page.clone()],
        kernel_snapshot,
        surface_runtime_snapshot: SurfaceRuntimeSnapshotV1 {
            contract: SURFACE_RUNTIME_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            snapshot_revision: 6,
            project_id: project_id.clone(),
            project_revision: 7,
            catalog: SurfaceCatalogV1 {
                factories: vec![
                    definition(
                        "rho.file-source",
                        "File Source",
                        &[
                            ("source", "Source"),
                            ("diff", "Diff"),
                            ("outline", "Outline"),
                        ],
                        false,
                    ),
                    definition(
                        "rho.file-preview",
                        "File Preview",
                        &[("preview", "Preview")],
                        false,
                    ),
                    definition("rho.console", "Console", &[], false),
                    singleton_definition(
                        "rho.runtimes",
                        "Runtime Center",
                        &[("overview", "Overview")],
                    ),
                    definition("rho.status", "Runtime status", &[], true),
                    definition("rho.check-result", "Check result", &[], false),
                    definition(
                        "rho.navigator",
                        "Navigator",
                        &[("files", "Files"), ("runs", "History")],
                        false,
                    ),
                    definition(
                        "rho.environment",
                        "Environment",
                        &[
                            ("health", "Health"),
                            ("plans", "Plans"),
                            ("activity", "Activity"),
                        ],
                        false,
                    ),
                    definition(
                        "rho.surface-playground",
                        "Surface Playground",
                        &[("notes", "Notes"), ("inspect", "Inspect")],
                        false,
                    ),
                ]
                .into_iter()
                .map(|definition| SurfaceFactoryRegistrationV1 {
                    definition,
                    activation_generation: 1,
                })
                .collect(),
                instances: instances.clone(),
            },
        },
        studio_runtime_snapshot: StudioRuntimeSnapshotV1 {
            contract: STUDIO_RUNTIME_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            snapshot_revision: 4,
            project_id: project_id.clone(),
            project_revision: 7,
            scene: scene.clone(),
            unplaced_instance_ids: vec![
                SurfaceInstanceId::new("instance:check").unwrap(),
                SurfaceInstanceId::new("instance:file-preview").unwrap(),
                SurfaceInstanceId::new("instance:playground-a").unwrap(),
                SurfaceInstanceId::new("instance:playground-b").unwrap(),
            ],
            can_undo: true,
            can_redo: false,
        },
        project_ui_profile_snapshot: ProjectUiProfileSnapshotV1 {
            contract: PROJECT_UI_PROFILE_SNAPSHOT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            profile: ProjectUiProfileV1 {
                schema_version: PROJECT_UI_PROFILE_SCHEMA_VERSION,
                project_id: project_id.clone(),
                revision: 5,
                active_mode: UiProfileModeV1::Studio,
                active_studio_scene_id: Some(scene.scene_id.clone()),
                active_vibe_page_id: Some(page.page_id.clone()),
                studio_scenes: vec![scene.clone()],
                vibe_pages: vec![page],
                surface_instance_specs: surface_specs.clone(),
                last_focused_surface_instance_id: scene.focused_surface_instance_id.clone(),
            },
            immutable_scene_presets: vec![StudioScenePresetV1 {
                preset_id: ScenePresetId::new("rho.studio").unwrap(),
                label: "Rho Studio".to_string(),
                description: "Fixture projection of the immutable recursive Studio preset."
                    .to_string(),
                scene,
                surface_instance_specs: surface_specs,
            }],
            load_status: UiProfileLoadStatusV1::Clean,
            recovery_detail: None,
        },
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
            .filter(|instance| {
                matches!(
                    instance.surface_id.as_str(),
                    "rho.file-source" | "rho.file-preview"
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(files[0].resource_binding, files[1].resource_binding);
        assert_ne!(files[0].mode_id, files[1].mode_id);
        assert_ne!(files[0].surface_id, files[1].surface_id);
    }
}
