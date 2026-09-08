import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../src/runtime-coordinator";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";

const snapshot: QuerySnapshot = { target: { kind: "workspace", identity: "session-a" }, source: "test", observed_at_ms: 1,
  status: "ready", completeness: "complete", data: {}, notices: [] };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const coordinators: RuntimeCoordinator[] = [];
function coordinator() {
  const result = new RuntimeCoordinator(); coordinators.push(result); return result;
}
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => {
  for (const runtime of coordinators.splice(0)) { runtime.stop(); runtime.dispose(); }
  vi.clearAllTimers(); vi.useRealTimers();
});

it("does not start a queued task when stopped before its execution microtask", async () => {
  const runtime = coordinator(), run = vi.fn(async () => {});
  runtime.register("events", 250, run);
  runtime.start();
  vi.advanceTimersByTime(0);
  runtime.stop();
  await microtasks();
  await vi.advanceTimersByTimeAsync(2000);
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps per-task backoff despite repeated view-demand wakeups and caps it at five seconds", async () => {
  const runtime = coordinator(), attempts: number[] = [];
  runtime.register("events", 250, async () => { attempts.push(Date.now()); throw new Error("temporary"); });
  runtime.start(); await vi.advanceTimersByTimeAsync(0);
  expect(attempts).toEqual([0]);
  for (const delay of [500, 1000, 2000, 5000, 5000]) {
    const before = attempts.length;
    runtime.wake("events"); runtime.wake();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(attempts).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(before + 1);
  }
  expect(attempts).toEqual([0, 500, 1500, 3500, 8500, 13500]);
});

it("isolates failed reads from control tasks and does not overlap a task's own runs", async () => {
  const runtime = coordinator(), pending = deferred<void>();
  const control = vi.fn(async () => {}), workspace = vi.fn(() => pending.promise);
  runtime.register("events", 250, async () => { throw new Error("event page unavailable"); });
  runtime.register("control", 250, control);
  runtime.register("workspace", 2000, workspace);
  runtime.start();
  await vi.advanceTimersByTimeAsync(1000);
  runtime.wake(); await vi.advanceTimersByTimeAsync(0);
  expect(control.mock.calls.length).toBeGreaterThanOrEqual(5);
  expect(workspace).toHaveBeenCalledTimes(1);
  expect(runtime.getSnapshot().tasks.events.error).toBe("event page unavailable");
  expect(runtime.getSnapshot().tasks.control.error).toBe("");
  expect(runtime.getSnapshot().tasks.workspace.inFlight).toBe(true);
  pending.resolve(); await microtasks();
  expect(runtime.getSnapshot().tasks.workspace.inFlight).toBe(false);
});

it("coalesces equal native demands, serializes different observations, and leaves control reads independent", async () => {
  const runtime = coordinator(), first = deferred<QuerySnapshot>(), second = deferred<QuerySnapshot>();
  const read = vi.fn((project: string, id: string) => id === "workspace.snapshot" ? first.promise
    : id === "workspace.packages" ? second.promise : Promise.resolve(snapshot));
  const query = runtime.query(read);
  const objectA = query("/a", "workspace.snapshot", { limit: 30 });
  const objectB = query("/a", "workspace.snapshot", { limit: 30 });
  const packages = query("/a", "workspace.packages", { observation_id: "one", offset: 0 });
  expect(objectB).toBe(objectA);
  await microtasks();
  expect(read).toHaveBeenCalledTimes(1);
  await query("/a", "workspace.runtime_status");
  expect(read).toHaveBeenCalledTimes(2);
  first.resolve(snapshot); await objectA; await microtasks();
  expect(read.mock.calls.map((call) => call[1])).toEqual(["workspace.snapshot", "workspace.runtime_status", "workspace.packages"]);
  second.resolve(snapshot); await packages;
});

it("keeps the 250 ms control cadence when reads have nonzero latency", async () => {
  const runtime = coordinator(), starts: number[] = [];
  runtime.register("control", 250, async () => {
    starts.push(Date.now());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });
  runtime.start();
  await vi.advanceTimersByTimeAsync(999);
  expect(starts).toEqual([0, 250, 500, 750]);
});

it("retains observation identity on retry and lets a failed native read release the serial lane", async () => {
  const runtime = coordinator();
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(snapshot);
  const query = runtime.query(read), args = { observation_id: "observation-1", expected_session_id: "session-a", offset: 100 };
  await expect(query("/a", "workspace.packages", args)).rejects.toThrow("offline");
  await expect(query("/a", "workspace.packages", args)).resolves.toBe(snapshot);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0]).toEqual(read.mock.calls[1]);
});

it("drops stopped queued observations and rejects new reads until explicitly resumed", async () => {
  const runtime = coordinator(), pending = deferred<QuerySnapshot>();
  const read = vi.fn(() => pending.promise), query = runtime.query(read);
  const active = query("/a", "workspace.snapshot");
  await microtasks();
  const queued = query("/a", "workspace.packages");
  const cancelled = expect(queued).rejects.toThrow(/cancel|stop|lifecycle/i);
  runtime.stop();
  await expect(query("/a", "workspace.snapshot")).rejects.toThrow(/cancel|stop|lifecycle/i);
  await expect(query("/a", "workspace.runtime_status")).rejects.toThrow(/cancel|stop|lifecycle/i);
  runtime.startReads();
  const resumed = query("/b", "workspace.snapshot");
  await microtasks();
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(snapshot); await active; await cancelled; await resumed;
  expect(read.mock.calls).toEqual([["/a", "workspace.snapshot", {}], ["/b", "workspace.snapshot", {}]]);
});

it("late task failure and cleanup cannot overwrite a restarted task or notify disposed subscribers", async () => {
  const runtime = coordinator(), old = deferred<void>(), fresh = deferred<void>();
  const run = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  runtime.register("events", 250, run);
  const listener = vi.fn(), unsubscribe = runtime.subscribe(listener);
  runtime.start(); await vi.advanceTimersByTimeAsync(0);
  runtime.stop(); runtime.start(); await vi.advanceTimersByTimeAsync(0);
  unsubscribe(); runtime.dispose(); listener.mockClear();
  old.reject(new Error("old project failed")); await microtasks();
  expect(runtime.getSnapshot().tasks.events.error).toBe("");
  expect(runtime.getSnapshot().tasks.events.inFlight).toBe(true);
  expect(listener).not.toHaveBeenCalled();
  fresh.resolve(); await microtasks();
  expect(runtime.getSnapshot().tasks.events.inFlight).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});


it.each(["workspace.list_objects", "workspace.observe_object", "workspace.read_object", "workspace.package_index"])("coalesces %s with the shared native observation lane", async (capability) => {
  const runtime = coordinator(), first = deferred<QuerySnapshot>();
  const read = vi.fn(async (_project: string, id: string) => id === capability ? first.promise : snapshot);
  const query = runtime.query(read), a = query("/project", capability, { expected_session: "session" }), b = query("/project", capability, { expected_session: "session" });
  const packages = query("/project", "workspace.packages", { expected_session: "session" }); await microtasks();
  expect(read).toHaveBeenCalledTimes(1); expect(a).toBe(b); first.resolve(snapshot); await Promise.all([a, b, packages]);
  expect(read.mock.calls.map(([, id]) => id)).toEqual([capability, "workspace.packages"]);
});
