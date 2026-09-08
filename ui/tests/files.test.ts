import { expect, it, vi } from "vitest";
import { Files } from "../src/files";
import type { ResourceIdentity } from "../src/resource-ports";
import type { SearchFilesCursor } from "../src/generated/SearchFilesCursor";
const cursor = (after = "last-200", text = "analysis"): SearchFilesCursor => ({ project: "/project", text, show_hidden: false, directories: [{ path: "", after_name: after }] });
const result = (paths: string[], continuation: SearchFilesCursor | null, scanned = paths.length) => ({ entries: paths.map((path) => ({ path, name: path, kind: "regular", byte_size: 1 })),
  continuation, scanned_entries: scanned, scanned_directories: 1, truncated: continuation !== null, notices: continuation ? ["Continue the search from its original cursor."] : [] });
const ready = (data: unknown) => ({ target: { kind: "project", identity: "/project" }, source: "project", status: "ready", data, notices: [], observed_at_ms: 1 });
function fixture() {
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: null, runtimeState: null, connected: true, capabilities: ["project.search_files"] };
  const query = vi.fn(), owner = new Files({ context: () => scope, query, schedule: vi.fn(), changed: vi.fn() });
  owner.setSearchMode(true); owner.setFilter("analysis");
  return { owner, query, scope: (patch: Partial<ResourceIdentity>) => { scope = { ...scope, ...patch }; } };
}
it("continues beyond 200 path results explicitly using the original query and cursor", async () => {
  const f = fixture(), first = Array.from({ length: 200 }, (_, i) => `analysis-${i}.R`), continuation = cursor();
  f.owner.search(); f.query.mockResolvedValueOnce(ready(result(first, continuation))); await f.owner.observe();
  await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(1); expect(f.owner.canContinueSearch).toBe(true);
  f.owner.continueSearch(); f.owner.continueSearch(); f.query.mockResolvedValueOnce(ready(result(["analysis-last.R"], null))); await f.owner.observe();
  expect(f.query.mock.calls[1][2]).toEqual({ text: "analysis", show_hidden: false, continuation }); expect(f.owner.results?.entries).toHaveLength(201); expect(f.owner.results?.scanned_entries).toBe(201); expect(f.owner.canContinueSearch).toBe(false);
});
it("a zero-match scan-budget page still has a usable continuation", async () => {
  const f = fixture(); f.owner.search(); f.query.mockResolvedValueOnce(ready(result([], cursor(), 10000))); await f.owner.observe(); expect(f.owner.results?.entries).toEqual([]); expect(f.owner.canContinueSearch).toBe(true);
  f.owner.continueSearch(); f.query.mockResolvedValueOnce(ready(result(["analysis-target.R"], null, 3))); await f.owner.observe(); expect(f.owner.results?.scanned_entries).toBe(10003); expect(f.owner.results?.entries[0].path).toBe("analysis-target.R");
});
it("failed continuation retains cached pages and retries only the same cursor", async () => {
  const f = fixture(); f.owner.search(); f.query.mockResolvedValueOnce(ready(result(["analysis-a.R"], cursor()))); await f.owner.observe(); f.owner.continueSearch(); f.query.mockRejectedValueOnce(new Error("network lost"));
  await expect(f.owner.observe()).rejects.toThrow("network lost"); expect(f.owner.results?.entries).toHaveLength(1);
  f.query.mockResolvedValueOnce(ready(result(["analysis-b.R"], null))); await f.owner.observe(); expect(f.query.mock.calls[1][2]).toEqual(f.query.mock.calls[2][2]); expect(f.owner.results?.entries).toHaveLength(2);
});
it("filter and hidden-file changes retain labeled cached results without reusing their cursor", async () => {
  const f = fixture(); f.owner.search(); f.query.mockResolvedValueOnce(ready(result(["analysis-a.R"], cursor()))); await f.owner.observe();
  f.owner.setFilter("other"); expect(f.owner.getSnapshot()).toMatchObject({ resultsStale: true, resultsQuery: "analysis", canContinueSearch: false }); f.owner.continueSearch(); await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(1);
  f.owner.search(); f.query.mockResolvedValueOnce(ready(result(["other.R"], null))); await f.owner.observe(); expect(f.query.mock.calls[1][2]).toMatchObject({ text: "other", continuation: null }); expect(f.owner.results?.entries).toHaveLength(1);
  f.owner.setShowHidden(true); expect(f.owner.getSnapshot().resultsStale).toBe(true);
});
it("refresh and project transitions cannot append an old response to a new search", async () => {
  const f = fixture(); f.owner.search(); f.query.mockResolvedValueOnce(ready(result(["analysis-a.R"], cursor()))); await f.owner.observe(); f.owner.continueSearch();
  let release!: (value: ReturnType<typeof ready>) => void; f.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const old = f.owner.observe();
  f.owner.refresh(); release(ready(result(["old-page.R"], null))); await old; expect(f.owner.results?.entries.map((e) => e.path)).toEqual(["analysis-a.R"]); expect(f.owner.canContinueSearch).toBe(false);
  f.scope({ epoch: 2, project: "/other" }); f.owner.reset(); expect(f.owner.results).toBeNull();
});
it("rejects wrong or non-advancing continuation identity instead of merging incompatible pages", async () => {
  const f = fixture(); f.owner.search(); f.query.mockResolvedValueOnce(ready(result(["analysis-a.R"], cursor()))); await f.owner.observe(); f.owner.continueSearch();
  f.query.mockResolvedValueOnce(ready(result(["wrong.R"], cursor()))); await expect(f.owner.observe()).rejects.toThrow("did not advance"); expect(f.owner.results?.entries).toHaveLength(1);
  f.query.mockResolvedValueOnce(ready(result(["wrong.R"], { ...cursor("next"), project: "/other" }))); await expect(f.owner.observe()).rejects.toThrow("does not match"); expect(f.owner.results?.entries).toHaveLength(1);
});
it("stop and disconnection do not start or publish late search reads", async () => {
  const f = fixture(); f.owner.search(); f.scope({ connected: false }); await f.owner.observe(); expect(f.query).not.toHaveBeenCalled();
  f.scope({ connected: true }); let release!: (value: ReturnType<typeof ready>) => void; f.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const old = f.owner.observe(); f.owner.stop(); release(ready(result(["late.R"],null))); await old; expect(f.owner.results).toBeNull();
});
