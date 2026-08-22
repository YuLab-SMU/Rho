import { describe, expect, it, vi } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { createMockUiKernelTransport } from "./mock";
import { RuntimeExternalStore, StudioExternalStore, SurfaceExternalStore, UiExternalStore } from "./store";
import { createTauriUiKernelTransport } from "./tauri";
import type {
  OpenSurfaceRequest,
  RuntimeRegistrySnapshot,
  SurfaceInstanceRequest,
  SurfaceRuntimeSnapshot,
  StudioRuntimeSnapshot,
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

function generatedStudio(): StudioRuntimeSnapshot {
  return structuredClone(
    fixture.studio_runtime_snapshot,
  ) as unknown as StudioRuntimeSnapshot;
}

function generatedRuntimes(): RuntimeRegistrySnapshot {
  return structuredClone(
    fixture.runtime_registry_snapshot,
  ) as unknown as RuntimeRegistrySnapshot;
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
      return (command.startsWith("runtime_")
        ? command === "runtime_attach" || command === "runtime_detach"
          ? generatedSurfaces()
          : command === "runtime_execute"
            ? {
                execution_id: "runtime-execution:test",
                runtime_instance_id: "runtime:workspace-r",
                runtime_activation_generation: 1,
                console_instance_id: "instance:console-a",
                state_revision_after: 13,
                status: "completed",
                events: [],
              }
            : generatedRuntimes()
        : command.startsWith("surface_")
        ? generatedSurfaces()
        : command.startsWith("studio_")
          ? generatedStudio()
          : generated()) as T;
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
      expected_layout_revision: 1,
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
    const studioRequest = {
      project_id: "project:fixture",
      expected_project_revision: 7,
      expected_layout_revision: 1,
    } as const;
    await transport.loadStudio();
    await transport.applyStudio({
      ...studioRequest,
      edit: { kind: "set_focus", instance_id: "instance:file-source" },
    });
    await transport.undoStudio(studioRequest);
    await transport.redoStudio(studioRequest);
    const runtimeTarget = {
      project_id: "project:fixture",
      runtime_provider_id: "rho.ark-r",
      runtime_instance_id: "runtime:workspace-r",
      activation_generation: 1,
      expected_project_revision: 7,
      expected_state_revision: 12,
    } as const;
    const attachment = { runtime: runtimeTarget, surface: target } as const;
    const createRuntime = {
      project_id: "project:fixture",
      runtime_provider_id: "rho.ark-r",
      expected_project_revision: 7,
      expected_snapshot_revision: 4,
      display_label: null,
    } as const;
    await transport.loadRuntimes();
    await transport.createRuntime(createRuntime);
    await transport.attachRuntime(attachment);
    await transport.detachRuntime({ surface: target });
    await transport.interruptRuntime(runtimeTarget);
    await transport.restartRuntime(runtimeTarget);
    await transport.stopRuntime(runtimeTarget);
    await transport.executeRuntime({
      runtime: runtimeTarget,
      console_instance_id: "instance:console-a",
      expected_console_revision: 1,
      code: "1 + 1",
    });
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
      { command: "studio_scene" },
      {
        command: "studio_apply",
        args: {
          request: {
            ...studioRequest,
            edit: { kind: "set_focus", instance_id: "instance:file-source" },
          },
        },
      },
      { command: "studio_undo", args: { request: studioRequest } },
      { command: "studio_redo", args: { request: studioRequest } },
      { command: "runtime_list" },
      { command: "runtime_create", args: { request: createRuntime } },
      { command: "runtime_attach", args: { request: attachment } },
      { command: "runtime_detach", args: { request: { surface: target } } },
      { command: "runtime_interrupt", args: { request: runtimeTarget } },
      { command: "runtime_restart", args: { request: runtimeTarget } },
      { command: "runtime_stop", args: { request: runtimeTarget } },
      {
        command: "runtime_execute",
        args: {
          request: {
            runtime: runtimeTarget,
            console_instance_id: "instance:console-a",
            expected_console_revision: 1,
            code: "1 + 1",
          },
        },
      },
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
      expected_layout_revision: (await transport.loadStudio()).scene.layout_revision,
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

  it("keeps Studio edits stale-safe, undoable, and reconciled with Surface availability", async () => {
    const transport = createMockUiKernelTransport();
    const store = new StudioExternalStore(transport);
    const stop = store.subscribe(() => undefined);
    await store.refresh();
    const state = store.getSnapshot();
    if (state.status !== "ready") throw new Error("Studio fixture did not load");
    const initial = state.snapshot;
    const placed = await store.apply({
      project_id: initial.project_id,
      expected_project_revision: initial.project_revision,
      expected_layout_revision: initial.scene.layout_revision,
      edit: {
        kind: "insert_surface",
        target_container_node_id: initial.scene.root.node_id,
        child_index: initial.scene.root.kind === "container" ? initial.scene.root.children.length : 0,
        instance_id: "instance:playground-a",
        basis: { kind: "fraction", weight: 1 },
      },
    });
    expect(placed.unplaced_instance_ids).not.toContain("instance:playground-a");
    expect(placed.can_undo).toBe(true);
    await expect(store.apply({
      project_id: initial.project_id,
      expected_project_revision: initial.project_revision,
      expected_layout_revision: initial.scene.layout_revision,
      edit: { kind: "normalize" },
    })).rejects.toThrow(/stale/i);
    const undone = await store.undo({
      project_id: placed.project_id,
      expected_project_revision: placed.project_revision,
      expected_layout_revision: placed.scene.layout_revision,
    });
    expect(undone.unplaced_instance_ids).toContain("instance:playground-a");
    expect(undone.scene.layout_revision).toBeGreaterThan(placed.scene.layout_revision);
    stop();
  });

  it("supports shared and split runtimes without coupling Console or layout lifetime", async () => {
    const transport = createMockUiKernelTransport();
    const runtimeStore = new RuntimeExternalStore(transport);
    const stop = runtimeStore.subscribe(() => undefined);
    await runtimeStore.refresh();
    let runtimeState = runtimeStore.getSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime fixture did not load");
    const workspace = runtimeState.snapshot.instances[0]!;
    const runtimeTarget = (runtime = workspace) => ({
      project_id: runtime.project_id,
      runtime_provider_id: runtime.runtime_provider_id,
      runtime_instance_id: runtime.runtime_instance_id,
      activation_generation: runtime.activation_generation,
      expected_project_revision: runtimeState.status === "ready"
        ? runtimeState.snapshot.project_revision
        : 0,
      expected_state_revision: runtime.state_revision,
    });
    let surfaces = await transport.loadSurfaces();
    const consoleA = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === "instance:console-a"
    )!;
    const consoleB = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === "instance:console-b"
    )!;
    const first = await runtimeStore.execute({
      runtime: runtimeTarget(),
      console_instance_id: consoleA.instance_id,
      expected_console_revision: consoleA.surface_revision,
      code: "1 + 1",
    });
    expect(first.events[0]).toMatchObject({
      runtime_instance_id: workspace.runtime_instance_id,
      console_instance_id: consoleA.instance_id,
    });
    await runtimeStore.refresh();
    runtimeState = runtimeStore.getSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime refresh failed");
    const currentWorkspace = runtimeState.snapshot.instances[0]!;
    const second = await runtimeStore.execute({
      runtime: runtimeTarget(currentWorkspace),
      console_instance_id: consoleB.instance_id,
      expected_console_revision: consoleB.surface_revision,
      code: "2 + 2",
    });
    expect(second.console_instance_id).toBe(consoleB.instance_id);
    await runtimeStore.refresh();
    runtimeState = runtimeStore.getSnapshot();
    if (runtimeState.status !== "ready") throw new Error("Runtime refresh failed");
    await transport.closeSurface({
      project_id: consoleA.project_id,
      instance_id: consoleA.instance_id,
      activation_generation: consoleA.activation_generation,
      expected_project_revision: surfaces.project_revision,
      expected_surface_revision: consoleA.surface_revision,
    });
    expect((await transport.loadRuntimes()).instances.some((runtime) =>
      runtime.runtime_instance_id === workspace.runtime_instance_id
    )).toBe(true);

    const created = await runtimeStore.create({
      project_id: runtimeState.snapshot.project_id,
      runtime_provider_id: "rho.ark-r",
      expected_project_revision: runtimeState.snapshot.project_revision,
      expected_snapshot_revision: runtimeState.snapshot.snapshot_revision,
      display_label: "Split R",
    });
    const auxiliary = created.instances.find((runtime) => !runtime.primary_scientific_runtime)!;
    surfaces = await transport.loadSurfaces();
    const latestConsoleB = surfaces.catalog.instances.find((surface) =>
      surface.instance_id === consoleB.instance_id
    )!;
    await runtimeStore.attach({
      runtime: {
        project_id: auxiliary.project_id,
        runtime_provider_id: auxiliary.runtime_provider_id,
        runtime_instance_id: auxiliary.runtime_instance_id,
        activation_generation: auxiliary.activation_generation,
        expected_project_revision: created.project_revision,
        expected_state_revision: auxiliary.state_revision,
      },
      surface: {
        project_id: latestConsoleB.project_id,
        instance_id: latestConsoleB.instance_id,
        activation_generation: latestConsoleB.activation_generation,
        expected_project_revision: surfaces.project_revision,
        expected_surface_revision: latestConsoleB.surface_revision,
      },
    });
    const restarted = await runtimeStore.restart({
      project_id: auxiliary.project_id,
      runtime_provider_id: auxiliary.runtime_provider_id,
      runtime_instance_id: auxiliary.runtime_instance_id,
      activation_generation: auxiliary.activation_generation,
      expected_project_revision: created.project_revision,
      expected_state_revision: auxiliary.state_revision,
    });
    const restartedAux = restarted.instances.find((runtime) =>
      runtime.runtime_instance_id === auxiliary.runtime_instance_id
    )!;
    expect(restartedAux.activation_generation).toBe(auxiliary.activation_generation + 1);
    const rebound = (await transport.loadSurfaces()).catalog.instances.find((surface) =>
      surface.instance_id === consoleB.instance_id
    )!;
    expect(rebound.runtime_binding?.activation_generation).toBe(
      restartedAux.activation_generation,
    );
    const sceneBeforeStop = await transport.loadStudio();
    await runtimeStore.stop({
      project_id: restartedAux.project_id,
      runtime_provider_id: restartedAux.runtime_provider_id,
      runtime_instance_id: restartedAux.runtime_instance_id,
      activation_generation: restartedAux.activation_generation,
      expected_project_revision: restarted.project_revision,
      expected_state_revision: restartedAux.state_revision,
    });
    expect((await transport.loadSurfaces()).catalog.instances).toContainEqual(rebound);
    expect((await transport.loadStudio()).scene).toEqual(sceneBeforeStop.scene);
    stop();
  });
});
