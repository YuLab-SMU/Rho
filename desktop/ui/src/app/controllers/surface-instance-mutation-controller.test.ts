import { describe, expect, it, vi } from "vitest";

import fixture from "../../contracts/generated/rsr-contract-fixtures.json";
import type { SurfaceRuntimeSnapshot } from "../../transport";
import type { SurfaceInstanceMutationPorts } from "./surface-instance-mutation-controller";
import { SurfaceInstanceMutationController } from "./surface-instance-mutation-controller";

const generatedSurfaces = fixture.surface_runtime_snapshot as unknown as SurfaceRuntimeSnapshot;

function harness() {
  let snapshot = structuredClone(generatedSurfaces);
  let admissionOpen = true;
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
  let admissionCount = 0;
  const admit: SurfaceInstanceMutationPorts["admit"] = async (projectId, operation) => {
    admissionCount += 1;
    if (!admissionOpen) throw new Error("Project transition is in progress.");
    return operation({ projectId, admissionEpoch: 0 });
  };
  const ports: SurfaceInstanceMutationPorts = {
    getSurfaces: () => ({ status: "ready", source: "mock", snapshot }),
    admit,
    update,
    suspend,
    resume,
  };
  return {
    controller: new SurfaceInstanceMutationController(ports),
    admit,
    update,
    suspend,
    resume,
    getAdmissionCount: () => admissionCount,
    setSnapshot: (next: SurfaceRuntimeSnapshot) => { snapshot = next; },
    setAdmissionOpen: (open: boolean) => { admissionOpen = open; },
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

  it("forwards an existing composition-root lease without opening a second admission", async () => {
    const current = harness();
    const lease = {
      projectId: generatedSurfaces.project_id,
      admissionEpoch: 7,
    };
    current.setAdmissionOpen(false);
    await expect(current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "one admitted workflow" },
    }, lease)).resolves.toBeDefined();
    expect(current.getAdmissionCount()).toBe(0);
    expect(current.update).toHaveBeenCalledWith(expect.objectContaining({
      mutation: {
        kind: "set_view_state",
        view_state: { draft: "one admitted workflow" },
      },
    }), lease);
  });

  it("rejects an admitted exact update after the Surface activation is replaced", async () => {
    const current = harness();
    const original = generatedSurfaces.catalog.instances.find(
      (instance) => instance.instance_id === "instance:console-a",
    )!;
    const lease = {
      projectId: generatedSurfaces.project_id,
      admissionEpoch: 7,
    };
    current.setSnapshot({
      ...structuredClone(generatedSurfaces),
      catalog: {
        ...structuredClone(generatedSurfaces.catalog),
        instances: generatedSurfaces.catalog.instances.map((instance) => (
          instance.instance_id === original.instance_id
            ? { ...instance, activation_generation: instance.activation_generation + 1 }
            : instance
        )),
      },
    });

    await expect(current.controller.updateExact(original, {
      kind: "set_view_state",
      view_state: { conversation_id: "agent-conversation:stale" },
    }, lease)).rejects.toThrow("exact component activation");
    expect(current.update).not.toHaveBeenCalled();
  });

  it("rejects unready, missing and cross-project work before mutation", async () => {
    const current = harness();
    const unready = new SurfaceInstanceMutationController({
      getSurfaces: () => ({ status: "loading" }),
      admit: async (projectId, operation) => operation({ projectId, admissionEpoch: 0 }),
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

  it("drains work admitted before a project transition and rejects new admissions", async () => {
    const current = harness();
    let release: (() => void) | undefined;
    current.update.mockImplementationOnce((request) => new Promise<SurfaceRuntimeSnapshot>((resolve) => {
      release = () => resolve({
        ...structuredClone(generatedSurfaces),
        snapshot_revision: generatedSurfaces.snapshot_revision + 1,
      });
      expect(request.target.instance_id).toBe("instance:console-a");
    }));
    const admitted = current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "before transition" },
    });
    const queued = current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "queued before transition" },
    });
    current.setAdmissionOpen(false);
    await expect(current.controller.update("instance:navigator", {
      kind: "set_view_state",
      view_state: { selected_tab: "files" },
    })).rejects.toThrow("transition");
    let settled = false;
    const waiting = current.controller.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(admitted).resolves.toBeDefined();
    await expect(queued).resolves.toBeDefined();
    await waiting;
    expect(current.update).toHaveBeenCalledTimes(2);
    expect(current.update.mock.calls.map(([request]) => (
      request.mutation.kind === "set_view_state"
        ? (request.mutation.view_state as { draft?: unknown }).draft
        : null
    ))).toEqual(["before transition", "queued before transition"]);
  });

  it("drains every pre-close queue entry after a rejection and recovers admission after reopen", async () => {
    const current = harness();
    const portOrder: string[] = [];
    let rejectEntry1: ((reason?: unknown) => void) | undefined;
    let markEntry2Started: (() => void) | undefined;
    const entry2Started = new Promise<void>((resolve) => { markEntry2Started = resolve; });
    let releaseEntry2: (() => void) | undefined;
    current.update
      .mockImplementationOnce((request) => new Promise<SurfaceRuntimeSnapshot>((_resolve, reject) => {
        portOrder.push("entry1");
        expect(request.mutation).toMatchObject({
          kind: "set_view_state",
          view_state: { draft: "entry1" },
        });
        rejectEntry1 = reject;
      }))
      .mockImplementationOnce((request) => new Promise<SurfaceRuntimeSnapshot>((resolve) => {
        portOrder.push("entry2");
        expect(request.mutation).toMatchObject({
          kind: "set_view_state",
          view_state: { draft: "entry2" },
        });
        markEntry2Started?.();
        releaseEntry2 = () => resolve({
          ...structuredClone(generatedSurfaces),
          snapshot_revision: generatedSurfaces.snapshot_revision + 1,
        });
      }));

    const entry1 = current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "entry1" },
    });
    const entry1Outcome = entry1.then(
      () => null,
      (error: unknown) => error,
    );
    const entry2 = current.controller.update("instance:console-a", {
      kind: "set_view_state",
      view_state: { draft: "entry2" },
    });
    await Promise.resolve();
    expect(current.update).toHaveBeenCalledTimes(1);

    current.setAdmissionOpen(false);
    await expect(current.controller.update("instance:navigator", {
      kind: "set_view_state",
      view_state: { selected_tab: "entry3" },
    })).rejects.toThrow("transition");
    expect(current.update).toHaveBeenCalledTimes(1);

    let settled = false;
    const waiting = current.controller.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    rejectEntry1?.(new Error("entry1 stale revision"));
    await expect(entry1Outcome).resolves.toEqual(expect.objectContaining({
      message: "entry1 stale revision",
    }));
    await entry2Started;
    expect(portOrder).toEqual(["entry1", "entry2"]);
    expect(current.update).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseEntry2?.();
    await expect(entry2).resolves.toBeDefined();
    await waiting;
    expect(settled).toBe(true);

    current.setAdmissionOpen(true);
    await expect(current.controller.update("instance:navigator", {
      kind: "set_view_state",
      view_state: { selected_tab: "entry4" },
    })).resolves.toBeDefined();
    expect(current.update).toHaveBeenCalledTimes(3);
    expect(current.update.mock.calls.map(([request]) => (
      request.mutation.kind === "set_view_state"
        ? request.mutation.view_state
        : null
    ))).toEqual([
      { draft: "entry1" },
      { draft: "entry2" },
      { selected_tab: "entry4" },
    ]);
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
