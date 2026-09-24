import type { InstanceRef, JsonValue, ProviderBinding } from "../public/plugin-protocol/index.js";
import type { PluginViewClient } from "../public/plugin-ui/index.js";
import type { RInspection, RInspectionState } from "../public/r-protocol/index.js";
import { Help, type HelpCopy } from "./help.js";
import { Model } from "./shared/model.js";

type ViewClient = Pick<PluginViewClient, "view" | "query" | "setState">;
interface ConnectionSnapshot { notice: string; saveError: string; connected: boolean; ready: boolean; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The index and topic always belong to the configured installed copy. A new
 * execution cache key never replaces its observation or native session. */
export class HelpConnection extends Model<ConnectionSnapshot> {
  readonly help: Help;
  readonly source: Readonly<InstanceRef>;
  private notice = "";
  private saveError = "";
  private connected = false;
  private ready = false;
  private stopped = false;
  private paused = false;
  private deferred = false;
  private saved: string;
  private refreshing: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly client: ViewClient, source: InstanceRef, copy: HelpCopy, topic: string | null = null) {
    super();
    if (!source || ![source.instance, source.plugin, source.revision, source.artifact].every(value => typeof value === "string" && value.length > 0))
      throw new Error("Select an exact R plugin instance.");
    this.source = Object.freeze(structuredClone(source));
    const saved = client.view.state as { choices?: unknown } | null;
    this.help = new Help({ session: () => this.help.copy.nativeSession,
      query: async (id, args) => {
        try {
          const result = await this.query<RInspection<unknown>>(id, args);
          if (result.status !== "ready") this.deferred = true;
          return result as never;
        } catch (error) { this.deferred = true; throw error; }
      }, changed: () => this.changed(), schedule: () => this.schedule(),
    }, copy, saved?.choices ?? (topic ? { topic } : undefined));
    this.saved = JSON.stringify(this.state());
  }
  protected readSnapshot(): ConnectionSnapshot { return { notice: this.notice, saveError: this.saveError, connected: this.connected, ready: this.ready }; }
  private state() { return { choices: { ...this.help.serialize() } }; }
  private async query<T>(id: string, arguments_: unknown): Promise<T> {
    const binding: ProviderBinding = { capability: { id, version: 1 }, provider: this.source,
      project: this.client.view.project, target: this.help.copy.nativeSession };
    const response = await this.client.query<{ data?: T }>({ id, version: 1 }, { binding, arguments: arguments_ } as JsonValue);
    if (response.data === undefined || response.data === null) throw new Error(`${id} is unavailable for the original R provider.`);
    return response.data;
  }
  private schedule() {
    if (this.stopped || this.paused || this.deferred || this.refreshing || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh().catch(() => undefined); }, 20);
  }
  private changed() {
    if (this.stopped || this.paused) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush().catch(() => undefined); }, 250);
  }
  flush(): Promise<void> {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    const task = this.saveQueue.then(() => this.persist());
    this.saveQueue = task.catch(() => undefined); return task;
  }
  private async persist() {
    if (this.stopped) throw new Error("The Help view connection is closed.");
    const state = this.state(), encoded = JSON.stringify(state);
    if (encoded === this.saved) return;
    try { await this.client.setState(state as JsonValue); this.saved = encoded; this.saveError = ""; }
    catch (error) { this.saveError = `View state was not saved: ${message(error)}`; throw error; }
    finally { if (!this.stopped) this.publish(); }
  }
  refresh(): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined; this.deferred = false;
    const task = (async () => {
      const state = await this.query<RInspectionState>("r.inspection_state", { expected_session: this.help.copy.nativeSession });
      if (this.stopped) return;
      if (!["ready", "busy", "unavailable"].includes(state.status) || !Array.isArray(state.notices) ||
        state.session_id !== this.help.copy.nativeSession || typeof state.cache_key !== "string" || !state.cache_key)
        throw new Error("The original R session is unavailable. Help was not retargeted.");
      this.connected = true; this.ready = state.status === "ready";
      this.notice = state.notices.join("\n") || (this.ready ? "" : `R is ${state.status}; the selected copy is retained.`); this.publish();
      if (!this.ready) { this.deferred = true; return; }
      // Yield between bounded batches. Busy/error retries wait for the caller's
      // next poll; observing does not start or recover R or renew package copies.
      for (let read = 0; read < 8 && !this.stopped && !this.paused && this.help.needsObservation; read++) {
        await this.help.observe(); if (this.deferred) break;
      }
    })();
    this.refreshing = task.catch(error => {
      if (!this.stopped) { this.connected = false; this.ready = false; this.deferred = true; this.notice = message(error); this.publish(); }
      throw error;
    }).finally(() => {
      this.refreshing = null;
      if (!this.stopped && !this.deferred && this.help.needsObservation) this.schedule();
    });
    return this.refreshing;
  }
  async pause() {
    this.paused = true; clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    await this.refreshing?.catch(() => undefined);
  }
  resume() { this.paused = false; this.schedule(); }
  stop() { this.stopped = true; clearTimeout(this.refreshTimer); clearTimeout(this.saveTimer); this.help.stop(); this.dispose(); }
}
