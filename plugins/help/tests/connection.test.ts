import { afterEach, expect, it, vi } from "vitest";
import { HelpConnection } from "../src/connection.js";
import { copy, index, page, ready } from "./fixtures.js";
const source = { instance: "r-one", plugin: "org.rho.r", revision: "revision", artifact: "artifact" };
const connections: HelpConnection[] = [];
afterEach(() => { for (const owner of connections.splice(0)) owner.stop(); vi.useRealTimers(); });
function fixture(saved: unknown = {}) {
  vi.useFakeTimers();
  let state = { session_id: copy.nativeSession as string | null, status: "ready", cache_key: "idle", observed_at_ms: 1, notices: [] as string[] };
  const query = vi.fn(async (cap, _args) => ({ data: cap.id === "r.inspection_state" ? structuredClone(state) : ready(cap.id === "r.package_index" ? index : page) }));
  const setState = vi.fn(async value => ({ state: value }));
  const owner = new HelpConnection({ view: { project: "project", state: saved }, query, setState } as never, source, copy, "demo");
  connections.push(owner);
  return { owner, query, setState, state: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; } };
}
it("uses only public exact provider/session queries and does not renew the selected copy after execution", async () => {
  const f = fixture(); await f.owner.refresh();
  expect(f.query.mock.calls.map(([cap]) => cap.id)).toEqual(["r.inspection_state", "r.package_index", "r.read_help"]);
  for (const [, args] of f.query.mock.calls) expect(args).toMatchObject({ binding: { provider: source, project: "project", target: copy.nativeSession }, arguments: { expected_session: copy.nativeSession } });
  f.state({ cache_key: "after-execution" }); await f.owner.refresh();
  expect(f.query.mock.calls.map(([cap]) => cap.id)).toEqual(["r.inspection_state", "r.package_index", "r.read_help", "r.inspection_state"]);
  expect(f.owner.help.getSnapshot().copy).toEqual(copy);
});
it("busy readiness and failed native reads wait for a later poll without a retry loop", async () => {
  const f = fixture(); f.state({ status: "busy" }); await f.owner.refresh(); await vi.advanceTimersByTimeAsync(5000);
  expect(f.query).toHaveBeenCalledTimes(1); f.state({ status: "ready" });
  f.query.mockImplementationOnce(async () => ({ data: { session_id: copy.nativeSession, status: "ready", cache_key: "idle", notices: [], observed_at_ms: 1 } }));
  f.query.mockImplementationOnce(async () => ({ data: { ...ready(index), status: "busy", data: null, notices: ["busy"] } } as never));
  await f.owner.refresh(); await vi.advanceTimersByTimeAsync(5000); expect(f.query).toHaveBeenCalledTimes(3);
  await f.owner.refresh(); expect(f.owner.help.getSnapshot().page?.complete).toBe(true);
});
it("never replaces a missing or different session on restoration", async () => {
  const f = fixture({ choices: { topic: "demo", filter: "中文", format: "text", raw: false, indexVisible: false, scrollTop: 40 } });
  f.state({ session_id: "replacement" }); await expect(f.owner.refresh()).rejects.toThrow("not retargeted");
  expect(f.query).toHaveBeenCalledTimes(1); expect(f.owner.help.serialize()).toMatchObject({ filter: "中文", scrollTop: 40 });
  f.state({ session_id: null }); await expect(f.owner.refresh()).rejects.toThrow("not retargeted");
  expect(f.query).toHaveBeenCalledTimes(2);
});
it("cooperative closure waits for current reads and persists the latest choices after preceding saves", async () => {
  const f = fixture(); await f.owner.refresh(); let finish!: () => void;
  f.setState.mockImplementationOnce(value => new Promise(resolve => { finish = () => resolve({ state: value }); }));
  f.owner.help.search("temporary"); const first = f.owner.flush(); await Promise.resolve();
  f.owner.help.search("latest 中文"); f.owner.help.setScroll(80); await f.owner.pause();
  const final = f.owner.flush(); finish(); await first; await final;
  expect(f.setState.mock.calls.at(-1)?.[0]).toEqual({ choices: { indexKind: "topic", filter: "latest 中文", topic: "demo", format: "html", raw: false, indexVisible: false, scrollTop: 80 } });
  const calls = f.query.mock.calls.length; await f.owner.refresh(); await vi.advanceTimersByTimeAsync(5000); expect(f.query).toHaveBeenCalledTimes(calls);
  f.owner.resume(); await f.owner.refresh(); expect(f.query.mock.calls.length).toBeGreaterThan(calls);
});
it("failed state writes remain unsaved and can be retried without reading science", async () => {
  const f = fixture(); f.owner.help.search("中文"); f.setState.mockRejectedValueOnce(new Error("disk"));
  await expect(f.owner.flush()).rejects.toThrow("disk"); expect(f.owner.getSnapshot().saveError).toContain("not saved");
  await f.owner.flush(); expect(f.owner.getSnapshot().saveError).toBe(""); expect(f.setState).toHaveBeenCalledTimes(2); expect(f.query).not.toHaveBeenCalled();
});
