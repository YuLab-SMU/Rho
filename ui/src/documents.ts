import { EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { Model, readonlyMap } from "./shared/model";
import { sameScope } from "./shared/ports";
import type { DocumentPorts, ResourceIdentity } from "./resource-ports";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const isR = (path: string | null) => path === null || /\.[rR]$/.test(path);
import type { FilePage } from "./generated/FilePage";
import type { ProjectSnapshot } from "./generated/ProjectSnapshot";
import type { ProjectPatchResult } from "./generated/ProjectPatchResult";
import type { RunROutput } from "./generated/RunROutput";
import type { FormatResult } from "./generated/FormatResult";
import type { ApplicationDocument } from "./generated/ApplicationDocument";
import type { ApplicationDocumentRef } from "./generated/ApplicationDocumentRef";
import type { ApplicationTextEdit } from "./generated/ApplicationTextEdit";

export const MAX_EDIT_BYTES = 512 * 1024;
export const normalizeText = (raw: string) => raw.replace(/\r\n|\r/g, "\n");
export const bytes = (text: string) => new TextEncoder().encode(text);
export async function sha256(text: string) {
  return (
    "sha256:" +
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(text))),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
export function validatePath(path: string) {
  if (
    !path ||
    bytes(path).length > 1024 ||
    /[\\\x00-\x1f\x7f:]/u.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("Use a project-relative path without .git or ..");
}
const quotePath = (path: string) => `"${path.replace(/"/g, '\\"')}"`;
export function filePatch(
  path: string,
  before: string | null,
  after: string,
): string {
  validatePath(path);
  if (after.includes("\0"))
    throw new Error("Text contains NUL. The file was not written.");
  const a = quotePath("a/" + path),
    b = quotePath("b/" + path);
  const hunks = createTwoFilesPatch(
    before === null ? "/dev/null" : "a/" + path,
    "b/" + path,
    before ?? "",
    after,
    "",
    "",
    {
      context: 3,
      stripTrailingCr: false,
      timeout: 1000,
      maxEditLength: 20000,
      headerOptions: FILE_HEADERS_ONLY,
    },
  );
  if (hunks === undefined)
    throw new Error("The diff is too large. Your draft is retained.");
  const patch = `diff --git ${a} ${b}\n${before === null ? "new file mode 100644\n" : ""}${hunks}`;
  if (bytes(patch).length > 200 * 1024)
    throw new Error(
      "The save patch exceeds 200 KiB. Your draft is retained; the file was not written.",
    );
  return patch;
}
function rawOffset(raw: string, offset: number) {
  if (!raw.includes("\r")) return Math.min(offset, raw.length);
  let position = 0;
  for (
    let count = 0;
    count < offset && position < raw.length;
    count++, position++
  ) {
    if (raw[position] === "\r" && raw[position + 1] === "\n") position++;
  }
  return position;
}
export interface Draft {
  id: string;
  path: string | null;
  raw: string;
  bom: boolean;
  eol: string;
  baseRaw: string | null;
  baseHash: string | null;
  readonly: string | null;
  byteSize: number;
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
  version?: string;
  selectionVersion?: string;
}

export interface DocumentSnapshot {
  readonly id: string;
  readonly path: string | null;
  readonly name: string;
  readonly version: string;
  readonly selectionVersion: string;
  readonly raw: string;
  readonly dirty: boolean;
  readonly draft: Readonly<Draft>;
  readonly state: EditorState;
  readonly saving: boolean;
  readonly runningFile: boolean;
  readonly error: string;
  readonly comparison: Readonly<{ before: string; formatted: string }> | null;
  readonly diskComparison: Readonly<{ raw: string; hash: string }> | null;
}
export type DocumentRef = string | Pick<DocumentSnapshot, "id">;
interface DocumentsSnapshot {
  readonly active: string | null;
  readonly items: ReadonlyMap<string, DocumentSnapshot>;
}
class DocumentState {
  state: EditorState;
  saving = false;
  runningFile = false;
  error = "";
  comparison: { before: string; formatted: string } | null = null;
  diskComparison: { raw: string; hash: string } | null = null;
  snapshot: DocumentSnapshot | null = null;
  generations = new Map<string, number>();
  constructor(readonly draft: Draft) {
    draft.version ??= crypto.randomUUID();
    draft.selectionVersion ??= crypto.randomUUID();
    const text = normalizeText(draft.raw);
    this.state = EditorState.create({
      doc: text,
      selection: {
        anchor: Math.min(draft.anchor, text.length),
        head: Math.min(draft.head, text.length),
      },
    });
  }
  get raw() { return (this.draft.bom ? "\uFEFF" : "") + this.draft.raw; }
  get name() { return this.draft.path?.split("/").at(-1) ?? "Untitled.R"; }
  read(): DocumentSnapshot {
    if (this.snapshot) return this.snapshot;
    this.snapshot = Object.freeze({
      id: this.draft.id, path: this.draft.path, name: this.name, raw: this.raw,
      version: this.draft.version!, selectionVersion: this.draft.selectionVersion!,
      dirty: this.draft.baseRaw !== this.raw, draft: Object.freeze({ ...this.draft }),
      state: this.state, saving: this.saving, runningFile: this.runningFile,
      error: this.error,
      comparison: this.comparison && Object.freeze({ ...this.comparison }),
      diskComparison: this.diskComparison && Object.freeze({ ...this.diskComparison }),
    });
    snapshotOwners.set(this.snapshot, this);
    return this.snapshot;
  }
  update(transaction: Transaction) {
    if (transaction.startState !== this.state)
      throw new Error("The editor changed before this edit could be applied.");
    if (transaction.docChanged) {
      this.draft.version = crypto.randomUUID();
      let value = "", end = 0;
      const raw = this.draft.raw;
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        value += raw.slice(end, rawOffset(raw, from)) + inserted.toString().replace(/\n/g, this.draft.eol);
        end = rawOffset(raw, to);
      });
      this.draft.raw = value + raw.slice(end);
    }
    this.state = transaction.state;
    if (transaction.docChanged || !transaction.startState.selection.eq(transaction.state.selection)) this.draft.selectionVersion = crypto.randomUUID();
    this.draft.anchor = this.state.selection.main.anchor;
    this.draft.head = this.state.selection.main.head;
    this.snapshot = null;
  }
  replace(text: string) {
    this.update(this.state.update({
      changes: { from: 0, to: this.state.doc.length, insert: normalizeText(text) },
      selection: { anchor: 0 },
    }));
  }
}

const snapshotOwners = new WeakMap<DocumentSnapshot, DocumentState>();

/** Owns all editable state, including the persistent CodeMirror state object. */
export class Documents extends Model<DocumentsSnapshot> {
  private opening = new Map<string, Promise<DocumentSnapshot>>();
  private entries = new Map<string, DocumentState>();
  private activeId: string | null = null;
  private revision = 0;
  private stopped = false;
  private documentListeners = new Map<string, Set<() => void>>();
  private pendingDocuments = new Set<string>();
  private flushPending = false;
  constructor(private readonly ports: DocumentPorts) { super(); }
  protected readSnapshot(): DocumentsSnapshot {
    return { active: this.activeId, items: readonlyMap(new Map([...this.entries].map(([id, d]) => [id, d.read()]))) };
  }
  get items() { return this.getSnapshot().items; }
  get active() { return this.activeId; }
  get current() { return this.activeId ? this.getDocumentSnapshot(this.activeId) : null; }
  getDocumentSnapshot = (id: string) => this.entries.get(id)?.read() ?? null;
  subscribeDocument = (id: string, listener: () => void) => {
    const listeners = this.documentListeners.get(id) ?? new Set<() => void>();
    this.documentListeners.set(id, listeners);
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.documentListeners.delete(id); };
  };
  private emitDocument(id: string) {
    this.pendingDocuments.add(id);
    if (this.flushPending) return;
    this.flushPending = true;
    queueMicrotask(() => {
      this.flushPending = false;
      const ids = [...this.pendingDocuments];
      this.pendingDocuments.clear();
      for (const key of ids) for (const fn of this.documentListeners.get(key) ?? []) fn();
    });
  }
  private changed(document?: DocumentState, persist = true) {
    if (document) { document.snapshot = null; this.emitDocument(document.draft.id); }
    if (persist) this.ports.changed();
    this.publish();
  }
  private resolve(ref: DocumentRef): DocumentState {
    const entry = this.entries.get(typeof ref === "string" ? ref : ref.id);
    if (!entry || !this.owns(ref)) throw new Error("This draft was discarded or belongs to another project.");
    return entry;
  }
  owns(ref: DocumentRef): boolean {
    const entry = this.entries.get(typeof ref === "string" ? ref : ref.id);
    return !!entry && (typeof ref === "string" || !snapshotOwners.has(ref as DocumentSnapshot) || snapshotOwners.get(ref as DocumentSnapshot) === entry);
  }
  private guard(document?: DocumentState, kind = "read", native = false) {
    const identity = { ...this.ports.context() }, revision = this.revision;
    const generation = document ? (document.generations.get(kind) ?? 0) + 1 : 0;
    document?.generations.set(kind, generation);
    const current = () => !this.stopped && revision === this.revision && sameScope(identity, this.ports.context(), native)
      && (!document || (this.entries.get(document.draft.id) === document && document.generations.get(kind) === generation));
    return { identity, current, assert: () => { if (!current()) throw new Error("The project or session changed. This result was discarded."); } };
  }
  serialize() {
    return { active: this.activeId, items: [...this.entries.values()].map((d) => ({ ...d.draft })) };
  }
  restore(value: unknown) {
    this.reset();
    if (!value || typeof value !== "object") return;
    const data = value as { active?: string; items?: Draft[] };
    if (!Array.isArray(data.items)) return;
    for (const raw of data.items.slice(0, 64)) {
      if (!raw || typeof raw.id !== "string" || typeof raw.raw !== "string" ||
          (typeof raw.path !== "string" && raw.path !== null) ||
          (typeof raw.baseRaw !== "string" && raw.baseRaw !== null) || bytes(raw.raw).length > MAX_EDIT_BYTES * 2) continue;
      try {
        if (raw.path) validatePath(raw.path);
        const finite = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;
        const draft: Draft = {
          ...raw, bom: raw.bom === true, eol: ["\n", "\r\n", "\r"].includes(raw.eol) ? raw.eol : "\n",
          anchor: Number.isSafeInteger(raw.anchor) ? finite(raw.anchor) : 0,
          head: Number.isSafeInteger(raw.head) ? finite(raw.head) : 0,
          scrollTop: finite(raw.scrollTop), scrollLeft: finite(raw.scrollLeft),
          readonly: typeof raw.readonly === "string" ? raw.readonly : null,
          baseHash: typeof raw.baseHash === "string" ? raw.baseHash : null,
          byteSize: finite(raw.byteSize),
        };
        this.entries.set(draft.id, new DocumentState(draft));
        this.emitDocument(draft.id);
      } catch { this.ports.reportError("Some draft state could not be restored. Project files are intact."); }
    }
    this.activeId = data.active && this.entries.has(data.active) ? data.active : null;
    this.publish();
  }
  reset() {
    this.revision++;
    this.stopped = false;
    for (const id of this.entries.keys()) this.emitDocument(id);
    this.entries.clear(); this.opening.clear(); this.activeId = null; this.publish();
  }
  sessionChanged() {
    for (const d of this.entries.values()) {
      for (const kind of ["run", "format", "action"]) d.generations.set(kind, (d.generations.get(kind) ?? 0) + 1);
      d.runningFile = false; this.changed(d, false);
    }
  }
  stop() {
    this.stopped = true; this.revision++; this.opening.clear();
    for (const d of this.entries.values()) { d.saving = false; d.runningFile = false; d.snapshot = null; }
    this.documentListeners.clear(); this.pendingDocuments.clear(); this.publish(); this.dispose();
  }
  activate(ref: DocumentRef) {
    const d = this.resolve(ref);
    if (this.activeId === d.draft.id) return;
    this.activeId = d.draft.id; this.changed();
  }
  focus(ref: DocumentRef) {
    const d = this.resolve(ref); this.activate(ref); this.ports.openDocument(d.draft.id, d.name);
  }
  create() {
    return this.applicationCreate(null, "");
  }
  applyTransactions(ref: DocumentRef, transactions: readonly Transaction[]) {
    const d = this.resolve(ref);
    for (const transaction of transactions) d.update(transaction);
    this.changed(d, transactions.some((t) => t.docChanged || !!t.selection));
    return d.read();
  }
  replace(ref: DocumentRef, text: string) { const d = this.resolve(ref); d.replace(text); this.changed(d); }
  /** Stable application resources are available even when no editor is mounted. */
  applicationDocuments(): ApplicationDocument[] {
    return [...this.entries.values()].map((d) => ({
      document_id: d.draft.id, version: d.draft.version!, path: d.draft.path,
      text: d.raw, base_text: d.draft.baseRaw, base_hash: d.draft.baseHash,
      selection: { anchor: d.state.selection.main.anchor, head: d.state.selection.main.head, version: d.draft.selectionVersion! },
      readonly_reason: d.draft.readonly,
    }));
  }
  private applicationDocument(reference: ApplicationDocumentRef) {
    const d = this.resolve(reference.document_id);
    if (d.draft.version !== reference.document_version || d.draft.selectionVersion !== reference.selection_version)
      throw new Error("The document or selection changed. Current input was retained.");
    return d;
  }
  applicationCheck(reference: ApplicationDocumentRef) { this.applicationDocument(reference); }
  applicationSetSelection(reference: ApplicationDocumentRef, anchor: number, head: number) {
    const d = this.applicationDocument(reference), text = d.state.doc.toString();
    this.checkEditorOffset(text, anchor); this.checkEditorOffset(text, head);
    d.update(d.state.update({ selection: { anchor, head } })); this.changed(d);
  }
  applicationEdit(reference: ApplicationDocumentRef, edits: readonly ApplicationTextEdit[]) {
    const d = this.applicationDocument(reference);
    if (d.draft.readonly) throw new Error("This document is read-only.");
    if (!edits.length || edits.length > 200) throw new Error("Use 1..200 ordered, nonoverlapping edits.");
    const text = d.state.doc.toString(); let end = 0;
    for (const edit of edits) {
      this.checkEditorOffset(text, edit.from); this.checkEditorOffset(text, edit.to);
      if (edit.from < end || edit.to < edit.from || edit.insert.includes("\0")) throw new Error("Invalid or overlapping editor ranges.");
      end = edit.to;
    }
    const transaction = d.state.update({ changes: edits.map((edit) => ({ ...edit, insert: normalizeText(edit.insert) })) });
    const eolBytes = bytes(transaction.state.doc.toString().replace(/\n/g, d.draft.eol)).length + (d.draft.bom ? 3 : 0);
    if (eolBytes > MAX_EDIT_BYTES) throw new Error("The edit exceeds the 512 KiB document limit.");
    d.update(transaction); this.changed(d);
  }
  private checkEditorOffset(text: string, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length ||
      (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset])))
      throw new Error("Position is not a valid zero-based UTF-16 editor boundary.");
  }
  applicationCreate(path: string | null, text: string) {
    if (!this.ports.context().project) throw new Error("Open a project first");
    if (path) { validatePath(path); if ([...this.entries.values()].some((d) => d.draft.path === path)) throw new Error("The path is already open."); }
    if (bytes(text).length > MAX_EDIT_BYTES || text.includes("\0")) throw new Error("New document exceeds the UTF-8 editing limit.");
    const d = new DocumentState({ id: crypto.randomUUID(), path, raw: text.replace(/^\uFEFF/, ""), bom: text.startsWith("\uFEFF"), eol: text.match(/\r\n|\r|\n/)?.[0] ?? "\n",
      baseRaw: null, baseHash: null, readonly: null, byteSize: bytes(text).length, anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0 });
    this.entries.set(d.draft.id, d); this.focus(d.read()); this.changed(d); return d.read();
  }
  applicationRestore(documents: readonly ApplicationDocument[], active: string | null) {
    // Bridge has merged versioned remote resources with concurrent local input.
    // Keep the resident editor/undo state for every unchanged resource, and do
    // not invalidate unrelated user file reads which are still in flight.
    const ids = new Set(documents.map((d) => d.document_id));
    for (const id of this.entries.keys()) if (!ids.has(id)) { this.entries.delete(id); this.emitDocument(id); }
    for (const d of documents) {
      const existing = this.entries.get(d.document_id);
      if (existing && existing.draft.version === d.version && existing.draft.selectionVersion === d.selection.version &&
        existing.draft.path === d.path && existing.raw === d.text && existing.draft.baseRaw === d.base_text &&
        existing.draft.baseHash === d.base_hash && existing.draft.readonly === d.readonly_reason &&
        existing.state.selection.main.anchor === d.selection.anchor && existing.state.selection.main.head === d.selection.head) continue;
      const draft: Draft = { id: d.document_id, path: d.path, raw: d.text.replace(/^\uFEFF/, ""),
        bom: d.text.startsWith("\uFEFF"), eol: d.text.match(/\r\n|\r|\n/)?.[0] ?? "\n", baseRaw: d.base_text, baseHash: d.base_hash,
        readonly: d.readonly_reason, byteSize: bytes(d.text).length, anchor: d.selection.anchor, head: d.selection.head,
        scrollTop: existing?.draft.scrollTop ?? 0, scrollLeft: existing?.draft.scrollLeft ?? 0,
        version: d.version, selectionVersion: d.selection.version };
      this.entries.set(d.document_id, new DocumentState(draft)); this.emitDocument(d.document_id);
    }
    this.activeId = active && this.entries.has(active) ? active : null;
    this.publish();
  }
  /** A saved capture changes the base; later keystrokes retain their current text. */
  applicationConfirmSave(documentId: string, captured: string, path: string, hash: string) {
    const d = this.entries.get(documentId);
    if (!d) return;
    validatePath(path);
    d.draft.path = path; d.draft.baseRaw = captured; d.draft.baseHash = hash;
    d.draft.byteSize = bytes(captured).length; d.draft.version = crypto.randomUUID();
    this.ports.renameDocument(documentId, d.name);
    const project = this.ports.context().project;
    if (project) this.ports.fileSaved(project, path, hash);
    this.changed(d);
  }
  setScroll(ref: DocumentRef, top: number, left: number) {
    if (!this.owns(ref)) return;
    const d = this.resolve(ref);
    if (d.draft.scrollTop === top && d.draft.scrollLeft === left) return;
    d.draft.scrollTop = top; d.draft.scrollLeft = left; this.changed(d);
  }
  setError(ref: DocumentRef, error: unknown) {
    const id = typeof ref === "string" ? ref : ref.id;
    const d = this.entries.get(id); if (!d || !this.owns(ref)) return;
    d.error = error === null ? "" : message(error); this.changed(d, false);
  }
  async attempt(ref: DocumentRef, work: () => Promise<unknown>) {
    const d = this.resolve(ref), guard = this.guard(d, "action");
    d.error = ""; this.changed(d, false);
    try { await work(); } catch (error) { if (guard.current()) this.setError(ref, error); }
  }
  async open(path: string, byteSize?: number): Promise<DocumentSnapshot> {
    validatePath(path);
    const existing = [...this.entries.values()].find((d) => d.draft.path === path);
    if (existing) { this.focus(existing.read()); return existing.read(); }
    const guard = this.guard(), identity = guard.identity;
    if (!identity.project) throw new Error("Open a project first");
    const key = `${identity.epoch}:${identity.project}:${path}`;
    const underway = this.opening.get(key); if (underway) return underway;
    const closeVersion = this.ports.closeVersion();
    const task = (async () => {
      const file = await this.readFile(identity, path, null, byteSize, guard.assert, true);
      guard.assert();
      const d = new DocumentState({ id: crypto.randomUUID(), path, raw: file.raw.replace(/^\uFEFF/, ""),
        bom: file.raw.startsWith("\uFEFF"), eol: file.raw.match(/\r\n|\r|\n/)?.[0] ?? "\n", baseRaw: file.readonly ? null : file.raw,
        baseHash: file.hash, readonly: file.readonly, byteSize: file.size, anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0 });
      this.entries.set(d.draft.id, d);
      if (closeVersion === this.ports.closeVersion()) this.focus(d.read());
      this.changed(d); return d.read();
    })();
    this.opening.set(key, task);
    try { return await task; } finally { if (guard.current() && this.opening.get(key) === task) this.opening.delete(key); }
  }
  private async readFile(identity: ResourceIdentity, path: string, expected: string | null, byteSize: number | undefined,
    assert: () => void, preview = false): Promise<{ raw: string; hash: string | null; size: number; readonly: string | null }> {
    let size = byteSize ?? 0, hash = expected, offset = 0;
    const content: number[] = [];
    const oversized = () => ({ raw: "", hash, size, readonly: "The file exceeds the 512 KiB editing limit. Its full content was not loaded." });
    if (size > MAX_EDIT_BYTES) { if (preview) return oversized(); throw new Error("The disk file exceeds the editing limit."); }
    while (true) {
      assert();
      const observed = await this.ports.query(identity.project!, "project.read_file", { path, offset, limit_bytes: 65536, expected_sha256: hash });
      assert();
      if (observed.status !== "ready") throw new Error(observed.notices.join("\n") || "The disk file could not be read.");
      const page = observed.data as FilePage | null;
      if (!page || page.offset !== offset || page.file?.path !== path || !Array.isArray(page.bytes) || !page.file.sha256 || (hash && page.file.sha256 !== hash))
        throw new Error("The file changed while reading. Open it again.");
      hash = page.file.sha256; size = page.file.byte_size;
      if (size > MAX_EDIT_BYTES || offset + page.bytes.length > MAX_EDIT_BYTES) {
        if (preview) return oversized(); throw new Error("The disk file exceeds the editing limit.");
      }
      content.push(...page.bytes); offset += page.bytes.length;
      if (!page.has_more) break;
      if (!page.bytes.length || offset >= MAX_EDIT_BYTES) throw new Error("The disk content could not be read completely.");
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(content));
      if (raw.includes("\0")) throw new Error("Binary content");
    } catch {
      if (!preview) throw new Error("The disk content cannot be compared as text.");
      return { raw: content.slice(0, 128).map((b) => b.toString(16).padStart(2, "0")).join(" "), hash, size,
        readonly: "Binary or non-UTF-8 file. Showing a bounded byte preview." };
    }
    return { raw, hash, size, readonly: null };
  }
  canSave(ref: DocumentRef) {
    const d = this.entries.get(typeof ref === "string" ? ref : ref.id), context = this.ports.context();
    return !!d && !!context.project && context.connected && !this.stopped && !d.saving && !d.draft.readonly;
  }
  canRun(ref: DocumentRef) {
    const d = this.entries.get(typeof ref === "string" ? ref : ref.id);
    return !!d && isR(d.draft.path) && !this.stopped && this.ports.canRun() && !d.saving && !d.draft.readonly;
  }
  canRunFile(ref: DocumentRef, captured = this.resolve(ref).raw) { return this.canRun(ref) && !!captured.trim() && !captured.includes("\0"); }
  canRunSelection(ref: DocumentRef) {
    const d = this.resolve(ref), range = d.state.selection.main;
    const code = range.empty ? d.state.doc.lineAt(range.head).text : d.state.sliceDoc(range.from, range.to);
    return this.canRun(ref) && !!code.trim() && !code.includes("\0");
  }
  async save(ref: DocumentRef, captured = this.resolve(ref).raw, target = this.resolve(ref).draft.path, overwrite = false) {
    const d = this.resolve(ref);
    if (!this.canSave(ref)) throw new Error("Save is currently unavailable.");
    if (!target) throw new Error("Save the new file with Save As first.");
    validatePath(target);
    const guard = this.guard(d, "save"), project = guard.identity.project!;
    d.saving = true; d.error = ""; this.changed(d, false);
    try {
      if (bytes(captured).length > MAX_EDIT_BYTES) throw new Error("Text exceeds the 512 KiB editing limit. Your draft is retained.");
      let baseRaw = d.draft.baseRaw, baseHash = d.draft.baseHash;
      if (target !== d.draft.path) {
        if ([...this.entries.values()].some((other) => other !== d && other.draft.path === target))
          throw new Error("The target file is already open in another document.");
        const snapshot = await this.ports.query(project, "project.snapshot", { paths: [target], limit: 1 });
        guard.assert();
        if (snapshot.status !== "ready") throw new Error(snapshot.notices.join("\n"));
        const file = (snapshot.data as ProjectSnapshot | null)?.files?.[0];
        if (!file || file.path !== target) throw new Error("The save target could not be verified.");
        if (file.kind !== "absent") {
          if (!overwrite) throw new Error("The target exists. Choose a new path or explicitly replace its content.");
          const observed = await this.readFile(guard.identity, target, file.sha256, file.byte_size, guard.assert);
          baseRaw = observed.raw; baseHash = observed.hash;
        } else { baseRaw = null; baseHash = null; }
      }
      const expected = await sha256(captured);
      guard.assert();
      if (baseRaw === captured && baseHash) {
        const observed = await this.ports.query(project, "project.read_file", { path: target, offset: 0, limit_bytes: 1, expected_sha256: baseHash });
        guard.assert();
        if (observed.status !== "ready" || (observed.data as FilePage | null)?.file?.sha256 !== expected)
          throw new Error("The disk content changed. Save is unconfirmed.");
      } else {
        const patch = filePatch(target, baseRaw, captured);
        guard.assert();
        const record = await this.ports.invoke("project.apply_patch", { patch }, [{ kind: "file.sha256", subject: target, expected: baseHash }]);
        guard.assert();
        if (record.status !== "succeeded") throw new Error(record.error ?? `Save ${record.status}`);
        const actual = (record.output as ProjectPatchResult | null)?.after?.files?.find((file) => file.path === target);
        if (actual?.sha256 !== expected) throw new Error("The saved file digest does not match. No run was submitted.");
      }
      guard.assert();
      d.draft.path = target; d.draft.baseRaw = captured; d.draft.baseHash = expected; d.draft.byteSize = bytes(captured).length;
      d.draft.version = crypto.randomUUID();
      this.ports.renameDocument(d.draft.id, d.name);
      this.ports.fileSaved(project, target, expected); this.changed(d); return captured;
    } catch (error) {
      if (guard.current()) { d.error = message(error); this.changed(d, false); }
      throw error;
    } finally { if (guard.current()) { d.saving = false; this.changed(d, false); } }
  }
  async runFile(ref: DocumentRef, captured = this.resolve(ref).raw, target = this.resolve(ref).draft.path, overwrite = false) {
    const d = this.resolve(ref);
    if (!this.canRunFile(ref, captured)) throw new Error("Run File is currently unavailable.");
    const runtimeTarget = this.ports.captureTarget?.(), guard = this.guard(d, "run", runtimeTarget === undefined);
    d.runningFile = true; this.changed(d, false);
    try {
      const saved = await this.save(ref, captured, target, overwrite);
      guard.assert();
      if (!this.ports.context().connected) throw new Error("Disconnected. The saved code was not submitted.");
      const source = { view_id: d.draft.id, label: target ?? d.name, kind: "file" };
      if (runtimeTarget) await this.ports.run(saved, source, runtimeTarget);
      else await this.ports.run(saved, source);
      guard.assert();
    } finally { if (guard.current()) { d.runningFile = false; this.changed(d, false); } }
  }
  async runSelection(ref: DocumentRef) {
    if (!this.canRunSelection(ref)) return;
    const d = this.resolve(ref), selection = d.state.selection.main;
    const code = selection.empty ? d.state.doc.lineAt(selection.head).text : d.state.sliceDoc(selection.from, selection.to);
    await this.ports.run(code, { view_id: d.draft.id, label: d.draft.path ?? d.name, kind: selection.empty ? "line" : "selection" });
  }
  async format(ref: DocumentRef) {
    if (!this.canRun(ref) || this.ports.queueing()) return;
    const d = this.resolve(ref), guard = this.guard(d, "format"), captured = d.state.doc.toString();
    if (bytes(captured).length > 64 * 1024) throw new Error("Formatting input exceeds 64 KiB. Your text is retained.");
    const record = await this.ports.invoke("workspace.format", { code: captured });
    guard.assert();
    if (record.status !== "succeeded") throw new Error(record.error ?? "Formatting failed.");
    const result = (record.output as RunROutput | null)?.value as FormatResult | null;
    if (typeof result?.code !== "string") throw new Error("Formatting returned no text.");
    if (d.state.doc.toString() === captured) d.replace(result.code);
    else d.comparison = { before: captured, formatted: result.code };
    this.changed(d);
  }
  async compareDisk(ref: DocumentRef) {
    const d = this.resolve(ref), guard = this.guard(d, "compare");
    if (!guard.identity.project || !d.draft.path) throw new Error("This document has no saved file.");
    const file = await this.readFile(guard.identity, d.draft.path, null, undefined, guard.assert);
    guard.assert();
    if (!file.hash) throw new Error("The disk content cannot be compared as text.");
    d.diskComparison = { raw: file.raw, hash: file.hash }; this.changed(d, false);
  }
  closeComparison(ref: DocumentRef, kind: "disk" | "format") {
    const d = this.resolve(ref); if (kind === "disk") d.diskComparison = null; else d.comparison = null; this.changed(d, false);
  }
  acceptFormatted(ref: DocumentRef) {
    const d = this.resolve(ref); if (!d.comparison) return;
    d.replace(d.comparison.formatted); d.comparison = null; this.changed(d);
  }
  acceptDiskBase(ref: DocumentRef, useDisk: boolean) {
    const d = this.resolve(ref), comparison = d.diskComparison; if (!comparison) return;
    d.draft.baseHash = comparison.hash; d.draft.baseRaw = comparison.raw;
    d.draft.version = crypto.randomUUID();
    if (useDisk) { d.draft.bom = comparison.raw.startsWith("\uFEFF"); d.draft.eol = comparison.raw.match(/\r\n|\r|\n/)?.[0] ?? "\n"; d.replace(comparison.raw.replace(/^\uFEFF/, "")); }
    d.diskComparison = null; d.error = ""; this.changed(d);
  }
  discard(ref: DocumentRef) {
    const d = this.resolve(ref); if (d.saving) throw new Error("Wait for the save before discarding this draft.");
    this.entries.delete(d.draft.id); if (this.activeId === d.draft.id) this.activeId = null;
    this.ports.closeDocument(d.draft.id); this.changed(d);
  }
}
