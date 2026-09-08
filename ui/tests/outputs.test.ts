import { expect, it, vi } from "vitest";
import { Outputs } from "../src/outputs";
import { record as fixtureRecord } from "../src/wire-fixtures";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { OperationSummary } from "../src/generated/OperationSummary";
import type { OutputEvent } from "../src/generated/OutputEvent";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { RequestContext } from "../src/shared/ports";
import { Notifications } from "../src/shared/events";

const snapshot = (data: unknown, status: "ready" | "busy" | "unavailable" = "ready"): QuerySnapshot => ({ target: { kind: "workspace", identity: "/project" }, source: "test", observed_at_ms: 1, status, completeness: "complete", data: data as QuerySnapshot["data"], notices: [] });
const event = (id: string, sequence: number): OutputEvent => ({ operation_id: id, sequence, kind: "stdout", text: `${sequence}\n`, media: null, observed_at_ms: sequence });
const page = (id: string, events: OutputEvent[], has_more = false) => snapshot({ operation_id: id, events, next_sequence: events.at(-1)?.sequence ?? 0, has_more, gap: false, truncated: false, notices: [] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let context: RequestContext = { epoch: 1, project: "/project", session: "session-a", runtimeState: "idle", connected: true, capabilities: [] }, now = 0;
  const records = new Map<string, OperationRecord>(), summaries = new Map<string, OperationSummary>();
  const add = (id: string, cursor = 1, status: OperationRecord["status"] = "succeeded") => {
    records.set(id, { ...fixtureRecord, operation: { ...fixtureRecord.operation, operation_id: id }, status });
    summaries.set(id, { operation_id: id, cursor, client_request_id: id, capability: { id: "workspace.run_r", version: 1 }, status, accepted_at_ms: cursor, updated_at_ms: cursor, error: null });
  };
  const query = vi.fn(), appended = vi.fn(), ensureOperation = vi.fn(async (id: string) => records.get(id) ?? null);
  const listRecent = vi.fn(async () => ({ operations: [...summaries.values()], next_cursor: null }));
  const outputs = new Outputs({ context: () => context, now: () => now, query, appended, operations: { getRecord: (id) => records.get(id), getSummary: (id) => summaries.get(id), ensureOperation, listRecent, records: () => records, summaries: () => summaries } });
  return { outputs, query, add, records, summaries, appended, ensureOperation, listRecent, advance: (ms = 500) => { now += ms; }, context: (value: Partial<RequestContext>) => { context = { ...context, ...value }; } };
}

it("keeps terminal output recoverable after a busy response or a transient read failure", async () => {
  const f = fixture(); f.add("one", 1, "failed"); f.outputs.syncOperations();
  f.query.mockResolvedValueOnce(snapshot(null, "busy")).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(page("one", [event("one", 1)]));
  await f.outputs.step();
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(false);
  f.advance(); await f.outputs.step();
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(false);
  expect(f.outputs.getSnapshot().errors.get("one")).toBe("connection lost");
  f.advance(); await f.outputs.step();
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(true);
  expect(f.outputs.getSnapshot().events.get("one")).toHaveLength(1);
  expect(f.outputs.getSnapshot().errors.has("one")).toBe(false);
});

it.each(["succeeded", "failed", "cancelled", "uncertain"] as const)(
  "drains final text and media when a %s event overtakes an earlier exhausted output response",
  async (status) => {
    const f = fixture(), beforeTerminal = deferred<QuerySnapshot>();
    f.add("one", 1, "running"); f.outputs.syncOperations();
    const text: OutputEvent = { ...event("one", 1), text: "final text\n" };
    const plot: OutputEvent = {
      ...event("one", 2), kind: "media", text: null,
      media: { operation_id: "one", sequence: 2, mime_type: "image/png", byte_size: 1, sha256: `sha256:${"a".repeat(64)}`, display_id: null },
    };
    f.query.mockReturnValueOnce(beforeTerminal.promise).mockImplementationOnce(async () => {
      expect(f.outputs.getSnapshot().completed.has("one")).toBe(false);
      return page("one", [text, plot]);
    });
    const reading = f.outputs.step();
    // The Host read an empty page while running. Its HTTP response arrives only
    // after R wrote its final output and Operations observed the terminal record.
    f.add("one", 1, status);
    f.outputs.operationChanged({ epoch: 1, project: "/project", operationId: "one", capability: "workspace.run_r", status, cursor: 1 });
    beforeTerminal.resolve(page("one", []));
    await reading;
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.map((call) => call[2].after_sequence)).toEqual([0, 0]);
    expect(f.outputs.getSnapshot().events.get("one")).toEqual([text, plot]);
    expect(f.outputs.getSnapshot().media).toEqual([plot.media]);
    expect(f.outputs.getSnapshot().completed.has("one")).toBe(true);
    expect(f.appended).toHaveBeenCalledTimes(1);
  },
);

it("does not commit any part of a malformed page, then merges repeated pages by output identity", async () => {
  const f = fixture(); f.add("one"); f.outputs.syncOperations();
  f.query.mockResolvedValueOnce(page("one", [event("one", 1), event("foreign", 2)]));
  await f.outputs.step();
  expect(f.outputs.getSnapshot().cursors.get("one")).toBe(0);
  expect(f.outputs.getSnapshot().events.size).toBe(0);
  expect(f.appended).not.toHaveBeenCalled();
  f.advance(); f.query.mockResolvedValue(page("one", [event("one", 1), event("one", 2)]));
  await f.outputs.step();
  f.outputs.retry("one"); await f.outputs.step();
  expect(f.outputs.getSnapshot().events.get("one")?.map((entry) => entry.sequence)).toEqual([1, 2]);
  expect(f.appended).toHaveBeenCalledTimes(1);
});

it("validates page metadata before advancing its cursor", async () => {
  const f = fixture(); f.add("one"); f.outputs.syncOperations();
  f.query.mockResolvedValue(snapshot({ operation_id: "one", events: [event("one", 1)], next_sequence: 1, has_more: false, gap: false, truncated: false }));
  await f.outputs.step();
  expect(f.outputs.getSnapshot().cursors.get("one")).toBe(0);
  expect(f.outputs.getSnapshot().events.size).toBe(0);
});

it("yields after two bounded pages while retaining later output for the next turn", async () => {
  const f = fixture(); f.add("one"); f.outputs.syncOperations();
  f.query.mockImplementation(async (_project, _capability, args) => {
    const from = args.after_sequence, end = Math.min(250, from + 100);
    return page("one", Array.from({ length: end - from }, (_, index) => event("one", from + index + 1)), end < 250);
  });
  await f.outputs.step();
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.outputs.getSnapshot().events.get("one")).toHaveLength(200);
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(false);
  await f.outputs.step();
  expect(f.outputs.getSnapshot().events.get("one")).toHaveLength(250);
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(true);
});

it("pauses explicitly unavailable output with a visible retry and preserves gap and truncation notices", async () => {
  const f = fixture(); f.add("one"); f.outputs.syncOperations();
  f.query.mockResolvedValueOnce(snapshot(null, "unavailable"));
  await f.outputs.step(); f.advance(10000); await f.outputs.step();
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(false);
  expect(f.outputs.getSnapshot().notices.get("one")).toMatch(/unavailable/);
  f.outputs.retry("one");
  f.query.mockResolvedValueOnce(snapshot({ operation_id: "one", events: [], next_sequence: 2, has_more: false, gap: true, truncated: true, notices: [] }));
  await f.outputs.step();
  expect(f.outputs.getSnapshot().completed.has("one")).toBe(true);
  expect(f.outputs.getSnapshot().notices.get("one")).toMatch(/Some output/);
  expect(f.outputs.getSnapshot().notices.get("one")).toMatch(/observation limit/);
});

it("requires authoritative operation ordering before exposing media and orders media by summary cursor", async () => {
  const f = fixture(); f.add("later", 20); f.add("earlier", 10);
  f.summaries.delete("earlier"); f.outputs.syncOperations();
  const mediaEvent = (id: string): OutputEvent => ({ ...event(id, 1), kind: "display", text: null, media: { operation_id: id, sequence: 1, mime_type: "image/png", byte_size: 1, sha256: `sha256:${"a".repeat(64)}`, display_id: null } });
  f.query.mockImplementation(async (_project, _capability, args) => page(args.operation_id, [mediaEvent(args.operation_id)]));
  await f.outputs.step();
  expect(f.outputs.getSnapshot().media.map((ref) => ref.operation_id)).toEqual(["later"]);
  f.add("earlier", 10); f.outputs.syncOperations(); f.advance(); await f.outputs.step();
  expect(f.outputs.getSnapshot().media.map((ref) => ref.operation_id)).toEqual(["earlier", "later"]);
});

it("invalidates memoized output visibility when a typed notification marks its authoritative record unreadable", async () => {
  const f = fixture(), notifications = new Notifications();
  const unsubscribe = notifications.on("operationChanged", (change) => f.outputs.operationChanged(change));
  f.add("one", 1, "running"); f.outputs.syncOperations();
  const plot: OutputEvent = {
    ...event("one", 1), kind: "media", text: null,
    media: { operation_id: "one", sequence: 1, mime_type: "image/png", byte_size: 1, sha256: `sha256:${"a".repeat(64)}`, display_id: null },
  };
  f.query.mockResolvedValue(page("one", [plot]));
  await f.outputs.step();
  const readable = f.outputs.getSnapshot(), requests = f.query.mock.calls.length;
  expect(readable.media).toEqual([plot.media]);
  expect(readable.events.get("one")).toEqual([plot]);
  f.records.delete("one");
  // Without an owner notification this is still the cached snapshot, proving
  // the test does not accidentally refresh through a global UI subscription.
  expect(f.outputs.getSnapshot()).toBe(readable);
  f.appended.mockClear();
  notifications.send("operationChanged", { epoch: 1, project: "/project", operationId: "one", capability: "workspace.run_r", status: "unreadable", cursor: 1 });
  const hidden = f.outputs.getSnapshot();
  expect(hidden).not.toBe(readable);
  expect(hidden.media).toEqual([]);
  expect(hidden.events.has("one")).toBe(false);
  expect(hidden.records.has("one")).toBe(false);
  expect(hidden.cursors.has("one")).toBe(false);
  await f.outputs.step();
  expect(f.query).toHaveBeenCalledTimes(requests);
  expect(f.appended).not.toHaveBeenCalled();
  unsubscribe(); notifications.dispose(); f.outputs.stop();
});

it("drops A-to-B-to-A completions and prevents an old finally from releasing a newer request", async () => {
  const f = fixture(), old = deferred<QuerySnapshot>(), current = deferred<QuerySnapshot>();
  f.add("one"); f.outputs.syncOperations();
  f.query.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const previousRun = f.outputs.step();
  f.context({ epoch: 2, project: "/other" }); f.outputs.reset();
  f.context({ epoch: 3, project: "/project" }); f.outputs.reset(); f.outputs.syncOperations();
  const currentRun = f.outputs.step();
  old.reject(new Error("old connection")); await previousRun;
  await f.outputs.step();
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.outputs.getSnapshot().errors.size).toBe(0);
  current.resolve(page("one", [event("one", 1)])); await currentRun;
  expect(f.outputs.getSnapshot().events.get("one")).toHaveLength(1);
  f.outputs.stop();
});

it("reads pinned historical media without R and treats a confirmed unreadable association as absent", async () => {
  const f = fixture(); f.context({ session: null, runtimeState: null });
  f.add("old", 1);
  f.outputs.restoreReferences([`missing:1:sha256:${"a".repeat(64)}`, `old:1:sha256:${"a".repeat(64)}`]);
  f.query.mockResolvedValue(snapshot({ operation_id: "old", media: [{ reference: { operation_id: "old", sequence: 1, mime_type: "image/png", byte_size: 1, sha256: `sha256:${"a".repeat(64)}`, display_id: null }, observed_at_ms: 123 }], next_sequence: 1, has_more: false, gap: false }));
  await f.outputs.step(); await f.outputs.step();
  expect(f.ensureOperation).toHaveBeenCalledWith("missing");
  expect(f.outputs.getSnapshot().media.map((ref) => ref.operation_id)).toEqual(["old"]);
  expect(f.outputs.getSnapshot().errors.size).toBe(0);
  expect(f.query).toHaveBeenCalledWith("/project", "workspace.list_outputs", expect.anything());
});

it("retains completed historical output while fencing reads at a same-project R restart", async () => {
  const f = fixture(); f.add("old", 1); f.outputs.syncOperations(); f.query.mockResolvedValueOnce(page("old", [event("old", 1)]));
  await f.outputs.step();
  f.add("current", 2); f.outputs.syncOperations();
  const read = deferred<QuerySnapshot>(); f.query.mockReturnValueOnce(read.promise);
  const pending = f.outputs.step();
  f.context({ epoch: 2, session: "session-b" }); f.outputs.sessionChanged();
  read.resolve(page("current", [event("current", 1)])); await pending;
  expect(f.outputs.getSnapshot().events.get("old")).toHaveLength(1);
  expect(f.outputs.getSnapshot().events.has("current")).toBe(false);
  f.query.mockResolvedValueOnce(page("current", [event("current", 1)])); await f.outputs.step();
  expect(f.outputs.getSnapshot().events.get("current")).toHaveLength(1);
});
