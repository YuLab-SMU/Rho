import { expect, it, vi } from "vitest";
import { PluginWindowState } from "../src/plugin-window-state";
import type { PluginWindowLayout, PluginWindowNode, UpdatePluginWindowLayout } from "../../sdk/plugin-protocol/index.js";
const empty: PluginWindowNode = { kind: "empty" };
const tabs: PluginWindowNode = { kind: "tabs", id: "main", views: ["first"], selected: "first" };
const initial: PluginWindowLayout = { window: "window", project: "project", principal: "principal", version: 0, layout: empty };
const result = (args: UpdatePluginWindowLayout): PluginWindowLayout => ({ ...initial, version: args.expected_version + 1, layout: args.layout });

it("coalesces edits while a save is pending and preserves a revert to the previous saved layout", async () => {
  let finish!: (value: PluginWindowLayout) => void;
  const write = vi.fn<(args: UpdatePluginWindowLayout, id: string) => Promise<PluginWindowLayout>>()
    .mockImplementationOnce(() => new Promise(done => finish = done)).mockImplementation(async args => result(args));
  const owner = new PluginWindowState("window", { read: async () => initial, write });
  await owner.load(); owner.change(tabs); const saving = owner.save(); await Promise.resolve();
  expect(owner.save()).toBe(saving); owner.change(empty); finish(result(write.mock.calls[0][0])); await saving;
  expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[1][0]).toEqual({ window: "window", expected_version: 1, layout: empty });
  expect(owner.getSnapshot()).toMatchObject({ dirty: false, saving: false, saved: { version: 2, layout: empty } });
});
it("a lost acknowledgement retains the original id and arguments before sending later edits", async () => {
  const write = vi.fn(async (args: UpdatePluginWindowLayout, _id: string) => result(args)).mockRejectedValueOnce(new Error("Connection lost"));
  const owner = new PluginWindowState("window", { read: async () => initial, write });
  await owner.load(); owner.change(tabs); await expect(owner.save()).rejects.toThrow("Connection lost");
  const original = structuredClone(write.mock.calls[0]); owner.change(empty);
  expect(owner.getSnapshot()).toMatchObject({ dirty: true, pendingRequest: original[1] });
  await owner.save(); expect(write.mock.calls[1]).toEqual(original);
  expect(write.mock.calls[2][1]).not.toBe(original[1]); expect(write.mock.calls[2][0]).toMatchObject({ expected_version: 1, layout: empty });
});
it("refuses mismatched scope and forged success without discarding local changes", async () => {
  const write = vi.fn(async (args: UpdatePluginWindowLayout, _id: string) => ({ ...result(args), principal: "someone-else" }));
  const owner = new PluginWindowState("window", { read: async () => initial, write });
  await owner.load(); owner.change(tabs); await expect(owner.save()).rejects.toThrow("different scope");
  expect(owner.getSnapshot()).toMatchObject({ dirty: true, saved: initial, layout: tabs });
  write.mockImplementation(async args => ({ ...result(args), version: 99 }));
  await expect(owner.save()).rejects.toThrow("original change");
  expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
});
it("normal reads cannot replace unsaved layout and explicit discard preserves it when reading fails", async () => {
  const read = vi.fn(async () => initial), write = vi.fn(async (args: UpdatePluginWindowLayout) => result(args));
  const owner = new PluginWindowState("window", { read, write }); await owner.load(); owner.change(tabs);
  await expect(owner.load()).rejects.toThrow("explicitly discard");
  read.mockRejectedValueOnce(new Error("Offline")); await expect(owner.discardAndReload()).rejects.toThrow("Offline");
  expect(owner.getSnapshot()).toMatchObject({ dirty: true, layout: tabs });
  await owner.discardAndReload(); expect(owner.getSnapshot()).toMatchObject({ dirty: false, layout: empty }); expect(write).not.toHaveBeenCalled();
});
it("late reads and writes from a stopped window cannot replace its last observation", async () => {
  let finish!: (value: PluginWindowLayout) => void;
  const owner = new PluginWindowState("window", { read: async () => initial, write: () => new Promise(done => finish = done) });
  await owner.load(); owner.change(tabs); const saving = owner.save(); await Promise.resolve();
  owner.stop(); finish({ ...initial, version: 1, layout: tabs }); await saving;
  expect(owner.getSnapshot().saved).toEqual(initial);
  await expect(owner.save()).rejects.toThrow("closed");
});
it("accepts equivalent Host JSON with sorted object keys without changing meaningful view order", async () => {
  const write = vi.fn(async (args: UpdatePluginWindowLayout) => JSON.parse(JSON.stringify(result(args), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) as PluginWindowLayout);
  const owner = new PluginWindowState("window", { read: async () => initial, write });
  await owner.load(); owner.change(tabs); await owner.save();
  expect(owner.getSnapshot().dirty).toBe(false); await owner.save(); expect(write).toHaveBeenCalledTimes(1);
});
it("keeps unchanged observations referentially stable and rejects unversioned or older replacements", async () => {
  const read=vi.fn(async()=>({...initial,version:2,layout:tabs}));
  const owner=new PluginWindowState('window',{read,write:async args=>result(args)});await owner.load();const snapshot=owner.getSnapshot();
  await owner.load();expect(owner.getSnapshot()).toBe(snapshot);
  read.mockResolvedValueOnce({...initial,version:2,layout:empty as typeof tabs});await expect(owner.load()).rejects.toThrow('without a new owner version');
  read.mockResolvedValueOnce({...initial,version:1,layout:tabs});await expect(owner.load()).rejects.toThrow('older');expect(owner.getSnapshot()).toBe(snapshot);
});
