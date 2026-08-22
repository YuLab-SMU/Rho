import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { projectLabel } from "./normalize";
import type {
  OpenSurfaceRequest,
  SetUiSelectionRequest,
  SurfaceInstance,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  UpdateSurfaceRequest,
  UiKernelSnapshot,
  UiKernelTransport,
  Unsubscribe,
} from "./types";

const generatedSnapshot = fixture.kernel_snapshot as unknown as UiKernelSnapshot;
const generatedSurfaces =
  fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;

function copySnapshot(snapshot: UiKernelSnapshot): UiKernelSnapshot {
  return structuredClone(snapshot);
}

function copySurfaces(snapshot: SurfaceRuntimeSnapshot): SurfaceRuntimeSnapshot {
  return structuredClone(snapshot);
}

export interface MockUiKernelTransport extends UiKernelTransport {
  publish(snapshot: UiKernelSnapshot): void;
  publishSurfaces(snapshot: SurfaceRuntimeSnapshot): void;
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
  let nextInstance = 1;
  const listeners = new Set<() => void>();
  const surfaceListeners = new Set<() => void>();
  const notifySurfaces = () => {
    for (const listener of surfaceListeners) listener();
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
    return copySurfaces(surfaces);
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
        request.expected_layout_revision !== 0
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
    },
  };
}
