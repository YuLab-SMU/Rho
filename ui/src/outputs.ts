import type { MediaReference } from "./generated/MediaReference";
import type { MediaPage } from "./generated/MediaPage";
import type { OutputEvent } from "./generated/OutputEvent";
import type { OutputEvents } from "./generated/OutputEvents";
import type { OperationChange } from "./shared/events";
import { immutable, Model, readonlyMap, readonlySet } from "./shared/model";
import { message, sameScope, terminal } from "./shared/ports";
import type { RequestContext } from "./shared/ports";
import { mediaKey, sameMediaReference, validMediaReference } from "./output-ports";
import type { OutputSnapshot, OutputsDependencies } from "./output-ports";

type ReadProgress = { cursor: number; complete: boolean; blocked: boolean; attempts: number; retryAt: number };
const progress = (): ReadProgress => ({ cursor: 0, complete: false, blocked: false, attempts: 0, retryAt: 0 });
const delay = (attempts: number) => [500, 1000, 2000, 5000][Math.min(attempts - 1, 3)];

/** Stored output observations have their own recovery lifecycle, independent of execution outcome. */
export class Outputs extends Model<OutputSnapshot> {
  private events = new Map<string, readonly OutputEvent[]>();
  private notices = new Map<string, string>();
  private errors = new Map<string, string>();
  private streams = new Map<string, ReadProgress>();
  private media = new Map<string, MediaReference>();
  private times = new Map<string, number>();
  private mediaScans = new Map<string, ReadProgress>();
  private requestedReferences = new Set<string>();
  private historyCursor: number | null = null;
  private historyRequested = false;
  private historyExhausted = false;
  private historyProgress = progress();
  private historyError = "";
  private inFlight = false;
  private generation = 0;
  private stopped = false;
  private lastRead = "";

  constructor(private deps: OutputsDependencies) { super(); }

  protected readSnapshot(): OutputSnapshot {
    // Do not expose an output until its authoritative operation sort identity is known.
    const known = (id: string) => !!this.deps.operations.getRecord(id) && Number.isSafeInteger(this.deps.operations.getSummary(id)?.cursor);
    const events = new Map([...this.events].filter(([id]) => known(id)));
    const media = [...this.media.values()].filter((reference) => known(reference.operation_id)).sort((a, b) =>
      this.deps.operations.getSummary(a.operation_id)!.cursor - this.deps.operations.getSummary(b.operation_id)!.cursor ||
      a.operation_id.localeCompare(b.operation_id) || a.sequence - b.sequence,
    );
    return {
      events: readonlyMap(events), notices: readonlyMap(this.notices), errors: readonlyMap(this.errors),
      cursors: readonlyMap(new Map([...this.streams].map(([id, state]) => [id, state.cursor]))),
      completed: readonlySet(new Set([...this.streams].filter(([, state]) => state.complete).map(([id]) => id))),
      media: Object.freeze(media), times: readonlyMap(this.times), records: readonlyMap(this.deps.operations.records()),
      historyLoading: this.historyRequested || [...this.mediaScans.values()].some((state) => !state.blocked) || this.requestedReferences.size > 0,
      historyError: this.historyError,
    };
  }
  operationChanged(event: OperationChange) {
    const context = this.deps.context();
    if (event.epoch !== context.epoch || event.project !== context.project || !event.capability.startsWith("workspace.")) return;
    if (event.status === "unreadable") {
      this.streams.delete(event.operationId); this.mediaScans.delete(event.operationId);
      this.requestedReferences.delete(event.operationId); this.publish();
      return;
    }
    if (!this.streams.has(event.operationId)) this.streams.set(event.operationId, progress());
    this.publish();
    this.deps.schedule?.();
  }
  syncOperations() {
    for (const [id, record] of this.deps.operations.records())
      if (record.operation.capability.id.startsWith("workspace.") && !this.streams.has(id)) this.streams.set(id, progress());
    this.publish();
    this.deps.schedule?.();
  }
  reset() {
    this.generation++;
    this.stopped = false;
    this.inFlight = false;
    this.events.clear(); this.notices.clear(); this.errors.clear(); this.streams.clear();
    this.media.clear(); this.times.clear(); this.mediaScans.clear(); this.requestedReferences.clear();
    this.historyCursor = null; this.historyRequested = false; this.historyExhausted = false;
    this.historyProgress = progress(); this.historyError = ""; this.lastRead = "";
    this.publish();
  }
  stop() { this.stopped = true; this.generation++; this.inFlight = false; this.dispose(); }
  sessionChanged() { this.generation++; this.inFlight = false; this.deps.schedule?.(); }
  private valid(context: RequestContext, generation: number) {
    return !this.stopped && generation === this.generation && sameScope(context, this.deps.context());
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  retry(id: string) {
    const state = this.streams.get(id);
    if (state) Object.assign(state, progress());
    const scan = this.mediaScans.get(id);
    if (scan) Object.assign(scan, progress());
    this.errors.delete(id);
    this.publish(); this.deps.schedule?.();
  }
  loadEarlierPlots(): Promise<void> {
    if (this.historyError || [...this.mediaScans.values()].some((state) => state.blocked)) this.retryHistory();
    if (this.historyExhausted) return Promise.resolve();
    this.historyRequested = true;
    this.historyProgress.retryAt = 0;
    this.historyProgress.blocked = false;
    this.historyError = "";
    this.publish(); this.deps.schedule?.();
    return Promise.resolve();
  }
  retryHistory() {
    this.historyProgress.blocked = false; this.historyProgress.retryAt = 0; this.historyProgress.attempts = 0;
    for (const state of this.mediaScans.values()) { state.blocked = false; state.retryAt = 0; state.attempts = 0; }
    this.historyError = "";
    this.publish(); this.deps.schedule?.();
  }
  restoreReferences(keys: readonly string[]) {
    for (const key of keys) {
      const match = /^(.*):[0-9]+:sha256:[a-f0-9]+$/i.exec(key);
      if (match) this.requestedReferences.add(match[1]);
    }
    this.publish(); this.deps.schedule?.();
  }
  async loadPlotDetails(reference: MediaReference) {
    const context = this.deps.context(), generation = this.generation;
    try {
      await this.deps.operations.ensureOperation(reference.operation_id);
      if (this.valid(context, generation)) this.publish();
    } catch (error) {
      if (this.valid(context, generation)) { this.errors.set(reference.operation_id, message(error)); this.publish(); }
    }
  }
  /** One coordinator turn performs at most two pages, rotating across independent output demands. */
  async step() {
    const context = this.deps.context(), generation = this.generation;
    if (!context.project || this.stopped || this.inFlight) return;
    this.inFlight = true;
    try {
      for (let count = 0; count < 2 && this.valid(context, generation); count++) {
        const now = this.now();
        const jobs: { key: string; id?: string; state: ReadProgress; kind: "stream" | "media" | "history" | "reference" }[] = [];
        for (const [id, state] of this.streams)
          if (!state.complete && !state.blocked && state.retryAt <= now) jobs.push({ key: `stream:${id}`, id, state, kind: "stream" });
        for (const [id, state] of this.mediaScans)
          if (!state.complete && !state.blocked && state.retryAt <= now) jobs.push({ key: `media:${id}`, id, state, kind: "media" });
        if (this.historyRequested && !this.historyProgress.blocked && this.historyProgress.retryAt <= now)
          jobs.push({ key: "history", state: this.historyProgress, kind: "history" });
        for (const id of this.requestedReferences) jobs.push({ key: `reference:${id}`, id, state: this.mediaScans.get(id) ?? progress(), kind: "reference" });
        if (!jobs.length) break;
        const index = jobs.findIndex((job) => job.key === this.lastRead), job = jobs[(index + 1) % jobs.length];
        this.lastRead = job.key;
        try {
          if (job.kind === "history") await this.readHistory(context, generation);
          else if (job.kind === "reference") {
            const record = await this.deps.operations.ensureOperation(job.id!);
            if (!this.valid(context, generation)) return;
            this.requestedReferences.delete(job.id!);
            if (record) this.mediaScans.set(job.id!, progress());
          } else {
            const record = this.deps.operations.getRecord(job.id!) ?? await this.deps.operations.ensureOperation(job.id!);
            if (!this.valid(context, generation)) return;
            if (!record) {
              this.streams.delete(job.id!); this.mediaScans.delete(job.id!);
              continue;
            }
            if (!this.deps.operations.getSummary(job.id!)) {
              await this.deps.operations.ensureOperation(job.id!);
              if (!this.valid(context, generation)) return;
              if (!this.deps.operations.getSummary(job.id!)) throw new Error("Operation ordering identity is unavailable.");
            }
            if (job.kind === "stream") await this.readStream(context, generation, job.id!, job.state);
            else await this.readMedia(context, generation, job.id!, job.state);
          }
        } catch (error) {
          if (!this.valid(context, generation)) return;
          job.state.attempts++;
          job.state.retryAt = this.now() + delay(job.state.attempts);
          if (job.kind === "history") this.historyError = message(error);
          else {
            this.errors.set(job.id!, message(error));
            if (job.kind === "media" || job.kind === "reference") this.historyError = message(error);
            if (job.kind === "reference") {
              this.requestedReferences.delete(job.id!);
              this.mediaScans.set(job.id!, job.state);
            }
          }
        }
        if (this.valid(context, generation)) this.publish();
      }
    } finally {
      if (this.valid(context, generation)) this.inFlight = false;
    }
  }
  private async readStream(context: RequestContext, generation: number, id: string, state: ReadProgress) {
    const terminalBeforeRead = terminal(this.deps.operations.getRecord(id)?.status ?? "");
    const snapshot = await this.deps.query(context.project!, "workspace.output_events", { operation_id: id, after_sequence: state.cursor, limit: 100 });
    if (!this.valid(context, generation)) return;
    if (snapshot.status !== "ready") {
      this.notices.set(id, snapshot.notices.join("\n") || (snapshot.status === "busy" ? "Output is temporarily busy. Retrying…" : "Original output is unavailable. Retry to check again."));
      state.blocked = snapshot.status === "unavailable";
      state.retryAt = this.now() + 500;
      return;
    }
    const page = snapshot.data as OutputEvents | null;
    if (!page || page.operation_id !== id || !Array.isArray(page.events) || page.events.length > 100 || !Number.isSafeInteger(page.next_sequence) || page.next_sequence < state.cursor || typeof page.has_more !== "boolean" || typeof page.gap !== "boolean" || typeof page.truncated !== "boolean" || !Array.isArray(page.notices) || page.notices.some((notice) => typeof notice !== "string") || (page.has_more && page.next_sequence <= state.cursor))
      throw new Error("Output identity does not match.");
    const merged = new Map((this.events.get(id) ?? []).map((event) => [event.sequence, event]));
    const additions: OutputEvent[] = [];
    for (const event of page.events) {
      if (!event || event.operation_id !== id || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > page.next_sequence || typeof event.kind !== "string" || (event.text !== null && typeof event.text !== "string") || !Number.isFinite(event.observed_at_ms) || (event.media !== null && (!validMediaReference(event.media) || event.media.operation_id !== id || event.media.sequence !== event.sequence)))
        throw new Error("Output event identity does not match.");
      const existing = merged.get(event.sequence);
      if (existing && (existing.kind !== event.kind || existing.text !== event.text || existing.observed_at_ms !== event.observed_at_ms || (existing.media === null ? event.media !== null : !event.media || !sameMediaReference(existing.media, event.media)))) throw new Error("Output event changed under the same identity.");
      if (!existing) { const copy = immutable(structuredClone(event)); additions.push(copy); merged.set(copy.sequence, copy); }
    }
    // Commit this page together, after every identity has been validated.
    state.cursor = page.next_sequence;
    state.attempts = 0; state.retryAt = 0;
    // A terminal notification can overtake a response observed while R was
    // still running. Only a read started after terminal can finish the drain.
    state.complete = terminalBeforeRead && !page.has_more;
    this.errors.delete(id);
    if (page.gap || page.truncated || page.notices.length) this.notices.set(id, [
      ...page.notices,
      ...(page.gap ? ["Some output could not be read. Retry to check for available content."] : []),
      ...(page.truncated ? ["Output reached the observation limit. Later content is omitted."] : []),
    ].join("\n"));
    else if (!this.notices.get(id)?.includes("observation limit") && !this.notices.get(id)?.includes("Some output")) this.notices.delete(id);
    if (additions.length) {
      this.events.set(id, Object.freeze([...merged.values()].sort((a, b) => a.sequence - b.sequence)));
      const media: MediaReference[] = [];
      for (const event of additions) if (event.media) {
        this.media.set(mediaKey(event.media), event.media); this.times.set(mediaKey(event.media), event.observed_at_ms); media.push(event.media);
      }
      this.publish();
      this.deps.appended?.({ epoch: context.epoch, project: context.project!, operationId: id, media });
    }
  }
  private async readHistory(context: RequestContext, generation: number) {
    const page = await this.deps.operations.listRecent(this.historyCursor, 30);
    if (!this.valid(context, generation)) return;
    for (const summary of page.operations)
      if (summary.capability.id.startsWith("workspace.") && !this.mediaScans.has(summary.operation_id)) this.mediaScans.set(summary.operation_id, progress());
    this.historyCursor = page.next_cursor;
    this.historyExhausted = page.next_cursor === null;
    this.historyRequested = false;
    this.historyError = "";
    this.historyProgress = progress();
  }
  private async readMedia(context: RequestContext, generation: number, id: string, state: ReadProgress) {
    const snapshot = await this.deps.query(context.project!, "workspace.list_outputs", { operation_id: id, after_sequence: state.cursor, limit: 100 });
    if (!this.valid(context, generation)) return;
    if (snapshot.status !== "ready") {
      state.blocked = snapshot.status === "unavailable";
      state.retryAt = this.now() + 500;
      this.notices.set(id, snapshot.notices.join("\n") || "Original output is unavailable. Retry to check again.");
      this.historyError = this.notices.get(id)!;
      return;
    }
    const page = snapshot.data as MediaPage | null;
    if (!page || page.operation_id !== id || !Array.isArray(page.media) || page.media.length > 100 || !Number.isSafeInteger(page.next_sequence) || page.next_sequence < state.cursor || typeof page.has_more !== "boolean" || typeof page.gap !== "boolean" || (page.has_more && page.next_sequence <= state.cursor) || page.media.some((item) => !item || !validMediaReference(item.reference) || item.reference.operation_id !== id || item.reference.sequence > page.next_sequence || !Number.isFinite(item.observed_at_ms)))
      throw new Error("Historical output identity does not match.");
    const additions: MediaReference[] = [];
    for (const item of page.media) {
      const reference = immutable(structuredClone(item.reference)), key = mediaKey(reference);
      if (!this.media.has(key)) additions.push(reference);
      this.media.set(key, reference); this.times.set(key, item.observed_at_ms);
    }
    state.cursor = page.next_sequence; state.attempts = 0; state.retryAt = 0;
    if (!page.has_more) this.mediaScans.delete(id);
    this.errors.delete(id);
    if (page.gap) this.notices.set(id, "Some historical output could not be read. Retry to check for available content.");
    this.publish();
    if (additions.length) this.deps.appended?.({ epoch: context.epoch, project: context.project!, operationId: id, media: additions });
  }
}
