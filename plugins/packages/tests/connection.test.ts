import { afterEach, expect, it, vi } from "vitest";
import { PackagesConnection } from "../src/connection.js";
import type { AgentState } from "../public/agent-input/input.js";
const source = { instance: "r-one", plugin: "org.rho.r", revision: "revision", artifact: "artifact" };
const connections: PackagesConnection[] = [];
afterEach(() => { for (const owner of connections.splice(0)) owner.stop(); vi.useRealTimers(); });
function fixture(saved: unknown = {}) {
  vi.useFakeTimers();
  let state = { session_id: "original" as string | null, status: "ready", cache_key: "idle" as string | null, observed_at_ms: 1, notices: [] as string[] };
  const query = vi.fn(async (cap, args) => ({ data: cap.id === "r.inspection_state" ? structuredClone(state) : {
    session_id: "original", status: "ready", source: "native", notices: [], diagnostic: null,
    observed_at_ms: 1, completeness: "complete", data: { observation_id: "packages_1", package_name: null,
      groups: [], packages: [], counts: { all: 0 }, offset: 0, next_offset: null, scan_complete: true, observed_at_ms: 1 },
  } }));
  const setState = vi.fn(async value => ({ state: value }));
  const owner = new PackagesConnection({ view: { project: "project", state: saved }, query, setState } as never, source);
  connections.push(owner); owner.packages.setVisible("panel", true);
  return { owner, query, setState, state: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; } };
}
it("pins public reads to the exact provider and native session and refreshes after execution", async () => {
  const f = fixture(); await f.owner.refresh();
  expect(f.query.mock.calls.map(([cap]) => cap.id)).toEqual(["r.inspection_state", "r.packages"]);
  for (const [, args] of f.query.mock.calls) expect(args.binding).toMatchObject({ provider: source, project: "project" });
  expect(f.query.mock.calls[1][1]).toMatchObject({ binding: { target: "original" }, arguments: { expected_session: "original" } });
  await f.owner.refresh(); expect(f.query.mock.calls.filter(([cap]) => cap.id === "r.packages")).toHaveLength(1);
  f.state({ cache_key: "execution-completed" }); await f.owner.refresh();
  expect(f.query.mock.calls.filter(([cap]) => cap.id === "r.packages")).toHaveLength(2);
});
it("unstarted and busy sessions remain bounded observations without starting R or loading packages", async () => {
  const f = fixture(); f.state({ session_id: null, status: "unavailable", cache_key: null }); await f.owner.refresh();
  f.state({ session_id: "original", status: "busy", cache_key: "running" }); await f.owner.refresh();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.query.mock.calls.map(([cap]) => cap.id)).toEqual(["r.inspection_state", "r.inspection_state"]);
});
it("restoration refuses another session while preserving the saved inspection choice", async () => {
  const f = fixture({ nativeSession: "ended", packages: { packages: { filter: "中文", selected: "stats", inspectorMode: "source" } } });
  await expect(f.owner.refresh()).rejects.toThrow("original session");
  expect(f.query).toHaveBeenCalledTimes(1); expect(f.owner.nativeSession).toBe("ended");
  expect(f.owner.packages.filter).toBe("中文"); expect(f.owner.packages.inspectorMode).toBe("source");
});
it("final capture pauses observations and saves choices after earlier writes settle", async () => {
  const f = fixture(); await f.owner.refresh(); await f.owner.flush();
  let complete!: () => void;
  f.setState.mockImplementationOnce(value => new Promise(resolve => { complete = () => resolve({ state: value }); }));
  f.owner.packages.select("temporary"); const first = f.owner.flush(); await Promise.resolve();
  f.owner.packages.select("latest 中文", "multiple"); await f.owner.pause();
  const final = f.owner.flush(); complete(); await first; await final;
  expect(f.setState.mock.calls.at(-1)?.[0]).toMatchObject({ nativeSession: "original", packages: { packages: { filter: "latest 中文", mode: "multiple" } } });
  const reads = f.query.mock.calls.length, saves = f.setState.mock.calls.length;
  await f.owner.refresh(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.query).toHaveBeenCalledTimes(reads); expect(f.setState).toHaveBeenCalledTimes(saves);
  f.owner.resume(); await f.owner.refresh(); expect(f.query.mock.calls.length).toBeGreaterThan(reads);
});
it("retains an Agent opening request through failed saves and new connection state", async () => {
  const f=fixture(),agent:AgentState={input:{request:'input-original',source_view:'packages-view',title:'Package stats',instance:null,
    reference:{provider:source,window:'window',contribution:'packages',selector:{session:'original',observation:'packages_1',package:'stats',library:'/R/library',version:'4.5'}},
    inclusion:{kind:'metadata'},preview:{id:'r.context.packages.preview',version:1}},
    pending:{view:'packages-view',request:'open-original',operation:'operation-original',capability:{id:'windows.open_view',version:1},arguments:{original:true}},opened:null};
  f.setState.mockRejectedValueOnce(new Error('lost save'));
  await expect(f.owner.saveAgent(agent)).rejects.toThrow('lost save');
  expect(f.owner.savedAgent).toEqual(agent);await f.owner.flush();
  const saved=f.setState.mock.calls.at(-1)![0];expect(saved.agent).toEqual(agent);
  const next=fixture(saved);expect(next.owner.savedAgent).toEqual(agent);
  const detached=next.owner.savedAgent!;detached.pending!.request='different';
  expect(next.owner.savedAgent?.pending?.request).toBe('open-original');
  expect(next.query).not.toHaveBeenCalled();
});
