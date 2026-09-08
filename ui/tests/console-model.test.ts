import { afterEach, expect, it, vi } from "vitest";
import { Console } from "../src/console";
import type { RequestContext } from "../src/shared/ports";
import type { ConsoleState } from "../src/generated/ConsoleState";
import type { OperationRecord } from "../src/generated/OperationRecord";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { RespondInput } from "../src/generated/RespondInput";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function microtasks() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
const accepted = { status: "accepted" } as OperationRecord;
const state = (session = "native-a"): ConsoleState => ({ session_id: session, current: null, pending: [], pause: null, input: null });
const observed = (data: unknown): QuerySnapshot => ({ target: { kind: "workspace", identity: "native-a" }, source: "R", observed_at_ms: 1,
  status: "ready", completeness: "complete", notices: [], data: data as QuerySnapshot["data"] });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/a", session: "native-a", runtimeState: "idle", connected: true,
    capabilities: ["workspace.console_state", "workspace.check_code", "workspace.run_r"] };
  const ports = { context: () => ({ ...scope }), query: vi.fn(async (_project: string, _id: string, _args?: unknown) => observed(state())),
    run: vi.fn(async (_code: string, _source: unknown) => accepted), invoke: vi.fn(async (_id: string, _args: unknown) => accepted),
    cancel: vi.fn(async (_id?: string, _pending?: boolean) => {}), respondInput: vi.fn(async (_project: string, _input: RespondInput): Promise<unknown> => ({})),
    changed: vi.fn(), schedule: vi.fn(), controlChanged: vi.fn(), showConsole: vi.fn(), };
  const console = new Console(ports); cleanup.push(() => { console.stop(); console.dispose(); });
  return { console, ports, setScope: (patch: Partial<RequestContext>) => { scope = { ...scope, ...patch }; } };
}

it("keeps view drafts independent while sharing queue state and command history", async () => {
  const f = fixture(); f.console.updateView("console", { input: "x <- 1", scrollTop: 10 });
  const second = f.console.newConsole(); f.console.updateView(second, { input: "y <- 2", scrollTop: 20 });
  f.ports.query.mockResolvedValueOnce(observed({ ...state(), pending: [{ operation_id: "op-1", source: null, summary: "queued" }] }));
  await f.console.refresh(); await f.console.run("x <- 1", "console");
  expect(f.console.view("console").input).toBe(""); expect(f.console.view(second)).toMatchObject({ input: "y <- 2", scrollTop: 20 });
  expect(f.console.commandHistory).toEqual(["x <- 1"]); expect(f.console.operationIds()).toEqual(["op-1"]);
  expect(f.console.queueing).toBe(true);
});

it("does not clear text typed while an earlier run is waiting for acceptance", async () => {
  const f = fixture(), waiting = deferred<OperationRecord>(); f.ports.run.mockReturnValueOnce(waiting.promise);
  f.console.updateView("console", { input: "first" }); const running = f.console.run("first", "console");
  f.console.updateView("console", { input: "new draft", anchor: 9, head: 9 }); waiting.resolve(accepted); await running;
  expect(f.console.view("console")).toMatchObject({ input: "new draft", anchor: 9, head: 9 }); expect(f.console.commandHistory).toEqual(["first"]);
});

it.each(["A-B-A", "R restart", "stop"])("late run acceptance after %s cannot erase the current same-viewId draft or append old history", async (transition) => {
  const f = fixture(), waiting = deferred<OperationRecord>(); f.ports.run.mockReturnValueOnce(waiting.promise);
  f.console.updateView("console", { input: "same text" }); const running = f.console.run("same text", "console");
  if (transition === "stop") f.console.stop();
  else if (transition === "R restart") { f.setScope({ epoch: 2, session: "native-b" }); f.console.resetSession(); }
  else { f.setScope({ epoch: 2, project: "/b" }); f.console.reset(); f.setScope({ epoch: 3, project: "/a" }); f.console.reset(); }
  f.console.restore({ consoleViews: { console: { input: "same text" } }, commandHistory: ["new history"] });
  f.ports.changed.mockClear(); f.ports.schedule.mockClear(); waiting.resolve(accepted); await running;
  expect(f.console.view("console").input).toBe("same text"); expect(f.console.commandHistory).toEqual(["new history"]);
  expect(f.ports.changed).not.toHaveBeenCalled(); expect(f.ports.schedule).not.toHaveBeenCalled();
});

it("retains drafts and history on a failed run", async () => {
  const f = fixture(); f.console.updateView("console", { input: "kept" });
  f.ports.run.mockRejectedValueOnce(new Error("request not submitted"));
  await expect(f.console.run("kept", "console")).rejects.toThrow("not submitted");
  expect(f.console.view("console").input).toBe("kept"); expect(f.console.commandHistory).toEqual([]);
});

it("coalesces concurrent console observations across views and keeps unchanged control state quiet", async () => {
  const f = fixture(), waiting = deferred<QuerySnapshot>(); f.ports.query.mockReturnValueOnce(waiting.promise);
  const first = f.console.refresh(), second = f.console.refresh(); expect(f.ports.query).toHaveBeenCalledTimes(1);
  waiting.resolve(observed(state())); await first; await second;
  expect(f.ports.controlChanged).toHaveBeenCalledTimes(1);
  await f.console.refresh(); expect(f.ports.controlChanged).toHaveBeenCalledTimes(1);
});

it.each(["success", "failure"])("drops late console observation %s after reset and retains the new native identity", async (kind) => {
  const f = fixture(), waiting = deferred<QuerySnapshot>(); f.ports.query.mockReturnValueOnce(waiting.promise);
  const old = f.console.refresh().catch(() => {});
  f.setScope({ epoch: 2, session: "native-b" }); f.console.resetSession();
  f.ports.query.mockResolvedValueOnce(observed(state("native-b"))); await f.console.refresh();
  if (kind === "success") waiting.resolve(observed(state())); else waiting.reject(new Error("old failure"));
  await old;
  expect(f.console.consoleState?.session_id).toBe("native-b"); expect(f.console.getSnapshot().error).toBe("");
});

it("does not issue native completeness checks while busy and rejects a stopped check response", async () => {
  const f = fixture(); f.setScope({ runtimeState: "busy" });
  await expect(f.console.checkCode("x <-")).resolves.toBeNull(); expect(f.ports.query).not.toHaveBeenCalled();
  f.setScope({ runtimeState: "idle" }); const waiting = deferred<QuerySnapshot>(); f.ports.query.mockReturnValueOnce(waiting.promise);
  const checking = f.console.checkCode("x <-"), rejected = expect(checking).rejects.toThrow(/lifecycle/i);
  f.console.stop(); waiting.resolve(observed({ status: "incomplete", indent: "  " })); await rejected;
});

it.each(["success", "failure"])("never stores a password when stdin reply ends in %s", async (kind) => {
  const f = fixture(); f.console.updateView("console", { input: "ordinary code" });
  f.ports.query.mockResolvedValueOnce(observed({ ...state(), input: { session_id: "native-a", operation_id: "operation-1", request_id: "input-1", prompt: "Password", password: true, submitted: false } }));
  await f.console.refresh(); const secret = "secret-only-in-transport";
  if (kind === "failure") f.ports.respondInput.mockRejectedValueOnce(new Error("connection lost"));
  await f.console.respond(secret).catch(() => {});
  expect(f.ports.respondInput.mock.calls[0][1]).toMatchObject({ session_id: "native-a", operation_id: "operation-1", request_id: "input-1", value: secret });
  expect(JSON.stringify(f.console.serialize())).not.toContain(secret); expect(JSON.stringify(f.console.getSnapshot())).not.toContain(secret);
  expect(f.console.view("console").input).toBe("ordinary code"); expect(f.console.commandHistory).toEqual([]);
});

it("does not answer an already submitted stdin request or schedule after a stopped reply", async () => {
  const f = fixture(), input = { session_id: "native-a", operation_id: "operation-1", request_id: "input-1", prompt: "Input", password: false, submitted: true };
  f.ports.query.mockResolvedValueOnce(observed({ ...state(), input })); await f.console.refresh(); await f.console.respond("value");
  expect(f.ports.respondInput).not.toHaveBeenCalled();
  f.ports.query.mockResolvedValueOnce(observed({ ...state(), input: { ...input, submitted: false } })); await f.console.refresh();
  const waiting = deferred<unknown>(); f.ports.respondInput.mockReturnValueOnce(waiting.promise);
  const responding = f.console.respond("value"); f.console.stop(); waiting.resolve({}); await responding;
  expect(f.ports.schedule).not.toHaveBeenCalled();
});

it.each(["queue control", "pending cancellation"])("does not schedule stale work after stopping an in-flight %s", async (kind) => {
  const f = fixture(); f.ports.query.mockResolvedValueOnce(observed({ ...state(), pending: [{ operation_id: "queued", source: null, summary: "queued" }] }));
  await f.console.refresh();
  const waiting = deferred<never>();
  let request: Promise<void>;
  if (kind === "queue control") { f.ports.invoke.mockReturnValueOnce(waiting.promise); request = f.console.queueControl(true); }
  else { f.ports.cancel.mockReturnValueOnce(waiting.promise); request = f.console.cancelPending("queued"); }
  f.console.stop(); waiting.resolve(undefined as never); await request;
  expect(f.ports.schedule).not.toHaveBeenCalled();
});

it("disposes both model and per-view pending subscriptions on stop", async () => {
  const f = fixture(), viewListener = vi.fn(), listener = vi.fn();
  f.console.subscribe(listener); f.console.subscribeView("console", viewListener);
  f.console.updateView("console", { input: "pending repaint" }); f.console.newConsole(); f.console.stop(); await microtasks();
  expect(viewListener).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
});
