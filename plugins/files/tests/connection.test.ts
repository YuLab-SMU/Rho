import { afterEach, expect, it, vi } from "vitest";
import { FilesConnection } from "../src/connection.js";
const source = { instance: "files-one", plugin: "org.rho.files", revision: "revision", artifact: "artifact" };
const connections: FilesConnection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.stop(); vi.useRealTimers(); });
function fixture(state: unknown = {}) {
  vi.useFakeTimers();
  let root = "/native/project";
  const query = vi.fn<(...args: any[]) => Promise<any>>(async (cap, args) => ({ status: "ready", notices: [], data:
    cap.id === "workspace.paths" ? { project_root: root, protected_paths: [] } :
    cap.id === "files.storage_status" ? { project: root, total_bytes: 1000, available_bytes: 500, free_bytes: 600, observed_at_ms: 1 } :
    { path: args.arguments.path, entries: [{ path: "分析.R", name: "分析.R", kind: "regular", byte_size: 8 }], next_name: null, notices: [] },
  }));
  const setState = vi.fn<(...args: any[]) => Promise<any>>(async state => ({ state }));
  const owner = new FilesConnection({ view: { instance: source, project: "opaque-project", state }, query, setState } as never);
  connections.push(owner);
  return { owner, query, setState, root: (value: string) => { root = value; } };
}
it("uses the exact own provider and opaque project while retaining the normalized native root", async () => {
  const f = fixture(); await f.owner.refresh();
  expect(f.query.mock.calls.map(([cap]) => cap.id)).toEqual(["workspace.paths", "files.list_directory", "files.storage_status"]);
  for (const [cap, args] of f.query.mock.calls.slice(1)) expect(args.binding).toEqual({ capability: cap, provider: source, project: "opaque-project", target: "/native/project" });
  expect(f.owner.nativeRoot).toBe("/native/project"); expect(f.owner.files.directories.get("")?.entries[0].path).toBe("分析.R");
  await f.owner.refresh(); expect(f.query.mock.calls.filter(([cap]) => cap.id === "files.list_directory")).toHaveLength(1);
  await f.owner.refresh(true); expect(f.query.mock.calls.filter(([cap]) => cap.id === "files.list_directory")).toHaveLength(2);
});
it("a failed read retains cached entries, defers retries and never retargets the project", async () => {
  const f = fixture(); await f.owner.refresh();
  f.query.mockResolvedValueOnce({ status: "ready", data: { project_root: "/native/project" } });
  f.query.mockRejectedValueOnce(Object.assign(new Error("The patch is waiting for settlement"), { diagnostic: { code: "busy", recovery: "read_again" } }));
  await expect(f.owner.refresh(true)).rejects.toThrow("settlement");
  expect(f.owner.files.directories.get("")?.entries).toHaveLength(1); expect(f.owner.files.getSnapshot().stale).toBe(true);
  const count = f.query.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(f.query).toHaveBeenCalledTimes(count);
  await f.owner.refresh(); expect(f.owner.getSnapshot().connected).toBe(true);
  f.root("/other"); await expect(f.owner.refresh()).rejects.toThrow("original project path");
  expect(f.owner.nativeRoot).toBe("/native/project"); expect(f.owner.files.directories.get("")?.entries).toHaveLength(1);
});
it("close capture waits for earlier saves, preserves reverted choices and resumes without lost state", async () => {
  const f = fixture(); await f.owner.refresh();
  let finish!: () => void;
  f.setState.mockImplementationOnce(value => new Promise(resolve => { finish = () => resolve({ state: value }); }));
  f.owner.files.setFilter("temporary"); const first = f.owner.flush(); await Promise.resolve();
  f.owner.files.setFilter(""); f.owner.files.setScroll(110); await f.owner.pause();
  const final = f.owner.flush(); finish(); await first; await final;
  expect(f.setState.mock.calls.at(-1)?.[0]).toMatchObject({ files: { filesScrollTop: 110, fileSearch: { filter: "" } } });
  const count = f.query.mock.calls.length; await f.owner.refresh(true); await vi.advanceTimersByTimeAsync(5000); expect(f.query).toHaveBeenCalledTimes(count);
  f.owner.resume(); await f.owner.refresh(); expect(f.query.mock.calls.length).toBeGreaterThan(count);
});
it("late observations after disposal cannot repopulate the view", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const refresh = f.owner.refresh(); f.owner.stop(); finish({ status: "ready", data: { project_root: "/native/project" } }); await refresh;
  expect(f.query).toHaveBeenCalledTimes(1); expect(f.owner.nativeRoot).toBeNull(); expect(f.owner.files.directories.size).toBe(0);
});
it("save errors keep the unsaved choice available for an explicit retry", async () => {
  const f = fixture(); f.owner.files.setFilter("中文"); f.setState.mockRejectedValueOnce(new Error("store offline"));
  await expect(f.owner.flush()).rejects.toThrow("store offline"); expect(f.owner.getSnapshot().saveError).toContain("not saved");
  await f.owner.flush(); expect(f.owner.getSnapshot().saveError).toBe("");
  expect(f.setState.mock.calls.at(-1)?.[0]).toMatchObject({ files: { fileSearch: { filter: "中文" } } });
});

it("unavailable disk capacity does not disable the successfully observed Files provider", async () => {
  const f = fixture();
  f.query.mockResolvedValueOnce({ status: "ready", data: { project_root: "/native/project" } });
  f.query.mockResolvedValueOnce({ status: "ready", data: { path: "", entries: [], next_name: null, notices: [] } });
  f.query.mockRejectedValueOnce(new Error("Disk capacity unavailable")); await f.owner.refresh();
  expect(f.owner.getSnapshot()).toMatchObject({ connected: true, notice: "Disk capacity unavailable" });
  expect(f.owner.files.getSnapshot().storageError).toBe("Disk capacity unavailable");
});
it("retains the original Agent request after lost save and restores without reading a replacement file",async()=>{
 const f=fixture();const saved={input:{request:'input-one',source_view:'view',title:'Original file',instance:null,
   reference:{provider:source,window:'window',contribution:'files',selector:{path:'分析.R',sha256:'original',native_identity:'native'}},inclusion:{kind:'text'},preview:{id:'files.context.preview',version:1}},
   pending:{view:'view',request:'original-opening',operation:'original-operation',capability:{id:'windows.open_view',version:1},arguments:{original:true}},opened:null};
 f.setState.mockRejectedValueOnce(Error('lost save'));
 await expect(f.owner.saveAgent(saved)).rejects.toThrow('lost save');await f.owner.flush();
 const restored=fixture(f.setState.mock.calls.at(-1)![0]);expect(restored.owner.savedAgent).toEqual(saved);
 const detached=restored.owner.savedAgent!;detached.pending!.request='changed';
 expect(restored.owner.savedAgent?.pending?.request).toBe('original-opening');expect(restored.query).not.toHaveBeenCalled();
});
