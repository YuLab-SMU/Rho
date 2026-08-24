import { describe, expect, it, vi } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type { SurfaceRuntimeSnapshot } from "../../transport";
import type { SurfaceInstanceMutationPorts } from "./surface-instance-mutation-controller";
import { SurfaceInstanceMutationController } from "./surface-instance-mutation-controller";

const generatedSurfaces = fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;

function harness() {
  let snapshot = structuredClone(generatedSurfaces);
  const installNext = (instanceId: string): SurfaceRuntimeSnapshot => {
    snapshot = {
      ...snapshot,
      snapshot_revision: snapshot.snapshot_revision + 1,
      catalog: {
        ...snapshot.catalog,
        instances: snapshot.catalog.instances.map((instance) => instance.instance_id === instanceId
          ? { ...instance, surface_revision: instance.surface_revision + 1 }
          : instance),
      },
    };
    return snapshot;
  };
  const update = vi.fn<SurfaceInstanceMutationPorts["update"]>(async (request) =>
    installNext(request.target.instance_id));
  const suspend = vi.fn<SurfaceInstanceMutationPorts["suspend"]>(async (request) =>
    installNext(request.instance_id));
  const resume = vi.fn<SurfaceInstanceMutationPorts["resume"]>(async (request) =>
    installNext(request.instance_id));
  const ports: SurfaceInstanceMutationPorts = {
    getSurfaces: () => ({ status: "ready", source: "mock", snapshot }),
    update,
    suspend,
    resume,
  };
  return {
    controller: new SurfaceInstanceMutationController(ports),
    update,
    suspend,
    resume,
    setSnapshot: (next: SurfaceRuntimeSnapshot) => { snapshot = next; },
  };
}

describe("Surface instance mutation controller", () => {
  it("serializes one instance and reads the latest Surface revision for each write", async () => {
    const current = harness();
    const first = current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "one" },
    });
    const second = current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "two" },
    });
    await Promise.all([first, second]);
    const firstRevision = current.update.mock.calls[0]![0].target.expected_surface_revision;
    const secondRevision = current.update.mock.calls[1]![0].target.expected_surface_revision;
    expect(secondRevision).toBe(firstRevision + 1);
  });

  it("keeps independent instances on independent queues", async () => {
    const current = harness();
    let release: (() => void) | undefined;
    current.update.mockImplementationOnce((request) => new Promise<SurfaceRuntimeSnapshot>((resolve) => {
      release = () => resolve(structuredClone(generatedSurfaces));
      expect(request.target.instance_id).toBe("instance:console-a");
    }));
    const first = current.controller.update("instance:console-a", { kind: "set_view_state", view_state: {} });
    const other = current.controller.update("instance:navigator", { kind: "set_view_state", view_state: {} });
    await expect(other).resolves.toBeDefined();
    expect(current.update).toHaveBeenCalledTimes(2);
    release?.();
    await first;
  });

  it("recovers the per-instance queue after a rejected write", async () => {
    const current = harness();
    current.update.mockRejectedValueOnce(new Error("stale revision"));
    await expect(current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "first" },
    })).rejects.toThrow("stale revision");
    await expect(current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "retry" },
    })).resolves.toBeDefined();
  });

  it("rejects unready, missing and cross-project work before mutation", async () => {
    const current = harness();
    const unready = new SurfaceInstanceMutationController({
      getSurfaces: () => ({ status: "loading" }),
      update: current.update,
      suspend: current.suspend,
      resume: current.resume,
    });
    await expect(unready.update("instance:console-a", { kind: "set_view_state", view_state: {} }))
      .rejects.toThrow("not ready");
    await expect(current.controller.update("instance:missing", { kind: "set_view_state", view_state: {} }))
      .rejects.toThrow("no longer available");

    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    current.update.mockImplementationOnce(() => new Promise<SurfaceRuntimeSnapshot>((resolve) => {
      markStarted?.();
      release = () => resolve(structuredClone(generatedSurfaces));
    }));
    const first = current.controller.update("instance:console-a", { kind: "set_view_state", view_state: {} });
    await started;
    const queued = current.controller.update("instance:console-a", { kind: "set_view_state", view_state: {} });
    current.setSnapshot({ ...structuredClone(generatedSurfaces), project_id: "project:other" });
    release?.();
    await first;
    await expect(queued).rejects.toThrow("project changed");
  });

  it("routes suspend and resume through the current exact instance request", async () => {
    const current = harness();
    await current.controller.suspend("instance:console-a");
    await current.controller.resume("instance:console-a");
    expect(current.suspend).toHaveBeenCalledTimes(1);
    expect(current.resume).toHaveBeenCalledTimes(1);
    expect(current.resume.mock.calls[0]![0].expected_surface_revision)
      .toBe(current.suspend.mock.calls[0]![0].expected_surface_revision + 1);
  });
});
