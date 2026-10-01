import type { AgentContextSelection, AgentHandoffCommand, AgentHandoffReceipt, AgentHandoffSourceSnapshot, AgentHandoffTargetSnapshot, ProjectAgentTaskRef } from '../sdk/index.js';
import type { NativeAgentModel } from './native-model.js';
import { type Client, type Intent, type RecordReply, json, same, inspectOriginal, verifyOriginal } from './operations.js';

type Append = Omit<AgentHandoffCommand, 'project_root' | 'window'>;
export interface HandoffEditor {
  source: ProjectAgentTaskRef; observation: AgentHandoffSourceSnapshot | null;
  body: string; context: AgentContextSelection[]; targetRef: ProjectAgentTaskRef | null; targetTitle: string | null;
  open: boolean; pending: Intent | null; receipt: AgentHandoffReceipt | null; error: string;
}
export interface HandoffState { editors: Record<string, HandoffEditor>; }
export const handoffKey = (ref: ProjectAgentTaskRef) => ref.kind === 'rho' ? `rho:${ref.conversation_id}` : `native:${ref.task_id}`;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Human-edited transfer through ordinary ports. Saved intents are recovery
 * material; reopening never dispatches a transfer or starts an Agent. */
export class HandoffModel {
  readonly state: HandoffState;
  readonly targets = new Map<string, AgentHandoffTargetSnapshot>();
  private working = new Set<string>();
  private stopped = false;
  constructor(private client: Client, private owner: Pick<NativeAgentModel, 'state' | 'read' | 'save'>,
    private synchronize: (ref: ProjectAgentTaskRef) => Promise<void>,
    private refreshTarget: (ref: ProjectAgentTaskRef) => Promise<void>, private changed = () => {}) {
    this.state = owner.state.handoffs ??= { editors: {} };
    if (Object.keys(this.state.editors).length > 4 || bytes(JSON.stringify(this.state)) > 131072)
      throw Error('The saved handoff drafts exceed their view limit. Their contents were retained.');
    for (const [key, entry] of Object.entries(this.state.editors)) {
      if (handoffKey(entry.source) !== key || typeof entry.body !== 'string' || !Array.isArray(entry.context))
        throw Error('The saved handoff does not match its source task.');
      if (entry.pending) this.validateIntent(entry, entry.pending);
    }
  }
  private live() { if (this.stopped) throw Error('The Agent view is closed. The original handoff is retained.'); }
  private notify() { if (!this.stopped) this.changed(); }
  private binding(id: string) { return { provider: this.client.view.instance, project: this.client.view.project, capability: { id, version: 1 }, target: null }; }
  private validateIntent(entry: HandoffEditor, intent: Intent) {
    const input = intent.arguments as unknown as { binding: unknown; arguments: Append; preconditions: unknown };
    if (intent.view !== this.client.view.view || intent.capability.id !== 'agent.handoff.append' || intent.capability.version !== 1 ||
      !same(input.binding, this.binding('agent.handoff.append')) || input.preconditions !== null || input.arguments.request_id !== intent.request ||
      !same(input.arguments.source, entry.source) || !same(input.arguments.target, entry.targetRef) ||
      input.arguments.body !== entry.body || !same(input.arguments.context, entry.context))
      throw Error('The original handoff belongs to another source, target, view or instance.');
  }
  editor(ref: ProjectAgentTaskRef) { return this.state.editors[handoffKey(ref)]; }
  busy(ref: ProjectAgentTaskRef) { return this.working.has(handoffKey(ref)); }
  locked(entry: HandoffEditor) { return !!entry.pending || !!entry.receipt || this.busy(entry.source); }
  invalidContext(entry: HandoffEditor) { return entry.context.some(item => !entry.observation?.context.some(original => same(original, item))); }
  private mutable(ref: ProjectAgentTaskRef) {
    this.live(); const entry = this.editor(ref); if (!entry) throw Error('Prepare a handoff first.'); return entry;
  }
  private async save() {
    this.live();
    if (bytes(JSON.stringify(this.state)) > 131072) throw Error('Finish an existing handoff before adding more source material. Your input is retained.');
    await this.owner.save(); this.live(); this.notify();
  }
  private async work(ref: ProjectAgentTaskRef, action: (entry: HandoffEditor) => Promise<void>) {
    const entry = this.mutable(ref), key = handoffKey(ref);
    if (this.working.has(key)) throw Error('Wait for the current handoff observation.');
    this.working.add(key); entry.error = ''; this.notify();
    try { await action(entry); }
    catch (error) { if (!this.stopped) { entry.error = error instanceof Error ? error.message : String(error); } throw error; }
    finally { this.working.delete(key); this.notify(); }
  }
  async prepare(source: ProjectAgentTaskRef) {
    this.live(); const key = handoffKey(source);
    if (!this.state.editors[key] || this.state.editors[key]!.receipt) {
      if (!this.state.editors[key] && Object.keys(this.state.editors).length >= 4)
        throw Error('Finish and close an existing handoff before preparing another.');
      this.state.editors[key] = { source: structuredClone(source), observation: null, body: '', context: [], targetRef: null, targetTitle: null, open: true, pending: null, receipt: null, error: '' };
      this.targets.delete(key);
    }
    const entry = this.state.editors[key]!; entry.open = true; await this.save();
    if (!entry.observation && !entry.pending) await this.reloadSource(source);
  }
  async close(ref: ProjectAgentTaskRef) { const entry = this.mutable(ref); entry.open = false; if (entry.receipt) delete this.state.editors[handoffKey(ref)]; await this.save(); }
  edit(ref: ProjectAgentTaskRef, text: string) {
    const entry = this.mutable(ref); if (this.locked(entry)) throw Error('Inspect the original handoff before editing.');
    if (bytes(text) > 16384) throw Error('Keep the handoff under 16 KiB.');
    entry.body = text; this.notify();
  }
  async remove(ref: ProjectAgentTaskRef, selection: AgentContextSelection) {
    const entry = this.mutable(ref); if (this.locked(entry)) return;
    entry.context = entry.context.filter(item => !same(item, selection)); await this.save();
  }
  async reloadSource(ref: ProjectAgentTaskRef) {
    if (this.locked(this.mutable(ref))) return;
    await this.work(ref, async entry => {
      await this.synchronize(ref);
      const source = await this.owner.read<AgentHandoffSourceSnapshot>('agent.handoff.source', { source: ref }); this.live();
      if (!same(source.source, ref) || source.context.length > 16 || bytes(JSON.stringify(source)) > 65536) throw Error('The source does not match this bounded handoff.');
      if (!entry.observation) { if (!entry.body) entry.body = source.body; entry.context = structuredClone(source.context); }
      entry.observation = structuredClone(source); await this.save();
    });
  }
  async selectTarget(ref: ProjectAgentTaskRef, target: ProjectAgentTaskRef) {
    if (this.locked(this.mutable(ref))) return;
    if (same(ref, target)) throw Error('Choose another task in this project.');
    await this.work(ref, async entry => {
      entry.targetRef = structuredClone(target); entry.targetTitle = null; this.targets.delete(handoffKey(ref)); await this.save();
      await this.synchronize(target); const value = await this.readTarget(target); this.live();
      this.targets.set(handoffKey(ref), value); entry.targetTitle = value.title; await this.save();
    });
  }
  private async readTarget(target: ProjectAgentTaskRef) {
    const value = await this.owner.read<AgentHandoffTargetSnapshot>('agent.handoff.target', { target }); this.live();
    if (!same(value.target, target) || !Number.isSafeInteger(value.draft_version)) throw Error('The target draft belongs to another task.');
    return value;
  }
  async append(ref: ProjectAgentTaskRef) {
    const entry = this.mutable(ref), target = this.targets.get(handoffKey(ref));
    if (this.locked(entry)) throw Error('Inspect the original handoff before adding again.');
    if (!entry.observation || !target?.writable || !entry.body.trim() || this.invalidContext(entry)) throw Error('Review the source and an editable target draft first.');
    await this.work(ref, async entry => {
      await this.synchronize(target.target); const current = await this.readTarget(target.target);
      if (!same(target, current)) { this.targets.set(handoffKey(ref), current); throw Error('The target draft changed. Review its current content before adding the handoff.'); }
      const request = crypto.randomUUID(), input: Append = {
        request_id: request, source: structuredClone(ref), source_revision: entry.observation!.revision,
        target: structuredClone(target.target), target_draft_version: target.draft_version, target_control_generation: target.control_generation,
        body: entry.body, context: structuredClone(entry.context),
      };
      entry.pending = { view: this.client.view.view, request, capability: { id: 'agent.handoff.append', version: 1 }, operation: null,
        arguments: json({ binding: this.binding('agent.handoff.append'), arguments: input, preconditions: null }) };
      await this.save(); await this.dispatch(entry);
    });
  }
  private async accept(entry: HandoffEditor, receipt: AgentHandoffReceipt) {
    const intent = entry.pending!; this.validateIntent(entry, intent);
    const input = (intent.arguments as unknown as { arguments: Append }).arguments;
    if (!receipt || receipt.request_id !== intent.request || !same(receipt.source, input.source) || !same(receipt.target, input.target) ||
      receipt.target_draft_version !== input.target_draft_version + 1 || !Number.isSafeInteger(receipt.created_at_ms))
      throw Error('The handoff receipt does not match the original request.');
    entry.receipt = structuredClone(receipt); entry.pending = null; entry.error = ''; await this.save();
    await this.refreshTarget(receipt.target);
  }
  private async consume(entry: HandoffEditor, record: RecordReply) {
    entry.pending!.operation = record.operation.operation_id;
    if (record.status === 'succeeded') { await this.accept(entry, record.output as AgentHandoffReceipt); return; }
    if (record.status === 'failed' || record.status === 'cancelled') {
      entry.pending = null; this.targets.delete(handoffKey(entry.source)); await this.save();
      throw Error(record.error || 'The original handoff was rejected. Refresh source and target before trying again.');
    }
    entry.error = 'The original handoff is not confirmed. Check its receipt before continuing.'; await this.save();
  }
  private async dispatch(entry: HandoffEditor) {
    const intent = structuredClone(entry.pending!); this.validateIntent(entry, intent);
    const reply = await this.client.invoke(intent.capability, intent.arguments, { requestId: intent.request }); this.live();
    await this.consume(entry, await verifyOriginal(reply, intent));
  }
  async check(ref: ProjectAgentTaskRef) {
    if (!this.mutable(ref).pending) return;
    await this.work(ref, async entry => {
      const intent = entry.pending!; this.validateIntent(entry, intent);
      const id = 'agent.handoff.receipt';
      const value = await this.client.query<{ status: string; completeness: string; data?: AgentHandoffReceipt | null }>({ id, version: 1 },
        json({ binding: this.binding(id), arguments: { request_id: intent.request }, preconditions: null })); this.live();
      if (value.status === 'ready' && value.completeness === 'complete' && value.data) { await this.accept(entry, value.data); return; }
      // Absence alone never proves failure. The original native Operation can
      // separately establish rejection, or leave the request unconfirmed.
      await this.consume(entry, await inspectOriginal(this.client, intent));
    });
  }
  async retry(ref: ProjectAgentTaskRef) {
    if (!this.mutable(ref).pending) return;
    await this.work(ref, async entry => { await this.save(); await this.dispatch(entry); });
  }
  dispose() { this.stopped = true; }
}
