import type {
  RuntimeExecution,
  RuntimeExecutionCursor,
  RuntimeExecutionDeleteResult,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputPageRequest,
  RuntimeOutputPolicyUpdate,
  RuntimeOutputPolicyView,
  RuntimeOutputPruneResult,
  RuntimeOutputReference,
  RuntimeOutputSearchRequest,
  RuntimeOutputSearchResult,
} from "./runtime-output";
import type {
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeExecuteRequest,
  RuntimeExecutionStartResponse,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
} from "./runtime";

export type {
  RuntimeExecution,
  RuntimeExecutionCursor,
  RuntimeExecutionDeleteResult,
  RuntimeExecutionStatus,
  RuntimeOutputChunk,
  RuntimeOutputFollowFrame,
  RuntimeOutputPage,
  RuntimeOutputPageRequest,
  RuntimeOutputPolicy,
  RuntimeOutputPolicyUpdate,
  RuntimeOutputPolicyView,
  RuntimeOutputPresentationKind,
  RuntimeOutputPruneResult,
  RuntimeOutputReference,
  RuntimeOutputReferenceKind,
  RuntimeOutputSearchHit,
  RuntimeOutputSearchRequest,
  RuntimeOutputSearchResult,
  RuntimeOutputState,
  RuntimeOutputStorageKind,
  RuntimeOutputTransport,
} from "./runtime-output";

export type {
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeDescriptor,
  RuntimeExecuteRequest,
  RuntimeExecutionSourceContext,
  RuntimeExecutionSourceRange,
  RuntimeExecutionStartResponse,
  RuntimeInstanceRequest,
  RuntimePersistenceClass,
  RuntimeProviderDefinition,
  RuntimeProviderRegistration,
  RuntimeRegistrySnapshot,
  RuntimeStatus,
  RuntimeTransport,
} from "./runtime";

export type UiSnapshotSource = "tauri" | "mock";
export type HealthState = "ready" | "degraded" | "unavailable" | "restarting";
export type ActiveOperationState = "queued" | "running" | "waiting" | "cancelling";
export type CommandPlacementTag =
  | "palette"
  | "surface_local"
  | "primary_candidate"
  | "menu"
  | "context_menu"
  | "keyboard";

export type SurfaceOrigin =
  | { readonly kind: "application"; readonly component_id: string }
  | {
      readonly kind: "workspace_plugin";
      readonly plugin_id: string;
      readonly package_digest: string;
    };

export interface ResourceBinding {
  readonly resource_provider_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly resource_revision: number | null;
}

export type UiSelection =
  | { readonly kind: "resource"; readonly binding: ResourceBinding }
  | {
      readonly kind: "text_range";
      readonly binding: ResourceBinding;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "run"; readonly run_id: string }
  | { readonly kind: "artifact"; readonly artifact_id: string }
  | { readonly kind: "object"; readonly object_id: string }
  | { readonly kind: "finding"; readonly finding_id: string }
  | { readonly kind: "task"; readonly task_id: string }
  | { readonly kind: "vibe_block"; readonly page_id: string; readonly block_id: string };

export interface ActiveOperation {
  readonly operation_id: string;
  readonly label: string;
  readonly state: ActiveOperationState;
}

export interface UiContext {
  readonly project_id: string;
  readonly project_revision: number;
  readonly scene_id: string | null;
  readonly page_id: string | null;
  readonly focused_surface_instance_id: string | null;
  readonly selection: UiSelection | null;
  readonly workspace_health: HealthState;
  readonly agent_health: HealthState;
  readonly active_operations: readonly ActiveOperation[];
}

export interface CommandDefinition {
  readonly command_id: string;
  readonly label: string;
  readonly purpose: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly consequence: string;
  readonly availability_predicate_id: string;
  readonly placement_tags: readonly CommandPlacementTag[];
  readonly origin: SurfaceOrigin;
}

export type CommandAvailability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string };

export interface CommandRegistration {
  readonly definition: CommandDefinition;
  readonly activation_generation: number;
  readonly availability: CommandAvailability;
}

export interface UiHealthDetail {
  readonly state: HealthState;
  readonly label: string;
  readonly detail: string | null;
}

export interface UiKernelSnapshot {
  readonly contract: "rho.ui.kernel.snapshot.v1";
  readonly contract_major: 1;
  readonly snapshot_revision: number;
  readonly project: {
    readonly project_id: string;
    readonly display_label: string;
    readonly display_path: string;
  };
  readonly context: UiContext;
  readonly health: {
    readonly workspace: UiHealthDetail;
    readonly agent: UiHealthDetail;
  };
  readonly command_registry: {
    readonly registrations: readonly CommandRegistration[];
  };
}

export interface SetUiSelectionRequest {
  readonly project_id: string;
  readonly expected_project_revision: number;
  readonly expected_snapshot_revision: number;
  readonly selection: UiSelection | null;
}

export type SurfaceLifecycleState =
  | "active"
  | "hidden"
  | "suspended"
  | "failed"
  | "placeholder";

export interface RuntimeAttachmentRequest {
  readonly runtime: RuntimeInstanceRequest;
  readonly surface: SurfaceInstanceRequest;
}

export interface RuntimeDetachRequest {
  readonly surface: SurfaceInstanceRequest;
}

export interface RuntimeOutputEvent {
  readonly sequence: number;
  readonly runtime_instance_id: string;
  readonly console_instance_id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export type ResourceStatus = "ready" | "missing" | "unsupported";
export type ResourceReadConsistency = "shared_document" | "immutable_snapshot";

export interface ResourceDescriptor {
  readonly resource_provider_id: string;
  readonly project_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly resource_revision: number;
  readonly label: string;
  readonly capabilities: readonly string[];
  readonly status: ResourceStatus;
  readonly media_type: string | null;
  readonly size_bytes: number | null;
  readonly content_sha256: string | null;
}

export interface ResourceProviderRegistration {
  readonly definition: {
    readonly resource_provider_id: string;
    readonly resource_kinds: readonly string[];
    readonly display_label: string;
    readonly capabilities: readonly string[];
    readonly application_component_id: string;
  };
  readonly activation_generation: number;
}

export interface ResourceRegistrySnapshot {
  readonly contract: "rho.ui.resource-registry.snapshot.v1";
  readonly contract_major: 1;
  readonly snapshot_revision: number;
  readonly project_id: string;
  readonly project_revision: number;
  readonly providers: readonly ResourceProviderRegistration[];
  readonly resources: readonly ResourceDescriptor[];
}

export interface ResourceTarget {
  readonly project_id: string;
  readonly resource_provider_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly expected_project_revision: number;
  readonly expected_resource_revision: number;
}

export interface ResourceResolveRequest {
  readonly project_id: string;
  readonly resource_provider_id: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly expected_project_revision: number;
  readonly expected_snapshot_revision: number;
}

export interface ResourceReadRequest {
  readonly target: ResourceTarget;
  readonly consistency: ResourceReadConsistency;
}

export interface ResourceContent {
  readonly contract: "rho.ui.resource-content.v1";
  readonly descriptor: ResourceDescriptor;
  readonly consistency: ResourceReadConsistency;
  readonly document_revision: number;
  readonly base_resource_revision: number;
  readonly dirty: boolean;
  readonly stale: boolean;
  readonly content_encoding: string;
  readonly content: string;
}

export interface ResourceDraftRequest {
  readonly target: ResourceTarget;
  readonly expected_document_revision: number;
  readonly content: string;
}

export interface ResourceSaveRequest {
  readonly target: ResourceTarget;
  readonly expected_document_revision: number;
}

export interface ResourceReloadRequest extends ResourceSaveRequest {
  readonly discard_dirty: boolean;
}

export interface ResourceRenameRequest {
  readonly target: ResourceTarget;
  readonly expected_document_revision: number | null;
  readonly new_resource_id: string;
}

export interface ResourceDeleteRequest {
  readonly target: ResourceTarget;
  readonly expected_document_revision: number | null;
  readonly discard_dirty: boolean;
}

export interface SurfaceDefinition {
  readonly surface_id: string;
  readonly contract_major: number;
  readonly label: string;
  readonly purpose: string;
  readonly icon?: string;
  readonly renderer_kind: "trusted_host" | "declarative_document";
  readonly scope: "application" | "project";
  readonly instance_policy: "singleton" | "multi_instance";
  readonly instance_quota_class: "strip" | "standard" | "heavy";
  readonly resource_kinds: readonly string[];
  readonly modes: readonly {
    readonly mode_id: string;
    readonly label: string;
    readonly interaction_kind: "read_only" | "interactive";
  }[];
  readonly sizing_hints: Readonly<Record<string, unknown>>;
  readonly accepted_contexts: readonly string[];
  readonly commands: readonly string[];
  readonly origin: SurfaceOrigin;
}

export interface SurfaceFactoryRegistration {
  readonly definition: SurfaceDefinition;
  readonly activation_generation: number;
}

export interface SurfaceInstance {
  readonly instance_id: string;
  readonly surface_id: string;
  readonly project_id: string;
  readonly origin: SurfaceOrigin;
  readonly activation_generation: number;
  readonly surface_revision: number;
  readonly mode_id: string | null;
  readonly resource_binding: ResourceBinding | null;
  readonly runtime_binding: RuntimeBinding | null;
  readonly view_group_id: string | null;
  readonly view_state: unknown;
  readonly lifecycle_state: SurfaceLifecycleState;
}

export interface SurfaceRuntimeSnapshot {
  readonly contract: "rho.ui.surface-runtime.snapshot.v1";
  readonly contract_major: 1;
  readonly snapshot_revision: number;
  readonly project_id: string;
  readonly project_revision: number;
  readonly catalog: {
    readonly factories: readonly SurfaceFactoryRegistration[];
    readonly instances: readonly SurfaceInstance[];
  };
}

export interface OpenSurfaceRequest {
  readonly surface_id: string;
  readonly project_id: string;
  readonly mode_id: string | null;
  readonly resource_binding: ResourceBinding | null;
  readonly runtime_binding: RuntimeBinding | null;
  readonly view_group_id: string | null;
  readonly view_state: unknown;
  readonly instance_disposition: "reuse_exact" | "new_instance";
  readonly placement_intent: "current" | "beside" | "stack" | "container";
  readonly expected_project_revision: number;
  readonly expected_layout_revision: number;
}

export interface SurfaceInstanceRequest {
  readonly project_id: string;
  readonly instance_id: string;
  readonly activation_generation: number;
  readonly expected_project_revision: number;
  readonly expected_surface_revision: number;
}

export type SurfaceInstanceMutation =
  | { readonly kind: "set_mode"; readonly mode_id: string | null }
  | { readonly kind: "set_view_state"; readonly view_state: unknown }
  | { readonly kind: "set_lifecycle"; readonly state: SurfaceLifecycleState }
  | { readonly kind: "bind_resource"; readonly binding: ResourceBinding | null }
  | { readonly kind: "bind_runtime"; readonly binding: RuntimeBinding | null }
  | { readonly kind: "set_view_group"; readonly view_group_id: string | null };

export interface UpdateSurfaceRequest {
  readonly target: SurfaceInstanceRequest;
  readonly mutation: SurfaceInstanceMutation;
}

export type PluginSurfaceEventKind = "input" | "change" | "submit" | "activate";

export type PluginSurfaceNoticeTone = "info" | "success" | "warning" | "error";

export type PluginSurfaceBlock =
  | { readonly kind: "row"; readonly blocks: readonly PluginSurfaceBlock[] }
  | { readonly kind: "column"; readonly blocks: readonly PluginSurfaceBlock[] }
  | {
      readonly kind: "grid";
      readonly columns: number;
      readonly blocks: readonly {
        readonly column_span: number;
        readonly block: PluginSurfaceBlock;
      }[];
    }
  | {
      readonly kind: "tabs";
      readonly active_tab_id: string;
      readonly tabs: readonly {
        readonly tab_id: string;
        readonly label: string;
        readonly blocks: readonly PluginSurfaceBlock[];
      }[];
    }
  | { readonly kind: "group"; readonly label: string | null; readonly blocks: readonly PluginSurfaceBlock[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly code: string; readonly language: string | null }
  | { readonly kind: "key_value"; readonly items: readonly { readonly key: string; readonly value: string }[] }
  | { readonly kind: "table"; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "notice"; readonly tone: PluginSurfaceNoticeTone; readonly text: string }
  | { readonly kind: "artifact_image_ref"; readonly artifact_id: string; readonly media_type: string; readonly alt: string }
  | {
      readonly kind: "field";
      readonly control_id: string;
      readonly label: string;
      readonly value: string;
      readonly placeholder: string | null;
      readonly disabled: boolean;
      readonly busy: boolean;
    }
  | {
      readonly kind: "select";
      readonly control_id: string;
      readonly label: string;
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly disabled: boolean;
      readonly busy: boolean;
    }
  | {
      readonly kind: "command_button";
      readonly control_id: string;
      readonly label: string;
      readonly command_id: string;
      readonly disabled: boolean;
      readonly busy: boolean;
    };

export interface PluginSurfaceDocument {
  readonly contract: "rho.plugin_surface_document.v1";
  readonly revision: number;
  readonly title: string;
  readonly blocks: readonly PluginSurfaceBlock[];
}

export interface PluginSurfaceDocumentRequest {
  readonly target: SurfaceInstanceRequest;
  readonly expected_layout_revision: number | null;
  readonly expected_page_revision: number | null;
}

export interface PluginSurfaceEventRequest extends PluginSurfaceDocumentRequest {
  readonly expected_document_revision: number;
  readonly control_id: string;
  readonly event_kind: PluginSurfaceEventKind;
  readonly value: unknown;
}

export interface PluginSurfaceDocumentView {
  readonly project_id: string;
  readonly instance_id: string;
  readonly surface_id: string;
  readonly surface_revision: number;
  readonly document: PluginSurfaceDocument;
  readonly provenance: unknown;
}

export interface PluginSurfaceEventResult {
  readonly event_id: string;
  readonly status: "completed" | "queued";
  readonly document: PluginSurfaceDocument | null;
  readonly command_result: unknown | null;
  readonly provenance: unknown | null;
}

export type CheckSeverity = "info" | "warning" | "error";
export type CheckResultStatus = "clean" | "findings" | "incomplete" | "failed";

export type CheckEvidence =
  | {
      readonly kind: "source_range";
      readonly path: string;
      readonly line: number;
      readonly column: number | null;
      readonly excerpt: string | null;
    }
  | { readonly kind: "project_file"; readonly path: string }
  | { readonly kind: "run_ref"; readonly run_id: string }
  | { readonly kind: "environment_ref"; readonly snapshot_id: string }
  | { readonly kind: "note"; readonly text: string };

export interface CheckFinding {
  readonly rule_id: string;
  readonly rule_version: number;
  readonly origin: SurfaceOrigin;
  readonly activation_generation: number;
  readonly severity: CheckSeverity;
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  readonly remediation: string;
  readonly evidence: readonly CheckEvidence[];
  readonly limitations: readonly string[];
}

export interface CheckProjectSnapshot {
  readonly contract: "rho.ui.check-project.snapshot.v1";
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly project_revision: number;
  readonly captured_at: string;
  readonly files: readonly {
    readonly path: string;
    readonly size_bytes: number;
    readonly content_sha256: string;
    readonly skipped: boolean;
    readonly skip_reason: string | null;
  }[];
  readonly source_bytes: number;
  readonly renv_lock_sha256: string | null;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface CheckResult {
  readonly contract: "rho.ui.check-result.v1";
  readonly result_id: string;
  readonly project_id: string;
  readonly project_revision: number;
  readonly snapshot: CheckProjectSnapshot;
  readonly ruleset_digest: string;
  readonly generated_at: string;
  readonly status: CheckResultStatus;
  readonly findings: readonly CheckFinding[];
  readonly coverage: {
    readonly files_scanned: number;
    readonly files_skipped: number;
    readonly core_rules: number;
    readonly plugin_rule_packs: number;
    readonly plugin_rule_failures: number;
  };
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

export interface CheckRunRequest {
  readonly project_id: string;
  readonly expected_project_revision: number;
}

export interface CheckResultRequest extends CheckRunRequest {
  readonly result_id: string;
}

export interface CheckRunResponse {
  readonly result: CheckResult;
}

export type LayoutAxis = "horizontal" | "vertical";

export type LayoutBasis =
  | { readonly kind: "auto" }
  | { readonly kind: "intrinsic" }
  | { readonly kind: "fixed"; readonly logical_pixels: number }
  | { readonly kind: "fraction"; readonly weight: number }
  | {
      readonly kind: "minmax";
      readonly min_logical_pixels: number;
      readonly max_logical_pixels: number;
      readonly weight: number;
    };

export interface LayoutChild {
  readonly child: LayoutNode;
  readonly basis: LayoutBasis;
  readonly resizable: boolean;
  readonly collapse_priority: number | null;
}

export interface StackNode {
  readonly node_id: string;
  readonly active_instance_id: string;
  readonly instances: readonly string[];
}

export type LayoutNode =
  | {
      readonly kind: "container";
      readonly node_id: string;
      readonly axis: LayoutAxis;
      readonly children: readonly LayoutChild[];
    }
  | ({ readonly kind: "stack" } & StackNode)
  | { readonly kind: "surface"; readonly node_id: string; readonly instance_id: string };

export interface SceneState {
  readonly scene_id: string;
  readonly project_id: string;
  readonly label: string;
  readonly layout_revision: number;
  readonly root: LayoutNode;
  readonly focused_surface_instance_id: string | null;
  readonly utility_tray: StackNode | null;
}

export type SceneEdit =
  | {
      readonly kind: "insert_surface";
      readonly target_container_node_id: string;
      readonly child_index: number;
      readonly instance_id: string;
      readonly basis: LayoutBasis;
    }
  | {
      readonly kind: "move_surface";
      readonly instance_id: string;
      readonly target_container_node_id: string;
      readonly child_index: number;
      readonly basis: LayoutBasis;
    }
  | {
      readonly kind: "stack_surface";
      readonly instance_id: string;
      readonly target_instance_id: string;
    }
  | {
      readonly kind: "unstack_surface";
      readonly instance_id: string;
      readonly target_container_node_id: string;
      readonly child_index: number;
      readonly basis: LayoutBasis;
    }
  | { readonly kind: "close_surface_placement"; readonly instance_id: string }
  | {
      readonly kind: "resize_boundary";
      readonly container_node_id: string;
      readonly before_child_index: number;
      readonly before_basis: LayoutBasis;
      readonly after_basis: LayoutBasis;
    }
  | {
      readonly kind: "set_child_basis";
      readonly container_node_id: string;
      readonly child_index: number;
      readonly basis: LayoutBasis;
    }
  | {
      readonly kind: "set_collapse_priority";
      readonly container_node_id: string;
      readonly child_index: number;
      readonly collapse_priority: number | null;
    }
  | {
      readonly kind: "set_container_axis";
      readonly container_node_id: string;
      readonly axis: LayoutAxis;
    }
  | {
      readonly kind: "set_stack_active";
      readonly stack_node_id: string;
      readonly instance_id: string;
    }
  | { readonly kind: "set_focus"; readonly instance_id: string | null }
  | { readonly kind: "normalize" }
  | { readonly kind: "distribute_container"; readonly container_node_id: string }
  | { readonly kind: "replace_root"; readonly root: LayoutNode };

export interface SceneEditRequest {
  readonly project_id: string;
  readonly expected_project_revision: number;
  readonly expected_layout_revision: number;
  readonly edit: SceneEdit;
}

export interface StudioRevisionRequest {
  readonly project_id: string;
  readonly expected_project_revision: number;
  readonly expected_layout_revision: number;
}

export interface StudioRuntimeSnapshot {
  readonly contract: "rho.ui.studio-runtime.snapshot.v1";
  readonly contract_major: 1;
  readonly snapshot_revision: number;
  readonly project_id: string;
  readonly project_revision: number;
  readonly scene: SceneState;
  readonly unplaced_instance_ids: readonly string[];
  readonly can_undo: boolean;
  readonly can_redo: boolean;
}

export type UiProfileMode = "studio" | "vibe";
export type UiProfileLoadStatus = "created" | "clean" | "recovered_backup";

export interface RuntimeAttachmentIntent {
  readonly runtime_provider_id: string;
  readonly runtime_instance_id: string;
  readonly runtime_kind: string;
}

export interface SurfaceInstanceSpec {
  readonly instance_id: string;
  readonly surface_id: string;
  readonly origin: SurfaceOrigin;
  readonly mode_id: string | null;
  readonly resource_binding: ResourceBinding | null;
  readonly runtime_attachment_intent: RuntimeAttachmentIntent | null;
  readonly view_group_id: string | null;
  readonly view_state: unknown;
}

export type VibeRichTextMark =
  | { readonly kind: "strong" }
  | { readonly kind: "emphasis" }
  | { readonly kind: "code" }
  | { readonly kind: "link"; readonly href: string };

export interface VibeRichTextInline {
  readonly text: string;
  readonly marks: readonly VibeRichTextMark[];
}

export type VibeRichTextBlock =
  | { readonly kind: "paragraph"; readonly content: readonly VibeRichTextInline[] }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly content: readonly VibeRichTextInline[] };

export interface VibeRichTextDocument {
  readonly blocks: readonly VibeRichTextBlock[];
}

export type VibeBlockContent =
  | { readonly kind: "rich_text"; readonly document: VibeRichTextDocument }
  | { readonly kind: "callout"; readonly tone: string; readonly text: string }
  | { readonly kind: "divider" }
  | { readonly kind: "file_excerpt"; readonly resource: ResourceBinding; readonly start_line: number; readonly end_line: number }
  | { readonly kind: "artifact_ref"; readonly artifact_id: string; readonly label: string }
  | { readonly kind: "finding_ref"; readonly finding_id: string; readonly label: string }
  | { readonly kind: "task_ref"; readonly task_id: string; readonly label: string }
  | { readonly kind: "surface_ref"; readonly instance_id: string; readonly live: boolean }
  | { readonly kind: "command_ref"; readonly command_id: string; readonly label: string };

export interface VibeBlock {
  readonly block_id: string;
  readonly content: VibeBlockContent;
}

export interface VibeGridPlacement {
  readonly block_id: string;
  readonly row_start: number;
  readonly column_start: number;
  readonly column_span: number;
}

export type VibeSectionLayout =
  | { readonly kind: "flow" }
  | { readonly kind: "grid"; readonly placements: readonly VibeGridPlacement[] };

export interface VibeSection {
  readonly section_id: string;
  readonly heading: string | null;
  readonly layout: VibeSectionLayout;
  readonly blocks: readonly VibeBlock[];
}

export interface VibePage {
  readonly page_id: string;
  readonly project_id: string;
  readonly label: string;
  readonly page_revision: number;
  readonly sections: readonly VibeSection[];
  readonly focused_block_id: string | null;
}

export interface ProjectUiProfile {
  readonly schema_version: 3;
  readonly project_id: string;
  readonly revision: number;
  readonly active_mode: UiProfileMode;
  readonly active_studio_scene_id: string | null;
  readonly active_vibe_page_id: string | null;
  readonly studio_scenes: readonly SceneState[];
  readonly vibe_pages: readonly VibePage[];
  readonly surface_instance_specs: readonly SurfaceInstanceSpec[];
  readonly last_focused_surface_instance_id: string | null;
}

export interface StudioScenePreset {
  readonly preset_id: string;
  readonly label: string;
  readonly description: string;
  readonly scene: SceneState;
  readonly surface_instance_specs: readonly SurfaceInstanceSpec[];
}

export interface ProjectUiProfileSnapshot {
  readonly contract: "rho.ui.project-profile.snapshot.v1";
  readonly contract_major: 1;
  readonly profile: ProjectUiProfile;
  readonly immutable_scene_presets: readonly StudioScenePreset[];
  readonly load_status: UiProfileLoadStatus;
  readonly recovery_detail: string | null;
}

export interface UiProfileRevisionRequest {
  readonly project_id: string;
  readonly expected_profile_revision: number;
}

export interface UiProfileSetModeRequest {
  readonly target: UiProfileRevisionRequest;
  readonly mode: UiProfileMode;
}

export interface UiProfileSelectSceneRequest {
  readonly target: UiProfileRevisionRequest;
  readonly scene_id: string;
}

export interface UiProfileSelectPageRequest {
  readonly target: UiProfileRevisionRequest;
  readonly page_id: string;
}

export interface UiProfileSceneLabelRequest {
  readonly target: UiProfileRevisionRequest;
  readonly scene_id: string;
  readonly label: string;
}

export interface UiProfileSceneTargetRequest {
  readonly target: UiProfileRevisionRequest;
  readonly scene_id: string;
}

export type VibePageMutation =
  | { readonly kind: "replace_sections"; readonly sections: readonly VibeSection[]; readonly focused_block_id: string | null }
  | { readonly kind: "set_focus"; readonly block_id: string | null }
  | { readonly kind: "update_block"; readonly block_id: string; readonly replacement: VibeBlock }
  | { readonly kind: "insert_section"; readonly index: number; readonly section: VibeSection }
  | { readonly kind: "remove_section"; readonly section_id: string }
  | { readonly kind: "insert_block"; readonly section_id: string; readonly index: number; readonly block: VibeBlock; readonly grid_placement: VibeGridPlacement | null }
  | { readonly kind: "move_block"; readonly block_id: string; readonly target_section_id: string; readonly target_index: number; readonly grid_placement: VibeGridPlacement | null }
  | { readonly kind: "remove_block"; readonly block_id: string }
  | { readonly kind: "set_section_layout"; readonly section_id: string; readonly layout: VibeSectionLayout };

export interface VibePageMutationRequest {
  readonly target: UiProfileRevisionRequest;
  readonly page_id: string;
  readonly expected_page_revision: number;
  readonly mutation: VibePageMutation;
}

export interface VibePageExportRequest {
  readonly project_id: string;
  readonly expected_profile_revision: number;
  readonly page_id: string;
  readonly expected_page_revision: number;
}

export interface VibePageExport {
  readonly contract: "rho.ui.vibe-page.export.v1";
  readonly project_id: string;
  readonly page_id: string;
  readonly page_revision: number;
  readonly label: string;
  readonly markdown: string;
}

export type AgentMode = "ask" | "plan" | "act";

export interface AgentDependencyDiagnostics {
  readonly package: string;
  readonly status: "ready" | "checking" | "missing" | "incompatible_version" | "namespace_load_failed" | "incompatible_api" | "probe_failed" | string;
  readonly installed_version: string | null;
  readonly required_version: string;
  readonly resolved_path: string | null;
  readonly detail: string | null;
  readonly remediation: string | null;
}

export interface AgentRuntimeDiagnostics {
  readonly available: boolean;
  readonly status: string;
  readonly rscript: string | null;
  readonly r_version: string | null;
  readonly aisdk_version: string | null;
  readonly provider_adapters_available: boolean;
  readonly provider_health: string;
  readonly dependencies: readonly AgentDependencyDiagnostics[];
  readonly error: string | null;
}

export interface AgentConversationSummary {
  readonly conversation_id: string;
  readonly project_root: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly legacy_unthreaded: boolean;
  readonly turn_count: number;
  readonly status: string;
  readonly latest_turn_id: string | null;
  readonly latest_mode: string | null;
  readonly latest_prompt_preview: string | null;
  readonly terminal_reason: string | null;
  readonly pending_request_id: string | null;
}

export interface AgentTurnSummary {
  readonly turn_id: string;
  readonly conversation_id: string;
  readonly project_root: string;
  readonly mode: AgentMode;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly prompt_preview: string;
  readonly model: string;
  readonly workspace_id_before: string | null;
  readonly state_revision_before: number | null;
  readonly project_revision_before: number | null;
  readonly workspace_id_after: string | null;
  readonly state_revision_after: number | null;
  readonly project_revision_after: number | null;
  readonly final_message: string | null;
  readonly error_message: string | null;
  readonly pending_request_id: string | null;
  readonly retry_of_turn_id: string | null;
  readonly terminal_reason: string | null;
}

export interface AgentTurnEvent {
  readonly id: number;
  readonly turn_id: string;
  readonly timestamp: string;
  readonly event_type: string;
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly tool: string | null;
  readonly request_id: string | null;
  readonly code: string | null;
  readonly details_json: string;
}

export interface AgentApprovalRequest {
  readonly request_id: string;
  readonly turn_id: string;
  readonly project_root: string;
  readonly tool: string;
  readonly policy: string;
  readonly status: string;
  readonly decision: string | null;
  readonly reason: string | null;
  readonly arguments_json: string;
  readonly code: string | null;
  readonly workspace_id: string | null;
  readonly state_revision: number | null;
  readonly project_revision: number | null;
  readonly requested_at: string;
  readonly responded_at: string | null;
  readonly continuation_outcome: string | null;
}

export interface AgentTurnDetail {
  readonly turn: AgentTurnSummary;
  readonly events: readonly AgentTurnEvent[];
  readonly approvals: readonly AgentApprovalRequest[];
  readonly context_items?: readonly AgentContextPlanItem[];
}

export interface AgentContextPlanItem {
  readonly ordinal: number;
  readonly source_kind: string;
  readonly source_id: string | null;
  readonly source_revision: string | null;
  readonly source_sha256: string;
  readonly trust_class: string;
  readonly capacity_source: string;
  readonly original_bytes: number;
  readonly included_bytes: number;
  readonly estimated_tokens: number;
  readonly disposition: string;
  readonly reason_code: string | null;
}

export interface AgentContextPreviewRequest {
  readonly prompt: string;
  readonly mode: AgentMode;
  readonly task_kind: "agent_turn" | "problem_repair";
  readonly model_id: string | null;
  readonly editor_context: unknown | null;
  readonly conversation_id: string | null;
  readonly runtime_output_context: RuntimeOutputReference | null;
}

export interface AgentContextPlanPreview {
  readonly plan_digest: string;
  readonly context_window_tokens: number;
  readonly reserved_output_tokens: number;
  readonly estimated_input_tokens: number;
  readonly capacity_source: string;
  readonly items: readonly AgentContextPlanItem[];
  readonly model_profile_id: string;
  readonly model_display_name: string;
  readonly settings_revision: number;
  readonly conversation_id: string | null;
  readonly runtime_output_context: RuntimeOutputReference | null;
}

export interface AgentModelContextCapacity {
  readonly id: string;
  readonly display_name: string;
  readonly selected: boolean;
  readonly context_window_tokens: number;
  readonly reserved_output_tokens: number;
  readonly context_capacity_source: "catalog" | "user_declared" | "conservative_default";
}

export interface AgentLlmSettingsView {
  readonly revision: number;
  readonly selected_model_id: string;
  readonly models: readonly AgentModelContextCapacity[];
}

export interface AgentContextCapacityRequest {
  readonly model_id: string;
  readonly expected_revision: number;
  readonly context_window_tokens: number;
  readonly reserved_output_tokens: number;
}

export interface RunAgentRequest {
  readonly prompt: string;
  readonly mode: AgentMode;
  readonly task_kind: "agent_turn" | "problem_repair";
  readonly model_id: string | null;
  readonly auto_approve: boolean;
  readonly editor_context: unknown | null;
  readonly conversation_id: string | null;
  readonly runtime_output_context: RuntimeOutputReference | null;
  readonly context_plan_digest: string | null;
}

export interface RunAgentResponse {
  readonly status: "started";
  readonly turn_id: string;
  readonly conversation_id: string;
  readonly retry_of_turn_id: string | null;
  readonly auto_approve: boolean;
  readonly task_kind: string;
}

export interface AgentApprovalDecisionRequest {
  readonly request_id: string;
  readonly decision: "approve" | "reject" | "cancel";
  readonly reason: string | null;
}

export interface AgentFileApplyRequest {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_disk_sha256: string | null;
  readonly before_content: string;
}

export interface AgentFileUndoRequest {
  readonly turn_id: string;
  readonly proposal_event_id: number;
  readonly path: string;
  readonly expected_after_sha256: string;
  readonly before_content: string;
  readonly created: boolean;
}

export interface AgentFileMutationResponse {
  readonly status: string;
  readonly path: string;
  readonly content: string | null;
  readonly start: number;
  readonly end: number;
  readonly after_sha256: string | null;
}

export interface DomainSurfaceItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly status: string | null;
  readonly detail: string | null;
}

export interface DomainSurfaceData {
  readonly surface_id: string;
  readonly loaded_at: string;
  readonly summary: string;
  readonly items: readonly DomainSurfaceItem[];
}

export interface PlotImageView {
  readonly plot_id: string;
  readonly media_type: string;
  readonly data_base64: string;
}

export type Unsubscribe = () => void;

export interface WorkspacePreparationIssue {
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly technical_detail: string | null;
}

export interface WorkspacePreparation {
  readonly status: "ready" | "needs_attention";
  readonly phase: string;
  readonly workspace_ready: boolean;
  readonly restored_project_status: string | null;
  readonly issue: WorkspacePreparationIssue | null;
}

export type ProjectSwitchStatus =
  | "ready"
  | "cancelled"
  | "blocked"
  | "unavailable"
  | "failed_restored"
  | "fatal";

export interface ProjectSwitchResponse {
  readonly status: ProjectSwitchStatus;
  readonly project: {
    readonly root: string;
    readonly files: readonly unknown[];
    readonly truncated: boolean;
  } | null;
  readonly session: unknown;
  readonly unavailable: { readonly path: string; readonly reason: string } | null;
  readonly blocker: {
    readonly kind: string;
    readonly message: string;
    readonly pending_count: number;
  } | null;
  readonly reason_code: string | null;
  readonly message: string | null;
  readonly restored_root: string | null;
  readonly restart_required: boolean;
}

export interface UiKernelTransport {
  readonly source: UiSnapshotSource;
  prepareWorkspace(chooseRscript?: boolean): Promise<WorkspacePreparation>;
  openProject(path: string): Promise<ProjectSwitchResponse>;
  pickProjectDirectory(): Promise<ProjectSwitchResponse>;
  loadSnapshot(): Promise<UiKernelSnapshot>;
  setSelection(request: SetUiSelectionRequest): Promise<UiKernelSnapshot>;
  subscribeInvalidated(listener: () => void): Unsubscribe;
  loadSurfaces(): Promise<SurfaceRuntimeSnapshot>;
  openSurface(request: OpenSurfaceRequest): Promise<SurfaceRuntimeSnapshot>;
  updateSurface(request: UpdateSurfaceRequest): Promise<SurfaceRuntimeSnapshot>;
  closeSurface(request: SurfaceInstanceRequest): Promise<SurfaceRuntimeSnapshot>;
  suspendSurface(request: SurfaceInstanceRequest): Promise<SurfaceRuntimeSnapshot>;
  resumeSurface(request: SurfaceInstanceRequest): Promise<SurfaceRuntimeSnapshot>;
  subscribeSurfacesInvalidated(listener: () => void): Unsubscribe;
  loadPluginSurfaceDocument(request: PluginSurfaceDocumentRequest): Promise<PluginSurfaceDocumentView>;
  dispatchPluginSurfaceEvent(request: PluginSurfaceEventRequest): Promise<PluginSurfaceEventResult>;
  subscribePluginSurfacesInvalidated(listener: () => void): Unsubscribe;
  runCheckProject(request: CheckRunRequest): Promise<CheckRunResponse>;
  loadCheckResult(request: CheckResultRequest): Promise<CheckResult>;
  subscribeCheckResultsInvalidated(listener: () => void): Unsubscribe;
  loadStudio(): Promise<StudioRuntimeSnapshot>;
  applyStudio(request: SceneEditRequest): Promise<StudioRuntimeSnapshot>;
  undoStudio(request: StudioRevisionRequest): Promise<StudioRuntimeSnapshot>;
  redoStudio(request: StudioRevisionRequest): Promise<StudioRuntimeSnapshot>;
  subscribeStudioInvalidated(listener: () => void): Unsubscribe;
  loadUiProfile(): Promise<ProjectUiProfileSnapshot>;
  setUiProfileMode(request: UiProfileSetModeRequest): Promise<ProjectUiProfileSnapshot>;
  selectUiProfileScene(request: UiProfileSelectSceneRequest): Promise<ProjectUiProfileSnapshot>;
  selectUiProfilePage(request: UiProfileSelectPageRequest): Promise<ProjectUiProfileSnapshot>;
  applyVibePage(request: VibePageMutationRequest): Promise<ProjectUiProfileSnapshot>;
  exportVibePage(request: VibePageExportRequest): Promise<VibePageExport>;
  duplicateUiProfileScene(request: UiProfileSceneLabelRequest): Promise<ProjectUiProfileSnapshot>;
  saveUiProfileScene(request: UiProfileSceneTargetRequest): Promise<ProjectUiProfileSnapshot>;
  renameUiProfileScene(request: UiProfileSceneLabelRequest): Promise<ProjectUiProfileSnapshot>;
  deleteUiProfileScene(request: UiProfileSceneTargetRequest): Promise<ProjectUiProfileSnapshot>;
  resetUiProfileScene(request: UiProfileSceneTargetRequest): Promise<ProjectUiProfileSnapshot>;
  subscribeUiProfileInvalidated(listener: () => void): Unsubscribe;
  loadRuntimes(): Promise<RuntimeRegistrySnapshot>;
  createRuntime(request: RuntimeCreateRequest): Promise<RuntimeRegistrySnapshot>;
  attachRuntime(request: RuntimeAttachmentRequest): Promise<SurfaceRuntimeSnapshot>;
  detachRuntime(request: RuntimeDetachRequest): Promise<SurfaceRuntimeSnapshot>;
  interruptRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  restartRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  stopRuntime(request: RuntimeInstanceRequest): Promise<RuntimeRegistrySnapshot>;
  startRuntimeExecution(request: RuntimeExecuteRequest): Promise<RuntimeExecutionStartResponse>;
  getRuntimeExecution(executionId: string): Promise<RuntimeExecution>;
  listRuntimeExecutions(limit?: number, before?: RuntimeExecutionCursor): Promise<readonly RuntimeExecution[]>;
  loadRuntimeOutputPage(request: RuntimeOutputPageRequest): Promise<RuntimeOutputPage>;
  searchRuntimeOutput(request: RuntimeOutputSearchRequest): Promise<RuntimeOutputSearchResult>;
  getRuntimeOutputPolicy(): Promise<RuntimeOutputPolicyView>;
  updateRuntimeOutputPolicy(request: RuntimeOutputPolicyUpdate): Promise<RuntimeOutputPolicyView>;
  createRuntimeOutputReference(
    executionId: string,
    startSequence?: number,
    endSequence?: number,
  ): Promise<RuntimeOutputReference>;
  pruneRuntimeOutput(executionId: string): Promise<RuntimeOutputPruneResult>;
  deleteRuntimeExecution(executionId: string): Promise<RuntimeExecutionDeleteResult>;
  followRuntimeOutput(
    executionId: string,
    afterSequence: number,
    listener: (frame: RuntimeOutputFollowFrame) => void,
  ): Promise<void>;
  subscribeRuntimesInvalidated(listener: () => void): Unsubscribe;
  loadResources(): Promise<ResourceRegistrySnapshot>;
  resolveResource(request: ResourceResolveRequest): Promise<ResourceRegistrySnapshot>;
  readResource(request: ResourceReadRequest): Promise<ResourceContent>;
  updateResourceDraft(request: ResourceDraftRequest): Promise<ResourceContent>;
  saveResource(request: ResourceSaveRequest): Promise<ResourceContent>;
  reloadResource(request: ResourceReloadRequest): Promise<ResourceContent>;
  renameResource(request: ResourceRenameRequest): Promise<ResourceRegistrySnapshot>;
  deleteResource(request: ResourceDeleteRequest): Promise<ResourceRegistrySnapshot>;
  subscribeResourcesInvalidated(listener: () => void): Unsubscribe;
  listAgentConversations(limit?: number): Promise<readonly AgentConversationSummary[]>;
  createAgentConversation(): Promise<AgentConversationSummary>;
  listAgentTurns(conversationId: string | null, limit?: number): Promise<readonly AgentTurnSummary[]>;
  getAgentTurnDetail(turnId: string): Promise<AgentTurnDetail | null>;
  loadAgentLlmSettings(): Promise<AgentLlmSettingsView>;
  setAgentContextCapacity(request: AgentContextCapacityRequest): Promise<AgentLlmSettingsView>;
  previewAgentContext(request: AgentContextPreviewRequest): Promise<AgentContextPlanPreview>;
  runAgent(request: RunAgentRequest): Promise<RunAgentResponse>;
  retryAgentTurn(turnId: string): Promise<RunAgentResponse>;
  cancelAgentTurn(turnId: string): Promise<unknown>;
  respondAgentApproval(request: AgentApprovalDecisionRequest): Promise<unknown>;
  getAgentRuntimeDiagnostics(): Promise<AgentRuntimeDiagnostics>;
  retryAgentRuntime(): Promise<AgentRuntimeDiagnostics>;
  subscribeAgentInvalidated(listener: () => void): Unsubscribe;
  loadDomainSurface(surfaceId: string): Promise<DomainSurfaceData>;
  readPlotArtifact(plotId: string): Promise<PlotImageView>;
  retryRun(runId: string): Promise<unknown>;
  applyAgentFileEdit(request: AgentFileApplyRequest): Promise<AgentFileMutationResponse>;
  undoAgentFileEdit(request: AgentFileUndoRequest): Promise<AgentFileMutationResponse>;
}
