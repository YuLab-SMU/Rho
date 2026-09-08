import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch } from "diff";
import { history, undo } from "@codemirror/commands";
import { StateEffect } from "@codemirror/state";
import { Documents, filePatch, sha256 } from "../src/documents";
import type { Draft } from "../src/documents";
import type { DocumentPorts, ResourceIdentity } from "../src/resource-ports";
import type { OperationRecord } from "../src/generated/OperationRecord";

function draft(raw: string, path: string | null = "中文 文件.R"): Draft {
  return { id: "document-one", path, raw: raw.replace(/^\uFEFF/, ""), bom: raw.startsWith("\uFEFF"),
    eol: raw.includes("\r\n") ? "\r\n" : "\n", baseRaw: path ? raw : null, baseHash: path ? "sha256:original" : null,
    readonly: null, byteSize: raw.length, anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0 };
}
function fixture(raw = "x <- 1\n") {
  let scope: ResourceIdentity = { epoch: 1, project: "/project", session: "session", runtimeState: "idle", connected: true,
    capabilities: ["workspace.run_r"] };
  let closeVersion = 0;
  const query = vi.fn(), invoke = vi.fn(), run = vi.fn().mockResolvedValue({}), fileSaved = vi.fn(), show = vi.fn();
  const ports: DocumentPorts = {
    context: () => scope, query, invoke, run, fileSaved, schedule: vi.fn(), changed: vi.fn(), canRun: () => true,
    queueing: () => false, openDocument: show, renameDocument: vi.fn(), closeDocument: vi.fn(), closeVersion: () => closeVersion,
    reportError: vi.fn(),
  };
  const documents = new Documents(ports);
  documents.restore({ active: "document-one", items: [draft(raw)] });
  return { documents, query, invoke, run, fileSaved, show, ports,
    d: () => documents.getDocumentSnapshot("document-one")!,
    scope: (change: Partial<ResourceIdentity>) => { scope = { ...scope, ...change }; },
    closeViews: () => { closeVersion++; } };
}
function saved(hash: string, status = "succeeded", path = "中文 文件.R"): OperationRecord {
  return { operation: { operation_id: "op-test", capability: { id: "project.apply_patch", version: 1 } } as never,
    status: status as never, outcome: status as never, updated_at_ms: 1, cancellation_requested: false,
    recovery: null, error: status === "succeeded" ? null : "disk conflict",
    output: { after: { files: [{ path, sha256: hash }] } } };
}
function file(raw: string, path = "delayed.R", hash = "sha256:fixture") {
  return { status: "ready", data: { offset: 0, bytes: [...new TextEncoder().encode(raw)], has_more: false,
    file: { path, sha256: hash, byte_size: new TextEncoder().encode(raw).length } }, notices: [] };
}
afterEach(() => { vi.restoreAllMocks(); });
describe("document byte and save discipline", () => {
  it("preserves BOM and CRLF, including unchanged mixed line endings", () => {
    const { documents, d } = fixture("\uFEFF甲\r\n乙\n丙\r\n");
    documents.applyTransactions(d(), [d().state.update({ changes: { from: 2, to: 3, insert: "新\n行" } })]);
    expect(d().raw).toBe("\uFEFF甲\r\n新\r\n行\n丙\r\n");
  });
  it("uses a real diff with Unicode paths and exact byte line endings", () => {
    const before = "\uFEFF甲\r\n乙\r\n", after = "\uFEFF甲\r\n新\r\n";
    expect(applyPatch(before, filePatch("中文 文件.R", before, after), { autoConvertLineEndings: false })).toBe(after);
  });
  it.each(["中文 文件.R", 'quoted"name.R', "empty.R"])("Git creates only the intended path %s", (path) => {
    const directory = mkdtempSync(join(tmpdir(), "rho-diff-"));
    try {
      const value = path === "empty.R" ? "" : "\uFEFFx <- 1\r\n";
      execFileSync("git", ["apply", "-"], { cwd: directory, input: filePatch(path, null, value) });
      expect(readdirSync(directory)).toEqual([path]); expect(readFileSync(join(directory, path), "utf8")).toBe(value);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("refuses oversized patches without truncating text", () => {
    expect(() => filePatch("large.R", null, "中".repeat(80000))).toThrow("200 KiB");
  });
  it("keeps edits made during a save dirty and records only the saved snapshot", async () => {
    const { documents, d, invoke, fileSaved } = fixture(); documents.replace(d(), "x <- 2\n");
    let release!: (value: OperationRecord) => void;
    invoke.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const save = documents.save(d());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    documents.applyTransactions(d(), [d().state.update({ changes: { from: d().state.doc.length, insert: "y <- 3\n" } })]);
    const hash = await sha256("x <- 2\n"); release(saved(hash)); await save;
    expect(d().draft.baseRaw).toBe("x <- 2\n"); expect(d().raw).toBe("x <- 2\ny <- 3\n"); expect(d().dirty).toBe(true);
    expect(fileSaved).toHaveBeenCalledWith("/project", "中文 文件.R", hash);
  });
  it.each(["failed", "uncertain", "wrong-digest", "network"])("never runs a file after %s save", async (mode) => {
    const { documents, d, invoke, run } = fixture(); documents.replace(d(), "x <- 2\n");
    invoke.mockImplementation(async () => {
      if (mode === "network") throw new Error("network interrupted");
      return saved(mode === "wrong-digest" ? "sha256:wrong" : await sha256(d().raw),
        mode === "uncertain" ? "uncertain" : mode === "failed" ? "failed" : "succeeded");
    });
    await expect(documents.runFile(d())).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1); expect(invoke.mock.calls[0][0]).toBe("project.apply_patch");
    expect(run).not.toHaveBeenCalled(); expect(d().dirty).toBe(true); expect(d().saving).toBe(false);
  });
  it("runs exactly the click snapshot after a confirmed save despite later typing", async () => {
    const { documents, d, invoke, run } = fixture(); documents.replace(d(), "x <- 2\n");
    invoke.mockImplementation(async () => { documents.replace(d(), "x <- 999\n"); return saved(await sha256("x <- 2\n")); });
    await documents.runFile(d());
    expect(run).toHaveBeenCalledWith("x <- 2\n", { view_id: d().id, kind: "file", label: "中文 文件.R" });
    expect(d().raw).toBe("x <- 999\n"); expect(d().dirty).toBe(true);
  });
  it("keeps concurrent edits when formatting returns and offers the captured comparison", async () => {
    const { documents, d, invoke } = fixture("x=1");
    invoke.mockImplementation(async () => {
      documents.replace(d(), "x <- 99 # newer text");
      return { ...saved("unused"), output: { value: { code: "x <- 1", changed: true, tool_version: "fixture" } } };
    });
    await documents.format(d()); expect(d().raw).toBe("x <- 99 # newer text");
    expect(d().comparison).toEqual({ before: "x=1", formatted: "x <- 1" });
    documents.acceptFormatted(d()); expect(d().raw).toBe("x <- 1"); expect(d().comparison).toBeNull();
  });
  it("a newer format request owns the result and a late first result is discarded", async () => {
    const { documents, d, invoke } = fixture("x=1"); let release!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const old = documents.format(d());
    documents.replace(d(), "y=2");
    invoke.mockResolvedValueOnce({ ...saved("unused"), output: { value: { code: "y <- 2" } } });
    await documents.format(d()); release({ ...saved("unused"), output: { value: { code: "x <- 1" } } });
    await expect(old).rejects.toThrow("discarded"); expect(d().raw).toBe("y <- 2"); expect(d().comparison).toBeNull();
  });
});

it("deduplicates pending file reads and never reopens a view closed during the read", async () => {
  const { documents, query, show, closeViews } = fixture(); let release!: (value: unknown) => void;
  query.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const first = documents.open("delayed.R"), second = documents.open("delayed.R");
  expect(query).toHaveBeenCalledTimes(1); closeViews(); release(file("1+1"));
  const loaded = await first; expect(await second).toBe(loaded); expect(documents.items.size).toBe(2); expect(show).not.toHaveBeenCalled();
});
it("A → B → A cannot merge an old read or clear the new same-path in-flight read", async () => {
  const { documents, query, scope } = fixture(); let oldRelease!: (value: unknown) => void, newRelease!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise((resolve) => { oldRelease = resolve; }));
  const old = documents.open("delayed.R");
  scope({ project: "/other", epoch: 2 }); documents.restore(null);
  scope({ project: "/project", epoch: 3 }); documents.restore(null);
  query.mockImplementationOnce(() => new Promise((resolve) => { newRelease = resolve; }));
  const fresh = documents.open("delayed.R"); oldRelease(file("old")); await expect(old).rejects.toThrow("discarded");
  const duplicate = documents.open("delayed.R"); expect(query).toHaveBeenCalledTimes(2);
  newRelease(file("fresh")); const value = await fresh; expect(await duplicate).toBe(value);
  expect([...documents.items.values()].map((d) => d.raw)).toEqual(["fresh"]);
});
it("late save failure and cleanup cannot change a restored same-id draft", async () => {
  const { documents, d, invoke, scope } = fixture(); documents.replace(d(), "x <- 2\n");
  let reject!: (value: Error) => void;
  invoke.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const old = documents.save(d()); await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  scope({ project: "/other", epoch: 2 }); documents.restore({ active: "document-one", items: [draft("new project")] });
  reject(new Error("old failure")); await expect(old).rejects.toThrow("old failure");
  expect(d().raw).toBe("new project"); expect(d().error).toBe(""); expect(d().saving).toBe(false);
});
it("same-project R restart prevents Run File from submitting saved code and retains drafts", async () => {
  const { documents, d, invoke, scope, run } = fixture(); documents.replace(d(), "x <- 2\n");
  invoke.mockImplementation(async () => {
    scope({ session: "restarted" }); documents.sessionChanged(); return saved(await sha256("x <- 2\n"));
  });
  await expect(documents.runFile(d())).rejects.toThrow("discarded");
  expect(run).not.toHaveBeenCalled(); expect(d().raw).toBe("x <- 2\n"); expect(d().runningFile).toBe(false);
});
it("stopping during a read drops its result and notifications", async () => {
  const { documents, query } = fixture(); let release!: (value: unknown) => void;
  query.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const read = documents.open("delayed.R"), notify = vi.fn(); await Promise.resolve(); documents.subscribe(notify); documents.stop();
  release(file("late")); await expect(read).rejects.toThrow("discarded"); await Promise.resolve();
  expect(documents.items.size).toBe(1); expect(notify).not.toHaveBeenCalled();
});
it("only the edited document's subscribers redraw and snapshots reject direct mutation", async () => {
  const { documents, d } = fixture(); const second = documents.create(); await Promise.resolve();
  const firstNotify = vi.fn(), secondNotify = vi.fn();
  documents.subscribeDocument(d().id, firstNotify); documents.subscribeDocument(second.id, secondNotify);
  const before = documents.getDocumentSnapshot(second.id); documents.replace(d(), "edited"); await Promise.resolve();
  expect(firstNotify).toHaveBeenCalledTimes(1); expect(secondNotify).not.toHaveBeenCalled(); expect(documents.getDocumentSnapshot(second.id)).toBe(before);
  expect((documents.items as unknown as Map<string, unknown>).set).toBeUndefined();
  expect(() => { (d().draft as Draft).raw = "bypass"; }).toThrow();
});
it("rejects an inconsistent Save As target page before submitting a patch", async () => {
  const { documents, d, query, invoke } = fixture();
  query.mockResolvedValueOnce({ status: "ready", notices: [], data: { files: [{ path: "target.R", kind: "regular", sha256: "h", byte_size: 3 }] } });
  query.mockResolvedValueOnce(file("abc", "other.R", "h"));
  await expect(documents.save(d(), "new", "target.R", true)).rejects.toThrow("changed while reading");
  expect(invoke).not.toHaveBeenCalled();
});

it("preserves editor selection and undo when a view reconfigures its extensions", () => {
  const { documents, d } = fixture("first");
  documents.applyTransactions(d(), [d().state.update({ effects: StateEffect.reconfigure.of([history()]) })]);
  documents.applyTransactions(d(), [d().state.update({ changes: { from: 0, to: 5, insert: "second" }, selection: { anchor: 3 } })]);
  documents.applyTransactions(d(), [d().state.update({ effects: StateEffect.reconfigure.of([history()]) })]);
  expect(d().state.selection.main.head).toBe(3);
  expect(undo({ state: d().state, dispatch: (transaction) => { documents.applyTransactions(d(), [transaction]); } })).toBe(true);
  expect(d().raw).toBe("first");
});
it("old view callbacks cannot mutate a restored draft with the same persisted id", () => {
  const { documents, d, scope } = fixture("original"), oldView = d();
  scope({ epoch: 2, project: "/other" }); documents.restore(null);
  scope({ epoch: 3, project: "/project" }); documents.restore({ active: "document-one", items: [draft("restored")] });
  documents.setScroll(oldView, 999, 999); documents.setError(oldView, "old view error");
  expect(documents.owns(oldView)).toBe(false); expect(() => documents.replace(oldView, "old edit")).toThrow("another project");
  expect(d().raw).toBe("restored"); expect(d().error).toBe(""); expect(d().draft.scrollTop).toBe(0);
});
