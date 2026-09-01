use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use rho_core::ExecutionOrigin;
use rho_extension_runtime::{
    ActivationError, BoundedJson, BrokerError, BrokerFacade, BrokerRequest, BrokerResponseClass,
    CapabilityDeclaration, CapabilityId, CapabilityRequirement, InternalPlugin, OperationId,
    PluginContext, PluginDescriptor, PluginVersion, ProjectFileViewerContribution, ScopeKindId,
    SourceHandler, WorkspaceToolHandler,
};
use serde::{Deserialize, Serialize};

use crate::project::{MAX_VIEWER_FILE_BYTES, MAX_VIEWER_HTML_BYTES};

pub(crate) fn run_history_source_capability_id() -> CapabilityId {
    CapabilityId::new("source.project.run-history")
        .expect("built-in Run History source capability must be valid")
}

pub(crate) fn runs_broker_capability_id() -> CapabilityId {
    CapabilityId::new("service.broker.runs").expect("built-in Runs broker capability must be valid")
}

pub(crate) fn runs_broker_operation_id() -> OperationId {
    OperationId::new("service.broker.runs.list")
        .expect("built-in Runs broker operation must be valid")
}

pub(crate) fn workspace_snapshot_tool_capability_id() -> CapabilityId {
    CapabilityId::new("tool.workspace.snapshot")
        .expect("built-in Workspace Snapshot tool capability must be valid")
}

pub(crate) fn workspace_probe_broker_capability_id() -> CapabilityId {
    CapabilityId::new("service.broker.workspace-probe")
        .expect("built-in Workspace probe broker capability must be valid")
}

pub(crate) fn workspace_probe_broker_operation_id() -> OperationId {
    OperationId::new("service.broker.workspace-probe.snapshot")
        .expect("built-in Workspace probe operation must be valid")
}

pub(crate) fn project_file_viewer_capability_id() -> CapabilityId {
    CapabilityId::new("ui.viewer.project-file")
        .expect("built-in project file viewer capability must be valid")
}

fn surface_playground_capability_id() -> CapabilityId {
    CapabilityId::new("ui.surface.surface-playground")
        .expect("built-in Surface Playground capability must be valid")
}

fn console_surface_capability_id() -> CapabilityId {
    CapabilityId::new("ui.surface.console").expect("built-in Console capability must be valid")
}

fn check_result_surface_capability_id() -> CapabilityId {
    CapabilityId::new("ui.surface.check-result")
        .expect("built-in Check result capability must be valid")
}

fn first_party_surface_capability_id(surface_id: &str) -> CapabilityId {
    CapabilityId::new(format!("ui.surface.{surface_id}"))
        .expect("built-in first-party Surface capability must be valid")
}

fn first_party_surface_definition(
    surface_id: &str,
    label: &str,
    purpose: &str,
    modes: &[(&str, &str, rho_ui_contract::SurfaceInteractionKindV1)],
    strip: bool,
) -> rho_ui_contract::SurfaceDefinitionV1 {
    rho_ui_contract::SurfaceDefinitionV1 {
        surface_id: rho_ui_contract::SurfaceId::new(surface_id)
            .expect("built-in first-party Surface ID must be valid"),
        contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
        label: label.to_string(),
        purpose: purpose.to_string(),
        icon: None,
        renderer_kind: rho_ui_contract::SurfaceRendererKindV1::TrustedHost,
        scope: rho_ui_contract::SurfaceScopeV1::Project,
        instance_policy: rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance,
        instance_quota_class: if strip {
            rho_ui_contract::SurfaceInstanceQuotaClassV1::Strip
        } else {
            rho_ui_contract::SurfaceInstanceQuotaClassV1::Standard
        },
        resource_kinds: vec![],
        modes: modes
            .iter()
            .map(
                |(mode_id, mode_label, interaction_kind)| rho_ui_contract::SurfaceModeV1 {
                    mode_id: rho_ui_contract::SurfaceModeId::new(*mode_id)
                        .expect("built-in first-party Surface mode must be valid"),
                    label: (*mode_label).to_string(),
                    interaction_kind: *interaction_kind,
                },
            )
            .collect(),
        sizing_hints: rho_ui_contract::SurfaceSizingHintsV1 {
            min_inline: if strip { 120 } else { 220 },
            min_block: if strip { 28 } else { 120 },
            ideal_inline: Some(if strip { 320 } else { 560 }),
            ideal_block: Some(if strip { 40 } else { 420 }),
            max_inline: None,
            max_block: strip.then_some(72),
            stretch_inline: true,
            stretch_block: !strip,
            presentation_classes: if strip {
                vec![rho_ui_contract::SurfacePresentationClassV1::Strip]
            } else {
                vec![
                    rho_ui_contract::SurfacePresentationClassV1::Full,
                    rho_ui_contract::SurfacePresentationClassV1::Compact,
                ]
            },
        },
        accepted_contexts: vec![
            "project".to_string(),
            "selection".to_string(),
            "vibe".to_string(),
        ],
        commands: vec![],
        origin: rho_ui_contract::SurfaceOriginV1::Application {
            component_id: rho_ui_contract::ApplicationComponentId::new(surface_id)
                .expect("built-in first-party Surface component ID must be valid"),
        },
    }
}

const FIRST_PARTY_SURFACE_IDS: &[&str] = &[
    "rho.agent",
    "rho.settings",
    "rho.environment",
    "rho.navigator",
    "rho.claims",
    "rho.evidence-graph",
    "rho.evidence-gaps",
    "rho.claim-trace",
    "rho.git",
    "rho.runs",
    "rho.jobs",
    "rho.artifacts",
    "rho.approvals",
    "rho.revisions",
    "rho.problems",
    "rho.plots",
    "rho.logs",
    "rho.help",
];

fn settings_surface_definition(
    interactive: rho_ui_contract::SurfaceInteractionKindV1,
) -> rho_ui_contract::SurfaceDefinitionV1 {
    let mut definition = first_party_surface_definition(
        "rho.settings",
        "Settings",
        "Configure trusted application capabilities through bounded first-party modules without transferring authority into layout or workspace plugins.",
        &[("settings", "Settings", interactive)],
        false,
    );
    definition.scope = rho_ui_contract::SurfaceScopeV1::Application;
    definition.instance_policy = rho_ui_contract::SurfaceInstancePolicyV1::Singleton;
    definition.accepted_contexts = vec!["application".to_string(), "project".to_string()];
    definition
}

fn ark_runtime_provider_capability_id() -> CapabilityId {
    CapabilityId::new("runtime.provider.ark-r")
        .expect("built-in Ark Runtime Provider capability must be valid")
}

fn project_file_resource_provider_capability_id() -> CapabilityId {
    CapabilityId::new("resource.provider.project-files")
        .expect("built-in project file Resource Provider capability must be valid")
}

struct CoreWorkbenchPlugin {
    descriptor: PluginDescriptor,
}

impl CoreWorkbenchPlugin {
    fn new() -> Self {
        let mut descriptor = PluginDescriptor::new(
            rho_extension_runtime::PluginId::new("org.yulab.rho.core-workbench")
                .expect("built-in Core Workbench plugin ID must be valid"),
            PluginVersion::parse("1.0.0").expect("built-in Core Workbench version must be valid"),
            vec![rho_extension_runtime::ScopePolicy::application_kind()],
        );
        descriptor.provides = vec![
            CapabilityDeclaration::new(surface_playground_capability_id(), 1),
            CapabilityDeclaration::new(console_surface_capability_id(), 1),
            CapabilityDeclaration::new(check_result_surface_capability_id(), 1),
            CapabilityDeclaration::new(ark_runtime_provider_capability_id(), 1),
            CapabilityDeclaration::new(project_file_resource_provider_capability_id(), 1),
        ];
        descriptor
            .provides
            .extend(FIRST_PARTY_SURFACE_IDS.iter().map(|surface_id| {
                CapabilityDeclaration::new(first_party_surface_capability_id(surface_id), 1)
            }));
        Self { descriptor }
    }
}

impl InternalPlugin for CoreWorkbenchPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            let definition = rho_ui_contract::SurfaceDefinitionV1 {
                surface_id: rho_ui_contract::SurfaceId::new("rho.surface-playground")
                    .expect("built-in Surface ID must be valid"),
                contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
                label: "Surface Playground".to_string(),
                purpose: "Exercise independent application Surface instances and local view state."
                    .to_string(),
                icon: None,
                renderer_kind: rho_ui_contract::SurfaceRendererKindV1::TrustedHost,
                scope: rho_ui_contract::SurfaceScopeV1::Project,
                instance_policy: rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance,
                instance_quota_class: rho_ui_contract::SurfaceInstanceQuotaClassV1::Standard,
                resource_kinds: vec![
                    rho_ui_contract::ResourceKindId::new("project_file")
                        .expect("built-in resource kind must be valid"),
                ],
                modes: vec![
                    rho_ui_contract::SurfaceModeV1 {
                        mode_id: rho_ui_contract::SurfaceModeId::new("notes")
                            .expect("built-in mode must be valid"),
                        label: "Notes".to_string(),
                        interaction_kind: rho_ui_contract::SurfaceInteractionKindV1::Interactive,
                    },
                    rho_ui_contract::SurfaceModeV1 {
                        mode_id: rho_ui_contract::SurfaceModeId::new("inspect")
                            .expect("built-in mode must be valid"),
                        label: "Inspect".to_string(),
                        interaction_kind: rho_ui_contract::SurfaceInteractionKindV1::ReadOnly,
                    },
                ],
                sizing_hints: rho_ui_contract::SurfaceSizingHintsV1 {
                    min_inline: 180,
                    min_block: 96,
                    ideal_inline: Some(440),
                    ideal_block: Some(280),
                    max_inline: None,
                    max_block: None,
                    stretch_inline: true,
                    stretch_block: true,
                    presentation_classes: vec![
                        rho_ui_contract::SurfacePresentationClassV1::Full,
                        rho_ui_contract::SurfacePresentationClassV1::Compact,
                    ],
                },
                accepted_contexts: vec!["project".to_string(), "selection".to_string()],
                commands: vec![],
                origin: rho_ui_contract::SurfaceOriginV1::Application {
                    component_id: rho_ui_contract::ApplicationComponentId::new(
                        "rho.surface-playground",
                    )
                    .expect("built-in component ID must be valid"),
                },
            };
            context
                .effects
                .register_application_surface(context.registry, definition)
                .map_err(|error| {
                    ActivationError::new("surface_playground_registration", error.to_string())
                })?;
            context
                .effects
                .register_application_surface(
                    context.registry,
                    rho_ui_contract::SurfaceDefinitionV1 {
                        surface_id: rho_ui_contract::SurfaceId::new("rho.console")
                            .expect("built-in Console Surface ID must be valid"),
                        contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
                        label: "Console".to_string(),
                        purpose: "Attach an independent Console view to one explicit runtime."
                            .to_string(),
                        icon: None,
                        renderer_kind: rho_ui_contract::SurfaceRendererKindV1::TrustedHost,
                        scope: rho_ui_contract::SurfaceScopeV1::Project,
                        instance_policy: rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance,
                        instance_quota_class:
                            rho_ui_contract::SurfaceInstanceQuotaClassV1::Standard,
                        resource_kinds: vec![],
                        modes: vec![],
                        sizing_hints: rho_ui_contract::SurfaceSizingHintsV1 {
                            min_inline: 240,
                            min_block: 120,
                            ideal_inline: Some(640),
                            ideal_block: Some(420),
                            max_inline: None,
                            max_block: None,
                            stretch_inline: true,
                            stretch_block: true,
                            presentation_classes: vec![
                                rho_ui_contract::SurfacePresentationClassV1::Full,
                                rho_ui_contract::SurfacePresentationClassV1::Compact,
                            ],
                        },
                        accepted_contexts: vec!["project".to_string()],
                        commands: vec![],
                        origin: rho_ui_contract::SurfaceOriginV1::Application {
                            component_id: rho_ui_contract::ApplicationComponentId::new(
                                "rho.console",
                            )
                            .expect("built-in Console component ID must be valid"),
                        },
                    },
                )
                .map_err(|error| {
                    ActivationError::new("console_surface_registration", error.to_string())
                })?;
            context
                .effects
                .register_application_surface(
                    context.registry,
                    rho_ui_contract::SurfaceDefinitionV1 {
                        surface_id: rho_ui_contract::SurfaceId::new("rho.check-result")
                            .expect("built-in Check result Surface ID must be valid"),
                        contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
                        label: "Check result".to_string(),
                        purpose: "Review one immutable typed Check project result independently."
                            .to_string(),
                        icon: None,
                        renderer_kind: rho_ui_contract::SurfaceRendererKindV1::TrustedHost,
                        scope: rho_ui_contract::SurfaceScopeV1::Project,
                        instance_policy: rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance,
                        instance_quota_class:
                            rho_ui_contract::SurfaceInstanceQuotaClassV1::Standard,
                        resource_kinds: vec![],
                        modes: vec![],
                        sizing_hints: rho_ui_contract::SurfaceSizingHintsV1 {
                            min_inline: 240,
                            min_block: 140,
                            ideal_inline: Some(620),
                            ideal_block: Some(520),
                            max_inline: None,
                            max_block: None,
                            stretch_inline: true,
                            stretch_block: true,
                            presentation_classes: vec![
                                rho_ui_contract::SurfacePresentationClassV1::Full,
                                rho_ui_contract::SurfacePresentationClassV1::Compact,
                            ],
                        },
                        accepted_contexts: vec!["project".to_string(), "vibe".to_string()],
                        commands: vec![],
                        origin: rho_ui_contract::SurfaceOriginV1::Application {
                            component_id: rho_ui_contract::ApplicationComponentId::new("rho.check")
                                .expect("built-in Check component ID must be valid"),
                        },
                    },
                )
                .map_err(|error| {
                    ActivationError::new("check_result_surface_registration", error.to_string())
                })?;
            let interactive = rho_ui_contract::SurfaceInteractionKindV1::Interactive;
            let read_only = rho_ui_contract::SurfaceInteractionKindV1::ReadOnly;
            for definition in [
                settings_surface_definition(interactive),
                first_party_surface_definition(
                    "rho.agent",
                    "Agent",
                    "Bind an independent Agent view to one durable project conversation; repeated views may share the same conversation without sharing composer state.",
                    &[
                        ("conversation", "Conversation", interactive),
                        ("activity", "Activity", read_only),
                        ("composer", "Composer", interactive),
                    ],
                    false,
                ),
                first_party_surface_definition(
                    "rho.environment",
                    "Environment",
                    "Inspect verified Environment receipts, immutable plans, live Workspace activation and incidents.",
                    &[
                        ("health", "Health", read_only),
                        ("plans", "Plans", read_only),
                        ("activity", "Activity", read_only),
                    ],
                    false,
                ),
                first_party_surface_definition(
                    "rho.navigator",
                    "Navigator",
                    "Browse project files and execution history as the workbench navigation column; opening a file creates an independent File Source or Preview view.",
                    &[
                        ("files", "Files", interactive),
                        ("runs", "History", interactive),
                    ],
                    false,
                ),
                first_party_surface_definition(
                    "rho.claims",
                    "Claims",
                    "Review, draft, and explicitly promote bounded project claims without changing authority facts.",
                    &[("claims", "Claims", interactive)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.evidence-graph",
                    "Evidence graph",
                    "Traverse typed support, conflict, citation, and authority-reference relationships.",
                    &[("graph", "Graph", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.evidence-gaps",
                    "Evidence gaps",
                    "Inspect deterministic evidence gaps without changing authority outcomes.",
                    &[("gaps", "Gaps", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.claim-trace",
                    "Claim trace",
                    "Inspect one claim's promoted links, live authority references, and open gaps.",
                    &[("trace", "Trace", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.git",
                    "Git",
                    "Inspect project source-control state as an independently placeable view.",
                    &[
                        ("changes", "Changes", interactive),
                        ("history", "History", read_only),
                    ],
                    false,
                ),
                first_party_surface_definition(
                    "rho.runs",
                    "History",
                    "Review broker-owned scientific execution history and recovery state.",
                    &[("history", "History", interactive)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.jobs",
                    "Jobs",
                    "Review typed submitted and document-render job lifecycle state.",
                    &[("queue", "Queue", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.artifacts",
                    "Artifacts",
                    "Review durable artifact identity and producing-run references.",
                    &[("list", "List", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.approvals",
                    "Approvals",
                    "Review broker-owned approval receipts independently from graph promotion.",
                    &[("list", "List", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.revisions",
                    "Revisions",
                    "Review current project and Workspace revision authority.",
                    &[("current", "Current", read_only)],
                    false,
                ),
                first_party_surface_definition(
                    "rho.problems",
                    "Problems",
                    "Review actionable project diagnostics as a compact or full Surface.",
                    &[("list", "List", interactive)],
                    true,
                ),
                first_party_surface_definition(
                    "rho.plots",
                    "Plots",
                    "Review plot artifacts independently from source files and runtimes.",
                    &[
                        ("gallery", "Gallery", read_only),
                        ("single", "Single", read_only),
                    ],
                    false,
                ),
                first_party_surface_definition(
                    "rho.logs",
                    "Logs",
                    "Stream bounded application and runtime diagnostics in an intrinsic strip or expanded view.",
                    &[("stream", "Stream", read_only)],
                    true,
                ),
                first_party_surface_definition(
                    "rho.help",
                    "Help",
                    "Open contextual project and command guidance without a permanent top-level tab.",
                    &[
                        ("context", "Context", read_only),
                        ("search", "Search", interactive),
                    ],
                    false,
                ),
            ] {
                context
                    .effects
                    .register_application_surface(context.registry, definition)
                    .map_err(|error| {
                        ActivationError::new("first_party_surface_registration", error.to_string())
                    })?;
            }
            context
                .effects
                .register_application_runtime_provider(
                    context.registry,
                    rho_ui_contract::RuntimeProviderDefinitionV1 {
                        runtime_provider_id: rho_ui_contract::RuntimeProviderId::new("rho.ark-r")
                            .expect("built-in Runtime Provider ID must be valid"),
                        runtime_kind: rho_ui_contract::RuntimeKindId::new("r")
                            .expect("built-in Runtime kind must be valid"),
                        display_label: "Ark R".to_string(),
                        create_supported: true,
                        max_instances: rho_ui_contract::MAX_AUXILIARY_RUNTIMES,
                        attach_capabilities: vec![
                            rho_ui_contract::RuntimeCapabilityId::new("console.attach")
                                .expect("built-in Runtime capability must be valid"),
                        ],
                        application_component_id: rho_ui_contract::ApplicationComponentId::new(
                            "rho.runtime.ark-r",
                        )
                        .expect("built-in Runtime component ID must be valid"),
                    },
                )
                .map_err(|error| {
                    ActivationError::new("ark_runtime_provider_registration", error.to_string())
                })?;
            for definition in [
                rho_ui_contract::SurfaceDefinitionV1 {
                    surface_id: rho_ui_contract::SurfaceId::new("rho.file-source")
                        .expect("built-in File Source Surface ID must be valid"),
                    contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
                    label: "File Source".to_string(),
                    purpose: "Edit one shared project-file document through an independent view."
                        .to_string(),
                    icon: None,
                    renderer_kind: rho_ui_contract::SurfaceRendererKindV1::TrustedHost,
                    scope: rho_ui_contract::SurfaceScopeV1::Project,
                    instance_policy: rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance,
                    instance_quota_class: rho_ui_contract::SurfaceInstanceQuotaClassV1::Heavy,
                    resource_kinds: vec![
                        rho_ui_contract::ResourceKindId::new("project_file")
                            .expect("built-in project file Resource kind must be valid"),
                    ],
                    modes: [
                        (
                            "source",
                            "Source",
                            rho_ui_contract::SurfaceInteractionKindV1::Interactive,
                        ),
                        (
                            "diff",
                            "Diff",
                            rho_ui_contract::SurfaceInteractionKindV1::ReadOnly,
                        ),
                        (
                            "outline",
                            "Outline",
                            rho_ui_contract::SurfaceInteractionKindV1::ReadOnly,
                        ),
                    ]
                    .into_iter()
                    .map(
                        |(mode_id, label, interaction_kind)| rho_ui_contract::SurfaceModeV1 {
                            mode_id: rho_ui_contract::SurfaceModeId::new(mode_id)
                                .expect("built-in File Source mode must be valid"),
                            label: label.to_string(),
                            interaction_kind,
                        },
                    )
                    .collect(),
                    sizing_hints: rho_ui_contract::SurfaceSizingHintsV1 {
                        min_inline: 220,
                        min_block: 120,
                        ideal_inline: Some(720),
                        ideal_block: Some(520),
                        max_inline: None,
                        max_block: None,
                        stretch_inline: true,
                        stretch_block: true,
                        presentation_classes: vec![
                            rho_ui_contract::SurfacePresentationClassV1::Full,
                            rho_ui_contract::SurfacePresentationClassV1::Compact,
                        ],
                    },
                    accepted_contexts: vec!["project".to_string(), "selection".to_string()],
                    commands: vec![],
                    origin: rho_ui_contract::SurfaceOriginV1::Application {
                        component_id: rho_ui_contract::ApplicationComponentId::new(
                            "rho.file-source",
                        )
                        .expect("built-in File Source component ID must be valid"),
                    },
                },
                rho_ui_contract::SurfaceDefinitionV1 {
                    surface_id: rho_ui_contract::SurfaceId::new("rho.file-preview")
                        .expect("built-in File Preview Surface ID must be valid"),
                    contract_major: rho_ui_contract::RSR_CONTRACT_MAJOR,
                    label: "File Preview".to_string(),
                    purpose: "Render one immutable project-file revision in an independent view."
                        .to_string(),
                    icon: None,
                    renderer_kind: rho_ui_contract::SurfaceRendererKindV1::TrustedHost,
                    scope: rho_ui_contract::SurfaceScopeV1::Project,
                    instance_policy: rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance,
                    instance_quota_class: rho_ui_contract::SurfaceInstanceQuotaClassV1::Standard,
                    resource_kinds: vec![
                        rho_ui_contract::ResourceKindId::new("project_file")
                            .expect("built-in project file Resource kind must be valid"),
                    ],
                    modes: vec![rho_ui_contract::SurfaceModeV1 {
                        mode_id: rho_ui_contract::SurfaceModeId::new("preview")
                            .expect("built-in File Preview mode must be valid"),
                        label: "Preview".to_string(),
                        interaction_kind: rho_ui_contract::SurfaceInteractionKindV1::ReadOnly,
                    }],
                    sizing_hints: rho_ui_contract::SurfaceSizingHintsV1 {
                        min_inline: 180,
                        min_block: 96,
                        ideal_inline: Some(640),
                        ideal_block: Some(480),
                        max_inline: None,
                        max_block: None,
                        stretch_inline: true,
                        stretch_block: true,
                        presentation_classes: vec![
                            rho_ui_contract::SurfacePresentationClassV1::Full,
                            rho_ui_contract::SurfacePresentationClassV1::Compact,
                        ],
                    },
                    accepted_contexts: vec!["project".to_string(), "selection".to_string()],
                    commands: vec![],
                    origin: rho_ui_contract::SurfaceOriginV1::Application {
                        component_id: rho_ui_contract::ApplicationComponentId::new(
                            "rho.file-preview",
                        )
                        .expect("built-in File Preview component ID must be valid"),
                    },
                },
            ] {
                context
                    .effects
                    .register_application_surface(context.registry, definition)
                    .map_err(|error| {
                        ActivationError::new("file_surface_registration", error.to_string())
                    })?;
            }
            context
                .effects
                .register_application_resource_provider(
                    context.registry,
                    rho_ui_contract::ResourceProviderDefinitionV1 {
                        resource_provider_id: rho_ui_contract::ResourceProviderId::new(
                            "rho.project-files",
                        )
                        .expect("built-in Resource Provider ID must be valid"),
                        resource_kinds: vec![
                            rho_ui_contract::ResourceKindId::new("project_file")
                                .expect("built-in project file Resource kind must be valid"),
                        ],
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
                        .map(|value| {
                            rho_ui_contract::ResourceCapabilityId::new(value)
                                .expect("built-in Resource capability must be valid")
                        })
                        .collect(),
                        application_component_id: rho_ui_contract::ApplicationComponentId::new(
                            "rho.resource.project-files",
                        )
                        .expect("built-in Resource Provider component ID must be valid"),
                    },
                )
                .map_err(|error| {
                    ActivationError::new("project_file_resource_registration", error.to_string())
                })?;
            Ok(())
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum WorkspaceOperation {
    Snapshot {
        expected_workspace: rho_protocol::ExpectedWorkspace,
        origin: ExecutionOrigin,
        execution_id: Option<String>,
    },
}

pub(crate) struct WorkspaceSnapshotPlugin {
    descriptor: PluginDescriptor,
}

impl WorkspaceSnapshotPlugin {
    pub(crate) fn new() -> Self {
        let mut descriptor = PluginDescriptor::new(
            rho_extension_runtime::PluginId::new("org.yulab.rho.workspace-snapshot-tool")
                .expect("built-in Workspace Snapshot plugin ID must be valid"),
            PluginVersion::parse("1.0.0")
                .expect("built-in Workspace Snapshot version must be valid"),
            vec![rho_extension_runtime::ScopePolicy::workspace_kind()],
        );
        descriptor.provides = vec![CapabilityDeclaration::new(
            workspace_snapshot_tool_capability_id(),
            1,
        )];
        descriptor.requires = vec![CapabilityRequirement::new(
            workspace_probe_broker_capability_id(),
            1,
        )];
        Self { descriptor }
    }
}

impl InternalPlugin for WorkspaceSnapshotPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            context
                .effects
                .register_workspace_tool(
                    context.registry,
                    workspace_snapshot_tool_capability_id(),
                    Arc::new(WorkspaceSnapshotToolHandler {
                        broker: Arc::clone(&context.broker),
                    }),
                )
                .map_err(|error| {
                    ActivationError::new("workspace_snapshot_registration", error.to_string())
                })?;
            Ok(())
        })
    }
}

struct WorkspaceSnapshotToolHandler {
    broker: Arc<dyn BrokerFacade>,
}

impl WorkspaceToolHandler for WorkspaceSnapshotToolHandler {
    fn call<'a>(
        &'a self,
        request: BoundedJson,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedJson, BrokerError>> + Send + 'a>> {
        let broker = Arc::clone(&self.broker);
        Box::pin(async move {
            let operation: WorkspaceOperation = serde_json::from_value(request.into_value())
                .map_err(|error| {
                    BrokerError::rejected("workspace_snapshot_request_invalid", error.to_string())
                })?;
            let request = BrokerRequest::new(
                workspace_probe_broker_operation_id(),
                serde_json::to_value(operation).map_err(|error| {
                    BrokerError::rejected("workspace_snapshot_request_encode", error.to_string())
                })?,
                BrokerResponseClass::WorkspaceSnapshot,
            )
            .map_err(BrokerError::from)?;
            Ok(broker.call(request).await?.payload)
        })
    }
}

pub(crate) struct ProjectFileViewerPlugin {
    descriptor: PluginDescriptor,
}

impl ProjectFileViewerPlugin {
    pub(crate) fn new() -> Self {
        let mut descriptor = PluginDescriptor::new(
            rho_extension_runtime::PluginId::new("org.yulab.rho.project-file-viewer")
                .expect("built-in project file viewer plugin ID must be valid"),
            PluginVersion::parse("1.0.0")
                .expect("built-in project file viewer version must be valid"),
            vec![rho_extension_runtime::ScopePolicy::application_kind()],
        );
        descriptor.provides = vec![CapabilityDeclaration::new(
            project_file_viewer_capability_id(),
            1,
        )];
        Self { descriptor }
    }
}

impl InternalPlugin for ProjectFileViewerPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            context
                .effects
                .register_project_file_viewer(
                    context.registry,
                    project_file_viewer_capability_id(),
                    ProjectFileViewerContribution::new(
                        vec![
                            "application/json".to_string(),
                            "image/gif".to_string(),
                            "image/jpeg".to_string(),
                            "image/png".to_string(),
                            "image/webp".to_string(),
                            "text/csv".to_string(),
                            "text/html".to_string(),
                            "text/markdown".to_string(),
                            "text/plain".to_string(),
                            "text/tab-separated-values".to_string(),
                            "text/x-r".to_string(),
                            "text/x-r-markdown".to_string(),
                        ],
                        MAX_VIEWER_FILE_BYTES as usize,
                        MAX_VIEWER_HTML_BYTES as usize,
                    ),
                )
                .map_err(|error| {
                    ActivationError::new("project_file_viewer_registration", error.to_string())
                })?;
            Ok(())
        })
    }
}

pub(crate) struct RunHistoryPlugin {
    descriptor: PluginDescriptor,
}

impl RunHistoryPlugin {
    pub(crate) fn new() -> Self {
        let mut descriptor = PluginDescriptor::new(
            rho_extension_runtime::PluginId::new("org.yulab.rho.run-history")
                .expect("built-in Run History plugin ID must be valid"),
            PluginVersion::parse("1.0.0").expect("built-in Run History version must be valid"),
            vec![rho_extension_runtime::ScopePolicy::project_kind()],
        );
        descriptor.provides = vec![CapabilityDeclaration::new(
            run_history_source_capability_id(),
            1,
        )];
        descriptor.requires = vec![CapabilityRequirement::new(runs_broker_capability_id(), 1)];
        Self { descriptor }
    }
}

impl InternalPlugin for RunHistoryPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            context
                .effects
                .register_source(
                    context.registry,
                    run_history_source_capability_id(),
                    Arc::new(RunHistorySourceHandler {
                        broker: Arc::clone(&context.broker),
                    }),
                )
                .map_err(|error| {
                    ActivationError::new("run_history_registration", error.to_string())
                })?;
            Ok(())
        })
    }
}

struct RunHistorySourceHandler {
    broker: Arc<dyn BrokerFacade>,
}

impl SourceHandler for RunHistorySourceHandler {
    fn call<'a>(
        &'a self,
        request: BoundedJson,
    ) -> Pin<Box<dyn Future<Output = Result<BoundedJson, BrokerError>> + Send + 'a>> {
        let broker = Arc::clone(&self.broker);
        Box::pin(async move {
            let request = BrokerRequest {
                operation_id: runs_broker_operation_id(),
                payload: request,
                response_class: BrokerResponseClass::Generic,
            };
            Ok(broker.call(request).await?.payload)
        })
    }
}

fn internal_plugin_inventory() -> Vec<Arc<dyn InternalPlugin>> {
    vec![
        Arc::new(CoreWorkbenchPlugin::new()),
        Arc::new(ProjectFileViewerPlugin::new()),
        Arc::new(RunHistoryPlugin::new()),
        Arc::new(WorkspaceSnapshotPlugin::new()),
    ]
}

pub(crate) fn internal_plugins_for_scope(scope_kind: &ScopeKindId) -> Vec<Arc<dyn InternalPlugin>> {
    internal_plugin_inventory()
        .into_iter()
        .filter(|plugin| plugin.descriptor().allowed_scopes == [scope_kind.clone()])
        .collect()
}
