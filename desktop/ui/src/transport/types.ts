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
}
