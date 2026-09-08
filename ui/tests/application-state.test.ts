import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationPersistence } from "../src/application-state";
import type { RequestContext } from "../src/shared/ports";
import type { ApplicationState } from "../src/generated/ApplicationState";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.clearAllTimers(); vi.useRealTimers(); });
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  let scope: RequestContext = { epoch: 1, project: "/a", session: "session-a", runtimeState: "idle", connected: true, capabilities: [] };
  let draft = "initial", layout = "layout-a", revision = 1;
  let disk: ApplicationState = { key: "studio", version: "v1", value: { version: 2, draft: "server", layout: "layout-a" } };
  const port = {
    readState: vi.fn(async (_project: string | null, _key: string) => structuredClone(disk)),
    writeState: vi.fn(async (_project: string | null, state: ApplicationState) => {
      if (state.version !== disk.version) throw new Error("state version conflict");
      disk = structuredClone({ ...state, version: `v${++revision}` }); return structuredClone(disk);
    }),
  };
  const persistence = new ApplicationPersistence(port, () => ({ ...scope }));
  const restore = vi.fn((value: unknown) => { draft = (value as { draft?: string } | null)?.draft ?? ""; });
  persistence.register({ serialize: () => ({ draft }), restore });
  persistence.register({ serialize: () => ({ layout }), restore: (value) => { layout = (value as { layout?: string } | null)?.layout ?? "layout-a"; } });
  cleanup.push(() => { persistence.stop(); persistence.dispose(); });
  return { persistence, port, restore, draft: () => draft, disk: () => disk,
    edit: (value: string) => { draft = value; persistence.changed(); },
    layout: (value: string) => { layout = value; persistence.changed(); },
    remote: (value: string) => { disk = { ...disk, version: `v${++revision}`, value: { version: 2, draft: value, layout } }; },
    setScope: (patch: Partial<RequestContext>) => { scope = { ...scope, ...patch }; } };
}

it("coalesces edits for 400 ms and writes all module fragments in one versioned studio record", async () => {
  const f = fixture(); await f.persistence.restore();
  f.edit("first"); await vi.advanceTimersByTimeAsync(300);
  f.edit("second"); f.layout("layout-b");
  await vi.advanceTimersByTimeAsync(399); expect(f.port.writeState).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.port.writeState).toHaveBeenCalledExactlyOnceWith("/a", { key: "studio", version: "v1", value: { version: 2, draft: "second", layout: "layout-b" } });
  expect(f.persistence.unsynced).toBe(false); expect(f.draft()).toBe("second");
});

it("keeps edits made during a save dirty and serially persists the new text with the returned version", async () => {
  const f = fixture(); await f.persistence.restore();
  const first = deferred<ApplicationState>(), second = deferred<ApplicationState>();
  f.port.writeState.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  f.edit("captured"); const saving = f.persistence.flush();
  expect(f.port.writeState).toHaveBeenCalledTimes(1);
  f.edit("typed during save"); const alsoSaving = f.persistence.flush();
  expect(f.port.writeState).toHaveBeenCalledTimes(1); expect(f.persistence.unsynced).toBe(true);
  first.resolve({ ...f.port.writeState.mock.calls[0][1], version: "v2" }); await microtasks();
  expect(f.port.writeState).toHaveBeenCalledTimes(2);
  expect(f.port.writeState.mock.calls[1][1]).toEqual({ key: "studio", version: "v2", value: { version: 2, draft: "typed during save", layout: "layout-a" } });
  expect(f.persistence.unsynced).toBe(true); expect(f.draft()).toBe("typed during save");
  second.resolve({ ...f.port.writeState.mock.calls[1][1], version: "v3" });
  await saving; await alsoSaving;
  expect(f.persistence.unsynced).toBe(false); expect(f.port.writeState).toHaveBeenCalledTimes(2);
});

it("reconciles a lost save acknowledgement by reading the captured value without replaying its write", async () => {
  const f = fixture(); await f.persistence.restore();
  const write = f.port.writeState.getMockImplementation()!;
  f.port.writeState.mockImplementationOnce(async (project, state) => { await write(project, state); throw new Error("acknowledgement lost"); });
  f.edit("saved without reply"); await f.persistence.flush();
  expect(f.persistence.unsynced).toBe(true); expect(f.persistence.syncError).toBe("acknowledgement lost");
  await f.persistence.flush();
  expect(f.port.readState).toHaveBeenCalledTimes(2); expect(f.port.writeState).toHaveBeenCalledTimes(1);
  expect(f.persistence.unsynced).toBe(false); expect(f.persistence.stateConflict).toBeNull();
});

it("uses the acknowledged version when newer edits follow an unconfirmed save", async () => {
  const f = fixture(); await f.persistence.restore();
  const write = f.port.writeState.getMockImplementation()!;
  f.port.writeState.mockImplementationOnce(async (project, state) => { await write(project, state); throw new Error("acknowledgement lost"); });
  f.edit("captured"); await f.persistence.flush();
  f.edit("new local text"); await f.persistence.flush();
  expect(f.port.writeState).toHaveBeenCalledTimes(2);
  expect(f.port.writeState.mock.calls[1][1]).toMatchObject({ version: "v2", value: { draft: "new local text" } });
  expect(f.persistence.unsynced).toBe(false); expect(f.draft()).toBe("new local text");
});

it("retains local edits on multiwindow conflict and only replaces shared state after an explicit reviewed command", async () => {
  const f = fixture(); await f.persistence.restore();
  f.remote("other window"); f.edit("my draft"); await f.persistence.flush();
  expect(f.persistence.unsynced).toBe(true); expect(f.port.writeState).toHaveBeenCalledTimes(1);
  await f.persistence.flush();
  const conflict = f.persistence.stateConflict;
  expect(conflict?.value).toMatchObject({ draft: "other window" });
  expect(f.draft()).toBe("my draft"); expect(f.port.writeState).toHaveBeenCalledTimes(1);
  await expect(f.persistence.replaceSharedDrafts(structuredClone(conflict!))).rejects.toThrow("conflict changed");
  await f.persistence.replaceSharedDrafts(conflict!);
  expect(f.port.writeState).toHaveBeenCalledTimes(2);
  expect(f.disk().value).toMatchObject({ draft: "my draft" }); expect(f.persistence.unsynced).toBe(false);
});

it("does not overwrite a second concurrent edit made after the user reviewed a conflict", async () => {
  const f = fixture(); await f.persistence.restore();
  f.remote("other window"); f.edit("mine"); await f.persistence.flush(); await f.persistence.flush();
  const conflict = f.persistence.stateConflict!;
  f.remote("other window edited again");
  await f.persistence.replaceSharedDrafts(conflict);
  expect(f.persistence.unsynced).toBe(true); expect(f.draft()).toBe("mine");
  expect(f.disk().value).toMatchObject({ draft: "other window edited again" });
});

it("keeps failed reads and saves dirty without silently adopting another window's text", async () => {
  const f = fixture(); await f.persistence.restore();
  f.port.writeState.mockRejectedValueOnce(new Error("offline"));
  f.edit("local"); await f.persistence.flush();
  f.port.readState.mockRejectedValueOnce(new Error("still offline")); await f.persistence.flush();
  expect(f.persistence.unsynced).toBe(true); expect(f.persistence.syncError).toBe("still offline");
  expect(f.port.writeState).toHaveBeenCalledTimes(1); expect(f.draft()).toBe("local");
});

it("ignores an A-B-A restore reply that belongs to the old epoch", async () => {
  const f = fixture(), late = deferred<ApplicationState>();
  f.port.readState.mockReturnValueOnce(late.promise);
  const old = f.persistence.restore();
  f.setScope({ epoch: 2, project: "/b" }); await f.persistence.restore();
  f.setScope({ epoch: 3, project: "/a" }); f.remote("current A"); await f.persistence.restore();
  late.resolve({ key: "studio", version: "old", value: { draft: "old A" } }); await old;
  expect(f.draft()).toBe("current A"); expect(f.restore).toHaveBeenCalledTimes(2);
});

it.each(["success", "failure"])("late save %s cannot clear dirty state or errors for the new project", async (result) => {
  const f = fixture(); await f.persistence.restore();
  const late = deferred<ApplicationState>(); f.port.writeState.mockReturnValueOnce(late.promise);
  f.edit("old project"); const old = f.persistence.flush();
  f.persistence.stop(); f.setScope({ epoch: 2, project: "/b" }); await f.persistence.restore(); f.edit("new project");
  if (result === "success") late.resolve({ key: "studio", version: "old-reply", value: { draft: "old project" } });
  else late.reject(new Error("old project disconnected"));
  await old;
  expect(f.persistence.unsynced).toBe(true); expect(f.persistence.syncError).toBe(""); expect(f.draft()).toBe("new project");
  await f.persistence.flush();
  expect(f.port.writeState.mock.calls[1][0]).toBe("/b"); expect(f.port.writeState.mock.calls[1][1].version).toBe("v1");
});

it("stops pending save timers and discards a late restore without notifying disposed subscribers", async () => {
  const f = fixture(); await f.persistence.restore();
  const listener = vi.fn(); f.persistence.subscribe(listener);
  f.edit("unsaved"); f.persistence.stop(); f.persistence.dispose(); listener.mockClear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.port.writeState).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  const late = deferred<ApplicationState>(); f.port.readState.mockReturnValueOnce(late.promise);
  const restoring = f.persistence.restore(); f.persistence.stop();
  late.resolve({ key: "studio", version: "old", value: { draft: "late" } }); await restoring;
  expect(f.draft()).toBe("unsaved");
});

it.each(["success", "failure"])("reconciles its original committed value after a native epoch fences the save %s", async (result) => {
  const f = fixture(); await f.persistence.restore();
  const acknowledged = deferred<ApplicationState>(), write = f.port.writeState.getMockImplementation()!;
  f.port.writeState.mockImplementationOnce(async (project, state) => { await write(project, state); return acknowledged.promise; });
  f.edit("captured before R restart"); const saving = f.persistence.flush(); await microtasks();
  f.edit("typed during R restart"); f.setScope({ epoch: 2, session: "native-b" });
  if (result === "success") acknowledged.resolve(structuredClone(f.disk())); else acknowledged.reject(new Error("late acknowledgement failed"));
  await saving;
  expect(f.persistence.syncError).toBe(""); expect(f.persistence.unsynced).toBe(true);
  await f.persistence.flush();
  expect(f.port.readState).toHaveBeenCalledTimes(2);
  expect(f.port.writeState).toHaveBeenCalledTimes(2);
  expect(f.port.writeState.mock.calls[1][1]).toMatchObject({ version: "v2", value: { draft: "typed during R restart" } });
  expect(f.persistence.stateConflict).toBeNull(); expect(f.persistence.unsynced).toBe(false);
  expect(f.disk().value).toMatchObject({ draft: "typed during R restart" });
});

it("retains genuine concurrent edits when reconciling a save fenced by a native restart", async () => {
  const f = fixture(); await f.persistence.restore();
  const acknowledged = deferred<ApplicationState>(), write = f.port.writeState.getMockImplementation()!;
  f.port.writeState.mockImplementationOnce(async (project, state) => { await write(project, state); return acknowledged.promise; });
  f.edit("my captured text"); const saving = f.persistence.flush(); await microtasks();
  const ownReply = structuredClone(f.disk());
  f.edit("my newer text"); f.setScope({ epoch: 2, session: "native-b" }); f.remote("another window's newer text");
  acknowledged.resolve(ownReply); await saving; await f.persistence.flush();
  expect(f.port.writeState).toHaveBeenCalledTimes(1); expect(f.persistence.unsynced).toBe(true);
  expect(f.persistence.stateConflict?.value).toMatchObject({ draft: "another window's newer text" });
  expect(f.disk().value).toMatchObject({ draft: "another window's newer text" }); expect(f.draft()).toBe("my newer text");
});
