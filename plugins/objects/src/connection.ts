import type { InstanceRef, JsonValue, ProviderBinding } from "../public/plugin-protocol/index.js";
import type { PluginViewClient } from "../public/plugin-ui/index.js";
import type { RInspection, RInspectionState } from "../public/r-protocol/index.js";
import { Objects } from "./objects.js";
import type { ResourceIdentity } from "./resource-ports.js";
import { Model } from "./shared/model.js";

interface ConnectionSnapshot {
  readonly session: { project: string; runtime: { state: string } | null };
  readonly notice: string;
  readonly saveError: string;
  readonly connected: boolean;
}
type ViewClient = Pick<PluginViewClient, "view" | "query" | "setState">;
const capabilities = ["r.list_objects", "r.observe_object", "r.read_object"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One exact R provider/session and one view's acknowledged presentation state.
 * Polling observes native readiness, never Operation-list row IDs or timestamps.
 * Nothing here starts R, recovers work or invokes scientific code. */
export class ObjectsConnection extends Model<ConnectionSnapshot> {
  readonly objects: Objects;
  readonly source: InstanceRef;
  private identity: ResourceIdentity;
  private cacheKey: string | null = null;
  private notice = "";
  private saveError = "";
  private saved = "";
  private actions: JsonValue = null;
  private stopped = false;
  private refreshing: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private deferred = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly client: ViewClient, source: InstanceRef) {
    super();
    this.source = Object.freeze(structuredClone(source));
    if (![source.instance, source.plugin, source.revision, source.artifact].every(value => typeof value === "string" && value.length > 0))
      throw new Error("Select an exact R plugin instance.");
    const saved = client.view.state as { nativeSession?: unknown; objects?: unknown; actions?: JsonValue } | null;
    this.actions = structuredClone(saved?.actions ?? null);
    const session = typeof saved?.nativeSession === "string" && saved.nativeSession ? saved.nativeSession : null;
    this.identity = { epoch: 1, project: client.view.project, session, runtimeState: null, connected: false, capabilities };
    this.objects = new Objects({ context: () => this.identity,
      query: async (project, capability, args) => {
        if (project !== this.identity.project) throw new Error("Object request belongs to a different project.");
        const result = await this.query<RInspection<unknown>>(capability, args, this.identity.session);
        if (result.status !== "ready") this.deferred = true;
        if (result.status === "busy") {
          this.identity = { ...this.identity, runtimeState: "busy" };
          this.notice = result.notices.join("\n"); this.publish();
        }
        return result;
      }, schedule: () => this.schedule(), changed: () => this.changed(),
    });
    this.objects.restore(saved?.objects);
    this.saved = JSON.stringify(this.state());
  }
  protected readSnapshot(): ConnectionSnapshot {
    return { session: { project: this.identity.project!, runtime: this.identity.session ? { state: this.identity.runtimeState ?? "unavailable" } : null },
      notice: this.notice, saveError: this.saveError, connected: this.identity.connected };
  }
  get nativeSession() { return this.identity.session; }
  get actionState(): JsonValue { return structuredClone(this.actions); }
  async saveActions(value: JsonValue) { this.actions = structuredClone(value); await this.flush(); }
  private state() { return { nativeSession: this.identity.session, objects: this.objects.serialize(), actions: this.actions }; }
  private binding(id: string, target: string | null): ProviderBinding {
    return { capability: { id, version: 1 }, provider: this.source, project: this.identity.project!, target };
  }
  private async query<T>(id: string, arguments_: unknown, target: string | null): Promise<T> {
    const response = await this.client.query<{ data?: T }>({ id, version: 1 },
      { binding: this.binding(id, target), arguments: arguments_ } as JsonValue);
    if (response.data === undefined || response.data === null) throw new Error(`${id} is unavailable for the original R provider.`);
    return response.data;
  }
  private schedule() {
    if (this.stopped || this.deferred || this.refreshing || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch(() => undefined);
    }, 20);
  }
  private changed() {
    if (this.stopped) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.flush().catch(() => undefined); }, 250);
  }
  flush(): Promise<void> {
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    // Compare against acknowledged state only after earlier writes settle. A
    // user may revert an edit while its preceding save is still in flight.
    const task = this.saveQueue.then(() => this.persist());
    this.saveQueue = task.catch(() => undefined);
    return task;
  }
  private async persist() {
    if (this.stopped) throw new Error("The Objects view connection is closed.");
    const state = this.state(), encoded = JSON.stringify(state);
    if (encoded === this.saved) return;
    try { await this.client.setState(state as JsonValue); this.saved = encoded; this.saveError = ""; }
    catch (error) { this.saveError = `View state was not saved: ${message(error)}`; throw error; }
    finally { if (!this.stopped) this.publish(); }
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    this.deferred = false;
    const task = (async () => {
      const previous = this.identity;
      const state = await this.query<RInspectionState>("r.inspection_state", { expected_session: previous.session }, previous.session);
      if (this.stopped) return;
      if (!["ready", "busy", "unavailable"].includes(state.status) || !Array.isArray(state.notices) ||
          !(state.session_id === null || typeof state.session_id === "string" && state.session_id.length > 0) ||
          (state.session_id === null ? state.cache_key !== null || state.status === "ready" : typeof state.cache_key !== "string" || !state.cache_key) ||
          (previous.session !== null && state.session_id !== previous.session))
        throw new Error("R inspection readiness changed its original session or returned an invalid observation.");
      this.identity = { ...previous, session: state.session_id, connected: true,
        runtimeState: state.status === "ready" ? "idle" : state.status === "busy" ? "busy" : "unavailable" };
      if (previous.session !== state.session_id) { this.objects.sessionChanged(); this.changed(); }
      else if (!previous.connected || this.cacheKey !== state.cache_key || state.status === "unavailable" && previous.runtimeState !== "unavailable") this.objects.invalidate();
      this.cacheKey = state.cache_key;
      this.notice = state.notices.join("\n"); this.publish();
      // A bounded batch allows separate frame actions and readiness reads to run.
      // Busy/unavailable native reads defer retries to the next caller's poll.
      for (let read = 0; read < 8 && !this.stopped; read++) {
        await this.objects.observe();
        if (this.deferred || !this.objects.needsObservation) break;
      }
    })();
    this.refreshing = task.catch(error => {
      if (!this.stopped) {
        const connected = this.identity.connected;
        this.identity = { ...this.identity, connected: false, runtimeState: "unavailable" };
        this.deferred = true;
        if (connected) this.objects.invalidate();
        this.notice = message(error); this.publish();
      }
      throw error;
    }).finally(() => {
      this.refreshing = null;
      if (!this.stopped && !this.deferred && this.objects.needsObservation) this.schedule();
    });
    return this.refreshing;
  }
  stop() {
    this.stopped = true; clearTimeout(this.refreshTimer); clearTimeout(this.saveTimer);
    this.objects.stop(); this.dispose();
  }
}
