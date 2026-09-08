import type { MediaReference } from "./generated/MediaReference";
import type { OutputPage } from "./generated/OutputPage";
import { immutable, Model, readonlyMap, readonlySet } from "./shared/model";
import { message, sameScope } from "./shared/ports";
import type { RequestContext } from "./shared/ports";
import { mediaKey, sameMediaReference, validMediaReference } from "./output-ports";
import type { MediaCacheDependencies } from "./output-ports";

export interface MediaCacheSnapshot {
  readonly urls: ReadonlyMap<string, string>;
  readonly errors: ReadonlyMap<string, string>;
  readonly loading: ReadonlySet<string>;
  readonly byteSize: number;
}
type Entry = { reference: MediaReference; bytes: Uint8Array; url: string; accessed: number };
type Download = { reference: MediaReference; bytes: Uint8Array | null; offset: number; attempts: number; retryAt: number; blocked: boolean };

/** One validated original per identity. Browser URL creation is injected by the UI adapter. */
export class MediaCache extends Model<MediaCacheSnapshot> {
  private entries = new Map<string, Entry>();
  private downloads = new Map<string, Download>();
  private errors = new Map<string, string>();
  private protected = new Set<string>();
  private inFlight = false;
  private generation = 0;
  private stopped = false;
  private lastKey = "";
  constructor(private deps: MediaCacheDependencies) { super(); }
  protected readSnapshot(): MediaCacheSnapshot {
    return {
      urls: readonlyMap(new Map([...this.entries].map(([key, entry]) => [key, entry.url]))),
      errors: readonlyMap(this.errors),
      loading: readonlySet(new Set([...this.downloads].filter(([, value]) => !value.blocked).map(([key]) => key))),
      byteSize: [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes.length, 0),
    };
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  key = mediaKey;
  load(reference: MediaReference) {
    if (this.stopped || !this.deps.context().project) return;
    const key = mediaKey(reference), cached = this.entries.get(key);
    if (cached) { cached.accessed = this.now(); return; }
    if (this.downloads.has(key) || this.errors.has(key)) return;
    if (!validMediaReference(reference) || reference.byte_size > 16 * 1024 * 1024 || !["image/png", "image/jpeg", "image/svg+xml"].includes(reference.mime_type)) {
      this.errors.set(key, "Unsupported or oversized media output.");
      this.publish(); return;
    }
    // Queued thumbnail demand allocates no raw buffers; only the active original does.
    this.downloads.set(key, { reference: immutable(structuredClone(reference)), bytes: null, offset: 0, attempts: 0, retryAt: 0, blocked: false });
    this.publish(); this.deps.schedule?.();
  }
  retry(reference: MediaReference) {
    const key = mediaKey(reference), download = this.downloads.get(key);
    this.errors.delete(key);
    if (download) { download.blocked = false; download.retryAt = 0; download.attempts = 0; }
    else this.load(reference);
    this.publish(); this.deps.schedule?.();
  }
  reportDecodeError(reference: MediaReference, url?: string) {
    const key = mediaKey(reference);
    if (!this.entries.has(key) || (url && this.entries.get(key)!.url !== url)) return;
    this.errors.set(key, "The browser could not decode this original. Export Original is still available.");
    this.publish();
  }
  protect(keys: ReadonlySet<string>) {
    this.protected = new Set(keys);
    if (this.evict()) this.publish();
  }
  private evict(keep?: string) {
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes.length, 0), changed = false;
    for (const [key, entry] of [...this.entries].sort(([, a], [, b]) => a.accessed - b.accessed)) {
      if (total <= (this.deps.budgetBytes ?? 64 * 1024 * 1024)) break;
      if (key === keep || this.protected.has(key)) continue;
      this.deps.adapter.revokeUrl(entry.url);
      this.entries.delete(key); this.errors.delete(key); total -= entry.bytes.length; changed = true;
    }
    return changed;
  }
  private valid(context: RequestContext, generation: number) {
    return !this.stopped && generation === this.generation && sameScope(context, this.deps.context());
  }
  /** Read a single bounded chunk; the shared runtime coordinator schedules continuation. */
  async step() {
    const context = this.deps.context(), generation = this.generation;
    if (!context.project || this.stopped || this.inFlight) return;
    const allocated = [...this.downloads].find(([, download]) => download.bytes && !download.blocked);
    const ready = (allocated ? [allocated] : [...this.downloads]).filter(([, download]) => !download.blocked && download.retryAt <= this.now());
    if (!ready.length) return;
    const index = ready.findIndex(([key]) => key === this.lastKey), [key, download] = ready[(index + 1) % ready.length];
    this.lastKey = key; this.inFlight = true;
    const bytes = download.bytes ??= new Uint8Array(download.reference.byte_size);
    try {
      const snapshot = await this.deps.query(context.project, "workspace.read_output", { reference: download.reference, offset: download.offset, limit_bytes: 65536 });
      if (!this.valid(context, generation)) return;
      if (snapshot.status !== "ready") {
        this.errors.set(key, snapshot.notices.join("\n") || "Original output is unavailable. Retry to check again.");
        download.blocked = snapshot.status === "unavailable";
        if (download.blocked) { download.bytes = null; download.offset = 0; }
        download.retryAt = this.now() + 500;
        return;
      }
      const page = snapshot.data as OutputPage | null;
      if (!page || !page.reference || !sameMediaReference(page.reference, download.reference) || page.offset !== download.offset || typeof page.has_more !== "boolean" || !Array.isArray(page.bytes) || page.bytes.length > 65536 || page.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) || download.offset + page.bytes.length > bytes.length || (!page.bytes.length && page.has_more) || (page.has_more && download.offset + page.bytes.length >= bytes.length))
        throw new Error("Media chunk identity does not match.");
      if (!page.has_more && download.offset + page.bytes.length !== bytes.length) throw new Error("Original output is incomplete.");
      bytes.set(page.bytes, download.offset);
      download.offset += page.bytes.length;
      download.attempts = 0; download.retryAt = 0;
      this.errors.delete(key);
      if (!page.has_more) {
        const digest = await this.deps.adapter.sha256(bytes);
        if (!this.valid(context, generation)) return;
        if (digest !== download.reference.sha256) {
          download.blocked = true;
          download.offset = 0;
          download.bytes = null;
          this.errors.set(key, "Original output failed its checksum.");
          return;
        }
        const url = this.deps.adapter.createUrl(bytes, download.reference.mime_type);
        this.entries.set(key, { reference: download.reference, bytes, url, accessed: this.now() });
        this.downloads.delete(key);
        this.evict(key);
      }
    } catch (error) {
      if (!this.valid(context, generation)) return;
      download.attempts++;
      download.retryAt = this.now() + [500, 1000, 2000, 5000][Math.min(download.attempts - 1, 3)];
      this.errors.set(key, message(error));
    } finally {
      if (this.valid(context, generation)) { this.inFlight = false; this.publish(); }
    }
  }
  reset() {
    this.generation++; this.stopped = false; this.inFlight = false;
    for (const entry of this.entries.values()) this.deps.adapter.revokeUrl(entry.url);
    this.entries.clear(); this.downloads.clear(); this.errors.clear(); this.protected.clear(); this.lastKey = "";
    this.publish();
  }
  sessionChanged() { this.generation++; this.inFlight = false; this.deps.schedule?.(); }
  stop() { this.reset(); this.stopped = true; this.dispose(); }
}
