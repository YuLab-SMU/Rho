import { describe, expect, it, vi } from "vitest";

import {
  defaultToolbarLayout,
  loadToolbarLayout,
  normalizeToolbarLayout,
  reorderToolbarComponent,
  saveToolbarLayout,
  setToolbarComponentVisible,
  toolbarStorageKey,
} from "./toolbar-model";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

describe("toolbar preference model", () => {
  it("defaults to the fixed skeleton with every optional component ordered and hidden", () => {
    const layout = defaultToolbarLayout();
    expect(layout.order).toEqual([
      "project_context",
      "scene_selector",
      "command_search",
      "project_action",
      "runtime_status",
      "compose",
    ]);
    expect(layout.visible).toEqual([]);
  });

  it("toggles visibility and reorders without losing disabled components", () => {
    const visible = setToolbarComponentVisible(defaultToolbarLayout(), "compose", true);
    const reordered = reorderToolbarComponent(visible, "compose", "project_context", "before");
    expect(reordered.order[0]).toBe("compose");
    expect(reordered.visible).toEqual(["compose"]);
    expect(defaultToolbarLayout().visible).toEqual([]);
  });

  it("rejects duplicate, unknown, incomplete, and unsupported payloads", () => {
    const complete = defaultToolbarLayout();
    expect(normalizeToolbarLayout({ ...complete, order: [...complete.order, "compose"] })).toBeNull();
    expect(normalizeToolbarLayout({ ...complete, order: complete.order.slice(1) })).toBeNull();
    expect(normalizeToolbarLayout({ ...complete, visible: ["unknown"] })).toBeNull();
    expect(normalizeToolbarLayout({ ...complete, version: 2 })).toBeNull();
  });

  it("recovers malformed, unsupported, and oversized stored values to the minimal default", () => {
    const target = storage();
    const key = toolbarStorageKey("project:a");
    for (const value of ["{", JSON.stringify({ version: 2 }), "x".repeat(2_049)]) {
      target.values.set(key, value);
      const loaded = loadToolbarLayout(target, "project:a");
      expect(loaded.status).toBe("recovered");
      expect(loaded.layout).toEqual(defaultToolbarLayout());
    }
  });

  it("persists exact layouts under isolated project keys", () => {
    const target = storage();
    const first = setToolbarComponentVisible(defaultToolbarLayout(), "compose", true);
    const second = setToolbarComponentVisible(defaultToolbarLayout(), "runtime_status", true);
    saveToolbarLayout(target, "project:a", first);
    saveToolbarLayout(target, "project:b", second);
    expect(loadToolbarLayout(target, "project:a").layout.visible).toEqual(["compose"]);
    expect(loadToolbarLayout(target, "project:b").layout.visible).toEqual(["runtime_status"]);
    expect(target.setItem).toHaveBeenCalledTimes(2);
  });

  it("recovers read failures and surfaces write failures", () => {
    const unavailable = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(loadToolbarLayout(unavailable, "project:a").status).toBe("unavailable");
    expect(() => saveToolbarLayout(unavailable, "project:a", defaultToolbarLayout()))
      .toThrow("blocked");
  });
});
