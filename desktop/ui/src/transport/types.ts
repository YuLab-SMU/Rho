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

export interface RuntimeBinding {
  readonly runtime_provider_id: string;
  readonly runtime_instance_id: string;
  readonly runtime_kind: string;
  readonly project_id: string;
  readonly activation_generation: number;
  readonly state_revision: number;
  readonly attach_capabilities: readonly string[];
}

export type RuntimeStatus =
  | "starting"
  | "ready"
  | "busy"
  | "interrupting"
  | "restarting"
  | "stopped"
  | "failed";

export interface RuntimeDescriptor {
  readonly runtime_provider_id: string;
  readonly runtime_instance_id: string;
  readonly runtime_kind: string;
  readonly project_id: string;
  readonly activation_generation: number;
  readonly state_revision: number;
  readonly status: RuntimeStatus;
  readonly attach_capabilities: readonly string[];
  readonly persistence_class:
    | "project_persistent"
    | "application_persistent"
    | "explicit_lease";
  readonly display_label: string;
  readonly primary_scientific_runtime: boolean;
}

export interface RuntimeProviderRegistration {
  readonly definition: {
    readonly runtime_provider_id: string;
    readonly runtime_kind: string;
    readonly display_label: string;
    readonly create_supported: boolean;
    readonly max_instances: number;
    readonly attach_capabilities: readonly string[];
    readonly application_component_id: string;
  };
  readonly activation_generation: number;
}

export interface RuntimeRegistrySnapshot {
  readonly contract: "rho.ui.runtime-registry.snapshot.v1";
  readonly contract_major: 1;
  readonly snapshot_revision: number;
  readonly project_id: string;
  readonly project_revision: number;
  readonly providers: readonly RuntimeProviderRegistration[];
  readonly instances: readonly RuntimeDescriptor[];
}

export interface RuntimeCreateRequest {
  readonly project_id: string;
  readonly runtime_provider_id: string;
  readonly expected_project_revision: number;
  readonly expected_snapshot_revision: number;
  readonly display_label: string | null;
}

export interface RuntimeInstanceRequest {
  readonly project_id: string;
  readonly runtime_provider_id: string;
  readonly runtime_instance_id: string;
  readonly activation_generation: number;
  readonly expected_project_revision: number;
  readonly expected_state_revision: number;
}

export interface RuntimeAttachmentRequest {
  readonly runtime: RuntimeInstanceRequest;
  readonly surface: SurfaceInstanceRequest;
}

export interface RuntimeDetachRequest {
  readonly surface: SurfaceInstanceRequest;
}

export interface RuntimeExecuteRequest {
  readonly runtime: RuntimeInstanceRequest;
  readonly console_instance_id: string;
  readonly expected_console_revision: number;
  readonly code: string;
}

export interface RuntimeOutputEvent {
  readonly sequence: number;
  readonly runtime_instance_id: string;
  readonly console_instance_id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface RuntimeExecutionResult {
  readonly execution_id: string;
  readonly runtime_instance_id: string;
  readonly runtime_activation_generation: number;
  readonly console_instance_id: string;
  readonly state_revision_after: number;
  readonly status: "completed" | "cancelled" | "failed";
  readonly events: readonly RuntimeOutputEvent[];
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

export type VibeBlockContent =
  | { readonly kind: "rich_text"; readonly text: string }
  | { readonly kind: "callout"; readonly tone: string; readonly text: string }
  | { readonly kind: "divider" }
  | { readonly kind: "file_excerpt"; readonly resource: ResourceBinding; readonly start_line: number; readonly end_line: number }
  | { readonly kind: "artifact_ref"; readonly artifact_id: string; readonly label: string }
  | { readonly kind: "finding_ref"; readonly finding_id: string; readonly label: string }
  | { readonly kind: "task_ref"; readonly task_id: string; readonly label: string }
  | { readonly kind: "surface_ref"; readonly instance_id: string; readonly live: boolean }
  | { readonly kind: "command_ref"; readonly command_id: string; readonly label: string };

export interface VibePage {
  readonly page_id: string;
  readonly project_id: string;
  readonly label: string;
  readonly page_revision: number;
  readonly sections: readonly {
    readonly section_id: string;
    readonly heading: string | null;
    readonly layout: Readonly<Record<string, unknown>>;
    readonly blocks: readonly {
      readonly block_id: string;
      readonly content: VibeBlockContent;
    }[];
  }[];
  readonly focused_block_id: string | null;
}

export interface ProjectUiProfile {
  readonly schema_version: 1;
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

export type Unsubscribe = () => void;

export interface UiKernelTransport {
  readonly source: UiSnapshotSource;
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
  loadStudio(): Promise<StudioRuntimeSnapshot>;
  applyStudio(request: SceneEditRequest): Promise<StudioRuntimeSnapshot>;
  undoStudio(request: StudioRevisionRequest): Promise<StudioRuntimeSnapshot>;
  redoStudio(request: StudioRevisionRequest): Promise<StudioRuntimeSnapshot>;
  subscribeStudioInvalidated(listener: () => void): Unsubscribe;
  loadUiProfile(): Promise<ProjectUiProfileSnapshot>;
  setUiProfileMode(request: UiProfileSetModeRequest): Promise<ProjectUiProfileSnapshot>;
  selectUiProfileScene(request: UiProfileSelectSceneRequest): Promise<ProjectUiProfileSnapshot>;
  selectUiProfilePage(request: UiProfileSelectPageRequest): Promise<ProjectUiProfileSnapshot>;
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
  executeRuntime(request: RuntimeExecuteRequest): Promise<RuntimeExecutionResult>;
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
}
