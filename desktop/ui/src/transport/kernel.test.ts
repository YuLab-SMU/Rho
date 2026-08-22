import { describe, expect, it, vi } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { createMockUiKernelTransport } from "./mock";
import { SurfaceExternalStore, UiExternalStore } from "./store";
import { createTauriUiKernelTransport } from "./tauri";
import type {
  OpenSurfaceRequest,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  UiKernelSnapshot,
} from "./types";

function generated(): UiKernelSnapshot {
  return structuredClone(fixture.kernel_snapshot) as unknown as UiKernelSnapshot;
}

function generatedSurfaces(): SurfaceRuntimeSnapshot {
  return structuredClone(
    fixture.surface_runtime_snapshot,
  ) as unknown as SurfaceRuntimeSnapshot;
}

describe("UI Kernel transport and external store", () => {
  it("loads the exact Rust-generated command registry in mock mode", async () => {
    const transport = createMockUiKernelTransport(
      "?project=%2Ftmp%2F%E7%A7%91%E5%AD%A6%20Project",
    );
    const snapshot = await transport.loadSnapshot();
    expect(snapshot.project.display_label).toBe("科学 Project");
    expect(snapshot.command_registry.registrations).toEqual(
      fixture.kernel_snapshot.command_registry.registrations,
    );
    expect(
      snapshot.command_registry.registrations.find(
        (registration) => registration.definition.command_id === "ui.command.fixture-inspect",
      )?.definition.origin,
    ).toEqual({
      kind: "workspace_plugin",
      plugin_id: "fixture-plugin",
      package_digest: "a".repeat(64),
    });
  });

  it("caches immutable snapshots without tearing and ignores stale responses", async () => {
    const transport = createMockUiKernelTransport();
    const store = new UiExternalStore(transport);
    const changes = vi.fn();
    const unsubscribe = store.subscribe(changes);
    await store.refresh();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("snapshot did not load");
    expect(Object.isFrozen(first.snapshot)).toBe(true);

    const stale = generated();
    (stale as { snapshot_revision: number }).snapshot_revision =
      first.snapshot.snapshot_revision - 1;
    transport.publish(stale);
    await store.refresh();
    expect(store.getSnapshot()).toBe(first);
    unsubscribe();
  });

  it("accepts a monotonic project A/B/A sequence", async () => {
    const transport = createMockUiKernelTransport();
    const store = new UiExternalStore(transport);
    const unsubscribe = store.subscribe(() => undefined);
    await store.refresh();
    const base = generated();
    for (const [revision, project] of [
      [10, "project:a"],
      [11, "project:b"],
      [12, "project:a"],
    ] as const) {
      const next = structuredClone(base);
      (next as { snapshot_revision: number }).snapshot_revision = revision;
      const mutableProject = next.project as {
        project_id: string;
        display_label: string;
        display_path: string;
      };
      mutableProject.project_id = project;
      mutableProject.display_label = project;
      mutableProject.display_path = `/tmp/${project}`;
      (next.context as { project_id: string }).project_id = project;
      transport.publish(next);
      await store.refresh();
      const state = store.getSnapshot();
      expect(state.status).toBe("ready");
      if (state.status === "ready") expect(state.snapshot.project.project_id).toBe(project);
    }
    const final = store.getSnapshot();
    if (final.status !== "ready") throw new Error("final snapshot is unavailable");
    expect(final.snapshot.snapshot_revision).toBe(12);
    unsubscribe();
  });

  it("uses Tauri snapshot and event APIs behind the same interface", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const handlers = new Map<string, () => void>();
    const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args == null ? { command } : { command, args });
      return (command.startsWith("surface_") ? generatedSurfaces() : generated()) as T;
    };
    const transport = createTauriUiKernelTransport(invoke, async (event, handler) => {
      handlers.set(event, () => handler({ payload: undefined as never }));
      return () => handlers.delete(event);
    });
    await transport.loadSnapshot();
    await transport.setSelection({
      project_id: "project:fixture",
      expected_project_revision: 7,
      expected_snapshot_revision: 9,
      selection: null,
    });
    const open: OpenSurfaceRequest = {
      surface_id: "rho.surface-playground",
      project_id: "project:fixture",
      mode_id: "notes",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: {},
      instance_disposition: "new_instance",
      placement_intent: "current",
      expected_project_revision: 7,
      expected_layout_revision: 0,
    };
    const target: SurfaceInstanceRequest = {
      project_id: "project:fixture",
      instance_id: "instance:playground-a",
      activation_generation: 1,
      expected_project_revision: 7,
      expected_surface_revision: 1,
    };
    await transport.loadSurfaces();
    await transport.openSurface(open);
    await transport.updateSurface({
      target,
      mutation: { kind: "set_view_state", view_state: { draft: "changed" } },
    });
    await transport.closeSurface(target);
    await transport.suspendSurface(target);
    await transport.resumeSurface(target);
    const invalidated = vi.fn();
    const stop = transport.subscribeInvalidated(invalidated);
    await Promise.resolve();
    handlers.get("rho://ui-snapshot-invalidated")?.();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { command: "ui_kernel_snapshot" },
      {
        command: "ui_set_selection",
        args: {
          request: {
            project_id: "project:fixture",
            expected_project_revision: 7,
            expected_snapshot_revision: 9,
            selection: null,
          },
        },
      },
      { command: "surface_list" },
      { command: "surface_open", args: { request: open } },
      {
        command: "surface_update",
        args: {
          request: {
            target,
            mutation: { kind: "set_view_state", view_state: { draft: "changed" } },
          },
        },
      },
      { command: "surface_close", args: { request: target } },
      { command: "surface_suspend", args: { request: target } },
      { command: "surface_resume", args: { request: target } },
    ]);
    stop();
  });

  it("keeps the mock Surface command lane in lockstep with instance semantics", async () => {
    const transport = createMockUiKernelTransport();
    const store = new SurfaceExternalStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("Surface fixture did not load");
    const initial = state.snapshot.catalog.instances.length;
    const request: OpenSurfaceRequest = {
      surface_id: "rho.surface-playground",
      project_id: state.snapshot.project_id,
      mode_id: "notes",
      resource_binding: null,
      runtime_binding: null,
      view_group_id: null,
      view_state: { fixture: true },
      instance_disposition: "new_instance",
      placement_intent: "beside",
      expected_project_revision: state.snapshot.project_revision,
      expected_layout_revision: 0,
    };
    const opened = await store.open(request);
    expect(opened.catalog.instances).toHaveLength(initial + 1);
    const second = await store.open(request);
    expect(second.catalog.instances).toHaveLength(initial + 2);
    const reuse = await store.open({ ...request, instance_disposition: "reuse_exact" });
    expect(reuse.snapshot_revision).toBe(second.snapshot_revision);
    const created = reuse.catalog.instances.find(
      (instance) => instance.instance_id === "surface-instance:mock-1",
    );
    if (created == null) throw new Error("mock host did not allocate an instance ID");
    const closed = await store.close({
      project_id: reuse.project_id,
      instance_id: created.instance_id,
      activation_generation: created.activation_generation,
      expected_project_revision: reuse.project_revision,
      expected_surface_revision: created.surface_revision,
    });
    expect(closed.catalog.instances).toHaveLength(initial + 1);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    stop();
  });
});
