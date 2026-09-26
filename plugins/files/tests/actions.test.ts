import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { FilesActions } from "../src/actions.js";
import type { JsonValue, PluginViewRecord } from "../public/plugin-protocol/index.js";

const requestId = (view: string, request: string) => `sha256:${createHash("sha256").update(`${view}:${request}`).digest("hex")}`;
const source = { instance: "files-one", plugin: "files", revision: "files-revision", artifact: "files-artifact" };
const editor = { instance: "editor-one", plugin: "editor", revision: "editor-revision", artifact: "editor-artifact" };
const selected = "分析.R";
const file = { path: selected, kind: "regular", sha256: "original-hash", byte_size: 42, mode: 420, modified_at_ns: "123" };
function fixture(saved: JsonValue = null) {
  const view: PluginViewRecord = { view: "files-view", instance: source,
    project: "project", principal: "principal", window: "window", contribution: "files", configuration: {}, state: {}, state_version: 0, closed: false };
  const persisted: JsonValue[] = [];
  const read = vi.fn(async () => ({ status: "ready", data: { root: "/project", files: [structuredClone(file)] } }));
  const owner = { source, nativeRoot: "/project", read, actionState: saved,
    saveActions: vi.fn(async (value: JsonValue) => { persisted.push(structuredClone(value)); }) };
  const invoke = vi.fn(async (capability, args, options) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: view.view }, operation_id: "original-operation", client_request_id: requestId(view.view, options.requestId), capability, normalized_arguments: structuredClone(args) } }));
  const query = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ status: "ready", data: { project: view.project, principal: view.principal, window: view.window,
    version: 7, layout: { kind: "tabs", id: "editor-group", views: [view.view], selected: view.view } } }));
  const client = { get view() { return structuredClone(view); }, invoke, query };
  const actions = new FilesActions(client, owner as never, "editor-group", editor);
  return { view, owner, client, actions, invoke, query, persisted };
}
it("captures native file identity and exact provider before opening the configured Editor", async () => {
  const f = fixture(); await f.actions.openDocument(selected);
  expect(f.owner.read).toHaveBeenCalledWith("files.snapshot", { paths: [selected], limit: 1 });
  expect(f.invoke).toHaveBeenCalledWith({ id: "windows.open_view", version: 1 }, {
    view: { instance: editor, contribution: "editor", window: "window", configuration: { source, file }, state: {} },
    expected_layout_version: 7, group: "editor-group",
  }, { requestId: expect.any(String) });
  expect(f.persisted[0]).toMatchObject({ pending: { request: f.invoke.mock.calls[0][2].requestId }, receipt: null });
  expect(f.owner.saveActions.mock.invocationCallOrder[0]).toBeLessThan(f.invoke.mock.invocationCallOrder[0]);
});
it("changing a file during layout observation cannot replace the captured identity", async () => {
  const f = fixture(); const layout = await f.query(); let finish!: (value: unknown) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const opening = f.actions.openDocument(selected); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.owner.read.mockResolvedValue({ status: "ready", data: { root: "/project", files: [{ ...file, sha256: "later-hash" }] } });
  finish(layout); await opening; expect(f.invoke.mock.calls[0][1].view.configuration.file.sha256).toBe("original-hash");
});
it("new documents have no existing file and navigation never creates a native file", async () => {
  const f = fixture(); await f.actions.openDocument(null); expect(f.owner.read).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls[0][1].view.configuration).toEqual({ source, file: null });
});
it("invalid paths, missing files, wrong roots and directories cannot be opened", async () => {
  for (const invalid of ["../other", "/absolute", "", "dir/../file", "dir\\file"]) {
    const f = fixture(); await expect(f.actions.openDocument(invalid)).rejects.toThrow("inside the project"); expect(f.owner.read).not.toHaveBeenCalled();
  }
  for (const observation of [
    { root: "/other", files: [file] }, { root: "/project", files: [] },
    { root: "/project", files: [{ ...file, kind: "directory" }] },
  ]) {
    const f = fixture(); f.owner.read.mockResolvedValue({ status: "ready", data: observation });
    await expect(f.actions.openDocument(selected)).rejects.toThrow(); expect(f.query).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
  }
});
it("missing providers and destination groups are explicit failures; null selects the containing group", async () => {
  const f = fixture(); const missing = new FilesActions(f.client, f.owner as never, "editor-group", null);
  await expect(missing.openDocument(selected)).rejects.toThrow("Editor provider"); expect(f.query).not.toHaveBeenCalled();
  const deleted = new FilesActions(f.client, f.owner as never, "deleted", editor);
  await expect(deleted.openDocument(selected)).rejects.toThrow("destination tab group"); expect(f.invoke).not.toHaveBeenCalled();
  const own = new FilesActions(f.client, f.owner as never, null, editor); await own.openDocument(selected);
  expect(f.invoke.mock.calls[0][1].group).toBe("editor-group");
});
it("failed capture prevents submission and lost acknowledgement keeps the original request", async () => {
  const f = fixture(); f.owner.saveActions.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(f.actions.openDocument(selected)).rejects.toThrow("storage unavailable"); expect(f.invoke).not.toHaveBeenCalled();
  f.invoke.mockRejectedValueOnce(new Error("lost reply")); await expect(f.actions.retry()).rejects.toThrow("lost reply");
  const original = structuredClone(f.invoke.mock.calls[0]); f.owner.read.mockResolvedValue({ status: "ready", data: { root: "/project", files: [{ ...file, sha256: "later" }] } });
  await expect(f.actions.openDocument(selected)).rejects.toThrow("unconfirmed"); await f.actions.retry();
  expect(f.invoke.mock.calls[1]).toEqual(original);
});
it("a copied pending request can find its original Operation but cannot open another view", async () => {
  const original = fixture(); original.invoke.mockRejectedValueOnce(new Error("lost")); await expect(original.actions.openDocument(selected)).rejects.toThrow("lost");
  const saved = original.persisted[0] as any, f = fixture(saved); f.view.view = "reopened";
  await expect(f.actions.retry()).rejects.toThrow("another view"); expect(f.invoke).not.toHaveBeenCalled();
  f.query.mockResolvedValueOnce({ status: "ready", data: { operations: [{ operation_id: "original-operation" }] } });
  f.query.mockResolvedValueOnce({ status: "ready", data: { record: { status: "succeeded", outcome: "succeeded", operation: {
    caller: { kind: "plugin", id: saved.pending.view }, operation_id: "original-operation", client_request_id: requestId(saved.pending.view, saved.pending.request),
    capability: { id: "windows.open_view", version: 1 }, normalized_arguments: saved.pending.arguments,
  } } } });
  await f.actions.inspectPending(); expect(f.actions.getSnapshot()).toMatchObject({ pending: null, receipt: { view: "files-view", id: "original-operation" } });
  expect(f.invoke).not.toHaveBeenCalled();
});
it("foreign acknowledgements leave the original navigation unconfirmed", async () => {
  const f = fixture(); f.invoke.mockImplementationOnce(async (capability, args) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: "other-view" }, operation_id: "other", client_request_id: "other", capability, normalized_arguments: args } }));
  await expect(f.actions.openDocument(selected)).rejects.toThrow("original Files action");
  expect(f.actions.getSnapshot().pending).not.toBeNull(); expect(f.actions.getSnapshot().receipt).toBeNull();
});

it("passes large-file metadata to the Editor without imposing its editing policy", async () => {
  const f = fixture(); f.owner.read.mockResolvedValue({ status: "ready", data: { root: "/project", files: [{ ...file, byte_size: 512 * 1024 + 1 }] } });
  await f.actions.openDocument(selected); expect(f.invoke.mock.calls[0][1].view.configuration.file.byte_size).toBe(512 * 1024 + 1);
});
