import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PackagesActions } from "../src/actions.js";
import type { JsonValue, PluginViewRecord } from "../public/plugin-protocol/index.js";
import type { PackageEntry } from "../public/r-protocol/index.js";
const requestId = (view: string, request: string) => `sha256:${createHash("sha256").update(`${view}:${request}`).digest("hex")}`;
const source = { instance: "r-one", plugin: "r", revision: "r-revision", artifact: "r-artifact" };
const help = { instance: "help-one", plugin: "help", revision: "help-revision", artifact: "help-artifact" };
const selected = { name: "demo", version: "2.0", library_path: "/second lib" } as PackageEntry;
function fixture(saved: JsonValue = null) {
  const view: PluginViewRecord = { view: "packages-one", instance: { instance: "packages", plugin: "packages", revision: "revision", artifact: "artifact" },
    project: "project", principal: "principal", window: "window", contribution: "packages", configuration: {}, state: {}, state_version: 0, closed: false };
  const packages = { session: "native-one", data: { observation_id: "original-observation" }, expired: false,
    details: new Map([["demo", { copies: [{ ...selected, version: "1.0", library_path: "/first lib" }, selected] }]]) };
  const persisted: JsonValue[] = [];
  const owner = { source, nativeSession: "native-one" as string | null, packages, actionState: saved,
    saveActions: vi.fn(async (value: JsonValue) => { persisted.push(structuredClone(value)); }) };
  const invoke = vi.fn(async (capability, args, options) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: view.view }, operation_id: "original-operation", client_request_id: requestId(view.view, options.requestId), capability, normalized_arguments: structuredClone(args) } }));
  const query = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ status: "ready", data: { project: view.project, principal: view.principal, window: view.window,
    version: 7, layout: { kind: "tabs", id: "help-group", views: [view.view], selected: view.view } } }));
  const client = { get view() { return structuredClone(view); }, invoke, query };
  const actions = new PackagesActions(client, owner as never, "help-group", help);
  return { view, owner, client, actions, invoke, query, persisted };
}
it("captures the chosen installed copy and original observation before opening the configured Help instance", async () => {
  const f = fixture(); await f.actions.openDocumentation(selected);
  expect(f.invoke).toHaveBeenCalledWith({ id: "windows.open_view", version: 1 }, {
    view: { instance: help, contribution: "help", window: "window", configuration: { source, topic: null,
      copy: { nativeSession: "native-one", observation: "original-observation", package: "demo", libraryPath: "/second lib", version: "2.0" } }, state: {} },
    expected_layout_version: 7, group: "help-group",
  }, { requestId: expect.any(String) });
  expect(f.persisted[0]).toMatchObject({ pending: { request: f.invoke.mock.calls[0][2].requestId }, receipt: null });
  expect(f.persisted.at(-1)).toMatchObject({ pending: null, receipt: { id: "original-operation", status: "succeeded" } });
  expect(f.owner.saveActions.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
});
it("refreshing while layout is read cannot retarget the already selected copy", async () => {
  const f = fixture(); const layout = await f.query(); let finish!: (value: unknown) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.actions.openDocumentation(selected); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.owner.packages.data.observation_id = "new-observation"; f.owner.packages.details.clear(); finish(layout); await opening;
  expect(f.invoke.mock.calls[0][1].view.configuration.copy).toMatchObject({ observation: "original-observation", libraryPath: "/second lib", version: "2.0" });
});
it("unobserved copies, expired observations and another native session cannot open Help", async () => {
  for (const kind of ["copy", "expired", "session"]) {
    const f = fixture();
    if (kind === "copy") f.owner.packages.details.clear();
    if (kind === "expired") f.owner.packages.expired = true;
    if (kind === "session") f.owner.nativeSession = "other";
    await expect(f.actions.openDocumentation(selected)).rejects.toThrow("current Packages observation");
    expect(f.query).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
  }
});
it("missing providers and destination groups are explicit failures; null selects the containing group", async () => {
  const f = fixture(); const missing = new PackagesActions(f.client, f.owner as never, "help-group", null);
  await expect(missing.openDocumentation(selected)).rejects.toThrow("Help provider"); expect(f.query).not.toHaveBeenCalled();
  const deleted = new PackagesActions(f.client, f.owner as never, "deleted", help);
  await expect(deleted.openDocumentation(selected)).rejects.toThrow("destination tab group"); expect(f.invoke).not.toHaveBeenCalled();
  const own = new PackagesActions(f.client, f.owner as never, null, help); await own.openDocumentation(selected);
  expect(f.invoke.mock.calls[0][1].group).toBe("help-group");
});
it("failed capture prevents submission and lost acknowledgement keeps the original request", async () => {
  const f = fixture(); f.owner.saveActions.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(f.actions.openDocumentation(selected)).rejects.toThrow("storage unavailable"); expect(f.invoke).not.toHaveBeenCalled();
  f.invoke.mockRejectedValueOnce(new Error("lost reply")); await expect(f.actions.retry()).rejects.toThrow("lost reply");
  const original = structuredClone(f.invoke.mock.calls[0]); f.owner.packages.data.observation_id = "later";
  await expect(f.actions.openDocumentation(selected)).rejects.toThrow("unconfirmed"); await f.actions.retry();
  expect(f.invoke.mock.calls[1]).toEqual(original);
});
it("a copied pending request can find its original Operation but cannot open another view", async () => {
  const original = fixture(); original.invoke.mockRejectedValueOnce(new Error("lost")); await expect(original.actions.openDocumentation(selected)).rejects.toThrow("lost");
  const saved = original.persisted[0] as any, f = fixture(saved); f.view.view = "reopened";
  await expect(f.actions.retry()).rejects.toThrow("another view"); expect(f.invoke).not.toHaveBeenCalled();
  f.query.mockResolvedValueOnce({ status: "ready", data: { operations: [{ operation_id: "original-operation" }] } });
  f.query.mockResolvedValueOnce({ status: "ready", data: { record: { status: "succeeded", outcome: "succeeded", operation: {
    caller: { kind: "plugin", id: saved.pending.view }, operation_id: "original-operation", client_request_id: requestId(saved.pending.view, saved.pending.request),
    capability: { id: "windows.open_view", version: 1 }, normalized_arguments: saved.pending.arguments,
  } } } });
  await f.actions.inspectPending(); expect(f.actions.getSnapshot()).toMatchObject({ pending: null, receipt: { view: "packages-one", id: "original-operation" } });
  expect(f.invoke).not.toHaveBeenCalled();
});
it("foreign acknowledgements leave the original navigation unconfirmed", async () => {
  const f = fixture(); f.invoke.mockImplementationOnce(async (capability, args) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: "other-view" }, operation_id: "other", client_request_id: "other", capability, normalized_arguments: args } }));
  await expect(f.actions.openDocumentation(selected)).rejects.toThrow("original Packages action");
  expect(f.actions.getSnapshot().pending).not.toBeNull(); expect(f.actions.getSnapshot().receipt).toBeNull();
});
