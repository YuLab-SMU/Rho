import { afterEach, expect, it, vi } from "vitest";
import { Objects } from "../src/objects";
import type { ResourceIdentity } from "../src/resource-ports";
import type { ObjectMetadata } from "../src/generated/ObjectMetadata";
import type { ObjectReadPage } from "../src/generated/ObjectReadPage";
const capabilities = ["workspace.list_objects", "workspace.observe_object", "workspace.read_object"];
const metadata = (kind = "value", length = 1): ObjectMetadata => ({ kind, object_type: kind === "value" ? "double" : null, classes: [], length: kind === "value" ? length : null,
  dimensions: [], supported_reads: kind === "value" ? ["structure", "values"] : ["structure"], attributes: [], notice: kind === "value" ? null : "Only binding metadata is available." });
const directory = (names = ["x"], offset = 0, next: number | null = null, reference = "directory-1", length = 1) => ({ directory_ref: reference, entries: names.map((name) => ({ name, metadata: metadata("value", length) })), total: next === null ? offset + names.length : next + 1, offset, next_offset: next, observed_at_ms: 123, complete: next === null, notices: [] });
const observed = (name: string, reference = `ref-${name}`, m = metadata()) => ({ object_ref: reference, name, path: [], metadata: m, observed_at_ms: 123, expires_at_ms: 60123 });
const page = (name: string, reference = `ref-${name}`, kind: ObjectReadPage["kind"] = "values", m = metadata(), value = 1): ObjectReadPage => ({ object_ref: reference, root_name: name, observed_path: [], path: [], kind, metadata: m,
  values: kind === "values" ? [{ kind: "value", object_type: "double", logical: null, number: value, imaginary: null, text: null, label: null, text_characters: null, next_text_start: null }] : [], children: [], columns: [],
  start: 1, next_start: null, column_start: 1, next_column_start: null, text_start: 1, next_text_start: null, observed_at_ms: 123, complete: true, notices: [] });
const ready = (data: unknown, session = "session") => ({ target: { kind: "workspace", identity: session }, source: "native-fixture", observed_at_ms: 123, status: "ready", data, notices: [], diagnostics: [] });
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(123);
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true, capabilities };
  const query = vi.fn(async (_project: string, capability: string, args: Record<string, unknown>) => ready(capability === "workspace.list_objects" ? directory() : capability === "workspace.observe_object" ? observed(String(args.name)) : page(String(args.object_ref).replace(/^ref-/, ""), String(args.object_ref), args.kind as ObjectReadPage["kind"]), scope.session!));
  const schedule = vi.fn(), changed = vi.fn(), owner = new Objects({ context: () => scope, query: query as never, schedule, changed });
  return { owner, query, schedule, changed, clock, scope: (patch: Partial<ResourceIdentity>) => { scope = { ...scope, ...patch }; } };
}

it("opens one bounded directory without implicitly draining later pages", async () => {
  const f = fixture(); f.query.mockResolvedValueOnce(ready(directory(Array.from({ length: 200 }, (_, i) => `x${i}`), 0, 200)));
  await f.owner.observe(); await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(1); expect(f.owner.data?.objects).toHaveLength(200); expect(f.owner.canLoadMore).toBe(true);
  f.owner.loadMore(); f.query.mockResolvedValueOnce(ready(directory(["last"], 200))); await f.owner.observe();
  expect(f.query.mock.calls[1][2]).toMatchObject({ directory_ref: "directory-1", offset: 200, expected_session: "session", limit: 200 }); expect(f.owner.data?.objects).toHaveLength(201); expect(f.owner.canLoadMore).toBe(false);
});
it("normal human expansion obtains an exact reference shared by inline and dedicated preview demand", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.setExpanded("x", true);
  const releaseInline = f.owner.registerDemand("inline:x", "x", "objects"), releaseViewer = f.owner.registerDemand("viewer:x", "x", "viewer");
  await f.owner.observe(); expect(f.owner.applicationSelection).toEqual({ name: "x", object_ref: "ref-x", native_session_id: "session" });
  await f.owner.observe(); expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]);
  expect(f.query.mock.calls.map(([, capability]) => capability)).toEqual(capabilities);
  releaseInline(); f.owner.invalidate(); expect(f.owner.applicationSelection).toBeNull(); await f.owner.observe(); await f.owner.observe(); await f.owner.observe(); expect(f.owner.visibleNames).toEqual(["x"]); releaseViewer(); expect(f.owner.visibleNames).toEqual([]);
});
it("busy state retains actual preview time and selection without issuing native reads or fabricating references", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe(); const selected = f.owner.applicationSelection;
  f.scope({ runtimeState: "busy" }); f.owner.inspect("x"); await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(3); expect(f.owner.applicationSelection).toEqual(selected); expect(f.owner.inspectors.get("x")?.observedAt).toBe(123);
  f.owner.inspect("unknown"); await f.owner.observe(); expect(f.owner.selected).toBe("unknown"); expect(f.owner.applicationSelection).toBeNull();
});
it.each(["running", "failed", "cancelled", "uncertain", "succeeded"])("workspace %s invalidates directory and object identities without replay", async (status) => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe();
  f.owner.operationChanged({ epoch: 1, project: "/project", operationId: "op", capability: "workspace.run_r", status, cursor: 1 });
  expect(f.owner.stale).toBe(true); expect(f.owner.applicationSelection).toBeNull(); expect(f.owner.inspectors.get("x")?.stale).toBe(true); expect(f.query).toHaveBeenCalledTimes(3);
});
it("unrelated project events do not invalidate the current object directory", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.operationChanged({ epoch: 1, project: "/other", operationId: "op", capability: "workspace.run_r", status: "succeeded", cursor: 1 }); expect(f.owner.stale).toBe(false);
});
it("A → B → A and late cleanup cannot replace a newer directory request", async () => {
  const f = fixture(); let reject!: (error: Error) => void, release!: (data: ReturnType<typeof ready>) => void;
  f.query.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; })); const old = f.owner.observe();
  f.scope({ epoch: 2, project: "/other" }); f.owner.reset(); f.scope({ epoch: 3, project: "/project" }); f.owner.reset();
  f.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const current = f.owner.observe();
  reject(new Error("old error")); await old; expect(f.owner.loading).toBe(true); expect(f.owner.notice).toBe(""); release(ready(directory(["new"]))); await current; expect(f.owner.data?.objects[0].name).toBe("new");
});
it("R restart fences old previews while retaining active view demand", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.registerDemand("view:x", "x", "viewer"); await f.owner.observe();
  let release!: (data: ReturnType<typeof ready>) => void; f.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const old = f.owner.observe();
  f.scope({ session: "new-session" }); f.owner.sessionChanged(); release(ready(page("x"))); await old;
  expect(f.owner.inspectors.size).toBe(0); expect(f.owner.visibleNames).toEqual(["x"]); expect(f.owner.applicationSelection).toBeNull();
  await f.owner.observe(); await f.owner.observe(); await f.owner.observe(); expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]);
});
it("transport retry retains the same read reference and does not open a replacement observation", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); f.query.mockRejectedValueOnce(new Error("temporary network failure"));
  await expect(f.owner.observe()).rejects.toThrow("temporary"); await f.owner.observe();
  expect(f.query.mock.calls[2][2]).toEqual(f.query.mock.calls[3][2]); expect(f.query.mock.calls.filter(([, id]) => id === "workspace.observe_object")).toHaveLength(1);
});
it("reference expiry requires explicit refresh and never silently combines old pagination", async () => {
  const f = fixture(); f.query.mockResolvedValueOnce(ready(directory(["x"], 0, 1))); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe();
  f.clock.mockReturnValue(60124); await f.owner.observe(); expect(f.owner.applicationSelection).toBeNull(); expect(f.owner.canLoadMore).toBe(false); expect(f.owner.needsObservation).toBe(false); expect(f.query).toHaveBeenCalledTimes(3); expect(f.owner.inspectors.get("x")?.stale).toBe(true);
  f.owner.refresh(); f.clock.mockReturnValue(124); f.query.mockResolvedValueOnce(ready(directory(["replacement"], 0, null, "directory-2"))); await f.owner.observe(); expect(f.owner.data?.objects.map((d) => d.name)).toEqual(["replacement"]);
});
it.each(["promise", "active_binding", "unsupported_class"])("%s exposes metadata and a real reference without any value read", async (kind) => {
  const f = fixture(), m = metadata(kind); await f.owner.observe(); f.owner.inspect("x"); f.query.mockResolvedValueOnce(ready(observed("x", "ref-x", m))).mockResolvedValueOnce(ready(page("x", "ref-x", "structure", m)));
  await f.owner.observe(); await f.owner.observe(); expect(f.owner.applicationSelection?.object_ref).toBe("ref-x"); expect(f.owner.inspectors.get("x")?.binding.preview).toBeNull(); expect(f.query.mock.calls.at(-1)?.[2].kind).toBe("structure"); expect(f.owner.needsObservation).toBe(false);
});
it("owner-reported expiry blocks retries until explicit refresh and preserves cached values", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe(); f.owner.inspect("x"); f.query.mockRejectedValueOnce(new Error("observation_expired: original reference ended"));
  await expect(f.owner.observe()).rejects.toThrow("observation_expired"); expect(f.owner.applicationSelection).toBeNull(); expect(f.owner.needsObservation).toBe(false); expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]); expect(f.owner.inspectors.get("x")?.stale).toBe(true);
  f.owner.inspect("x"); await f.owner.observe(); expect(f.query.mock.calls.at(-1)?.[1]).toBe("workspace.observe_object");
});
it("inactive retained views and stale release callbacks cannot schedule or cancel another view", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.viewsChanged({ activeViewIds: ["objects"] });
  const stale = f.owner.registerDemand("shared", "x", "objects"); f.owner.registerDemand("shared", "x", "viewer"); stale();
  f.owner.viewsChanged({ activeViewIds: [] }); f.owner.registerDemand("late", "x", "viewer"); await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(1);
  f.owner.viewsChanged({ activeViewIds: ["viewer"] }); await f.owner.observe(); await f.owner.observe(); expect(f.owner.visibleNames).toEqual(["x"]); expect(f.owner.inspectors.has("x")).toBe(true);
});
it("a stopped owner ignores late results and retains completion-name identity across preview work", async () => {
  const f = fixture(); await f.owner.observe(); const names = f.owner.completionNames(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe(); expect(f.owner.completionNames()).toBe(names);
  f.owner.refresh(); let release!: (value: ReturnType<typeof ready>) => void; f.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })); const old = f.owner.observe(); f.owner.stop(); release(ready(directory(["late"]))); await old; expect(f.owner.completionNames()).toBe(names);
});
it("Agent-provided references are adopted only from matching native root evidence", async () => {
  const f = fixture(); await f.owner.observe(); const selection = { name: "x", object_ref: "ref-x", native_session_id: "session" };
  f.owner.selectObservation(selection); expect(f.owner.applicationSelection).toBeNull();
  expect(() => f.owner.selectObservation(selection, { ...page("x"), observed_path: [{ kind: "index", index: 1 }] })).toThrow("root binding");
  f.owner.selectObservation(selection, page("x", "ref-x", "structure")); expect(f.owner.applicationSelection).toEqual(selection);
});

it("deduplicates detail pages on the original observation and fences late responses", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  const options = { kind: 'values' as const, start: 101, limit: 20 };
  const first = f.owner.readPage('x', options), second = f.owner.readPage('x', options);
  expect(second).toBe(first);
  f.query.mockResolvedValueOnce(ready({ ...page('x'), start: 101 })); await f.owner.observe();
  expect((await first).start).toBe(101);
  expect(await f.owner.readPage('x', options)).toEqual(await second);
  expect(f.query).toHaveBeenCalledTimes(4);
  let release!: (value: ReturnType<typeof ready>) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.owner.readPage('x', { kind: 'values', start: 121 });
  const rejected = expect(pending).rejects.toThrow('observation changed');
  const inFlight = f.owner.observe(); f.owner.invalidate(); release(ready({ ...page('x'), start: 121 }));
  await inFlight; await rejected;
  expect(f.owner.inspectors.get('x')?.stale).toBe(true);
});
