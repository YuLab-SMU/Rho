import { afterEach, expect, it, vi } from "vitest";
import { ObjectsConnection } from "../src/connection";
import type { InstanceRef } from "../public/plugin-protocol/index.js";
const source: InstanceRef = { instance: "native-instance", plugin: "r-provider", revision: "revision", artifact: "artifact" };
const owners: ObjectsConnection[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.stop(); vi.useRealTimers(); });
function fixture(savedState: unknown = {}) {
  vi.useFakeTimers();
  let state = { session_id: "session" as string | null, status: "ready", cache_key: "initial" as string | null, observed_at_ms: 1, notices: [] as string[] };
  let nextRead: unknown | undefined;
  const query = vi.fn(async (capability, args) => ({ data: capability.id === "r.inspection_state" ? structuredClone(state) : nextRead ?? {
    session_id: "session", status: "ready", source: "fixture", completeness: "complete", observed_at_ms: Date.now(), notices: [], diagnostic: null,
    data: { directory_ref: "directory", entries: [], total: 0, offset: 0, next_offset: null, observed_at_ms: Date.now(), complete: true, notices: [] },
  } }));
  const setState = vi.fn(async (value) => ({ state: value }));
  const client = { view: { project: "project", state: savedState }, query, setState };
  const owner = new ObjectsConnection(client as never, source); owners.push(owner);
  return { owner, query, setState, state: (patch: Partial<typeof state>) => state = { ...state, ...patch }, read: (value: unknown) => nextRead = value };
}
it("pins every query to the exact public provider and learns changes between idle polls", async () => {
  const f = fixture(); await f.owner.refresh();
  expect(f.query.mock.calls.map(([key]) => key.id)).toEqual(["r.inspection_state", "r.list_objects"]);
  for (const [, args] of f.query.mock.calls) expect(args.binding).toMatchObject({ provider: source, project: "project" });
  expect(f.query.mock.calls[0][1].binding.target).toBeNull();
  expect(f.query.mock.calls[1][1]).toMatchObject({ binding: { target: "session" }, arguments: { expected_session: "session" } });
  const version = f.owner.objects.version;
  await f.owner.refresh(); expect(f.owner.objects.version).toBe(version);
  expect(f.query.mock.calls.map(([key]) => key.id)).toEqual(["r.inspection_state", "r.list_objects", "r.inspection_state"]);
  f.state({ cache_key: "fast-operation:returned" }); await f.owner.refresh();
  expect(f.owner.objects.version).toBeGreaterThan(version);
  expect(f.query.mock.calls.filter(([key]) => key.id === "r.list_objects")).toHaveLength(2);
});
it("unstarted and busy owners do not submit scientific inspections or start sessions", async () => {
  const f = fixture(); f.state({ session_id: null, status: "unavailable", cache_key: null, notices: ["Create a session."] });
  await f.owner.refresh(); expect(f.owner.getSnapshot().session.runtime).toBeNull();
  f.state({ session_id: "session", status: "busy", cache_key: "run:running" });
  await f.owner.refresh(); expect(f.owner.getSnapshot().session.runtime?.state).toBe("busy");
  expect(f.query.mock.calls.every(([key]) => key.id === "r.inspection_state")).toBe(true);
});
it("a foreign readiness result fences the connection without retargeting retained presentation", async () => {
  const f = fixture(); await f.owner.refresh();
  f.owner.objects.setViewValue("field-order", ["name", "value"]);
  f.state({ session_id: "foreign-session", cache_key: "foreign-key" });
  await expect(f.owner.refresh()).rejects.toThrow("original session");
  expect(f.owner.getSnapshot().connected).toBe(false);
  expect(f.owner.objects.viewValue("field-order", [])).toEqual(["name", "value"]);
  expect(f.query.mock.calls.at(-1)?.[1].arguments.expected_session).toBe("session");
  expect(f.query.mock.calls.filter(([key]) => key.id === "r.list_objects")).toHaveLength(1);
});
it("native busy responses are deferred instead of spinning on queued page reads", async () => {
  const f = fixture(); f.read({ session_id: "session", status: "busy", source: "fixture", completeness: "unknown", observed_at_ms: 1, data: null, notices: ["Busy"], diagnostic: null });
  await f.owner.refresh(); const reads = f.query.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.query).toHaveBeenCalledTimes(reads);
  expect(f.owner.objects.stale).toBe(true);
  expect(f.owner.getSnapshot().session.runtime?.state).toBe("busy");
});
it("presentation writes keep the pinned session and report unacknowledged state", async () => {
  const f = fixture(); await f.owner.refresh();
  f.owner.objects.setViewValue("field-order", ["name", "value"]); await f.owner.flush();
  expect(f.setState.mock.calls.at(-1)?.[0]).toMatchObject({ nativeSession: "session", objects: { objectViews: { "field-order": ["name", "value"] } } });
  const writes = f.setState.mock.calls.length; await f.owner.refresh(); await f.owner.flush();
  expect(f.setState).toHaveBeenCalledTimes(writes);
  f.owner.objects.setViewValue("filter", "中文"); f.setState.mockRejectedValueOnce(new Error("connection lost"));
  await expect(f.owner.flush()).rejects.toThrow("connection lost");
  expect(f.owner.getSnapshot().saveError).toContain("not saved");
  await f.owner.flush(); expect(f.owner.getSnapshot().saveError).toBe("");
});
it("a restored view refuses a replacement session before requesting any object data", async () => {
  const f = fixture({ nativeSession: "original-session", objects: { objectViews: { filter: "中文" } } });
  await expect(f.owner.refresh()).rejects.toThrow("original session");
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls[0][1]).toMatchObject({ binding: { target: "original-session" }, arguments: { expected_session: "original-session" } });
  expect(f.owner.objects.viewValue("filter", "")).toBe("中文");
});
it("a reverted edit is saved after the preceding in-flight write is acknowledged", async () => {
  const f = fixture(); await f.owner.refresh();
  f.owner.objects.setViewValue("filter", "original"); await f.owner.flush();
  let complete!: () => void;
  f.setState.mockImplementationOnce(value => new Promise(resolve => { complete = () => resolve({ state: value }); }));
  f.owner.objects.setViewValue("filter", "temporary"); const first = f.owner.flush();
  await Promise.resolve();
  f.owner.objects.setViewValue("filter", "original"); const reverted = f.owner.flush();
  complete(); await first; await reverted;
  expect(f.setState.mock.calls.at(-1)?.[0].objects.objectViews.filter).toBe("original");
  expect(f.setState).toHaveBeenCalledTimes(3);
});
it("close preparation drains the active read, pauses new observations and captures the latest unsaved choice", async () => {
  const f = fixture(); await f.owner.refresh(); await f.owner.flush();
  const original = f.query.getMockImplementation()!;
  let complete!: () => void;
  f.query.mockImplementationOnce((...args) => new Promise(resolve => { complete = () => { void original(...args).then(resolve); }; }));
  const refresh = f.owner.refresh();
  let paused = false; const pause = f.owner.pause().then(() => { paused = true; });
  await Promise.resolve(); expect(paused).toBe(false);
  const reads = f.query.mock.calls.length;
  await f.owner.refresh(); expect(f.query).toHaveBeenCalledTimes(reads);
  f.owner.objects.setViewValue("filter", "last 中文 choice");
  complete(); await refresh; await pause; await f.owner.flush();
  expect(f.setState.mock.calls.at(-1)?.[0].objects.objectViews.filter).toBe("last 中文 choice");
  const saves = f.setState.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000); expect(f.query).toHaveBeenCalledTimes(reads); expect(f.setState).toHaveBeenCalledTimes(saves);
  f.owner.resume(); await f.owner.refresh(); expect(f.query.mock.calls.length).toBeGreaterThan(reads);
});
