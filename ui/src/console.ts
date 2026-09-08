import { Model, immutable } from "./shared/model";
import { message, sameScope } from "./shared/ports";
import type { QueryPort, RequestContext } from "./shared/ports";
import type { ConsoleState } from "./generated/ConsoleState";
import type { CodeCompleteness } from "./generated/CodeCompleteness";
import type { RunSource } from "./generated/RunSource";
import type { OperationRecord } from "./generated/OperationRecord";
import type { RespondInput } from "./generated/RespondInput";

export interface ConsoleView {
  input: string; hiddenBefore: number; scrollTop: number; follow: boolean;
  anchor: number; head: number;
}
class DraftView extends Model<ConsoleView> {
  readonly identity = Object.freeze({});
  private value: ConsoleView;
  constructor(value?: Partial<ConsoleView>) { super(); this.value = { input: "", hiddenBefore: 0, scrollTop: 0, follow: true, anchor: 0, head: 0, ...value }; }
  protected readSnapshot() { return { ...this.value }; }
  update(value: Partial<ConsoleView>) { this.value = { ...this.value, ...value }; this.publish(); }
}
interface ConsolePorts {
  context(): RequestContext; query: QueryPort;
  run(code: string, source: RunSource): Promise<OperationRecord>;
  invoke(id: string, args: unknown): Promise<OperationRecord>;
  cancel(id?: string, pending?: boolean): Promise<void>;
  respondInput(project: string, input: RespondInput): Promise<unknown>;
  changed(): void; schedule(): void; controlChanged(): void;
  showConsole(id: string, name: string): void;
}
interface ConsoleSnapshot { state: ConsoleState | null; history: readonly string[]; viewIds: readonly string[]; error: string }

export class Console extends Model<ConsoleSnapshot> {
  private state: ConsoleState | null = null;
  private history: string[] = [];
  private views = new Map<string, DraftView>();
  private error = "";
  private generation = 0;
  private request = 0;
  private refreshing: Promise<void> | null = null;
  private stopped = false;
  constructor(private ports: ConsolePorts) { super(); }
  protected readSnapshot() { return { state: this.state, history: Object.freeze([...this.history]), viewIds: Object.freeze([...this.views.keys()]), error: this.error }; }
  get consoleState() { return this.state; }
  get commandHistory() { return this.getSnapshot().history; }
  get queueing() { return !!this.state?.current || !!this.state?.pause || !!this.state?.pending.length || this.ports.context().runtimeState === "busy"; }
  private viewOwner(id: string) {
    let view = this.views.get(id);
    if (!view) { view = new DraftView(); this.views.set(id, view); }
    return view;
  }
  view(id: string) { return this.viewOwner(id).getSnapshot(); }
  viewIdentity(id: string) { return this.viewOwner(id).identity; }
  subscribeView = (id: string, listener: () => void) => this.viewOwner(id).subscribe(listener);
  getViewSnapshot = (id: string) => this.viewOwner(id).getSnapshot();
  updateView(id: string, patch: Partial<ConsoleView>) { this.viewOwner(id).update(patch); this.ports.changed(); }
  clearView(id: string) { this.updateView(id, { hiddenBefore: Date.now() }); }
  showHistory(id: string) { this.updateView(id, { hiddenBefore: 0 }); }
  newConsole() {
    const id = `console:${crypto.randomUUID()}`;
    this.viewOwner(id); this.ports.showConsole(id, `Console ${this.views.size}`); this.ports.changed(); this.publish();
    return id;
  }
  serialize() {
    return { consoleViews: Object.fromEntries([...this.views].map(([id, view]) => [id, view.getSnapshot()])),
      consoleInput: this.views.get("console")?.getSnapshot().input ?? "", commandHistory: this.history };
  }
  restore(value: unknown) {
    const data = value as { consoleViews?: Record<string, Partial<ConsoleView>>; consoleInput?: unknown; commandHistory?: unknown[] } | null;
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    for (const [id, view] of Object.entries(data?.consoleViews ?? {})) {
      if (!view || typeof view.input !== "string") continue;
      this.views.set(id, new DraftView({ input: view.input, hiddenBefore: Number(view.hiddenBefore) || 0, scrollTop: Number(view.scrollTop) || 0,
        follow: view.follow !== false, anchor: Math.max(0, Math.min(Number(view.anchor) || 0, view.input.length)), head: Math.max(0, Math.min(Number(view.head) || 0, view.input.length)) }));
    }
    if (!this.views.has("console")) this.views.set("console", new DraftView({ input: typeof data?.consoleInput === "string" ? data.consoleInput : "" }));
    this.history = (data?.commandHistory ?? []).filter((v): v is string => typeof v === "string").slice(-500);
    this.publish();
  }
  reset() { this.generation++; this.stopped = false; this.state = null; this.error = ""; this.refreshing = null; this.publish(); }
  resetSession() { this.reset(); }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    const scope = this.ports.context(), generation = this.generation, request = ++this.request;
    if (!scope.project || !scope.capabilities.includes("workspace.console_state")) return;
    const current = () => !this.stopped && generation === this.generation && request === this.request && sameScope(scope, this.ports.context(), true);
    const task = (async () => {
      try {
        const result = await this.ports.query(scope.project!, "workspace.console_state");
        if (!current()) return;
        if (result.status !== "ready" || !result.data) throw new Error(result.notices.join("\n") || `Console ${result.status}`);
        const state = result.data as ConsoleState;
        if (typeof state.session_id !== "string" || !Array.isArray(state.pending) || (scope.session && state.session_id !== scope.session))
          throw new Error("Console observation identity does not match");
        if (JSON.stringify(state) !== JSON.stringify(this.state) || this.error) {
          this.state = immutable(state); this.error = ""; this.publish(); this.ports.controlChanged();
        }
      } catch (error) {
        if (current()) { this.error = message(error); this.publish(); }
        throw error;
      }
    })();
    this.refreshing = task;
    try { await task; } finally { if (this.refreshing === task) this.refreshing = null; }
  }
  operationIds() {
    return [...new Set([this.state?.current?.operation_id, this.state?.pause?.operation_id, ...this.state?.pending.map((r) => r.operation_id) ?? []].filter((id): id is string => !!id))];
  }
  async checkCode(code: string): Promise<CodeCompleteness | null> {
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project || scope.runtimeState !== "idle") return null;
    const result = await this.ports.query(scope.project, "workspace.check_code", { code });
    if (this.stopped || generation !== this.generation || !sameScope(scope, this.ports.context(), true)) throw new Error("Code check superseded by client lifecycle");
    return result.status === "ready" ? result.data as CodeCompleteness : null;
  }
  async run(code: string, viewId: string) {
    const scope = this.ports.context(), generation = this.generation;
    const record = await this.ports.run(code, { view_id: viewId, label: viewId === "console" ? "Console" : `Console ${[...this.views.keys()].indexOf(viewId) + 1}`, kind: "console" });
    if (this.stopped || generation !== this.generation || !sameScope(scope, this.ports.context(), true)) return record;
    if (this.history.at(-1) !== code) this.history = [...this.history.slice(-499), code];
    if (this.view(viewId).input === code) this.updateView(viewId, { input: "", anchor: 0, head: 0 });
    this.ports.changed(); this.publish(); this.ports.schedule();
    return record;
  }
  async queueControl(pause: boolean) {
    const state = this.state, scope = this.ports.context(), generation = this.generation;
    if (!state) return;
    await this.ports.invoke(pause ? "workspace.pause_queue" : "workspace.resume_queue", { session_id: state.session_id, pause_id: pause ? null : state.pause?.id ?? null });
    if (!this.stopped && generation === this.generation && sameScope(scope, this.ports.context(), true)) this.ports.schedule();
  }
  async cancelPending(id?: string) {
    const scope = this.ports.context(), generation = this.generation;
    const errors: string[] = [];
    for (const run of this.state?.pending ?? []) {
      if (!sameScope(scope, this.ports.context(), true) || generation !== this.generation || this.stopped) return;
      if (!id || id === run.operation_id) try { await this.ports.cancel(run.operation_id, true); } catch (error) { errors.push(message(error)); }
    }
    if (!this.stopped && generation === this.generation && sameScope(scope, this.ports.context(), true)) this.ports.schedule();
    if (errors.length) throw new Error(`Some entries changed state or could not be cancelled: ${errors.join("; ")}`);
  }
  async respond(value: string) {
    const scope = this.ports.context(), input = this.state?.input, generation = this.generation;
    if (!scope.project || !input || input.submitted) return;
    // Response content, including passwords, is never put in any model, fragment or log.
    try {
      await this.ports.respondInput(scope.project, { session_id: input.session_id, operation_id: input.operation_id,
        request_id: input.request_id, reply_id: crypto.randomUUID(), value });
    } finally {
      if (!this.stopped && generation === this.generation && sameScope(scope, this.ports.context(), true)) this.ports.schedule();
    }
  }
  stop() { this.stopped = true; this.generation++; this.refreshing = null; this.dispose(); for (const view of this.views.values()) view.dispose(); }
}
