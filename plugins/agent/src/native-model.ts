import type { AgentDraftContent, AgentTaskCommand, AgentTaskCommandResult, AgentTaskDetail,
  AgentNativeToolSelection, AgentProvider, LocalAgent, ProjectAgentTaskPage, AgentCommandReceipt } from '../sdk/index.js';
import { NativeHistory } from './history.js';
import type { ModelSettingsState } from './model-settings.js';
import type { RhoState } from './rho-model.js';
import type { HandoffState } from './handoff-model.js';
import { captureFile, attachmentChunk, verifyProgress, verifyUploaded, ATTACHMENT_CHUNK_BYTES, type PendingUpload, type UploadProgress } from './uploads.js';
import { type Client, type Intent, type RecordReply, json, same, terminal, verifyOriginal, inspectOriginal } from './operations.js';

type Command = Exclude<AgentTaskCommand, { kind: 'add_asset' }>;
interface LocalDraft { content: AgentDraftContent; base: number; revision: number; dirty: boolean; conflict: AgentDraftContent | null; }
interface Pending { intent: Intent; task: string | null; kind: Command['kind'] | 'discover'; draftRevision: number | null; status: string | null; }
interface Saved { schema: 1; selected: string | null; archived: boolean; drafts: Record<string, LocalDraft>; pending: Pending[]; tools: AgentNativeToolSelection[]; catalogs: Partial<Record<AgentProvider, LocalAgent>>; uploads?: PendingUpload[]; settings?: ModelSettingsState; rho?: RhoState; handoffs?: HandoffState; studioRequestApplied?: {request: string; task: string}; componentRequestApplied?: {request: string; target: import('../sdk/index.js').ProjectAgentTaskRef}; }
const empty = (): AgentDraftContent => ({ text: '', assets: [], context: [] });
export const agentBusy = (state: string) => ['running', 'waiting_for_permission', 'connecting', 'resuming', 'stopping', 'queued', 'waiting_for_r', 'needs_input'].includes(state);

/** A view model for the ordinary Agent instance. Backend records own tasks and
 * drafts. View state retains local edits and original requests, never execution
 * authority. Reading/reopening does not dispatch or reconnect a native Agent. */
export class NativeAgentModel {
  readonly state: Saved;
  page: ProjectAgentTaskPage | null = null;
  readonly details = new Map<string, AgentTaskDetail>();
  readonly history = new NativeHistory(<T>(id: string, args: unknown) => this.read<T>(id, args), () => this.notify());
  readonly events = this.history.events;
  private taskCursors: (string | null)[] = [null];
  private taskRead = 0;
  taskLoading = false;
  private writes: Promise<unknown> = Promise.resolve();
  private admission = false;
  private stopped = false;
  private persisted = false;
  error = '';
  constructor(private client: Client, private changed = () => {}) {
    const saved = client.view.state as unknown as Partial<Saved>;
    if (Object.keys(saved).length && (saved.schema !== 1 || !saved.drafts || !Array.isArray(saved.pending) || !Array.isArray(saved.tools)))
      throw Error('The saved Agent view has an unsupported state. Its contents were retained.');
    this.state = saved.schema === 1 ? structuredClone(saved as Saved) : { schema: 1, selected: null, archived: false, drafts: {}, pending: [], tools: [], catalogs: {} };
    for (const pending of this.state.uploads ?? []) {
      if (pending.view !== client.view.view || !same(pending.instance, client.view.instance))
        throw Error('A retained attachment belongs to another Agent view or instance.');
    }
    for (const pending of this.state.pending) {
      const original = pending.intent, args = original.arguments as unknown as { binding: unknown; arguments: { request_id?: string }; preconditions: unknown };
      if (original.view !== client.view.view || original.capability.version !== 1 ||
        original.capability.id !== (pending.kind === 'discover' ? 'agent.native.discover' : 'agent.native.command') ||
        !same(args.binding, this.binding(original.capability.id)) || args.preconditions !== null ||
        pending.kind !== 'discover' && args.arguments.request_id !== original.request)
        throw Error('A retained request belongs to another Agent view or instance.');
    }
  }
  get busy() { return this.admission; }
  get uploads() { return this.state.uploads ?? []; }
  private live() { if (this.stopped) throw Error('The Agent view is closed. Accepted work is retained.'); }
  private notify() { if (!this.stopped) this.changed(); }
  private binding(id: string) { return { provider: this.client.view.instance, project: this.client.view.project, capability: { id, version: 1 }, target: null }; }
  async read<T>(id: string, args: unknown): Promise<T> {
    this.live();
    const result = await this.client.query<{ status: string; completeness?: string; data?: T; notices?: string[] }>({ id, version: 1 }, json({ binding: this.binding(id), arguments: args, preconditions: null }));
    this.live();
    if (result.status !== 'ready' || result.completeness && result.completeness !== 'complete' || !result.data)
      throw Error(result.notices?.join('\n') || 'The Agent observation is unavailable.');
    return result.data;
  }
  async save() {
    this.live();
    // Serialize native CAS writes; capture when this save actually starts so an
    // older acknowledgement cannot replace more recent in-memory user input.
    const write = this.writes.then(async () => {
      this.live(); const value = structuredClone(this.state);
      value.drafts = Object.fromEntries(Object.entries(value.drafts).filter(([id, draft]) => draft.dirty || id === value.selected || value.pending.some(p => p.task === id)));
      if (value.rho) value.rho.drafts = Object.fromEntries(Object.entries(value.rho.drafts).filter(([id, draft]) => draft.dirty || id === value.rho!.selected || value.rho!.pending.some(p => p.task === id)));
      const original = this.client.view;
      const confirmed = await this.client.setState(json(value));
      if (confirmed.view !== original.view || !same(confirmed.instance, original.instance) || !same(confirmed.state, value))
        throw Error('The saved Agent view state was not confirmed.');
      this.persisted = true;
    });
    this.writes = write.catch(() => { this.persisted = false; });
    return write;
  }
  async refresh() {
    await this.readTasks();
    if (this.state.selected) await this.observe(this.state.selected);
    this.notify();
  }
  get newerTasksAvailable() { return this.taskCursors.length > 1; }
  private async readTasks(cursors = this.taskCursors) {
    if (this.taskLoading) return;
    const token = ++this.taskRead, archived = this.state.archived, before = cursors.at(-1)!;
    this.taskLoading = true; this.notify();
    try {
      const page = await this.read<ProjectAgentTaskPage>('agent.tasks', { archived, before, limit: 20 });
      if (token !== this.taskRead || archived !== this.state.archived) return;
      if (page.tasks.length > 20 || page.tasks.some(task => task.archived !== archived) || page.next && cursors.includes(page.next))
        throw Error('The task list no longer matches this page. Refresh the task list.');
      this.page = page; this.taskCursors = cursors;
    } finally { if (token === this.taskRead) { this.taskLoading = false; this.notify(); } }
  }
  async olderTasks() {
    if (this.taskLoading || !this.page?.next) throw Error('There is no next task page ready.');
    await this.readTasks([...this.taskCursors, this.page.next]);
  }
  async newerTasks() {
    if (this.taskLoading || !this.newerTasksAvailable) throw Error('There is no newer task page ready.');
    await this.readTasks(this.taskCursors.slice(0, -1));
  }
  async setArchived(archived: boolean) {
    this.state.archived = archived; this.taskRead++; this.taskLoading = false;
    this.taskCursors = [null]; this.page = null; await this.save(); await this.readTasks();
  }
  async select(task: string) {
    if (this.state.rho) this.state.rho.selected = null;
    this.live(); this.state.selected = task; this.notify();
    await this.save(); await this.observe(task); this.notify();
  }
  canControl(task: string) {
    const attachment = this.details.get(task)?.summary.attachment;
    return !!attachment && !attachment.control_frozen && attachment.controller.window_id === this.client.view.window &&
      attachment.controller.incarnation === `view:${this.client.view.view}`;
  }
  draft(task: string) { return this.state.drafts[task]?.content ?? this.details.get(task)?.draft.content ?? empty(); }
  edit(task: string, content: AgentDraftContent) {
    this.live(); if (!this.canControl(task)) throw Error('This task is read-only in this view.');
    if (this.details.get(task)?.summary.task.archived) throw Error('Unarchive this task before editing its draft.');
    const local = this.state.drafts[task];
    if (!local) throw Error('Read this task before editing its draft.');
    local.content = structuredClone(content); local.revision++; local.dirty = true; this.notify();
  }
  private merge(detail: AgentTaskDetail) {
    const task = detail.summary.task.task_id, previous = this.details.get(task);
    if (previous && previous.summary.observation_version > detail.summary.observation_version) return;
    this.details.set(task, detail);
    const local = this.state.drafts[task];
    if (!local || !local.dirty) this.state.drafts[task] = { content: structuredClone(detail.draft.content), base: detail.draft.version, revision: local?.revision ?? 0, dirty: false, conflict: null };
    else if (detail.draft.version !== local.base && !this.state.pending.some(p => p.task === task && p.kind === 'save_draft')) {
      // A confirmed original Send may clear exactly its submitted draft. Keep
      // any text typed later, and move only its native CAS base forward.
      const sent = this.state.pending.find(p => p.task === task && p.kind === 'send' && detail.receipts.some(r =>
        r.request_id === p.intent.request && r.submitted_draft_version === local.base && ['submitted', 'succeeded'].includes(r.status)));
      if (sent && detail.draft.version === local.base + 1 && same(detail.draft.content, empty())) local.base = detail.draft.version;
      else local.conflict = structuredClone(detail.draft.content);
    }
  }
  async observe(task: string) {
    const detail = await this.read<AgentTaskDetail>('agent.native.task', { task_id: task });
    if (detail.summary.task.task_id !== task) throw Error('The Agent returned a different task.');
    this.merge(detail);
    await this.history.observe(this.details.get(task)!); this.notify();
  }
  private control(task: string) {
    if (!this.canControl(task)) throw Error('Take control of this task before changing it.');
    return { task_id: task, generation: this.details.get(task)!.summary.attachment.generation };
  }
  async create(provider: AgentProvider, model: string, effort: string | null) {
    if (!model.trim()) throw Error('Select an available model first.');
    return this.command({ kind: 'create', provider, model, effort }, null);
  }
  async discover(provider: AgentProvider) {
    await this.admit('agent.native.discover', { provider, model: this.state.catalogs[provider]?.selected_model ?? null }, 'discover', null);
    return this.state.catalogs[provider];
  }
  async newTask(provider: AgentProvider) {
    const catalog = await this.discover(provider);
    if (!catalog || this.state.pending.some(p => p.kind === 'discover')) throw Error('Model discovery is still pending. Inspect its original request.');
    if (catalog.error || !catalog.selected_model) throw Error(catalog.error || 'The Agent returned no selected model.');
    await this.create(provider, catalog.selected_model, catalog.selected_effort);
  }
  async flush(task: string) {
    const draft = this.state.drafts[task];
    if (!draft?.dirty) return;
    if (new TextEncoder().encode(draft.content.text).length > 32768)
      throw Error('Messages are limited to 32 KiB. Shorten this draft before sending; your local text is retained.');
    if (draft.conflict) throw Error('Keep or replace the conflicting draft before sending.');
    if (this.state.pending.some(p => p.task === task && p.kind === 'save_draft')) throw Error('Inspect the original draft save before continuing.');
    await this.command({ kind: 'save_draft', control: this.control(task), version: draft.base, content: structuredClone(draft.content) }, task, draft.revision);
  }
  async send(task: string) {
    if (agentBusy(this.details.get(task)?.summary.attachment.state ?? '') || this.state.pending.some(p => p.task === task && p.kind === 'send'))
      throw Error('The original turn is still running or unconfirmed.');
    await this.flush(task);
    const draft = this.state.drafts[task];
    if (!draft || draft.dirty || draft.conflict) throw Error('Confirm the saved draft before sending.');
    await this.command({ kind: 'send', control: this.control(task), draft_version: draft.base }, task);
  }
  async stop(task: string) { return this.command({ kind: 'stop', control: this.control(task) }, task); }
  async resume(task: string) { return this.command({ kind: 'resume', control: this.control(task) }, task); }
  async takeOver(task: string, stop: boolean) {
    const detail = this.details.get(task); if (!detail) throw Error('Read this task before taking control.');
    return this.command({ kind: 'take_over', control: { task_id: task, generation: detail.summary.attachment.generation }, stop }, task);
  }
  async decide(task: string, decision: number, option: string) { return this.command({ kind: 'decision', control: this.control(task), decision_id: decision, option_id: option }, task); }
  async configure(task: string, model: string, effort: string | null, mode: string | null) { return this.command({ kind: 'configure', control: this.control(task), model, effort, mode }, task); }
  async rename(task: string, title: string) { return this.command({ kind: 'rename', control: this.control(task), title }, task); }
  async archive(task: string, archived: boolean) { return this.command({ kind: 'archive', control: this.control(task), archived }, task); }
  async resolveDraft(task: string, keepLocal: boolean) {
    const local = this.state.drafts[task], detail = this.details.get(task);
    if (!local?.conflict || !detail) throw Error('There is no observed draft conflict.');
    if (!keepLocal) local.content = structuredClone(detail.draft.content);
    local.base = detail.draft.version; local.dirty = keepLocal; local.conflict = null; local.revision++;
    await this.save(); this.notify();
  }
  async attachFile(task: string, file: Blob, name: string) {
    this.live(); if (this.admission) throw Error('Wait for the current Agent request.');
    if (this.uploads.length >= 16) throw Error('Resolve existing attachment transfers before selecting more files.');
    this.admission = true; this.notify();
    try {
      const capture = await captureFile(file, name, this.control(task)); this.live();
      const pending: PendingUpload = { upload: capture.upload, view: this.client.view.view, instance: this.client.view.instance, received: 0, phase: 'uploading' };
      (this.state.uploads ??= []).push(pending);
      await this.save();
      await this.transfer(pending, capture.blob);
      await this.addUploaded(pending.upload.request_id);
    } finally { this.admission = false; this.notify(); }
  }
  private async uploadControl<T>(id: string, args: unknown): Promise<T> {
    this.live();
    const result = await this.client.control<T>({ id, version: 1 }, json({ binding: this.binding(id), arguments: args, preconditions: null }));
    this.live(); return result;
  }
  private async transfer(pending: PendingUpload, blob: Blob) {
    const upload = pending.upload;
    // Retrying a reselected immutable file uses the same complete descriptor.
    // Chunks may repeat; finish is still one owner request, never a model turn.
    for (let offset = 0; offset < upload.bytes || offset === 0; offset += ATTACHMENT_CHUNK_BYTES) {
      const data = await attachmentChunk(blob, offset);
      const reply = await this.uploadControl<UploadProgress>('agent.native.assets.stage', { upload, offset, data });
      verifyProgress(reply, upload, Math.min(offset + ATTACHMENT_CHUNK_BYTES, upload.bytes));
      pending.received = reply.received; this.notify();
    }
    pending.phase = 'finishing'; await this.save();
    const result = await this.uploadControl<AgentTaskCommandResult>('agent.native.assets.finish', { upload });
    verifyUploaded(upload, result); pending.phase = 'imported'; this.merge(result.detail); await this.save();
  }
  async inspectUpload(request: string) {
    this.live(); const pending = this.uploads.find(p => p.upload.request_id === request);
    if (!pending) throw Error('The original attachment is no longer pending.');
    const receipt = await this.read<AgentCommandReceipt>('agent.native.receipt', { request_id: request });
    await this.observe(pending.upload.control.task_id);
    verifyUploaded(pending.upload, { receipt, detail: this.details.get(pending.upload.control.task_id)! });
    pending.phase = 'imported'; await this.save(); this.notify();
    // Inspection never selects an attachment into the draft or sends it.
  }
  async resumeUpload(request: string, file: Blob, name: string) {
    this.live(); if (this.admission) throw Error('Wait for the current Agent request.');
    const pending = this.uploads.find(p => p.upload.request_id === request);
    if (!pending || pending.phase === 'imported') throw Error('Inspect or add the already imported attachment.');
    this.admission = true; this.notify();
    try {
      const capture = await captureFile(file, name, pending.upload.control, request);
      if (!same(capture.upload, pending.upload)) throw Error('Reselect the same filename, type and bytes as the original attachment.');
      await this.save(); await this.transfer(pending, capture.blob); await this.addUploaded(request);
    } finally { this.admission = false; this.notify(); }
  }
  async addUploaded(request: string) {
    this.live(); const pending = this.uploads.find(p => p.upload.request_id === request);
    if (!pending || pending.phase !== 'imported') throw Error('Inspect the original attachment before adding it.');
    const task = pending.upload.control.task_id, draft = this.draft(task);
    this.edit(task, { ...draft, assets: [...new Set([...draft.assets, request])] });
    // Retain the imported intent until the selected draft is confirmed saved
    // in this view. A lost acknowledgement can be re-inspected without upload.
    await this.save(); this.state.uploads = this.uploads.filter(p => p !== pending); await this.save(); this.notify();
  }
  private async command(command: Command, task: string | null, revision: number | null = null) {
    const request = crypto.randomUUID();
    return this.admit('agent.native.command', { request_id: request, command, tools: command.kind === 'send' ? structuredClone(this.state.tools) : [] }, command.kind, task, revision, request);
  }
  private async admit(id: string, args: unknown, kind: Pending['kind'], task: string | null, revision: number | null = null, request = crypto.randomUUID()) {
    this.live(); if (this.admission) throw Error('Wait for the current Agent request.');
    if (this.state.pending.some(p => p.task === task && p.kind === kind)) throw Error('Inspect the original request before repeating this action.');
    if (this.state.pending.length >= 32) throw Error('Inspect retained requests before starting more Agent work.');
    this.admission = true; this.error = ''; this.notify();
    const capability = { id, version: 1 };
    const pending: Pending = { task, kind, draftRevision: revision, status: null,
      intent: { view: this.client.view.view, request, capability, operation: null,
        arguments: json({ binding: this.binding(id), arguments: args, preconditions: null }) } };
    this.state.pending.push(pending);
    try {
      await this.save();
      if (!this.persisted) throw Error('The original request has not been saved.');
      await this.accept(pending, await this.client.invoke(capability, pending.intent.arguments, { requestId: request }));
      // Metadata commands normally settle promptly. Keep the original request
      // observable if they do not; long native turns do not lock the composer.
      const deadline = Date.now() + (kind === 'discover' ? 35000 : 8000);
      while (kind !== 'send' && this.state.pending.includes(pending) && pending.status && !terminal(pending.status) && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 150));
        await this.inspect(request);
      }
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { this.admission = false; this.notify(); }
  }
  async inspect(request: string) {
    this.live(); const pending = this.state.pending.find(p => p.intent.request === request);
    if (!pending) throw Error('The original request is no longer pending.');
    await this.accept(pending, await inspectOriginal(this.client, pending.intent)); this.notify();
  }
  async continueOriginal(request: string) {
    this.live(); if (this.admission) throw Error('Wait for the current Agent request.');
    const pending = this.state.pending.find(p => p.intent.request === request);
    if (!pending || pending.intent.operation) throw Error('Inspect the already accepted original request.');
    this.admission = true;
    try {
      await this.save();
      await this.accept(pending, await this.client.invoke(pending.intent.capability, pending.intent.arguments, { requestId: pending.intent.request }));
    } finally { this.admission = false; this.notify(); }
  }
  private async accept(pending: Pending, value: unknown) {
    const record: RecordReply = await verifyOriginal(value, pending.intent); this.live();
    if (!this.state.pending.includes(pending) || terminal(pending.status ?? '') && !terminal(record.status)) return;
    const changed = pending.intent.operation !== record.operation.operation_id || pending.status !== record.status;
    pending.intent.operation = record.operation.operation_id; pending.status = record.status;
    if (record.status === 'succeeded' && pending.kind === 'discover') {
      const catalog = record.output as LocalAgent;
      const selected = (pending.intent.arguments as unknown as { arguments: { provider: AgentProvider } }).arguments.provider;
      if (catalog?.provider !== selected || !Array.isArray(catalog.models)) throw Error('The model catalog belongs to another Agent.');
      this.state.catalogs[selected] = structuredClone(catalog);
      this.state.pending = this.state.pending.filter(p => p !== pending);
    } else if (record.status === 'succeeded') {
      const result = record.output as AgentTaskCommandResult;
      if (result?.receipt?.request_id !== pending.intent.request || result.receipt.command !== pending.kind ||
        result.receipt.status !== 'succeeded' || pending.task !== null && result.receipt.task_id !== pending.task || result.detail?.summary.task.task_id !== result.receipt.task_id)
        throw Error('The Agent receipt does not match its original task.');
      const task = result.receipt.task_id, local = this.state.drafts[task];
      if (pending.kind === 'save_draft' && local) {
        const submitted = (pending.intent.arguments as unknown as { arguments: { command: { content: AgentDraftContent; version: number } } }).arguments.command;
        if (result.detail.draft.version < submitted.version + 1 || !same(result.detail.draft.content, submitted.content))
          throw Error('The original draft acknowledgement is incomplete.');
        if (local.base <= result.detail.draft.version) {
          local.base = result.detail.draft.version; local.conflict = null;
          if (local.revision === pending.draftRevision) local.dirty = false;
        }
      }
      // A later observation can arrive before the original reply. Remove the
      // pending-save fence before merging it, so conflicts are not suppressed
      // and a stale receipt cannot roll the native CAS base backwards.
      const latest = this.details.get(task);
      this.state.pending = this.state.pending.filter(p => p !== pending);
      this.merge(latest && latest.summary.observation_version > result.detail.summary.observation_version ? latest : result.detail);
      if (pending.kind === 'create') { this.state.selected = task; if (this.state.rho) this.state.rho.selected = null; }
    } else if (terminal(record.status) && record.status !== 'uncertain') {
      this.state.pending = this.state.pending.filter(p => p !== pending);
      this.error = record.error || `The original ${pending.kind} request ${record.status}.`;
    }
    if (changed || terminal(record.status)) await this.save();
    if (record.status === 'failed' || record.status === 'cancelled') throw Error(this.error);
  }
  dispose() { this.stopped = true; }
}
