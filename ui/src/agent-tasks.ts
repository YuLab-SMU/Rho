import { Model, immutable, readonlyMap } from "./shared/model";
import { message } from "./shared/ports";
import type { AgentTaskPorts, AgentAssetPreview } from "./agent-task-ports";
import type { AgentTaskSummary } from "./generated/AgentTaskSummary";
import type { AgentTaskDetail } from "./generated/AgentTaskDetail";
import type { AgentTaskEvent } from "./generated/AgentTaskEvent";
import type { AgentDraftContent } from "./generated/AgentDraftContent";
import type { AgentTaskCommand } from "./generated/AgentTaskCommand";
import type { AgentTaskQuery } from "./generated/AgentTaskQuery";
import type { AgentTaskCommandResult } from "./generated/AgentTaskCommandResult";
import type { AgentCommandReceipt } from "./generated/AgentCommandReceipt";
import type { AgentProvider } from "./generated/AgentProvider";
import type { LocalAgent } from "./generated/LocalAgent";
import type { AgentContextSelection } from "./generated/AgentContextSelection";
import type { AgentContextItem } from "./generated/AgentContextItem";
import type { AgentContextSource } from "./generated/AgentContextSource";
import type { AgentContextPreview } from "./generated/AgentContextPreview";

export const agentBusy = (state: string) => ["running", "waiting_for_permission", "connecting", "resuming", "stopping"].includes(state);
const emptyDraft = (): AgentDraftContent => ({ text: "", assets: [], context: [] });
const clone = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
interface LocalDraft {
  content: AgentDraftContent; baseVersion: number; revision: number; dirty: boolean;
  conflict: AgentDraftContent | null;
}
interface Pending {
  requestId: string; taskId: string | null; kind: AgentTaskCommand["kind"];
  localRevision: number; content: AgentDraftContent | null;
}
interface ReadingPosition { scrollTop: number; following: boolean }
interface AgentTaskSnapshot {
  tasks: readonly AgentTaskSummary[]; attention: readonly AgentTaskSummary[]; selected: string | null; archived: boolean; next: string | null;
  details: ReadonlyMap<string, AgentTaskDetail>; drafts: ReadonlyMap<string, Readonly<LocalDraft>>;
  events: ReadonlyMap<string, readonly AgentTaskEvent[]>; pending: readonly Pending[];
  catalogs: Readonly<Partial<Record<AgentProvider, LocalAgent>>>;
  running: number; permissions: number; loading: boolean; error: string; creating: boolean;
  sources: readonly AgentContextSource[]; contextItems: readonly AgentContextItem[];
  contextNotices: readonly string[]; contextPreview: AgentContextPreview | null; contextLoading: boolean;
  previews: ReadonlyMap<string, AgentAssetPreview>; historyGap: ReadonlyMap<string, boolean>; earlier: ReadonlyMap<string, boolean>;
}

/** Persistent task client, independent of R-session and panel lifetime. */
export class AgentTasks extends Model<AgentTaskSnapshot> {
  private tasks: AgentTaskSummary[] = [];
  private attention: readonly AgentTaskSummary[] = [];
  private selected: string | null = null;
  private archived = false;
  private next: string | null = null;
  private details = new Map<string, AgentTaskDetail>();
  private drafts = new Map<string, LocalDraft>();
  private events = new Map<string, readonly AgentTaskEvent[]>();
  private cursors = new Map<string, number>();
  private historyGap = new Map<string, boolean>();
  private earlier = new Map<string, boolean>();
  private eventSizes = new Map<string, number>();
  private nativeHistoryDone = new Set<string>();
  private historyEpochs = new Map<string, number>();
  private extendedList = false;
  private nativeCursors = new Map<string, string | null>();
  private pending = new Map<string, Pending>();
  private reading = new Map<string, ReadingPosition>();
  private catalogs: Partial<Record<AgentProvider, LocalAgent>> = {};
  private preferred: Partial<Record<AgentProvider, string>> = {};
  private running = 0; private permissions = 0; private error = "";
  private visible = new Set<string>(); private activeViews: ReadonlySet<string> | null = null; private generation = 0; private stopped = false;
  private summaryFlight = false; private eventFlight = false;
  private creating = false; private saving = new Set<string>();
  private saveFlights = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sources: AgentContextSource[] = []; private contextItems: AgentContextItem[] = [];
  private contextNotices: string[] = []; private contextPreview: AgentContextPreview | null = null;
  private contextLoading = false; private contextGeneration = 0;
  private previews = new Map<string, AgentAssetPreview>(); private assetFlights = new Set<string>();
  constructor(private ports: AgentTaskPorts) { super(); }
  protected readSnapshot(): AgentTaskSnapshot {
    return { tasks: Object.freeze([...this.tasks]), attention: this.attention, selected: this.selected, archived: this.archived, next: this.next,
      details: readonlyMap(this.details), drafts: readonlyMap(new Map([...this.drafts].map(([id, d]) => [id, immutable(clone(d))]))),
      events: readonlyMap(this.events), pending: immutable(clone([...this.pending.values()])), catalogs: Object.freeze({ ...this.catalogs }),
      running: this.running, permissions: this.permissions, loading: this.summaryFlight, error: this.error, creating: this.creating,
      sources: Object.freeze([...this.sources]), contextItems: Object.freeze([...this.contextItems]), contextNotices: Object.freeze([...this.contextNotices]),
      contextPreview: this.contextPreview, contextLoading: this.contextLoading, previews: readonlyMap(this.previews), historyGap: readonlyMap(this.historyGap), earlier: readonlyMap(this.earlier) };
  }
  private guard(project: string | null, generation: number) { return !this.stopped && generation === this.generation && project === this.ports.context().project; }
  private async query(query: AgentTaskQuery) {
    const project = this.ports.context().project;
    if (!project) throw new Error("Open a project first.");
    return this.ports.query({ project_root: project, query });
  }
  show(view: string) { this.visible.add(view); this.ports.schedule(); }
  hide(view: string) { this.visible.delete(view); }
  viewsChanged({ activeViewIds }: { activeViewIds: readonly string[] }) { this.activeViews = new Set(activeViewIds); }
  private get historyVisible() { return [...this.visible].some(id => this.activeViews === null || this.activeViews.has(id)); }
  clearError() { this.error = ""; this.publish(); }
  get windowId() { return this.ports.windowId; }
  get connected() { return this.ports.context().connected && !!this.ports.window(); }
  hasPending(id: string, kind?: AgentTaskCommand["kind"]) { return [...this.pending.values()].some(p => p.taskId === id && (!kind || p.kind === kind)); }
  restoreSubmitted(id: string, content: AgentDraftContent) { if (!this.canEdit(id)) return; const local=this.local(id); if (!equal(local.content,content) && (local.content.text || local.content.assets.length || local.content.context.length)) local.conflict=clone(local.content); this.edit(id,content); }
  summary(id: string) { return this.tasks.find(t => t.task.task_id === id) ?? this.details.get(id)?.summary; }
  canEdit(id: string) { const a = this.summary(id)?.attachment; return !!a && a.controller.window_id === this.windowId && !a.control_frozen; }
  private local(id: string): LocalDraft {
    let local = this.drafts.get(id);
    if (!local) {
      const draft = this.details.get(id)?.draft;
      local = { content: clone(draft?.content ?? emptyDraft()), baseVersion: draft?.version ?? 0, revision: 0, dirty: false, conflict: null };
      this.drafts.set(id, local);
    }
    return local;
  }
  private control(id: string, generation?: number) {
    const summary = this.summary(id);
    if (!summary) throw new Error("Task is unavailable.");
    return { task_id: id, generation: generation ?? summary.attachment.generation };
  }
  private mergeSummary(incoming: AgentTaskSummary) {
    const id = incoming.task.task_id, old = this.summary(id);
    if (old && old.observation_version > incoming.observation_version) return;
    if (!incoming.attachment.capabilities.models.length && old?.attachment.capabilities.models.length) incoming = { ...incoming, attachment: { ...incoming.attachment, capabilities: { ...incoming.attachment.capabilities, models: old.attachment.capabilities.models } } };
    const value = immutable(incoming);
    const i = this.tasks.findIndex(t => t.task.task_id === id);
    if (i >= 0) this.tasks = this.tasks.map((t, n) => n === i ? value : t);
    else if (incoming.task.archived === this.archived) this.tasks = [value, ...this.tasks];
    const local = this.drafts.get(id);
    if (local?.dirty && incoming.attachment.controller.window_id !== this.windowId) local.conflict ??= clone(local.content);
  }
  private mergeDetail(incoming: AgentTaskDetail) {
    const id = incoming.summary.task.task_id, old = this.details.get(id);
    if (Math.max(old?.summary.observation_version ?? 0, this.summary(id)?.observation_version ?? 0) > incoming.summary.observation_version) return;
    this.mergeSummary(incoming.summary); this.details.set(id, immutable(incoming));
    const local = this.local(id);
    const send = [...this.pending.values()].find(p => p.taskId === id && p.kind === "send");
    const save = [...this.pending.values()].find(p => p.taskId === id && p.kind === "save_draft");
    const remote = incoming.draft;
    if (!local.dirty) { local.content = clone(remote.content); local.baseVersion = remote.version; }
    else if (remote.version > local.baseVersion) {
      if (equal(remote.content, local.content)) { local.baseVersion = remote.version; local.dirty = false; }
      else if (save && equal(remote.content, save.content)) { local.baseVersion = remote.version; }
      else if (send) { local.baseVersion = remote.version; }
      else { local.conflict ??= clone(local.content); }
    }
    this.stash();
  }
  select(id: string) { this.selected = id; this.contextPreview = null; this.contextItems = []; this.contextGeneration++; this.changed(); this.publish(); void this.loadDetail(id); this.ports.schedule(); }
  filterArchived(value: boolean) { if (value === this.archived) return; this.archived = value; this.tasks = []; this.next = null; this.extendedList = false; this.changed(); this.publish(); this.ports.schedule(); }
  async loadMore() { if (this.next) await this.list(this.next); }
  private async list(before: string | null = null) {
    const project = this.ports.context().project, generation = this.generation;
    const archived = this.archived;
    const result = await this.query({ kind: "list", archived, before, limit: 50 });
    if (!this.guard(project, generation) || archived !== this.archived || result.kind !== "list") return;
    for (const task of result.tasks) this.mergeSummary(task);
    this.tasks = [...new Map(this.tasks.map(t => [t.task.task_id, t])).values()].filter(t => t.task.archived === this.archived);
    this.tasks.sort((a, b) => b.task.created_at_ms - a.task.created_at_ms || b.task.task_id.localeCompare(a.task.task_id));
    if (before) this.extendedList = true;
    if (before || !this.extendedList) this.next = result.next;
    this.running = result.running; this.permissions = result.permissions; this.attention = immutable(result.attention);
    if (!this.selected && this.tasks.length) this.selected = this.tasks[0].task.task_id;
  }
  async observeSummary() {
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project || !scope.connected || this.summaryFlight || this.stopped) return;
    this.summaryFlight = true;
    try {
      const before = JSON.stringify([this.tasks, this.attention, this.running, this.permissions, this.selected]);
      const active = this.tasks.filter(t => agentBusy(t.attachment.state) || t.attachment.decisions.length).map(t => t.task.task_id).slice(0, 8);
      await this.list();
      if (!this.guard(scope.project, generation)) return;
      for (const pending of [...this.pending.values()].slice(0, 8)) await this.checkReceipt(pending);
      for (const [id, local] of this.drafts) if (local.dirty && !local.conflict && this.canEdit(id) && !this.hasPending(id, "save_draft") && !this.saving.has(id)) this.queueSave(id);
      for (const id of active) if (id !== this.selected) await this.loadDetail(id);
      if (this.historyVisible && this.selected) await this.loadDetail(this.selected);
      if (before !== JSON.stringify([this.tasks, this.attention, this.running, this.permissions, this.selected])) this.publish();
    } catch (e) { if (this.guard(scope.project, generation)) { this.error = message(e); this.publish(); } }
    finally { if (generation === this.generation) this.summaryFlight = false; }
  }
  async loadDetail(id: string) {
    const project = this.ports.context().project, generation = this.generation;
    try { const result = await this.query({ kind: "get", task_id: id });
      if (this.guard(project, generation) && result.kind === "detail") { const previous = this.details.get(id); this.mergeDetail(result.detail); if (!equal(previous, result.detail)) this.publish(); }
    } catch (e) { if (this.guard(project, generation)) { this.error = message(e); this.publish(); } }
  }
  async observeEvents() {
    const id = this.selected, scope = this.ports.context(), generation = this.generation;
    if (!id || !this.historyVisible || this.eventFlight || !scope.connected || !scope.project) return;
    this.eventFlight = true;
    try {
      const after = this.cursors.get(id) ?? null;
      const result = await this.query({ kind: "events", task_id: id, after, before: null, limit: 100 });
      if (!this.guard(scope.project, generation) || result.kind !== "events") return;
      const page = result.page;
      if (page.task_id !== id) throw new Error("History belongs to another task.");
      if (this.historyEpochs.get(id) !== page.history_generation) { this.events.delete(id); this.historyEpochs.set(id, page.history_generation); }
      if (page.events.some(e => e.sequence > page.durable_cursor)) throw new Error("History contains a non-durable cursor.");
      if (page.events.length) {
        const map = new Map((this.events.get(id) ?? []).map(e => [e.event_id, e]));
        for (const event of page.events) { const previous = map.get(event.event_id); if (!previous || previous.sequence <= event.sequence) map.set(event.event_id, immutable(event)); }
        this.events.set(id, Object.freeze([...map.values()].sort((a, b) => a.observed_at_ms - b.observed_at_ms || a.sequence - b.sequence)));
      }
      if (after === null) this.earlier.set(id, page.has_more);
      this.cursors.set(id, after !== null && page.has_more ? page.next_cursor : page.durable_cursor);
      this.historyGap.set(id, page.history_gap); if (page.events.length) this.trimEventCache(id);
      if (page.events.length || page.history_gap) this.publish();
    } catch (e) { if (this.guard(scope.project, generation)) { this.error = message(e); this.publish(); } }
    finally { if (generation === this.generation) this.eventFlight = false; }
  }
  canReadNativeHistory(id: string) { return this.summary(id)?.task.provider === "codex" && !this.nativeHistoryDone.has(id); }
  async olderHistory(id: string) {
    const project = this.ports.context().project, generation = this.generation;
    try {
      const before = Math.min(...(this.events.get(id) ?? []).map(e => e.sequence).filter(n => n > 0));
      const result = await this.query({ kind: "events", task_id: id, after: null, before: Number.isFinite(before) ? before : null, limit: 100 });
      if (!this.guard(project, generation)) return;
      if (result.kind === "events" && result.page.task_id !== id) throw new Error("History belongs to another task.");
      if (result.kind === "events" && result.page.events.length) {
        if (result.page.events.some(e => e.sequence > result.page.durable_cursor)) throw new Error("History contains a non-durable cursor.");
        this.earlier.set(id, result.page.has_more);
        const map = new Map([...(this.events.get(id) ?? []), ...result.page.events].map(e => [e.event_id, e]));
        this.events.set(id, Object.freeze([...map.values()].sort((a, b) => a.observed_at_ms - b.observed_at_ms || a.sequence - b.sequence)));
      } else if (this.summary(id)?.task.provider === "codex" && !this.nativeHistoryDone.has(id)) {
        const page = await this.query({ kind: "native_history", task_id: id, cursor: this.nativeCursors.get(id) ?? null, limit: 20 });
        if (!this.guard(project, generation)) return;
        if (page.kind === "native_history" && page.page.task_id === id) { if (!page.page.next_cursor) this.nativeHistoryDone.add(id); this.nativeCursors.set(id, page.page.next_cursor); const map = new Map([...page.page.events, ...(this.events.get(id) ?? [])].map(e => [e.event_id, e])); this.events.set(id, Object.freeze([...map.values()])); }
      }
      this.trimEventCache(id, true); this.publish();
    } catch (e) { if (this.guard(project, generation)) { this.error = message(e); this.publish(); } }
  }
  private trimEventCache(id: string, older = false) {
    const size = (events: readonly AgentTaskEvent[]) => events.reduce((n, e) => n + new TextEncoder().encode(e.text).length, 0);
    const events = [...(this.events.get(id) ?? [])]; let bytes = size(events), trimmed = false;
    while (events.length > 500 || bytes > 1024 * 1024) { const removed = older ? events.pop()! : events.shift()!; bytes -= new TextEncoder().encode(removed.text).length; trimmed = true; }
    if (trimmed) { this.events.set(id, Object.freeze(events)); this.historyGap.set(id, true); }
    this.eventSizes.set(id, bytes);
    let total = [...this.eventSizes.values()].reduce((n, value) => n + value, 0);
    for (const key of this.events.keys()) {
      if (total <= 64 * 1024 * 1024) break;
      if (key === id || agentBusy(this.summary(key)?.attachment.state ?? "")) continue;
      total -= this.eventSizes.get(key) ?? 0; this.eventSizes.delete(key); this.events.delete(key); this.cursors.delete(key); this.historyGap.set(key, true);
    }
  }
  edit(id: string, content: AgentDraftContent) {
    if (!this.canEdit(id)) return;
    const local = this.local(id); local.content = clone(content); local.revision++; local.dirty = true;
    this.changed(); this.publish(); this.queueSave(id);
  }
  editText(id: string, text: string) { this.edit(id, { ...this.local(id).content, text }); }
  private queueSave(id: string) { clearTimeout(this.timers.get(id)); this.timers.set(id, setTimeout(() => { void this.flushDraft(id); }, 400)); }
  async flushDraft(id: string): Promise<void> {
    const previous=this.saveFlights.get(id);
    if(previous){await previous;if(this.local(id).dirty && !this.local(id).conflict && !this.hasPending(id,"save_draft"))return this.flushDraft(id);return;}
    const work=this.saveDraft(id);this.saveFlights.set(id,work);
    try{await work;}finally{if(this.saveFlights.get(id)===work)this.saveFlights.delete(id);}
  }
  private async saveDraft(id: string) {
    clearTimeout(this.timers.get(id));
    const local = this.local(id);
    if (!local.dirty || local.conflict || this.saving.has(id) || !this.canEdit(id) || !this.ports.context().connected) return;
    if (new TextEncoder().encode(local.content.text).length > 32768 || new TextEncoder().encode(JSON.stringify(local.content)).length > 256 * 1024) { this.error = "Draft exceeds the saved-input limit. Shorten the text or remove context."; this.publish(); return; }
    this.saving.add(id); const revision = local.revision;
    try {
      const result = await this.perform({ kind: "save_draft", control: this.control(id), version: local.baseVersion, content: clone(local.content) }, id);
      if (result?.receipt.status === "succeeded") {
        local.baseVersion = Math.max(local.baseVersion, result.detail.draft.version);
        if (local.revision === revision) local.dirty = false;
      }
    } finally { this.saving.delete(id); this.stash(); this.publish(); if (local.dirty && !local.conflict && local.revision !== revision) this.queueSave(id); }
  }
  async flushAll() { for (const id of this.drafts.keys()) await this.flushDraft(id); }
  async discover(provider: AgentProvider, model: string | null = null) {
    const project = this.ports.context().project, generation = this.generation;
    if (!project) throw new Error("Open a project first.");
    const catalog = await this.ports.discover({ project_root: project, provider, model });
    if (!this.guard(project, generation)) throw new Error("Project changed during discovery.");
    this.catalogs[provider] = immutable(catalog); this.publish();
    if (catalog.error) throw new Error(catalog.error); return catalog;
  }
  async newTask(provider: AgentProvider) {
    if (this.creating) return;
    this.creating = true; this.error = ""; this.publish();
    try {
      const desired = this.preferred[provider] ?? this.tasks.find(t => t.task.provider === provider)?.task.model ?? null;
      const catalog = this.catalogs[provider] ?? await this.discover(provider, desired);
      const model = desired && catalog.models.some(m => m.id === desired) ? desired : catalog.selected_model ?? catalog.models[0]?.id;
      if (!model) throw new Error("Open Agent Settings to choose an available model.");
      const result = await this.perform({ kind: "create", provider, model, effort: catalog.models.find(m => m.id === model)?.default_effort ?? null }, null);
      if (result) this.select(result.detail.summary.task.task_id);
    } catch (e) { this.error = message(e); }
    finally { this.creating = false; this.publish(); }
  }
  async send(id: string) {
    await this.flushDraft(id);
    const local = this.local(id), task = this.summary(id);
    if (local.dirty || local.conflict || !task || agentBusy(task.attachment.state) || !this.canEdit(id) || [...this.pending.values()].some(p => p.taskId === id && p.kind === "send")) return;
    await this.perform({ kind: "send", control: this.control(id), draft_version: local.baseVersion }, id);
  }
  async configure(id: string, model: string, effort: string | null, mode: string | null) {
    const task = this.summary(id); if (!task || !this.canEdit(id)) return;
    if (task.task.model !== model) { try { await this.discover(task.task.provider, model); } catch (e) { this.error = message(e); this.publish(); return; } }
    this.preferred[task.task.provider] = model;
    await this.perform({ kind: "configure", control: this.control(id), model, effort, mode }, id); this.changed();
  }
  async act(id: string, kind: "resume" | "disconnect" | "stop") { await this.perform({ kind, control: this.control(id) }, id); }
  async takeOver(id: string, stop: boolean) { await this.perform({ kind: "take_over", control: this.control(id), stop }, id); }
  async rename(id: string, title: string) { await this.perform({ kind: "rename", control: this.control(id), title }, id); }
  async archive(id: string, archived: boolean) { await this.perform({ kind: "archive", control: this.control(id), archived }, id);  this.ports.schedule(); }
  async reply(id: string, generation: number, decision_id: number, option_id: string) { await this.perform({ kind: "decision", control: this.control(id, generation), decision_id, option_id }, id); }
  async upload(id: string, name: string, mime_type: string, data: string) {
    const result = await this.perform({ kind: "add_asset", control: this.control(id), name, mime_type, data }, id);
    if (result) {
      const pending = this.pending.get(result.receipt.request_id);
      if (pending) pending.content = { text: result.receipt.request_id, assets: [], context: [] };
      else if (result.receipt.status === "succeeded") this.attachAsset(id, result.receipt.request_id);
    }
  }
  private attachAsset(id: string, assetId: string) {
    const local = this.local(id);
    if (local.content.assets.includes(assetId)) return;
    if (this.canEdit(id)) this.edit(id, { ...local.content, assets: [...local.content.assets, assetId] });
    else { local.conflict ??= clone(local.content); local.conflict.assets.push(assetId); this.changed(); this.publish(); }
  }
  removeAsset(id: string, assetId: string) { const content = this.local(id).content; this.edit(id, { ...content, assets: content.assets.filter(a => a !== assetId) }); }
  addContext(id: string, selection: AgentContextSelection) { const content = this.local(id).content; if (!content.context.some(s => equal(s, selection))) this.edit(id, { ...content, context: [...content.context, clone(selection)] }); }
  removeContext(id: string, index: number) { const content = this.local(id).content; this.edit(id, { ...content, context: content.context.filter((_, i) => i !== index) }); }
  useLocalCopy(id: string) { if (!this.canEdit(id)) return; const local = this.local(id); if (local.conflict) { local.content = clone(local.conflict); local.conflict = null; local.baseVersion = this.details.get(id)?.draft.version ?? local.baseVersion; local.revision++; local.dirty = true; this.changed(); this.publish(); this.queueSave(id); } }
  useSavedDraft(id: string) { const d = this.details.get(id)?.draft; if (!d) return; const local = this.local(id); if (local.dirty) local.conflict ??= clone(local.content); local.content = clone(d.content); local.baseVersion = d.version; local.dirty = false; this.changed(); this.publish(); }
  async searchContext(source: string | null, text: string) {
    const window = this.ports.window(), project = this.ports.context().project, generation = ++this.contextGeneration;
    if (!window || !project) return;
    this.contextLoading = true; this.contextNotices = []; this.publish();
    try {
      const sources = await this.query({ kind: "context_sources" });
      const result = await this.query({ kind: "context_search", window, source, text, limit: 40 });
      if (generation !== this.contextGeneration || project !== this.ports.context().project) return;
      if (sources.kind === "context_sources") this.sources = sources.sources;
      if (result.kind === "context_items") { this.contextItems = immutable(result.items); this.contextNotices = result.notices; }
    } catch (e) { if (generation === this.contextGeneration) this.contextNotices = [message(e)]; }
    finally { if (generation === this.contextGeneration) { this.contextLoading = false; this.publish(); } }
  }
  async previewContext(selection: AgentContextSelection) {
    const window = this.ports.window(), project = this.ports.context().project, generation = ++this.contextGeneration;
    if (!window || !project) return null;
    this.contextLoading = true; this.contextNotices = []; this.publish();
    try { const result = await this.query({ kind: "context_preview", window, selection });
      if (generation !== this.contextGeneration || project !== this.ports.context().project || result.kind !== "context_preview") return null;
      this.contextPreview = immutable(result.preview); return result.preview;
    } catch (e) { if (generation === this.contextGeneration) this.contextNotices = [message(e)]; return null; }
    finally { if (generation === this.contextGeneration) { this.contextLoading = false; this.publish(); } }
  }
  clearContext(loading = false) { this.contextGeneration++; this.contextPreview = null; this.contextItems = []; this.contextNotices = []; this.contextLoading = loading; this.publish(); }
  async loadAsset(taskId: string, assetId: string) {
    const key = `${taskId}:${assetId}`, project = this.ports.context().project, generation = this.generation;
    if (!project || this.previews.has(key) || this.assetFlights.has(key)) return;
    this.assetFlights.add(key);
    try { const value = await this.ports.asset({ project_root: project, task_id: taskId, asset_id: assetId });
      if (!this.guard(project, generation)) { this.ports.releaseAsset(value.url); return; }
      if (this.previews.size >= 16) { const oldest = this.previews.keys().next().value!; this.ports.releaseAsset(this.previews.get(oldest)!.url); this.previews.delete(oldest); }
      this.previews.set(key, value); this.publish();
    } catch (e) { if (this.guard(project, generation)) { this.error = message(e); this.publish(); } }
    finally { this.assetFlights.delete(key); }
  }
  position(id: string) { return this.reading.get(id) ?? { scrollTop: 0, following: true }; }
  setPosition(id: string, position: ReadingPosition) { this.reading.set(id, position); this.ports.changed(); }
  private async perform(command: AgentTaskCommand, taskId: string | null): Promise<AgentTaskCommandResult | null> {
    const scope = this.ports.context(), window = this.ports.window(), generation = this.generation;
    if (!scope.project || !scope.connected || !window) { this.error = "Wait for this Studio window to reconnect."; this.publish(); return null; }
    const requestId = crypto.randomUUID(), local = taskId ? this.local(taskId) : null;
    const pending: Pending = { requestId, taskId, kind: command.kind, localRevision: local?.revision ?? 0, content: command.kind === "save_draft" ? clone(command.content) : command.kind === "send" ? clone(local?.content ?? emptyDraft()) : null };
    this.pending.set(requestId, pending); this.error = ""; this.stash(); this.publish();
    try {
      const result = await this.ports.command({ project_root: scope.project, window, request_id: requestId, command });
      if (!this.guard(scope.project, generation)) return null;
      pending.taskId = result.detail.summary.task.task_id;
      this.mergeDetail(result.detail); this.received(pending, result.receipt);
      this.publish(); this.ports.schedule(); return result;
    } catch (e) {
      if (!this.guard(scope.project, generation)) return null;
      this.error = message(e);
      if (e && typeof e === "object" && "status" in e) {
        this.pending.delete(requestId);
        if (taskId) await this.loadDetail(taskId);
      } else this.error += " Checking the original request; it will not be sent again.";
      this.publish(); return null;
    } finally { this.stash(); }
  }
  private received(pending: Pending, receipt: AgentCommandReceipt) {
    if (!["succeeded", "failed", "uncertain", "interrupted"].includes(receipt.status)) return;
    this.pending.delete(pending.requestId);
    if (receipt.status !== "succeeded") this.error = receipt.error ?? `Agent request ${receipt.status}.`;
    if (pending.taskId && pending.kind === "save_draft" && receipt.status === "succeeded") {
      const local = this.local(pending.taskId); if (local.revision === pending.localRevision) local.dirty = false;
      local.baseVersion = Math.max(local.baseVersion, this.details.get(pending.taskId)?.draft.version ?? 0);
    }
    if (pending.taskId && pending.kind === "add_asset" && receipt.status === "succeeded") this.attachAsset(pending.taskId, receipt.request_id);
    this.changed();
  }
  private async checkReceipt(pending: Pending) {
    const project = this.ports.context().project, generation = this.generation;
    const result = await this.query({ kind: "receipt", request_id: pending.requestId });
    if (!this.guard(project, generation)) return;
    if (result.kind !== "receipt") return;
    if (!result.receipt) {
      // A draft CAS has no native side effect. If its identity is absent, read
      // the current draft before saving newer edits under the current version.
      // Native creation/send identities remain pending and are never replayed.
      if (pending.kind === "save_draft" && pending.taskId) {
        this.pending.delete(pending.requestId); await this.loadDetail(pending.taskId);
        if (this.guard(project, generation)) { this.stash(); this.publish(); }
      }
      return;
    }
    pending.taskId = result.receipt.task_id;
    if (pending.kind === "create" && !this.selected) this.selected = pending.taskId;
    await this.loadDetail(pending.taskId); if (this.guard(project, generation)) { this.received(pending, result.receipt); this.publish(); }
  }
  private changed() { this.ports.changed(); this.stash(); }
  private stash() { const project = this.ports.context().project; if (project) { try { this.ports.writeLocal(project, this.serialize()); } catch { this.error = "Local draft backup is full. Keep this window open until drafts are saved."; } } }
  serialize(): Record<string, unknown> {
    return { agentTasks: { selected: this.selected, archived: this.archived, reading: Object.fromEntries(this.reading), preferred: this.preferred,
      localDrafts: Object.fromEntries([...this.drafts].filter(([, d]) => d.dirty || d.conflict).map(([id, d]) => [id, clone(d)])), pending: [...this.pending.values()] } };
  }
  restore(value: unknown) {
    const project = this.ports.context().project;
    const saved = (value as { agentTasks?: unknown } | null)?.agentTasks;
    const local = project ? (this.ports.readLocal(project) as { agentTasks?: unknown } | null)?.agentTasks : undefined;
    for (const raw of [saved, local]) {
      if (!raw || typeof raw !== "object") continue;
      const data = raw as { selected?: unknown; archived?: unknown; reading?: Record<string, ReadingPosition>; preferred?: Partial<Record<AgentProvider, string>>; localDrafts?: Record<string, LocalDraft>; pending?: Pending[] };
      if (typeof data.selected === "string") this.selected = data.selected;
      if (typeof data.archived === "boolean") this.archived = data.archived;
      if (data.preferred) this.preferred = { ...this.preferred, ...data.preferred };
      for (const [id, d] of Object.entries(data.localDrafts ?? {}).slice(0, 50)) if (d?.content && typeof d.content.text === "string" && d.content.text.length <= 32768 && Array.isArray(d.content.assets) && Array.isArray(d.content.context)) this.drafts.set(id, clone(d));
      for (const p of (data.pending ?? []).slice(0, 64)) if (typeof p.requestId === "string" && typeof p.kind === "string") this.pending.set(p.requestId, clone(p));
      for (const [id, pos] of Object.entries(data.reading ?? {})) if (Number.isFinite(pos.scrollTop)) this.reading.set(id, pos);
    }
    this.stopped = false;  this.publish(); this.ports.schedule();
  }
  reset() {
    this.generation++; this.contextGeneration++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const p of this.previews.values()) this.ports.releaseAsset(p.url);
    this.tasks = []; this.attention = []; this.selected = null; this.next = null; this.extendedList = false; this.archived = false; this.historyEpochs.clear(); this.eventSizes.clear(); this.saveFlights.clear(); this.creating = false; this.sources = []; this.contextItems = []; this.contextPreview = null; this.contextNotices = []; this.contextLoading = false; this.details.clear(); this.drafts.clear(); this.events.clear(); this.cursors.clear(); this.pending.clear(); this.reading.clear(); this.historyGap.clear(); this.earlier.clear(); this.nativeHistoryDone.clear(); this.nativeCursors.clear(); this.catalogs = {}; this.previews.clear(); this.assetFlights.clear(); this.saving.clear(); this.running = this.permissions = 0; this.summaryFlight = this.eventFlight = false; this.error = "";  this.publish();
  }
  stop() { this.stash(); this.stopped = true; this.generation++; for (const timer of this.timers.values()) clearTimeout(timer); for (const p of this.previews.values()) this.ports.releaseAsset(p.url); this.dispose(); }
}
