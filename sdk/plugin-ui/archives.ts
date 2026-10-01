/** Package transfers are independent of runtime resources. These helpers never
 * invoke import/export, activate code, discard recovery bytes or save a file. */
import type { CapabilityKey, JsonValue, PluginArchiveReference, PluginArchiveProgress } from '../plugin-protocol/index.js';
export type { PluginArchiveReference, PluginArchiveProgress } from '../plugin-protocol/index.js';
export const ARCHIVE_CHUNK_BYTES = 64 * 1024;
export const MAX_PLUGIN_ARCHIVE_BYTES = Math.floor(256 * 1024 * 1024 * 4 / 3) + 16 * 1024 * 1024;
export interface ArchiveReader { query<T = unknown>(capability: CapabilityKey, arguments_: JsonValue): Promise<T>; }
export interface ArchiveWriter { control<T = unknown>(capability: CapabilityKey, arguments_: JsonValue): Promise<T>; }
export interface CapturedPluginArchive { reference: PluginArchiveReference; blob: Blob; }
const opaque = /^[A-Za-z0-9._-]{1,128}$/, digest = /^sha256:[a-f0-9]{64}$/;
export function isPluginArchiveReference(value: unknown): value is PluginArchiveReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as PluginArchiveReference;
  return Object.keys(ref).every(key => ['archive', 'digest', 'bytes'].includes(key)) && typeof ref.archive === 'string' && opaque.test(ref.archive) &&
    typeof ref.digest === 'string' && digest.test(ref.digest) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= MAX_PLUGIN_ARCHIVE_BYTES;
}
export function samePluginArchive(a: PluginArchiveReference, b: PluginArchiveReference) { return a.archive === b.archive && a.digest === b.digest && a.bytes === b.bytes; }
function stopped(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Archive transfer stopped', 'AbortError'); }
async function hash(bytes: ArrayBuffer) { return 'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join(''); }
/** Capture an immutable Blob; persist its reference before staging. A reselected
 * file must match that same digest/size before resuming its original transfer. */
export async function capturePluginArchive(input: Blob, archive: string = crypto.randomUUID(), signal?: AbortSignal): Promise<CapturedPluginArchive> {
  stopped(signal);
  if (!(input instanceof Blob) || input.size < 1 || input.size > MAX_PLUGIN_ARCHIVE_BYTES || typeof archive !== 'string' || !opaque.test(archive)) throw Error('Invalid archive identity or byte limit.');
  const blob = new Blob([input]), reference = { archive, digest: await hash(await blob.arrayBuffer()), bytes: blob.size };
  stopped(signal); return { reference, blob };
}
/** Repeat only identical transient chunks. Completeness is distinct from package
 * validation and import; those require separate explicit public-port actions. */
export async function stagePluginArchive(writer: ArchiveWriter, capture: CapturedPluginArchive,
  options: { signal?: AbortSignal; progress?: (state: PluginArchiveProgress) => void } = {}): Promise<PluginArchiveProgress> {
  const ref = structuredClone(capture.reference), blob = capture.blob;
  stopped(options.signal);
  if (!isPluginArchiveReference(ref) || !(blob instanceof Blob) || blob.size !== ref.bytes || await hash(await blob.arrayBuffer()) !== ref.digest)
    throw Error('The original archive capture changed; reselect its exact bytes.');
  stopped(options.signal);
  let progress: PluginArchiveProgress = { reference: ref, received: 0, complete: false };
  for (let offset = 0; offset < ref.bytes; offset += ARCHIVE_CHUNK_BYTES) {
    stopped(options.signal);
    const part = new Uint8Array(await blob.slice(offset, offset + ARCHIVE_CHUNK_BYTES).arrayBuffer());
    stopped(options.signal);
    const encoded: string[] = [];
    for (let start = 0; start < part.length; start += 8192) encoded.push(String.fromCharCode(...part.subarray(start, start + 8192)));
    const result = await writer.control<PluginArchiveProgress>({ id: 'plugins.archive_stage', version: 1 }, { reference: ref, offset, base64: btoa(encoded.join('')) });
    stopped(options.signal);
    if (!result || !isPluginArchiveReference(result.reference) || !samePluginArchive(ref, result.reference) || !Number.isSafeInteger(result.received) ||
        result.received < Math.max(progress.received, part.length) || result.received > ref.bytes || result.complete !== (result.received === ref.bytes))
      throw Error('Archive staging acknowledgement changed its identity or progress.');
    progress = structuredClone(result); options.progress?.(structuredClone(progress));
  }
  if (!progress.complete) throw Error('The original archive upload remains incomplete.');
  return progress;
}
/** Verify every returned range and the full checksum before returning bytes. A
 * browser download requires a separate authorized presentation action. */
export async function readPluginArchive(reader: ArchiveReader, reference: PluginArchiveReference,
  options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const ref = structuredClone(reference), maximum = options.maxBytes ?? MAX_PLUGIN_ARCHIVE_BYTES;
  stopped(options.signal);
  if (!isPluginArchiveReference(ref) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_PLUGIN_ARCHIVE_BYTES || ref.bytes > maximum)
    throw Error('Archive exceeds the byte limit or has an invalid identity.');
  const bytes = new Uint8Array(ref.bytes);
  for (let offset = 0; offset < ref.bytes; offset += ARCHIVE_CHUNK_BYTES) {
    stopped(options.signal);
    const response = await reader.query<{ status?: string; data?: unknown }>({ id: 'plugins.archive_read', version: 1 }, { reference: ref, offset, limit: ARCHIVE_CHUNK_BYTES });
    stopped(options.signal);
    const part = response?.status === 'ready' ? response.data as { reference: unknown; offset: unknown; base64: unknown; next: unknown } | null : null;
    if (!part || !isPluginArchiveReference(part.reference) || !samePluginArchive(ref, part.reference) || part.offset !== offset || typeof part.base64 !== 'string' || part.base64.length > Math.ceil(ARCHIVE_CHUNK_BYTES / 3) * 4)
      throw Error('Archive chunk identity or byte range changed.');
    let decoded: string;
    try { decoded = atob(part.base64); } catch { throw Error('Archive chunk encoding is invalid.'); }
    const end = Math.min(offset + ARCHIVE_CHUNK_BYTES, ref.bytes);
    if (decoded.length !== end - offset || part.next !== (end === ref.bytes ? null : end)) throw Error('The original archive read is incomplete.');
    for (let i = 0; i < decoded.length; i++) bytes[offset + i] = decoded.charCodeAt(i);
  }
  const actual = await hash(bytes.buffer); stopped(options.signal);
  if (actual !== ref.digest) throw Error('Archive integrity check failed; the original reference was preserved.');
  return bytes;
}
