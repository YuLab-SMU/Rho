import { Model, immutable, readonlyMap, readonlySet } from "./shared/model";
import { json, message, operationWorkspaceInstance, sameScope, terminal } from "./shared/ports";
import type { QueryPort, RequestContext, RuntimeTarget } from "./shared/ports";
import type { Notifications } from "./shared/events";
import type { OperationRecord } from "./generated/OperationRecord";
import type { OperationSummary } from "./generated/OperationSummary";
import type { RecentOperations } from "./generated/RecentOperations";
import type { Invocation } from "./generated/Invocation";
import type { Precondition } from "./generated/Precondition";
import type { RunSource } from "./generated/RunSource";
import type { ConsoleState } from "./generated/ConsoleState";
import type { OutboxRecord } from "./generated/OutboxRecord";

export class IncompleteRCodeError extends Error {
  constructor(readonly indent: string) { super("The selected R code is incomplete. Complete the block or run the full file."); }
}
export interface PendingRequest { invocation: Invocation; operationId?: string; ignored?: boolean; error?: string }
interface OperationsPorts {
  context(): RequestContext;
  contextFor?(workspaceInstanceId: string): RequestContext;
  query: QueryPort;
  subscribe(project: string, after: number): Promise<OutboxRecord[]>;
  getOperation(project: string, id: string): Promise<OperationRecord | null>;
  invoke(project: string, invocation: Invocation, accepted?: boolean): Promise<OperationRecord>;
  cancel(project: string, id: string, pending?: boolean): Promise<unknown>;
  execution(workspaceInstanceId?: string): ConsoleState | null;
  changed(): void;
  flush(): Promise<void>;
  unsynced(): boolean;
  syncError(): string;
  notifications: Notifications;
}
interface OperationsSnapshot {
  records: ReadonlyMap<string, OperationRecord>; summaries: ReadonlyMap<string, OperationSummary>;
  pending: readonly Readonly<PendingRequest>[]; unreadable: ReadonlySet<string>;
  recentCursor: number | null; cursor: number; initialized: boolean; error: string; busy: boolean; canRun: boolean; queueing: boolean;
}

/** Authoritative records and event position. Recovery reads identities; it never invokes code. */
export class Operations extends Model<OperationsSnapshot> {
  private recordsMap = new Map<string, OperationRecord>();
  private summariesMap = new Map<string, OperationSummary>();
  private pendingRequests: PendingRequest[] = [];
  private unavailable = new Set<string>();
  private loading = new Map<string, Promise<OperationRecord | null>>();
  private runLocks = new Map<string, symbol>();
  private _cursor = 0;
  private _recentCursor: number | null = null;
  private _initialized = false;
  private checkpointEstablished = false;
  private _error = "";
  private generation = 0;
  private stopped = false;
  private consuming = false;
  private historyLoading: Promise<void> | null = null;
  private views = new Map<string, Operations>();
  constructor(private ports: OperationsPorts) { super(); }
  protected readSnapshot(): OperationsSnapshot {
    return { records: readonlyMap(this.recordsMap), summaries: readonlyMap(this.summariesMap),
      pending: Object.freeze(this.pendingRequests.map((p) => immutable(structuredClone(p)))),
      unreadable: readonlySet(this.unavailable), recentCursor: this._recentCursor, cursor: this._cursor,
      initialized: this._initialized, error: this._error, busy: this.busy, canRun: this.canRun, queueing: this.queueing };
  }
  get records() { return this.getSnapshot().records; }
  get summaries() { return this.getSnapshot().summaries; }
  get pending() { return this.getSnapshot().pending; }
  get recentCursor() { return this._recentCursor; }
  get initialized() { return this._initialized; }
  get eventCursor() { return this._cursor; }
  getRecord = (id: string) => this.recordsMap.get(id);
  getSummary = (id: string) => this.summariesMap.get(id);
  get busy() { return this.pendingRequests.some((p) => !p.error && !p.ignored) || [...this.recordsMap.values()].some((r) => !terminal(r.status)); }
  get canRun() {
    return this.canRunIn();
  }
  canRunIn(id?: string) {
    const context = id && this.ports.contextFor ? this.ports.contextFor(id) : this.ports.context();
    return !this.runLocks.has(id ?? context.workspaceInstanceId ?? "main") && !!context.project && context.connected && context.ready !== false && ["idle", "busy"].includes(context.runtimeState ?? "") &&
      (this.ports.execution(id)?.pending.length ?? 0) < 32 && context.capabilities.includes("workspace.run_r");
  }
  get queueing() { return this.queueingIn(); }
  queueingIn(id?: string) { const state = this.ports.execution(id), scope = id && this.ports.contextFor ? this.ports.contextFor(id) : this.ports.context();
    return !!state?.current || !!state?.pause || !!state?.pending.length || scope.runtimeState === "busy"; }
  /** A read/command projection of this owner, with no independent records or request identities. */
  forInstance(id: string): Operations {
    const existing = this.views.get(id); if (existing) return existing;
    let previous: Readonly<OperationsSnapshot> | undefined, snapshot: Readonly<OperationsSnapshot>;
    const belongs = (record: OperationRecord) => operationWorkspaceInstance(record) === id || (id === "main" && operationWorkspaceInstance(record) === undefined);
    const getSnapshot = () => {
      const current = this.getSnapshot();
      if (previous !== current) {
        previous = current;
        snapshot = Object.freeze({ ...current, records: readonlyMap(new Map([...current.records].filter(([, record]) => belongs(record)))),
          pending: Object.freeze(current.pending.filter((pending) => {
            const args = pending.invocation.arguments;
            const target = args && typeof args === "object" && !Array.isArray(args) ? args.workspace_instance_id : undefined;
            return target === id || (target === undefined && id === "main");
          })), canRun: this.canRunIn(id), queueing: this.queueingIn(id) });
      }
      return snapshot;
    };
    const view = new Proxy(this, { get: (owner, property) => {
      if (property === "getSnapshot") return getSnapshot;
      if (property === "records" || property === "pending") return getSnapshot()[property];
      if (property === "canRun") return owner.canRunIn(id);
      if (property === "queueing") return owner.queueingIn(id);
      if (property === "cancel") return (operationId?: string, pending = false) => owner.cancel(operationId, pending, id);
      if (property === "run") return (code: string, source?: RunSource, target?: RuntimeTarget) => owner.run(code, source, target, id);
      const value = Reflect.get(owner, property, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    } });
    this.views.set(id, view); return view;
  }
  refreshAdmission() { this.publish(); }
  serialize() { return { pending: this.pendingRequests }; }
  restore(value: unknown) {
    const data = value as { pending?: unknown[] } | null;
    this.pendingRequests = [];
    for (const entry of data?.pending ?? []) {
      const p = entry as Partial<PendingRequest> | null;
      if (!p?.invocation || typeof p.invocation.client_request_id !== "string" || typeof p.invocation.capability?.id !== "string") continue;
      this.pendingRequests.push({ ...structuredClone(p as PendingRequest), error: "The request is unconfirmed. Refresh does not replay it." });
    }
    // The old persisted event cursor intentionally has no reader.
    this.publish();
  }
  reset() {
    this.generation++; this.stopped = false;
    this.recordsMap.clear(); this.summariesMap.clear(); this.unavailable.clear(); this.loading.clear(); this.runLocks.clear();
    this.pendingRequests = []; this._cursor = 0; this._recentCursor = null; this._initialized = false; this.checkpointEstablished = false;
    this._error = ""; this.consuming = false; this.historyLoading = null; this.publish();
  }
  sessionChanged() {
    this.generation++; this.loading.clear(); this.runLocks.clear(); this.consuming = false; this.historyLoading = null;
    let changed = false;
    for (const pending of this.pendingRequests) if (!pending.error) {
      pending.error = "The session changed while this request was unconfirmed. Check the original request; code is not replayed.";
      changed = true;
    }
    if (changed) this.ports.changed();
    this.publish();
  }
  async ensureReferences(ids: readonly string[]) {
    for (const id of ids) if (!this.recordsMap.has(id) || !this.summariesMap.has(id)) await this.ensureOperation(id);
  }
  private guard(scope: RequestContext, generation: number) {
    return !this.stopped && generation === this.generation && sameScope(scope, this.ports.context());
  }
  async beginBaseline() {
    if (this.checkpointEstablished) return;
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project) return;
    const result = await this.ports.query(scope.project, "operation.events_checkpoint");
    if (!this.guard(scope, generation)) return;
    const sequence = (result.data as { sequence?: unknown } | null)?.sequence;
    if (result.status !== "ready" || !Number.isSafeInteger(sequence) || Number(sequence) < 0)
      throw new Error("Operation event checkpoint is unavailable or invalid");
    this._cursor = Number(sequence); this._initialized = false; this.checkpointEstablished = true; this.publish();
  }
  finishBaseline() { this._initialized = true; this.publish(); }
  async initialize(references: readonly string[] = []) {
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project || this._initialized || !this.guard(scope, generation)) return;
    await this.beginBaseline();
    if (!this.guard(scope, generation)) return;
    await this.loadRecent();
    if (!this.guard(scope, generation)) return;
    await this.reconcilePending();
    if (!this.guard(scope, generation)) return;
    await this.ensureReferences(references);
    if (this.guard(scope, generation)) this.finishBaseline();
  }
  async listRecent(before: number | null, limit = 30): Promise<RecentOperations> {
    return this.querySummaries({ before_cursor: before, limit });
  }
  private async querySummaries(args: unknown): Promise<RecentOperations> {
    const scope = this.ports.context(), generation = this.generation;
    if (!this.guard(scope, generation)) throw new Error("Client stopped reading operations");
    if (!scope.project) return { operations: [], next_cursor: null };
    const result = await this.ports.query(scope.project, "operation.list_recent", args);
    if (!this.guard(scope, generation)) throw new Error("Operation observation superseded by client lifecycle");
    const data = result.data as RecentOperations | null;
    if (result.status !== "ready" || !data || !Array.isArray(data.operations) ||
      !(data.next_cursor === null || Number.isSafeInteger(data.next_cursor)))
      throw new Error(result.notices.join("\n") || "Invalid operation summary page");
    for (const summary of data.operations) {
      if (!Number.isSafeInteger(summary.cursor) || summary.cursor < 0 || typeof summary.operation_id !== "string" || typeof summary.capability?.id !== "string")
        throw new Error("Invalid operation sorting identity");
    }
    let changed = false;
    for (const summary of data.operations) {
      const previous = this.summariesMap.get(summary.operation_id);
      if (previous && JSON.stringify(previous) === JSON.stringify(summary)) continue;
      changed = true;
      this.summariesMap.set(summary.operation_id, immutable(summary));
      const record = this.recordsMap.get(summary.operation_id);
      if (record) this.ports.notifications.send("operationChanged", { epoch: scope.epoch, project: scope.project,
        operationId: summary.operation_id, capability: record.operation.capability.id, status: record.status, cursor: summary.cursor,
        workspaceInstanceId: operationWorkspaceInstance(record) });
    }
    if (changed) this.publish();
    return data;
  }
  async loadRecent(older = false) {
    if (this.historyLoading) return this.historyLoading;
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project) return;
    const task = (async () => {
      const page = await this.listRecent(older ? this._recentCursor : null);
      for (const summary of [...page.operations].reverse()) {
        if (!this.guard(scope, generation)) return;
        await this.ensureOperation(summary.operation_id);
      }
      if (this.guard(scope, generation)) {
        if (older || this._recentCursor === null) this._recentCursor = page.next_cursor;
        this.publish();
      }
    })();
    this.historyLoading = task;
    try { await task; } finally { if (this.historyLoading === task) this.historyLoading = null; }
  }
  ensureOperation = async (id: string): Promise<OperationRecord | null> => {
    const existing = this.loading.get(id);
    if (existing) return existing;
    const scope = this.ports.context(), generation = this.generation;
    if (!this.guard(scope, generation)) throw new Error("Client stopped reading operations");
    if (!scope.project) return null;
    const task = (async () => {
      const record = await this.ports.getOperation(scope.project!, id);
      if (!this.guard(scope, generation)) throw new Error("Operation observation superseded by client lifecycle");
      if (record === null) {
        const capability = this.recordsMap.get(id)?.operation.capability.id ?? this.summariesMap.get(id)?.capability.id;
        this.unavailable.add(id); this.recordsMap.delete(id); this.publish();
        if (capability) this.ports.notifications.send("operationChanged", { epoch: scope.epoch, project: scope.project!,
          operationId: id, capability, status: "unreadable", cursor: this.summariesMap.get(id)?.cursor ?? null });
        return null;
      }
      if (!record || record.operation?.operation_id !== id || record.operation.idempotency_scope !== scope.project ||
        !["accepted", "running", "reconciling", "succeeded", "failed", "cancelled", "uncertain"].includes(record.status))
        throw new Error("Operation record identity does not match");
      if (!this.summariesMap.has(id)) {
        const page = await this.querySummaries({ operation_id: id, limit: 1 });
        if (page.operations.length !== 1 || page.operations[0].operation_id !== id) throw new Error("Operation sorting identity is unavailable");
      }
      if (!this.guard(scope, generation)) throw new Error("Operation observation superseded by client lifecycle");
      this.accept(record, scope);
      return record;
    })();
    this.loading.set(id, task);
    try { return await task; } finally { if (this.loading.get(id) === task) this.loading.delete(id); }
  };
  private accept(record: OperationRecord, scope: RequestContext) {
    const id = record.operation.operation_id, previous = this.recordsMap.get(id);
    if (previous && (previous.updated_at_ms > record.updated_at_ms || (terminal(previous.status) && !terminal(record.status)))) return;
    this.unavailable.delete(id);
    this.recordsMap.set(id, immutable(record));
    const pending = this.pendingRequests.find((p) => p.invocation.client_request_id === record.operation.client_request_id);
    if (pending) {
      this.pendingRequests = this.pendingRequests.filter((p) => p !== pending);
      this.ports.changed();
    }
    if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) {
      this.ports.notifications.send("operationChanged", { epoch: scope.epoch, project: scope.project!, operationId: id,
        capability: record.operation.capability.id, status: record.status, cursor: this.summariesMap.get(id)?.cursor ?? null,
        workspaceInstanceId: operationWorkspaceInstance(record) });
      this.publish();
    } else if (pending) this.publish();
  }
  async consumeEvents(): Promise<boolean> {
    if (!this._initialized || this.consuming) return false;
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project) return false;
    this.consuming = true;
    try {
      let backlog = false;
      for (let count = 0; count < 2; count++) {
        const page = await this.ports.subscribe(scope.project, this._cursor);
        if (!this.guard(scope, generation)) return false;
        if (!Array.isArray(page) || page.length > 100 || page.some((e) => !Number.isSafeInteger(e.sequence) || e.sequence < 0 || typeof e.operation_id !== "string"))
          throw new Error("Invalid operation event page");
        const fresh = page.filter((e) => e.sequence > this._cursor);
        for (const id of new Set(fresh.map((e) => e.operation_id))) {
          // A read started before this event may be stale. Finish it, then observe anew.
          const underway = this.loading.get(id);
          if (underway) await underway;
          await this.ensureOperation(id);
          if (!this.guard(scope, generation)) return false;
        }
        // Neither parse errors nor a partially processed page can advance this cursor.
        if (fresh.length) this._cursor = Math.max(...fresh.map((e) => e.sequence), this._cursor);
        backlog = page.length === 100 && fresh.length > 0;
        const changed = fresh.length > 0 || !!this._error;
        this._error = ""; if (changed) this.publish();
        if (!backlog) break;
      }
      return backlog;
    } catch (error) {
      if (this.guard(scope, generation)) { this._error = message(error); this.publish(); }
      throw error;
    } finally {
      if (this.guard(scope, generation)) this.consuming = false;
    }
  }
  async reconcilePending() {
    const scope = this.ports.context(), generation = this.generation;
    for (const pending of [...this.pendingRequests]) {
      if (!this.guard(scope, generation)) return;
      if (pending.operationId) await this.ensureOperation(pending.operationId);
      else {
        const result = await this.querySummaries({ client_request_id: pending.invocation.client_request_id, limit: 1 });
        const summary = result.operations[0];
        if (summary) await this.ensureOperation(summary.operation_id);
      }
    }
  }
  async invoke(id: string, args: unknown, preconditions: Precondition[] = []): Promise<OperationRecord> {
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project) throw new Error("Open a project first");
    if (new TextEncoder().encode(JSON.stringify(args)).length > 256 * 1024)
      throw new Error("Arguments exceed 256 KiB. Nothing was submitted; your draft is retained.");
    const request: PendingRequest = { invocation: { client_request_id: crypto.randomUUID(), capability: { id, version: 1 }, arguments: json(args), preconditions } };
    if (new TextEncoder().encode(JSON.stringify({ project_root: scope.project, frame: { id: crypto.randomUUID(), request: { method: "invoke", params: request.invocation } } })).length > 272 * 1024)
      throw new Error("The request exceeds 272 KiB. Nothing was submitted; your draft is retained.");
    this.pendingRequests.push(request); this.ports.changed(); this.publish();
    await this.ports.flush();
    if (!this.guard(scope, generation)) throw new Error("The client changed before request submission");
    if (this.ports.unsynced()) {
      this.pendingRequests = this.pendingRequests.filter((p) => p !== request);
      this.ports.changed(); this.publish();
      throw new Error(`Request was not submitted: ${this.ports.syncError()}`);
    }
    try {
      const record = await this.ports.invoke(scope.project, request.invocation, id === "workspace.run_r");
      if (!this.guard(scope, generation)) throw new Error("Request accepted in a previous client lifecycle; check its original identity");
      if (!record || record.operation?.client_request_id !== request.invocation.client_request_id || record.operation.idempotency_scope !== scope.project)
        throw new Error("The returned request identity does not match");
      request.operationId = record.operation.operation_id;
      this.ports.changed();
      // Return the authoritative write reply even if a read outage delays display ordering.
      this.accept(record, scope);
      try { await this.ensureOperation(record.operation.operation_id); } catch { /* The event/recovery lane retries reads only. */ }
      return record;
    } catch (error) {
      if (this.guard(scope, generation)) { request.error = message(error); this.ports.changed(); this.publish(); }
      throw error;
    }
  }
  async retryPending(value: Readonly<PendingRequest>) {
    const request = this.pendingRequests.find((p) => p.invocation.client_request_id === value.invocation.client_request_id);
    if (!request) return;
    const scope = this.ports.context(), generation = this.generation;
    if (!scope.project || !scope.connected) throw new Error("Host Unavailable");
    await this.reconcilePending();
    if (!this.guard(scope, generation) || !this.pendingRequests.includes(request)) return;
    request.error = undefined; request.ignored = false; this.ports.changed(); this.publish();
    await this.ports.flush();
    if (!this.guard(scope, generation) || this.ports.unsynced()) throw new Error(this.ports.syncError() || "Request identity is not synchronized");
    try {
      const record = await this.ports.invoke(scope.project, request.invocation, request.invocation.capability.id === "workspace.run_r");
      if (this.guard(scope, generation)) { this.accept(record, scope); await this.ensureOperation(record.operation.operation_id); }
    } catch (error) {
      if (this.guard(scope, generation)) { request.error = message(error); this.ports.changed(); this.publish(); }
      throw error;
    }
  }
  private async preflightRun(scope: RequestContext, instanceId: string | undefined, code: string) {
    if (!scope.project) throw new Error("R is reconnecting/unavailable.");
    const args = instanceId ? { code, workspace_instance_id: instanceId } : { code };
    let result: Awaited<ReturnType<QueryPort>>;
    try { result = await this.ports.query(scope.project, "workspace.check_code", args); }
    catch { throw new Error("R is reconnecting/unavailable. Code was not submitted."); }
    if (result.status === "busy") throw new Error("R is busy. Code could not be checked and was not queued. Try again when R is idle.");
    if (result.status !== "ready" || result.completeness !== "complete" || !result.data || typeof result.data !== "object" || Array.isArray(result.data))
      throw new Error("R is reconnecting/unavailable. Code was not submitted.");
    const { status, indent } = result.data as { status?: unknown; indent?: unknown };
    if (status === "incomplete") throw new IncompleteRCodeError(typeof indent === "string" ? indent : "");
    if (status === "invalid" || status === "error") throw new Error("R parser rejected the selected code.");
    if (status !== "complete") throw new Error("R is reconnecting/unavailable. Code was not submitted.");
  }
  async run(code: string, source: RunSource = { view_id: "console", label: "Console", kind: "console" }, target?: RuntimeTarget, instanceId?: string, prepare?: () => Promise<void>) {
    instanceId = target?.workspaceInstanceId ?? instanceId ?? this.ports.context().workspaceInstanceId;
    const scope = instanceId && this.ports.contextFor ? this.ports.contextFor(instanceId) : this.ports.context();
    const lockId = instanceId ?? "main";
    if (this.runLocks.has(lockId)) throw new Error("A run is already being submitted for this R session.");
    if (!this.canRunIn(instanceId) || !code.trim()) throw new Error((this.ports.execution(instanceId)?.pending.length ?? 0) >= 32 ? "Queue full (32 pending runs). Your input is retained." : "R is unavailable. Your input is retained.");
    if (code.includes("\0")) throw new Error("R code cannot contain NUL.");
    if (target && target.nativeSessionId !== scope.session) throw new Error("The captured R session changed. The saved code was not submitted.");
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation && sameScope(scope,
      instanceId && this.ports.contextFor ? this.ports.contextFor(instanceId) : this.ports.context(), true);
    const token = Symbol(lockId); this.runLocks.set(lockId, token); this.publish();
    try {
      await this.preflightRun(scope, instanceId, code);
      if (!current()) throw new Error("The project or R session changed. The code was not submitted.");
      await prepare?.();
      if (!current()) throw new Error("The project or R session changed. The code was not submitted.");
      const session = target?.nativeSessionId ?? this.ports.execution(instanceId)?.session_id ?? scope.session;
      const record = await this.invoke("workspace.run_r", { code, output_mode: "console", source, ...(instanceId ? { workspace_instance_id: instanceId } : {}) },
        session ? [{ kind: "workspace.session", subject: "active", expected: session }] : []);
      if (record.status === "failed" && record.output === null) throw new Error(record.error ?? "Run was rejected");
      return record;
    } finally {
      if (this.runLocks.get(lockId) === token) { this.runLocks.delete(lockId); this.publish(); }
    }
  }
  reviewOperation(id: string) { return this.ensureOperation(id); }
  async cancel(id?: string, onlyPending = false, workspaceInstanceId?: string) {
    const scope = this.ports.context();
    const target = workspaceInstanceId ?? scope.workspaceInstanceId;
    id ??= this.ports.execution(target)?.current?.operation_id ?? [...this.recordsMap.values()].find((r) => r.status === "running" && r.operation.capability.id === "workspace.run_r" &&
      (target ? operationWorkspaceInstance(r) === target : r.operation.target.identity === scope.session))?.operation.operation_id;
    if (scope.project && id) await this.ports.cancel(scope.project, id, onlyPending);
  }
  stop() { this.stopped = true; this.generation++; this.loading.clear(); this.runLocks.clear(); this.consuming = false; this.publish(); }
}
