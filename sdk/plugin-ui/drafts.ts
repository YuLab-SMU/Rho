/** Opaque draft bytes. File encoding, save receipts and execution captures belong
 * to the contributed document owner, not these transport helpers. */
import type { CapabilityKey, DocumentDraft, DraftContent, JsonValue, PluginViewRecord } from "../plugin-protocol/index.js";
export type { DocumentDraft, DraftContent } from "../plugin-protocol/index.js";
export const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
export const DRAFT_CHUNK_BYTES = 64 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const opaquePattern = /^[A-Za-z0-9._-]{1,128}$/;
const namePattern = /^[a-z][a-z0-9._-]{0,127}$/;
const isDigest = (value: unknown): value is string => typeof value === "string" && digestPattern.test(value);
const isOpaque = (value: unknown): value is string => typeof value === "string" && opaquePattern.test(value);
const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 0xffffffff;
export interface DraftReader {
  readonly view: Pick<PluginViewRecord, "project" | "principal" | "window">;
  query<T = unknown>(capability: CapabilityKey, arguments_: JsonValue): Promise<T>;
}
export interface DraftWriter extends Pick<DraftReader, "view"> {
  control<T = unknown>(capability: CapabilityKey, arguments_: JsonValue): Promise<T>;
}
export interface CapturedDraftContent { content: DraftContent; chunks: string[]; }
function stopped(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Draft transfer stopped; accepted work is unchanged", "AbortError"); }
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function encode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function decode(base64: unknown, size: number): Uint8Array<ArrayBuffer> {
  if (typeof base64 !== "string" || base64.length > Math.ceil(DRAFT_CHUNK_BYTES / 3) * 4) throw new Error("Draft chunk encoding exceeds its limit");
  let text: string;
  try { text = atob(base64); } catch { throw new Error("Draft chunk encoding is invalid"); }
  if (text.length !== size) throw new Error("Draft chunk byte range is incomplete or changed");
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
export function isDraftContent(value: unknown): value is DraftContent {
  if (!value || typeof value !== "object") return false;
  const content = value as DraftContent;
  if (!isDigest(content.digest) || !Number.isSafeInteger(content.bytes) || content.bytes < 0 || content.bytes > MAX_DRAFT_BYTES ||
    !Array.isArray(content.chunks) || content.chunks.length !== Math.ceil(content.bytes / DRAFT_CHUNK_BYTES)) return false;
  return Array.from(content.chunks).every((chunk, index) => chunk && isDigest(chunk.digest) && chunk.bytes === Math.min(DRAFT_CHUNK_BYTES, content.bytes - index * DRAFT_CHUNK_BYTES));
}
export function isDocumentDraft(value: unknown): value is DocumentDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as DocumentDraft;
  if (![draft.draft, draft.window, draft.project, draft.principal].every(isOpaque) || !isVersion(draft.version) ||
    !draft.source || !isDigest(draft.source.revision) || typeof draft.source.contribution !== "string" ||
    !namePattern.test(draft.source.contribution) || draft.source.contribution.includes("..") ||
    !isDraftContent(draft.content) || typeof draft.discarded !== "boolean") return false;
  try { const metadata = JSON.stringify(draft.metadata); return metadata !== undefined && new TextEncoder().encode(metadata).length <= 32 * 1024; }
  catch { return false; }
}
/** Copies before the first asynchronous step, so subsequent buffer edits cannot
 * alter the captured content or any of its independently hashed chunks. */
export async function captureDraftContent(input: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<CapturedDraftContent> {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_DRAFT_BYTES) throw new Error("Draft content exceeds the 8 MiB limit or is not bytes");
  const bytes = new Uint8Array(input);
  stopped(options.signal);
  const content: DraftContent = { digest: await digest(bytes), bytes: bytes.length, chunks: [] }, chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += DRAFT_CHUNK_BYTES) {
    stopped(options.signal);
    const chunk = bytes.slice(offset, offset + DRAFT_CHUNK_BYTES);
    content.chunks.push({ digest: await digest(chunk), bytes: chunk.length });
    chunks.push(encode(chunk));
  }
  stopped(options.signal);
  return { content, chunks };
}
/** Stage one frozen capture through its declared public Control grant. This does
 * not save a draft, invoke an Operation, or attest that an upload is durable. */
export async function stageDraftContent(writer: DraftWriter, address: { draft: string; upload: string }, capture: CapturedDraftContent,
  options: { signal?: AbortSignal } = {}): Promise<DraftContent> {
  const scope = structuredClone(writer.view), owner = structuredClone(address);
  if (!isOpaque(scope.window) || !isOpaque(owner.draft) || !isOpaque(owner.upload) || !isDraftContent(capture?.content) ||
    !Array.isArray(capture.chunks) || capture.chunks.length !== capture.content.chunks.length ||
    Array.from(capture.chunks).some(chunk => typeof chunk !== "string" || chunk.length > Math.ceil(DRAFT_CHUNK_BYTES / 3) * 4)) throw new Error("Draft capture identity or content is invalid");
  const frozen = structuredClone(capture), all = new Uint8Array(frozen.content.bytes);
  // Validate the entire retained capture before the first write. Callers may
  // restore this structure from their own temporary memory; it is not authority.
  for (let index = 0; index < frozen.chunks.length; index++) {
    stopped(options.signal);
    const chunk = frozen.content.chunks[index]!, bytes = decode(frozen.chunks[index], chunk.bytes);
    if (await digest(bytes) !== chunk.digest) throw new Error("Draft capture chunk integrity failed");
    all.set(bytes, index * DRAFT_CHUNK_BYTES);
  }
  if (await digest(all) !== frozen.content.digest) throw new Error("Draft capture integrity failed");
  stopped(options.signal);
  for (let index = 0; index < frozen.chunks.length; index++) {
    const chunk = frozen.content.chunks[index]!;
    const reply = await writer.control<{ digest?: unknown; bytes?: unknown }>({ id: "documents.stage", version: 1 },
      { window: scope.window, draft: owner.draft, upload: owner.upload, digest: chunk.digest, base64: frozen.chunks[index]! });
    stopped(options.signal);
    if (reply?.digest !== chunk.digest || reply.bytes !== chunk.bytes) throw new Error("Draft staging acknowledgement has a different identity or size");
  }
  return frozen.content;
}
/** Reads only the supplied current version, with bounded pages and complete hash
 * verification. Later versions are refused; a read never initiates recovery. */
export async function readDraft(reader: DraftReader, record: DocumentDraft,
  options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const scope = structuredClone(reader.view), ref = structuredClone(record), maximum = options.maxBytes ?? MAX_DRAFT_BYTES;
  if (!isDocumentDraft(ref) || ref.discarded || ref.project !== scope.project || ref.principal !== scope.principal || ref.window !== scope.window ||
    !Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_DRAFT_BYTES || ref.content.bytes > maximum) throw new Error("Draft identity, version, scope or byte limit is invalid");
  stopped(options.signal);
  const observed = (await reader.query<{ data?: unknown }>({ id: "documents.inspect", version: 1 }, { window: ref.window, draft: ref.draft }))?.data;
  stopped(options.signal);
  if (!isDocumentDraft(observed) || observed.discarded || observed.draft !== ref.draft || observed.project !== ref.project || observed.principal !== ref.principal ||
    observed.window !== ref.window || observed.version !== ref.version || observed.source.revision !== ref.source.revision || observed.source.contribution !== ref.source.contribution ||
    observed.content.digest !== ref.content.digest || observed.content.bytes !== ref.content.bytes ||
    observed.content.chunks.some((chunk, index) => chunk.digest !== ref.content.chunks[index]?.digest)) throw new Error("Original draft identity or version changed");
  const bytes = new Uint8Array(ref.content.bytes);
  let offset = 0;
  do {
    stopped(options.signal);
    const part = (await reader.query<{ data?: { draft?: unknown; version?: unknown; digest?: unknown; offset?: unknown; base64?: unknown; next?: unknown } }>(
      { id: "documents.read", version: 1 }, { window: ref.window, draft: ref.draft, expected_version: ref.version, offset, limit: DRAFT_CHUNK_BYTES }))?.data;
    stopped(options.signal);
    const end = Math.min(offset + DRAFT_CHUNK_BYTES, bytes.length);
    if (!part || part.draft !== ref.draft || part.version !== ref.version || part.digest !== ref.content.digest || part.offset !== offset || part.next !== (end === bytes.length ? null : end))
      throw new Error("Draft chunk identity or byte range changed");
    const chunk = decode(part.base64, end - offset);
    if (chunk.length && await digest(chunk) !== ref.content.chunks[offset / DRAFT_CHUNK_BYTES]!.digest) throw new Error("Draft chunk integrity failed");
    bytes.set(chunk, offset);
    offset = end;
  } while (offset < bytes.length);
  if (await digest(bytes) !== ref.content.digest) throw new Error("Draft content integrity failed");
  stopped(options.signal);
  return bytes;
}
