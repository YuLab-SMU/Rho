import { Model, immutable, readonlyMap } from "./shared/model";
import { message } from "./shared/ports";
import type { AgentHandoffPorts } from "./agent-handoff-ports";
import type { AgentHandoffSourceSnapshot } from "./generated/AgentHandoffSourceSnapshot";
import type { AgentHandoffTargetSnapshot } from "./generated/AgentHandoffTargetSnapshot";
import type { AgentHandoffCommand } from "./generated/AgentHandoffCommand";
import type { AgentHandoffReceipt } from "./generated/AgentHandoffReceipt";
import type { AgentContextSelection } from "./generated/AgentContextSelection";
import type { AgentContextPreview } from "./generated/AgentContextPreview";
import type { ProjectAgentTaskRef } from "./generated/ProjectAgentTaskRef";
import type { Diagnostic } from "./generated/Diagnostic";

const clone = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const HANDOFF_BODY_BYTES = 16 * 1024;
export const handoffKey = (ref: ProjectAgentTaskRef) => ref.kind === "rho" ? `rho:${ref.conversation_id}` : `native:${ref.task_id}`;
const validRef = (ref: unknown): ref is ProjectAgentTaskRef => !!ref && typeof ref === "object" && (("kind" in ref && ref.kind === "rho" && "conversation_id" in ref && typeof ref.conversation_id === "string") || ("kind" in ref && ref.kind === "native" && "task_id" in ref && typeof ref.task_id === "string"));

export interface HandoffEditor {
  source: ProjectAgentTaskRef; observation: AgentHandoffSourceSnapshot | null;
  targetRef: ProjectAgentTaskRef | null; target: AgentHandoffTargetSnapshot | null;
  body: string; context: AgentContextSelection[]; open: boolean;
  loading: boolean; sending: boolean; checking: boolean;
  pending: AgentHandoffCommand | null; receipt: AgentHandoffReceipt | null;
  error: string; diagnostic: Diagnostic | null;
  preview: AgentContextPreview | null; previewLoading: boolean; previewError: string;
}
interface Scope { project: string; generation: number; window: NonNullable<ReturnType<AgentHandoffPorts["window"]>> }

/** Local handoff forms, kept with AgentTasks' existing draft cache. No task lifecycle or polling. */
export class AgentHandoffs extends Model<{ editors: ReadonlyMap<string, Readonly<HandoffEditor>> }> {
  private editors = new Map<string, HandoffEditor>();
  private reads = new Map<string, symbol>();
  private generation = 0;
  constructor(private ports: AgentHandoffPorts) { super(); }
  protected readSnapshot() { return { editors: readonlyMap(new Map([...this.editors].map(([key, entry]) => [key, immutable(clone(entry))]))) }; }
  editor(source: ProjectAgentTaskRef) { return this.getSnapshot().editors.get(handoffKey(source)); }
  private scope(): Scope {
    const context = this.ports.context(), window = this.ports.window();
    if (!context.project || !context.connected || !window) throw new Error("Connect this window to the project first.");
    return { project: context.project, generation: this.generation, window: clone(window) };
  }
  private current(scope: Scope) { return scope.generation === this.generation && scope.project === this.ports.context().project && same(scope.window, this.ports.window()); }
  private update(required = false) { this.ports.changed(required); this.publish(); }
  private mutable(source: ProjectAgentTaskRef) {
    const entry = this.editors.get(handoffKey(source));
    if (!entry) throw new Error("Prepare the handoff first.");
    return entry;
  }
  async prepare(source: ProjectAgentTaskRef) {
    const key = handoffKey(source);
    let entry = this.editors.get(key);
    if (!entry || entry.receipt) {
      if (!entry && this.editors.size >= 16) throw new Error("Finish an existing handoff before preparing another.");
      entry = { source: clone(source), observation: null, targetRef: null, target: null, body: "", context: [], open: true, loading: false, sending: false, checking: false, pending: null, receipt: null, error: "", diagnostic: null, preview: null, previewLoading: false, previewError: "" };
      this.editors.set(key, entry);
    }
    entry.open = true; this.update();
    if (!entry.observation && !entry.pending) await this.reloadSource(source);
  }
  close(source: ProjectAgentTaskRef) { this.mutable(source).open = false; this.update(); }
  edit(source: ProjectAgentTaskRef, body: string) {
    const entry = this.mutable(source); if (entry.pending || entry.sending || entry.receipt) return;
    if (new TextEncoder().encode(body).length > HANDOFF_BODY_BYTES) throw new Error("Keep the handoff under 16 KiB.");
    entry.body = body; this.update();
  }
  removeContext(source: ProjectAgentTaskRef, index: number) {
    const entry = this.mutable(source); if (entry.pending || entry.sending || entry.receipt) return;
    entry.context = entry.context.filter((_, i) => i !== index); this.update();
  }
  invalidContext(entry: Readonly<HandoffEditor>) { return entry.context.some(selection => !entry.observation?.context.some(candidate => same(candidate, selection))); }
  async reloadSource(source: ProjectAgentTaskRef) {
    const entry = this.mutable(source); if (entry.pending || entry.sending) return;
    const scope = this.scope(), key = `${handoffKey(source)}:source`, read = Symbol(); this.reads.set(key, read);
    entry.loading = true; entry.error = ""; this.publish();
    try {
      await this.ports.synchronizeDraft(source); if (!this.current(scope)) return;
      const result = await this.ports.query({ project_root: scope.project, window: scope.window, query: { kind: "source", source } });
      if (!this.current(scope) || this.reads.get(key) !== read) return;
      if (result.kind !== "source" || !same(result.source.source, source)) throw new Error("Handoff source identity mismatch.");
      if (!entry.observation) { if (!entry.body) entry.body = result.source.body; entry.context = clone(result.source.context); }
      entry.observation = clone(result.source); entry.diagnostic = null;
    } catch (error) { if (this.current(scope) && this.reads.get(key) === read) this.failed(entry, error); }
    finally { if (this.current(scope) && this.reads.get(key) === read) { entry.loading = false; this.update(); } }
  }
  async selectTarget(source: ProjectAgentTaskRef, target: ProjectAgentTaskRef) {
    const entry = this.mutable(source); if (entry.pending || entry.sending || entry.receipt) return;
    if (same(source, target)) throw new Error("Choose another task in this project.");
    const scope = this.scope(), key = `${handoffKey(source)}:target`, read = Symbol(); this.reads.set(key, read);
    entry.targetRef = clone(target); entry.target = null; entry.loading = true; entry.error = ""; this.publish();
    try {
      await this.ports.synchronizeDraft(target); if (!this.current(scope)) return;
      const result = await this.ports.query({ project_root: scope.project, window: scope.window, query: { kind: "target", target } });
      if (!this.current(scope) || this.reads.get(key) !== read) return;
      if (result.kind !== "target" || !same(result.target.target, target)) throw new Error("Handoff target identity mismatch.");
      entry.target = clone(result.target); entry.diagnostic = null;
    } catch (error) { if (this.current(scope) && this.reads.get(key) === read) this.failed(entry, error); }
    finally { if (this.current(scope) && this.reads.get(key) === read) { entry.loading = false; this.update(); } }
  }
  private failed(entry: HandoffEditor, error: unknown) { entry.error = message(error); entry.diagnostic = (error as { diagnostic?: Diagnostic } | null)?.diagnostic ?? null; }
  async appendToDraft(source: ProjectAgentTaskRef) {
    const entry = this.mutable(source), target = entry.target, observation = entry.observation;
    if (entry.pending || entry.sending || entry.loading || entry.receipt) return;
    if (!target?.writable || !observation || !entry.body.trim() || this.invalidContext(entry)) throw new Error("Review the handoff and choose an editable target draft first.");
    if (new TextEncoder().encode(entry.body).length > HANDOFF_BODY_BYTES) throw new Error("Keep the handoff under 16 KiB.");
    const scope = this.scope(); entry.sending = true; entry.error = ""; this.publish();
    try {
      await this.ports.synchronizeDraft(target.target); if (!this.current(scope)) return;
      const observed = await this.ports.query({ project_root: scope.project, window: scope.window, query: { kind: "target", target: target.target } });
      if (!this.current(scope)) return;
      if (observed.kind !== "target" || !same(observed.target.target, target.target)) throw new Error("Handoff target identity mismatch.");
      if (!same(observed.target, target)) { entry.target = clone(observed.target); entry.error = "The target draft changed. Review its current content before adding the handoff."; return; }
      const request: AgentHandoffCommand = { project_root: scope.project, window: scope.window, request_id: crypto.randomUUID(),
        source: clone(source), source_revision: observation.revision, target: clone(target.target), target_draft_version: target.draft_version,
        target_control_generation: target.control_generation, body: entry.body, context: clone(entry.context) };
      entry.pending = immutable(clone(request));
      try { this.update(true); } catch { entry.pending = null; throw new Error("The handoff was not submitted because its request identity could not be saved."); }
      await this.dispatch(entry, request, scope);
    } catch (error) { if (this.current(scope)) this.failed(entry, error); }
    finally { if (this.current(scope)) { entry.sending = false; this.update(); } }
  }
  private async dispatch(entry: HandoffEditor, request: AgentHandoffCommand, scope: Scope, wasUncertain = false) {
    try {
      const receipt = await this.ports.command(request);
      if (!this.current(scope)) return;
      this.acceptReceipt(entry, request, receipt);
      await this.ports.refreshTarget(receipt.target);
    } catch (error) {
      if (!this.current(scope)) return;
      if (!wasUncertain && (error as { submission?: string } | null)?.submission === "rejected") { entry.pending = null; entry.target = null; }
      this.failed(entry, error);
    }
  }
  private acceptReceipt(entry: HandoffEditor, request: AgentHandoffCommand, receipt: AgentHandoffReceipt) {
    if (receipt.request_id !== request.request_id || !same(receipt.source, request.source) || !same(receipt.target, request.target)) throw new Error("Handoff receipt identity mismatch. Check the original request.");
    entry.receipt = clone(receipt); entry.pending = null; entry.error = ""; entry.diagnostic = null; this.update();
  }
  async check(source: ProjectAgentTaskRef) {
    const entry = this.mutable(source), request = entry.pending;
    if (!request || entry.checking || entry.sending) return;
    const scope = this.scope(); entry.checking = true; entry.error = ""; this.publish();
    try {
      const result = await this.ports.query({ project_root: scope.project, window: scope.window, query: { kind: "receipt", request_id: request.request_id } });
      if (!this.current(scope)) return;
      if (result.kind !== "receipt") throw new Error("Unexpected handoff receipt response.");
      if (result.receipt) { this.acceptReceipt(entry, request, result.receipt); await this.ports.refreshTarget(result.receipt.target); }
      else entry.error = "No receipt is available yet. You can check again or retry the original request.";
    } catch (error) { if (this.current(scope)) this.failed(entry, error); }
    finally { if (this.current(scope)) { entry.checking = false; this.update(); } }
  }
  async retry(source: ProjectAgentTaskRef) {
    const entry = this.mutable(source), request = entry.pending;
    if (!request || entry.checking || entry.sending) return;
    const scope = this.scope();
    if (request.project_root !== scope.project || !same(request.window, scope.window)) throw new Error("The original handoff belongs to another window incarnation. Check its receipt.");
    entry.sending = true; entry.error = ""; this.publish();
    try { await this.dispatch(entry, request, scope, true); }
    finally { if (this.current(scope)) { entry.sending = false; this.update(); } }
  }
  async preview(source: ProjectAgentTaskRef, selection: AgentContextSelection) {
    const entry = this.mutable(source), scope = this.scope(), key = `${handoffKey(source)}:preview`, read = Symbol(); this.reads.set(key, read);
    entry.preview = null; entry.previewError = ""; entry.previewLoading = true; this.publish();
    try { const value = await this.ports.preview(selection); if (this.current(scope) && this.reads.get(key) === read) { entry.preview = value; if (!value) entry.previewError = "This source is unavailable in the current observation."; } }
    catch (error) { if (this.current(scope) && this.reads.get(key) === read) entry.previewError = message(error); }
    finally { if (this.current(scope) && this.reads.get(key) === read) { entry.previewLoading = false; this.publish(); } }
  }
  closePreview(source: ProjectAgentTaskRef) { const entry = this.mutable(source); this.reads.delete(`${handoffKey(source)}:preview`); entry.preview = null; entry.previewError = ""; entry.previewLoading = false; this.publish(); }
  serialize() {
    const entries = [...this.editors].map(([key, entry]) => [key, { ...entry, target: null, loading: false, sending: false, checking: false, preview: null, previewError: "", previewLoading: false }]);
    if (bytes(entries) > 2 * 1024 * 1024) throw new Error("Local handoff drafts exceed 2 MiB.");
    return clone(entries);
  }
  restore(value: unknown) {
    if (!Array.isArray(value) || bytes(value) > 2 * 1024 * 1024) return;
    for (const pair of value.slice(0, 16)) {
      if (!Array.isArray(pair)) continue;
      const entry = pair[1] as HandoffEditor | undefined;
      if (!entry || !validRef(entry.source) || typeof entry.body !== "string" || new TextEncoder().encode(entry.body).length > 32768 || !Array.isArray(entry.context)) continue;
      if (entry.pending && (entry.pending.project_root !== this.ports.context().project || typeof entry.pending.request_id !== "string" || !same(entry.pending.source, entry.source))) continue;
      this.editors.set(handoffKey(entry.source), { ...clone(entry), target: null, loading: false, sending: false, checking: false, preview: null, previewError: "", previewLoading: false });
    }
    this.publish();
  }
  reset() { this.generation++; this.reads.clear(); this.editors.clear(); this.publish(); }
  override dispose() { this.reset(); super.dispose(); }
}
