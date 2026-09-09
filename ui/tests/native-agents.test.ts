import { expect, it, vi } from "vitest";
import { NativeAgents } from "../src/native-agents";
import type { NativeAgentPorts } from "../src/native-agent-ports";
import type { AgentDiagnostic } from "../src/generated/AgentDiagnostic";
import type { LocalAgent } from "../src/generated/LocalAgent";
import type { RequestContext } from "../src/shared/ports";
const windowRef = { window_id: "window", incarnation: "one" };
const capabilities = { resume: true, history: "native_context_history", images: true, embedded_context: true, modes: [], current_mode: null, models: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/study", session: "r", runtimeState: "idle", connected: true, ready: true, capabilities: [] };
  const ports = { context: () => scope, window: () => windowRef, schedule: vi.fn(),
    discover: vi.fn<NativeAgentPorts["discover"]>(async r => ({ provider: r.provider, executable: "/agent", version: "1", models: [{ id: r.model ?? "model", name: "Native model", efforts: ["low"], default_effort: "low" }], selected_model: r.model ?? "model", selected_effort: "low", discovery_ms: 1, error: null, setup_required: false, capabilities })),
    setup: vi.fn<NativeAgentPorts["setup"]>(async r => ({ provider: r.provider, executable: "/component", version: "1", models: [], selected_model: null, selected_effort: null, discovery_ms: 1, error: null, setup_required: false, capabilities })),
    test: vi.fn<NativeAgentPorts["test"]>(async r => ({ request_id: r.request_id, provider: r.provider, model: r.model, state: "succeeded", elapsed_ms: 1, response: "ok", error: null })) };
  return { model: new NativeAgents(ports), ports, change: () => { scope = { ...scope, epoch: 2, project: "/new" }; } };
}
it("settings discovery does not submit a diagnostic or create a task", async () => {
  const f = fixture(); await f.model.rescan();
  expect(f.ports.discover).toHaveBeenCalledTimes(3); expect(f.ports.test).not.toHaveBeenCalled();
  expect(f.model.getSnapshot().catalog.kimi?.models[0].name).toBe("Native model");
});
it("Test is a distinct request without an existing native-session selector", async () => {
  const f = fixture(); await f.model.test("kimi", "b-ai/glm-5.3-flash", "low"); await f.model.test("kimi", "b-ai/glm-5.3-flash", "low");
  const requests = f.ports.test.mock.calls.map(c => c[0]);
  expect(requests[0].request_id).not.toBe(requests[1].request_id);
  expect(requests[0]).toMatchObject({ project_root: "/study", window: windowRef, model: "b-ai/glm-5.3-flash", observe_only: false });
  expect(requests[0]).not.toHaveProperty("session_id"); expect(f.model.getSnapshot().diagnostics.kimi?.response).toBe("ok");
});
it("after a lost Test acknowledgement, observation never starts another diagnostic", async () => {
  const f = fixture(); f.ports.test.mockRejectedValueOnce(new Error("Network interrupted"));
  await f.model.test("kimi", "model", null); await f.model.observe();
  const [first, second] = f.ports.test.mock.calls.map(c => c[0]);
  expect(first.observe_only).toBe(false); expect(second.observe_only).toBe(true); expect(first.request_id).toBe(second.request_id);
});
it("late diagnostic results are fenced after a project transition", async () => {
  const f = fixture(), old = deferred<AgentDiagnostic>(); f.ports.test.mockReturnValueOnce(old.promise);
  const testing = f.model.test("kimi", "model", null); f.change(); f.model.reset();
  old.resolve({ request_id: "old", provider: "kimi", model: "model", state: "succeeded", elapsed_ms: 1, response: "old project", error: null });
  await testing; expect(f.model.getSnapshot().diagnostics).toEqual({});
});
it("discovery failures require explicit rescan instead of repeated CLI starts", async () => {
  const f = fixture(); f.ports.discover.mockRejectedValue(new Error("Unavailable"));
  await f.model.rescan(); f.model.show(); for (let i = 0; i < 5; i++) await f.model.observe(); f.model.hide(); f.model.show();
  expect(f.ports.discover).toHaveBeenCalledTimes(3); await f.model.rescan(); expect(f.ports.discover).toHaveBeenCalledTimes(6);
});
it("discovery is serialized and queued work from another project is skipped", async () => {
  const f = fixture(), first = deferred<LocalAgent>(); f.ports.discover.mockReturnValueOnce(first.promise);
  const jobs = [f.model.discover("codex"), f.model.discover("kimi")];
  await vi.waitFor(() => expect(f.ports.discover).toHaveBeenCalledTimes(1));
  f.change(); f.model.reset(); first.resolve({ provider: "codex", executable: "/agent", version: "1", models: [], selected_model: null, selected_effort: null, discovery_ms: 1, error: null, setup_required: false, capabilities });
  await Promise.all(jobs); expect(f.ports.discover).toHaveBeenCalledTimes(1); expect(f.model.getSnapshot().catalog).toEqual({});
});
it("component setup is explicit and does not send a model request", async () => {
  const f = fixture(); await f.model.setup("deepseek"); expect(f.ports.setup).toHaveBeenCalledWith({ project_root: "/study", provider: "deepseek" }); expect(f.ports.test).not.toHaveBeenCalled();
});
