import { describe, expect, it, vi } from "vitest";

import { createMockUiKernelTransport } from "./mock";
import {
  createTauriWorkbenchProjectionTransport,
  type WorkbenchProjection,
} from "./workbench-projection";
import type { WorkbenchProjectionInvoke } from "./generated/workbench-projection";

describe("Workbench projection transport", () => {
  it("returns one coherent mock projection with a monotonic generation", async () => {
    const transport = createMockUiKernelTransport();
    const first = await transport.loadWorkbenchProjection();
    const second = await transport.loadWorkbenchProjection();

    expect(second.projection_generation).toBe(first.projection_generation + 1);
    expect([
      first.kernel.project.project_id,
      first.kernel.context.project_id,
      first.surfaces.project_id,
      first.studio.project_id,
      first.studio.scene.project_id,
      first.runtimes.project_id,
      first.resources.project_id,
      first.profile.profile.project_id,
    ]).toEqual(Array(8).fill(first.project_id));
    expect(first.revisions).toMatchObject({
      project_revision: first.kernel.context.project_revision,
      kernel_snapshot_revision: first.kernel.snapshot_revision,
      surface_snapshot_revision: first.surfaces.snapshot_revision,
      studio_snapshot_revision: first.studio.snapshot_revision,
      layout_revision: first.studio.scene.layout_revision,
      runtime_snapshot_revision: first.runtimes.snapshot_revision,
      resource_snapshot_revision: first.resources.snapshot_revision,
      profile_revision: first.profile.profile.revision,
    });
  });

  it("publishes coherent A/B/A project projections without mixed generations", async () => {
    const transport = createMockUiKernelTransport("?project=%2Ftmp%2Fproject-a");
    const firstA = await transport.loadWorkbenchProjection();
    await transport.openProject("/tmp/project-b");
    const projectB = await transport.loadWorkbenchProjection();
    await transport.openProject("/tmp/project-a");
    const secondA = await transport.loadWorkbenchProjection();

    expect(projectB.project_id).not.toBe(firstA.project_id);
    expect(secondA.project_id).toBe(firstA.project_id);
    expect(secondA.projection_generation).toBeGreaterThan(projectB.projection_generation);
    for (const projection of [firstA, projectB, secondA]) {
      expect(projection.surfaces.project_id).toBe(projection.project_id);
      expect(projection.studio.project_id).toBe(projection.project_id);
      expect(projection.runtimes.project_id).toBe(projection.project_id);
      expect(projection.resources.project_id).toBe(projection.project_id);
      expect(projection.profile.profile.project_id).toBe(projection.project_id);
    }
  });

  it("rejects a mixed project or mismatched revision vector at the Tauri boundary", async () => {
    const mock = createMockUiKernelTransport();
    const base = await mock.loadWorkbenchProjection();
    const responses: WorkbenchProjection[] = [];
    async function invoke<T>(command: string): Promise<T> {
      expect(command).toBe("workbench_projection_snapshot");
      return responses.shift() as T;
    }
    const transport = createTauriWorkbenchProjectionTransport(
      invoke as WorkbenchProjectionInvoke,
    );

    const mixed = structuredClone(base);
    (mixed.resources as { project_id: string }).project_id = "project:other";
    responses.push(mixed);
    await expect(transport.loadWorkbenchProjection()).rejects.toThrow(/different projects/);

    const staleVector = structuredClone(base);
    (staleVector.revisions as { layout_revision: number }).layout_revision += 1;
    responses.push(staleVector);
    await expect(transport.loadWorkbenchProjection()).rejects.toThrow(/revision vector/);
  });

  it("exposes one workbench invalidation subscription in mock mode", async () => {
    const transport = createMockUiKernelTransport();
    const listener = vi.fn();
    const unsubscribe = transport.subscribeWorkbenchInvalidated(listener);
    const projection = await transport.loadWorkbenchProjection();
    const resources = structuredClone(projection.resources);
    (resources as { snapshot_revision: number }).snapshot_revision += 1;
    transport.publishResources(resources);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
