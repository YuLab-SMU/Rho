import { describe, expect, it, vi } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type {
  ProjectUiProfileSnapshot,
  RuntimeRegistrySnapshot,
  StudioRuntimeSnapshot,
  SurfaceInstance,
  SurfaceRuntimeSnapshot,
} from "../../transport";
import type { ConsoleExecutionEndpoint } from "./console-execution-router";
import type { ConsoleRequirementPorts } from "./console-requirement-controller";
import { ConsoleRequirementController } from "./console-requirement-controller";

const generatedSurfaces = fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;
const generatedStudio = fixture.studio_runtime_snapshot as unknown as StudioRuntimeSnapshot;
const generatedRuntimes = fixture.runtime_registry_snapshot as unknown as RuntimeRegistrySnapshot;
const generatedProfile = fixture.project_ui_profile_snapshot as unknown as ProjectUiProfileSnapshot;

const endpoint = (instanceId: string): ConsoleExecutionEndpoint => ({
  instanceId,
  submitSource: () => ({ accepted: true, message: null }),
});

interface HarnessOverrides {
  readonly surfaces?: SurfaceRuntimeSnapshot;
  readonly studio?: StudioRuntimeSnapshot;
  readonly runtimes?: RuntimeRegistrySnapshot;
  readonly profile?: ProjectUiProfileSnapshot;
  readonly getStudio?: ConsoleRequirementPorts["getStudio"];
  readonly attachRuntime?: ConsoleRequirementPorts["attachRuntime"];
  readonly openSurface?: ConsoleRequirementPorts["openSurface"];
}

function harness(overrides: HarnessOverrides = {}) {
  const surfaces = structuredClone(overrides.surfaces ?? generatedSurfaces);
  const studio = structuredClone(overrides.studio ?? generatedStudio);
  const runtimes = structuredClone(overrides.runtimes ?? generatedRuntimes);
  const profile = structuredClone(overrides.profile ?? generatedProfile);
  const applyStudio = vi.fn(async () => studio);
  const waitForRenderer = vi.fn(async (instanceId: string) => endpoint(instanceId));
  const markPreferred = vi.fn();
  const ports: ConsoleRequirementPorts = {
    getSurfaces: () => ({ status: "ready", source: "mock", snapshot: surfaces }),
    getStudio: overrides.getStudio ?? (() => ({ status: "ready", source: "mock", snapshot: studio })),
    getRuntimes: () => ({ status: "ready", source: "mock", snapshot: runtimes }),
    getProfile: () => ({ status: "ready", source: "mock", snapshot: profile }),
    attachRuntime: overrides.attachRuntime ?? (async () => surfaces),
    refreshSurfaces: vi.fn(async () => undefined),
    openSurface: overrides.openSurface ?? (async () => { throw new Error("unexpected open"); }),
    applyStudio,
    waitForRenderer,
    markPreferred,
    allocateLayoutNodeId: (() => {
      let next = 0;
      return () => `test-node:${next++}`;
    })(),
  };
  return {
    controller: new ConsoleRequirementController(ports),
    ports,
    applyStudio,
    waitForRenderer,
    markPreferred,
  };
}

function withConsoles(
  surfaces: SurfaceRuntimeSnapshot,
  transform: (instance: SurfaceInstance) => SurfaceInstance | null,
): SurfaceRuntimeSnapshot {
  return {
    ...surfaces,
    catalog: {
      ...surfaces.catalog,
      instances: surfaces.catalog.instances.flatMap((instance) => {
        if (instance.surface_id !== "rho.console") return [instance];
        const next = transform(instance);
        return next == null ? [] : [next];
      }),
    },
  };
}

describe("Console requirement controller", () => {
  it("activates the best eligible inactive Console tab and waits for its renderer", async () => {
    const current = harness();
    await expect(current.controller.resolve("instance:file-source")).resolves.toMatchObject({
      instanceId: "instance:console-b",
    });
    expect(current.applyStudio).toHaveBeenCalledWith(expect.objectContaining({
      edit: {
        kind: "set_stack_active",
        stack_node_id: "node:consoles",
        instance_id: "instance:console-b",
      },
    }));
    expect(current.waitForRenderer).toHaveBeenCalledWith("instance:console-b");
    expect(current.markPreferred).toHaveBeenCalledWith("instance:console-b");
  });

  it("rejects unready stores, Vibe mode, project mismatch and missing primary Runtime", async () => {
    const unreadyPorts = harness().ports;
    const unready = new ConsoleRequirementController({
      ...unreadyPorts,
      getSurfaces: () => ({ status: "loading" }),
    });
    await expect(unready.resolve("instance:file-source")).rejects.toThrow("not ready");

    const vibe: ProjectUiProfileSnapshot = {
      ...structuredClone(generatedProfile),
      profile: { ...structuredClone(generatedProfile.profile), active_mode: "vibe" },
    };
    await expect(harness({ profile: vibe }).controller.resolve("instance:file-source"))
      .rejects.toThrow("Studio mode");

    const mismatched: StudioRuntimeSnapshot = {
      ...structuredClone(generatedStudio),
      project_id: "project:other",
    };
    await expect(harness({ studio: mismatched }).controller.resolve("instance:file-source"))
      .rejects.toThrow("changing projects");

    const noPrimary: RuntimeRegistrySnapshot = {
      ...structuredClone(generatedRuntimes),
      instances: [],
    };
    await expect(harness({ runtimes: noPrimary }).controller.resolve("instance:file-source"))
      .rejects.toThrow("No primary scientific Runtime");
  });

  it("does not auto-resume a deliberately paused or failed Console", async () => {
    for (const lifecycle_state of ["suspended", "failed"] as const) {
      let retained = false;
      const surfaces = withConsoles(structuredClone(generatedSurfaces), (instance) => {
        if (retained) return null;
        retained = true;
        return { ...instance, lifecycle_state };
      });
      await expect(harness({ surfaces }).controller.resolve("instance:file-source"))
        .rejects.toThrow(lifecycle_state === "suspended" ? "paused" : "cannot be restored");
    }
  });

  it("attaches one eligible unbound Console before activation", async () => {
    let retained = false;
    const surfaces = withConsoles(structuredClone(generatedSurfaces), (instance) => {
      if (retained) return null;
      retained = true;
      return { ...instance, runtime_binding: null };
    });
    const primary = generatedRuntimes.instances[0]!;
    const attached = {
      ...surfaces,
      catalog: {
        ...surfaces.catalog,
        instances: surfaces.catalog.instances.map((instance) => instance.surface_id === "rho.console"
          ? {
              ...instance,
              runtime_binding: {
                runtime_provider_id: primary.runtime_provider_id,
                runtime_instance_id: primary.runtime_instance_id,
                runtime_kind: primary.runtime_kind,
                project_id: primary.project_id,
                activation_generation: primary.activation_generation,
                state_revision: primary.state_revision,
                attach_capabilities: primary.attach_capabilities,
              },
            }
          : instance),
      },
    };
    const attachRuntime = vi.fn(async () => attached);
    const current = harness({ surfaces, attachRuntime });
    await current.controller.resolve("instance:file-source");
    expect(attachRuntime).toHaveBeenCalledTimes(1);
    expect(current.ports.refreshSurfaces).toHaveBeenCalledTimes(1);
  });

  it("opens and places one new Console only when reusable instances do not exist", async () => {
    const surfaces = withConsoles(structuredClone(generatedSurfaces), () => null);
    const template = generatedSurfaces.catalog.instances.find((instance) => instance.surface_id === "rho.console")!;
    const created = { ...template, instance_id: "instance:console-created" };
    const opened: SurfaceRuntimeSnapshot = {
      ...surfaces,
      catalog: { ...surfaces.catalog, instances: [...surfaces.catalog.instances, created] },
    };
    const openSurface = vi.fn(async () => opened);
    const current = harness({ surfaces, openSurface });
    await expect(current.controller.resolve("instance:file-source")).resolves.toMatchObject({
      instanceId: "instance:console-created",
    });
    expect(openSurface).toHaveBeenCalledTimes(1);
    expect(current.applyStudio).toHaveBeenCalledWith(expect.objectContaining({
      edit: expect.objectContaining({ kind: "replace_root" }),
    }));
  });

  it("revalidates Source placement after async preparation before mutating Studio", async () => {
    const surfaces = withConsoles(structuredClone(generatedSurfaces), () => null);
    const template = generatedSurfaces.catalog.instances.find((instance) => instance.surface_id === "rho.console")!;
    const opened = {
      ...surfaces,
      catalog: {
        ...surfaces.catalog,
        instances: [...surfaces.catalog.instances, { ...template, instance_id: "instance:console-created" }],
      },
    };
    const initialLatest = structuredClone(generatedStudio);
    const latest: StudioRuntimeSnapshot = initialLatest.scene.root.kind === "container"
      ? {
          ...initialLatest,
          scene: {
            ...initialLatest.scene,
            root: {
              ...initialLatest.scene.root,
              children: initialLatest.scene.root.children.filter((child) => {
        const node = child.child;
        return !(node.kind === "container" && node.node_id === "node:center");
              }),
            },
          },
        }
      : initialLatest;
    let reads = 0;
    const getStudio: ConsoleRequirementPorts["getStudio"] = () => ({
      status: "ready",
      source: "mock",
      snapshot: reads++ === 0 ? structuredClone(generatedStudio) : latest,
    });
    const current = harness({ surfaces, getStudio, openSurface: async () => opened });
    await expect(current.controller.resolve("instance:file-source")).rejects.toThrow("Source editor moved");
    expect(current.applyStudio).not.toHaveBeenCalled();
  });
});
