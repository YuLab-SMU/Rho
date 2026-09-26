import type { FileObservation, ProjectPatchResult } from '../public/files-protocol/index.js';
import type { InstanceRef } from '../public/plugin-protocol/index.js';
import { EditorDocument, type DocumentBody } from './document.js';
import { EditorFiles } from './files.js';
import { DraftSync } from './draft-sync.js';
import { type Client, type Intent, type RecordReply, inspectOriginal, verifyOriginal, same, json, terminal } from './operations.js';
import { bytes, filePatch, sha256, validatePath } from './text.js';
interface FileSave { intent: Intent; path: string; raw: string; before: string | null; baseHash: string | null; digest: string; }
interface Payload { schema: 1; files: InstanceRef; document: DocumentBody; save: FileSave | null; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Coordinates a single ordinary Editor view. Native file actions and generic
 * draft saves keep separate requests, outcomes and capture identities. */
export class EditorController {
  readonly files: EditorFiles;
  readonly drafts: DraftSync;
  document: EditorDocument | null = null;
  pending: FileSave | null = null;
  error = '';
  synchronizationError = '';
  private paused = false;
  private stopped = false;
  private task: Promise<unknown> | null = null;
  private initial: FileObservation | null;
  constructor(private readonly client: Client, configuration: { source: InstanceRef; file: FileObservation | null }, private changed: () => void = () => {}) {
    this.files = new EditorFiles(client, configuration?.source);
    if (!configuration || !Object.hasOwn(configuration, 'file')) throw new Error('The Editor configuration needs an explicit file capture or null.');
    this.initial = structuredClone(configuration.file);
    this.drafts = new DraftSync(client);
  }
  get busy() { return this.task !== null; }
  private live() { if (this.stopped) throw new Error('The Editor is closed. Original work is retained.'); }
  private editable() { this.live(); if (this.paused) throw new Error('The Editor is preparing to close.'); }
  private notify() { if (!this.stopped) this.changed(); }
  private act<T>(work: () => Promise<T>): Promise<T> {
    this.editable(); if (this.task) return Promise.reject(new Error('Wait for the current Editor request.'));
    this.error = '';
    const task = Promise.resolve().then(work).catch(error => { if (!this.stopped) this.error = message(error); throw error; })
      .finally(() => { this.task = null; this.notify(); });
    this.task = task; this.notify(); return task;
  }
  private payload(): Payload {
    if (!this.document) throw new Error('No acknowledged Editor document is available.');
    return { schema: 1, files: this.files.source, document: this.document.snapshot, save: this.pending && structuredClone(this.pending) };
  }
  async open() {
    this.live();
    if (this.drafts.unresolved) {
      try { await this.drafts.inspect(); } catch (error) { this.synchronizationError = message(error); }
    }
    const retained = await this.drafts.read(); this.live();
    if (retained !== null) {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained)) as Payload;
      if (value.schema !== 1 || !same(value.files, this.files.source) || !Object.hasOwn(value, 'save')) throw new Error('The retained Editor body has another encoding or Files provider.');
      const document = new EditorDocument(value.document);
      if (value.save !== null) await this.checkSave(value.save, false);
      this.live(); this.document = document; this.pending = structuredClone(value.save);
    } else {
      if (this.drafts.unresolved) throw new Error('The first draft save remains unconfirmed. Inspect its original Operation before opening another document.');
      if (this.initial) {
        await this.files.connect(); const captured = await this.files.read(this.initial); this.live();
        this.document = EditorDocument.create(captured.raw, captured.file.path, captured.file.sha256, captured.readonly, captured.file.byte_size);
      } else this.document = EditorDocument.create();
    }
    this.notify();
  }
  refreshInitial(): Promise<void> { return this.act(async () => {
    if (this.document || this.drafts.snapshot.draft || this.drafts.unresolved || !this.initial) throw new Error('A retained document cannot be replaced by refreshing its initial file.');
    await this.files.connect(); const current = await this.files.inspect(this.initial.path); this.editable();
    if (!current) throw new Error('The original path is no longer a regular file.');
    this.initial = current; await this.open(); this.editable(); await this.flush();
  }); }
  flush(): Promise<void> {
    this.live(); const capture = bytes(JSON.stringify(this.payload()));
    return this.drafts.save(capture, { encoding: 'org.rho.editor.document.v1' }).then(() => { this.synchronizationError = ''; })
      .catch(error => { this.synchronizationError = message(error); throw error; }).finally(() => this.notify());
  }
  async inspectDraft() {
    this.live(); await this.drafts.inspect(); this.live();
    // A resident newer edit is never replaced by an older recovered capture.
    if (!this.document) await this.open(); else await this.flush();
  }
  private async checkSave(save: FileSave, currentBinding: boolean) {
    if (!save || !save.intent || typeof save.raw !== 'string' || !(save.before === null || typeof save.before === 'string') ||
      !(save.baseHash === null || typeof save.baseHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(save.baseHash)) ||
      (save.before === null) !== (save.baseHash === null) || !same(save.intent.capability, { id: 'files.apply_patch', version: 1 }) ||
      typeof save.intent.view !== 'string' || !save.intent.view || typeof save.intent.request !== 'string' || !save.intent.request ||
      !(save.intent.operation === null || typeof save.intent.operation === 'string' && !!save.intent.operation)) throw new Error('The retained file save is invalid.');
    validatePath(save.path);
    if (await sha256(save.raw) !== save.digest) throw new Error('The retained file capture has a different digest.');
    const args = save.intent.arguments as any;
    if (!args || !same(args.binding?.provider, this.files.source) || args.binding.project !== this.client.view.project ||
      !same(args.binding.capability, save.intent.capability) || typeof args.binding.target !== 'string' || !args.binding.target.startsWith('/') ||
      !same(args.arguments, { patch: filePatch(save.path, save.before, save.raw) }) ||
      !same(args.preconditions, [{ kind: 'file.sha256', subject: save.path, expected: save.baseHash }]) ||
      currentBinding && !same(args.binding, this.files.binding('files.apply_patch'))) throw new Error('The retained save differs from its original file, provider or native precondition.');
  }
  /** Resolves only admission, not a running native operation. Close preparation
   * can retain the exact pending request without waiting for scientific work. */
  save(path = this.document?.path ?? '', overwrite = false): Promise<void> {
    const document = this.document;
    if (!document || document.snapshot.readonly) return Promise.reject(new Error('The document is not editable.'));
    const raw = document.raw, base = document.snapshot;
    return this.act(async () => {
      if (this.pending) throw new Error('Inspect the original file save before starting another.');
      if (!path) throw new Error('Choose a project-relative path with Save As.');
      validatePath(path); await this.files.connect(); this.editable();
      let before = base.baseRaw, baseHash = base.baseHash;
      if (path !== base.path || before === null) {
        const target = await this.files.inspect(path); this.editable();
        if (target) {
          if (!overwrite) throw new Error('The target exists. Choose another path or explicitly replace it.');
          const captured = await this.files.read(target); this.editable();
          if (captured.readonly) throw new Error('A read-only target cannot be replaced from this Editor.');
          before = captured.raw; baseHash = captured.file.sha256;
        } else { before = null; baseHash = null; }
      }
      const digest = await sha256(raw); this.editable();
      if (before === raw && baseHash === digest) {
        const current = await this.files.inspect(path); this.editable();
        if (current?.sha256 !== digest) throw new Error('The file changed on disk. Save remains unconfirmed.');
        document.saved(path, raw, digest); await this.flush(); return;
      }
      const binding = this.files.binding('files.apply_patch'), args = { binding, arguments: { patch: filePatch(path, before, raw) },
        preconditions: [{ kind: 'file.sha256', subject: path, expected: baseHash }] };
      this.pending = { path, raw, before, baseHash, digest, intent: { view: this.client.view.view, request: crypto.randomUUID(),
        capability: { id: 'files.apply_patch', version: 1 }, arguments: json(args), operation: null } };
      let attempted = false;
      try {
        await this.flush(); this.editable();
        await this.submit(() => { attempted = true; });
      } catch (error) {
        // This branch has direct evidence that no file invocation was attempted.
        // Close waits for this preparation before taking its final body capture.
        if (!attempted) { this.pending = null; await this.flush().catch(() => undefined); }
        throw error;
      }
    });
  }
  private async submit(attempt: () => void = () => {}) {
    const pending = this.pending!; await this.checkSave(pending, true); this.editable();
    if (pending.intent.view !== this.client.view.view) throw new Error('This save belongs to another view. Inspect its original Operation instead of replaying it.');
    attempt();
    const record = await verifyOriginal(await this.client.invoke(pending.intent.capability, structuredClone(pending.intent.arguments), { requestId: pending.intent.request }), pending.intent);
    this.live(); pending.intent.operation = record.operation.operation_id;
    await this.consume(record); await this.flush();
  }
  retrySave(): Promise<void> { return this.act(async () => {
    if (!this.pending) throw new Error('No original file save is retained.');
    await this.files.connect(); this.editable(); await this.flush(); await this.submit();
  }); }
  inspectSave(): Promise<RecordReply> { return this.act(async () => {
    if (!this.pending) throw new Error('No original file save is retained.');
    const before = JSON.stringify(this.payload());
    const record = await inspectOriginal(this.client, this.pending.intent); this.live();
    this.pending.intent.operation = record.operation.operation_id; await this.consume(record);
    if (JSON.stringify(this.payload()) !== before) await this.flush();
    return record;
  }); }
  private async consume(record: RecordReply) {
    const pending = this.pending!;
    if (record.status === 'succeeded') {
      const result = record.output as ProjectPatchResult, binding = (pending.intent.arguments as any).binding;
      const file = result?.after?.files?.find(item => item.path === pending.path);
      if (result?.after?.root !== binding.target || file?.kind !== 'regular' || file.sha256 !== pending.digest || file.byte_size !== bytes(pending.raw).length ||
        !Array.isArray(result.affected_paths) || !result.affected_paths.includes(pending.path)) throw new Error('The original file-save receipt does not match the captured bytes.');
      this.document!.saved(pending.path, pending.raw, pending.digest); this.pending = null; this.error = '';
    } else if (terminal(record.status)) this.error = record.error || `The original file save is ${record.status}.`;
  }
  acknowledgeFileFailure(): Promise<void> { return this.act(async () => {
    if (!this.pending) throw new Error('No original file save is retained.');
    const record = await inspectOriginal(this.client, this.pending.intent); this.live();
    if (!['failed', 'cancelled'].includes(record.status)) throw new Error('The original file save has no confirmed failure.');
    this.pending = null; await this.flush();
  }); }
  async pause() { this.paused = true; await this.task?.catch(() => undefined); await this.flush(); }
  resume() { this.paused = false; this.notify(); }
  stop() { this.stopped = true; this.drafts.stop(); this.files.stop(); }
}
