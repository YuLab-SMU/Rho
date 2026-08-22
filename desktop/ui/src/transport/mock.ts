import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { projectLabel } from "./normalize";
import { applySceneEdit, collectSceneInstances, reconcileStudio } from "./studio-model";
import type {
  LayoutChild,
  OpenSurfaceRequest,
  PluginSurfaceDocument,
  PluginSurfaceDocumentRequest,
  PluginSurfaceDocumentView,
  PluginSurfaceEventRequest,
  PluginSurfaceEventResult,
  ProjectUiProfileSnapshot,
  ResourceBinding,
  ResourceContent,
  ResourceDeleteRequest,
  ResourceDescriptor,
  ResourceDraftRequest,
  ResourceReadRequest,
  ResourceRegistrySnapshot,
  ResourceReloadRequest,
  ResourceRenameRequest,
  ResourceResolveRequest,
  ResourceSaveRequest,
  ResourceTarget,
  RuntimeAttachmentRequest,
  RuntimeBinding,
  RuntimeCreateRequest,
  RuntimeDescriptor,
  RuntimeDetachRequest,
  RuntimeExecuteRequest,
  RuntimeExecutionResult,
  RuntimeInstanceRequest,
  RuntimeRegistrySnapshot,
  SetUiSelectionRequest,
  SurfaceInstance,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  SurfaceInstanceSpec,
  SceneEditRequest,
  SceneState,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  UpdateSurfaceRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  UiProfileRevisionRequest,
  UiProfileSceneLabelRequest,
  UiProfileSceneTargetRequest,
  UiProfileSelectPageRequest,
  UiProfileSelectSceneRequest,
  UiProfileSetModeRequest,
  Unsubscribe,
} from "./types";

const generatedSnapshot = fixture.kernel_snapshot as unknown as UiKernelSnapshot;
const generatedSurfaces =
  fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;
const generatedStudio =
  fixture.studio_runtime_snapshot as unknown as StudioRuntimeSnapshot;
const generatedRuntimes =
  fixture.runtime_registry_snapshot as unknown as RuntimeRegistrySnapshot;
const generatedResources =
  fixture.resource_registry_snapshot as unknown as ResourceRegistrySnapshot;
const generatedProfile =
  fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

function copySnapshot(snapshot: UiKernelSnapshot): UiKernelSnapshot {
  return structuredClone(snapshot);
}

function copySurfaces(snapshot: SurfaceRuntimeSnapshot): SurfaceRuntimeSnapshot {
  return structuredClone(snapshot);
}

function copyStudio(snapshot: StudioRuntimeSnapshot): StudioRuntimeSnapshot {
  return structuredClone(snapshot);
}

function copyRuntimes(snapshot: RuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  return structuredClone(snapshot);
}

function copyResources(snapshot: ResourceRegistrySnapshot): ResourceRegistrySnapshot {
  return structuredClone(snapshot);
}

function copyProfile(snapshot: ProjectUiProfileSnapshot): ProjectUiProfileSnapshot {
  return structuredClone(snapshot);
}

export interface MockUiKernelTransport extends UiKernelTransport {
  publish(snapshot: UiKernelSnapshot): void;
  publishSurfaces(snapshot: SurfaceRuntimeSnapshot): void;
  publishStudio(snapshot: StudioRuntimeSnapshot): void;
  publishRuntimes(snapshot: RuntimeRegistrySnapshot): void;
  publishResources(snapshot: ResourceRegistrySnapshot): void;
  publishUiProfile(snapshot: ProjectUiProfileSnapshot): void;
}

export function createMockUiKernelTransport(
  searchInput: string | URLSearchParams = "",
): MockUiKernelTransport {
  const search =
    typeof searchInput === "string" ? new URLSearchParams(searchInput) : searchInput;
  const snapshot = copySnapshot(generatedSnapshot);
  const requestedProject = search.get("project");
  if (requestedProject != null && requestedProject.length > 0) {
    const project = snapshot.project as {
      display_path: string;
      display_label: string;
    };
    project.display_path = requestedProject;
    project.display_label = projectLabel(requestedProject);
  }
  let current = snapshot;
  let surfaces = copySurfaces(generatedSurfaces);
  let studio = copyStudio(generatedStudio);
  let runtimes = copyRuntimes(generatedRuntimes);
  let resources = copyResources(generatedResources);
  let profile = copyProfile(generatedProfile);
  if (search.get("mode") === "vibe") {
    (profile.profile as { active_mode: "studio" | "vibe" }).active_mode = "vibe";
  }
  if (search.get("plugin") === "surface") {
    const pluginOrigin = {
      kind: "workspace_plugin" as const,
      plugin_id: "org.example.analysis",
      package_digest: `sha256:${"a".repeat(64)}`,
    };
    const pluginFactory = {
      definition: {
        surface_id: "ui.surface.differential-expression",
        contract_major: 1,
        label: "Differential expression",
        purpose: "Explore one bounded differential-expression result.",
        renderer_kind: "declarative_document" as const,
        scope: "project" as const,
        instance_policy: "multi_instance" as const,
        instance_quota_class: "standard" as const,
        resource_kinds: ["project_file"],
        modes: [{ mode_id: "explore", label: "Explore", interaction_kind: "interactive" as const }],
        sizing_hints: {
          min_inline: 180, min_block: 96, ideal_inline: 520, ideal_block: 360,
          max_inline: null, max_block: null, stretch_inline: true, stretch_block: true,
          presentation_classes: ["full", "compact"],
        },
        accepted_contexts: ["project"],
        commands: [],
        origin: pluginOrigin,
      },
      activation_generation: 1,
    };
    const pluginInstance: SurfaceInstance = {
      instance_id: "surface-instance:plugin-analysis",
      surface_id: pluginFactory.definition.surface_id,
      project_id: surfaces.project_id,
      origin: pluginOrigin,
      activation_generation: 1,
      surface_revision: 1,
      mode_id: "explore",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {},
      lifecycle_state: "active",
    };
    (surfaces.catalog.factories as unknown as typeof pluginFactory[]).push(pluginFactory);
    (surfaces.catalog.instances as unknown as SurfaceInstance[]).push(pluginInstance);
    (profile.profile.surface_instance_specs as unknown as SurfaceInstanceSpec[]).push({
      instance_id: pluginInstance.instance_id,
      surface_id: pluginInstance.surface_id,
      origin: pluginOrigin,
      mode_id: pluginInstance.mode_id,
      resource_binding: null,
      runtime_attachment_intent: null,
      view_group_id: null,
      view_state: {},
    });
    if (studio.scene.root.kind === "container") {
      (studio.scene.root.children as unknown as LayoutChild[]).push({
        basis: { kind: "minmax", min_logical_pixels: 240, max_logical_pixels: 720, weight: 1 },
        resizable: true,
        collapse_priority: 30,
        child: { kind: "surface", node_id: "node:plugin-analysis", instance_id: pluginInstance.instance_id },
      });
    }
  }
  const persistedContent = new Map<string, string>([
    ["analysis.R", "library(ggplot2)\nplot(mtcars$wt, mtcars$mpg)\n"],
  ]);
  const documents = new Map<string, {
    content: string;
    baseContent: string;
    documentRevision: number;
    baseResourceRevision: number;
    dirty: boolean;
  }>();
  let nextInstance = 1;
  let nextNode = 1;
  let nextRuntime = 1;
  let nextExecution = 1;
  let nextScene = 1;
  const allocateNode = () => `node:mock-${nextNode++}`;
  const undo: SceneState[] = [];
  const redo: SceneState[] = [];
  const listeners = new Set<() => void>();
  const surfaceListeners = new Set<() => void>();
  const pluginSurfaceListeners = new Set<() => void>();
  const studioListeners = new Set<() => void>();
  const runtimeListeners = new Set<() => void>();
  const resourceListeners = new Set<() => void>();
  const profileListeners = new Set<() => void>();
  const notifySurfaces = () => {
    for (const listener of surfaceListeners) listener();
  };
  const notifyPluginSurfaces = () => {
    for (const listener of pluginSurfaceListeners) listener();
  };
  const pluginDocuments = new Map<string, PluginSurfaceDocument>();
  const pluginDocument = (instanceId: string): PluginSurfaceDocument => {
    const existing = pluginDocuments.get(instanceId);
    if (existing != null) return existing;
    const created: PluginSurfaceDocument = {
      contract: "rho.plugin_surface_document.v1",
      revision: 1,
      title: "Differential expression explorer",
      blocks: [{
        kind: "column",
        blocks: [
          { kind: "notice", tone: "info", text: "Workspace plugin · declarative trusted rendering" },
          { kind: "text", text: "Compare a selected contrast without coupling this view to another instance." },
          {
            kind: "key_value",
            items: [{ key: "Genes", value: "18,442" }, { key: "Significant", value: "612" }],
          },
          {
            kind: "field", control_id: "contrast", label: "Contrast", value: "treated-control",
            placeholder: "group-a/group-b", disabled: false, busy: false,
          },
          {
            kind: "command_button", control_id: "apply", label: "Apply filter",
            command_id: "analysis.apply", disabled: false, busy: false,
          },
        ],
      }],
    };
    pluginDocuments.set(instanceId, created);
    return created;
  };
  const notifyStudio = () => {
    for (const listener of studioListeners) listener();
  };
  const notifyRuntimes = () => {
    for (const listener of runtimeListeners) listener();
  };
  const notifyResources = () => {
    for (const listener of resourceListeners) listener();
  };
  const notifyProfile = () => {
    for (const listener of profileListeners) listener();
  };
  const validateProfileTarget = (target: UiProfileRevisionRequest) => {
    if (
      target.project_id !== profile.profile.project_id ||
      target.expected_profile_revision !== profile.profile.revision
    ) throw new Error("Mock UI Profile request is stale or belongs to another project.");
  };
  const surfaceSpec = (instance: SurfaceInstance): SurfaceInstanceSpec => ({
    instance_id: instance.instance_id,
    surface_id: instance.surface_id,
    origin: instance.origin,
    mode_id: instance.mode_id,
    resource_binding: instance.resource_binding,
    runtime_attachment_intent: instance.runtime_binding == null
      ? profile.profile.surface_instance_specs.find(
          (spec) => spec.instance_id === instance.instance_id,
        )?.runtime_attachment_intent ?? null
      : {
          runtime_provider_id: instance.runtime_binding.runtime_provider_id,
          runtime_instance_id: instance.runtime_binding.runtime_instance_id,
          runtime_kind: instance.runtime_binding.runtime_kind,
        },
    view_group_id: instance.view_group_id,
    view_state: instance.view_state,
  });
  const installProfile = (
    mutate: (draft: ProjectUiProfileSnapshot) => void,
  ): ProjectUiProfileSnapshot => {
    const next = copyProfile(profile) as ProjectUiProfileSnapshot & {
      profile: ProjectUiProfileSnapshot["profile"] & { revision: number };
      load_status: ProjectUiProfileSnapshot["load_status"];
      recovery_detail: string | null;
    };
    mutate(next);
    next.profile.revision += 1;
    next.load_status = "clean";
    next.recovery_detail = null;
    profile = next;
    notifyProfile();
    return copyProfile(profile);
  };
  const syncRuntimeProfile = () => {
    installProfile((next) => {
      const activeId = next.profile.active_studio_scene_id;
      const scenes = next.profile.studio_scenes.map((scene) =>
        scene.scene_id === activeId ? structuredClone(studio.scene) : scene
      );
      (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = scenes;
      (next.profile as { surface_instance_specs: readonly SurfaceInstanceSpec[] })
        .surface_instance_specs = surfaces.catalog.instances.map(surfaceSpec);
      (next.profile as { last_focused_surface_instance_id: string | null })
        .last_focused_surface_instance_id = studio.scene.focused_surface_instance_id;
    });
  };
  const availableIds = () => surfaces.catalog.instances.map((instance) => instance.instance_id);
  const reconcileCurrentStudio = () => {
    const next = reconcileStudio(studio, availableIds(), allocateNode);
    if (next.snapshot_revision !== studio.snapshot_revision) {
      const sceneChanged = JSON.stringify(next.scene) !== JSON.stringify(studio.scene);
      studio = next;
      if (sceneChanged) {
        undo.splice(0);
        redo.splice(0);
      }
      notifyStudio();
    }
  };
  const validateTarget = (request: SurfaceInstanceRequest): number => {
    if (
      request.project_id !== surfaces.project_id ||
      request.expected_project_revision !== surfaces.project_revision
    ) {
      throw new Error("Mock Surface request belongs to another project or revision.");
    }
    const index = surfaces.catalog.instances.findIndex(
      (instance) => instance.instance_id === request.instance_id,
    );
    if (index < 0) throw new Error("Mock Surface instance was not found.");
    const instance = surfaces.catalog.instances[index];
    if (instance == null) throw new Error("Mock Surface instance was not found.");
    if (
      instance.activation_generation !== request.activation_generation ||
      instance.surface_revision !== request.expected_surface_revision
    ) {
      throw new Error("Mock Surface request is stale.");
    }
    return index;
  };
  const installSurfaces = (
    instances: readonly SurfaceInstance[],
    persistProfile = true,
  ) => {
    const next = copySurfaces(surfaces);
    (next as { snapshot_revision: number }).snapshot_revision += 1;
    (next.catalog as unknown as { instances: SurfaceInstance[] }).instances = [...instances];
    surfaces = next;
    notifySurfaces();
    reconcileCurrentStudio();
    if (persistProfile) syncRuntimeProfile();
    return copySurfaces(surfaces);
  };
  const bindingFor = (runtime: RuntimeDescriptor): RuntimeBinding => ({
    runtime_provider_id: runtime.runtime_provider_id,
    runtime_instance_id: runtime.runtime_instance_id,
    runtime_kind: runtime.runtime_kind,
    project_id: runtime.project_id,
    activation_generation: runtime.activation_generation,
    state_revision: runtime.state_revision,
    attach_capabilities: runtime.attach_capabilities,
  });
  const installRuntimes = (instances: readonly RuntimeDescriptor[]) => {
    runtimes = {
      ...copyRuntimes(runtimes),
      snapshot_revision: runtimes.snapshot_revision + 1,
      instances: [...instances],
    };
    notifyRuntimes();
    return copyRuntimes(runtimes);
  };
  const installResources = (nextResources: readonly ResourceDescriptor[]) => {
    resources = {
      ...copyResources(resources),
      snapshot_revision: resources.snapshot_revision + 1,
      resources: [...nextResources],
    };
    notifyResources();
    return copyResources(resources);
  };
  const validateResource = (target: ResourceTarget, exact: boolean): ResourceDescriptor => {
    if (
      target.project_id !== resources.project_id ||
      target.expected_project_revision !== resources.project_revision
    ) throw new Error("Mock Resource belongs to another project or revision.");
    const descriptor = resources.resources.find((resource) =>
      resource.resource_provider_id === target.resource_provider_id &&
      resource.resource_kind === target.resource_kind &&
      resource.resource_id === target.resource_id
    );
    if (descriptor == null) throw new Error("Mock Resource was not resolved.");
    if (exact && descriptor.resource_revision !== target.expected_resource_revision) {
      throw new Error("Mock Resource revision is stale.");
    }
    return descriptor;
  };
  const contentShape = (
    descriptor: ResourceDescriptor,
    document: NonNullable<ReturnType<typeof documents.get>>,
  ): ResourceContent => ({
    contract: "rho.ui.resource-content.v1",
    descriptor,
    consistency: "shared_document",
    document_revision: document.documentRevision,
    base_resource_revision: document.baseResourceRevision,
    dirty: document.dirty,
    stale: descriptor.status !== "ready" ||
      descriptor.resource_revision !== document.baseResourceRevision,
    content_encoding: "utf-8",
    content: document.content,
  });
  const rebindSourceSurfaces = (descriptor: ResourceDescriptor) => {
    const instances = surfaces.catalog.instances.map((instance) =>
      instance.surface_id === "rho.file-source" &&
      instance.resource_binding?.resource_provider_id === descriptor.resource_provider_id &&
      instance.resource_binding.resource_kind === descriptor.resource_kind &&
      instance.resource_binding.resource_id === descriptor.resource_id
        ? {
            ...instance,
            surface_revision: instance.surface_revision + 1,
            resource_binding: {
              resource_provider_id: descriptor.resource_provider_id,
              resource_kind: descriptor.resource_kind,
              resource_id: descriptor.resource_id,
              resource_revision: descriptor.resource_revision,
            } satisfies ResourceBinding,
          }
        : instance
    );
    if (JSON.stringify(instances) !== JSON.stringify(surfaces.catalog.instances)) {
      installSurfaces(instances);
    }
  };
  const validateRuntime = (request: RuntimeInstanceRequest): number => {
    if (
      request.project_id !== runtimes.project_id ||
      request.expected_project_revision !== runtimes.project_revision
    ) throw new Error("Mock Runtime request belongs to another project or revision.");
    const index = runtimes.instances.findIndex(
      (runtime) => runtime.runtime_instance_id === request.runtime_instance_id,
    );
    const runtime = runtimes.instances[index];
    if (
      runtime == null || runtime.runtime_provider_id !== request.runtime_provider_id ||
      runtime.activation_generation !== request.activation_generation ||
      runtime.state_revision !== request.expected_state_revision
    ) throw new Error("Mock Runtime request is stale or unavailable.");
    return index;
  };
  const attachRuntime = (request: RuntimeAttachmentRequest) => {
    const runtimeIndex = validateRuntime(request.runtime);
    const surfaceIndex = validateTarget(request.surface);
    const runtime = runtimes.instances[runtimeIndex];
    const surface = surfaces.catalog.instances[surfaceIndex];
    if (runtime == null || surface == null) throw new Error("Mock attachment target vanished.");
    if (!runtime.attach_capabilities.includes("console.attach")) {
      throw new Error("Mock Runtime cannot attach a Console.");
    }
    const instances = [...surfaces.catalog.instances];
    instances[surfaceIndex] = {
      ...surface,
      surface_revision: surface.surface_revision + 1,
      runtime_binding: bindingFor(runtime),
    };
    return installSurfaces(instances);
  };
  const detachRuntime = (request: RuntimeDetachRequest) => {
    const surfaceIndex = validateTarget(request.surface);
    const surface = surfaces.catalog.instances[surfaceIndex];
    if (surface == null) throw new Error("Mock attachment target vanished.");
    const instances = [...surfaces.catalog.instances];
    instances[surfaceIndex] = {
      ...surface,
      surface_revision: surface.surface_revision + 1,
      runtime_binding: null,
    };
    return installSurfaces(instances);
  };
  const validateStudio = (request: StudioRevisionRequest) => {
    reconcileCurrentStudio();
    if (
      request.project_id !== studio.project_id ||
      request.expected_project_revision !== studio.project_revision ||
      request.expected_layout_revision !== studio.scene.layout_revision
    ) {
      throw new Error("Mock Studio request is stale or belongs to another project.");
    }
  };
  const installScene = (scene: SceneState, persistProfile = true): StudioRuntimeSnapshot => {
    const placed = collectSceneInstances(scene);
    const missing = [...placed].find((id) => !availableIds().includes(id));
    if (missing != null) throw new Error(`Mock Studio instance ${missing} is unavailable.`);
    studio = {
      ...studio,
      snapshot_revision: studio.snapshot_revision + 1,
      scene,
      unplaced_instance_ids: availableIds().filter((id) => !placed.has(id)).sort(),
      can_undo: undo.length > 0,
      can_redo: redo.length > 0,
    };
    notifyStudio();
    if (persistProfile) syncRuntimeProfile();
    return copyStudio(studio);
  };
  const validateSceneAvailability = (scene: SceneState) => {
    const placed = collectSceneInstances(scene);
    const missing = [...placed].find((id) => !availableIds().includes(id));
    if (missing != null) throw new Error(`Mock Studio instance ${missing} is unavailable.`);
  };
  return {
    source: "mock",
    async loadSnapshot() {
      return copySnapshot(current);
    },
    async setSelection(request: SetUiSelectionRequest) {
      if (
        request.project_id !== current.project.project_id ||
        request.expected_project_revision !== current.context.project_revision ||
        request.expected_snapshot_revision !== current.snapshot_revision
      ) {
        throw new Error("Mock UI selection request is stale.");
      }
      current = copySnapshot(current);
      (current.context as { selection: typeof request.selection }).selection = request.selection;
      (current as { snapshot_revision: number }).snapshot_revision += 1;
      for (const listener of listeners) listener();
      return copySnapshot(current);
    },
    subscribeInvalidated(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: UiKernelSnapshot) {
      current = copySnapshot(next);
      for (const listener of listeners) listener();
    },
    async loadSurfaces() {
      return copySurfaces(surfaces);
    },
    async openSurface(request: OpenSurfaceRequest) {
      if (
        request.project_id !== surfaces.project_id ||
        request.expected_project_revision !== surfaces.project_revision ||
        request.expected_layout_revision !== studio.scene.layout_revision
      ) {
        throw new Error("Mock Surface open request is stale.");
      }
      const factory = surfaces.catalog.factories.find(
        (candidate) => candidate.definition.surface_id === request.surface_id,
      );
      if (factory == null) throw new Error("Mock Surface factory is unavailable.");
      if (request.resource_binding != null) {
        const resource = resources.resources.find((candidate) =>
          candidate.resource_provider_id === request.resource_binding?.resource_provider_id &&
          candidate.resource_kind === request.resource_binding.resource_kind &&
          candidate.resource_id === request.resource_binding.resource_id
        );
        if (
          resource == null || resource.status !== "ready" ||
          request.resource_binding.resource_revision !== resource.resource_revision
        ) throw new Error("Mock bound Resource is stale or unavailable.");
      }
      const exact = surfaces.catalog.instances.find(
        (instance) =>
          instance.lifecycle_state !== "placeholder" &&
          instance.surface_id === request.surface_id &&
          instance.activation_generation === factory.activation_generation &&
          instance.mode_id === request.mode_id &&
          JSON.stringify(instance.resource_binding) ===
            JSON.stringify(request.resource_binding) &&
          JSON.stringify(instance.runtime_binding) ===
            JSON.stringify(request.runtime_binding) &&
          instance.view_group_id === request.view_group_id &&
          JSON.stringify(instance.view_state) === JSON.stringify(request.view_state),
      );
      if (request.instance_disposition === "reuse_exact" && exact != null) {
        return copySurfaces(surfaces);
      }
      if (
        factory.definition.instance_policy === "singleton" &&
        surfaces.catalog.instances.some(
          (instance) =>
            instance.surface_id === request.surface_id &&
            instance.lifecycle_state !== "placeholder",
        )
      ) {
        throw new Error("Mock singleton Surface already exists.");
      }
      const instance: SurfaceInstance = {
        instance_id: `surface-instance:mock-${nextInstance++}`,
        surface_id: request.surface_id,
        project_id: request.project_id,
        origin: factory.definition.origin,
        activation_generation: factory.activation_generation,
        surface_revision: 1,
        mode_id: request.mode_id,
        resource_binding: request.resource_binding,
        runtime_binding: request.runtime_binding,
        view_group_id: request.view_group_id,
        view_state: request.view_state,
        lifecycle_state: "active",
      };
      return installSurfaces([...surfaces.catalog.instances, instance]);
    },
    async updateSurface(request: UpdateSurfaceRequest) {
      const index = validateTarget(request.target);
      const instances = [...surfaces.catalog.instances];
      const current = instances[index];
      if (current == null) throw new Error("Mock Surface instance was not found.");
      const mutable = structuredClone(current) as {
        mode_id: string | null;
        resource_binding: typeof current.resource_binding;
        runtime_binding: typeof current.runtime_binding;
        view_group_id: string | null;
        view_state: unknown;
        lifecycle_state: typeof current.lifecycle_state;
        surface_revision: number;
      };
      switch (request.mutation.kind) {
        case "set_mode": mutable.mode_id = request.mutation.mode_id; break;
        case "set_view_state": mutable.view_state = request.mutation.view_state; break;
        case "set_lifecycle": mutable.lifecycle_state = request.mutation.state; break;
        case "bind_resource": {
          const binding = request.mutation.binding;
          if (binding != null) {
            const resource = resources.resources.find((candidate) =>
              candidate.resource_provider_id === binding.resource_provider_id &&
              candidate.resource_kind === binding.resource_kind &&
              candidate.resource_id === binding.resource_id
            );
            if (
              resource == null || resource.status !== "ready" ||
              binding.resource_revision !== resource.resource_revision
            ) throw new Error("Mock bound Resource is stale or unavailable.");
          }
          mutable.resource_binding = binding;
          break;
        }
        case "bind_runtime": mutable.runtime_binding = request.mutation.binding; break;
        case "set_view_group": mutable.view_group_id = request.mutation.view_group_id; break;
      }
      mutable.surface_revision += 1;
      instances[index] = mutable as SurfaceInstance;
      if (
        request.mutation.kind === "set_view_state" &&
        current.view_group_id != null && current.resource_binding != null
      ) {
        for (let siblingIndex = 0; siblingIndex < instances.length; siblingIndex += 1) {
          if (siblingIndex === index) continue;
          const sibling = instances[siblingIndex];
          if (
            sibling == null || sibling.lifecycle_state === "placeholder" ||
            sibling.view_group_id !== current.view_group_id ||
            sibling.resource_binding?.resource_provider_id !== current.resource_binding.resource_provider_id ||
            sibling.resource_binding.resource_kind !== current.resource_binding.resource_kind ||
            sibling.resource_binding.resource_id !== current.resource_binding.resource_id
          ) continue;
          instances[siblingIndex] = {
            ...sibling,
            view_state: request.mutation.view_state,
            surface_revision: sibling.surface_revision + 1,
          };
        }
      }
      return installSurfaces(instances);
    },
    async closeSurface(request: SurfaceInstanceRequest) {
      const index = validateTarget(request);
      return installSurfaces(surfaces.catalog.instances.filter((_, at) => at !== index));
    },
    async suspendSurface(request: SurfaceInstanceRequest) {
      const index = validateTarget(request);
      const instances = [...surfaces.catalog.instances];
      const current = instances[index];
      if (current == null) throw new Error("Mock Surface instance was not found.");
      if (current.lifecycle_state !== "active" && current.lifecycle_state !== "hidden") {
        throw new Error("Mock Surface cannot be suspended from its current state.");
      }
      instances[index] = {
        ...current,
        surface_revision: current.surface_revision + 1,
        lifecycle_state: "suspended",
      };
      return installSurfaces(instances);
    },
    async resumeSurface(request: SurfaceInstanceRequest) {
      const index = validateTarget(request);
      const instances = [...surfaces.catalog.instances];
      const current = instances[index];
      if (current == null) throw new Error("Mock Surface instance was not found.");
      if (current.lifecycle_state !== "suspended") {
        throw new Error("Mock Surface is not suspended.");
      }
      instances[index] = {
        ...current,
        surface_revision: current.surface_revision + 1,
        lifecycle_state: "active",
      };
      return installSurfaces(instances);
    },
    subscribeSurfacesInvalidated(listener: () => void): Unsubscribe {
      surfaceListeners.add(listener);
      return () => surfaceListeners.delete(listener);
    },
    async loadPluginSurfaceDocument(
      request: PluginSurfaceDocumentRequest,
    ): Promise<PluginSurfaceDocumentView> {
      const index = validateTarget(request.target);
      const instance = surfaces.catalog.instances[index];
      if (instance == null || instance.origin.kind !== "workspace_plugin") {
        throw new Error("Mock workspace Surface route is unavailable.");
      }
      if (
        request.expected_layout_revision !== studio.scene.layout_revision ||
        request.expected_page_revision != null
      ) throw new Error("Mock workspace Surface placement is stale.");
      return {
        project_id: instance.project_id,
        instance_id: instance.instance_id,
        surface_id: instance.surface_id,
        surface_revision: instance.surface_revision,
        document: structuredClone(pluginDocument(instance.instance_id)),
        provenance: { origin: "trusted_surface", source: "mock" },
      };
    },
    async dispatchPluginSurfaceEvent(
      request: PluginSurfaceEventRequest,
    ): Promise<PluginSurfaceEventResult> {
      const loaded = await this.loadPluginSurfaceDocument(request);
      if (loaded.document.revision !== request.expected_document_revision) {
        throw new Error("Mock workspace Surface document is stale.");
      }
      const next = structuredClone(loaded.document) as PluginSurfaceDocument & { revision: number };
      next.revision += 1;
      if (request.control_id === "contrast" && typeof request.value === "string") {
        const column = next.blocks[0];
        if (column?.kind === "column") {
          const field = column.blocks.find((block) =>
            block.kind === "field" && block.control_id === "contrast"
          );
          if (field?.kind === "field") {
            (field as { value: string }).value = request.value;
          }
        }
      }
      pluginDocuments.set(request.target.instance_id, next);
      notifyPluginSurfaces();
      return {
        event_id: `mock-surface-event:${next.revision}`,
        status: "completed",
        document: structuredClone(next),
        command_result: null,
        provenance: { origin: "trusted_surface", source: "mock" },
      };
    },
    subscribePluginSurfacesInvalidated(listener: () => void): Unsubscribe {
      pluginSurfaceListeners.add(listener);
      return () => pluginSurfaceListeners.delete(listener);
    },
    publishSurfaces(next: SurfaceRuntimeSnapshot) {
      surfaces = copySurfaces(next);
      notifySurfaces();
      reconcileCurrentStudio();
    },
    async loadStudio() {
      reconcileCurrentStudio();
      return copyStudio(studio);
    },
    async applyStudio(request: SceneEditRequest) {
      validateStudio(request);
      const previous = copyStudio(studio).scene;
      const candidate = applySceneEdit(studio.scene, request.edit, allocateNode);
      validateSceneAvailability(candidate);
      undo.push(previous);
      if (undo.length > 64) undo.shift();
      redo.splice(0);
      return installScene(candidate);
    },
    async undoStudio(request: StudioRevisionRequest) {
      validateStudio(request);
      const target = undo.pop();
      if (target == null) throw new Error("Mock Studio undo history is empty.");
      redo.push(copyStudio(studio).scene);
      const restored = structuredClone(target) as SceneState & { layout_revision: number };
      restored.layout_revision = studio.scene.layout_revision + 1;
      return installScene(restored);
    },
    async redoStudio(request: StudioRevisionRequest) {
      validateStudio(request);
      const target = redo.pop();
      if (target == null) throw new Error("Mock Studio redo history is empty.");
      undo.push(copyStudio(studio).scene);
      const restored = structuredClone(target) as SceneState & { layout_revision: number };
      restored.layout_revision = studio.scene.layout_revision + 1;
      return installScene(restored);
    },
    subscribeStudioInvalidated(listener: () => void): Unsubscribe {
      studioListeners.add(listener);
      return () => studioListeners.delete(listener);
    },
    publishStudio(next: StudioRuntimeSnapshot) {
      studio = copyStudio(next);
      undo.splice(0);
      redo.splice(0);
      notifyStudio();
    },
    async loadUiProfile() {
      return copyProfile(profile);
    },
    async setUiProfileMode(request: UiProfileSetModeRequest) {
      validateProfileTarget(request.target);
      return installProfile((next) => {
        (next.profile as { active_mode: typeof request.mode }).active_mode = request.mode;
      });
    },
    async selectUiProfileScene(request: UiProfileSelectSceneRequest) {
      validateProfileTarget(request.target);
      const scene = profile.profile.studio_scenes.find(
        (candidate) => candidate.scene_id === request.scene_id,
      );
      if (scene == null) throw new Error("Mock Studio Scene was not found.");
      const snapshot = installProfile((next) => {
        (next.profile as { active_studio_scene_id: string | null }).active_studio_scene_id =
          request.scene_id;
      });
      undo.splice(0);
      redo.splice(0);
      installScene(structuredClone(scene), false);
      return snapshot;
    },
    async selectUiProfilePage(request: UiProfileSelectPageRequest) {
      validateProfileTarget(request.target);
      if (!profile.profile.vibe_pages.some((page) => page.page_id === request.page_id)) {
        throw new Error("Mock Vibe Page was not found.");
      }
      return installProfile((next) => {
        (next.profile as { active_vibe_page_id: string | null }).active_vibe_page_id =
          request.page_id;
      });
    },
    async duplicateUiProfileScene(request: UiProfileSceneLabelRequest) {
      validateProfileTarget(request.target);
      const source = profile.profile.studio_scenes.find(
        (candidate) => candidate.scene_id === request.scene_id,
      );
      if (source == null) throw new Error("Mock Studio Scene was not found.");
      const scene = structuredClone(source) as SceneState & {
        scene_id: string;
        label: string;
        layout_revision: number;
      };
      scene.scene_id = `scene:mock-${nextScene++}`;
      scene.label = request.label;
      scene.layout_revision = 1;
      const snapshot = installProfile((next) => {
        (next.profile as { active_studio_scene_id: string | null }).active_studio_scene_id =
          scene.scene_id;
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = [
          ...next.profile.studio_scenes,
          scene,
        ];
      });
      undo.splice(0);
      redo.splice(0);
      installScene(scene, false);
      return snapshot;
    },
    async saveUiProfileScene(request: UiProfileSceneTargetRequest) {
      validateProfileTarget(request.target);
      if (studio.scene.scene_id !== request.scene_id) {
        throw new Error("Only the active Mock Studio Scene can be saved.");
      }
      return installProfile((next) => {
        const scenes = next.profile.studio_scenes.map((scene) =>
          scene.scene_id === request.scene_id ? structuredClone(studio.scene) : scene
        );
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = scenes;
      });
    },
    async renameUiProfileScene(request: UiProfileSceneLabelRequest) {
      validateProfileTarget(request.target);
      if (!request.label.trim()) throw new Error("Mock Studio Scene label is empty.");
      let found = false;
      const snapshot = installProfile((next) => {
        const scenes = next.profile.studio_scenes.map((scene) => {
          if (scene.scene_id !== request.scene_id) return scene;
          found = true;
          return { ...scene, label: request.label };
        });
        if (!found) throw new Error("Mock Studio Scene was not found.");
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = scenes;
      });
      if (studio.scene.scene_id === request.scene_id) {
        installScene({ ...studio.scene, label: request.label }, false);
      }
      return snapshot;
    },
    async deleteUiProfileScene(request: UiProfileSceneTargetRequest) {
      validateProfileTarget(request.target);
      const remaining = profile.profile.studio_scenes.filter(
        (scene) => scene.scene_id !== request.scene_id,
      );
      if (remaining.length === profile.profile.studio_scenes.length) {
        throw new Error("Mock Studio Scene was not found.");
      }
      const nextScene = remaining[0];
      if (nextScene == null) {
        throw new Error("The last Mock Studio Scene cannot be deleted; reset it instead.");
      }
      const snapshot = installProfile((next) => {
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes = remaining;
        (next.profile as { active_studio_scene_id: string | null }).active_studio_scene_id =
          nextScene.scene_id;
      });
      undo.splice(0);
      redo.splice(0);
      installScene(structuredClone(nextScene), false);
      return snapshot;
    },
    async resetUiProfileScene(request: UiProfileSceneTargetRequest) {
      validateProfileTarget(request.target);
      const currentScene = profile.profile.studio_scenes.find(
        (scene) => scene.scene_id === request.scene_id,
      );
      const preset = profile.immutable_scene_presets[0];
      if (currentScene == null || preset == null) {
        throw new Error("Mock Rho Studio preset or Scene was not found.");
      }
      const replacement = {
        ...structuredClone(preset.scene),
        scene_id: currentScene.scene_id,
        project_id: currentScene.project_id,
        label: currentScene.label,
        layout_revision: currentScene.layout_revision + 1,
      };
      const snapshot = installProfile((next) => {
        (next.profile as { studio_scenes: readonly SceneState[] }).studio_scenes =
          next.profile.studio_scenes.map((scene) =>
            scene.scene_id === request.scene_id ? replacement : scene
          );
        const specs = [...next.profile.surface_instance_specs];
        for (const restored of preset.surface_instance_specs) {
          const index = specs.findIndex((spec) => spec.instance_id === restored.instance_id);
          if (index < 0) specs.push(restored);
          else specs[index] = restored;
        }
        (next.profile as { surface_instance_specs: readonly SurfaceInstanceSpec[] })
          .surface_instance_specs = specs;
      });
      undo.splice(0);
      redo.splice(0);
      installScene(replacement, false);
      return snapshot;
    },
    subscribeUiProfileInvalidated(listener: () => void): Unsubscribe {
      profileListeners.add(listener);
      return () => profileListeners.delete(listener);
    },
    publishUiProfile(next: ProjectUiProfileSnapshot) {
      profile = copyProfile(next);
      notifyProfile();
    },
    async loadRuntimes() {
      return copyRuntimes(runtimes);
    },
    async createRuntime(request: RuntimeCreateRequest) {
      if (
        request.project_id !== runtimes.project_id ||
        request.expected_project_revision !== runtimes.project_revision ||
        request.expected_snapshot_revision !== runtimes.snapshot_revision
      ) throw new Error("Mock Runtime create request is stale.");
      const provider = runtimes.providers.find(
        (candidate) => candidate.definition.runtime_provider_id === request.runtime_provider_id,
      );
      if (provider == null || !provider.definition.create_supported) {
        throw new Error("Mock Runtime Provider cannot create an instance.");
      }
      const auxiliaryCount = runtimes.instances.filter(
        (runtime) => runtime.runtime_provider_id === request.runtime_provider_id &&
          !runtime.primary_scientific_runtime,
      ).length;
      if (auxiliaryCount >= provider.definition.max_instances) {
        throw new Error("Mock Runtime Provider instance budget is exhausted.");
      }
      const runtime: RuntimeDescriptor = {
        runtime_provider_id: provider.definition.runtime_provider_id,
        runtime_instance_id: `runtime:mock-r-${nextRuntime++}`,
        runtime_kind: provider.definition.runtime_kind,
        project_id: runtimes.project_id,
        activation_generation: 1,
        state_revision: 2,
        status: "ready",
        attach_capabilities: provider.definition.attach_capabilities,
        persistence_class: "explicit_lease",
        display_label: request.display_label ?? `Auxiliary R ${auxiliaryCount + 1}`,
        primary_scientific_runtime: false,
      };
      return installRuntimes([...runtimes.instances, runtime]);
    },
    async attachRuntime(request: RuntimeAttachmentRequest) {
      return attachRuntime(request);
    },
    async detachRuntime(request: RuntimeDetachRequest) {
      return detachRuntime(request);
    },
    async interruptRuntime(request: RuntimeInstanceRequest) {
      const index = validateRuntime(request);
      const runtime = runtimes.instances[index]!;
      const instances = [...runtimes.instances];
      instances[index] = { ...runtime, state_revision: runtime.state_revision + 2, status: "ready" };
      return installRuntimes(instances);
    },
    async restartRuntime(request: RuntimeInstanceRequest) {
      const index = validateRuntime(request);
      const runtime = runtimes.instances[index]!;
      const restarted: RuntimeDescriptor = {
        ...runtime,
        activation_generation: runtime.activation_generation + 1,
        state_revision: runtime.state_revision + 2,
        status: "ready",
      };
      const instances = [...runtimes.instances];
      instances[index] = restarted;
      const snapshot = installRuntimes(instances);
      const rebound = surfaces.catalog.instances.map((surface) =>
        surface.runtime_binding?.runtime_instance_id === restarted.runtime_instance_id
          ? {
              ...surface,
              surface_revision: surface.surface_revision + 1,
              runtime_binding: bindingFor(restarted),
            }
          : surface,
      );
      if (rebound.some((surface, at) => surface !== surfaces.catalog.instances[at])) {
        installSurfaces(rebound);
      }
      return snapshot;
    },
    async stopRuntime(request: RuntimeInstanceRequest) {
      const index = validateRuntime(request);
      const runtime = runtimes.instances[index]!;
      if (runtime.primary_scientific_runtime) {
        throw new Error("Mock Workspace R is project-owned and cannot be stopped.");
      }
      return installRuntimes(runtimes.instances.filter((_, at) => at !== index));
    },
    async executeRuntime(request: RuntimeExecuteRequest): Promise<RuntimeExecutionResult> {
      const index = validateRuntime(request.runtime);
      const runtime = runtimes.instances[index]!;
      const console = surfaces.catalog.instances.find(
        (surface) => surface.instance_id === request.console_instance_id,
      );
      if (
        console == null || console.surface_id !== "rho.console" ||
        console.surface_revision !== request.expected_console_revision ||
        console.runtime_binding?.runtime_instance_id !== runtime.runtime_instance_id ||
        console.runtime_binding.activation_generation !== runtime.activation_generation
      ) throw new Error("Mock Console attachment is stale or unavailable.");
      if (!request.code.trim()) throw new Error("Mock Runtime code must not be empty.");
      const instances = [...runtimes.instances];
      const finished = { ...runtime, state_revision: runtime.state_revision + 2, status: "ready" as const };
      instances[index] = finished;
      installRuntimes(instances);
      return {
        execution_id: `runtime-execution:mock-${nextExecution++}`,
        runtime_instance_id: runtime.runtime_instance_id,
        runtime_activation_generation: runtime.activation_generation,
        console_instance_id: console.instance_id,
        state_revision_after: finished.state_revision,
        status: "completed",
        events: [{
          sequence: 1,
          runtime_instance_id: runtime.runtime_instance_id,
          console_instance_id: console.instance_id,
          kind: "mock_result",
          payload: { text: `Mock evaluation: ${request.code}` },
        }],
      };
    },
    subscribeRuntimesInvalidated(listener: () => void): Unsubscribe {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    publishRuntimes(next: RuntimeRegistrySnapshot) {
      runtimes = copyRuntimes(next);
      notifyRuntimes();
    },
    async loadResources() {
      return copyResources(resources);
    },
    async resolveResource(request: ResourceResolveRequest) {
      if (
        request.project_id !== resources.project_id ||
        request.expected_project_revision !== resources.project_revision ||
        request.expected_snapshot_revision !== resources.snapshot_revision
      ) throw new Error("Mock Resource resolve request is stale.");
      const normalized = request.resource_id.replaceAll("\\", "/");
      if (
        !normalized || normalized.startsWith("/") ||
        normalized.split("/").some((part) => !part || part === "." || part === "..")
      ) throw new Error("Mock Resource path must be normalized.");
      if (resources.resources.some((resource) => resource.resource_id === normalized)) {
        return copyResources(resources);
      }
      const exists = persistedContent.has(normalized);
      const supported = /\.(r|rmd|qmd|md|txt|json|csv|tsv|html|png|jpe?g|gif|webp)$/iu.test(normalized);
      const descriptor: ResourceDescriptor = {
        resource_provider_id: request.resource_provider_id,
        project_id: request.project_id,
        resource_kind: request.resource_kind,
        resource_id: normalized,
        resource_revision: 1,
        label: normalized.split("/").at(-1) ?? normalized,
        capabilities: exists && supported
          ? ["resource.delete", "resource.preview", "resource.read.document", "resource.read.snapshot", "resource.rename", "resource.write"]
          : ["resource.read.snapshot"],
        status: exists ? supported ? "ready" : "unsupported" : "missing",
        media_type: exists && supported ? "text/plain" : null,
        size_bytes: exists && supported ? (persistedContent.get(normalized)?.length ?? 0) : null,
        content_sha256: null,
      };
      return installResources([...resources.resources, descriptor]);
    },
    async readResource(request: ResourceReadRequest): Promise<ResourceContent> {
      const descriptor = validateResource(
        request.target,
        request.consistency === "immutable_snapshot",
      );
      if (descriptor.status !== "ready") throw new Error("Mock Resource is unavailable.");
      if (request.consistency === "immutable_snapshot") {
        if (!descriptor.capabilities.includes("resource.preview")) {
          throw new Error("Mock Resource preview is unsupported.");
        }
        return {
          contract: "rho.ui.resource-content.v1",
          descriptor,
          consistency: "immutable_snapshot",
          document_revision: 1,
          base_resource_revision: descriptor.resource_revision,
          dirty: false,
          stale: false,
          content_encoding: "utf-8",
          content: persistedContent.get(descriptor.resource_id) ?? "",
        };
      }
      let document = documents.get(descriptor.resource_id);
      if (document == null) {
        const content = persistedContent.get(descriptor.resource_id) ?? "";
        document = {
          content,
          baseContent: content,
          documentRevision: 1,
          baseResourceRevision: descriptor.resource_revision,
          dirty: false,
        };
        documents.set(descriptor.resource_id, document);
        resources = { ...resources, snapshot_revision: resources.snapshot_revision + 1 };
        notifyResources();
      }
      return contentShape(descriptor, document);
    },
    async updateResourceDraft(request: ResourceDraftRequest) {
      const descriptor = validateResource(request.target, false);
      const document = documents.get(descriptor.resource_id);
      if (document == null) throw new Error("Mock shared Resource document is not open.");
      if (document.documentRevision !== request.expected_document_revision) {
        throw new Error("Mock Resource document revision is stale.");
      }
      document.content = request.content;
      document.documentRevision += 1;
      document.dirty = document.content !== document.baseContent;
      resources = { ...resources, snapshot_revision: resources.snapshot_revision + 1 };
      notifyResources();
      return contentShape(descriptor, document);
    },
    async saveResource(request: ResourceSaveRequest) {
      const descriptor = validateResource(request.target, false);
      const document = documents.get(descriptor.resource_id);
      if (document == null) throw new Error("Mock shared Resource document is not open.");
      if (
        document.documentRevision !== request.expected_document_revision ||
        document.baseResourceRevision !== descriptor.resource_revision
      ) throw new Error("Mock Resource save request is stale.");
      persistedContent.set(descriptor.resource_id, document.content);
      const saved: ResourceDescriptor = {
        ...descriptor,
        resource_revision: descriptor.resource_revision + 1,
        size_bytes: document.content.length,
      };
      document.baseContent = document.content;
      document.baseResourceRevision = saved.resource_revision;
      document.documentRevision += 1;
      document.dirty = false;
      installResources(resources.resources.map((resource) =>
        resource.resource_id === saved.resource_id ? saved : resource
      ));
      rebindSourceSurfaces(saved);
      return contentShape(saved, document);
    },
    async reloadResource(request: ResourceReloadRequest) {
      const descriptor = validateResource(request.target, false);
      const document = documents.get(descriptor.resource_id);
      if (document == null) throw new Error("Mock shared Resource document is not open.");
      if (document.documentRevision !== request.expected_document_revision) {
        throw new Error("Mock Resource document revision is stale.");
      }
      if (document.dirty && !request.discard_dirty) {
        throw new Error("Mock Resource has an unsaved draft; explicit discard is required.");
      }
      const content = persistedContent.get(descriptor.resource_id) ?? "";
      document.content = content;
      document.baseContent = content;
      document.baseResourceRevision = descriptor.resource_revision;
      document.documentRevision += 1;
      document.dirty = false;
      resources = { ...resources, snapshot_revision: resources.snapshot_revision + 1 };
      notifyResources();
      rebindSourceSurfaces(descriptor);
      return contentShape(descriptor, document);
    },
    async renameResource(request: ResourceRenameRequest) {
      const descriptor = validateResource(request.target, true);
      const document = documents.get(descriptor.resource_id);
      if ((document?.documentRevision ?? null) !== request.expected_document_revision) {
        throw new Error("Mock Resource document revision is stale.");
      }
      if (resources.resources.some((resource) => resource.resource_id === request.new_resource_id)) {
        throw new Error("Mock Resource rename target already exists.");
      }
      const renamed: ResourceDescriptor = {
        ...descriptor,
        resource_id: request.new_resource_id,
        label: request.new_resource_id.split("/").at(-1) ?? request.new_resource_id,
        resource_revision: 1,
      };
      const persisted = persistedContent.get(descriptor.resource_id);
      persistedContent.delete(descriptor.resource_id);
      if (persisted != null) persistedContent.set(renamed.resource_id, persisted);
      if (document != null) {
        documents.delete(descriptor.resource_id);
        document.baseResourceRevision = renamed.resource_revision;
        document.documentRevision += 1;
        documents.set(renamed.resource_id, document);
      }
      const snapshot = installResources([
        ...resources.resources.filter((resource) => resource.resource_id !== descriptor.resource_id),
        renamed,
      ]);
      const binding: ResourceBinding = {
        resource_provider_id: renamed.resource_provider_id,
        resource_kind: renamed.resource_kind,
        resource_id: renamed.resource_id,
        resource_revision: renamed.resource_revision,
      };
      const rebound = surfaces.catalog.instances.map((surface) =>
        surface.resource_binding?.resource_provider_id === descriptor.resource_provider_id &&
        surface.resource_binding.resource_kind === descriptor.resource_kind &&
        surface.resource_binding.resource_id === descriptor.resource_id
          ? { ...surface, surface_revision: surface.surface_revision + 1, resource_binding: binding }
          : surface
      );
      installSurfaces(rebound);
      return snapshot;
    },
    async deleteResource(request: ResourceDeleteRequest) {
      const descriptor = validateResource(request.target, true);
      const document = documents.get(descriptor.resource_id);
      if (document != null) {
        if (request.expected_document_revision !== document.documentRevision) {
          throw new Error("Mock Resource document revision is stale.");
        }
        if (document.dirty && !request.discard_dirty) {
          throw new Error("Mock Resource has an unsaved draft; explicit discard is required.");
        }
        if (request.discard_dirty) documents.delete(descriptor.resource_id);
      }
      persistedContent.delete(descriptor.resource_id);
      const missing: ResourceDescriptor = {
        ...descriptor,
        resource_revision: descriptor.resource_revision + 1,
        status: "missing",
        media_type: null,
        size_bytes: null,
        content_sha256: null,
      };
      return installResources(resources.resources.map((resource) =>
        resource.resource_id === missing.resource_id ? missing : resource
      ));
    },
    subscribeResourcesInvalidated(listener: () => void): Unsubscribe {
      resourceListeners.add(listener);
      return () => resourceListeners.delete(listener);
    },
    publishResources(next: ResourceRegistrySnapshot) {
      resources = copyResources(next);
      notifyResources();
    },
  };
}
