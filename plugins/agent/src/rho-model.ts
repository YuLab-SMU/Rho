import type { AgentAsset, AgentDraftContent, ComponentAgentConversation, ComponentAgentRun, ComponentAgentRunSummary, ComponentAgentEventPage, ComponentModelSettings, ComponentCredentialStatus } from '../sdk/index.js';
import type { NativeAgentModel } from './native-model.js';
import type { ProviderBinding } from '../public/plugin-protocol/index.js';
import { type Client, type Intent, json, same, terminal, inspectOriginal, verifyOriginal } from './operations.js';

import { ATTACHMENT_CHUNK_BYTES, attachmentChunk } from './uploads.js';
import { captureRhoFile, validateUpload, verifyRhoImported, type RhoPendingUpload, type RhoImported, type RhoUpload } from './rho-uploads.js';

interface Draft { content: AgentDraftContent; base: number; revision: number; dirty: boolean; conflict: AgentDraftContent | null; }
interface Pending { intent: Intent; task: string; kind: string; revision: number; draftVersion: number; status: string | null; run: string | null; consumed: boolean; }
export interface RhoState { selected: string | null; drafts: Record<string, Draft>; pending: Pending[]; uploads?: RhoPendingUpload[]; }
export interface RhoHistoryPage { conversation_id: string; runs: ComponentAgentRunSummary[]; next: string | null; }
interface History { before: string | null; page: RhoHistoryPage; }
interface Transcript { cursor: number; text: string; gap: boolean; partial: boolean; }
const empty = (): AgentDraftContent => ({ text: '', assets: [], context: [] });
export const rhoBusy = (state: string) => ['queued', 'running', 'waiting_for_r', 'waiting_for_permission', 'needs_input', 'stopping'].includes(state);
const known = ['create', 'draft', 'update', 'take_control', 'run', 'run.stop', 'run.reconcile'];

/** Ordinary Rho tasks share the public Agent owner and the view's CAS writer.
 * Persisted requests are recovery material; observations never invoke a model. */
export class RhoModel {
  readonly state: RhoState;
  readonly conversations = new Map<string, ComponentAgentConversation>();
  readonly assets = new Map<string, AgentAsset[]>();
  readonly runs = new Map<string, ComponentAgentRun>();
  readonly history = new Map<string, History>();
  readonly transcripts = new Map<string, Transcript>();
  settings: ComponentModelSettings | null = null;
  busy = false;
  private stopped = false;
  private observing = new Set<string>();
  private submissions = new Set<string>();
  constructor(private client: Client, private owner: NativeAgentModel, private changed = () => {}) {
    this.state = owner.state.rho ??= { selected: null, drafts: {}, pending: [] };
    for (const pending of this.uploads) {
      validateUpload(pending.upload);
      if (pending.view !== client.view.view || !same(pending.instance, client.view.instance) || !['uploading', 'finishing', 'imported'].includes(pending.phase))
        throw Error('A retained Rho attachment belongs to another task, view or instance.');
    }
    for (const pending of this.state.pending) {
      const intent = pending.intent, args = intent.arguments as unknown as { binding: unknown; arguments: { conversation_id?: string; request_id?: string }; preconditions: unknown };
      if (!known.includes(pending.kind) || intent.view !== client.view.view || intent.capability.id !== `agent.model.${pending.kind}` || intent.capability.version !== 1 ||
        !same(args.binding, this.binding(intent.capability.id)) || args.preconditions !== null ||
        !['run.stop', 'run.reconcile'].includes(pending.kind) && args.arguments.conversation_id !== pending.task || pending.kind === 'run' && args.arguments.request_id !== intent.request)
        throw Error('A retained Rho request belongs to another task, view or instance.');
    }
  }
  private live() { if (this.stopped) throw Error('The Agent view is closed. Original Rho records are retained.'); }
  private notify() { if (!this.stopped) this.changed(); }
  private binding(id: string) { return { provider: this.client.view.instance, project: this.client.view.project, capability: { id, version: 1 }, target: null }; }
  private async read<T>(id: string, args: unknown) { this.live(); const value = await this.owner.read<T>(id, args); this.live(); return value; }
  private async save() { this.live(); await this.owner.save(); this.live(); }
  canControl(task: string) {
    const controller = this.conversations.get(task)?.controller;
    return controller?.window_id === this.client.view.window && controller.incarnation === `view:${this.client.view.view}`;
  }
  draft(task: string) { return this.state.drafts[task]?.content ?? this.conversations.get(task)?.draft_content ?? empty(); }
  draftAwaitingRun(task: string) { return this.state.pending.some(p => p.task === task && p.kind === 'run' && !p.consumed); }
  edit(task: string, content: AgentDraftContent) {
    this.live(); const local = this.state.drafts[task];
    if (!local || !this.canControl(task) || this.conversations.get(task)?.archived) throw Error('This Rho task is read-only in this view.');
    local.content = structuredClone(content); local.revision++; local.dirty = true; this.notify();
  }
  private merge(value: ComponentAgentConversation) {
    const old = this.conversations.get(value.conversation_id);
    if (old && old.version > value.version) return;
    this.conversations.set(value.conversation_id, value);
    const local = this.state.drafts[value.conversation_id];
    if (!local || !local.dirty) this.state.drafts[value.conversation_id] = { content: structuredClone(value.draft_content), base: value.draft_version, revision: local?.revision ?? 0, dirty: false, conflict: null };
    else if (local.base !== value.draft_version && !this.state.pending.some(p => {
      if (p.task !== value.conversation_id || p.kind !== 'draft') return false;
      const args = (p.intent.arguments as unknown as { arguments: { draft_version: number; content: AgentDraftContent } }).arguments;
      return value.draft_version === args.draft_version + 1 && same(value.draft_content, args.content);
    })) local.conflict = structuredClone(value.draft_content);
  }
  async select(task: string) {
    this.state.selected = task; this.owner.state.selected = null; this.notify();
    await this.save(); await this.observe(task);
  }
  async create() {
    if (this.state.pending.some(p => p.kind === 'create')) throw Error('Inspect the original task creation before creating another task.');
    const task = crypto.randomUUID(); await this.issue('create', task, { conversation_id: task, profile: 'project' });
  }
  async refresh() {
    if (this.state.selected) await this.observe(this.state.selected);
    for (const pending of [...this.state.pending]) if (pending.intent.operation && pending.status !== 'uncertain') await this.inspect(pending.intent.request);
  }
  async observe(task: string) {
    if (this.observing.has(task)) return;
    // Creation is an Operation too. Until its receipt is inspected, keep the
    // recovery surface visible without assuming that the task already exists.
    if (!this.conversations.has(task) && this.state.pending.some(p => p.task === task && p.kind === 'create')) return;
    this.observing.add(task);
    try {
      this.settings = await this.read<ComponentModelSettings>('agent.model.settings', {});
      const before = this.history.get(task)?.before ?? null;
      const page = await this.read<RhoHistoryPage>('agent.model.history', { conversation_id: task, before, limit: 5 }); this.live();
      // A page selection made while a poll is in flight belongs to the next
      // observation. The older response must not select its page again.
      if ((this.history.get(task)?.before ?? null) !== before) return;
      if (page.conversation_id !== task || page.runs.length > 5 || page.runs.some(run => run.conversation_id !== task) ||
        page.next && (page.next === before || !page.runs.length || page.next !== page.runs.at(-1)?.run_id)) throw Error('The Rho history page changed identity or did not advance.');
      this.history.set(task, { before, page });
      let changed = false;
      for (const summary of page.runs) {
        const run = await this.read<ComponentAgentRun>('agent.model.run.get', { run_id: summary.run_id });
        if (run.run_id !== summary.run_id || run.request.conversation_id !== task) throw Error('The run belongs to another Rho task.');
        changed = this.mergeRun(run) || changed; await this.readEvents(run);
      }
      const conversation = await this.read<ComponentAgentConversation>('agent.model.conversation', { conversation_id: task });
      if (conversation.conversation_id !== task) throw Error('The observation belongs to another Rho task.');
      if (conversation.active_run_id && !page.runs.some(run => run.run_id === conversation.active_run_id)) {
        const run = await this.read<ComponentAgentRun>('agent.model.run.get', { run_id: conversation.active_run_id });
        if (run.run_id !== conversation.active_run_id || run.request.conversation_id !== task) throw Error('The active run belongs to another task.');
        changed = this.mergeRun(run) || changed;
      }
      this.merge(conversation); await this.readAssets(task); if (changed) await this.save(); this.trim();
    } finally { this.observing.delete(task); this.notify(); }
  }
  private mergeRun(run: ComponentAgentRun) {
    const old = this.runs.get(run.run_id);
    if (old && (old.updated_at_ms > run.updated_at_ms || old.event_cursor > run.event_cursor || !rhoBusy(old.state) && rhoBusy(run.state))) return false;
    this.runs.set(run.run_id, run);
    const pending = this.state.pending.find(p => p.kind === 'run' && p.intent.request === run.request.request_id);
    if (!pending) return false;
    const args = (pending.intent.arguments as unknown as { arguments: { text: string; assets?: string[]; sources?: AgentDraftContent['context']; continuation?: ComponentAgentRun['request']['continuation']; conversation_id: string; conversation_version: number; model_settings_version: number } }).arguments;
    if (run.request.conversation_id !== pending.task || run.request.text !== args.text || run.request.conversation_version !== args.conversation_version ||
      run.request.model_settings_version !== args.model_settings_version || !same(run.request.assets ?? [], args.assets ?? []) || !same(run.request.sources ?? [], args.sources ?? []) || !same(run.request.continuation ?? null, args.continuation ?? null) || run.request.window.window_id !== this.client.view.window || run.request.window.incarnation !== `view:${this.client.view.view}`)
      throw Error('The Rho run does not match its original Send.');
    pending.run = run.run_id;
    if (pending.consumed) return false;
    const local = this.state.drafts[pending.task];
    if (local && local.base === pending.draftVersion) {
      if (local.revision === pending.revision && same(local.content, { text: args.text, assets: args.assets ?? [], context: args.sources ?? [] })) { local.content = empty(); local.dirty = false; }
      local.base = pending.draftVersion + 1; local.conflict = null;
    }
    pending.consumed = true; return true;
  }
  private async readEvents(run: ComponentAgentRun) {
    const state = this.transcripts.get(run.run_id) ?? { cursor: 0, text: '', gap: false, partial: false };
    for (let count = 0; state.cursor < run.event_cursor && count < 10; count++) {
      const page = await this.read<ComponentAgentEventPage>('agent.model.run.events', { run_id: run.run_id, after: state.cursor, limit: 100 });
      if (!Number.isSafeInteger(page.cursor) || page.cursor < state.cursor || page.events.length > 100 ||
        page.events.some((event, index) => event.run_id !== run.run_id || event.sequence <= (index ? page.events[index - 1]!.sequence : state.cursor) || event.sequence > page.cursor))
        throw Error('The Rho event page does not match the original run.');
      state.gap ||= page.history_gap;
      for (const event of page.events) if (event.content.kind === 'text') state.text += event.content.text;
      if (state.text.length > 262144) { state.text = state.text.slice(-262144); state.partial = true; }
      const next = page.events.at(-1)?.sequence ?? page.cursor;
      if (next <= state.cursor) { state.gap = true; break; }
      state.cursor = next;
    }
    this.live(); this.transcripts.set(run.run_id, state);
  }
  private trim() {
    while (this.history.size > 8) {
      const id = [...this.history.keys()].find(id => id !== this.state.selected)!;
      this.history.delete(id);
    }
    for (const id of this.conversations.keys()) if (this.conversations.size > 32 && id !== this.state.selected && !this.state.drafts[id]?.dirty && !this.state.pending.some(p => p.task === id)) {
      this.conversations.delete(id); this.assets.delete(id); delete this.state.drafts[id];
    }
    const retained = new Set([...this.history.values()].flatMap(history => history.page.runs.map(run => run.run_id)));
    for (const task of this.conversations.values()) if (task.active_run_id) retained.add(task.active_run_id);
    for (const id of this.runs.keys()) if (!retained.has(id)) { this.runs.delete(id); this.transcripts.delete(id); }
  }
  async earlier(task: string) {
    const history = this.history.get(task); if (!history?.page.next) return;
    history.before = history.page.next; await this.observe(task);
  }
  async latest(task: string) { this.history.delete(task); await this.observe(task); }
  async flush(task: string) {
    const local = this.state.drafts[task]; if (!local?.dirty) return;
    if (this.draftAwaitingRun(task)) throw Error('Inspect the original Send before saving the next draft. Your local input is retained.');
    if (!this.canControl(task) || this.conversations.get(task)?.archived || local.conflict) throw Error('Resolve task control or the draft conflict before saving.');
    if (new TextEncoder().encode(local.content.text).length > 32768) throw Error('Messages are limited to 32 KiB. Your local draft is retained.');
    await this.issue('draft', task, { conversation_id: task, draft_version: local.base, content: structuredClone(local.content), grant: null }, local.revision);
  }
  async send(task: string, continueRun?: string) {
    this.live();
    if (this.submissions.has(task) || this.state.pending.some(p => p.task === task && p.kind === 'run')) throw Error('Inspect the original Send before submitting again.');
    this.submissions.add(task);
    try {
      if (this.draft(task).context.length + this.draft(task).assets.length > 16) throw Error('Rho tasks accept up to 16 context references and attachments. The draft is retained.');
      await this.flush(task);
      this.settings = await this.read<ComponentModelSettings>('agent.model.settings', {});
      if (!this.settings.enabled || !this.settings.connection) throw Error('Choose and enable a model in Settings before sending.');
      const credential = await this.read<ComponentCredentialStatus>('agent.model.key.status', { settings_version: this.settings.version });
      if (!credential.available || !same(credential.credential, this.settings.connection.credential)) throw Error('The configured model key is unavailable. Open Settings to replace it; your draft is retained.');
      const conversation = this.conversations.get(task), local = this.state.drafts[task];
      if (!conversation || !local || local.dirty || local.conflict || !this.canControl(task) || conversation.archived || conversation.active_run_id || (!local.content.text.trim() && !local.content.assets.length))
        throw Error('Confirm the saved draft and original task state before sending.');
      const revision = local.revision, content = structuredClone(local.content);
      let continuation: ComponentAgentRun['request']['continuation'], r: ProviderBinding | null = null, mode: 'run' | 'explain' | null = null;
      if (continueRun) {
        const previous = await this.read<ComponentAgentRun>('agent.model.run.get', { run_id: continueRun });
        if (previous.run_id !== continueRun || previous.request.conversation_id !== task || rhoBusy(previous.state) || !previous.recovery || previous.recovery.unresolved_mutations)
          throw Error('Check the original tool outcomes before Continue. Your draft is retained.');
        if (!['run', 'explain'].includes(previous.request.grant.mode)) throw Error('This task has no supported original tool selection.');
        const admission = await this.read<{ binding: ProviderBinding; r: ProviderBinding | null }>('agent.model.run.admission', { run_id: continueRun });
        if (!same(admission.binding, this.binding('agent.model.run')) || previous.request.grant.mode === 'run' && !admission.r)
          throw Error('The original task has a different native admission.');
        continuation = { run_id: continueRun, recovery_digest: previous.recovery.digest }; r = admission.r; mode = previous.request.grant.mode as 'run' | 'explain';
        const current = this.state.drafts[task];
        if (!current || current.revision !== revision || current.dirty || current.conflict || !same(current.content, content) || this.conversations.get(task)?.version !== conversation.version) throw Error('The draft changed while preparing Continue. Your input is retained.');
      }
      const request = crypto.randomUUID();
      await this.issue('run', task, { request_id: request, conversation_id: task, conversation_version: conversation.version,
        model_settings_version: this.settings.version, text: content.text, assets: content.assets.length ? content.assets : undefined, sources: content.context, continuation, r, mode }, revision, request);
    } finally { this.submissions.delete(task); }
  }
  get uploads() { return this.state.uploads ?? []; }
  private editable(task: string) {
    this.live();
    if (!this.canControl(task) || this.conversations.get(task)?.archived) throw Error('This Rho task is read-only in this view.');
  }
  private async readAssets(task: string) {
    const reply = await this.read<{ conversation_id: string; assets: AgentAsset[] }>('agent.model.assets', { conversation_id: task });
    if (reply.conversation_id !== task || !Array.isArray(reply.assets) || reply.assets.length > 64 || new Set(reply.assets.map(asset => asset.asset_id)).size !== reply.assets.length)
      throw Error('The attachment observation belongs to another Rho task or exceeds its limit.');
    this.assets.set(task, reply.assets); return reply;
  }
  async attachFile(task: string, file: Blob, name: string) {
    this.editable(task); if (this.busy) throw Error('Wait for the current Rho request.');
    if (this.uploads.length >= 16) throw Error('Resolve existing attachment transfers before selecting more files.');
    this.busy = true; this.notify();
    try {
      const capture = await captureRhoFile(file, name, task); this.editable(task);
      const pending: RhoPendingUpload = { upload: capture.upload, view: this.client.view.view, instance: this.client.view.instance, received: 0, phase: 'uploading' };
      (this.state.uploads ??= []).push(pending); await this.save();
      await this.transfer(pending, capture.blob); await this.addUploaded(pending.upload.request_id);
    } finally { this.busy = false; this.notify(); }
  }
  private async transfer(pending: RhoPendingUpload, blob: Blob) {
    const upload = pending.upload;
    const control = async <T>(id: string, arguments_: unknown) => {
      this.editable(upload.conversation_id);
      const result = await this.client.control<T>({ id, version: 1 }, json({ binding: this.binding(id), arguments: arguments_, preconditions: null }));
      this.live(); return result;
    };
    for (let offset = 0; offset < upload.bytes || offset === 0; offset += ATTACHMENT_CHUNK_BYTES) {
      const data = await attachmentChunk(blob, offset);
      const reply = await control<{ upload: RhoUpload; received: number; complete: boolean }>('agent.model.assets.stage', { upload, offset, data });
      if (!same(reply.upload, upload) || !Number.isSafeInteger(reply.received) || reply.received < Math.min(offset + ATTACHMENT_CHUNK_BYTES, upload.bytes) ||
        reply.received > upload.bytes || reply.complete !== (reply.received === upload.bytes)) throw Error('The attachment acknowledgement differs from the original file.');
      pending.received = reply.received; this.notify();
    }
    pending.phase = 'finishing'; await this.save();
    const reply = await control<RhoImported>('agent.model.assets.finish', { upload });
    const asset = verifyRhoImported(upload, reply);
    this.assets.set(upload.conversation_id, [...(this.assets.get(upload.conversation_id) ?? []).filter(a => a.asset_id !== asset.asset_id), asset]);
    pending.phase = 'imported'; await this.save();
  }
  async inspectUpload(request: string) {
    this.live(); const pending = this.uploads.find(p => p.upload.request_id === request);
    if (!pending) throw Error('The original attachment is no longer pending.');
    const reply = await this.readAssets(pending.upload.conversation_id);
    const asset = reply.assets.find(a => a.asset_id === request);
    if (!asset) throw Error('The original attachment is not imported. Reselect its original file to finish the transfer.');
    verifyRhoImported(pending.upload, { conversation_id: reply.conversation_id, asset });
    pending.phase = 'imported'; await this.save(); this.notify();
  }
  async resumeUpload(request: string, file: Blob, name: string) {
    this.live(); if (this.busy) throw Error('Wait for the current Rho request.');
    const pending = this.uploads.find(p => p.upload.request_id === request);
    if (!pending || pending.phase === 'imported') throw Error('Inspect or add the already imported attachment.');
    this.editable(pending.upload.conversation_id); this.busy = true; this.notify();
    try {
      const capture = await captureRhoFile(file, name, pending.upload.conversation_id, request);
      if (!same(capture.upload, pending.upload)) throw Error('Reselect the same filename, type and bytes as the original attachment.');
      await this.save(); await this.transfer(pending, capture.blob); await this.addUploaded(request);
    } finally { this.busy = false; this.notify(); }
  }
  async addUploaded(request: string) {
    this.live(); const pending = this.uploads.find(p => p.upload.request_id === request);
    if (!pending || pending.phase !== 'imported') throw Error('Inspect the original attachment before adding it.');
    const task = pending.upload.conversation_id, draft = this.draft(task);
    const assets = [...new Set([...draft.assets, request])];
    if (assets.length + draft.context.length > 16) throw Error('Select at most 16 attachments and context references for one Send.');
    this.edit(task, { ...draft, assets }); await this.save();
    this.state.uploads = this.uploads.filter(p => p !== pending); await this.save(); this.notify();
  }
  async stop(task: string) {
    const run = this.conversations.get(task)?.active_run_id;
    if (!this.canControl(task) || !run) throw Error('Read the original active run before stopping.');
    await this.issue('run.stop', task, { run_id: run });
  }
  async reconcile(task: string, id: string) {
    const conversation = this.conversations.get(task), run = this.runs.get(id);
    if (!conversation || !this.canControl(task) || conversation.active_run_id || !run || run.request.conversation_id !== task || rhoBusy(run.state))
      throw Error('Read the original finished run and take control before checking tool outcomes.');
    await this.issue('run.reconcile', task, { run_id: id, conversation_version: conversation.version });
    await this.observe(task);
  }
  async takeOver(task: string) { const c = this.conversations.get(task); if (!c) throw Error('Read the task before taking control.'); await this.issue('take_control', task, { conversation_id: task, expected_version: c.version }); }
  async rename(task: string, title: string) { return this.update(task, { title }); }
  async archive(task: string, archived: boolean) { return this.update(task, { archived }); }
  private async update(task: string, changes: { title?: string; archived?: boolean }) {
    const c = this.conversations.get(task); if (!c || !this.canControl(task)) throw Error('Take control before changing the task.');
    await this.issue('update', task, { conversation_id: task, expected_version: c.version, ...changes });
  }
  async resolveDraft(task: string, keep: boolean) {
    const draft = this.state.drafts[task], current = this.conversations.get(task);
    if (!draft?.conflict || !current) throw Error('There is no draft conflict to resolve.');
    if (!keep) draft.content = structuredClone(current.draft_content);
    draft.base = current.draft_version; draft.dirty = keep; draft.conflict = null; draft.revision++; await this.save(); this.notify();
  }
  private async issue(kind: string, task: string, args: unknown, revision = 0, request = crypto.randomUUID()) {
    this.live(); if (this.busy || this.state.pending.some(p => p.task === task && p.kind === kind)) throw Error('Inspect the original Rho request before repeating this action.');
    if (this.state.pending.length >= 16) throw Error('Resolve retained Rho requests before starting more work.');
    this.busy = true; this.notify(); const capability = { id: `agent.model.${kind}`, version: 1 };
    const pending: Pending = { task, kind, revision, draftVersion: this.state.drafts[task]?.base ?? 0, status: null, run: null, consumed: false,
      intent: { view: this.client.view.view, request, capability, arguments: json({ binding: this.binding(capability.id), arguments: args, preconditions: null }), operation: null } };
    this.state.pending.push(pending);
    if (kind === 'create') { this.state.selected = task; this.owner.state.selected = null; }
    try {
      await this.save(); await this.accept(pending, await this.client.invoke(capability, pending.intent.arguments, { requestId: request }));
      const deadline = Date.now() + 8000;
      while (kind !== 'run' && this.state.pending.includes(pending) && pending.status && !terminal(pending.status) && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 150)); await this.inspect(request);
      }
    }
    finally { this.busy = false; this.notify(); }
  }
  async inspect(request: string) { const pending = this.original(request); await this.accept(pending, await inspectOriginal(this.client, pending.intent)); this.notify(); }
  async retry(request: string) {
    this.live(); const pending = this.original(request); if (this.busy || pending.intent.operation) throw Error('Inspect the already accepted original request.');
    this.busy = true;
    try { await this.save(); await this.accept(pending, await this.client.invoke(pending.intent.capability, pending.intent.arguments, { requestId: request })); }
    finally { this.busy = false; this.notify(); }
  }
  private original(request: string) { this.live(); const pending = this.state.pending.find(p => p.intent.request === request); if (!pending) throw Error('The original Rho request is no longer pending.'); return pending; }
  private async accept(pending: Pending, result: unknown) {
    const record = await verifyOriginal(result, pending.intent); this.live(); if (!this.state.pending.includes(pending)) return;
    if (terminal(pending.status ?? '') && !terminal(record.status)) return;
    const changed = pending.status !== record.status || pending.intent.operation !== record.operation.operation_id;
    pending.status = record.status; pending.intent.operation = record.operation.operation_id;
    // The public Operation may be accepted before the Agent owner has admitted
    // a run. Save that identity first; no Run is required at this stage.
    if (changed) await this.save();
    if (pending.kind === 'run' && !['accepted', 'failed', 'cancelled', 'uncertain'].includes(record.status)) {
      const run = record.status === 'succeeded' ? record.output as ComponentAgentRun : await this.read<ComponentAgentRun>('agent.model.run.request', { request_id: pending.intent.request });
      if (run?.request?.request_id !== pending.intent.request || !run.run_id) throw Error('The run belongs to another original Send.');
      this.mergeRun(run);
    } else if (record.status === 'succeeded' && ['run.stop', 'run.reconcile'].includes(pending.kind)) {
      const run = record.output as ComponentAgentRun, expected = (pending.intent.arguments as unknown as { arguments: { run_id: string } }).arguments;
      if (run?.run_id !== expected.run_id || run.request.conversation_id !== pending.task) throw Error('The original tool result belongs to another run.');
      if (pending.kind === 'run.reconcile' && (!run.recovery || rhoBusy(run.state) || !Array.isArray(run.recovery.tools) || run.recovery.tools.length > 16 || !run.recovery.digest))
        throw Error('The original recovery report is incomplete.');
      this.mergeRun(run);
    } else if (record.status === 'succeeded') {
      const conversation = record.output as ComponentAgentConversation;
      if (conversation?.conversation_id !== pending.task) throw Error('The Rho receipt belongs to another task.');
      const args = (pending.intent.arguments as unknown as { arguments: { profile?: string; expected_version?: number; title?: string; archived?: boolean } }).arguments;
      if (pending.kind === 'create' && (conversation.profile !== args.profile || conversation.archived || conversation.version < 1) ||
        ['create', 'take_control'].includes(pending.kind) && (conversation.controller.window_id !== this.client.view.window || conversation.controller.incarnation !== `view:${this.client.view.view}`) ||
        args.expected_version !== undefined && conversation.version <= args.expected_version ||
        args.title !== undefined && conversation.title !== args.title.trim() || args.archived !== undefined && conversation.archived !== args.archived)
        throw Error('The Rho task result does not match the original action.');
      if (pending.kind === 'draft') {
        const args = (pending.intent.arguments as unknown as { arguments: { content: AgentDraftContent; draft_version: number } }).arguments;
        if (conversation.draft_version !== args.draft_version + 1 || !same(conversation.draft_content, args.content)) throw Error('The original Rho draft save is incomplete.');
        const local = this.state.drafts[pending.task];
        const current = this.conversations.get(pending.task);
        if (local && local.base === args.draft_version && (!current || current.version <= conversation.version)) {
          local.base = conversation.draft_version; local.conflict = null; if (local.revision === pending.revision) local.dirty = false;
        }
      }
      this.merge(conversation);
      if (pending.kind === 'create') { this.state.selected = pending.task; this.owner.state.selected = null; }
    }
    if (terminal(record.status) && record.status !== 'uncertain') this.state.pending = this.state.pending.filter(p => p !== pending);
    if (changed || terminal(record.status) || pending.consumed) await this.save();
    if (record.status === 'failed' || record.status === 'cancelled') throw Error(record.error || 'The original Rho request did not succeed.');
  }
  dispose() { this.stopped = true; }
}
