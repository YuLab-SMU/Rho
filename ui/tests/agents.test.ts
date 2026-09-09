import { expect, it, vi } from "vitest";
import { Agents } from "../src/agents";
import type { RequestContext } from "../src/shared/ports";
import type { WorkbenchAgentConnection } from "../src/generated/WorkbenchAgentConnection";

const observation = (): WorkbenchAgentConnection => ({ project_root: "/项目", endpoint: "http://127.0.0.1:12345/mcp", suggested_server_name: "rho_12345", observed_at_ms: 1, active_sessions: 0, sessions: [], history_truncated: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/项目", session: "r1", runtimeState: "idle", connected: true, ready: true, capabilities: [] };
  let window = { window_id: "window-a", incarnation: "incarnation-1" };
  const ports = { context: () => scope, window: () => window, read: vi.fn(async () => observation()),
    configuration: vi.fn((_data: WorkbenchAgentConnection, _format: string, masked: boolean) => masked ? "Bearer <masked>" : "Bearer private-fixture-token"),
    copy: vi.fn(async (_text: string) => {}), schedule: vi.fn() };
  const agents = new Agents(ports);
  return { agents, ports, changeScope: (next: RequestContext) => { scope = next; }, scope: () => scope, changeWindow: () => { window = { ...window, incarnation: "incarnation-2" }; } };
}
it("observes only while visible and shares concurrent reads", async () => {
  const f = fixture(); await f.agents.observe(); expect(f.ports.read).not.toHaveBeenCalled();
  f.agents.show(); const pending = deferred<WorkbenchAgentConnection>(); f.ports.read.mockReturnValueOnce(pending.promise);
  const a = f.agents.refresh(), b = f.agents.refresh(); expect(a).toBe(b); expect(f.ports.read).toHaveBeenCalledTimes(1);
  pending.resolve(observation()); await a; expect(f.agents.canCopy).toBe(true);
  f.agents.hide(); await f.agents.observe(); expect(f.ports.read).toHaveBeenCalledTimes(1);
});
it("does not copy a credential when settings close during the fresh identity check", async () => {
  const f = fixture(); f.agents.show(); await f.agents.refresh();
  const pending = deferred<WorkbenchAgentConnection>(); f.ports.read.mockReturnValueOnce(pending.promise);
  const copying = f.agents.copyConfiguration("codex"); f.agents.hide(); pending.resolve(observation()); await copying;
  expect(f.ports.copy).not.toHaveBeenCalled(); expect(f.agents.getSnapshot().data).toBeNull();
});
it("retains stale evidence but disables copying for a mismatched project or failed read", async () => {
  const f = fixture(); f.agents.show(); await f.agents.refresh();
  f.ports.read.mockResolvedValueOnce({ ...observation(), project_root: "/different" }); await f.agents.refresh();
  expect(f.agents.getSnapshot().data?.project_root).toBe("/项目"); expect(f.agents.getSnapshot().stale).toBe(true);
  await f.agents.copyConfiguration("codex"); expect(f.ports.copy).not.toHaveBeenCalled();
  await f.agents.refresh(); expect(f.agents.canCopy).toBe(true);
  f.ports.read.mockRejectedValueOnce(new Error("Workbench unavailable")); await f.agents.refresh(); expect(f.agents.canCopy).toBe(false);
});
it("never stores private configuration in previews or snapshots and copying is not connection success", async () => {
  const f = fixture(); f.agents.show(); await f.agents.refresh();
  expect(f.agents.preview("codex")).not.toContain("private-fixture-token");
  await f.agents.copyConfiguration("codex"); expect(f.ports.copy).toHaveBeenCalledWith("Bearer private-fixture-token");
  expect(JSON.stringify(f.agents.getSnapshot())).not.toContain("private-fixture-token");
  expect(f.agents.getSnapshot().data?.active_sessions).toBe(0);
  expect(f.agents.getSnapshot().feedback).toContain("Configuration copied");
});
it("copies the current exact window incarnation and fences a native-session transition", async () => {
  const f = fixture(); f.agents.show(); await f.agents.refresh(); f.changeWindow(); await f.agents.copyContext();
  expect(f.ports.copy.mock.calls[0][0]).toContain('"incarnation":"incarnation-2"');
  expect(f.ports.copy.mock.calls[0][0]).toContain("Do not execute R");
  f.ports.copy.mockClear(); const pending = deferred<WorkbenchAgentConnection>(); f.ports.read.mockReturnValueOnce(pending.promise);
  const copying = f.agents.copyContext(); f.changeScope({ ...f.scope(), epoch: 2, session: "r2" }); f.agents.reset();
  pending.resolve(observation()); await copying; expect(f.ports.copy).not.toHaveBeenCalled();
});
it("reports clipboard denial without claiming success or exposing its input", async () => {
  const f = fixture(); f.agents.show(); await f.agents.refresh(); f.ports.copy.mockRejectedValueOnce(new Error("private-fixture-token"));
  await f.agents.copyConfiguration("codex"); expect(f.agents.getSnapshot().feedback).toBe("");
  expect(f.agents.getSnapshot().error).toContain("Copy failed"); expect(JSON.stringify(f.agents.getSnapshot())).not.toContain("private-fixture-token");
});
