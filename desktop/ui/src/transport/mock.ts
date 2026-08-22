import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { projectLabel } from "./normalize";
import { applySceneEdit, collectSceneInstances, reconcileStudio } from "./studio-model";
import type {
  OpenSurfaceRequest,
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
  SceneEditRequest,
  SceneState,
  StudioRevisionRequest,
  StudioRuntimeSnapshot,
  UpdateSurfaceRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  Unsubscribe,
} from "./types";

const generatedSnapshot = fixture.kernel_snapshot as unknown as UiKernelSnapshot;
const generatedSurfaces =
  fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;
const generatedStudio =
  fixture.studio_runtime_snapshot as unknown as StudioRuntimeSnapshot;
const generatedRuntimes =
  fixture.runtime_registry_snapshot as unknown as RuntimeRegistrySnapshot;

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

export interface MockUiKernelTransport extends UiKernelTransport {
  publish(snapshot: UiKernelSnapshot): void;
  publishSurfaces(snapshot: SurfaceRuntimeSnapshot): void;
  publishStudio(snapshot: StudioRuntimeSnapshot): void;
  publishRuntimes(snapshot: RuntimeRegistrySnapshot): void;
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
  let nextInstance = 1;
  let nextNode = 1;
  let nextRuntime = 1;
  let nextExecution = 1;
  const allocateNode = () => `node:mock-${nextNode++}`;
  const undo: SceneState[] = [];
  const redo: SceneState[] = [];
  const listeners = new Set<() => void>();
  const surfaceListeners = new Set<() => void>();
  const studioListeners = new Set<() => void>();
  const runtimeListeners = new Set<() => void>();
  const notifySurfaces = () => {
    for (const listener of surfaceListeners) listener();
  };
  const notifyStudio = () => {
    for (const listener of studioListeners) listener();
  };
  const notifyRuntimes = () => {
    for (const listener of runtimeListeners) listener();
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
  const installSurfaces = (instances: readonly SurfaceInstance[]) => {
    const next = copySurfaces(surfaces);
    (next as { snapshot_revision: number }).snapshot_revision += 1;
    (next.catalog as unknown as { instances: SurfaceInstance[] }).instances = [...instances];
    surfaces = next;
    notifySurfaces();
    reconcileCurrentStudio();
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
  const installScene = (scene: SceneState): StudioRuntimeSnapshot => {
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
        case "bind_resource": mutable.resource_binding = request.mutation.binding; break;
        case "bind_runtime": mutable.runtime_binding = request.mutation.binding; break;
        case "set_view_group": mutable.view_group_id = request.mutation.view_group_id; break;
      }
      mutable.surface_revision += 1;
      instances[index] = mutable as SurfaceInstance;
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
  };
}
