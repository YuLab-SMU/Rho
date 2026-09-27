import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginViewConnection, PluginViewRequest } from "../../sdk/plugin-protocol/index.js";
import { HostClient } from "../src/host-client";
import { mountPluginFrame } from "../src/plugin-frame";

const connection = {
  view: { view: "view-a", window: "window-a", contribution: "document", state: {}, state_version: 0 },
  connection: "connection-a", call_token: "private-call-credential", asset_token: "asset", entrypoint: "index.html", next_sequence: 7,
} as PluginViewConnection;
let port: { onmessage?: (event: { data: unknown }) => void; close: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
const disposals: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("MessageChannel", class {
    port1 = port = { close: vi.fn(), postMessage: vi.fn(), start: vi.fn() };
    port2 = { close: vi.fn() };
  });
});
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(testProject: string | null = "test-child", refresh?: () => Promise<void>) {
  const client = new HostClient("private-host-credential", "window-a", testProject ?? undefined);
  const request = vi.spyOn(client, "request").mockResolvedValue({ ok: true, result: {} });
  const release = vi.spyOn(client, "port").mockResolvedValue({ released: true });
  const container = document.createElement("div"); document.body.append(container);
  const failed = vi.fn();
  const dispose = mountPluginFrame(container, client, "/analysis", connection, failed, refresh); disposals.push(dispose);
  const messagePort = port;
  let sequence = 0;
  const send = (body: PluginViewRequest, testProject?: string) => messagePort.onmessage!({ data: { protocol_version: 1, connection: connection.connection,
    view: connection.view.view, sequence: ++sequence, request: `request-${sequence}`, test_project: testProject, body } });
  return { client, request, release, container, failed, dispose, send, messagePort };
}
it("forwards an explicit child selection inside the original private view channel", async () => {
  const frame = mount(null); frame.send({ type: "query", capability: { id: "plugins.instances", version: 1 }, arguments: {} }, "selected-child");
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
  expect(frame.request.mock.calls[0]).toEqual(["/api/plugin-view", { project_root: "/analysis", call_token: connection.call_token,
    message: { protocol_version: 1, connection: connection.connection, view: connection.view.view, sequence: 7,
      request: "request-1", test_project: "selected-child", body: { type: "query", capability: { id: "plugins.instances", version: 1 }, arguments: {} } } }]);
});
it.each(["valid", "unfocused", "wrong-target"])("opens a test workspace only for an exact Host result and current gesture: %s", async mode => {
  const frame = mount(null), open = vi.spyOn(frame.client, "openTestWorkspace").mockReturnValue({ navigation_requested: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(mode !== "unfocused");
  vi.stubGlobal("navigator", { userActivation: { isActive: true } });
  frame.container.querySelector("iframe")!.focus();
  frame.request.mockResolvedValue({ ok: true, result: { authorized_view: "view-a", window: "window-a", test_project: mode === "wrong-target" ? "wrong" : "selected-child" } });
  frame.send({ type: "open_test_workspace", test_project: "selected-child" });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
  const reply = port.postMessage.mock.calls[0]![0];
  expect(reply.ok).toBe(mode === "valid");
  if (mode === "valid") { expect(open).toHaveBeenCalledExactlyOnceWith("selected-child", "window-a"); expect(reply.result).toEqual({ navigation_requested: true }); }
  else expect(open).not.toHaveBeenCalled();
  expect(JSON.stringify(reply)).not.toContain("private-host-credential");
});
it("retires only acknowledged handlers after destruction, through a selected keepalive Control", async () => {
  const frame = mount();
  frame.send({ type: "register_close_handler", renderer: "document-a" });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
  frame.send({ type: "register_close_handler", renderer: "document-a" });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(2));
  frame.container.style.display = "none";
  expect(frame.release).not.toHaveBeenCalled();
  expect(frame.container.querySelector("iframe")!.src).not.toContain(connection.call_token);
  const nativeRenderer = (frame.request.mock.calls[0]![1] as { message: { body: { renderer: string } } }).message.body.renderer;
  expect(nativeRenderer).not.toBe("document-a");
  frame.dispose(); frame.dispose();
  expect(frame.release).toHaveBeenCalledExactlyOnceWith("/analysis", { method: "control", params: {
    capability: { id: "views.release_renderer", version: 1 }, arguments: {
      view: "view-a", connection: "connection-a", window: "window-a", renderer: nativeRenderer, call_token: connection.call_token,
    },
  } }, "test-child", true);
  expect(frame.container.querySelector("iframe")).toBeNull();
});
it("keeps equal SDK handler names in different documents independent", async () => {
  const first = mount(), second = mount();
  for (const frame of [first, second]) frame.send({ type: "register_close_handler", renderer: "same-public-name" });
  await vi.waitFor(() => expect(first.messagePort.postMessage).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(second.messagePort.postMessage).toHaveBeenCalledTimes(1));
  const renderer = (frame: typeof first) => (frame.request.mock.calls[0]![1] as { message: { body: { renderer: string } } }).message.body.renderer;
  expect(renderer(first)).not.toBe(renderer(second));
  first.dispose(); expect(first.release).toHaveBeenCalledTimes(1); expect(second.release).not.toHaveBeenCalled();
  second.send({ type: "observe_lifecycle", renderer: renderer(first) });
  await vi.waitFor(() => expect(second.failed).toHaveBeenCalledWith("This document has not registered that close handler."));
  expect(second.request).toHaveBeenCalledTimes(1);
});
it("retains cached documents and retires an actually ending browser document", async () => {
  const frame = mount(); frame.send({ type: "register_close_handler", renderer: "document-a" });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  expect(frame.release).not.toHaveBeenCalled(); expect(frame.container.querySelector("iframe")).not.toBeNull();
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  expect(frame.release).toHaveBeenCalledTimes(1); expect(frame.container.querySelector("iframe")).toBeNull();
});
it("uses a late registration acknowledgement only for its already destroyed document", async () => {
  const frame = mount(); let acknowledge!: (value: unknown) => void;
  frame.request.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
  frame.send({ type: "register_close_handler", renderer: "late-document" });
  frame.dispose(); expect(frame.release).not.toHaveBeenCalled();
  acknowledge({ ok: true, result: {} });
  await vi.waitFor(() => expect(frame.release).toHaveBeenCalledTimes(1));
  expect(port.postMessage).not.toHaveBeenCalled();
});
it.each(["rejected", "lost"])("does not claim a %s registration was acknowledged", async outcome => {
  const frame = mount();
  if (outcome === "lost") frame.request.mockRejectedValueOnce(new Error("disconnected"));
  else frame.request.mockResolvedValueOnce({ ok: false, error: "not registered" });
  frame.send({ type: "register_close_handler", renderer: "unknown-document" });
  await vi.waitFor(() => expect(outcome === "lost" ? frame.failed : port.postMessage).toHaveBeenCalled());
  frame.dispose(); expect(frame.release).not.toHaveBeenCalled();
});

it("refreshes a successful scenario observation before delivering its original receipt", async () => {
  let finish!: () => void;
  const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const frame = mount(null, refresh), result = {status: "succeeded", outcome: "succeeded", operation: {capability: {id: "scenarios.apply", version: 1}}};
  frame.request.mockResolvedValue({ok: true, result});
  frame.send({type: "get_operation", operation_id: "original"});
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(frame.messagePort.postMessage).not.toHaveBeenCalled(); finish();
  await vi.waitFor(() => expect(frame.messagePort.postMessage).toHaveBeenCalledTimes(1));
  expect(frame.messagePort.postMessage.mock.calls[0][0]).toMatchObject({ok: true, result});
});
it.each(["child", "query", "uncertain", "refresh-failed"])("preserves scope and the Operation outcome during presentation refresh: %s", async mode => {
  const refresh = vi.fn(async () => { throw Error("window observation unavailable"); });
  const frame = mount(null, refresh), status = mode === "uncertain" ? "uncertain" : "succeeded";
  const result = {status, outcome: status, operation: {capability: {id: "scenarios.apply", version: 1}}};
  frame.request.mockResolvedValue({ok: true, result});
  const body: PluginViewRequest = mode === "query" ? {type: "query", capability: {id: "example.read", version: 1}, arguments: {}} : {type: "get_operation", operation_id: "original"};
  frame.send(body, mode === "child" ? "child" : undefined);
  await vi.waitFor(() => expect(frame.messagePort.postMessage).toHaveBeenCalledTimes(1));
  expect(refresh).toHaveBeenCalledTimes(mode === "refresh-failed" ? 1 : 0);
  expect(frame.messagePort.postMessage.mock.calls[0][0]).toMatchObject({ok: true, result}); expect(frame.failed).not.toHaveBeenCalled();
});
