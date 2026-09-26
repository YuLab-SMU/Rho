import type { InstanceRef, ProviderBinding, WorkspacePaths } from '../public/plugin-protocol/index.js';
import type { FileObservation, FilePage, ProjectSnapshot } from '../public/files-protocol/index.js';
import { type Client, json } from './operations.js';
import { MAX_EDIT_BYTES, validatePath } from './text.js';
export interface FileCapture { file: FileObservation; raw: string; readonly: string | null; }
const digest = async (bytes: Uint8Array<ArrayBuffer>) => 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
const isHash = (hash: unknown) => typeof hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(hash);
/** Files remains the native owner. The Editor verifies complete captures and
 * preserves the exact configured provider across reads and later mutations. */
export class EditorFiles {
  readonly source: InstanceRef;
  private root: string | null = null;
  private stopped = false;
  constructor(private readonly client: Client, source: InstanceRef) {
    if (!source || typeof source.plugin !== 'string' || typeof source.instance !== 'string' || !isHash(source.revision) || !isHash(source.artifact))
      throw new Error('Choose an exact Files provider for this document.');
    this.source = Object.freeze(structuredClone(source));
  }
  private live() { if (this.stopped) throw new Error('The Editor file connection is closed.'); }
  async connect() {
    this.live();
    const reply = await this.client.query<{ status: string; data?: WorkspacePaths }>({ id: 'workspace.paths', version: 1 }, {}); this.live();
    const root = reply.data?.project_root;
    if (reply.status !== 'ready' || typeof root !== 'string' || !root.startsWith('/') || this.root !== null && this.root !== root)
      throw new Error('The original project root is unavailable or changed.');
    this.root = root;
  }
  binding(id: string): ProviderBinding {
    this.live(); if (!this.root) throw new Error('Observe the original project before accessing its files.');
    return { capability: { id, version: 1 }, provider: this.source, project: this.client.view.project, target: this.root };
  }
  private async query<T>(id: string, args: unknown): Promise<T> {
    const reply = await this.client.query<{ status: string; data?: T }>({ id, version: 1 }, json({ binding: this.binding(id), arguments: args })); this.live();
    if (reply.status !== 'ready' || reply.data === undefined || reply.data === null) throw new Error('The original Files observation is unavailable.');
    return reply.data;
  }
  private validate(file: FileObservation) {
    if (!file || typeof file.path !== 'string') throw new Error('The file observation is invalid.');
    validatePath(file.path);
    if (!Number.isSafeInteger(file.byte_size) || file.byte_size < 0 || file.kind !== 'regular' || !isHash(file.sha256)) throw new Error('The selected path is not an available regular file.');
  }
  async inspect(path: string): Promise<FileObservation | null> {
    validatePath(path);
    const snapshot = await this.query<ProjectSnapshot>('files.snapshot', { paths: [path], limit: 1 });
    if (snapshot.root !== this.root || !Array.isArray(snapshot.files) || snapshot.files.length !== 1 || snapshot.files[0]!.path !== path)
      throw new Error('The file observation differs from the requested project or path.');
    const file = snapshot.files[0]!;
    if (file.kind === 'absent' && file.sha256 === null && file.byte_size === 0) return null;
    this.validate(file); return structuredClone(file);
  }
  async read(expected: FileObservation): Promise<FileCapture> {
    const file = structuredClone(expected); this.validate(file);
    const preview = file.byte_size > MAX_EDIT_BYTES, count = preview ? Math.min(file.byte_size, 65536) : file.byte_size;
    const bytes = new Uint8Array(count); let offset = 0;
    do {
      const page = await this.query<FilePage>('files.read_file', { path: file.path, expected_sha256: file.sha256, offset, limit_bytes: Math.min(65536, Math.max(1, count - offset)) });
      if (!page || page.offset !== offset || page.file?.path !== file.path || page.file.kind !== 'regular' || page.file.sha256 !== file.sha256 || page.file.byte_size !== file.byte_size ||
        !Array.isArray(page.bytes) || page.bytes.length !== Math.min(65536, count - offset) || page.bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
        page.has_more !== (offset + page.bytes.length < file.byte_size)) throw new Error('The file changed or returned an incomplete byte page.');
      bytes.set(page.bytes, offset); offset += page.bytes.length;
    } while (offset < count);
    if (!preview && await digest(bytes) !== file.sha256) throw new Error('The complete file digest does not match its captured identity.');
    this.live();
    let raw: string, readonly: string | null = preview ? 'This file exceeds 512 KiB. Showing a read-only prefix.' : null;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: preview }); }
    catch { raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, 65536)); readonly = 'This file is not valid UTF-8. Showing a read-only preview.'; }
    if (raw.includes('\0')) readonly = 'This file contains binary data. Showing a read-only preview.';
    return { file, raw, readonly };
  }
  stop() { this.stopped = true; }
}
