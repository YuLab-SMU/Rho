import type { PluginWindowLayout, PluginWindowNode, UpdatePluginWindowLayout } from "../../sdk/plugin-protocol/index.js";
import { immutable, Model } from "./shared/model";

interface WindowPorts {
  read(): Promise<PluginWindowLayout>;
  /** Resolve only with the original Operation's successful output. Retrying an
   * unconfirmed write must send the supplied request id and exact same arguments. */
  write(args: UpdatePluginWindowLayout, requestId: string): Promise<PluginWindowLayout>;
}
interface WindowSnapshot {
  saved: Readonly<PluginWindowLayout> | null;
  layout: Readonly<PluginWindowNode>;
  dirty: boolean;
  saving: boolean;
  error: string;
  pendingRequest: string | null;
}
// JSON object key order can change across the language-neutral Host boundary.
// Array order (views, children and their weights) remains meaningful.
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Presentation state only. It neither opens/closes views nor controls providers.
 * Failed acknowledgements retain their request; later edits cannot replace it. */
export class PluginWindowState extends Model<WindowSnapshot> {
  private saved: PluginWindowLayout | null = null;
  private layout: PluginWindowNode = { kind: "empty" };
  private pending: { args: UpdatePluginWindowLayout; request: string } | null = null;
  private task: Promise<void> | null = null;
  private error = "";
  private stopped = false;
  private readVersion = 0;
  constructor(readonly window: string, private ports: WindowPorts) { super(); }
  protected readSnapshot(): WindowSnapshot {
    return { saved: this.saved, layout: this.layout, dirty: !!this.pending || !!this.saved && !equal(this.saved.layout, this.layout),
      saving: this.task !== null, error: this.error, pendingRequest: this.pending?.request ?? null };
  }
  async load() {
    if (this.stopped) throw new Error("Window connection closed.");
    if (this.task || this.getSnapshot().dirty) throw new Error("Save or explicitly discard local layout changes before reloading.");
    const version = ++this.readVersion;
    const value = await this.ports.read();
    if (this.stopped || version !== this.readVersion) return;
    if (this.getSnapshot().dirty) return;
    this.validateScope(value);
    if (this.saved && value.version < this.saved.version) throw new Error("Window observation is older than its acknowledged layout.");
    if (this.saved && value.version === this.saved.version) {
      if (!equal(this.saved.layout, value.layout)) throw new Error("Window layout changed without a new owner version.");
      if (this.error) { this.error = ""; this.publish(); }
      return;
    }
    this.saved = immutable(structuredClone(value)); this.layout = this.saved.layout; this.error = ""; this.publish();
  }
  change(value: PluginWindowNode) {
    if (this.stopped || !this.saved) throw new Error("Read the current window before editing its layout.");
    this.readVersion++;
    this.layout = immutable(structuredClone(value)); this.publish();
  }
  private validateScope(value: PluginWindowLayout) {
    if (value.window !== this.window || !Number.isInteger(value.version) || value.version < 0 || value.version > 0xffffffff ||
      this.saved && (value.project !== this.saved.project || value.principal !== this.saved.principal))
      throw new Error("Window observation belongs to a different scope or has an invalid version.");
  }
  /** Explicit Retry resends the captured request. A successful in-flight write
   * followed by a local revert must still save that revert as the next version. */
  save(): Promise<void> {
    if (this.task) return this.task;
    if (this.stopped || !this.saved) return Promise.reject(new Error("Window connection closed or not loaded."));
    this.error = "";
    const run = async () => {
      while (!this.stopped && (this.pending || this.saved && !equal(this.saved.layout, this.layout))) {
        const saved = this.saved!;
        this.pending ??= { args: { window: this.window, expected_version: saved.version, layout: structuredClone(this.layout) }, request: crypto.randomUUID() };
        this.publish();
        const captured = this.pending, result = await this.ports.write(structuredClone(captured.args), captured.request);
        if (this.stopped) return;
        this.validateScope(result);
        if (result.version !== captured.args.expected_version + 1 || !equal(result.layout, captured.args.layout))
          throw new Error("Window save acknowledgement does not match the original change.");
        this.saved = immutable(structuredClone(result)); this.pending = null; this.publish();
      }
    };
    // Start after task assignment so every observer sees the in-flight guard.
    this.task = Promise.resolve().then(run).catch(error => {
      if (!this.stopped) { this.error = error instanceof Error ? error.message : String(error); this.publish(); }
      throw error;
    }).finally(() => { this.task = null; if (!this.stopped) this.publish(); });
    this.publish(); return this.task;
  }
  /** An explicit presentation-only discard. The journal still retains any
   * original operation, and its expected version fences later conflicting writes. */
  async discardAndReload() {
    if (this.task) throw new Error("Wait for the current layout request before discarding changes.");
    const previous = { layout: this.layout, pending: this.pending, saved: this.saved };
    const version = ++this.readVersion;
    try {
      const result = await this.ports.read();
      if (this.stopped || version !== this.readVersion) return;
      this.validateScope(result);
      this.saved = immutable(structuredClone(result)); this.layout = this.saved.layout; this.pending = null; this.error = ""; this.publish();
    } catch (error) {
      if (!this.stopped && version === this.readVersion) { Object.assign(this, previous); this.error = String(error); this.publish(); }
      throw error;
    }
  }
  stop() { this.stopped = true; this.readVersion++; this.dispose(); }
}
