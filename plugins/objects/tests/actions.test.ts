import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ObjectsActions } from "../src/actions";
import type { JsonValue, PluginViewRecord } from "../public/plugin-protocol/index.js";
const requestId = (view: string, request: string) => `sha256:${createHash("sha256").update(`${view}:${request}`).digest("hex")}`;
const source = { instance: "r-one", plugin: "r", revision: "r-revision", artifact: "r-artifact" };
function fixture(saved: JsonValue = null) {
  const view: PluginViewRecord = { view: "objects-one", instance: { instance: "objects", plugin: "objects", revision: "revision", artifact: "artifact" },
    project: "project", principal: "principal", window: "window", contribution: "objects", configuration: {}, state: {}, state_version: 0, closed: false };
  const persisted: JsonValue[] = [];
  const owner = { source, nativeSession: "native-one" as string | null, actionState: saved,
    saveActions: vi.fn(async (value: JsonValue) => { persisted.push(structuredClone(value)); }) };
  const invoke = vi.fn(async (capability, args, options) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: "objects-one" }, operation_id: "original-operation", client_request_id: requestId("objects-one", options.requestId), capability, normalized_arguments: structuredClone(args) } }));
  const query = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ status: "ready", completeness: "complete", data: { project: view.project, principal: view.principal, window: view.window,
    version: 7, layout: { kind: "tabs", id: "editor-group", views: [], selected: null } } }));
  const operation = vi.fn();
  const client = { get view() { return structuredClone(view); }, invoke, query, operation };
  const actions = new ObjectsActions(client, owner, "editor-group");
  return { view, owner, client, actions, invoke, query, operation, persisted };
}
it("opens the exact object path in the explicitly configured containing group", async () => {
  const f = fixture();
  await f.actions.openObject("分析 data", [{ kind: "name", name: "a'b" }, { kind: "index", index: 2 }]);
  expect(f.query).toHaveBeenCalledOnce();
  expect(f.invoke).toHaveBeenCalledWith({ id: "windows.open_view", version: 1 }, {
    view: { instance: f.view.instance, contribution: "object", window: "window",
      configuration: { source, object_group: "editor-group", object: { name: "分析 data", path: [{ kind: "name", name: "a'b" }, { kind: "index", index: 2 }] } },
      state: { nativeSession: "native-one" } }, expected_layout_version: 7, group: "editor-group",
  }, { requestId: expect.any(String) });
  expect(f.persisted[0]).toMatchObject({ pending: { capability: "windows.open_view", request: f.invoke.mock.calls[0][2].requestId }, receipt: null });
  expect(f.persisted.at(-1)).toMatchObject({ pending: null, receipt: { id: "original-operation", status: "succeeded" } });
});
it("does not navigate from an unavailable or foreign window observation", async () => {
  for (const patch of [{ status: "busy" }, { data: { project: "foreign", principal: "principal", window: "window", version: 7 } }]) {
    const f = fixture(); f.query.mockResolvedValueOnce({ ...(await f.query()), ...patch } as any);
    await expect(f.actions.openObject("x")).rejects.toThrow("unavailable");
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.owner.saveActions).not.toHaveBeenCalled();
  }
});
it("null navigation configuration resolves the view's own group without inferring panel names", async () => {
  const f = fixture(); const layout = await f.query(); layout.data.layout.views = [f.view.view];
  f.query.mockResolvedValueOnce(layout);
  const actions = new ObjectsActions(f.client, f.owner, null);
  await actions.openObject("x");
  expect(f.invoke.mock.calls[0][1].group).toBe("editor-group");
  expect(f.invoke.mock.calls[0][1].view.configuration.object_group).toBeNull();
});
it("a missing configured group is refused before retaining or submitting a navigation", async () => {
  const f = fixture(); const actions = new ObjectsActions(f.client, f.owner, "deleted-group");
  await expect(actions.openObject("x")).rejects.toThrow("destination tab group");
  expect(f.invoke).not.toHaveBeenCalled(); expect(f.owner.saveActions).not.toHaveBeenCalled();
});
it("requires captured state acknowledgement before any plot execution, including retries", async () => {
  const f = fixture(); f.owner.saveActions.mockRejectedValueOnce(new Error("state unavailable"));
  await expect(f.actions.run("print(plot)", "console")).rejects.toThrow("state unavailable");
  expect(f.invoke).not.toHaveBeenCalled();
  const request = f.actions.getSnapshot().pending!.request;
  await f.actions.retry();
  expect(f.invoke).toHaveBeenCalledWith({ id: "r.execute", version: 2 }, {
    preconditions: null, binding: { capability: { id: "r.execute", version: 2 }, provider: source, project: "project", target: "native-one" },
    arguments: { expected_session: "native-one", run: { code: "print(plot)", output_mode: "console", source: { view_id: "objects-one", label: "Objects", kind: "console" } } },
  }, { requestId: request });
});
it("lost acknowledgement retains the same request and original session despite later owner observations", async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("reply lost"));
  await expect(f.actions.run("print(plot)", "console")).rejects.toThrow("reply lost");
  const first = structuredClone(f.invoke.mock.calls[0]);
  f.owner.nativeSession = "later-session";
  await expect(f.actions.run("print(other)", "console")).rejects.toThrow("unconfirmed");
  await f.actions.retry(); expect(f.invoke.mock.calls[1]).toEqual(first);
  expect(f.actions.getSnapshot().pending).toBeNull();
});
it("copied pending state cannot replay work from another view or provider", async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("lost"));
  await expect(f.actions.run("print(plot)", "console")).rejects.toThrow();
  for (const change of ["view", "provider"]) {
    const saved = structuredClone(f.persisted[0]) as any;
    if (change === "view") saved.pending.view = "another-view";
    else saved.pending.arguments.binding.provider.instance = "another-provider";
    const copy = fixture(saved);
    await expect(copy.actions.retry()).rejects.toThrow(/another view|original provider/);
    expect(copy.invoke).not.toHaveBeenCalled(); expect(copy.owner.saveActions).not.toHaveBeenCalled();
  }
});
it("refuses foreign replies and retains the original pending identity for reconciliation", async () => {
  const f = fixture();
  f.invoke.mockImplementationOnce(async (capability, args, options) => ({ status: "succeeded", outcome: "succeeded", output: {},
    operation: { caller: { kind: "plugin", id: "objects-one" }, operation_id: "foreign", client_request_id: "not-original", capability, normalized_arguments: args } }));
  await expect(f.actions.openObject("x")).rejects.toThrow("original Objects action");
  expect(f.actions.getSnapshot().pending).not.toBeNull(); expect(f.actions.getSnapshot().receipt).toBeNull();
});
it("retains terminal failure as the original Operation instead of preparing another run", async () => {
  const f = fixture();
  f.invoke.mockImplementationOnce(async (capability, args, options) => ({ status: "failed", outcome: "failed", output: {}, error: "native failure",
    operation: { caller: { kind: "plugin", id: "objects-one" }, operation_id: "original-operation", client_request_id: requestId("objects-one", options.requestId), capability, normalized_arguments: args } }));
  await expect(f.actions.run("print(plot)", "console")).rejects.toThrow("native failure");
  expect(f.actions.getSnapshot()).toMatchObject({ pending: null, receipt: { id: "original-operation", status: "failed" } });
  f.query.mockResolvedValueOnce({ status: "ready", completeness: "complete", data: { record: { status: "failed", operation: { caller: { kind: "plugin", id: "objects-one" }, operation_id: "original-operation", client_request_id: requestId("objects-one", f.invoke.mock.calls[0][2].requestId), capability: { id: "r.execute", version: 2 } }, error: "native failure" } } });
  await f.actions.inspect(); expect(f.invoke).toHaveBeenCalledOnce();
});
it("serializes explicit actions and refuses execution without an existing session", async () => {
  const f = fixture(); f.owner.nativeSession = null;
  await expect(f.actions.run("print(plot)", "console")).rejects.toThrow("existing R session");
  expect(f.invoke).not.toHaveBeenCalled();
  let release!: () => void;
  f.owner.saveActions.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const opening = f.actions.openObject("x"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await expect(f.actions.openObject("y")).rejects.toThrow("current Objects action");
  release(); await opening; expect(f.invoke).toHaveBeenCalledOnce();
});
it("finds an original accepted request after reopening without sending it from the new view", async () => {
  const original = fixture(); original.invoke.mockRejectedValueOnce(new Error("lost"));
  await expect(original.actions.run("print(plot)", "console")).rejects.toThrow();
  const saved = structuredClone(original.persisted[0]) as any;
  const reopened = fixture(saved); reopened.view.view = "reopened-view";
  reopened.query.mockResolvedValueOnce({ status: "ready", completeness: "partial", data: { operations: [{ operation_id: "original-operation" }], next_cursor: null } });
  reopened.query.mockResolvedValueOnce({ status: "ready", completeness: "complete", data: { record: { status: "running", outcome: null,
    operation: { caller: { kind: "plugin", id: "objects-one" }, operation_id: "original-operation",
      client_request_id: requestId(saved.pending.view, saved.pending.request), capability: { id: "r.execute", version: 2 }, normalized_arguments: saved.pending.arguments } } } });
  await reopened.actions.inspectPending();
  expect(reopened.query).toHaveBeenCalledWith({ id: "operation.list_recent", version: 1 }, { client_request_id: requestId(saved.pending.view, saved.pending.request), limit: 10 });
  expect(reopened.invoke).not.toHaveBeenCalled();
  expect(reopened.actions.getSnapshot()).toMatchObject({ pending: null, receipt: { view: "objects-one", id: "original-operation", status: "running" } });
});
it("an absent original request remains unconfirmed and lookup never submits or clears it", async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("lost"));
  await expect(f.actions.openObject("x")).rejects.toThrow();
  const pending = structuredClone(f.actions.getSnapshot().pending);
  f.query.mockResolvedValueOnce({ status: "ready", completeness: "complete", data: { operations: [], next_cursor: null } });
  await expect(f.actions.inspectPending()).rejects.toThrow("remains unconfirmed");
  expect(f.actions.getSnapshot().pending).toEqual(pending); expect(f.invoke).toHaveBeenCalledOnce();
});
it("stopping during capture cannot submit work when the late save reply arrives", async () => {
  const f = fixture(); let finish!: () => void;
  f.owner.saveActions.mockImplementationOnce(() => new Promise<void>(resolve => finish = resolve));
  const running = f.actions.run("print(plot)", "console"); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.actions.stop(); finish(); await expect(running).rejects.toThrow("closed");
  expect(f.invoke).not.toHaveBeenCalled();
});

it("setting aside saves the exact unconfirmed request and permits only a distinct new action", async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("reply lost"));
  await expect(f.actions.run("print(original_plot)", "console")).rejects.toThrow("reply lost");
  const original = structuredClone(f.actions.getSnapshot().pending)!;
  await f.actions.setAside();
  expect(f.actions.getSnapshot()).toMatchObject({ pending: null, retained: [original], receipt: null });
  expect(f.persisted.at(-1)).toMatchObject({ pending: null, retained: [original] });
  expect(f.invoke).toHaveBeenCalledOnce();
  await f.actions.run("print(new_plot)", "console");
  expect(f.invoke.mock.calls[1][2].requestId).not.toBe(original.request);
  expect(f.actions.getSnapshot().retained).toEqual([original]);
  const reopened = fixture(f.persisted.at(-1)!); reopened.view.view = "replacement-view";
  reopened.query.mockResolvedValueOnce({ status: "ready", completeness: "partial", data: { operations: [], next_cursor: null } });
  await expect(reopened.actions.inspectRetained(original.view, original.request)).rejects.toThrow("remains unconfirmed");
  expect(reopened.actions.getSnapshot().retained).toEqual([original]);
  reopened.query.mockResolvedValueOnce({ status: "ready", completeness: "partial", data: { operations: [{ operation_id: "original-operation" }], next_cursor: null } });
  reopened.query.mockResolvedValueOnce({ status: "ready", completeness: "complete", data: { record: { status: "running", outcome: null,
    operation: { caller: { kind: "plugin", id: original.view }, operation_id: "original-operation", client_request_id: requestId(original.view, original.request),
      capability: { id: original.capability, version: original.version }, normalized_arguments: original.arguments } } } });
  await reopened.actions.inspectRetained(original.view, original.request);
  expect(reopened.invoke).not.toHaveBeenCalled();
  expect(reopened.actions.getSnapshot()).toMatchObject({ pending: null, retained: [], receipt: { view: original.view, request: original.request, id: "original-operation", status: "running" } });
});

it("failed retention acknowledgement keeps the pending request and blocks new actions", async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("lost"));
  await expect(f.actions.run("print(plot)", "console")).rejects.toThrow();
  const original = structuredClone(f.actions.getSnapshot().pending);
  f.owner.saveActions.mockRejectedValueOnce(new Error("saved state unconfirmed"));
  await expect(f.actions.setAside()).rejects.toThrow("saved state unconfirmed");
  expect(f.actions.getSnapshot()).toMatchObject({ pending: original, retained: [] });
  await expect(f.actions.run("print(another)", "console")).rejects.toThrow("unconfirmed");
  expect(f.invoke).toHaveBeenCalledOnce();
  await f.actions.setAside();
  expect(f.actions.getSnapshot()).toMatchObject({ pending: null, retained: [original] });
});

it("retained recovery refuses partial records, foreign and unsaved results without changing another pending request", async () => {
  const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("lost"));
  await expect(f.actions.run("print(old)", "console")).rejects.toThrow();
  const original = structuredClone(f.actions.getSnapshot().pending)!; await f.actions.setAside();
  f.invoke.mockRejectedValueOnce(new Error("new reply lost"));
  await expect(f.actions.run("print(new)", "console")).rejects.toThrow();
  const next = structuredClone(f.actions.getSnapshot().pending);
  await expect(f.actions.inspectRetained("foreign", original.request)).rejects.toThrow("Select one retained");
  expect(f.query).not.toHaveBeenCalled();
  f.query.mockResolvedValueOnce({ status: "ready", completeness: "cached", data: { operations: [{ operation_id: "original-operation" }], next_cursor: null } });
  await expect(f.actions.inspectRetained(original.view, original.request)).rejects.toThrow("unavailable");
  const page = { status: "ready", completeness: "partial", data: { operations: [{ operation_id: "original-operation" }], next_cursor: null } };
  const record = { status: "running", outcome: null, operation: { caller: { kind: "plugin", id: original.view }, operation_id: "original-operation",
    client_request_id: requestId(original.view, original.request), capability: { id: original.capability, version: original.version }, normalized_arguments: original.arguments } };
  f.query.mockResolvedValueOnce(page).mockResolvedValueOnce({ status: "ready", completeness: "partial", data: { record } });
  await expect(f.actions.inspectRetained(original.view, original.request)).rejects.toThrow("unavailable");
  f.query.mockResolvedValueOnce(page).mockResolvedValueOnce({ status: "ready", completeness: "complete", data: { record: { ...record, operation: { ...record.operation, operation_id: "foreign" } } } });
  await expect(f.actions.inspectRetained(original.view, original.request)).rejects.toThrow("another Operation");
  f.query.mockResolvedValueOnce(page).mockResolvedValueOnce({ status: "ready", completeness: "complete", data: { record } });
  f.owner.saveActions.mockRejectedValueOnce(new Error("result state unconfirmed"));
  await expect(f.actions.inspectRetained(original.view, original.request)).rejects.toThrow("result state unconfirmed");
  expect(f.actions.getSnapshot()).toMatchObject({ pending: next, retained: [original], receipt: null });
  expect(f.invoke).toHaveBeenCalledTimes(2);
});

it("retention capacity never evicts an older unconfirmed request", async () => {
  const f = fixture(); f.invoke.mockRejectedValue(new Error("lost"));
  for (let index = 0; index < 8; index++) {
    await expect(f.actions.run(`print(plot_${index})`, "console")).rejects.toThrow("lost");
    await f.actions.setAside();
  }
  const retained = structuredClone(f.actions.getSnapshot().retained);
  await expect(f.actions.run("print(ninth)", "console")).rejects.toThrow("lost");
  const pending = structuredClone(f.actions.getSnapshot().pending);
  await expect(f.actions.setAside()).rejects.toThrow("capacity is full");
  expect(f.actions.getSnapshot()).toMatchObject({ pending, retained });
  expect(f.invoke).toHaveBeenCalledTimes(9);
});
