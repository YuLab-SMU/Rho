import { describe, expect, it, vi } from "vitest";

import fixture from "../contracts/generated/rsr-contract-fixtures.json";
import { createMockUiKernelTransport } from "./mock";
import { UiExternalStore } from "./store";
import { createTauriUiKernelTransport } from "./tauri";
import type { UiKernelSnapshot } from "./types";

function generated(): UiKernelSnapshot {
  return structuredClone(fixture.kernel_snapshot) as unknown as UiKernelSnapshot;
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
      return generated() as T;
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
    ]);
    stop();
  });
});
