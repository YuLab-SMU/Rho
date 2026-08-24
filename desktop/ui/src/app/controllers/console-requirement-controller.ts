import type {
  OpenSurfaceRequest,
  RuntimeAttachmentRequest,
  RuntimeDescriptor,
  RuntimeInstanceRequest,
  SceneEditRequest,
  StudioRuntimeSnapshot,
  SurfaceInstance,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
} from "../../transport";
import type {
  RuntimeStoreSnapshot,
  StudioStoreSnapshot,
  SurfaceStoreSnapshot,
  UiProfileStoreSnapshot,
} from "../../transport/store";
import { computeStudioEmergence, findStudioInstancePlacement } from "../../transport/studio-model";
import type { ConsoleExecutionEndpoint } from "./console-execution-router";

export interface ConsoleRequirementPorts {
  readonly getSurfaces: () => SurfaceStoreSnapshot;
  readonly getStudio: () => StudioStoreSnapshot;
  readonly getRuntimes: () => RuntimeStoreSnapshot;
  readonly getProfile: () => UiProfileStoreSnapshot;
  readonly attachRuntime: (request: RuntimeAttachmentRequest) => Promise<SurfaceRuntimeSnapshot>;
  readonly refreshSurfaces: () => Promise<void>;
  readonly openSurface: (request: OpenSurfaceRequest) => Promise<SurfaceRuntimeSnapshot>;
  readonly applyStudio: (request: SceneEditRequest) => Promise<StudioRuntimeSnapshot>;
  readonly waitForRenderer: (instanceId: string) => Promise<ConsoleExecutionEndpoint>;
  readonly markPreferred: (instanceId: string) => void;
  readonly allocateLayoutNodeId: () => string;
}

function instanceRequest(
  instance: SurfaceInstance,
  projectRevision: number,
): SurfaceInstanceRequest {
  return {
    project_id: instance.project_id,
    instance_id: instance.instance_id,
    activation_generation: instance.activation_generation,
    expected_project_revision: projectRevision,
    expected_surface_revision: instance.surface_revision,
  };
}

function runtimeRequest(
  runtime: RuntimeDescriptor,
  projectRevision: number,
): RuntimeInstanceRequest {
  return {
    project_id: runtime.project_id,
    runtime_provider_id: runtime.runtime_provider_id,
    runtime_instance_id: runtime.runtime_instance_id,
    activation_generation: runtime.activation_generation,
    expected_project_revision: projectRevision,
    expected_state_revision: runtime.state_revision,
  };
}

function runtimeBindingMatches(
  instance: SurfaceInstance,
  runtime: RuntimeDescriptor,
): boolean {
  return instance.runtime_binding != null &&
    instance.runtime_binding.runtime_provider_id === runtime.runtime_provider_id &&
    instance.runtime_binding.runtime_instance_id === runtime.runtime_instance_id &&
    instance.runtime_binding.activation_generation === runtime.activation_generation &&
    instance.runtime_binding.project_id === runtime.project_id;
}

export class ConsoleRequirementController {
  readonly #ports: ConsoleRequirementPorts;

  constructor(ports: ConsoleRequirementPorts) {
    this.#ports = ports;
  }

  async resolve(sourceInstanceId: string): Promise<ConsoleExecutionEndpoint> {
    const surfaceState = this.#ports.getSurfaces();
    const studioState = this.#ports.getStudio();
    const runtimeState = this.#ports.getRuntimes();
    const profileState = this.#ports.getProfile();
    if (
      surfaceState.status !== "ready" || studioState.status !== "ready" ||
      runtimeState.status !== "ready" || profileState.status !== "ready"
    ) {
      throw new Error("The component layout or Runtime Registry is not ready yet.");
    }
    if (profileState.snapshot.profile.active_mode !== "studio") {
      throw new Error("Automatic Console placement is available in Studio mode.");
    }

    let surfaceSnapshot = surfaceState.snapshot;
    let studioSnapshot = studioState.snapshot;
    const runtimeSnapshot = runtimeState.snapshot;
    if (
      surfaceSnapshot.project_id !== studioSnapshot.project_id ||
      surfaceSnapshot.project_id !== runtimeSnapshot.project_id
    ) {
      throw new Error("The component layout is changing projects. Try Run again when the switch completes.");
    }
    const primaryRuntime = runtimeSnapshot.instances.find((runtime) => runtime.primary_scientific_runtime);
    if (primaryRuntime == null) {
      throw new Error("No primary scientific Runtime is available for an R Console.");
    }
    if (!primaryRuntime.attach_capabilities.includes("console.attach")) {
      throw new Error(`${primaryRuntime.display_label} cannot attach an R Console.`);
    }
    const sourcePlacement = findStudioInstancePlacement(studioSnapshot.scene, sourceInstanceId);
    if (sourcePlacement == null) {
      throw new Error("The invoking Source editor is no longer placed in this Scene.");
    }

    const consoles = surfaceSnapshot.catalog.instances.filter(
      (instance) => instance.surface_id === "rho.console" &&
        instance.project_id === surfaceSnapshot.project_id,
    );
    const usable = consoles.filter((instance) =>
      (instance.lifecycle_state === "active" || instance.lifecycle_state === "hidden") &&
      (instance.runtime_binding == null || runtimeBindingMatches(instance, primaryRuntime)) &&
      !(
        sourcePlacement.kind === "stack" &&
        findStudioInstancePlacement(studioSnapshot.scene, instance.instance_id)?.nodeId === sourcePlacement.nodeId
      )
    );
    const rank = (instance: SurfaceInstance) => {
      const placement = findStudioInstancePlacement(studioSnapshot.scene, instance.instance_id);
      const binding = runtimeBindingMatches(instance, primaryRuntime) ? 0 : 10;
      const location = placement?.kind === "stack" && !placement.active
        ? 0
        : placement == null || placement.kind === "utility"
          ? 2
          : 1;
      return binding + location;
    };
    usable.sort((left, right) => rank(left) - rank(right) ||
      left.instance_id.localeCompare(right.instance_id));
    let candidate = usable[0] ?? null;

    if (candidate == null) {
      const intentionallyUnavailable = consoles.find((instance) =>
        instance.runtime_binding == null || runtimeBindingMatches(instance, primaryRuntime)
      );
      if (intentionallyUnavailable?.lifecycle_state === "suspended") {
        throw new Error("An R Console is paused. Resume it before running Source code.");
      }
      if (intentionallyUnavailable?.lifecycle_state === "failed" ||
          intentionallyUnavailable?.lifecycle_state === "placeholder") {
        throw new Error("The available R Console cannot be restored automatically. Open its component menu to recover it.");
      }
    }

    if (candidate != null && candidate.runtime_binding == null) {
      const candidateId = candidate.instance_id;
      const attached = await this.#ports.attachRuntime({
        runtime: runtimeRequest(primaryRuntime, runtimeSnapshot.project_revision),
        surface: instanceRequest(candidate, surfaceSnapshot.project_revision),
      });
      await this.#ports.refreshSurfaces();
      surfaceSnapshot = attached;
      candidate = surfaceSnapshot.catalog.instances.find(
        (instance) => instance.instance_id === candidateId,
      ) ?? null;
      if (candidate == null || !runtimeBindingMatches(candidate, primaryRuntime)) {
        throw new Error("The reused R Console did not retain its Workspace R attachment.");
      }
    }

    if (candidate == null) {
      const factory = surfaceSnapshot.catalog.factories.find(
        (registration) => registration.definition.surface_id === "rho.console",
      );
      if (factory == null) throw new Error("The R Console component is unavailable.");
      const before = new Set(surfaceSnapshot.catalog.instances.map((instance) => instance.instance_id));
      const opened = await this.#ports.openSurface({
        surface_id: "rho.console",
        project_id: surfaceSnapshot.project_id,
        mode_id: factory.definition.modes[0]?.mode_id ?? null,
        resource_binding: null,
        runtime_binding: {
          runtime_provider_id: primaryRuntime.runtime_provider_id,
          runtime_instance_id: primaryRuntime.runtime_instance_id,
          runtime_kind: primaryRuntime.runtime_kind,
          project_id: primaryRuntime.project_id,
          activation_generation: primaryRuntime.activation_generation,
          state_revision: primaryRuntime.state_revision,
          attach_capabilities: primaryRuntime.attach_capabilities,
        },
        view_group_id: null,
        view_state: {
          draft: "",
          history: [],
          history_cursor: null,
          filter: "",
          scroll_top: 0,
          outputs: [],
        },
        instance_disposition: "new_instance",
        placement_intent: "beside",
        expected_project_revision: surfaceSnapshot.project_revision,
        expected_layout_revision: studioSnapshot.scene.layout_revision,
      });
      candidate = opened.catalog.instances.find((instance) => !before.has(instance.instance_id)) ?? null;
      if (candidate == null) throw new Error("The R Console component was not created.");
      surfaceSnapshot = opened;
    }

    const latestStudioState = this.#ports.getStudio();
    if (latestStudioState.status !== "ready") throw new Error("The Studio layout is unavailable.");
    studioSnapshot = latestStudioState.snapshot;
    if (studioSnapshot.project_id !== candidate.project_id) {
      throw new Error("The project changed before the R Console could be placed.");
    }
    const latestSourcePlacement = findStudioInstancePlacement(studioSnapshot.scene, sourceInstanceId);
    if (latestSourcePlacement == null) {
      throw new Error("The invoking Source editor moved before the R Console could be placed. Try Run again.");
    }
    const placement = findStudioInstancePlacement(studioSnapshot.scene, candidate.instance_id);
    if (
      placement?.kind === "stack" && !placement.active &&
      placement.nodeId !== latestSourcePlacement.nodeId
    ) {
      await this.#ports.applyStudio({
        project_id: studioSnapshot.project_id,
        expected_project_revision: studioSnapshot.project_revision,
        expected_layout_revision: studioSnapshot.scene.layout_revision,
        edit: {
          kind: "set_stack_active",
          stack_node_id: placement.nodeId,
          instance_id: candidate.instance_id,
        },
      });
    } else if (
      placement == null || placement.kind === "utility" ||
      (placement.kind === "stack" && !placement.active)
    ) {
      const next = computeStudioEmergence(
        studioSnapshot.scene,
        candidate.instance_id,
        sourceInstanceId,
        this.#ports.allocateLayoutNodeId,
      );
      if (next == null) throw new Error("The R Console could not be placed beside this Source editor.");
      await this.#ports.applyStudio({
        project_id: studioSnapshot.project_id,
        expected_project_revision: studioSnapshot.project_revision,
        expected_layout_revision: studioSnapshot.scene.layout_revision,
        edit: { kind: "replace_root", root: next.root },
      });
    }

    const endpoint = await this.#ports.waitForRenderer(candidate.instance_id);
    this.#ports.markPreferred(candidate.instance_id);
    return endpoint;
  }
}
