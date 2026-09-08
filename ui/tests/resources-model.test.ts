import { expect, it, vi } from "vitest";
import { Files } from "../src/files";
import type { ResourceIdentity } from "../src/resource-ports";
function ready(data: unknown, session = "session", time = 123) {
  return { target: { kind: "workspace", identity: session }, source: "fixture", status: "ready", data, notices: [], observed_at_ms: time };
}
function fixture() {
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true, capabilities: [] };
  const query = vi.fn(), schedule = vi.fn();
  const ports = { context: () => scope, query, schedule, changed: vi.fn() };
  return { f: new Files(ports), query, schedule, scope: (change: Partial<ResourceIdentity>) => { scope = { ...scope, ...change }; } };
}
const directory = (path = "", names = ["a.R"]) => ({ path, entries: names.map((name) => ({ path: path ? `${path}/${name}` : name,
  name, kind: "regular", byte_size: 1 })), next_name: null, truncated: false, notices: [] });

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
  query.mockResolvedValueOnce(ready({ entries: directory("", ["new.R"]).entries, continuation: null, scanned_entries: 1, scanned_directories: 1, truncated: false, notices: [] }));
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
