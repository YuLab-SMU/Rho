import { expect, it, vi } from "vitest";
import { Help } from "../src/help.js";
import { copy, index, page, ready } from "./fixtures.js";
function fixture(saved?: unknown) {
  let session: string | null = copy.nativeSession;
  const query = vi.fn(async (id, _args) => ready(id === "r.package_index" ? index : page));
  const changed = vi.fn(), schedule = vi.fn();
  const help = new Help({ session: () => session, query, changed, schedule } as never, copy, saved);
  return { help, query, changed, schedule, session: (value: string | null) => { session = value; } };
}
it("pins the static index and every Help read to the original observed copy", async () => {
  const f = fixture(); await f.help.observe(); f.help.open("demo"); await f.help.observe();
  expect(f.query.mock.calls[0]).toEqual(["r.package_index", { expected_session: copy.nativeSession, observation_id: copy.observation,
    package: "demo", library_path: copy.libraryPath, index_ref: null, filter: "", kind: "topic", offset: 0, limit: 100 }]);
  expect(f.query.mock.calls[1]).toEqual(["r.read_help", { expected_session: copy.nativeSession, observation_id: copy.observation,
    package: "demo", library_path: copy.libraryPath, topic: "demo", expected_index_files: index.files,
    expected_help_files: null, offset_utf8: 0, limit_bytes: 32768, format: "html" }]);
  expect(f.help.getSnapshot().page?.text).toBe(page.text); expect(f.help.needsObservation).toBe(false);
  expect(Object.isFrozen(f.help.getSnapshot().index?.files[0])).toBe(true);
});
it("joins UTF-8 chunks while retaining original file identities and exposes incomplete markup as incomplete", async () => {
  const f = fixture(); await f.help.observe(); f.help.open("demo");
  f.query.mockResolvedValueOnce(ready({ ...page, text: "<p>中", next_offset_utf8: 6, complete: false }) as never);
  await f.help.observe(); expect(f.help.getSnapshot().page).toMatchObject({ text: "<p>中", complete: false });
  f.query.mockResolvedValueOnce(ready({ ...page, text: "文</p>", offset_utf8: 6 }) as never);
  await f.help.observe(); expect(f.help.getSnapshot().page).toMatchObject({ text: page.text, complete: true, offset_utf8: 0 });
  expect(f.query.mock.calls[2][1]).toMatchObject({ offset_utf8: 6, expected_help_files: page.help_files });
});
it.each([
  { topic: "other" }, { format: "text" }, { library_path: "/other" }, { version: "2.0" },
  { observation_id: "new-observation" }, { total_bytes: 12 }, { next_offset_utf8: 8 },
  { help_files: [null, null, null, null] }, { found: false },
])("rejects mismatched or malformed Help continuations (%j)", async patch => {
  const f = fixture(); await f.help.observe(); f.help.open("demo");
  f.query.mockResolvedValueOnce(ready({ ...page, ...patch }) as never); await f.help.observe();
  expect(f.help.getSnapshot()).toMatchObject({ page: null, requiresNewObservation: true });
  const count = f.query.mock.calls.length; f.help.retry(); await f.help.observe(); expect(f.query).toHaveBeenCalledTimes(count);
});
it("retains the partial document but refuses a changed Help database on continuation", async () => {
  const f = fixture(); await f.help.observe(); f.help.open("demo");
  f.query.mockResolvedValueOnce(ready({ ...page, text: "<p>中", next_offset_utf8: 6, complete: false }) as never); await f.help.observe();
  f.query.mockResolvedValueOnce(ready({ ...page, text: "文</p>", offset_utf8: 6,
    help_files: page.help_files.map(file => ({ ...file, digest: "changed" })) }) as never); await f.help.observe();
  expect(f.help.getSnapshot()).toMatchObject({ page: { text: "<p>中", complete: false }, requiresNewObservation: true });
});
it("retains unresolved declarations and reuses the index reference for search and pagination", async () => {
  const f = fixture(); f.query.mockResolvedValueOnce(ready({ ...index, complete: false, notices: ["Conditional exports are not evaluated."] }));
  await f.help.observe(); expect(f.help.getSnapshot().index?.complete).toBe(false);
  expect(f.help.getSnapshot().notice).toContain("not evaluated"); f.help.search("文");
  f.query.mockResolvedValueOnce(ready({ ...index, total: 2, next_offset: 1 })); await f.help.observe();
  expect(f.query.mock.calls[1][1]).toMatchObject({ filter: "文", index_ref: index.index_ref, offset: 0 });
  f.help.indexPage(1); f.query.mockResolvedValueOnce(ready({ ...index, offset: 1, total: 2 })); await f.help.observe();
  expect(f.help.getSnapshot().index?.offset).toBe(1); expect(f.query.mock.calls[2][1]).toMatchObject({ index_ref: index.index_ref, offset: 1 });
});
it.each([{ index_ref: "replacement" }, { files: index.files.map(file => ({ ...file, digest: "changed" })) },
  { next_offset: 0 }, { entries: [], total: 1 }, { offset: 1 }])("refuses index identity or cursor changes (%j)", async patch => {
  const f = fixture(); await f.help.observe(); f.help.search("demo");
  f.query.mockResolvedValueOnce(ready({ ...index, ...patch })); await f.help.observe();
  expect(f.help.getSnapshot()).toMatchObject({ requiresNewObservation: true, index: { index_ref: index.index_ref } });
});
it.each(["observation_expired", "observation_invalid", "content_changed"])("requires explicit new selection after %s without replacing the old observation", async code => {
  const f = fixture(); f.query.mockResolvedValueOnce({ ...ready(index), status: "unavailable", data: null,
    diagnostic: { code, message: "Original copy is no longer available." } } as never);
  await f.help.observe(); f.help.open("another"); f.help.retry(); await f.help.observe();
  expect(f.help.getSnapshot()).toMatchObject({ requiresNewObservation: true, notice: "Original copy is no longer available." });
  expect(f.query).toHaveBeenCalledTimes(1);
});
it("busy or transient unavailability retries only the same pending read", async () => {
  const f = fixture(); f.query.mockResolvedValueOnce({ ...ready(index), status: "busy", data: null, notices: ["R is busy."] } as never);
  await f.help.observe(); expect(f.help.getSnapshot()).toMatchObject({ notice: "R is busy.", requiresNewObservation: false });
  expect(f.query).toHaveBeenCalledTimes(1); await f.help.observe(); expect(f.query.mock.calls[1]).toEqual(f.query.mock.calls[0]);
});
it("joins concurrent reads and ignores both late search results and failures", async () => {
  const f = fixture(); let finish!: (value: never) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = f.help.observe(); expect(f.help.observe()).toBe(first); await Promise.resolve();
  f.help.search("new"); finish(ready(index) as never); await first; expect(f.help.getSnapshot().index).toBeNull();
  let reject!: (value: Error) => void; f.query.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const second = f.help.observe(); await Promise.resolve(); f.help.search("latest"); reject(new Error("obsolete")); await second;
  expect(f.help.getSnapshot().notice).toBe(""); await f.help.observe(); expect(f.query.mock.calls.at(-1)?.[1]).toMatchObject({ filter: "latest" });
});
it("ignores late pages and failures after selecting another topic or stopping", async () => {
  const f = fixture(); await f.help.observe(); f.help.open("demo"); let finish!: (value: never) => void;
  f.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const first = f.help.observe(); await Promise.resolve();
  f.help.open("next"); finish(ready(page) as never); await first; expect(f.help.getSnapshot().page).toBeNull();
  let reject!: (error: Error) => void; f.query.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const second = f.help.observe(); await Promise.resolve(); f.help.open("final"); reject(new Error("old")); await second;
  expect(f.help.getSnapshot().notice).toBe(""); f.help.stop(); await f.help.observe(); expect(f.query).toHaveBeenCalledTimes(3);
});
it("refuses session replacement before or during reads and foreign response envelopes", async () => {
  const f = fixture(); f.session("other"); await f.help.observe(); expect(f.query).not.toHaveBeenCalled();
  const g = fixture(); let finish!: (value: never) => void; g.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = g.help.observe(); await Promise.resolve(); g.session(null); finish(ready(index) as never); await pending;
  expect(g.help.getSnapshot().requiresNewObservation).toBe(true);
  const h = fixture(); h.query.mockResolvedValueOnce({ ...ready(index), session_id: "other" }); await h.help.observe();
  expect(h.help.getSnapshot().requiresNewObservation).toBe(true);
});
it("persists bounded presentation choices only, never a cached page or authority", async () => {
  const f = fixture({ filter: "中文", topic: "demo", format: "text", raw: false, indexVisible: false, scrollTop: 42, copy: { ...copy, version: "other" }, page });
  expect(f.help.serialize()).toEqual({ indexKind: "topic", filter: "中文", topic: "demo", format: "text", raw: false, indexVisible: false, scrollTop: 42 });
  expect(f.help.getSnapshot().copy).toEqual(copy); expect(f.help.getSnapshot().page).toBeNull();
  expect(() => f.help.search("中".repeat(43))).toThrow("128"); expect(() => f.help.open("x\n")).toThrow("bounded");
  expect(() => f.help.indexPage(-1)).toThrow("observed");
  const g = fixture({ filter: "\0", topic: "\n", format: "javascript", scrollTop: -1 });
  expect(g.help.serialize()).toEqual({ indexKind: "topic", filter: "", topic: null, format: "html", raw: false, indexVisible: true, scrollTop: 0 });
});
it("switches between documented topics and aliases on the same index and reopens the selected topic", async () => {
  const f = fixture(); await f.help.observe(); f.help.setIndexKind("alias"); await f.help.observe();
  expect(f.query.mock.calls.at(-1)?.[1]).toMatchObject({ kind: "alias", index_ref: index.index_ref });
  f.help.open("demo"); await f.help.observe(); f.help.setIndexVisible(true); f.help.open("demo");
  expect(f.help.getSnapshot().indexVisible).toBe(false); expect(f.query).toHaveBeenCalledTimes(3);
});
