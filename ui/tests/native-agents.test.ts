import { expect, it, vi } from "vitest";
import { NativeAgents } from "../src/native-agents";
import type { NativeAgentPorts } from "../src/native-agent-ports";
import type { AgentClientSession } from "../src/generated/AgentClientSession";
import type { RequestContext } from "../src/shared/ports";
const windowRef = { window_id: "window", incarnation: "one" };
const client = (): AgentClientSession => ({ id: "client", provider: "codex", native_session_id: "native", project_root: "/study", window: windowRef, model: "model", effort: "low", state: "ready", messages: [], activity: [], decisions: [], error: null, truncated: false, elapsed_ms: null, last_request_id: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/study", session: "r", runtimeState: "idle", connected: true, ready: true, capabilities: [] };
  const ports = { context: () => scope, window: () => windowRef, schedule: vi.fn(),
    discover: vi.fn<NativeAgentPorts["discover"]>(async req => ({ provider: req.provider, executable: "/agent", version: "1", models: [{ id: req.model ?? "model", name: "Native model", efforts: ["low"], default_effort: "low" }], selected_model: req.model ?? "model", selected_effort: "low", discovery_ms: 1, error: null })),
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
  expect(f.ports.discover).toHaveBeenCalledTimes(2);
  expect(f.model.getSnapshot().error).toBe("Discovery unavailable");
  await f.model.rescan(); expect(f.ports.discover).toHaveBeenCalledTimes(4);
});
it("keeps the same test request after a lost acknowledgement", async () => {
  const f = fixture(); f.ports.action.mockRejectedValueOnce(new Error("Network interrupted"));
  await f.model.connect("codex", "model", "low", true);
  await f.model.connect("codex", "model", "low", true);
  expect(f.ports.connect).toHaveBeenCalledTimes(1);
  expect(f.ports.action.mock.calls[0][0].action).toEqual(f.ports.action.mock.calls[1][0].action);
  expect(f.ports.schedule).toHaveBeenCalled();
});
