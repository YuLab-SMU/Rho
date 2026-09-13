import { Model, immutable, readonlyMap } from "./shared/model";
import { message } from "./shared/ports";
import type { ComponentAgentPorts } from "./component-agent-ports";
import type { ApplicationWindowRef } from "./generated/ApplicationWindowRef";
import type { ComponentAgentConversation } from "./generated/ComponentAgentConversation";
import type { ComponentAgentRun } from "./generated/ComponentAgentRun";
import type { ComponentAgentStart } from "./generated/ComponentAgentStart";
import type { ComponentAgentEvent } from "./generated/ComponentAgentEvent";
import type { ComponentToolReceipt } from "./generated/ComponentToolReceipt";
import type { ComponentAgentRunSummary } from "./generated/ComponentAgentRunSummary";
import type { ComponentAgentProfile } from "./generated/ComponentAgentProfile";

const clone = <T>(value: T): T => structuredClone(value);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const textBytes = (value: string) => new TextEncoder().encode(value).length;
const sameWindow = (a: ApplicationWindowRef | null, b: ApplicationWindowRef | null) =>
  a?.window_id === b?.window_id && a?.incarnation === b?.incarnation;
export const componentBusy = (run: ComponentAgentRun) =>
  ["queued", "running", "waiting_for_r", "needs_input", "stopping"].includes(run.state);
interface Draft { text: string; baseVersion: number; revision: number; dirty: boolean; conflict: string | null }
interface PendingStart { request: ComponentAgentStart; state: "sending" | "uncertain" }
interface Scope { project: string; epoch: number; generation: number; window: ApplicationWindowRef | null }
interface ComponentSnapshot {
  history: ReadonlyMap<string, { runs: readonly ComponentAgentRunSummary[]; before: string | null; next: string | null }>;
  conversations: ReadonlyMap<string, ComponentAgentConversation>;
  drafts: ReadonlyMap<string, Draft>;
  runs: ReadonlyMap<string, ComponentAgentRun>;
  tools: ReadonlyMap<string, readonly ComponentToolReceipt[]>;
  events: ReadonlyMap<string, readonly ComponentAgentEvent[]>;
  historyGap: ReadonlyMap<string, boolean>;
  pending: readonly PendingStart[];
  error: string;
}

/** Nonvisual application client. Every model/owner action is explicit; observation never replays it. */
export class ComponentAgents extends Model<ComponentSnapshot> {
  private project: string | null = null;
  private generation = 0;
  private stopped = false;
  private conversations = new Map<string, ComponentAgentConversation>();
  private history = new Map<string, { runs: readonly ComponentAgentRunSummary[]; before: string | null; next: string | null }>();
  private drafts = new Map<string, Draft>();
  private runs = new Map<string, ComponentAgentRun>();
  private tools = new Map<string, readonly ComponentToolReceipt[]>();
  private events = new Map<string, readonly ComponentAgentEvent[]>();
  private cursors = new Map<string, number>();
  private gaps = new Map<string, boolean>();
  private pending = new Map<string, PendingStart>();
  private saves = new Map<string, Promise<void>>();
  private runOrder = new Set<string>();
  private historyRequests = new Map<string, number>();
  private toolRequests = new Map<string, number>();
  private error = "";
  constructor(private ports: ComponentAgentPorts) { super(); }
  protected readSnapshot(): ComponentSnapshot {
    return { history: readonlyMap(this.history), conversations: readonlyMap(this.conversations), drafts: readonlyMap(new Map([...this.drafts].map(([id, draft]) => [id, immutable(clone(draft))]))),
      runs: readonlyMap(this.runs), tools: readonlyMap(this.tools), events: readonlyMap(this.events), historyGap: readonlyMap(this.gaps),
      pending: immutable(clone([...this.pending.values()])), error: this.error };
  }
  /** Called by the application lifecycle, never by a panel mount/unmount. */
  reset() {
    this.generation++;
    this.project = this.ports.context().project;
    this.conversations.clear(); this.history.clear(); this.drafts.clear(); this.runs.clear(); this.tools.clear();
    this.events.clear(); this.cursors.clear(); this.gaps.clear(); this.pending.clear(); this.saves.clear(); this.runOrder.clear(); this.error = "";
    this.historyRequests.clear(); this.toolRequests.clear();
    if (this.project) {
      try { this.restore(this.ports.readLocal(this.project)); }
      catch { this.error = "The local assistant draft state could not be read."; }
    }
    this.publish();
  }
  private scope(write = false): Scope {
    const context = this.ports.context();
    if (this.stopped || !context.connected || !context.project) throw new Error("Connect to a project first.");
    if (this.project !== context.project) this.reset();
    const window = clone(this.ports.window());
    if (write && !window) throw new Error("Wait for this window to synchronize.");
    return { project: context.project, epoch: context.epoch, generation: this.generation, window };
  }
  private current(scope: Scope) {
    const context = this.ports.context();
    return !this.stopped && scope.generation === this.generation && scope.project === context.project &&
      scope.epoch === context.epoch && sameWindow(scope.window, this.ports.window());
  }
  private persist(required = false) {
    if (!this.project) return;
    try {
      const value = this.serialize();
      if (bytes(value) > 2 * 1024 * 1024) throw new Error("Local assistant state exceeds 2 MiB.");
      this.ports.writeLocal(this.project, value);
    } catch {
      this.error = "The local draft or request identity could not be saved.";
      if (required) throw new Error("Request was not submitted because its identity could not be saved.");
    }
  }
  serialize() {
    return clone({ version: 1, drafts: [...this.drafts].filter(([, draft]) => draft.dirty || draft.conflict !== null), pending: [...this.pending.values()] });
  }
  private restore(value: unknown) {
    if (!value || typeof value !== "object" || bytes(value) > 2 * 1024 * 1024) return;
    const saved = value as { version?: number; drafts?: unknown; pending?: unknown };
    if (saved.version !== 1 || !Array.isArray(saved.drafts) || !Array.isArray(saved.pending)) return;
    for (const entry of saved.drafts.slice(0, 32)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const draft = entry[1] as Draft | undefined;
      if (draft && typeof draft.text === "string" && textBytes(draft.text) <= 64 * 1024 &&
        Number.isSafeInteger(draft.baseVersion) && draft.baseVersion >= 0 && Number.isSafeInteger(draft.revision) && draft.revision >= 0) {
        this.drafts.set(entry[0], { text: draft.text, baseVersion: draft.baseVersion, revision: draft.revision,
          dirty: Boolean(draft.dirty), conflict: typeof draft.conflict === "string" ? draft.conflict : null });
      }
    }
    for (const entry of saved.pending.slice(0, 16)) {
      const request = entry?.request as ComponentAgentStart | undefined;
      if (request && typeof request.request_id === "string" && typeof request.conversation_id === "string" &&
        typeof request.text === "string" && typeof request.window?.window_id === "string" &&
        typeof request.window.incarnation === "string" && bytes(request) <= 64 * 1024) {
        this.pending.set(request.request_id, { request: clone(request), state: "uncertain" });
      }
    }
  }
  private acceptConversation(remote: ComponentAgentConversation, ack?: { revision: number; text: string }) {
    const previous = this.conversations.get(remote.conversation_id);
    if (previous && (previous.version > remote.version || previous.draft_version > remote.draft_version)) return;
    if (!this.drafts.has(remote.conversation_id) && this.drafts.size >= 32) {
      const removable = [...this.drafts].find(([id, draft]) => !draft.dirty && ![...this.pending.values()].some(p => p.request.conversation_id === id));
      if (!removable) throw new Error("Keep at most 32 local assistant drafts.");
      this.drafts.delete(removable[0]); this.conversations.delete(removable[0]); this.history.delete(removable[0]);
      this.historyRequests.delete(removable[0]);
    }
    const local = this.drafts.get(remote.conversation_id);
    if (!local || !local.dirty) {
      this.drafts.set(remote.conversation_id, { text: remote.draft, baseVersion: remote.draft_version,
        revision: local?.revision ?? 0, dirty: false, conflict: null });
    } else if (ack && remote.draft === ack.text && (!previous || sameWindow(previous.controller, remote.controller))) {
      local.baseVersion = remote.draft_version;
      if (local.revision === ack.revision) { local.dirty = false; local.conflict = null; }
    } else if (local.text === remote.draft) {
      local.baseVersion = remote.draft_version; local.dirty = false; local.conflict = null;
    } else if (local.baseVersion !== remote.draft_version || (previous && !sameWindow(previous.controller, remote.controller))) {
      local.conflict = remote.draft;
    }
    this.conversations.set(remote.conversation_id, immutable(clone(remote)));
    this.persist(); this.publish();
  }
  async observeConversation(id: string) {
    const scope = this.scope();
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "conversation", conversation_id: id } });
    if (!this.current(scope)) return;
    if (reply.conversation.conversation_id !== id) throw new Error("Conversation identity mismatch.");
    this.acceptConversation(reply.conversation);
  }
  async observeConversations(after: string | null = null) {
    const scope = this.scope();
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "conversations", after, limit: 32 } });
    if (!this.current(scope)) return;
    if (reply.conversations.length > 32) throw new Error("Conversation page exceeds its limit.");
    for (const conversation of reply.conversations) this.acceptConversation(conversation);
    return reply.conversations.length === 32 ? reply.conversations.at(-1)!.conversation_id : null;
  }
  async create(id: string, profile: ComponentAgentProfile) {
    const scope = this.scope(true);
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind: "create", conversation_id: id, profile } });
    if (!this.current(scope)) return;
    if (reply.conversation.conversation_id !== id || reply.conversation.profile !== profile) throw new Error("Conversation acknowledgement mismatch.");
    this.acceptConversation(reply.conversation);
  }
  async observeHistory(id: string, before: string | null = null) {
    const scope = this.scope();
    if (!this.conversations.has(id)) throw new Error("Read the conversation before its history.");
    const request = (this.historyRequests.get(id) ?? 0) + 1; this.historyRequests.set(id, request);
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "runs", conversation_id: id, before, limit: 32 } });
    if (!this.current(scope) || this.historyRequests.get(id) !== request) return;
    if (reply.runs.length > 32 || reply.runs.some(run => run.conversation_id !== id) ||
      new Set(reply.runs.map(run => run.run_id)).size !== reply.runs.length) throw new Error("Invalid run history page.");
    this.history.set(id, immutable({ runs: clone(reply.runs), before, next: reply.runs.length === 32 ? reply.runs.at(-1)!.run_id : null }));
    this.publish();
  }
  canControl(id: string) {
    const conversation = this.conversations.get(id);
    return Boolean(!this.stopped && this.project === this.ports.context().project && conversation && this.ports.context().connected && sameWindow(conversation.controller, this.ports.window()));
  }
  editDraft(id: string, text: string) {
    if (this.project !== this.ports.context().project) this.reset();
    const draft = this.drafts.get(id);
    if (!draft) throw new Error("Read the conversation before editing its draft.");
    if (textBytes(text) > 64 * 1024) throw new Error("Draft exceeds 64 KiB.");
    draft.text = text; draft.revision++; draft.dirty = true;
    this.persist(); this.publish();
  }
  resolveDraft(id: string, keepLocal: boolean) {
    if (this.project !== this.ports.context().project) this.reset();
    const remote = this.conversations.get(id), draft = this.drafts.get(id);
    if (!remote || !draft) throw new Error("Read the current conversation first.");
    if (keepLocal && !this.canControl(id)) throw new Error("This window does not control the conversation.");
    if (!keepLocal) draft.text = remote.draft;
    draft.baseVersion = remote.draft_version; draft.revision++; draft.conflict = null;
    draft.dirty = draft.text !== remote.draft;
    this.persist(); this.publish();
  }
  flushDraft(id: string): Promise<void> {
    const existing = this.saves.get(id); if (existing) return existing;
    const scope = this.scope(true), draft = this.drafts.get(id);
    if (!draft?.dirty) return Promise.resolve();
    if (!this.canControl(id) || draft.conflict !== null) return Promise.reject(new Error("Resolve draft ownership or conflict before saving."));
    const ack = { revision: draft.revision, text: draft.text }, version = draft.baseVersion;
    const saving = (async () => {
      try {
        const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: {
          kind: "save_draft", draft: { conversation_id: id, draft_version: version, text: ack.text } } });
        if (!this.current(scope)) return;
        if (reply.conversation.conversation_id !== id) throw new Error("Draft acknowledgement identity mismatch.");
        this.acceptConversation(reply.conversation, ack);
      } catch (error) {
        if (this.current(scope)) { this.error = message(error); this.publish(); }
        throw error;
      } finally { if (this.current(scope)) this.saves.delete(id); }
    })();
    this.saves.set(id, saving); return saving;
  }
  private acceptRun(run: ComponentAgentRun) {
    const old = this.runs.get(run.run_id);
    if (old && (old.updated_at_ms > run.updated_at_ms || old.event_cursor > run.event_cursor || (!componentBusy(old) && componentBusy(run)))) return;
    this.touchRun(run.run_id);
    this.runs.set(run.run_id, immutable(clone(run)));
    this.publish();
  }
  private touchRun(id: string) {
    this.runOrder.delete(id); this.runOrder.add(id);
    while (this.runOrder.size > 32) {
      const expired = this.runOrder.values().next().value!;
      this.runOrder.delete(expired); this.runs.delete(expired); this.tools.delete(expired);
      this.toolRequests.delete(expired);
      this.events.delete(expired); this.cursors.delete(expired); this.gaps.delete(expired);
    }
  }
  async start(input: Omit<ComponentAgentStart, "request_id" | "window" | "conversation_version">) {
    const scope = this.scope(true);
    input = clone(input);
    await this.observeConversation(input.conversation_id);
    if (!this.current(scope)) return;
    if (!this.canControl(input.conversation_id)) throw new Error("This window does not control the conversation.");
    if (this.drafts.get(input.conversation_id)?.conflict !== null || this.conversations.get(input.conversation_id)?.active_run_id) throw new Error("Resolve the draft or active run before submitting.");
    if ([...this.pending.values()].some(p => p.request.conversation_id === input.conversation_id)) throw new Error("Resolve the previous submission first.");
    if (this.pending.size >= 16) throw new Error("Too many unresolved submissions.");
    const request: ComponentAgentStart = clone({ ...input, request_id: crypto.randomUUID(), window: scope.window!,
      conversation_version: this.conversations.get(input.conversation_id)!.version });
    if (bytes(request) > 64 * 1024) throw new Error("Request exceeds 64 KiB.");
    this.pending.set(request.request_id, { request, state: "sending" });
    try { this.persist(true); }
    catch (error) { this.pending.delete(request.request_id); this.publish(); throw error; }
    this.publish();
    try {
      const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind: "start", request } });
      if (!this.current(scope)) return;
      this.acceptSubmission(request, reply.run);
      return reply.run;
    } catch (error) {
      if (this.current(scope)) {
        const pending = this.pending.get(request.request_id);
        if (pending) pending.state = "uncertain";
        this.error = message(error); this.persist(); this.publish();
      }
      throw error;
    }
  }
  private acceptSubmission(request: ComponentAgentStart, run: ComponentAgentRun) {
    if (run.request.request_id !== request.request_id || run.request.conversation_id !== request.conversation_id ||
      !sameWindow(run.request.window, request.window)) throw new Error("Submission acknowledgement identity mismatch.");
    this.acceptRun(run); this.pending.delete(request.request_id); this.persist(); this.publish();
  }
  async observeSubmission(requestId: string) {
    const scope = this.scope(), pending = this.pending.get(requestId);
    if (!pending) return;
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "request", request_id: requestId } });
    if (this.current(scope) && reply.run) this.acceptSubmission(pending.request, reply.run);
    // Absence during an in-flight/lost acknowledgement is not proof that replay is safe.
  }
  async observeRun(id: string) {
    const scope = this.scope();
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "run", run_id: id } });
    if (!this.current(scope)) return;
    if (reply.run.run_id !== id) throw new Error("Run identity mismatch.");
    this.acceptRun(reply.run);
  }
  async observeEvents(id: string) {
    const scope = this.scope(), after = this.cursors.get(id) ?? 0;
    const { page } = await this.ports.query({ project_root: scope.project, query: { kind: "events", run_id: id, after, limit: 128 } });
    if (!this.current(scope) || (this.cursors.get(id) ?? 0) !== after) return;
    if (!Number.isSafeInteger(page.cursor) || page.cursor < after) throw new Error("Invalid event cursor.");
    let last = after;
    for (const event of page.events) {
      if (event.run_id !== id || !Number.isSafeInteger(event.sequence) || event.sequence <= last || event.sequence > page.cursor) throw new Error("Invalid event identity or order.");
      last = event.sequence;
    }
    const events = [...(this.events.get(id) ?? []), ...clone(page.events)];
    let gap = (this.gaps.get(id) ?? false) || page.history_gap;
    let size = bytes(events);
    while (events.length > 2048 || size > 256 * 1024) {
      const removed = events.shift()!;
      size -= bytes(removed) + (events.length ? 1 : 0); gap = true;
    }
    this.touchRun(id);
    this.events.set(id, immutable(events)); this.cursors.set(id, page.cursor); this.gaps.set(id, gap); this.publish();
  }
  async observeTools(id: string) {
    const scope = this.scope();
    const request = (this.toolRequests.get(id) ?? 0) + 1; this.toolRequests.set(id, request);
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "tools", run_id: id } });
    if (!this.current(scope) || this.toolRequests.get(id) !== request) return;
    if (reply.tools.some(tool => tool.run_id !== id)) throw new Error("Tool receipt identity mismatch.");
    if (bytes(reply.tools) > 512 * 1024) throw new Error("Tool receipt page exceeds its display budget.");
    this.touchRun(id); this.tools.set(id, immutable(clone(reply.tools))); this.publish();
  }
  async controlRun(id: string, kind: "stop" | "reconcile") {
    const scope = this.scope(true), run = this.runs.get(id);
    if (!run || !this.canControl(run.request.conversation_id)) throw new Error("This window does not control the run.");
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind, run_id: id } });
    if (this.current(scope)) {
      if (reply.run.run_id !== id) throw new Error("Run acknowledgement identity mismatch.");
      this.acceptRun(reply.run);
    }
  }
  async takeControl(id: string) {
    const scope = this.scope(true), conversation = this.conversations.get(id);
    if (!conversation) throw new Error("Read the conversation first.");
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: {
      kind: "take_control", conversation_id: id, expected_version: conversation.version } });
    if (!this.current(scope)) return;
    if (reply.conversation.conversation_id !== id || !sameWindow(reply.conversation.controller, scope.window)) throw new Error("Controller acknowledgement identity mismatch.");
    this.acceptConversation(reply.conversation);
  }
  override dispose() { this.stopped = true; this.generation++; super.dispose(); }
}
