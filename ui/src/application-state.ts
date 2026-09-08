import { Model, immutable } from "./shared/model";
import { json, message, sameScope } from "./shared/ports";
import type { RequestContext, PersistenceFragment } from "./shared/ports";
import type { ApplicationState } from "./generated/ApplicationState";

export interface StatePort {
  readState(project: string | null, key: string): Promise<ApplicationState>;
  writeState(project: string | null, state: ApplicationState): Promise<ApplicationState>;
}
interface SyncState {
  unsynced: boolean; syncError: string; stateConflict: ApplicationState | null;
}

/** A window's non-document fragments share one optimistic SQLite write. */
export class ApplicationPersistence extends Model<SyncState> {
  private fragments: PersistenceFragment[] = [];
  private state: ApplicationState;
  private dirty = false;
  private error = "";
  private conflict: ApplicationState | null = null;
  private unconfirmed: unknown;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private stopped = false;
  constructor(private port: StatePort, private context: () => RequestContext, private readonly stateKey = "studio", private readonly adoptCurrentStudio = false) {
    super(); this.state = { key: stateKey, version: null, value: null };
  }
  protected readSnapshot() { return { unsynced: this.dirty, syncError: this.error, stateConflict: this.conflict }; }
  get unsynced() { return this.dirty; }
  get syncError() { return this.error; }
  get stateConflict() { return this.conflict; }
  register(fragment: PersistenceFragment) { this.fragments.push(fragment); }
  serialize(): Record<string, unknown> {
    return Object.assign({ version: 2 }, ...this.fragments.map((f) => f.serialize()));
  }
  async restore() {
    const scope = this.context(), generation = ++this.generation;
    this.stopped = false;
    clearTimeout(this.timer);
    let state = scope.project ? await this.port.readState(scope.project, this.stateKey) :
      { key: this.stateKey, version: null, value: null };
    if (scope.project && this.adoptCurrentStudio && state.version === null && this.stateKey !== "studio") {
      // Explicitly give this newly identified window its own copy of the currently
      // supported Studio state. Document restoration remains in its existing owner.
      const current = await this.port.readState(scope.project, "studio");
      if (generation !== this.generation || !sameScope(scope, this.context())) return;
      if (current.version !== null) state = await this.port.writeState(scope.project, { key: this.stateKey, version: null, value: current.value });
    }
    if (generation !== this.generation || !sameScope(scope, this.context())) return;
    for (const fragment of this.fragments) fragment.restore(state.value);
    this.state = state;
    this.dirty = false; this.error = ""; this.conflict = null; this.unconfirmed = undefined;
    this.publish();
  }
  changed = () => {
    if (this.stopped) return;
    const notify = !this.dirty;
    this.dirty = true;
    if (notify) this.publish();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 400);
  };
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) {
      await this.saving;
      if (this.dirty && !this.error && !this.stopped) return this.flush();
      return;
    }
    const scope = this.context(), generation = this.generation;
    if (!scope.project || !this.dirty || this.stopped) return;
    const current = () => generation === this.generation && !this.stopped && sameScope(scope, this.context());
    const value = json(this.serialize());
    const task = (async () => {
      try {
        // A lifecycle fence can discard a committed write's reply without setting
        // an error. Reconcile its original value before a new attempt replaces it.
        if (this.error || this.unconfirmed !== undefined) {
          const remote = await this.port.readState(scope.project, this.state.key);
          if (!current()) return;
          if (remote.version !== this.state.version) {
            if (this.unconfirmed !== undefined && JSON.stringify(remote.value) === JSON.stringify(this.unconfirmed)) {
              this.state = remote;
              this.unconfirmed = undefined;
              if (JSON.stringify(remote.value) === JSON.stringify(value)) {
                this.error = ""; this.conflict = null;
                this.dirty = JSON.stringify(value) !== JSON.stringify(this.serialize());
                return;
              }
            } else {
              this.conflict = immutable(remote);
              throw new Error("Another window updated shared drafts. Your edits are retained. Resolve the window conflict.");
            }
          }
        }
        if (!current()) return;
        this.unconfirmed = value;
        const saved = await this.port.writeState(scope.project, { ...this.state, value });
        if (!current()) return;
        this.state = saved;
        this.error = ""; this.conflict = null; this.unconfirmed = undefined;
        this.dirty = JSON.stringify(value) !== JSON.stringify(this.serialize());
      } catch (error) {
        if (current()) { this.error = message(error); this.dirty = true; }
      } finally {
        if (current()) this.publish();
      }
    })();
    this.saving = task;
    await task;
    if (this.saving === task) this.saving = null;
    if (current() && this.dirty && !this.error) await this.flush();
  }
  async replaceSharedDrafts(remote: ApplicationState) {
    if (remote !== this.conflict) throw new Error("The conflict changed. Review the current shared drafts.");
    this.state = { ...this.state, version: remote.version };
    this.error = ""; this.conflict = null; this.unconfirmed = undefined;
    await this.flush();
  }
  stop() {
    this.stopped = true; this.generation++;
    clearTimeout(this.timer);
    this.saving = null;
  }
}

export interface EditorPreferences { editorFontSize: number; indentWidth: number }
export class Preferences extends Model<EditorPreferences> {
  private state: ApplicationState = { key: "preferences", version: null, value: null };
  private value: EditorPreferences = { editorFontSize: 14, indentWidth: 4 };
  private tail = Promise.resolve();
  private generation = 0;
  constructor(private port: StatePort) { super(); }
  protected readSnapshot() { return { ...this.value }; }
  get editorFontSize() { return this.value.editorFontSize; }
  get indentWidth() { return this.value.indentWidth; }
  async restore() {
    const generation = ++this.generation;
    const state = await this.port.readState(null, "preferences");
    if (generation !== this.generation) return;
    this.state = state;
    const value = state.value as Partial<EditorPreferences> | null;
    this.value = {
      editorFontSize: [12, 14, 16, 18].includes(value?.editorFontSize ?? 0) ? value!.editorFontSize! : 14,
      indentWidth: [2, 4, 8].includes(value?.indentWidth ?? 0) ? value!.indentWidth! : 4,
    };
    this.publish();
  }
  setPreferences(patch: Partial<EditorPreferences>) {
    const generation = this.generation;
    this.tail = this.tail.catch(() => {}).then(async () => {
      if (generation !== this.generation) return;
      const value = { ...this.value, ...patch };
      if (![12, 14, 16, 18].includes(value.editorFontSize) || ![2, 4, 8].includes(value.indentWidth))
        throw new Error("Invalid editor preferences");
      const state = await this.port.writeState(null, { ...this.state, value });
      if (generation !== this.generation) return;
      this.state = state; this.value = value; this.publish();
    });
    return this.tail;
  }
  stop() { this.generation++; }
}
