import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PlotsActions } from "../src/actions.js";
import type { JsonValue, PluginViewRecord } from "../public/plugin-protocol/index.js";
import type { MediaReference } from "../public/r-protocol/index.js";
const requestId = (view: string, request: string) => `sha256:${createHash("sha256").update(`${view}:${request}`).digest("hex")}`;
const source = { instance: "r-one", plugin: "r", revision: "r-revision", artifact: "r-artifact" };
const selected = { operation_id: "original-run", sequence: 1, mime_type: "image/png", byte_size: 20, sha256: "sha256:"+"a".repeat(64), display_id: null } as MediaReference;
const originalPlot = { operation: "original-run", reference: { resource: "original-image" } };
function fixture(saved: JsonValue = null) {
  const view: PluginViewRecord = { view: "plots-one", instance: { instance: "plots", plugin: "plots", revision: "revision", artifact: "artifact" },
    project: "project", principal: "principal", window: "window", contribution: "plots", configuration: {}, state: {}, state_version: 0, closed: false };
  const persisted: JsonValue[] = [];
  const owner = { source, history: { find: vi.fn(() => structuredClone(originalPlot) as typeof originalPlot | undefined) }, actionState: saved,
    saveActions: vi.fn(async (value: JsonValue) => { persisted.push(structuredClone(value)); }) };
  const invoke = vi.fn(async (capability, args, options) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: view.view }, operation_id: "original-operation", client_request_id: requestId(view.view, options.requestId), capability, normalized_arguments: structuredClone(args) } }));
  const query = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ status: "ready", data: { project: view.project, principal: view.principal, window: view.window,
    version: 7, layout: { kind: "tabs", id: "help-group", views: [view.view], selected: view.view } } }));
  const client = { get view() { return structuredClone(view); }, invoke, query };
  const actions = new PlotsActions(client, owner as never, "help-group");
  return { view, owner, client, actions, invoke, query, persisted };
}
it("captures the original plot and opens a pinned view of the same exact UI/R providers", async () => {
  const f = fixture(); await f.actions.openComparison(selected);
  expect(f.invoke).toHaveBeenCalledWith({ id: "windows.open_view", version: 1 }, {
    view: { instance: f.view.instance, contribution: "plots", window: "window", configuration: { source,
      selection: { operation_id: "original-run", resource_id: "original-image" }, pinned: true, plot_group: "help-group" }, state: {} },
    expected_layout_version: 7, group: "help-group",
  }, { requestId: expect.any(String) });
  expect(f.persisted[0]).toMatchObject({ pending: { request: f.invoke.mock.calls[0][2].requestId }, receipt: null });
  expect(f.owner.saveActions.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
});
it("rejects an unobserved plot and preserves the captured selection during concurrent history changes", async () => {
  const missing = fixture(); missing.owner.history.find.mockReturnValue(undefined);
  await expect(missing.actions.openComparison(selected)).rejects.toThrow("observed original plot"); expect(missing.query).not.toHaveBeenCalled();
  const f = fixture(), layout = await f.query(); let finish!: (value: unknown) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.actions.openComparison(selected); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.owner.history.find.mockReturnValue(undefined); finish(layout); await opening;
  expect(f.invoke.mock.calls[0][1].view.configuration.selection).toEqual({ operation_id: "original-run", resource_id: "original-image" });
});
it("failed capture prevents submission and lost acknowledgement keeps the original request", async () => {
  const f = fixture(); f.owner.saveActions.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(f.actions.openComparison(selected)).rejects.toThrow("storage unavailable"); expect(f.invoke).not.toHaveBeenCalled();
  f.invoke.mockRejectedValueOnce(new Error("lost reply")); await expect(f.actions.retry()).rejects.toThrow("lost reply");
  const original = structuredClone(f.invoke.mock.calls[0]); f.owner.history.find.mockReturnValue(undefined);
  await expect(f.actions.openComparison(selected)).rejects.toThrow("unconfirmed"); await f.actions.retry();
  expect(f.invoke.mock.calls[1]).toEqual(original);
});
it("a copied pending request can find its original Operation but cannot open another view", async () => {
  const original = fixture(); original.invoke.mockRejectedValueOnce(new Error("lost")); await expect(original.actions.openComparison(selected)).rejects.toThrow("lost");
  const saved = original.persisted[0] as any, f = fixture(saved); f.view.view = "reopened";
  await expect(f.actions.retry()).rejects.toThrow("another view"); expect(f.invoke).not.toHaveBeenCalled();
  f.query.mockResolvedValueOnce({ status: "ready", data: { operations: [{ operation_id: "original-operation" }] } });
  f.query.mockResolvedValueOnce({ status: "ready", data: { record: { status: "succeeded", outcome: "succeeded", operation: {
    caller: { kind: "plugin", id: saved.pending.view }, operation_id: "original-operation", client_request_id: requestId(saved.pending.view, saved.pending.request),
    capability: { id: "windows.open_view", version: 1 }, normalized_arguments: saved.pending.arguments,
  } } } });
  await f.actions.inspectPending(); expect(f.actions.getSnapshot()).toMatchObject({ pending: null, receipt: { view: "plots-one", id: "original-operation" } });
  expect(f.invoke).not.toHaveBeenCalled();
});
it("foreign acknowledgements leave the original navigation unconfirmed", async () => {
  const f = fixture(); f.invoke.mockImplementationOnce(async (capability, args) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: "other-view" }, operation_id: "other", client_request_id: "other", capability, normalized_arguments: args } }));
  await expect(f.actions.openComparison(selected)).rejects.toThrow("original Plots action");
  expect(f.actions.getSnapshot().pending).not.toBeNull(); expect(f.actions.getSnapshot().receipt).toBeNull();
});
