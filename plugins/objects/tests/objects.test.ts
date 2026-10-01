import { afterEach, expect, it, vi } from "vitest";
import { Objects } from "../src/objects";
import type { ResourceIdentity } from "../src/resource-ports";
import type { ObjectMetadata } from "../public/r-protocol/index.js";
import type { ObjectReadPage } from "../public/r-protocol/index.js";
const capabilities = ["r.list_objects", "r.observe_object", "r.read_object"];
const metadata = (kind = "value", length = 1): ObjectMetadata => ({ kind, object_type: kind === "value" ? "double" : null, classes: [], length: kind === "value" ? length : null,
  dimensions: [], supported_reads: kind === "value" ? ["structure", "values"] : ["structure"], attributes: [], notice: kind === "value" ? null : "Only binding metadata is available." });
const directory = (names = ["x"], offset = 0, next: number | null = null, reference = "directory-1", length = 1) => ({ directory_ref: reference, entries: names.map((name) => ({ name, metadata: metadata("value", length) })), total: next === null ? offset + names.length : next + 1, offset, next_offset: next, observed_at_ms: 123, complete: next === null, notices: [] });
const observed = (name: string, reference = `ref-${name}`, m = metadata()) => ({ object_ref: reference, name, path: [], metadata: m, observed_at_ms: 123, expires_at_ms: 60123 });
const page = (name: string, reference = `ref-${name}`, kind: ObjectReadPage["kind"] = "values", m = metadata(), value = 1): ObjectReadPage => ({ object_ref: reference, root_name: name, observed_path: [], path: [], kind, metadata: m,
  values: kind === "values" ? [{ kind: "value", object_type: "double", logical: null, number: value, imaginary: null, text: null, label: null, text_characters: null, next_text_start: null }] : [], children: [], columns: [],
  start: 1, next_start: null, column_start: 1, next_column_start: null, text_start: 1, next_text_start: null, observed_at_ms: 123, complete: true, notices: [] });
const ready = (data: unknown, session = "session") => ({ session_id: session, source: "native-fixture", observed_at_ms: 123, status: "ready", data, notices: [], completeness: "complete", diagnostic: null });
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(123);
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true, capabilities };
  const query = vi.fn(async (_project: string, capability: string, args: Record<string, unknown>) => ready(capability === "r.list_objects" ? directory() : capability === "r.observe_object" ? observed(String(args.name)) : page(String(args.object_ref).replace(/^ref-/, ""), String(args.object_ref), args.kind as ObjectReadPage["kind"]), scope.session!));
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
  await f.owner.observe(); expect(f.owner.selection).toEqual({ name: "x", object_ref: "ref-x", native_session_id: "session" });
  await f.owner.observe(); expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]);
  expect(f.query.mock.calls.map(([, capability]) => capability)).toEqual(capabilities);
  releaseInline(); f.owner.invalidate(); expect(f.owner.selection).toBeNull(); await f.owner.observe(); await f.owner.observe(); await f.owner.observe(); expect(f.owner.visibleNames).toEqual(["x"]); releaseViewer(); expect(f.owner.visibleNames).toEqual([]);
});
it("busy state retains actual preview time and selection without issuing native reads or fabricating references", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe(); const selected = f.owner.selection;
  f.scope({ runtimeState: "busy" }); f.owner.inspect("x"); await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(3); expect(f.owner.selection).toEqual(selected); expect(f.owner.inspectors.get("x")?.observedAt).toBe(123);
  f.owner.inspect("unknown"); await f.owner.observe(); expect(f.owner.selected).toBe("unknown"); expect(f.owner.selection).toBeNull();
});
it.each(["running", "failed", "cancelled", "uncertain", "succeeded"])("R execution %s invalidates directory and object identities without replay", async (status) => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe();
  f.owner.operationChanged({ epoch: 1, project: "/project", operationId: "op", session: "session", capability: "r.execute", status, cursor: 1 });
  expect(f.owner.stale).toBe(true); expect(f.owner.selection).toBeNull(); expect(f.owner.inspectors.get("x")?.stale).toBe(true); expect(f.query).toHaveBeenCalledTimes(3);
});
it("unrelated project events do not invalidate the current object directory", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.operationChanged({ epoch: 1, project: "/other", operationId: "op", session: "session", capability: "r.execute", status: "succeeded", cursor: 1 }); expect(f.owner.stale).toBe(false);
});
it("another native session cannot invalidate this view through an execution event", async () => {
  const f = fixture(); await f.owner.observe();
  f.owner.operationChanged({ epoch: 1, project: "/project", session: "other-session", operationId: "foreign", capability: "r.execute", status: "succeeded", cursor: 2 });
  expect(f.owner.stale).toBe(false); expect(f.query).toHaveBeenCalledTimes(1);
});
it.each(["observation_expired", "observation_invalid", "content_changed", "budget_exhausted"])("native %s envelopes keep cached evidence and require explicit refresh", async code => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe();
  f.owner.inspect("x");
  f.query.mockResolvedValueOnce({ ...ready(null), status: "unavailable", completeness: "unknown", diagnostic: { code, message: "Original observation cannot continue" } } as never);
  await f.owner.observe();
  expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]);
  expect(f.owner.inspectors.get("x")?.stale).toBe(true); expect(f.owner.selection).toBeNull();
  expect(f.owner.notice).toContain(code); expect(f.owner.needsObservation).toBe(false);
  await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(4);
  f.owner.inspect("x"); await f.owner.observe(); expect(f.query.mock.calls.at(-1)?.[1]).toBe("r.observe_object");
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
  expect(f.owner.inspectors.size).toBe(0); expect(f.owner.visibleNames).toEqual(["x"]); expect(f.owner.selection).toBeNull();
  await f.owner.observe(); await f.owner.observe(); await f.owner.observe(); expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]);
});
it("transport retry retains the same read reference and does not open a replacement observation", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); f.query.mockRejectedValueOnce(new Error("temporary network failure"));
  await expect(f.owner.observe()).rejects.toThrow("temporary"); await f.owner.observe();
  expect(f.query.mock.calls[2][2]).toEqual(f.query.mock.calls[3][2]); expect(f.query.mock.calls.filter(([, id]) => id === "r.observe_object")).toHaveLength(1);
});
it("reference expiry requires explicit refresh and never silently combines old pagination", async () => {
  const f = fixture(); f.query.mockResolvedValueOnce(ready(directory(["x"], 0, 1))); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe();
  f.clock.mockReturnValue(60124); await f.owner.observe(); expect(f.owner.selection).toBeNull(); expect(f.owner.canLoadMore).toBe(false); expect(f.owner.needsObservation).toBe(false); expect(f.query).toHaveBeenCalledTimes(3); expect(f.owner.inspectors.get("x")?.stale).toBe(true);
  f.owner.refresh(); f.clock.mockReturnValue(124); f.query.mockResolvedValueOnce(ready(directory(["replacement"], 0, null, "directory-2"))); await f.owner.observe(); expect(f.owner.data?.objects.map((d) => d.name)).toEqual(["replacement"]);
});
it.each(["promise", "active_binding", "unsupported_class"])("%s exposes metadata and a real reference without any value read", async (kind) => {
  const f = fixture(), m = metadata(kind); await f.owner.observe(); f.owner.inspect("x"); f.query.mockResolvedValueOnce(ready(observed("x", "ref-x", m))).mockResolvedValueOnce(ready(page("x", "ref-x", "structure", m)));
  await f.owner.observe(); await f.owner.observe(); expect(f.owner.selection?.object_ref).toBe("ref-x"); expect(f.owner.inspectors.get("x")?.binding.preview).toBeNull(); expect(f.query.mock.calls.at(-1)?.[2].kind).toBe("structure"); expect(f.owner.needsObservation).toBe(false);
});
it("owner-reported expiry blocks retries until explicit refresh and preserves cached values", async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect("x"); await f.owner.observe(); await f.owner.observe(); f.owner.inspect("x"); f.query.mockRejectedValueOnce(new Error("observation_expired: original reference ended"));
  await expect(f.owner.observe()).rejects.toThrow("observation_expired"); expect(f.owner.selection).toBeNull(); expect(f.owner.needsObservation).toBe(false); expect(f.owner.inspectors.get("x")?.binding.preview).toEqual([1]); expect(f.owner.inspectors.get("x")?.stale).toBe(true);
  f.owner.inspect("x"); await f.owner.observe(); expect(f.query.mock.calls.at(-1)?.[1]).toBe("r.observe_object");
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
  f.owner.selectObservation(selection); expect(f.owner.selection).toBeNull();
  expect(() => f.owner.selectObservation(selection, { ...page("x"), observed_path: [{ kind: "index", index: 1 }] })).toThrow("root binding");
  f.owner.selectObservation(selection, page("x", "ref-x", "structure")); expect(f.owner.selection).toEqual(selection);
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

async function settleCopy<T>(f: ReturnType<typeof fixture>, task: Promise<T>) {
  let result!: T, failure: unknown, settled = false;
  task.then(value => { result = value; settled = true; }, error => { failure = error; settled = true; });
  for (let i = 0; i < 2000 && !settled; i++) { await Promise.resolve(); if (f.owner.needsObservation) await f.owner.observe(); }
  expect(settled).toBe(true);
  if (failure) throw failure;
  return result;
}
it('whole-vector copy joins pages, full Unicode text and duplicate names on one reference', async () => {
  const f = fixture(), m = { ...metadata('value', 201), object_type: 'character', supported_reads: ['values', 'names', 'text'] as const } as ObjectMetadata;
  const scalar = (text: string) => ({ ...page('x').values[0], object_type: 'character', number: null, text });
  f.query.mockImplementation(async (_project, capability, args) => {
    if (capability === 'r.list_objects') return ready(directory());
    if (capability === 'r.observe_object') return ready(observed('x', 'ref-x', m));
    const start = Number(args.start ?? 1), limit = Number(args.limit ?? 20), kind = args.kind as ObjectReadPage['kind'];
    if (kind === 'text') return ready({ ...page('x', 'ref-x', 'text', m), start, values: [scalar('尾部')], next_text_start: null });
    const values = Array.from({ length: Math.min(limit, 202 - start) }, (_, i) => kind === 'names' ? scalar('重复名') : scalar(`value${start + i}`));
    if (kind === 'values' && start === 1) values[0] = { ...scalar('首部'), next_text_start: 3 };
    return ready({ ...page('x', 'ref-x', kind, m), start, values, next_start: start + values.length <= 201 ? start + values.length : null });
  });
  await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  const copied = await settleCopy(f, f.owner.collectVector('x', [], { reference: 'ref-x' }));
  expect(copied.values).toHaveLength(201); expect(copied.values[0].text).toBe('首部尾部'); expect(copied.values[0].next_text_start).toBeNull();
  expect(copied.values[200].text).toBe('value201'); expect(copied.names?.map(v => v.text)).toEqual(Array(201).fill('重复名'));
  expect(f.query.mock.calls.filter(([, c]) => c === 'r.observe_object')).toHaveLength(1);
  expect(f.query.mock.calls.filter(([, c]) => c === 'r.read_object').every(([, , a]) => a.object_ref === 'ref-x')).toBe(true);
});
it('copy rejects a prematurely ended native vector instead of returning a partial whole', async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  f.query.mockResolvedValueOnce(ready(page('x', 'ref-x', 'values', metadata('value', 20))));
  await expect(settleCopy(f, f.owner.collectVector('x', [], { reference: 'ref-x' }))).rejects.toThrow('complete vector');
});
it('copy rejects a changed observation and does not read while R is busy', async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  const task = f.owner.collectVector('x', [], { reference: 'ref-x' });
  const rejected = expect(task).rejects.toThrow(/observation changed/i);
  f.owner.invalidate(); await rejected;
  await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  f.scope({ runtimeState: 'busy' }); const calls = f.query.mock.calls.length;
  await expect(f.owner.collectVector('x', [], { reference: 'ref-x' })).rejects.toThrow('busy');
  expect(f.query).toHaveBeenCalledTimes(calls);
});

it('an in-progress whole copy waits through background capture without changing its reference', async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  const m = metadata('value', 201);
  f.query.mockImplementation(async (_project, _capability, args) => {
    const start = Number(args.start ?? 1), count = start === 1 ? 200 : 1;
    if (start === 1) f.scope({ runtimeState: 'busy' });
    return ready({ ...page('x', 'ref-x', 'values', m), start, values: Array.from({ length: count }, () => page('x').values[0]), next_start: start === 1 ? 201 : null });
  });
  const copying = f.owner.collectVector('x', [], { reference: 'ref-x' });
  await f.owner.observe();
  for (let i = 0; i < 500; i++) await Promise.resolve();
  const count = f.query.mock.calls.length;
  f.owner.operationChanged({ epoch: 1, project: '/project', operationId: 'save', session: 'session', capability: 'workspace.checkpoint_capture', status: 'succeeded', cursor: 1 });
  await f.owner.observe(); expect(f.query).toHaveBeenCalledTimes(count);
  expect(f.owner.selection?.object_ref).toBe('ref-x');
  f.scope({ runtimeState: 'idle' });
  const result = await settleCopy(f, copying); expect(result.values).toHaveLength(201);
});

it('a busy native detail keeps its original pending request and cancellation can release it', async () => {
  const f = fixture(); await f.owner.observe(); f.owner.inspect('x'); await f.owner.observe(); await f.owner.observe();
  let cancelled = false;
  const reading = f.owner.readPage('x', { kind: 'values', start: 1, limit: 1 }, { cancelled: () => cancelled });
  f.query.mockResolvedValueOnce({ ...ready(null), status: 'busy' }); await f.owner.observe();
  let settled = false; const done = reading.catch(error => { settled = true; return error; });
  await Promise.resolve(); expect(settled).toBe(false);
  cancelled = true; await f.owner.observe(); expect((await done).message).toContain('cancelled');
});
