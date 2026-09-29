import type {AgentState} from '../public/agent-input/input.js';
import type { InstanceRef, JsonValue, ProviderBinding, WorkspacePaths } from "../public/plugin-protocol/index.js";
import type { PluginViewClient } from "../public/plugin-ui/index.js";
import { Files } from "./files.js";
import type { Observation, ResourceIdentity } from "./resource-ports.js";
import { Model } from "./shared/model.js";

interface Snapshot { connected: boolean; project: string | null; notice: string; saveError: string; }
type Client = Pick<PluginViewClient, "view" | "query" | "setState">;
const capabilities = ["files.list_directory", "files.search_files", "files.storage_status"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The view reads its own exact backend. Native paths never replace the opaque
 * protocol project identity; neither reads nor refreshes invoke an Operation. */
export class FilesConnection extends Model<Snapshot> {
  readonly source: InstanceRef;
  readonly files: Files;
  private identity: ResourceIdentity = { epoch: 1, project: null, connected: false, capabilities };
  private notice = "";
  private saveError = "";
  private saved: string;
  private actions: JsonValue;
  private agentState?: AgentState;
  private stopped = false;
  private paused = false;
  private deferred = false;
  private refreshing: Promise<void> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly client: Client) {
    super();
    this.source = Object.freeze(structuredClone(client.view.instance));
    const saved = client.view.state as { files?: unknown; actions?: JsonValue; agent?: AgentState } | null;
    this.actions = structuredClone(saved?.actions ?? null);
    this.agentState = structuredClone(saved?.agent);
    this.files = new Files({ context: () => this.identity,
      query: async (project, capability, args) => {
        if (project !== this.identity.project) throw new Error("The file request belongs to another project.");
        return this.read(capability, args);
      }, schedule: () => this.schedule(), changed: () => this.changed(),
    });
    this.files.restore(saved?.files);
    this.saved = JSON.stringify(this.state());
  }
  protected readSnapshot(): Snapshot {
    return { connected: this.identity.connected, project: this.identity.project, notice: this.notice, saveError: this.saveError };
  }
  get nativeRoot() { return this.identity.project; }
  get actionState() { return structuredClone(this.actions); }
  async saveActions(value: JsonValue) { this.actions = structuredClone(value); await this.flush(); }
  get savedAgent() { return structuredClone(this.agentState); }
  async saveAgent(value:AgentState) { this.agentState=structuredClone(value); await this.flush(); }
  private state() { return { ...(this.agentState?{agent:this.agentState}:{}), files: this.files.serialize(), actions: this.actions }; }
  async read<T>(id: string, arguments_: unknown): Promise<Observation<T>> {
    if (this.stopped || !this.identity.connected || !this.identity.project) throw new Error("The original Files provider is unavailable.");
    const binding: ProviderBinding = { capability: { id, version: 1 }, provider: this.source, project: this.client.view.project, target: this.identity.project };
    try {
      const result = await this.client.query<Observation<T>>({ id, version: 1 }, { binding, arguments: arguments_ } as JsonValue);
      if (result.status !== "ready" || result.data === undefined || result.data === null) {
        this.deferred = true;
        throw new Error(result.notices?.join("\n") || "The original Files observation is unavailable.");
      }
      return result;
    } catch (error) { this.deferred = true; throw error; }
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
    const task = this.saveQueue.then(async () => {
      if (this.stopped) throw new Error("The Files connection is closed.");
      const state = this.state(), encoded = JSON.stringify(state);
      if (encoded === this.saved) return;
      try { await this.client.setState(state as unknown as JsonValue); this.saved = encoded; this.saveError = ""; }
      catch (error) { this.saveError = `View state was not saved: ${message(error)}`; throw error; }
      finally { if (!this.stopped) this.publish(); }
    });
    this.saveQueue = task.catch(() => undefined); return task;
  }
  /** Explicit refresh and the slow observation timer invalidate native directory
   * caches. No Operation-list polling or scientific-runtime event is involved. */
  refresh(invalidate: boolean | "directories" = false): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    if (invalidate === "directories") this.files.refreshDirectories(true);
    else if (invalidate) this.files.refresh();
    if (this.refreshing) return this.refreshing;
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    this.deferred = false;
    const task = (async () => {
      const paths = await this.client.query<Observation<WorkspacePaths>>({ id: "workspace.paths", version: 1 }, {});
      if (this.stopped) return;
      const root = paths.data?.project_root;
      if (paths.status !== "ready" || typeof root !== "string" || !root.startsWith("/") ||
          this.identity.project !== null && this.identity.project !== root)
        throw new Error("The original project path is unavailable or changed.");
      this.identity = { ...this.identity, project: root, connected: true };
      this.notice = ""; this.publish();
      for (let batch = 0; batch < 8 && !this.stopped && !this.paused; batch++) {
        await this.files.observe();
        if (this.deferred || !this.files.needsObservation) break;
      }
      if (!this.stopped && !this.paused && (invalidate || !this.files.getSnapshot().storage)) {
        // Volume capacity is an independent observation. Losing it must not
        // disable successfully observed directory navigation and file opening.
        await this.files.observeStorage().catch(error => {
          if (!this.stopped) { this.notice = message(error); this.publish(); }
        });
      }
    })();
    this.refreshing = task.catch(error => {
      if (!this.stopped) {
        this.deferred = true; this.notice = message(error);
        this.identity = { ...this.identity, connected: false }; this.publish();
      }
      throw error;
    }).finally(() => {
      this.refreshing = null;
      if (!this.stopped && !this.deferred && this.files.needsObservation) this.schedule();
    });
    return this.refreshing;
  }
  async pause() {
    this.paused = true; clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    clearTimeout(this.saveTimer); this.saveTimer = undefined;
    await this.refreshing?.catch(() => undefined);
  }
  resume() { this.paused = false; this.schedule(); }
  stop() {
    this.stopped = true; clearTimeout(this.refreshTimer); clearTimeout(this.saveTimer);
    this.files.stop(); this.dispose();
  }
}
