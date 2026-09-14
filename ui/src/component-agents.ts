import { Model, immutable, readonlyMap, readonlySet } from "./shared/model";
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
import type { AgentContextSelection } from "./generated/AgentContextSelection";
import type { ComponentAgentGrant } from "./generated/ComponentAgentGrant";
import type { ComponentModelSettings } from "./generated/ComponentModelSettings";
import type { ComponentModelDiagnostic } from "./generated/ComponentModelDiagnostic";
import type { ComponentSourcePreview } from "./generated/ComponentSourcePreview";
import type { ComponentSourceSearchResult } from "./generated/ComponentSourceSearchResult";
import type { ComponentCredentialStatus } from "./generated/ComponentCredentialStatus";
import type { Diagnostic } from "./generated/Diagnostic";
import type { AgentDraftContent } from "./generated/AgentDraftContent";
import type { AgentAsset } from "./generated/AgentAsset";
import type { AgentAssetPreview } from "./agent-task-ports";
export interface ComponentComposer { sources: AgentContextSelection[]; grant: ComponentAgentGrant }

const clone = <T>(value: T): T => structuredClone(value);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// Normalize the editable draft only. Accepted runs and uncertain requests retain
// their original grants for continuation, recovery and idempotent retry.
const draftComposer = (value: ComponentComposer): ComponentComposer => {
  const composer = clone(value);
  composer.grant.permission_policy ??= "ask";
  composer.grant.files = composer.grant.files.map(file => typeof file?.sha256 === "string"
    ? { ...file, sha256: file.sha256.replace(/^sha256:([\da-fA-F]{64})$/, "$1") } : file);
  return composer;
};
const sourceIdentity = (selection: AgentContextSelection) => {
  const ref = selection.reference && typeof selection.reference === "object" && !Array.isArray(selection.reference) ? selection.reference : {};
  const document = ref.document && typeof ref.document === "object" && !Array.isArray(ref.document) ? ref.document : {};
  const window = ref.window && typeof ref.window === "object" && !Array.isArray(ref.window) ? ref.window : {};
  const identity = selection.source === "files" ? [ref.path] : selection.source === "editor" ? [window.window_id,document.document_id] : selection.source === "plots" ? [ref.operation_id,ref.sequence] : selection.source === "packages" ? [ref.workspace_instance_id,ref.expected_session,ref.package,ref.library_path] : ["objects","tables"].includes(selection.source) ? [ref.workspace_instance_id,ref.expected_session,ref.name] : selection.source === "workspace" ? [ref.workspace_instance_id,ref.expected_session] : selection.source === "environment" ? [ref.workspace_instance_id] : [ref];
  return JSON.stringify([selection.source,canonical(identity)]);
};
const textBytes = (value: string) => new TextEncoder().encode(value).length;
const sameWindow = (a: ApplicationWindowRef | null, b: ApplicationWindowRef | null) =>
  a?.window_id === b?.window_id && a?.incarnation === b?.incarnation;
export const componentBusy = (run: ComponentAgentRun) =>
  ["queued", "running", "waiting_for_r", "needs_input", "waiting_for_permission", "stopping"].includes(run.state);
interface Draft { assets?: string[]; conflictContent?: AgentDraftContent; text: string; baseVersion: number; revision: number; dirty: boolean; conflict: string | null }
interface PendingStart { request: ComponentAgentStart; state: "sending" | "uncertain" }
interface Scope { project: string; epoch: number; generation: number; window: ApplicationWindowRef | null }
interface ComponentSnapshot {
  assets: ReadonlyMap<string, readonly AgentAsset[]>; previews: ReadonlyMap<string, AgentAssetPreview>; uploading: ReadonlySet<string>;
  settings: ComponentModelSettings | null;
  credentialStatus: ComponentCredentialStatus | null;
  errorDiagnostic: Diagnostic | null;
  diagnostics: readonly ComponentModelDiagnostic[];
  composers: ReadonlyMap<string, ComponentComposer>;
  submitting: ReadonlySet<string>;
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
  private assets = new Map<string, readonly AgentAsset[]>();
  private previews = new Map<string, AgentAssetPreview>();
  private assetFlights = new Set<string>();
  private uploads = new Map<string,number>();
  private settings: ComponentModelSettings | null = null;
  private diagnostics: ComponentModelDiagnostic[] = [];
  private credentialStatus: ComponentCredentialStatus | null = null;
  private errorDiagnostic: Diagnostic | null = null;
  private composers = new Map<string, ComponentComposer>();
  private sending = new Set<string>();
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
  private submitting = new Map<string, symbol>();
  private saves = new Map<string, Promise<void>>();
  private runOrder = new Set<string>();
  private historyRequests = new Map<string, symbol>();
  private toolRequests = new Map<string, symbol>();
  private eventRequests = new Map<string, symbol>();
  private error = "";
  constructor(private ports: ComponentAgentPorts) { super(); }
  protected readSnapshot(): ComponentSnapshot {
    return { assets: readonlyMap(this.assets), previews: readonlyMap(this.previews), uploading: readonlySet(new Set(this.uploads.keys())), settings: this.settings, credentialStatus: this.credentialStatus, errorDiagnostic: this.errorDiagnostic, diagnostics: immutable(clone(this.diagnostics)), composers: readonlyMap(this.composers),
      submitting: readonlySet(new Set(this.submitting.keys())), history: readonlyMap(this.history), conversations: readonlyMap(this.conversations), drafts: readonlyMap(new Map([...this.drafts].map(([id, draft]) => [id, immutable(clone(draft))]))),
      runs: readonlyMap(this.runs), tools: readonlyMap(this.tools), events: readonlyMap(this.events), historyGap: readonlyMap(this.gaps),
      pending: immutable(clone([...this.pending.values()])), error: this.error };
  }
  /** Called by the application lifecycle, never by a panel mount/unmount. */
  reset() {
    this.generation++;
    for (const preview of this.previews.values()) this.ports.releaseAsset?.(preview.url);
    this.assets.clear(); this.previews.clear(); this.assetFlights.clear(); this.uploads.clear();
    this.settings = null; this.credentialStatus = null; this.errorDiagnostic = null; this.diagnostics = []; this.composers.clear();
    this.sending.clear();
    this.project = this.ports.context().project;
    this.conversations.clear(); this.history.clear(); this.drafts.clear(); this.runs.clear(); this.tools.clear();
    this.events.clear(); this.cursors.clear(); this.gaps.clear(); this.pending.clear(); this.saves.clear(); this.runOrder.clear(); this.error = "";
    this.historyRequests.clear(); this.toolRequests.clear(); this.eventRequests.clear();
    this.submitting.clear();
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
    return clone({ version: 1, composers: [...this.composers], drafts: [...this.drafts].filter(([, draft]) => draft.dirty || draft.conflict !== null), pending: [...this.pending.values()] });
  }
  private restore(value: unknown) {
    if (!value || typeof value !== "object" || bytes(value) > 2 * 1024 * 1024) return;
    const saved = value as { version?: number; drafts?: unknown; pending?: unknown; composers?: unknown };
    if (saved.version !== 1 || !Array.isArray(saved.drafts) || !Array.isArray(saved.pending)) return;
    if (Array.isArray(saved.composers)) for (const entry of saved.composers.slice(0, 32)) {
      if (!Array.isArray(entry)) continue;
      const [id, composer] = entry;
      if (typeof id === "string" && composer && Array.isArray(composer.sources) && composer.sources.length <= 16 &&
          (["explain", "edit", "run"].includes(composer.grant?.mode) || ["ask", "auto_approval", "full_access"].includes(composer.grant?.permission_policy)) && Array.isArray(composer.grant?.documents) && Array.isArray(composer.grant?.files))
        this.composers.set(id, immutable(draftComposer(composer)));
    }
    for (const entry of saved.drafts.slice(0, 32)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const draft = entry[1] as Draft | undefined;
      if (draft && typeof draft.text === "string" && textBytes(draft.text) <= 64 * 1024 &&
        Number.isSafeInteger(draft.baseVersion) && draft.baseVersion >= 0 && Number.isSafeInteger(draft.revision) && draft.revision >= 0) {
        this.drafts.set(entry[0], { text: draft.text, assets: Array.isArray(draft.assets) ? draft.assets.slice(0,20) : [], baseVersion: draft.baseVersion, revision: draft.revision,
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
  private acceptConversation(remote: ComponentAgentConversation, ack?: { revision: number; text: string; content: AgentDraftContent; grant: ComponentAgentGrant }) {
    const previous = this.conversations.get(remote.conversation_id);
    if (previous && (previous.version > remote.version || previous.draft_version > remote.draft_version)) return;
    if (!this.drafts.has(remote.conversation_id) && this.drafts.size >= 32) {
      const removable = [...this.drafts].find(([id, draft]) => id !== this.ports.selectedConversation?.() && !draft.dirty && draft.conflict === null && ![...this.pending.values()].some(p => p.request.conversation_id === id));
      if (!removable) throw new Error("Keep at most 32 local assistant drafts.");
      this.drafts.delete(removable[0]); this.conversations.delete(removable[0]); this.history.delete(removable[0]);
      this.composers.delete(removable[0]);
      this.historyRequests.delete(removable[0]);
    }
    const local = this.drafts.get(remote.conversation_id);
    const remoteContent: AgentDraftContent = { text: remote.draft, assets: remote.draft_content?.assets ?? [], context: remote.draft_content?.context ?? [] };
    if (!local || !local.dirty) {
      const prior = this.composer(remote.conversation_id);
      this.composers.set(remote.conversation_id, immutable(draftComposer({ sources: remoteContent.context, grant: remote.draft_grant ?? prior.grant })));
    }
    if (!local || !local.dirty) {
      this.drafts.set(remote.conversation_id, { text: remoteContent.text, assets: clone(remoteContent.assets), baseVersion: remote.draft_version,
        revision: local?.revision ?? 0, dirty: false, conflict: null });
    } else if (ack && same(remoteContent,ack.content) && (!remote.draft_grant || same(remote.draft_grant,ack.grant)) && (!previous || sameWindow(previous.controller, remote.controller))) {
      local.baseVersion = remote.draft_version;
      if (local.revision === ack.revision) { local.dirty = false; local.conflict = null; }
    } else if (same(this.draftContent(remote.conversation_id),remoteContent) && (!remote.draft_grant || same(this.composer(remote.conversation_id).grant,remote.draft_grant))) {
      local.baseVersion = remote.draft_version; local.dirty = false; local.conflict = null;
    } else if (local.baseVersion !== remote.draft_version || (previous && !sameWindow(previous.controller, remote.controller))) {
      local.conflict = remote.draft; local.conflictContent = clone(remoteContent);
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
    const request = Symbol(); this.historyRequests.set(id, request);
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "runs", conversation_id: id, before, limit: 32 } });
    if (!this.current(scope) || this.historyRequests.get(id) !== request) return;
    if (reply.runs.length > 32 || reply.runs.some(run => run.conversation_id !== id) ||
      new Set(reply.runs.map(run => run.run_id)).size !== reply.runs.length) throw new Error("Invalid run history page.");
    this.history.set(id, immutable({ runs: clone(reply.runs), before, next: reply.runs.length === 32 ? reply.runs.at(-1)!.run_id : null }));
    this.publish();
  }
  ownsTask(id: string) {
    const conversation = this.conversations.get(id);
    return Boolean(!this.stopped && this.project === this.ports.context().project && conversation && this.ports.context().connected && sameWindow(conversation.controller, this.ports.window()));
  }
  canControl(id: string) { return this.ownsTask(id) && !this.conversations.get(id)?.archived; }
  editDraft(id: string, text: string) {
    if (this.project !== this.ports.context().project) this.reset();
    const draft = this.drafts.get(id);
    if (!draft) throw new Error("Read the conversation before editing its draft.");
    if (this.conversations.get(id)?.archived) throw new Error("Unarchive this task before editing its draft.");
    if (textBytes(text) > 64 * 1024) throw new Error("Draft exceeds 64 KiB.");
    draft.text = text; draft.revision++; draft.dirty = true;
    this.persist(); this.publish();
  }
  resolveDraft(id: string, keepLocal: boolean) {
    if (this.project !== this.ports.context().project) this.reset();
    const remote = this.conversations.get(id), draft = this.drafts.get(id);
    if (!remote || !draft) throw new Error("Read the current conversation first.");
    if (keepLocal && !this.canControl(id)) throw new Error("This window does not control the conversation.");
    if (!keepLocal) {
      const content: AgentDraftContent = { text: remote.draft, assets: remote.draft_content?.assets ?? [], context: remote.draft_content?.context ?? [] };
      draft.text = content.text; draft.assets = clone(content.assets);
      this.composers.set(id, immutable(draftComposer({ sources: content.context, grant: remote.draft_grant ?? this.composer(id).grant })));
    }
    draft.baseVersion = remote.draft_version; draft.revision++; draft.conflict = null;
    draft.dirty = !same(this.draftContent(id),{text:remote.draft,assets:remote.draft_content?.assets??[],context:remote.draft_content?.context??[]}) || (!!remote.draft_grant && !same(this.composer(id).grant,remote.draft_grant));
    this.persist(); this.publish();
  }
  flushDraft(id: string): Promise<void> {
    const existing = this.saves.get(id); if (existing) return existing;
    const scope = this.scope(true), draft = this.drafts.get(id);
    const savedGrant = this.conversations.get(id)?.draft_grant;
    if (!draft || (!draft.dirty && (!savedGrant || same(this.composer(id).grant, savedGrant)))) return Promise.resolve();
    if (!this.canControl(id) || draft.conflict !== null) return Promise.reject(new Error("Resolve draft ownership or conflict before saving."));
    const version = draft.baseVersion, content = this.draftContent(id), grant = clone(this.composer(id).grant), ack = { revision: draft.revision, text: draft.text, content, grant };
    const saving = (async () => {
      try {
        const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: {
          kind: "save_draft", draft: { conversation_id: id, draft_version: version, text: ack.text, content, grant } } });
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
      this.eventRequests.delete(expired);
      this.events.delete(expired); this.cursors.delete(expired); this.gaps.delete(expired);
    }
  }
  async start(input: Omit<ComponentAgentStart, "request_id" | "window" | "conversation_version">) {
    const scope = this.scope(true);
    const id = input.conversation_id;
    if (this.submitting.has(id)) throw new Error("A submission for this conversation is already in progress.");
    const token = Symbol(); this.submitting.set(id, token); this.publish();
    try { return await this.submit(input, scope); }
    finally {
      if (this.submitting.get(id) === token) { this.submitting.delete(id); this.publish(); }
    }
  }
  private async submit(input: Omit<ComponentAgentStart, "request_id" | "window" | "conversation_version">, scope: Scope) {
    input = clone(input);
    await this.observeConversation(input.conversation_id);
    if (!this.current(scope)) return;
    if (!this.canControl(input.conversation_id)) throw new Error("This window does not control the conversation.");
    if (this.drafts.get(input.conversation_id)?.conflict !== null || this.conversations.get(input.conversation_id)?.active_run_id) throw new Error("Resolve the draft or active run before submitting.");
    if ([...this.pending.values()].some(p => p.request.conversation_id === input.conversation_id)) throw new Error("Resolve the previous submission first.");
    if (this.pending.size >= 16) throw new Error("Too many unresolved submissions.");
    const request: ComponentAgentStart = immutable(clone({ ...input, request_id: crypto.randomUUID(), window: scope.window!,
      conversation_version: this.conversations.get(input.conversation_id)!.version }));
    if (bytes(request) > 64 * 1024) throw new Error("Request exceeds 64 KiB.");
    this.pending.set(request.request_id, { request, state: "sending" });
    try { this.persist(true); }
    catch (error) { this.pending.delete(request.request_id); this.publish(); throw error; }
    this.publish();
    return this.dispatchSubmission(request, scope);
  }
  /** Explicit user retry only; reuse the entire original payload and request identity. */
  async retrySubmission(requestId: string) {
    const scope = this.scope(true), pending = this.pending.get(requestId);
    if (!pending || pending.state !== "uncertain") throw new Error("There is no uncertain submission to retry.");
    if (!sameWindow(scope.window, pending.request.window)) throw new Error("The original submission belongs to another window incarnation.");
    const id = pending.request.conversation_id;
    if (this.submitting.has(id)) throw new Error("A submission for this conversation is already in progress.");
    const token = Symbol(); this.submitting.set(id, token); this.publish();
    try {
      await this.observeConversation(id);
      if (!this.current(scope)) return;
      if (!this.canControl(id)) throw new Error("This window does not control the conversation.");
      return await this.dispatchSubmission(immutable(clone(pending.request)), scope, true);
    } finally {
      if (this.submitting.get(id) === token) { this.submitting.delete(id); this.publish(); }
    }
  }
  private async dispatchSubmission(request: ComponentAgentStart, scope: Scope, wasUncertain = false) {
    const pending = this.pending.get(request.request_id);
    if (!pending) return;
    pending.state = "sending"; this.persist(); this.publish();
    try {
      const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind: "start", request } });
      if (!this.current(scope)) return;
      this.acceptSubmission(request, reply.run);
      return reply.run;
    } catch (error) {
      if (this.current(scope)) {
        // A completed first-attempt rejection plus an authoritative absent record
        // can release this draft. Lost acknowledgements and uncertain retries cannot.
        const submission = (error as { submission?: string } | null)?.submission;
        if (!wasUncertain && submission === "rejected") {
          try {
            const observed = await this.ports.query({ project_root: scope.project, query: { kind: "request", request_id: request.request_id } });
            if (this.current(scope)) {
              if (observed.run) this.acceptSubmission(request, observed.run);
              else this.pending.delete(request.request_id);
            }
          } catch { /* Failed proof remains uncertain. */ }
        }
        const pending = this.pending.get(request.request_id);
        if (pending) pending.state = "uncertain";
        this.error = message(error); this.errorDiagnostic = (error as { diagnostic?: Diagnostic } | null)?.diagnostic ?? null; this.persist(); this.publish();
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
    const request = Symbol(); this.eventRequests.set(id, request);
    const { page } = await this.ports.query({ project_root: scope.project, query: { kind: "events", run_id: id, after, limit: 128 } });
    if (!this.current(scope) || this.eventRequests.get(id) !== request || (this.cursors.get(id) ?? 0) !== after) return;
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
    const request = Symbol(); this.toolRequests.set(id, request);
    const reply = await this.ports.query({ project_root: scope.project, query: { kind: "tools", run_id: id } });
    if (!this.current(scope) || this.toolRequests.get(id) !== request) return;
    if (reply.tools.some(tool => tool.run_id !== id)) throw new Error("Tool receipt identity mismatch.");
    if (bytes(reply.tools) > 512 * 1024) throw new Error("Tool receipt page exceeds its display budget.");
    this.touchRun(id); this.tools.set(id, immutable(clone(reply.tools))); this.publish();
  }
  async controlRun(id: string, kind: "stop" | "reconcile") {
    const scope = this.scope(true), run = this.runs.get(id);
    if (!run || !this.ownsTask(run.request.conversation_id)) throw new Error("This window does not control the run.");
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
  reportError(error: unknown) { this.error = message(error); this.errorDiagnostic = (error as { diagnostic?: Diagnostic } | null)?.diagnostic ?? null; this.publish(); }
  clearError() { this.error = ""; this.errorDiagnostic = null; this.publish(); }
  async observeAssets(id: string) {
    const scope=this.scope();
    const reply=await this.ports.query({project_root:scope.project,query:{kind:"assets",conversation_id:id}});
    if (!this.current(scope)) return;
    if (reply.assets.length>64 || new Set(reply.assets.map(asset=>asset.asset_id)).size!==reply.assets.length) throw new Error("Invalid attachment list.");
    this.assets.set(id,immutable(clone(reply.assets))); this.publish();
  }
  async loadAsset(id: string, assetId: string) {
    const key=`${id}:${assetId}`; if (this.previews.has(key)||this.assetFlights.has(key)) return;
    const scope=this.scope(); if (!this.ports.asset) throw new Error("Attachment previews are unavailable.");
    this.assetFlights.add(key);
    try {
      const preview=await this.ports.asset({project_root:scope.project,conversation_id:id,asset_id:assetId});
      if (!this.current(scope)) { this.ports.releaseAsset?.(preview.url); return; }
      this.previews.set(key,preview); while(this.previews.size>16) { const first=this.previews.keys().next().value!; const removed=this.previews.get(first)!; this.previews.delete(first); this.ports.releaseAsset?.(removed.url); } this.publish();
    } finally { if(this.current(scope)) this.assetFlights.delete(key); }
  }
  async upload(id: string, name: string, mime_type: string, data: string) {
    const scope=this.scope(true); if (!this.canControl(id)) throw new Error("This task is read-only.");
    const draft=this.drafts.get(id); if (!draft) throw new Error("Read this task first.");
    if ((draft.assets?.length??0)>=20) throw new Error("Attach at most 20 files.");
    const asset_id=crypto.randomUUID();
    this.uploads.set(id,(this.uploads.get(id)??0)+1);
    draft.assets=[...(draft.assets??[]),asset_id]; draft.revision++; draft.dirty=true;
    try {
      try { this.persist(true); } catch(error) { draft.assets=draft.assets.filter(value=>value!==asset_id); throw error; }
      this.publish();
      const reply=await this.ports.command({project_root:scope.project,window:scope.window!,command:{kind:"add_asset",conversation_id:id,asset_id,name,mime_type,data}});
      if (!this.current(scope)) return;
      if (reply.asset.asset_id!==asset_id) throw new Error("Attachment acknowledgement identity mismatch.");
      this.assets.set(id,immutable([...(this.assets.get(id)??[]).filter(asset=>asset.asset_id!==asset_id),clone(reply.asset)]));
      this.publish();
    } catch(error) {
      if (this.current(scope)) {
        try { await this.observeAssets(id); } catch { /* Retained identity remains unconfirmed. */ }
        if (this.assets.get(id)?.some(asset=>asset.asset_id===asset_id)) return;
      }
      throw error;
    } finally { if(this.current(scope)) { const count=(this.uploads.get(id)??1)-1; if(count>0)this.uploads.set(id,count);else this.uploads.delete(id); this.persist(); this.publish(); } }
  }
  removeAsset(id: string, assetId: string) {
    if(!this.canControl(id)) throw new Error("This task is read-only.");
    const draft=this.drafts.get(id); if(!draft) return;
    draft.assets=(draft.assets??[]).filter(value=>value!==assetId); draft.revision++; draft.dirty=true; this.persist(); this.publish();
  }
  attachmentsReady(id: string) { const draft=this.drafts.get(id); return !this.uploads.has(id)&&(draft?.assets??[]).every(assetId=>this.assets.get(id)?.some(asset=>asset.asset_id===assetId)); }
  draftContent(id: string): AgentDraftContent { const draft = this.drafts.get(id); return { text: draft?.text ?? "", assets: clone(draft?.assets ?? []), context: clone(this.composer(id).sources) }; }
  commitComposition(id: string, text: string) {
    if(this.conversations.get(id)?.archived) { const draft=this.drafts.get(id); if(draft){draft.text=text;draft.revision++;draft.dirty=true;draft.conflict=this.conversations.get(id)!.draft;this.persist();this.publish();}return; }
    this.editDraft(id, text);
    if (!this.canControl(id)) { const draft = this.drafts.get(id)!; draft.conflict = this.conversations.get(id)?.draft ?? ""; this.persist(); this.publish(); }
  }
  async metadata(id: string, values: { title?: string; archived?: boolean }) {
    const scope = this.scope(true); await this.observeConversation(id); if (!this.current(scope)) return;
    const conversation = this.conversations.get(id); if (!conversation || !this.ownsTask(id)) throw new Error("Take control before changing this task.");
    const command = values.title !== undefined ? { kind: "rename" as const, conversation_id: id, expected_version: conversation.version, title: values.title } : { kind: "archive" as const, conversation_id: id, expected_version: conversation.version, archived: values.archived! };
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command });
    if (this.current(scope)) this.acceptConversation(reply.conversation);
  }
  async decide(runId: string, decisionId: string, allow: boolean) {
    const scope = this.scope(true), run = this.runs.get(runId);
    if (!run || !this.ownsTask(run.request.conversation_id)) throw new Error("Take control before responding.");
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind: "decision", run_id: runId, decision_id: decisionId, allow } });
    if (this.current(scope)) this.acceptRun(reply.run);
  }
  async newTask(profile: ComponentAgentProfile = "workspace", viewId?: string) {
    const scope = this.scope(true), initial = this.ports.initial?.(profile,viewId), id = crypto.randomUUID();
    await this.create(id, "workspace"); if (!this.current(scope)) return;
    this.setComposer(id, { sources: [], grant: { mode: "explain", permission_policy: "ask", session: initial?.session ?? null, documents: [], files: [] } });
    return id;
  }
  async appendContext(id: string, profile: ComponentAgentProfile, viewId?: string) {
    const scope = this.scope(true), initial = this.ports.initial?.(profile, viewId);
    await this.ports.synchronizeContext?.(); if (!this.current(scope)) return;
    if (!this.canControl(id)) throw new Error("This task is read-only.");
    const selections = [...(initial?.sources ?? [])];
    if (profile === "documents") {
      const page = await this.searchSources(id, "editor", "");
      const item = page?.items.find(item => (item.selection.reference as { document?: { document_id?: string } } | null)?.document?.document_id === initial?.documentId);
      if (item) selections.push(item.selection);
      else throw new Error("The selected document is not synchronized yet.");
    }
    for (const selection of selections) {
      const preview = await this.previewSource(id, selection); if (!this.current(scope)) return;
      if (!preview?.snapshot) throw new Error(preview?.error ?? "Source unavailable.");
      this.includeSource(id, preview);
    }
  }
  async prepareContext(profile: ComponentAgentProfile, viewId?: string): Promise<AgentContextSelection[]> {
    const scope = this.scope(true), initial = this.ports.initial?.(profile, viewId);
    await this.ports.synchronizeContext?.(); if (!this.current(scope)) return [];
    const selections = [...(initial?.sources ?? [])];
    if (profile === "documents" && this.ports.sourceSearch) {
      const page = await this.ports.sourceSearch({ project_root: scope.project, window: scope.window!, session: initial?.session ?? null, source: "editor", text: "", limit: 32 });
      if (!this.current(scope)) return [];
      const item = page.items.find(item => (item.selection.reference as {document?:{document_id?:string}} | null)?.document?.document_id === initial?.documentId);
      if (!item) throw new Error("The selected document is not synchronized yet.");
      selections.push(item.selection);
    }
    const prepared: AgentContextSelection[] = [];
    for (const selection of selections) {
      if (!this.ports.sourcePreview) throw new Error("Source preview is unavailable.");
      const preview = await this.ports.sourcePreview({project_root:scope.project,window:scope.window!,session:initial?.session ?? null,selection});
      if (!this.current(scope)) return [];
      if (!preview.snapshot) throw new Error(preview.error ?? "Source unavailable.");
      prepared.push(preview.snapshot.selection);
    }
    return prepared;
  }
  composer(id: string): ComponentComposer {
    return this.composers.get(id) ?? { sources: [], grant: { mode: "explain", permission_policy: "ask", session: null, documents: [], files: [] } };
  }
  setComposer(id: string, composer: ComponentComposer) {
    if (!this.canControl(id)) throw new Error("Take control before changing the request.");
    if (composer.sources.length > 16 || bytes(composer) > 64 * 1024) throw new Error("Select less context.");
    if (!this.composers.has(id) && this.composers.size >= 32) throw new Error("Keep at most 32 local assistant contexts.");
    this.composers.set(id, immutable(draftComposer(composer)));
    const draft = this.drafts.get(id); if (draft) { draft.revision++; draft.dirty = true; }
    this.persist(); this.publish();
  }
  includeSource(id: string, preview: ComponentSourcePreview) {
    const snapshot = preview.snapshot; if (!snapshot) throw new Error(preview.error ?? "Source unavailable.");
    const composer = clone(this.composer(id)), selection = snapshot.selection;
    const index = composer.sources.findIndex(s => sourceIdentity(s) === sourceIdentity(selection));
    if (index >= 0) composer.sources[index] = clone(selection); else composer.sources.push(clone(selection));
    const data = snapshot.native_data;
    for (const evidence of snapshot.evidence) {
      if (evidence.kind === "document") {
        const grant = { document: clone(evidence.document), allow_save: false, path: data && typeof data === "object" && !Array.isArray(data) && typeof data.path === "string" ? data.path : null };
        composer.grant.documents = [...composer.grant.documents.filter(d => d.document.document_id !== grant.document.document_id), grant];
      }
      if (evidence.kind === "file") composer.grant.files = [...composer.grant.files.filter(f => f.path !== evidence.path), { path: evidence.path, sha256: evidence.sha256 }];
    }
    this.setComposer(id, composer);
  }
  removeSource(id: string, index: number) {
    const composer = clone(this.composer(id)), removed = composer.sources.splice(index, 1)[0];
    if (removed?.source === "editor") {
      const ref = removed.reference;
      if (ref && typeof ref === "object" && !Array.isArray(ref)) composer.grant.documents = composer.grant.documents.filter(d => JSON.stringify(d.document) !== JSON.stringify(ref.document));
    }
    if (removed?.source === "files") {
      const ref = removed.reference;
      if (ref && typeof ref === "object" && !Array.isArray(ref)) composer.grant.files = composer.grant.files.filter(f => f.path !== ref.path);
    }
    this.setComposer(id, composer);
  }
  async searchSources(id: string, source: string, text: string): Promise<ComponentSourceSearchResult | null> {
    const scope = this.scope(true);
    if (!this.ports.sourceSearch) throw new Error("Source search is unavailable.");
    const result = await this.ports.sourceSearch({ project_root: scope.project, window: scope.window!, session: this.composer(id).grant.session, source, text, limit: 32 });
    return this.current(scope) ? result : null;
  }
  async previewSource(id: string, selection: AgentContextSelection): Promise<ComponentSourcePreview | null> {
    const scope = this.scope(true);
    if (!this.ports.sourcePreview) throw new Error("Source preview is unavailable.");
    const result = await this.ports.sourcePreview({ project_root: scope.project, window: scope.window!, session: this.composer(id).grant.session, selection });
    return this.current(scope) ? result : null;
  }
  async observeSettings() {
    const scope = this.scope();
    const [settings, diagnostics, credential] = await Promise.all([
      this.ports.query({ project_root: scope.project, query: { kind: "settings" } }),
      this.ports.query({ project_root: scope.project, query: { kind: "diagnostics" } }),
      this.ports.query({ project_root: scope.project, query: { kind: "credential_status" } }),
    ]);
    if (!this.current(scope)) return;
    if (!this.settings || settings.settings.version >= this.settings.version) this.settings = immutable(clone(settings.settings));
    this.diagnostics = clone(diagnostics.diagnostics);
    this.credentialStatus = credential.credential_status ? immutable(clone(credential.credential_status)) : null;
    this.publish();
  }
  async configure(settings: ComponentModelSettings, key = "") {
    const scope = this.scope(true);
    settings = clone(settings);
    if (key) {
      if (!this.ports.credential || !settings.connection) throw new Error("Credential endpoint is unavailable.");
      const result = await this.ports.credential({ project_root: scope.project, window: scope.window!, key });
      if (!this.current(scope)) return;
      settings.connection.credential = result.credential;
    }
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind: "configure", settings } });
    if (this.current(scope)) {
      this.settings = immutable(clone(reply.settings));
      if (key && settings.connection) this.credentialStatus = immutable({ credential: clone(settings.connection.credential), available: true });
      else if (JSON.stringify(this.credentialStatus?.credential) !== JSON.stringify(settings.connection?.credential)) this.credentialStatus = null;
      this.publish();
    }
  }
  async removeCredential() {
    const scope = this.scope(true), settings = this.settings, reference = settings?.connection?.credential;
    if (!settings || !reference || reference.kind === "environment") throw new Error("There is no saved API key to remove.");
    const reply = await this.ports.command({ project_root: scope.project, window: scope.window!, command: {
      kind: "remove_credential", settings_version: settings.version, key_id: reference.key_id,
    } });
    if (this.current(scope)) { this.credentialStatus = immutable(clone(reply.credential_status)); this.publish(); }
  }
  async testModel(kind: "connection" | "images") {
    const scope = this.scope(true);
    if (!this.settings || !this.ports.test) throw new Error("Save model settings first.");
    try {
      const result = await this.ports.test({ project_root: scope.project, window: scope.window!, request_id: crypto.randomUUID(), model_settings_version: this.settings.version, kind });
      if (this.current(scope)) { this.diagnostics = [result.diagnostic, ...this.diagnostics.filter(test => test.request_id !== result.diagnostic.request_id)].slice(0, 16); this.publish(); }
    } catch (error) {
      const existing = (error as { existingRequestId?: string } | null)?.existingRequestId;
      if (existing && this.current(scope)) {
        try {
          const observed = await this.ports.query({ project_root: scope.project, query: { kind: "diagnostic", request_id: existing } });
          if (this.current(scope) && observed.diagnostic) {
            this.diagnostics = [observed.diagnostic, ...this.diagnostics.filter(test => test.request_id !== existing)].slice(0, 16);
            this.publish();
          }
        } catch { /* The original typed busy error remains the result. */ }
      }
      throw error;
    }
  }
  async stopTest(request_id: string) {
    const scope = this.scope(true);
    await this.ports.command({ project_root: scope.project, window: scope.window!, command: { kind: "stop_test", request_id } });
    if (this.current(scope)) await this.observeSettings();
  }
  async send(id: string, continueRun?: string) {
    if (this.sending.has(id)) throw new Error("A submission for this conversation is already in progress.");
    this.sending.add(id);
    try { return await this.sendDraft(id, continueRun); }
    finally { this.sending.delete(id); }
  }
  private async sendDraft(id: string, continueRun?: string) {
    const scope = this.scope(true);
    const draft = this.drafts.get(id), composer = clone(this.composer(id));
    if (!draft || !this.settings?.enabled || !this.settings.connection) throw new Error("Configure a model first.");
    const text = draft.text, revision = draft.revision, settingsVersion = this.settings.version;
    let assets = clone(draft.assets ?? []);
    if (!this.attachmentsReady(id)) throw new Error("Check unfinished attachments before sending.");
    if (!text.trim() && !assets.length) throw new Error("Enter a message or attach a file first.");
    let continuation: ComponentAgentStart["continuation"] = undefined;
    if (continueRun) {
      const run = this.runs.get(continueRun);
      if (!run?.recovery || run.recovery.unresolved_mutations || componentBusy(run)) throw new Error("Check the original run status before continuing.");
      continuation = { run_id: run.run_id, recovery_digest: run.recovery.digest };
      assets = clone(run.request.assets ?? []);
      composer.grant = clone(run.request.grant);
      composer.sources = clone(run.request.sources);
      for (const document of composer.grant.documents) {
        const updated = run.document_versions?.[document.document.document_id];
        if (updated) document.document = clone(updated);
      }
      if (composer.sources.some(s => s.source === "editor")) {
        const page = await this.searchSources(id, "editor", "");
        if (!this.current(scope)) return;
        composer.sources = composer.sources.map(source => {
          if (source.source !== "editor") return source;
          const ref = source.reference as { document?: { document_id?: string } };
          const allowed = composer.grant.documents.find(d => d.document.document_id === ref.document?.document_id);
          const fresh = page?.items.find(item => {
            const reference = item.selection.reference as { document?: unknown };
            return allowed && JSON.stringify(reference.document) === JSON.stringify(allowed.document);
          });
          if (!fresh) throw new Error("The original document changed. Refresh context and start a new request.");
          return { ...fresh.selection, inclusion: source.inclusion };
        });
      }
    } else {
      // A new turn follows the Ask policy shown by the unified composer. Retained
      // grants belong to the new request; prior runs and retries remain frozen.
      composer.grant = draftComposer(composer).grant;
    }
    await this.flushDraft(id);
    if (!this.current(scope)) return;
    const run = await this.start({ conversation_id: id, model_settings_version: settingsVersion, text, ...composer, assets, continuation });
    if (run && this.drafts.get(id)?.revision === revision) { this.editDraft(id, ""); await this.flushDraft(id); }
    if (run) { await this.observeConversation(id); await this.observeHistory(id, this.history.get(id)?.before ?? null); }
    return run;
  }
  override dispose() { for(const preview of this.previews.values())this.ports.releaseAsset?.(preview.url); this.previews.clear(); this.stopped = true; this.generation++; super.dispose(); }
}
