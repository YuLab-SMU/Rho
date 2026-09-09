import { expect, it, vi } from "vitest";
import { NativeAgents } from "../src/native-agents";
import type { NativeAgentPorts } from "../src/native-agent-ports";
import type { AgentClientSession } from "../src/generated/AgentClientSession";
import type { LocalAgent } from "../src/generated/LocalAgent";
import type { RequestContext } from "../src/shared/ports";
const windowRef = { window_id: "window", incarnation: "one" };
const client = (): AgentClientSession => ({ id: "client", provider: "codex", native_session_id: "native", project_root: "/study", window: windowRef, model: "model", effort: "low", state: "ready", messages: [], activity: [], decisions: [], error: null, truncated: false, elapsed_ms: null, last_request_id: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/study", session: "r", runtimeState: "idle", connected: true, ready: true, capabilities: [] };
  const ports = { context: () => scope, window: () => windowRef, schedule: vi.fn(),
    discover: vi.fn<NativeAgentPorts["discover"]>(async req => ({ provider: req.provider, executable: "/agent", version: "1", models: [{ id: req.model ?? "model", name: "Native model", efforts: ["low"], default_effort: "low" }], selected_model: req.model ?? "model", selected_effort: "low", discovery_ms: 1, error: null, setup_required: false })),
    setup: vi.fn<NativeAgentPorts["setup"]>(async req => ({ provider: req.provider, executable: "/component/bin/dsh", version: "1", models: [{ id: "model", name: "Native model", efforts: [], default_effort: null }], selected_model: "model", selected_effort: null, discovery_ms: 1, error: null, setup_required: false })),
    connect: vi.fn<NativeAgentPorts["connect"]>(async () => client()), sessions: vi.fn<NativeAgentPorts["sessions"]>(async () => []),
    action: vi.fn<NativeAgentPorts["action"]>(async req => ({ ...client(), state: req.action.kind === "disconnect" ? "disconnected" : "running" })) };
  return { model: new NativeAgents(ports), ports, change: () => { scope = { ...scope, epoch: 2, project: "/new" }; } };
}
it("reads native model choices and starts an exact scoped session without clipboard setup", async () => {
  const f = fixture(); await f.model.rescan();
  expect(f.model.getSnapshot().catalog.kimi?.models[0].name).toBe("Native model");
  await f.model.connect("codex", "model", "low", true);
  expect(f.ports.connect).toHaveBeenCalledWith(expect.objectContaining({ project_root: "/study", window: windowRef, provider: "codex", model: "model", effort: "low" }));
  expect(f.ports.action.mock.calls[0][0].action.kind).toBe("test");
  expect(JSON.stringify(f.ports.connect.mock.calls)).not.toContain("Bearer");
  expect(f.model.getSnapshot().sessions[0].state).toBe("running");
});
it("reuses a connection request after lost acknowledgement, but a known failure can retry", async () => {
  const f = fixture(); f.ports.connect.mockRejectedValueOnce(new Error("Network interrupted"));
  await f.model.connect("codex", "model", "low"); await f.model.connect("codex", "model", "low");
  expect(f.ports.connect.mock.calls[0][0].request_id).toBe(f.ports.connect.mock.calls[1][0].request_id);
  const g = fixture(); g.ports.connect.mockRejectedValueOnce(Object.assign(new Error("Native failure"), { status: 502 }));
  await g.model.connect("codex", "model", "low"); await g.model.connect("codex", "model", "low");
  expect(g.ports.connect.mock.calls[0][0].request_id).not.toBe(g.ports.connect.mock.calls[1][0].request_id);
});
it("does not let an older session poll overwrite an admitted action", async () => {
  const f = fixture(); f.model.show(); await f.model.connect("codex", "model", "low");
  const old = deferred<AgentClientSession[]>(); f.ports.sessions.mockReturnValueOnce(old.promise);
  const reading = f.model.observe(); await f.model.act("client", { kind: "test", request_id: "test-request" });
  old.resolve([client()]); await reading; expect(f.model.getSnapshot().sessions[0].state).toBe("running");
});
it("fences connection results after a project transition", async () => {
  const f = fixture(), old = deferred<AgentClientSession>(); f.ports.connect.mockReturnValueOnce(old.promise);
  const connecting = f.model.connect("codex", "model", "low"); f.change(); f.model.reset();
  old.resolve(client()); await connecting; expect(f.model.getSnapshot().sessions).toEqual([]);
});
it("does not repeatedly launch CLI discovery after a transport failure", async () => {
  const f = fixture(); f.ports.discover.mockRejectedValue(new Error("Discovery unavailable"));
  await f.model.rescan(); f.model.show();
  for (let i = 0; i < 5; i++) await f.model.observe();
  f.model.hide(); f.model.show(); await f.model.observe();
  expect(f.ports.discover).toHaveBeenCalledTimes(3);
  expect(f.model.getSnapshot().error).toBe("Discovery unavailable");
  await f.model.rescan(); expect(f.ports.discover).toHaveBeenCalledTimes(6);
});
it("keeps the same test request after a lost acknowledgement", async () => {
  const f = fixture(); f.ports.action.mockRejectedValueOnce(new Error("Network interrupted"));
  await f.model.connect("codex", "model", "low", true);
  await f.model.connect("codex", "model", "low", true);
  expect(f.ports.connect).toHaveBeenCalledTimes(1);
  expect(f.ports.action.mock.calls[0][0].action).toEqual(f.ports.action.mock.calls[1][0].action);
  expect(f.ports.schedule).toHaveBeenCalled();
});
it("discovers all three CLIs with a bounded queue and skips stale project reads", async () => {
  const f = fixture(), first = deferred<LocalAgent>();
  f.ports.discover.mockReturnValueOnce(first.promise);
  const reads = [f.model.discover("codex"), f.model.discover("kimi"), f.model.discover("deepseek")];
  await vi.waitFor(() => expect(f.ports.discover).toHaveBeenCalledTimes(1));
  expect(f.model.getSnapshot().loading).toEqual({ codex: true, kimi: true, deepseek: true });
  first.resolve({ provider: "codex", executable: "/agent", version: "1", models: [], selected_model: null, selected_effort: null, discovery_ms: 1, error: null, setup_required: false });
  await Promise.all(reads);
  expect(f.ports.discover.mock.calls.map(([request]) => request.provider)).toEqual(["codex", "kimi", "deepseek"]);
  expect(f.model.getSnapshot().catalog.deepseek?.models[0].name).toBe("Native model");

  const g = fixture(), stale = deferred<LocalAgent>();
  g.ports.discover.mockReturnValueOnce(stale.promise);
  const old = [g.model.discover("codex"), g.model.discover("deepseek")];
  await vi.waitFor(() => expect(g.ports.discover).toHaveBeenCalledTimes(1));
  g.change(); g.model.reset(); stale.resolve(await first.promise); await Promise.all(old);
  expect(g.ports.discover).toHaveBeenCalledTimes(1);
  expect(g.model.getSnapshot().catalog).toEqual({});
});
it("passes the DeepSeek Harness model and native test through the current window", async () => {
  const f = fixture(), nativeModel = '["configured","deepseek-reasoner"]';
  await f.model.discover("deepseek", nativeModel);
  const deepseek = { ...client(), provider: "deepseek" as const, model: nativeModel, effort: null };
  f.ports.connect.mockResolvedValueOnce(deepseek);
  f.ports.action.mockResolvedValueOnce({ ...deepseek, state: "running" });
  await f.model.connect("deepseek", nativeModel, null, true);
  expect(f.ports.connect).toHaveBeenCalledWith(expect.objectContaining({ provider: "deepseek", model: nativeModel, effort: null, window: windowRef, project_root: "/study" }));
  expect(f.ports.action.mock.calls[0][0]).toMatchObject({ project_root: "/study", window: windowRef, session_id: "client", action: { kind: "test" } });
  expect(f.model.getSnapshot().sessions[0].provider).toBe("deepseek");
});
it("installs a connection component only on request and keeps retries explicit", async () => {
  const f = fixture();
  f.ports.discover.mockResolvedValue({ provider: "deepseek", executable: "/agent", version: "old", models: [], selected_model: null, selected_effort: null, discovery_ms: 1, error: null, setup_required: true });
  await f.model.discover("deepseek"); f.model.show(); await f.model.observe();
  expect(f.ports.setup).not.toHaveBeenCalled();
  const installed = deferred<LocalAgent>(); f.ports.setup.mockReturnValueOnce(installed.promise);
  const setup = f.model.setup("deepseek");
  expect(f.model.getSnapshot().installing).toBe("deepseek");
  await f.model.setup("deepseek"); expect(f.ports.setup).toHaveBeenCalledTimes(1);
  installed.resolve({ provider: "deepseek", executable: "/component/bin/dsh", version: "new", models: [{ id: "model", name: "Native model", efforts: [], default_effort: null }], selected_model: "model", selected_effort: null, discovery_ms: 1, error: null, setup_required: false });
  await setup;
  expect(f.ports.setup).toHaveBeenCalledWith({ project_root: "/study", provider: "deepseek" });
  expect(f.model.getSnapshot().catalog.deepseek?.setup_required).toBe(false);
  expect(f.model.getSnapshot().installing).toBeNull();

  f.ports.setup.mockRejectedValueOnce(new Error("Component download failed"));
  await f.model.setup("deepseek");
  for (let i = 0; i < 3; i++) await f.model.observe();
  expect(f.ports.setup).toHaveBeenCalledTimes(2);
  expect(f.model.getSnapshot().error).toBe("Component download failed");
});
it("fences a completed component installation after the workspace changes", async () => {
  const f = fixture(), installed = deferred<LocalAgent>(); f.ports.setup.mockReturnValueOnce(installed.promise);
  const setup = f.model.setup("deepseek"); f.change(); f.model.reset();
  installed.resolve({ provider: "deepseek", executable: "/component/bin/dsh", version: "new", models: [], selected_model: null, selected_effort: null, discovery_ms: 1, error: null, setup_required: false });
  await setup;
  expect(f.model.getSnapshot().catalog).toEqual({});
  expect(f.model.getSnapshot().installing).toBeNull();
});
