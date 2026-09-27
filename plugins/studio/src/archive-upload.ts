/** One retained local upload. Byte transfer never installs a package; Studio's
 * original Operation owns the explicit import and its recovery. */
import type { PluginArchiveInspection, PluginArchiveProgress, PluginArchiveReceipt, PluginArchiveReference } from '../public/plugin-protocol/index.js';
import { capturePluginArchive, isPluginArchiveReference, samePluginArchive, stagePluginArchive, type CapturedPluginArchive } from '../public/plugin-ui/index.js';
import { type Client, type Intent, json, same } from './operations.js';

export interface ArchiveUploadState {
  name: string;
  reference: PluginArchiveReference;
  received: number;
  inspection: PluginArchiveInspection | null;
  imported: PluginArchiveReceipt | null;
  original: Intent | null;
}
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function verifyArchiveInspection(value: unknown, reference: PluginArchiveReference): PluginArchiveInspection {
  const data = value as PluginArchiveInspection;
  if (!data || !isPluginArchiveReference(data.reference) || !samePluginArchive(data.reference, reference) || !digest(data.revision) ||
      typeof data.plugin !== 'string' || typeof data.name !== 'string' || typeof data.version !== 'string' || typeof data.description !== 'string' ||
      !Number.isSafeInteger(data.source_files) || data.source_files < 1 || data.source_files > 8192 || !Array.isArray(data.artifacts) || data.artifacts.length > 32 ||
      data.artifacts.some(a => !a || !digest(a.id) || typeof a.target !== 'string' || !Number.isSafeInteger(a.file_count) || a.file_count < 0) ||
      new Set(data.artifacts.map(a => a.id)).size !== data.artifacts.length)
    throw Error('Archive inspection does not match the retained file.');
  return structuredClone(data);
}
export function verifyArchiveImport(value: unknown, upload: ArchiveUploadState): PluginArchiveReceipt {
  const receipt = value as PluginArchiveReceipt, inspection = upload.inspection;
  if (!inspection || !receipt || !isPluginArchiveReference(receipt.reference) || !samePluginArchive(receipt.reference, upload.reference) ||
      receipt.revision !== inspection.revision || receipt.plugin !== inspection.plugin || !same(receipt.artifacts, inspection.artifacts.map(a => a.id).sort()))
    throw Error('Import returned a different archive or revision. Retain the original request for inspection.');
  return structuredClone(receipt);
}
export function validateArchiveUpload(value: ArchiveUploadState | null | undefined) {
  if (value == null) return;
  if (typeof value.name !== 'string' || !value.name || value.name.length > 1024 || !isPluginArchiveReference(value.reference) ||
      !Number.isSafeInteger(value.received) || value.received < 0 || value.received > value.reference.bytes ||
      !Object.hasOwn(value, 'inspection') || !Object.hasOwn(value, 'imported') || !Object.hasOwn(value, 'original')) throw Error('The retained archive upload has invalid metadata.');
  if (value.inspection) verifyArchiveInspection(value.inspection, value.reference);
  if (value.imported) {
    verifyArchiveImport(value.imported, value);
    const original = value.original;
    if (!original || typeof original.view !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(original.view) || typeof original.request !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(original.request) ||
        typeof original.operation !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(original.operation) ||
        !same(original.capability, { id: 'plugins.archive_import', version: 1 }) || !same(original.arguments, { reference: value.reference }))
      throw Error('The retained import is missing its original request identity.');
  } else if (value.original !== null) throw Error('An import identity requires its verified receipt.');
}
export class ArchiveUpload {
  private capture: CapturedPluginArchive | null = null;
  private abort = new AbortController();
  constructor(private readonly client: Client, private readonly current: () => ArchiveUploadState | null,
    private readonly replace: (state: ArchiveUploadState | null) => void, private readonly persist: () => Promise<unknown>,
    private readonly guard: () => void) { validateArchiveUpload(current()); }
  get fileAvailable() { return this.capture !== null && !this.abort.signal.aborted; }
  async choose(file: Blob, name: string) {
    this.guard();
    if (typeof name !== 'string' || !name || name.length > 1024) throw Error('Choose a file with a bounded filename.');
    const previous = this.current();
    const capture = await capturePluginArchive(file, previous?.reference.archive, this.abort.signal);
    if (previous && !samePluginArchive(previous.reference, capture.reference)) throw Error('Reselect the exact retained file, or explicitly discard its transfer before choosing another.');
    if (!previous) this.replace({ name, reference: capture.reference, received: 0, inspection: null, imported: null, original: null });
    // No chunk leaves this frame until the containing view acknowledges this
    // exact reference. Full file bytes remain outside the small saved state.
    await this.persist(); this.capture = capture;
  }
  async stage(progress?: (received: number) => void) {
    this.guard(); const upload = this.current(), capture = this.capture;
    if (!upload || !capture || !samePluginArchive(upload.reference, capture.reference)) throw Error('Reselect the retained file before resuming its upload.');
    await stagePluginArchive(this.client, capture, { signal: this.abort.signal, progress: state => {
      upload.received = state.received; progress?.(state.received);
    } });
    await this.persist(); await this.inspect();
  }
  async inspect() {
    const upload = this.current(); if (!upload) throw Error('Choose an archive first.');
    const state = await this.read<PluginArchiveProgress>('plugins.archive_progress', upload.reference);
    if (!state || !isPluginArchiveReference(state.reference) || !samePluginArchive(state.reference, upload.reference) ||
        !Number.isSafeInteger(state.received) || state.received < 0 || state.received > upload.reference.bytes || state.complete !== (state.received === upload.reference.bytes))
      throw Error('Archive progress does not match the retained file.');
    upload.received = state.received;
    if (state.complete) upload.inspection = verifyArchiveInspection(await this.read('plugins.archive_inspect', upload.reference), upload.reference);
    await this.persist();
  }
  async discard() {
    this.guard(); const upload = this.current(); if (!upload) return;
    const result = await this.client.control<{ reference: PluginArchiveReference; discarded: boolean }>({ id: 'plugins.archive_discard', version: 1 }, json({ reference: upload.reference }));
    if (!result || result.discarded !== true || !isPluginArchiveReference(result.reference) || !samePluginArchive(result.reference, upload.reference)) throw Error('Archive cleanup is unconfirmed. The original reference was retained.');
    this.replace(null);
    try { await this.persist(); } catch (error) { this.replace(upload); throw error; }
    this.capture = null;
  }
  private async read<T>(id: string, reference: PluginArchiveReference): Promise<T> {
    const reply = await this.client.query<{ status: string; data?: T; notices?: string[] }>({ id, version: 1 }, json({ reference }));
    if (reply.status !== 'ready' || reply.data == null) throw Error(reply.notices?.join('\n') || 'The original archive is unavailable.');
    return reply.data;
  }
  dispose() { this.abort.abort(); this.capture = null; }
}
