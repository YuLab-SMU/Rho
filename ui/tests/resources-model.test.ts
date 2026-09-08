import { expect, it, vi } from "vitest";
import { Objects } from "../src/objects";
import { Files } from "../src/files";
import type { ResourceIdentity } from "../src/resource-ports";
const binding = (name: string, value = 1) => ({ name, classes: ["numeric"], object_type: "double", kind: "value",
  length: 1, dimensions: [], preview: [value], truncated: false, notice: null });
function ready(data: unknown, session = "session", time = 123) {
  return { target: { kind: "workspace", identity: session }, source: "fixture", status: "ready", data, notices: [], observed_at_ms: time };
}
function fixture() {
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true,
    capabilities: ["workspace.snapshot", "workspace.inspect_object"] };
  const query = vi.fn(), schedule = vi.fn();
  const ports = { context: () => scope, query, schedule, changed: vi.fn() };
  return { o: new Objects(ports), f: new Files(ports), query, schedule,
    scope: (change: Partial<ResourceIdentity>) => { scope = { ...scope, ...change }; } };
}
const objects = (value = 1) => ({ objects: [binding("x", value)], total_bindings: 1, truncated: false, working_directory: "/project",
  r_version: "4", library_paths: [], namespace_paths: [], library_usage_complete: true });
const directory = (path = "", names = ["a.R"]) => ({ path, entries: names.map((name) => ({ path: path ? `${path}/${name}` : name,
  name, kind: "regular", byte_size: 1 })), next_name: null, truncated: false, notices: [] });

it("inline and viewer demands for the same object share one read and release independently", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())).mockResolvedValue(ready(binding("x")));
  await o.observe(); const releaseInline = o.registerDemand("inline:x", "x", "objects"), releaseViewer = o.registerDemand("viewer:x", "x", "viewer");
  await o.observe(); expect(query).toHaveBeenCalledTimes(2); releaseInline(); o.invalidate();
  query.mockResolvedValueOnce(ready(objects())).mockResolvedValueOnce(ready(binding("x", 2)));
  await o.observe(); await o.observe(); expect(o.inspectors.get("x")?.binding.preview).toEqual([2]);
  expect(o.visibleNames).toEqual(["x"]); releaseViewer(); expect(o.visibleNames).toEqual([]);
});
it("a busy runtime retains real observation times and makes no native reads", async () => {
  const { o, query, scope } = fixture(); query.mockResolvedValueOnce(ready(objects(), "session", 123)); await o.observe();
  o.invalidate(); scope({ runtimeState: "busy" }); o.registerDemand("viewer:x", "x", "viewer"); await o.observe();
  expect(query).toHaveBeenCalledTimes(1); expect(o.observedAt).toBe(123); expect(o.data?.objects).toHaveLength(1); expect(o.stale).toBe(true);
});
it.each(["failed", "cancelled", "uncertain", "succeeded"])("workspace %s invalidates observations without rerunning work", async (status) => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe();
  o.operationChanged({ epoch: 1, project: "/project", operationId: "op", capability: "workspace.run_r", status, cursor: 1 });
  expect(o.stale).toBe(true); expect(o.needsObservation).toBe(true); expect(query).toHaveBeenCalledTimes(1);
});
it("project scope is not bypassed by unrelated operation notifications", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe();
  o.operationChanged({ epoch: 1, project: "/other", operationId: "op", capability: "workspace.run_r", status: "succeeded", cursor: 1 });
  expect(o.stale).toBe(false);
});
it("A → B → A and late cleanup cannot contaminate a newer object request", async () => {
  const { o, query, scope } = fixture(); let reject!: (value: Error) => void, release!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })); const old = o.observe();
  scope({ epoch: 2, project: "/other" }); o.reset(); scope({ epoch: 3, project: "/project" }); o.reset();
  query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const fresh = o.observe();
  reject(new Error("old failure")); await old; expect(o.loading).toBe(true); expect(o.notice).toBe("");
  release(ready(objects(2))); await fresh; expect(o.data?.objects[0].preview).toEqual([2]);
});
it("R restart retains active demand tokens but fences the old preview", async () => {
  const { o, query, scope } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe();
  o.registerDemand("viewer:x", "x", "viewer"); let release!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const old = o.observe();
  scope({ session: "new-session" }); o.sessionChanged(); release(ready(binding("x"))); await old;
  expect(o.inspectors.size).toBe(0); expect(o.visibleNames).toEqual(["x"]);
  query.mockResolvedValueOnce(ready(objects(2), "new-session")).mockResolvedValueOnce(ready(binding("x", 2), "new-session"));
  await o.observe(); await o.observe(); expect(o.inspectors.get("x")?.binding.preview).toEqual([2]);
});
it("a failed preview remains eligible for recovery instead of clearing demand", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe(); o.registerDemand("viewer:x", "x", "viewer");
  query.mockRejectedValueOnce(new Error("network")); await expect(o.observe()).rejects.toThrow("network"); expect(o.needsObservation).toBe(true);
  query.mockResolvedValueOnce(ready(binding("x"))); await o.observe(); expect(o.inspectors.has("x")).toBe(true); expect(o.notice).toBe("");
});
it("directory reads deduplicate identical visible demand and retain state when a view closes", async () => {
  const { f, query } = fixture(); f.listDirectory(); f.listDirectory(); query.mockResolvedValueOnce(ready(directory()));
  await f.observe(); expect(query).toHaveBeenCalledTimes(1); f.setScroll(45); f.setFilter(".R");
  expect(f.serialize()).toMatchObject({ filesScrollTop: 45, fileSearch: { filter: ".R" } }); expect(f.directories.get("")?.entries[0].path).toBe("a.R");
});
it("save notification during a directory read preserves invalidation for a later observation", async () => {
  const { f, query } = fixture(); let release!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); f.listDirectory(); const old = f.observe();
  f.fileSaved({ epoch: 1, project: "/project", path: "new.R", hash: "h" }); release(ready(directory())); await old;
  expect(f.needsObservation).toBe(true); expect(f.directories.size).toBe(0);
  query.mockResolvedValueOnce(ready(directory("", ["new.R"]))); await f.observe(); expect(f.directories.get("")?.entries[0].path).toBe("new.R");
});
it("file search generations prevent older results or cleanup from replacing a new search", async () => {
  const { f, query } = fixture(); let release!: (value: unknown) => void;
  f.setSearchMode(true); f.setFilter("old"); f.search(); query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const old = f.observe(); f.setFilter("new"); f.search(); release(ready({ entries: directory("", ["old.R"]).entries })); await old;
  expect(f.results).toBeNull(); expect(f.searching).toBe(true);
  query.mockResolvedValueOnce(ready({ entries: directory("", ["new.R"]).entries, scanned_entries: 1, scanned_directories: 1, truncated: false, notices: [] }));
  await f.observe(); expect(f.results?.entries[0].path).toBe("new.R"); expect(f.searching).toBe(false);
});
it("file read errors retain the original continuation for scheduler retry", async () => {
  const { f, query } = fixture(); f.listDirectory(); query.mockResolvedValueOnce(ready({ ...directory(), next_name: "a.R" })); await f.observe();
  f.listDirectory("", true); query.mockRejectedValueOnce(new Error("temporary")); await expect(f.observe()).rejects.toThrow("temporary");
  expect(f.directories.get("")?.entries).toHaveLength(1); query.mockResolvedValueOnce(ready(directory("", ["b.R"]))); await f.observe();
  expect(query.mock.calls[1][2]).toEqual(query.mock.calls[2][2]); expect(f.directories.get("")?.entries.map((e) => e.path)).toEqual(["a.R", "b.R"]);
});
it("A → B → A drops an old file failure while a newer directory request remains loading", async () => {
  const { f, query, scope } = fixture(); let reject!: (value: Error) => void, release!: (value: unknown) => void;
  f.listDirectory(); query.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })); const old = f.observe();
  scope({ epoch: 2, project: "/other" }); f.reset(); scope({ epoch: 3, project: "/project" }); f.reset(); f.listDirectory();
  query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const fresh = f.observe(); reject(new Error("old")); await old;
  expect(f.error).toBe(""); expect(f.loading).toBe(true); release(ready(directory())); await fresh; expect(f.loading).toBe(false);
});
it("stop prevents late file and object results from publishing", async () => {
  const { f, o, query } = fixture(); const releases: ((value: unknown) => void)[] = [];
  query.mockImplementation(() => new Promise((resolve) => { releases.push(resolve); })); f.listDirectory(); const files = f.observe(), objectRead = o.observe();
  f.stop(); o.stop(); releases[0](ready(directory())); releases[1](ready(objects())); await Promise.all([files, objectRead]);
  expect(f.directories.size).toBe(0); expect(o.data).toBeNull();
});
it("an initial object list is actionable without any preview demand", async () => {
  const { o, query } = fixture(); expect(o.visibleNames).toEqual([]); expect(o.needsObservation).toBe(true);
  query.mockResolvedValueOnce(ready(objects())); await o.observe(); expect(query).toHaveBeenCalledTimes(1); expect(o.needsObservation).toBe(false);
});
it("inactive retained views and delayed intersection callbacks cannot schedule previews", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe();
  o.viewsChanged({ activeViewIds: ["objects"] });
  o.registerDemand("inline:x", "x", "objects"); o.registerDemand("viewer:x", "x", "viewer");
  o.viewsChanged({ activeViewIds: [] }); o.registerDemand("late-viewer", "x", "viewer");
  expect(o.visibleNames).toEqual([]); expect(o.needsObservation).toBe(false); await o.observe(); expect(query).toHaveBeenCalledTimes(1);
  o.viewsChanged({ activeViewIds: ["viewer"] }); expect(o.visibleNames).toEqual(["x"]);
  query.mockResolvedValueOnce(ready(binding("x"))); await o.observe(); expect(query).toHaveBeenCalledTimes(2);
});
it("active viewer demand survives hiding its same-name inline preview", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe();
  o.viewsChanged({ activeViewIds: ["objects", "viewer"] });
  o.registerDemand("inline:x", "x", "objects"); o.registerDemand("viewer:x", "x", "viewer");
  o.viewsChanged({ activeViewIds: ["viewer"] }); o.releaseDemand("inline:x");
  query.mockResolvedValueOnce(ready(binding("x"))); await o.observe(); expect(o.inspectors.has("x")).toBe(true); expect(query).toHaveBeenCalledTimes(2);
});
it("busy and disconnected observations retain work without requesting immediate scheduler slices", async () => {
  const { o, f, query, scope } = fixture(); f.listDirectory(); o.registerDemand("preview", "x", "viewer");
  scope({ runtimeState: "busy" }); expect(o.needsObservation).toBe(false); await o.observe(); expect(query).not.toHaveBeenCalled();
  scope({ runtimeState: "idle", connected: false }); expect(o.needsObservation).toBe(false); expect(f.needsObservation).toBe(false);
  await o.observe(); await f.observe(); expect(query).not.toHaveBeenCalled(); scope({ connected: true }); expect(o.needsObservation).toBe(true); expect(f.needsObservation).toBe(true);
});
it("a stale release handle cannot cancel a newer registration of the same view token", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe();
  const release = o.registerDemand("viewer:x", "x", "viewer"); o.registerDemand("viewer:x", "x", "viewer"); release();
  expect(o.visibleNames).toEqual(["x"]); expect(o.needsObservation).toBe(true);
});
it("completion names keep a stable identity across unrelated preview publications", async () => {
  const { o, query } = fixture(); query.mockResolvedValueOnce(ready(objects())); await o.observe(); const names = o.completionNames();
  o.registerDemand("viewer:x", "x", "viewer"); query.mockResolvedValueOnce(ready(binding("x"))); await o.observe(); expect(o.completionNames()).toBe(names);
  o.invalidate(); query.mockResolvedValueOnce(ready(objects(2))); await o.observe(); expect(o.completionNames()).toBe(names);
});
