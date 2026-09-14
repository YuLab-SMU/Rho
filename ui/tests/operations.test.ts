import { afterEach, expect, it, vi } from "vitest";
import { Operations } from "../src/operations";
import { Notifications } from "../src/shared/events";
import type { RequestContext } from "../src/shared/ports";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { OperationSummary } from "../src/generated/OperationSummary";
import type { OutboxRecord } from "../src/generated/OutboxRecord";
import type { Invocation } from "../src/generated/Invocation";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const observed = (data: unknown): QuerySnapshot => ({ target: { kind: "project", identity: "/a" }, source: "journal", observed_at_ms: 1,
  status: "ready", completeness: "complete", notices: [], data: data as QuerySnapshot["data"] });
function record(n: number, project = "/a", requestId = `request-${n}`): OperationRecord {
  return { operation: { operation_id: `op-${n}`, client_request_id: requestId, caller: { kind: "human", id: "user" },
    capability: { id: "workspace.run_r", version: 1 }, domain: "workspace", target: { kind: "workspace", identity: "session-a" },
    normalized_arguments: { code: `x <- ${n}` }, invocation_digest: `digest-${n}`, idempotency_scope: project,
    preconditions: [], potential_effects: [], correlation_id: `op-${n}`, causation_id: null, trace_parent: null, accepted_at_ms: n },
    status: "succeeded", outcome: null, output: null, error: null, recovery: null, cancellation_requested: false, updated_at_ms: n };
}
const summary = (r: OperationRecord): OperationSummary => ({ cursor: r.operation.accepted_at_ms,
  operation_id: r.operation.operation_id, client_request_id: r.operation.client_request_id, capability: r.operation.capability,
  status: r.status, accepted_at_ms: r.operation.accepted_at_ms, updated_at_ms: r.updated_at_ms, error: r.error });
const event = (sequence: number, operationId = `op-${sequence}`): OutboxRecord => ({ sequence, operation_id: operationId,
  message_id: `event-${sequence}`, topic: "operation.changed", payload: {}, created_at_ms: sequence, delivered_at_ms: null });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/a", session: "session-a", runtimeState: "idle", connected: true, capabilities: ["workspace.run_r"] };
  const records = new Map<string, OperationRecord>(), events: OutboxRecord[] = [], notifications = new Notifications();
  const query = vi.fn(async (_project: string, id: string, args: unknown = {}) => {
    if (id === "operation.events_checkpoint") return observed({ sequence: events.at(-1)?.sequence ?? 0 });
    const input = args as { operation_id?: string; client_request_id?: string; before_cursor?: number | null; limit?: number };
    const items = [...records.values()].map(summary).filter((s) => (!input.operation_id || s.operation_id === input.operation_id)
      && (!input.client_request_id || s.client_request_id === input.client_request_id) && (input.before_cursor == null || s.cursor < input.before_cursor))
      .sort((a, b) => b.cursor - a.cursor);
    const page = items.slice(0, input.limit ?? 30);
    return observed({ operations: page, next_cursor: items.length > page.length ? page.at(-1)!.cursor : null });
  });
  const ports = {
    context: () => ({ ...scope }), query,
    subscribe: vi.fn(async (_project: string, after: number) => events.filter((e) => e.sequence > after).slice(0, 100)),
    getOperation: vi.fn(async (_project: string, id: string) => records.get(id) ?? null),
    invoke: vi.fn(async (project: string, invocation: Invocation, _accepted?: boolean) => {
      const value = record(900, project, invocation.client_request_id); records.set(value.operation.operation_id, value); return value;
    }),
    cancel: vi.fn(async () => {}), execution: () => null, changed: vi.fn(), flush: vi.fn(async () => {}),
    unsynced: vi.fn(() => false), syncError: () => "draft conflict", notifications,
  };
  const operations = new Operations(ports);
  cleanup.push(() => { operations.stop(); operations.dispose(); notifications.dispose(); });
  return { operations, ports, records, events, setScope: (patch: Partial<RequestContext>) => { scope = { ...scope, ...patch }; } };
}

it("instance projections share original records but scope history, run admission and cancellation", async () => {
  const f = fixture();
  Object.assign(f.ports, { contextFor: (id: string) => ({ ...f.ports.context(), workspaceInstanceId: id, session: `r-${id}`, runtimeState: "idle" }),
    execution: (id?: string) => ({ session_id: `r-${id ?? "main"}`, current: { operation_id: id === "scratch" ? "op-2" : "op-1" }, pending: [], pause: null, input: null }) });
  for (const [n, id] of [[1, "main"], [2, "scratch"]] as const) {
    const value = record(n); value.operation.normalized_arguments = { code: `x <- ${n}`, workspace_instance_id: id };
    f.records.set(value.operation.operation_id, value);
  }
  await f.operations.loadRecent(); const main = f.operations.forInstance("main"), scratch = f.operations.forInstance("scratch");
  expect([...main.records.keys()]).toEqual(["op-1"]); expect([...scratch.records.keys()]).toEqual(["op-2"]);
  expect(scratch.records.get("op-2")).toBe(f.operations.records.get("op-2"));
  await scratch.cancel(); expect(f.ports.cancel).toHaveBeenCalledWith("/a", "op-2", false);
  await scratch.run("x <- 3");
  expect(f.ports.invoke.mock.calls.at(-1)![1]).toMatchObject({ arguments: { workspace_instance_id: "scratch", code: "x <- 3" },
    preconditions: [{ kind: "workspace.session", subject: "active", expected: "r-scratch" }] });
});
async function baseline(f: ReturnType<typeof fixture>) { await f.operations.beginBaseline(); f.operations.finishBaseline(); }

it("captures checkpoint before baseline reads and fills the operation inserted during initialization", async () => {
  const f = fixture();
  for (let n = 1; n <= 30; n++) f.records.set(`op-${n}`, record(n));
  f.events.push(event(10, "op-30"));
  await f.operations.beginBaseline();
  expect(f.operations.eventCursor).toBe(10);
  const originalQuery = f.ports.query.getMockImplementation()!, held = deferred<QuerySnapshot>();
  const recent = await originalQuery("/a", "operation.list_recent", { limit: 30 });
  f.ports.query.mockImplementationOnce(() => held.promise);
  const loading = f.operations.loadRecent();
  f.records.set("op-31", record(31)); f.events.push(event(11, "op-31"));
  expect(await f.operations.consumeEvents()).toBe(false);
  expect(f.ports.subscribe).not.toHaveBeenCalled();
  held.resolve(recent); await loading; f.operations.finishBaseline();
  await f.operations.consumeEvents();
  expect(f.operations.records.size).toBe(31);
  expect(f.operations.getRecord("op-31")).toEqual(record(31));
  expect(f.ports.query.mock.calls[0][1]).toBe("operation.events_checkpoint");
  expect(f.ports.invoke).not.toHaveBeenCalled();
});

it("retains its first checkpoint while retrying baseline reads", async () => {
  const f = fixture(); f.events.push(event(10));
  await f.operations.beginBaseline(); f.events.push(event(20));
  await f.operations.beginBaseline();
  expect(f.operations.eventCursor).toBe(10);
  expect(f.ports.query.mock.calls.filter((call) => call[1] === "operation.events_checkpoint")).toHaveLength(1);
});

it("consumes bursts beyond 30 and 100 records with at most two event pages per turn", async () => {
  const f = fixture(); await baseline(f);
  for (let n = 1; n <= 250; n++) { f.records.set(`op-${n}`, record(n)); f.events.push(event(n)); }
  expect(await f.operations.consumeEvents()).toBe(true);
  expect(f.ports.subscribe).toHaveBeenCalledTimes(2);
  expect(f.operations.records.size).toBe(200); expect(f.operations.eventCursor).toBe(200);
  expect(await f.operations.consumeEvents()).toBe(false);
  expect(f.ports.subscribe).toHaveBeenCalledTimes(3);
  expect(f.operations.records.size).toBe(250); expect(f.operations.eventCursor).toBe(250);
  expect(f.operations.summaries.size).toBe(250);
  expect(f.ports.invoke).not.toHaveBeenCalled();
});

it("merges repeated event identities/pages without duplicating records or notifications", async () => {
  const f = fixture(), changed = vi.fn(); await baseline(f);
  f.ports.notifications.on("operationChanged", changed);
  f.records.set("op-1", record(1));
  const page = [event(1), event(2, "op-1"), event(2, "op-1")];
  f.ports.subscribe.mockResolvedValue(page);
  await f.operations.consumeEvents(); await f.operations.consumeEvents();
  expect(f.operations.records.size).toBe(1); expect(f.operations.eventCursor).toBe(2);
  expect(f.ports.getOperation).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledTimes(1);
});

it("does not advance a partly processed page after a network failure and retries the same cursor", async () => {
  const f = fixture(); await baseline(f);
  for (let n = 1; n <= 3; n++) { f.records.set(`op-${n}`, record(n)); f.events.push(event(n)); }
  const read = f.ports.getOperation.getMockImplementation()!;
  let failure = true;
  f.ports.getOperation.mockImplementation(async (project, id) => { if (id === "op-2" && failure) { failure = false; throw new Error("network down"); } return read(project, id); });
  await expect(f.operations.consumeEvents()).rejects.toThrow("network down");
  expect(f.operations.eventCursor).toBe(0); expect(f.operations.records.size).toBe(1);
  await f.operations.consumeEvents();
  expect(f.ports.subscribe.mock.calls.map((call) => call[1])).toEqual([0, 0]);
  expect(f.operations.eventCursor).toBe(3); expect(f.operations.records.size).toBe(3);
});

it("continues past an authoritative null without manufacturing a record or sorting identity", async () => {
  const f = fixture(); await baseline(f);
  f.events.push(event(1), event(2)); f.records.set("op-2", record(2));
  await f.operations.consumeEvents();
  expect(f.operations.eventCursor).toBe(2); expect(f.operations.getSnapshot().unreadable.has("op-1")).toBe(true);
  expect(f.operations.getRecord("op-1")).toBeUndefined(); expect(f.operations.getSummary("op-1")).toBeUndefined();
  expect(f.operations.getRecord("op-2")).toBeDefined();
});

it.each(["record", "sorting identity", "event page"])("keeps the event page retryable after malformed %s", async (kind) => {
  const f = fixture(); await baseline(f); f.events.push(event(1)); f.records.set("op-1", record(1));
  if (kind === "record") f.ports.getOperation.mockResolvedValueOnce({ ...record(1), operation: { ...record(1).operation, operation_id: "wrong" } });
  if (kind === "sorting identity") f.ports.query.mockResolvedValueOnce(observed({ operations: [{ ...summary(record(1)), cursor: "wrong" }], next_cursor: null }));
  if (kind === "event page") f.ports.subscribe.mockResolvedValueOnce([{ ...event(1), sequence: -1 }]);
  await expect(f.operations.consumeEvents()).rejects.toThrow();
  expect(f.operations.eventCursor).toBe(0); expect(f.operations.getRecord("op-1")).toBeUndefined();
  await f.operations.consumeEvents();
  expect(f.operations.eventCursor).toBe(1); expect(f.operations.getRecord("op-1")).toBeDefined();
});

it("keeps all history reachable through independent before_cursor pagination", async () => {
  const f = fixture(); for (let n = 1; n <= 75; n++) f.records.set(`op-${n}`, record(n));
  await baseline(f); await f.operations.loadRecent();
  expect(f.operations.records.size).toBe(30); expect(f.operations.recentCursor).toBe(46);
  await f.operations.loadRecent(true); expect(f.operations.records.size).toBe(60);
  await f.operations.loadRecent(true); expect(f.operations.records.size).toBe(75); expect(f.operations.recentCursor).toBeNull();
  expect(f.operations.eventCursor).toBe(0);
  expect(f.ports.query.mock.calls.filter((call) => call[1] === "operation.list_recent").map((call) => call[2]))
    .toEqual([{ before_cursor: null, limit: 30 }, { before_cursor: 46, limit: 30 }, { before_cursor: 16, limit: 30 }]);
});

it("restores pending request identity without restoring cursor or invoking recovery code", async () => {
  const f = fixture(), invocation: Invocation = { client_request_id: "unconfirmed", capability: { id: "workspace.run_r", version: 1 }, arguments: { code: "x <- 1" }, preconditions: [] };
  f.operations.restore({ pending: [{ invocation }], cursor: 999, eventCursor: 999 });
  expect(f.operations.eventCursor).toBe(0); expect(f.operations.serialize()).not.toHaveProperty("cursor");
  expect(f.operations.pending[0].invocation).toEqual(invocation);
  await f.operations.reconcilePending();
  expect(f.operations.pending).toHaveLength(1);
  f.records.set("op-8", record(8, "/a", "unconfirmed"));
  await f.operations.reconcilePending();
  expect(f.operations.pending).toHaveLength(0); expect(f.operations.getRecord("op-8")).toBeDefined();
  expect(f.ports.invoke).not.toHaveBeenCalled();
});

it("persists request identity before Invoke and refuses submission when persistence remains dirty", async () => {
  const f = fixture(), durable = deferred<void>();
  f.ports.flush.mockReturnValueOnce(durable.promise);
  const run = f.operations.invoke("workspace.run_r", { code: "x <- 1" });
  expect(f.operations.pending).toHaveLength(1); expect(f.ports.changed).toHaveBeenCalled(); expect(f.ports.invoke).not.toHaveBeenCalled();
  const identity = f.operations.pending[0].invocation.client_request_id;
  durable.resolve(); await run;
  expect(f.ports.invoke.mock.calls[0][1].client_request_id).toBe(identity);
  f.ports.unsynced.mockReturnValue(true);
  await expect(f.operations.invoke("workspace.run_r", { code: "x <- 2" })).rejects.toThrow("not submitted");
  expect(f.ports.invoke).toHaveBeenCalledTimes(1);
});

it("retains unconfirmed request identity after lost acknowledgement without automatically invoking it again", async () => {
  const f = fixture(); f.ports.invoke.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await expect(f.operations.invoke("workspace.run_r", { code: "x <- 1" })).rejects.toThrow("lost acknowledgement");
  const identity = f.operations.pending[0].invocation.client_request_id;
  await f.operations.reconcilePending(); await baseline(f); await f.operations.consumeEvents();
  expect(f.operations.pending[0].invocation.client_request_id).toBe(identity); expect(f.ports.invoke).toHaveBeenCalledTimes(1);
});

it.each(["A-B-A", "R restart", "stop"])("discards late authoritative reads after %s", async (transition) => {
  const f = fixture(), late = deferred<OperationRecord | null>();
  f.ports.getOperation.mockReturnValueOnce(late.promise);
  const read = f.operations.ensureOperation("op-1"), rejected = expect(read).rejects.toThrow(/lifecycle/i);
  if (transition === "stop") f.operations.stop();
  else if (transition === "R restart") { f.setScope({ epoch: 2, session: "session-b" }); f.operations.sessionChanged(); }
  else { f.setScope({ epoch: 2, project: "/b" }); f.operations.reset(); f.setScope({ epoch: 3, project: "/a" }); f.operations.reset(); }
  late.resolve(record(1)); await rejected;
  expect(f.operations.records.size).toBe(0); expect(f.operations.summaries.size).toBe(0);
});

it("does not Invoke if the project changed while pending identity was being persisted", async () => {
  const f = fixture(), durable = deferred<void>(); f.ports.flush.mockReturnValueOnce(durable.promise);
  const run = f.operations.invoke("workspace.run_r", { code: "x <- 1" }), rejected = expect(run).rejects.toThrow(/changed before/i);
  f.setScope({ epoch: 2, project: "/b" }); f.operations.reset(); durable.resolve(); await rejected;
  expect(f.ports.invoke).not.toHaveBeenCalled(); expect(f.operations.pending).toHaveLength(0);
});

it("retains a request as unconfirmed without a false busy state when R restarts before durable submission", async () => {
  const f = fixture(), durable = deferred<void>(); f.ports.flush.mockReturnValueOnce(durable.promise);
  const run = f.operations.invoke("workspace.run_r", { code: "never_started <- TRUE" });
  const rejected = expect(run).rejects.toThrow(/changed before/i);
  const identity = f.operations.pending[0].invocation.client_request_id;
  f.setScope({ epoch: 2, session: "session-b" }); f.operations.sessionChanged();
  durable.resolve(); await rejected;
  expect(f.ports.invoke).not.toHaveBeenCalled();
  expect(f.operations.pending[0].invocation.client_request_id).toBe(identity);
  expect(f.operations.pending[0].error).toMatch(/unconfirmed/i);
  expect(f.operations.busy).toBe(false);
  await f.operations.reconcilePending();
  expect(f.ports.invoke).not.toHaveBeenCalled();
});

it("initializes recent, pending and protected-history references through reads alone", async () => {
  const f = fixture(); for (let n = 1; n <= 40; n++) f.records.set(`op-${n}`, record(n));
  const invocation: Invocation = { client_request_id: "request-3", capability: { id: "workspace.run_r", version: 1 }, arguments: { code: "x <- 3" }, preconditions: [] };
  f.operations.restore({ pending: [{ invocation }], cursor: 500 });
  await f.operations.initialize(["op-1", "op-2"]);
  expect(f.operations.initialized).toBe(true); expect(f.operations.records.size).toBe(33);
  for (const id of ["op-1", "op-2", "op-3"]) expect(f.operations.getRecord(id)).toBeDefined();
  expect(f.operations.pending).toHaveLength(0); expect(f.operations.eventCursor).toBe(0);
  expect(f.ports.invoke).not.toHaveBeenCalled();
});

it("retries a failed initialization from its original checkpoint and then fills intervening events", async () => {
  const f = fixture(); f.records.set("op-1", record(1)); f.events.push(event(1));
  f.ports.getOperation.mockRejectedValueOnce(new Error("record temporarily unavailable"));
  await expect(f.operations.initialize()).rejects.toThrow("temporarily unavailable");
  expect(f.operations.initialized).toBe(false); expect(f.operations.eventCursor).toBe(1);
  f.records.set("op-2", record(2)); f.events.push(event(2));
  await f.operations.initialize(); await f.operations.consumeEvents();
  expect(f.operations.records.size).toBe(2); expect(f.operations.eventCursor).toBe(2);
  expect(f.ports.query.mock.calls.filter((call) => call[1] === "operation.events_checkpoint")).toHaveLength(1);
});

it("does not start more initialization reads after stop even if the checkpoint reply arrives late", async () => {
  const f = fixture(), checkpoint = deferred<QuerySnapshot>();
  f.ports.query.mockReturnValueOnce(checkpoint.promise);
  const initializing = f.operations.initialize().catch(() => {});
  f.operations.stop(); checkpoint.resolve(observed({ sequence: 10 })); await initializing;
  expect(f.ports.query).toHaveBeenCalledTimes(1); expect(f.ports.getOperation).not.toHaveBeenCalled();
  expect(f.operations.initialized).toBe(false); expect(f.operations.eventCursor).toBe(0);
});

it.each([null, {}, { sequence: -1 }, { sequence: 1.5 }, { sequence: "10" }])("rejects invalid checkpoint %j without enabling consumption", async (value) => {
  const f = fixture(); f.ports.query.mockResolvedValueOnce(observed(value));
  await expect(f.operations.initialize()).rejects.toThrow(/checkpoint/i);
  expect(f.operations.initialized).toBe(false); expect(f.operations.eventCursor).toBe(0);
  expect(await f.operations.consumeEvents()).toBe(false); expect(f.ports.subscribe).not.toHaveBeenCalled();
});

it("rereads an operation after an event if an earlier read was already in flight", async () => {
  const f = fixture(); await baseline(f);
  const old = deferred<OperationRecord | null>();
  f.ports.getOperation.mockReturnValueOnce(old.promise); f.records.set("op-1", record(1));
  const priorRead = f.operations.ensureOperation("op-1");
  f.events.push(event(1)); const consuming = f.operations.consumeEvents();
  old.resolve({ ...record(1), status: "running", updated_at_ms: 0 });
  await priorRead; await consuming;
  expect(f.ports.getOperation).toHaveBeenCalledTimes(2);
  expect(f.operations.getRecord("op-1")?.status).toBe("succeeded"); expect(f.operations.eventCursor).toBe(1);
});

it.each(["succeeded", "failed", "cancelled", "uncertain"] as const)("publishes authoritative %s workspace outcome with its sorting identity", async (status) => {
  const f = fixture(), changed = vi.fn(); await baseline(f); f.ports.notifications.on("operationChanged", changed);
  f.records.set("op-1", { ...record(1), status }); f.events.push(event(1));
  await f.operations.consumeEvents();
  expect(changed).toHaveBeenCalledExactlyOnceWith({ epoch: 1, project: "/a", operationId: "op-1", capability: "workspace.run_r", status, cursor: 1 });
});

it("newly linked task operations keep following original queued and running events after the Agent is ready", async () => {
  const f=fixture(); await baseline(f);
  const original={...record(401),status:"accepted" as const,updated_at_ms:401};
  original.operation.caller={kind:"agent",id:"task:finished-agent"};
  f.records.set("op-401",original); await f.operations.ensureOperation("op-401");
  expect(f.operations.getRecord("op-401")?.status).toBe("accepted");
  f.records.set("op-401",{...original,status:"running",updated_at_ms:402}); f.events.push(event(1,"op-401"));
  await f.operations.consumeEvents(); expect(f.operations.getRecord("op-401")?.status).toBe("running");
  f.records.set("op-401",{...original,status:"succeeded",outcome:"succeeded",updated_at_ms:403}); f.events.push(event(2,"op-401"));
  await f.operations.consumeEvents(); expect(f.operations.getRecord("op-401")?.status).toBe("succeeded");
  expect(f.operations.getRecord("op-401")?.operation.operation_id).toBe("op-401");
  expect(f.ports.invoke).not.toHaveBeenCalled(); expect(f.ports.cancel).not.toHaveBeenCalled();
});
