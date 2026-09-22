import { afterEach, expect, it, vi } from "vitest";
import { Session } from "../src/session";
import { Notifications } from "../src/shared/events";
import type { WorkbenchInfo } from "../src/generated/WorkbenchInfo";
import type { RConfiguration } from "../src/generated/RConfiguration";
import type { RProbe } from "../src/generated/RProbe";
import type { RSelection } from "../src/generated/RSelection";
import type { ApplicationState } from "../src/generated/ApplicationState";
import type { QuerySnapshot } from "../src/generated/QuerySnapshot";
import type { ApplicationBridgeRequest } from "../src/generated/ApplicationBridgeRequest";
import type { ApplicationBridgeReply } from "../src/generated/ApplicationBridgeReply";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function microtasks() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
const info = (project = "/a"): WorkbenchInfo => ({ project_root: project, runtime: "R", capabilities: [{ capability: { id: "workspace.runtime_status", version: 1 },
  kind: "query", domain: "workspace", input_schema: {}, output_schema: {}, required_scopes: [], potential_effects: [], idempotency: "pure", retry: "never", cancellation: "unsupported" }] });
const r: RConfiguration = { source: "test", current: null, candidates: [], error: null };
const selection: RSelection = { executable: "/R", ark: "/ark" };
const probe: RProbe = { selection, r_home: "/R", version: "4.6", architecture: "arm64", jsonlite: true, rlang: true, ark_available: true, usable: true, diagnostics: [] };
const runtime = (session = "native-a"): QuerySnapshot => ({ target: { kind: "workspace", identity: session }, source: "R", observed_at_ms: 1,
  status: "ready", completeness: "complete", notices: [], data: { session_id: session, state: "idle", observed_at_ms: 1, processes: [], notices: [] } });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
function fixture() {
  let project = "/a";
  const notifications = new Notifications();
  const ports = {
    info: vi.fn(async () => info(project)), rConfiguration: vi.fn(async () => r),
    selectProject: vi.fn(async (next: string) => { project = next; return info(project); }),
    selectDemoProject: vi.fn(async () => { project = "/demo"; return info(project); }),
    probeR: vi.fn(async (_selection: RSelection) => probe), applyR: vi.fn(async (_selection: RSelection, _end: boolean) => r),
    query: vi.fn(async (_project: string, _id: string, _args?: unknown) => runtime()),
    readState: vi.fn(async (_project: string | null, key: string): Promise<ApplicationState> => ({ key, version: "v1", value: ["/a"] })),
    writeState: vi.fn(async (_project: string | null, state: ApplicationState) => ({ ...state, version: "v2" })),
    notifications, transition: { before: vi.fn(async () => {}), after: vi.fn(async (_projectChanged: boolean) => {}), failed: vi.fn() },
  };
  const session = new Session(ports); cleanup.push(() => { session.stop(); session.dispose(); notifications.dispose(); });
  return { session, ports };
}

it("keeps the project epoch stable while native epochs advance within an instance", async () => {
  const f = fixture(), projects = vi.fn(), sessions = vi.fn();
  f.ports.notifications.on("projectChanged", projects); f.ports.notifications.on("instanceChanged", sessions);
  await f.session.start(); const initial = f.session.epoch;
  await f.session.refreshRuntime();
  f.ports.query.mockResolvedValueOnce(runtime("native-b")); await f.session.refreshRuntime();
  expect(f.session.epoch).toBe(initial); expect(f.session.context().nativeEpoch).toBe(2); expect(f.session.context().session).toBe("native-b");
  expect(projects).toHaveBeenCalledExactlyOnceWith({ epoch: initial, project: "/a" });
  expect(sessions.mock.calls.map(([value]) => value.session)).toEqual(["native-a", "native-b"]);
});

it("observes R instances independently and selection does not emit a Host-wide session change", async () => {
  const f = fixture(), globalChange = vi.fn(); await f.session.start(); const epoch = f.session.epoch;
  f.ports.notifications.on("sessionChanged", globalChange);
  f.ports.query.mockImplementation(async (_project, _capability, args) => runtime((args as { workspace_instance_id: string }).workspace_instance_id === "scratch" ? "r-scratch" : "r-main"));
  await Promise.all([f.session.refreshRuntime("main"), f.session.refreshRuntime("scratch")]);
  const main = f.session.contextFor("main"), mainRuntime = f.session.runtimeFor("main");
  f.session.selectInstance("scratch"); expect(f.session.context().session).toBe("r-scratch");
  f.session.observeInstanceIdentity("scratch", "r-scratch-new");
  f.ports.query.mockResolvedValueOnce(runtime("r-scratch-new")); await f.session.refreshRuntime("scratch");
  expect(f.session.contextFor("main")).toEqual(main); expect(f.session.runtimeFor("main")).toBe(mainRuntime);
  expect(f.session.contextFor("scratch").nativeEpoch).toBe(2); expect(f.session.epoch).toBe(epoch);
  expect(globalChange).not.toHaveBeenCalled();
});

it("a late native read cannot replace the identity announced by a lifecycle result", async () => {
  const f = fixture(); await f.session.start(); const pending = deferred<QuerySnapshot>();
  f.session.observeInstanceIdentity("scratch", "r-before"); f.ports.query.mockReturnValueOnce(pending.promise);
  const reading = f.session.refreshRuntime("scratch"); f.session.observeInstanceIdentity("scratch", "r-after");
  pending.resolve(runtime("r-before")); await reading;
  expect(f.session.contextFor("scratch").session).toBe("r-after"); expect(f.session.runtimeFor("scratch")).toBeNull();
});

it.each(["R configuration", "recent projects"])("keeps Host health independent of failed %s startup reads", async (failure) => {
  const f = fixture();
  if (failure === "R configuration") f.ports.rConfiguration.mockRejectedValueOnce(new Error("R configuration failed"));
  else f.ports.readState.mockRejectedValueOnce(new Error("recent projects failed"));
  await f.session.start().catch(() => {});
  expect(f.session.project).toBe("/a"); expect(f.session.connected).toBe(true);
  expect(f.session.error).toContain("failed");
});

it("isolates runtime observation failure from transport health and retains the last native observation", async () => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  f.ports.query.mockRejectedValueOnce(new Error("runtime unavailable"));
  await expect(f.session.refreshRuntime()).rejects.toThrow("runtime unavailable");
  expect(f.session.connected).toBe(true); expect(f.session.context().session).toBe("native-a");
  expect(f.session.getSnapshot().runtimeError).toBe("runtime unavailable");
});

it("discards a late startup result after stop without publishing project identity", async () => {
  const f = fixture(), late = deferred<WorkbenchInfo>(), projects = vi.fn();
  f.ports.info.mockReturnValueOnce(late.promise); f.ports.notifications.on("projectChanged", projects);
  const start = f.session.start(); f.session.stop(); late.resolve(info()); await start;
  expect(f.session.project).toBeNull(); expect(projects).not.toHaveBeenCalled(); expect(f.ports.writeState).not.toHaveBeenCalled();
});

it.each(["success", "failure"])("discards stale runtime %s after A-B-A project switches", async (kind) => {
  const f = fixture(); await f.session.start(); const late = deferred<QuerySnapshot>();
  f.ports.query.mockReturnValueOnce(late.promise); const old = f.session.refreshRuntime().catch(() => {});
  const initial = f.session.epoch;
  await f.session.selectProject("/b"); await f.session.selectProject("/a");
  await f.session.refreshRuntime();
  if (kind === "success") late.resolve(runtime("old-native")); else late.reject(new Error("old runtime failed"));
  await old;
  expect(f.session.epoch).toBeGreaterThan(initial); expect(f.session.context().session).toBe("native-a"); expect(f.session.getSnapshot().runtimeError).toBe("");
});

it("uses the latest R probe result and rejects an older completion", async () => {
  const f = fixture(); await f.session.start(); const old = deferred<RProbe>();
  f.ports.probeR.mockReturnValueOnce(old.promise);
  const reading = f.session.probeR(selection), rejected = expect(reading).rejects.toThrow(/changed/i);
  await expect(f.session.probeR({ ...selection, executable: "/other/R" })).resolves.toBe(probe);
  old.resolve(probe); await rejected;
});

it("waits for draft synchronization before switching and leaves the current session intact on failure", async () => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  f.ports.transition.before.mockRejectedValueOnce(new Error("drafts not synchronized"));
  await expect(f.session.selectProject("/b")).rejects.toThrow("drafts not synchronized");
  expect(f.ports.selectProject).not.toHaveBeenCalled(); expect(f.session.project).toBe("/a"); expect(f.session.context().session).toBe("native-a");
  expect(f.session.switching).toBe(false); expect(f.ports.transition.failed).toHaveBeenCalledTimes(1);
});

it("opens the bundled demo through the same project transition", async () => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  await f.session.openDemoProject();
  expect(f.ports.selectDemoProject).toHaveBeenCalledOnce();
  expect(f.session.project).toBe("/demo"); expect(f.session.switching).toBe(false);
  expect(f.ports.transition.after).toHaveBeenCalledWith(true);
});

it("prevents two concurrent switches and cleans up switching after failure", async () => {
  const f = fixture(); await f.session.start(); const pending = deferred<WorkbenchInfo>();
  f.ports.selectProject.mockReturnValueOnce(pending.promise);
  const switching = f.session.selectProject("/b"), rejected = expect(switching).rejects.toThrow("selection failed");
  await expect(f.session.applyR(selection, true)).rejects.toThrow("already in progress");
  pending.reject(new Error("selection failed")); await rejected;
  expect(f.session.switching).toBe(false); expect(f.session.error).toBe("selection failed");
});

it("does not let an older health reply overwrite a newer disconnection", async () => {
  const f = fixture(); await f.session.start(); const oldInfo = deferred<WorkbenchInfo>();
  f.ports.info.mockReturnValueOnce(oldInfo.promise);
  const old = f.session.health(); await microtasks();
  f.ports.info.mockRejectedValueOnce(new Error("Host disconnected")); await expect(f.session.health()).rejects.toThrow("Host disconnected");
  expect(f.session.connected).toBe(false);
  oldInfo.resolve(info()); await old;
  expect(f.session.connected).toBe(false);
});

it("does not start a recent-project read after stop during project initialization", async () => {
  const f = fixture(); await f.session.start(); const initializing = deferred<void>();
  f.ports.transition.after.mockReturnValueOnce(initializing.promise);
  const switching = f.session.selectProject("/b"); await microtasks();
  f.session.stop(); f.ports.readState.mockClear(); initializing.resolve(); await switching;
  expect(f.ports.readState).not.toHaveBeenCalled(); expect(f.ports.writeState).not.toHaveBeenCalled();
});

it("disposes pending Session subscriptions when stopped", async () => {
  const f = fixture(); await f.session.start(); await microtasks();
  const listener = vi.fn(); f.session.subscribe(listener); f.session.reportError("pending repaint"); f.session.stop();
  await microtasks(); expect(listener).not.toHaveBeenCalled();
});

// Exercise lifecycle orchestration with real owners and an isolated in-memory Host edge.
async function studioFixture() {
  const { Studio } = await import("../src/studio");
  const f = fixture();
  const host = { ...f.ports, agentConnection: vi.fn(), agentConfiguration: vi.fn(), invoke: vi.fn(), cancel: vi.fn(async () => {}), respondInput: vi.fn(async () => ({})),
    subscribe: vi.fn(async () => []), getOperation: vi.fn(async () => null), stopReads: vi.fn(), quitWorkbench: vi.fn(),
    windowId: "test-window", incarnation: "test-incarnation", previousBridgeSession: () => undefined, rememberBridgeSession: vi.fn(),
    applicationExecute: vi.fn(), applicationStatus: vi.fn(), applicationReadDocument: vi.fn(),
    applicationBridge: vi.fn(async (_project: string, request: ApplicationBridgeRequest): Promise<ApplicationBridgeReply> => {
      if (request.kind === "register") return { kind: "registered", data: { session: { window: { window_id: request.window_id, incarnation: request.incarnation }, bridge_token: "test-bridge" },
        context: { version: "context-1", label: "test", active_document_id: null, active_view_id: null, native_session_id: null, views: [], selected_object: null, selected_package: null, selected_plot: null }, documents: [], heartbeat_interval_ms: 5000, offline_after_ms: 15000 } };
      if (request.kind === "sync") return { kind: "synced", data: { sync_id: request.sync_id, synced_at_ms: Date.now(), context_version: request.changes.context?.context.version ?? "context-1",
        document_versions: request.changes.documents.map(({ document: d }) => ({ document_id: d.document_id, document_version: d.version, selection_version: d.selection.version })) } };
      if (request.kind === "claim") return { kind: "claimed", data: null };
      if (request.kind === "renew") return { kind: "renewed", data: { window: request.session.window, label: "test", online: true, renewed_at_ms: Date.now(), lease_expires_at_ms: Date.now() + 15000, synced_at_ms: Date.now(), context_version: "context-1", document_count: 0 } };
      throw new Error("Unexpected application request in lifecycle fixture");
    }),
  };
  host.readState.mockImplementation(async (_project, key): Promise<ApplicationState> => ({ key, version: "v1", value: key === "recent" ? ["/a"]
    : key === "preferences" ? { editorFontSize: 14, indentWidth: 4 }
      : { version: 2, consoleViews: { console: { input: "persisted draft" } }, pending: [{ invocation: { client_request_id: "unconfirmed", capability: { id: "workspace.run_r", version: 1 }, arguments: { code: "never replay" }, preconditions: [] } }] } }));
  host.query.mockImplementation(async (_project, id): Promise<QuerySnapshot> => id === "workspace.runtime_status" ? runtime()
    : { ...runtime(), data: id === "operation.events_checkpoint" ? { sequence: 10 } : { operations: [], next_cursor: null } });
  const studio = new Studio(host as unknown as import("../src/host-client").HostClient, { width: 1280 });
  cleanup.push(() => { studio.stop(); vi.clearAllTimers(); vi.useRealTimers(); });
  return { studio, host };
}

it("Studio retries a failed checkpoint before restoring pending requests and drafts or enabling commands", async () => {
  vi.useFakeTimers(); const { studio, host } = await studioFixture();
  host.query.mockRejectedValueOnce(new Error("checkpoint temporarily unavailable"));
  await studio.start();
  expect(studio.session.ready).toBe(false);
  expect(host.readState.mock.calls.filter((call) => call[1] === "studio")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(studio.session.ready).toBe(true); expect(studio.console.view("console").input).toBe("persisted draft");
  expect(studio.operations.pending[0].invocation.client_request_id).toBe("unconfirmed");
  expect(host.invoke).not.toHaveBeenCalled();
});

it("Studio stops startup before preferences or persistence when a late Host reply arrives", async () => {
  vi.useFakeTimers(); const { studio, host } = await studioFixture(), late = deferred<WorkbenchInfo>();
  host.info.mockReturnValueOnce(late.promise);
  const starting = studio.start(); studio.stop(); late.resolve(info()); await starting;
  expect(host.readState).not.toHaveBeenCalled(); expect(host.query).not.toHaveBeenCalled();
  expect(studio.session.ready).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

it("Studio restores readiness and draft ownership when the Host rejects a project switch", async () => {
  vi.useFakeTimers(); const { studio, host } = await studioFixture(); await studio.start();
  host.selectProject.mockRejectedValueOnce(new Error("Host still owns active work"));
  await expect(studio.session.selectProject("/b")).rejects.toThrow("active work");
  await vi.advanceTimersByTimeAsync(1000);
  expect(studio.session.project).toBe("/a"); expect(studio.session.ready).toBe(true);
  expect(studio.console.view("console").input).toBe("persisted draft"); expect(host.invoke).not.toHaveBeenCalled();
});

it("Studio retains editable unsynced drafts when another window changes the Host project and resumes when it returns", async () => {
  vi.useFakeTimers(); const { studio, host } = await studioFixture(); await studio.start();
  const epoch = studio.session.epoch;
  studio.console.updateView("console", { input: "unsynced work in A" });
  host.info.mockResolvedValue(info("/b"));
  host.writeState.mockRejectedValueOnce(new Error("project changed; draft was not written"));
  await studio.session.health(); await studio.persistence.flush();
  expect(studio.session.project).toBe("/a"); expect(studio.session.connected).toBe(true);
  expect(studio.session.ready).toBe(true); expect(studio.session.runtime).toBeNull();
  expect(studio.session.context().capabilities).toEqual([]); expect(studio.operations.canRun).toBe(false);
  expect(studio.session.epoch).toBeGreaterThan(epoch); expect(studio.session.error).toMatch(/Host is using \/b.*drafts are retained/);
  expect(studio.console.view("console").input).toBe("unsynced work in A"); expect(studio.persistence.unsynced).toBe(true);
  expect(host.readState.mock.calls.filter((call) => call[0] === "/b")).toHaveLength(0);
  studio.console.updateView("console", { input: "continued editing in A" });
  host.info.mockResolvedValue(info());
  await studio.session.health(); await studio.session.refreshRuntime(); await studio.persistence.flush();
  expect(studio.session.project).toBe("/a"); expect(studio.session.error).toBe("");
  expect(studio.session.runtime?.session_id).toBe("native-a"); expect(studio.persistence.unsynced).toBe(false);
  expect(studio.console.view("console").input).toBe("continued editing in A");
  expect(host.writeState.mock.calls.at(-1)).toMatchObject(["/a", { value: { consoleViews: { console: { input: "continued editing in A" } } } }]);
});

it("fences a late native response during an external project mismatch without resetting project owners", async () => {
  const f = fixture(); await f.session.start(); const native = deferred<QuerySnapshot>();
  f.ports.query.mockReturnValueOnce(native.promise); const reading = f.session.refreshRuntime();
  const changed = vi.fn(); f.ports.notifications.on("projectChanged", changed);
  f.ports.info.mockResolvedValue(info("/b")); await f.session.health();
  native.resolve(runtime()); await reading;
  expect(f.session.project).toBe("/a"); expect(f.session.runtime).toBeNull(); expect(f.session.connected).toBe(true);
  expect(changed).not.toHaveBeenCalled(); expect(f.ports.transition.after).not.toHaveBeenCalled();
  await expect(f.session.applyR(selection, true)).rejects.toThrow("Host is using /b");
  expect(f.ports.applyR).not.toHaveBeenCalled();
});

it("discovers R enabled externally on the same project and refreshes its configuration", async () => {
  const f = fixture();
  f.ports.info.mockResolvedValueOnce({ ...info(), runtime: "project", capabilities: [] });
  await f.session.start();
  f.ports.rConfiguration.mockResolvedValue({ ...r, current: probe });
  await f.session.health(); await f.session.refreshRuntime();
  expect(f.session.context().capabilities).toContain("workspace.runtime_status");
  expect(f.session.info?.runtime).toBe("R"); expect(f.session.runtime?.session_id).toBe("native-a");
  expect(f.session.r?.current).toEqual(probe); expect(f.session.connected).toBe(true);
});

it("clears native availability when another window removes R without changing project", async () => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  const epoch = f.session.epoch, changed = vi.fn(); f.ports.notifications.on("sessionChanged", changed);
  f.ports.info.mockResolvedValue({ ...info(), runtime: "project", capabilities: [] });
  await f.session.health(); f.ports.query.mockClear(); await f.session.refreshRuntime();
  expect(f.session.runtime).toBeNull(); expect(f.session.context().capabilities).toEqual([]);
  expect(f.session.epoch).toBeGreaterThan(epoch); expect(f.session.connected).toBe(true);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ epoch: f.session.epoch, project: "/a", session: null });
  expect(f.ports.query).not.toHaveBeenCalled();
});

it("retries changed R configuration after a read failure without marking the Host disconnected", async () => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  f.ports.rConfiguration.mockRejectedValueOnce(new Error("configuration temporarily unavailable"));
  await expect(f.session.health()).rejects.toThrow("configuration temporarily unavailable");
  expect(f.session.connected).toBe(true); expect(f.session.context().session).toBe("native-a");
  f.ports.rConfiguration.mockResolvedValue({ ...r, current: probe }); await f.session.health();
  expect(f.session.r?.current).toEqual(probe); expect(f.session.error).toBe("");
});

it.each(["success", "failure"])("ignores a late R configuration %s after a newer health request", async (kind) => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  const old = deferred<RConfiguration>(); f.ports.rConfiguration.mockReturnValueOnce(old.promise);
  const oldHealth = f.session.health().catch(() => {}); await microtasks();
  f.ports.rConfiguration.mockResolvedValue({ ...r, current: probe }); await f.session.health();
  if (kind === "success") old.resolve({ ...r, error: "old configuration" }); else old.reject(new Error("old failure"));
  await oldHealth;
  expect(f.session.r?.current).toEqual(probe); expect(f.session.error).toBe(""); expect(f.session.connected).toBe(true);
});

it("refreshes R configuration after a native restart even when Host capabilities are unchanged", async () => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime(); await f.session.health();
  const reads = f.ports.rConfiguration.mock.calls.length;
  f.ports.query.mockResolvedValue(runtime("native-b")); await f.session.refreshRuntime();
  f.ports.rConfiguration.mockResolvedValue({ ...r, current: probe }); await f.session.health();
  expect(f.ports.rConfiguration).toHaveBeenCalledTimes(reads + 1); expect(f.session.r?.current).toEqual(probe);
});

it.each(["native restart", "stop"])("discards an R configuration reply after %s", async (change) => {
  const f = fixture(); await f.session.start(); await f.session.refreshRuntime();
  const old = deferred<RConfiguration>(); f.ports.rConfiguration.mockReturnValueOnce(old.promise);
  const observing = f.session.health(); await microtasks();
  if (change === "stop") f.session.stop();
  else { f.ports.query.mockResolvedValue(runtime("native-b")); await f.session.refreshRuntime(); }
  old.resolve({ ...r, error: "stale configuration" }); await observing;
  expect(f.session.r).toEqual(r); expect(f.session.error).toBe("");
  if (change === "native restart") {
    f.ports.rConfiguration.mockResolvedValue({ ...r, current: probe }); await f.session.health();
    expect(f.session.r?.current).toEqual(probe);
  }
});
