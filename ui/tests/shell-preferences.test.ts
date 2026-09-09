import { expect, it, vi } from "vitest";
import { Preferences } from "../src/application-state";
import type { ApplicationState } from "../src/generated/ApplicationState";

it("retains individually selected metrics and sidebar mode through reload and unrelated editor changes", async () => {
  let state: ApplicationState = { key: "preferences", version: "v1", value: { editorFontSize: 16, indentWidth: 2 } };
  const port = { readState: vi.fn(async () => structuredClone(state)), writeState: vi.fn(async (_project, next: ApplicationState) => {
    expect(next.version).toBe(state.version); state = { ...structuredClone(next), version: `${state.version}x` }; return structuredClone(state);
  }) };
  const owner = new Preferences(port); await owner.restore();
  expect(owner.getSnapshot()).toMatchObject({ sidebarExpanded: false, statusCpu: false, statusMemory: false, statusDisk: false });
  await Promise.all([owner.setPreferences({ statusCpu: true }), owner.setPreferences({ statusDisk: true }), owner.setPreferences({ sidebarExpanded: true })]);
  await owner.setPreferences({ editorFontSize: 18 });
  const reloaded = new Preferences(port); await reloaded.restore();
  expect(reloaded.getSnapshot()).toEqual({ editorFontSize: 18, indentWidth: 2, sidebarExpanded: true, statusCpu: true, statusMemory: false, statusDisk: true });
  port.writeState.mockRejectedValueOnce(new Error("disk full")); await expect(reloaded.setPreferences({ statusCpu: false })).rejects.toThrow("disk full");
  expect(reloaded.getSnapshot().statusCpu).toBe(true);
  await reloaded.setPreferences({ statusCpu: false }); expect(reloaded.getSnapshot().statusCpu).toBe(false);
  await owner.setPreferences({ statusMemory: true });
  expect(owner.getSnapshot()).toMatchObject({ statusCpu: false, statusMemory: true, statusDisk: true });
  owner.stop(); reloaded.stop();
});
