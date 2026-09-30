import { EditorState, type Transaction } from '@codemirror/state';
import { bytes, MAX_EDIT_BYTES, normalizeText, rawOffset, validatePath } from './text.js';
export interface DocumentBody {
  path: string | null; raw: string; baseRaw: string | null; baseHash: string | null;
  bom: boolean; eol: '\n' | '\r\n' | '\r'; readonly: string | null; byteSize: number;
  anchor: number; head: number; scrollTop: number; scrollLeft: number; version: string;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
/** One document per contributed view. CodeMirror owns undo/selection, while raw
 * bytes retain BOM and unchanged mixed line endings independently of its display. */
export class EditorDocument {
  private body: DocumentBody;
  state: EditorState;
  constructor(value: DocumentBody) {
    const body = structuredClone(value);
    if (body.path !== null) validatePath(body.path);
    if (typeof body.raw !== 'string' || !(body.baseRaw === null || typeof body.baseRaw === 'string') ||
      !(body.baseHash === null || hash(body.baseHash)) || typeof body.bom !== 'boolean' || !['\n', '\r\n', '\r'].includes(body.eol) ||
      !(body.readonly === null || typeof body.readonly === 'string' && body.readonly.length > 0) || !Number.isSafeInteger(body.byteSize) || body.byteSize < 0 ||
      typeof body.version !== 'string' || !body.version || [body.anchor, body.head].some(n => !Number.isSafeInteger(n) || n < 0) ||
      [body.scrollTop, body.scrollLeft].some(n => !Number.isFinite(n) || n < 0) || bytes(body.raw).length > MAX_EDIT_BYTES ||
      body.baseRaw !== null && bytes(body.baseRaw).length > MAX_EDIT_BYTES ||
      body.readonly === null && (body.byteSize !== bytes((body.bom ? '\ufeff' : '') + body.raw).length || body.raw.includes('\0') || bytes((body.bom ? '\ufeff' : '') + body.raw).length > MAX_EDIT_BYTES))
      throw new Error('The retained Editor document has an invalid encoding or exceeds its editing limit.');
    if (body.path === null && (body.baseRaw !== null || body.baseHash !== null) ||
      body.readonly === null && (body.baseRaw === null) !== (body.baseHash === null)) throw new Error('The retained file base is inconsistent.');
    const text = normalizeText(body.raw);
    if (body.anchor > text.length || body.head > text.length) throw new Error('The retained selection is outside its document.');
    this.body = body;
    this.state = EditorState.create({ doc: text, selection: { anchor: body.anchor, head: body.head } });
  }
  static create(raw = '', path: string | null = null, baseHash: string | null = null, readonly: string | null = null, byteSize = bytes(raw).length) {
    return new EditorDocument({ path, raw: raw.replace(/^\ufeff/, ''), bom: raw.startsWith('\ufeff'), eol: raw.includes('\r\n') ? '\r\n' : raw.includes('\r') ? '\r' : '\n',
      baseRaw: path && baseHash && !readonly ? raw : null, baseHash, readonly, byteSize, anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0, version: crypto.randomUUID() });
  }
  get snapshot(): DocumentBody { return { ...this.body }; }
  get raw() { return (this.body.bom ? '\ufeff' : '') + this.body.raw; }
  get path() { return this.body.path; }
  get name() { return this.body.path?.split('/').at(-1) ?? 'Untitled.R'; }
  get dirty() { return this.body.readonly === null && this.body.baseRaw !== this.raw; }
  update(transaction: Transaction) {
    if (transaction.startState !== this.state) throw new Error('The document changed before this edit could be applied.');
    let raw = this.body.raw;
    if (transaction.docChanged) {
      if (this.body.readonly !== null) throw new Error('This file preview is read-only.');
      let next = '', end = 0;
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        next += raw.slice(end, rawOffset(raw, from)) + inserted.toString().replace(/\n/g, this.body.eol); end = rawOffset(raw, to);
      });
      raw = next + raw.slice(end);
      if (raw.includes('\0') || bytes((this.body.bom ? '\ufeff' : '') + raw).length > MAX_EDIT_BYTES) throw new Error('Editable text is limited to 512 KiB without NUL. The previous draft is retained.');
      this.body.raw = raw; this.body.version = crypto.randomUUID(); this.body.byteSize = bytes(this.raw).length;
    }
    this.state = transaction.state; this.body.anchor = this.state.selection.main.anchor; this.body.head = this.state.selection.main.head;
  }
  setScroll(top: number, left: number) {
    if (![top, left].every(n => Number.isFinite(n) && n >= 0)) return;
    this.body.scrollTop = top; this.body.scrollLeft = left;
  }
  /** Only the exact captured base advances after a verified original receipt.
   * Later typing and its resident undo state are retained. */
  saved(path: string, raw: string, digest: string) {
    validatePath(path);
    if (!hash(digest) || bytes(raw).length > MAX_EDIT_BYTES || raw.includes('\0') || this.body.readonly !== null) throw new Error('The file-save receipt is invalid.');
    this.body.path = path; this.body.baseRaw = raw; this.body.baseHash = digest;
  }
  /** Replace presentation text as one undoable edit, retaining BOM, line-ending
   * policy and the saved disk base. A late result cannot consume a newer edit. */
  format(code: string, expectedVersion: string) {
    if (this.body.readonly !== null) throw new Error('This file preview is read-only.');
    if (this.body.version !== expectedVersion) throw new Error('The document changed while formatting. Compare the retained result before applying it.');
    const text = normalizeText(code), selection = this.state.selection.main;
    if (text === this.state.doc.toString()) return;
    this.update(this.state.update({ changes: { from: 0, to: this.state.doc.length, insert: text },
      selection: { anchor: Math.min(selection.anchor, text.length), head: Math.min(selection.head, text.length) }, userEvent: 'input.format' }));
  }
  /** An exact owner edit is one undoable transaction. Keep the resident
   * selection/scroll and file base returned by that original owner operation. */
  adopt(capture: DocumentBody) {
    const replacement = new EditorDocument(capture), text = replacement.state.doc.toString();
    const selection = this.state.selection.main;
    this.state = this.state.update({ changes: { from: 0, to: this.state.doc.length, insert: text },
      selection: { anchor: Math.min(selection.anchor, text.length), head: Math.min(selection.head, text.length) }, userEvent: 'input.agent' }).state;
    this.body = { ...replacement.snapshot, anchor: this.state.selection.main.anchor, head: this.state.selection.main.head,
      scrollTop: this.body.scrollTop, scrollLeft: this.body.scrollLeft };
  }
  /** An explicit disk replacement keeps the resident undo history. Its exact
   * BOM/newlines become the new base; undoing text leaves that base unchanged. */
  useDisk(raw: string, digest: string) {
    if (!this.body.path || this.body.readonly !== null) throw new Error('This document cannot load a disk replacement.');
    const replacement = EditorDocument.create(raw, this.body.path, digest);
    const text = replacement.state.doc.toString(), selection = this.state.selection.main;
    const transaction = this.state.update({ changes: { from: 0, to: this.state.doc.length, insert: text },
      selection: { anchor: Math.min(selection.anchor, text.length), head: Math.min(selection.head, text.length) }, userEvent: 'input.disk' });
    this.state = transaction.state;
    this.body = { ...replacement.snapshot, anchor: this.state.selection.main.anchor, head: this.state.selection.main.head,
      scrollTop: this.body.scrollTop, scrollLeft: this.body.scrollLeft };
  }
}
