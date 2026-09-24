/** Immutable bytes through the same declared read capability as other clients. */
import type { CapabilityKey, JsonValue, ResourceReference } from "../plugin-protocol/index.js";
export type { ResourceReference } from "../plugin-protocol/index.js";
export interface ResourceReader { query<T = unknown>(capability: CapabilityKey, arguments_: JsonValue): Promise<T>; }
export const DEFAULT_RESOURCE_VIEW_BYTES = 16 * 1024 * 1024;
const chunkLimit = 256 * 1024;
const digest = /^sha256:[a-f0-9]{64}$/;
const identity = /^[A-Za-z0-9._:/-]{1,160}$/;
export function isResourceReference(value: unknown): value is ResourceReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as ResourceReference, owner = ref.owner;
  return !!owner && [owner.instance, owner.plugin, ref.resource].every(id => typeof id === "string" && identity.test(id)) &&
    [owner.revision, owner.artifact, ref.digest].every(id => typeof id === "string" && digest.test(id)) &&
    typeof ref.media_type === "string" && ref.media_type.length > 0 && ref.media_type.length <= 128 &&
    Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= 256 * 1024 * 1024;
}
export function sameResource(left: ResourceReference, right: ResourceReference): boolean {
  return left.resource === right.resource && left.digest === right.digest && left.bytes === right.bytes && left.media_type === right.media_type &&
    left.owner.plugin === right.owner.plugin && left.owner.instance === right.owner.instance &&
    left.owner.revision === right.owner.revision && left.owner.artifact === right.owner.artifact;
}
/** Verify identity, every byte range, exact length and the final SHA-256 before
 * presentation. An aborted read never cancels its producing scientific work. */
export async function readResource(reader: ResourceReader, reference: ResourceReference,
  options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const ref = structuredClone(reference), maximum = options.maxBytes ?? DEFAULT_RESOURCE_VIEW_BYTES;
  if (!isResourceReference(ref) || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 256 * 1024 * 1024 || ref.bytes > maximum)
    throw new Error("Resource exceeds the presentation byte limit or has an invalid identity");
  const check = () => { if (options.signal?.aborted) throw new DOMException("Resource read stopped", "AbortError"); };
  check();
  const bytes = new Uint8Array(ref.bytes);
  let offset = 0;
  // Even an empty resource must cross the authorized read port.
  do {
    check();
    const response = await reader.query<{ data?: unknown }>({ id: "resources.read", version: 1 }, { reference: ref, offset, limit: chunkLimit });
    check();
    const part = response?.data as { reference?: unknown; offset?: unknown; base64?: unknown; next?: unknown } | null;
    if (!part || !isResourceReference(part.reference) || !sameResource(ref, part.reference) || part.offset !== offset ||
      typeof part.base64 !== "string" || part.base64.length > Math.ceil(chunkLimit / 3) * 4)
      throw new Error("Resource chunk identity or size changed");
    let decoded: string;
    try { decoded = atob(part.base64); } catch { throw new Error("Resource chunk encoding is invalid"); }
    const end = Math.min(offset + chunkLimit, ref.bytes);
    if (decoded.length !== end - offset || part.next !== (end === ref.bytes ? null : end))
      throw new Error("Resource read is incomplete or its byte range changed");
    for (let i = 0; i < decoded.length; i++) bytes[offset + i] = decoded.charCodeAt(i);
    offset = end;
  } while (offset < ref.bytes);
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  check();
  if (`sha256:${actual}` !== ref.digest) throw new Error("Resource integrity check failed; the original reference was preserved");
  return bytes;
}
