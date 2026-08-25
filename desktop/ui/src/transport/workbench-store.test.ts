import { describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "./mock";
import { WorkbenchProjectionStore } from "./workbench-store";
import type { WorkbenchProjection } from "./workbench-projection";

async function projectionFor(
  path: string,
  generation: number,
): Promise<WorkbenchProjection> {
  const transport = createMockUiKernelTransport(`?project=${encodeURIComponent(path)}`);
  const projection = await transport.loadWorkbenchProjection();
  (projection as { projection_generation: number }).projection_generation = generation;
  return projection;
}

describe("WorkbenchProjectionStore", () => {
  it("owns one transport subscription regardless of React listener count", async () => {
    const base = createMockUiKernelTransport();
    const stopTransport = vi.fn();
    const subscribeWorkbenchInvalidated = vi.fn(() => stopTransport);
    const loadWorkbenchProjection = vi.spyOn(base, "loadWorkbenchProjection");
    const store = new WorkbenchProjectionStore({
      ...base,
      subscribeWorkbenchInvalidated,
    });

    const stopA = store.subscribe(() => undefined);
    const stopB = store.subscribe(() => undefined);
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    expect(subscribeWorkbenchInvalidated).toHaveBeenCalledTimes(1);
    expect(loadWorkbenchProjection).toHaveBeenCalledTimes(1);

    stopA();
    expect(stopTransport).not.toHaveBeenCalled();
    stopB();
    expect(stopTransport).toHaveBeenCalledTimes(1);
  });

  it("orders A/B/A globally and ignores a late lower generation", async () => {
    const [projectA10, projectB12, staleA11, projectA13] = await Promise.all([
      projectionFor("/tmp/project-a", 10),
      projectionFor("/tmp/project-b", 12),
      projectionFor("/tmp/project-a", 11),
      projectionFor("/tmp/project-a", 13),
    ]);
    const base = createMockUiKernelTransport();
    const loadWorkbenchProjection = vi.fn()
      .mockResolvedValueOnce(projectA10)
      .mockResolvedValueOnce(projectB12)
      .mockResolvedValueOnce(staleA11)
      .mockResolvedValueOnce(projectA13);
    const store = new WorkbenchProjectionStore({ ...base, loadWorkbenchProjection });

    await store.refresh();
    await store.refresh();
    const projectB = store.getSnapshot();
    expect(projectB.status === "ready" && projectB.snapshot.project_id)
      .toBe(projectB12.project_id);

    await store.refresh();
    expect(store.getSnapshot()).toBe(projectB);

    await store.refresh();
    const final = store.getSnapshot();
    expect(final.status).toBe("ready");
    if (final.status === "ready") {
      expect(final.snapshot.project_id).toBe(projectA13.project_id);
      expect(final.snapshot.projection_generation).toBe(13);
    }
  });

  it("rejects different data for one generation and never falls back to older truth", async () => {
    const current = await projectionFor("/tmp/project-a", 20);
    const conflicting = structuredClone(current);
    (conflicting.kernel.project as { display_label: string }).display_label = "conflict";
    const stale = await projectionFor("/tmp/project-a", 19);
    const base = createMockUiKernelTransport();
    const loadWorkbenchProjection = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(conflicting)
      .mockResolvedValueOnce(stale);
    const store = new WorkbenchProjectionStore({ ...base, loadWorkbenchProjection });

    await store.refresh();
    await expect(store.refresh()).rejects.toThrow(/different data/i);
    expect(store.getSnapshot()).toMatchObject({ status: "failed" });
    await expect(store.refresh()).rejects.toThrow(/different data/i);
    expect(store.getSnapshot()).toMatchObject({ status: "failed" });
  });

  it("rejects a mixed-project projection before publishing it", async () => {
    const mixed = await projectionFor("/tmp/project-a", 30);
    (mixed.resources as { project_id: string }).project_id = "project:mixed";
    const base = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore({
      ...base,
      loadWorkbenchProjection: vi.fn().mockResolvedValue(mixed),
    });

    await expect(store.refresh()).rejects.toThrow(/different projects/i);
    expect(store.getSnapshot()).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/different projects/i),
    });
  });

  it("keeps the last coherent projection when post-mutation refresh fails, then recovers", async () => {
    const transport = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore(transport);
    await store.refresh();
    const before = store.getSnapshot();
    if (before.status !== "ready") throw new Error("initial projection did not load");
    const profile = before.snapshot.profile.profile;
    vi.spyOn(transport, "loadWorkbenchProjection")
      .mockRejectedValueOnce(new Error("projection unavailable"));

    await expect(store.setMode({
      target: {
        project_id: profile.project_id,
        expected_profile_revision: profile.revision,
      },
      mode: "vibe",
    })).rejects.toThrow(/projection unavailable/i);
    expect(store.getSnapshot()).toBe(before);

    await store.refresh();
    const recovered = store.getSnapshot();
    expect(recovered.status).toBe("ready");
    if (recovered.status === "ready") {
      expect(recovered.snapshot.profile.profile.active_mode).toBe("vibe");
    }
  });

  it("rejects a mutation if the active project changes before synchronization", async () => {
    const transport = createMockUiKernelTransport("?project=%2Ftmp%2Fproject-a");
    const store = new WorkbenchProjectionStore(transport);
    await store.refresh();
    const before = store.getSnapshot();
    if (before.status !== "ready") throw new Error("initial projection did not load");
    const oldProfile = before.snapshot.profile;
    vi.spyOn(transport, "setUiProfileMode").mockImplementation(async () => {
      await transport.openProject("/tmp/project-b");
      return oldProfile;
    });

    await expect(store.setMode({
      target: {
        project_id: oldProfile.profile.project_id,
        expected_profile_revision: oldProfile.profile.revision,
      },
      mode: "vibe",
    })).rejects.toThrow(/project changed/i);
    const current = store.getSnapshot();
    expect(current.status).toBe("ready");
    if (current.status === "ready") {
      expect(current.snapshot.project_id).not.toBe(before.snapshot.project_id);
    }
  });

  it("does not acknowledge a mutation without a newer coherent projection", async () => {
    const transport = createMockUiKernelTransport();
    const initial = await transport.loadWorkbenchProjection();
    const store = new WorkbenchProjectionStore({
      ...transport,
      loadWorkbenchProjection: vi.fn().mockResolvedValue(initial),
      setUiProfileMode: vi.fn().mockResolvedValue(initial.profile),
    });
    await store.refresh();
    const profile = initial.profile.profile;

    await expect(store.setMode({
      target: {
        project_id: profile.project_id,
        expected_profile_revision: profile.revision,
      },
      mode: "vibe",
    })).rejects.toThrow(/new projection/i);
  });

  it("lets a dependent operation wait for in-flight mutations without serializing their start", async () => {
    const transport = createMockUiKernelTransport();
    const store = new WorkbenchProjectionStore(transport);
    await store.refresh();
    const current = store.getSnapshot();
    if (current.status !== "ready") throw new Error("initial projection did not load");
    const original = transport.setUiProfileMode.bind(transport);
    let release: (() => void) | undefined;
    vi.spyOn(transport, "setUiProfileMode").mockImplementation((request) => (
      new Promise((resolve, reject) => {
        release = () => { void original(request).then(resolve, reject); };
      })
    ));
    const profile = current.snapshot.profile.profile;
    const mutation = store.setMode({
      target: {
        project_id: profile.project_id,
        expected_profile_revision: profile.revision,
      },
      mode: "vibe",
    });
    let settled = false;
    const waiting = store.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await mutation;
    await waiting;
    expect(settled).toBe(true);
  });
});
