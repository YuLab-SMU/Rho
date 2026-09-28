/** Console scientific semantics use public R messages and original Operations. */
import type { InstanceRef, JsonValue, ProviderBinding } from "../public/plugin-protocol/index.js";
import type { ConsoleState, OutputEvent, OutputEvents, REventsObservation, RunSource } from "../public/r-protocol/index.js";
import { isResourceReference, operationRequestId, readResource, sameResource, type PluginViewClient, type ResourceReference } from "../public/plugin-ui/index.js";

export interface QueueObservation {
  console: ConsoleState; awaiting_commit: string[]; pending_cancellations?: string[]; accepting: boolean; capacity: number;
}
export interface Session { state: string; session_id: string | null; queue_target: string; }
export interface Submission { request: string; code: string; session: string; view: string; }
export interface SavedState {
  input: string; anchor: number; head: number; hiddenBefore: number; follow: boolean; scrollTop: number;
  history: string[]; submission: Submission | null; clearPositions: Record<string, number>;
}
export interface Run {
  id: string; accepted: number; status: string; cancellationRequested: boolean; code: string;
  source: RunSource | null; session: string; events: OutputEvent[]; cursor: number; notices: string[];
  retained: ResourceReference | null; retainedLoaded: boolean; record: Record<string, any>;
}
export const key = (id: string, version = 1) => ({ id, version });
export const json = (value: unknown) => value as JsonValue;
export const sameOwner = (a: InstanceRef, b: InstanceRef) => !!a && !!b &&
  a.instance === b.instance && a.plugin === b.plugin && a.revision === b.revision && a.artifact === b.artifact;
export const terminal = (status: string) => ["succeeded", "failed", "cancelled", "uncertain"].includes(status);
const object = (value: unknown): Record<string, any> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export function validateCode(code: string) {
  if (!code.trim() || bytes(code) > 262144 || code.includes("\0")) throw new Error("Enter 1–262144 UTF-8 bytes of R code without NUL.");
}
export function initialState(value: unknown): SavedState {
  const saved = object(value) ?? {}, input = typeof saved.input === "string" ? saved.input : "";
  return { input, anchor: Math.max(0, Math.min(saved.anchor || 0, input.length)), head: Math.max(0, Math.min(saved.head || 0, input.length)),
    hiddenBefore: saved.hiddenBefore || 0, follow: saved.follow !== false, scrollTop: saved.scrollTop || 0,
    history: Array.isArray(saved.history) ? saved.history.filter((item: unknown) => typeof item === "string") : [], submission: saved.submission ?? null,
    clearPositions: object(saved.clearPositions) ?? {} };
}
export function visibleRun(run: Run, state: SavedState): { events: OutputEvent[]; showCode: boolean } | null {
  if (run.accepted >= state.hiddenBefore) return { events: run.events, showCode: true };
  if (!Object.hasOwn(state.clearPositions, run.id)) return null;
  const events = run.events.filter(event => event.sequence > state.clearPositions[run.id]!);
  return events.length ? { events, showCode: false } : null;
}
export function addHistory(history: string[], code: string): string[] {
  const result = history.at(-1) === code ? [...history] : [...history, code];
  let total = result.reduce((n, text) => n + bytes(text), 0);
  while (result.length && (result.length > 100 || total > 131072)) total -= bytes(result.shift()!);
  return result;
}
export function runFrom(value: unknown, owner: InstanceRef, previous?: Run): Run | null {
  const record = object(value), operation = object(record?.operation), args = object(operation?.normalized_arguments);
  if (!operation || operation.capability?.id !== "r.execute" || ![1, 2].includes(operation.capability.version) || !sameOwner(args?.binding?.provider, owner)) return null;
  const id = operation.operation_id, session = args?.arguments?.expected_session, run = operation.capability.version === 2 ? args?.arguments?.run : args?.arguments;
  if (typeof id !== "string" || typeof session !== "string" || typeof run?.code !== "string" || !Number.isSafeInteger(operation.accepted_at_ms)) throw new Error("Original R execution identity is incomplete.");
  const output = object(record?.output);
  let retained: ResourceReference | null = null;
  if (output && terminal(record!.status)) {
    if (output.operation_id !== id) throw new Error("R result does not match its original Operation.");
    if (output.started === false) {
      if (record!.status !== "cancelled" || Object.keys(output).length !== 2) throw new Error("Invalid pre-start cancellation result.");
    } else {
      if (output.session_id !== session || !isResourceReference(output.events) || !sameOwner(output.events.owner, owner) || output.events.media_type !== "application/json")
        throw new Error("Retained R events have a different session or owner.");
      if (operation.capability.version === 2) {
        const expected = run.source ?? null, actual = output.source ?? null;
        if (expected === null ? actual !== null : !actual || ["view_id", "label", "kind"].some(field => expected[field] !== actual[field]))
          throw new Error("R output source differs from the original input label.");
      }
      retained = output.events;
    }
  }
  if (previous && (previous.id !== id || previous.session !== session || previous.code !== run.code)) throw new Error("Original R execution changed identity or code.");
  return { id, session, code: run.code, source: run.source ?? null, accepted: operation.accepted_at_ms,
    status: record!.status, cancellationRequested: record!.cancellation_requested === true, record: record!,
    events: previous?.events ?? [], cursor: previous?.cursor ?? 0, notices: previous?.notices ?? [],
    retained, retainedLoaded: previous?.retainedLoaded === true && !!previous.retained && !!retained && sameResource(previous.retained, retained) };
}
export function mergeEvents(run: Run, output: OutputEvents): void {
  if (output.operation_id !== run.id || !Array.isArray(output.events) || !Number.isSafeInteger(output.next_sequence)) throw new Error("R event page has a different producing Operation.");
  const retained = new Map(run.events.map(event => [event.sequence, event]));
  let prior = 0, added = false;
  for (const event of output.events) {
    if (event.operation_id !== run.id || !Number.isSafeInteger(event.sequence) || event.sequence <= prior || event.sequence > output.next_sequence)
      throw new Error("R output events are out of order or have a foreign identity.");
    prior = event.sequence;
    const original = retained.get(event.sequence);
    if (original && JSON.stringify(original) !== JSON.stringify(event)) throw new Error("An observed R event changed its content.");
    if (!original) added = true;
    retained.set(event.sequence, event);
  }
  const events = [...retained.values()].sort((a, b) => a.sequence - b.sequence);
  let total = events.reduce((n, event) => n + bytes(event.text ?? ""), 0);
  let clipped = false;
  while (events.length > 4096 || total > 2097152) { total -= bytes(events.shift()!.text ?? ""); clipped = true; }
  if (added || clipped) run.events = events;
  run.cursor = Math.max(run.cursor, output.next_sequence);
  run.notices = [...new Set([...run.notices, ...(output.notices ?? []),
    ...(output.gap ? ["The native stream has a gap; this view is partial."] : []),
    ...(output.truncated || clipped ? ["Output is truncated in this view; inspect the original retained result."] : [])])];
}

export class ConsoleModel {
  readonly state: SavedState;
  session: Session | null = null;
  queue: QueueObservation | null = null;
  liveAvailable = false;
  runs = new Map<string, Run>();
  cursor: number | null = null;
  historyLoaded = false;
  historyLimited = false;
  private disposed = false;
  private refreshing: Promise<void> | null = null;
  private abort = new AbortController();
  constructor(readonly client: PluginViewClient, readonly source: InstanceRef) { this.state = initialState(client.view.state); }
  binding(id: string, version = 1, target: string | null = null): ProviderBinding {
    return { capability: key(id, version), provider: this.source, project: this.client.view.project, target };
  }
  async query<T>(id: string, args: unknown, target: string | null = null): Promise<T> {
    const result = await this.client.query<{ data?: T }>(key(id), json({ binding: this.binding(id, 1, target), arguments: args }));
    if (result.data === undefined || result.data === null) throw new Error(`${id} is unavailable.`);
    return result.data;
  }
  async control(id: string, args: unknown, target: string) {
    return this.client.control(key(id), json({ binding: this.binding(id, 1, target), arguments: args }));
  }
  save() { return this.client.setState(json(this.state)); }
  clearView() {
    const runs = [...this.runs.values()];
    this.state.hiddenBefore = Math.max(Date.now(), ...runs.map(run => run.accepted + 1));
    this.state.clearPositions = Object.fromEntries(runs.filter(run => !terminal(run.status)).map(run => [run.id, run.cursor]));
  }
  showHistory() { this.state.hiddenBefore = 0; this.state.clearPositions = {}; }
  async startSession() {
    return this.client.invoke(key("r.create_session"), json({ binding: this.binding("r.create_session"), arguments: {} }));
  }
  async submit(retry = false) {
    let submission = this.state.submission;
    if (submission && !retry) throw new Error("Inspect or retry the previous unconfirmed submission before sending another command.");
    if (!submission) {
      validateCode(this.state.input);
      if (!this.liveAvailable) throw new Error("Observe this R instance before submitting a new command.");
      if (!this.session?.session_id) throw new Error("Start this R instance before submitting code.");
      submission = { request: crypto.randomUUID(), code: this.state.input, session: this.session.session_id, view: this.client.view.view };
      this.state.submission = submission;
    }
    const captured = submission;
    if (captured.view !== this.client.view.view) throw new Error("This unconfirmed submission belongs to another view. Inspect its original Operation; copying view state cannot retry that run.");
    // Retrying a failed state write still has to retain this identity before
    // execution. A retry must not bypass the failed capture step.
    await this.save();
    const record = await this.client.invoke(key("r.execute", 2), json({ binding: this.binding("r.execute", 2, captured.session),
      arguments: { expected_session: captured.session, run: { code: captured.code, output_mode: "console",
        source: { view_id: captured.view, label: "Console", kind: "console" } } } }), { requestId: captured.request });
    const run = runFrom(record, this.source);
    if (!run || run.code !== captured.code || run.session !== captured.session || run.source?.view_id !== captured.view)
      throw new Error("Submission acknowledgement is not the original R run.");
    await this.acceptSubmission(captured, run);
    return run;
  }
  /** The bounded journal page supplies candidates only. A complete exact record
   * confirms admission; missing evidence never authorizes another submission. */
  async recoverSubmission() {
    const captured = structuredClone(this.state.submission);
    if (!captured) throw new Error("There is no unconfirmed Console submission.");
    validateCode(captured.code);
    const original = await operationRequestId(captured.view, captured.request);
    const page = await this.client.query<{ status: string; completeness: string; data?: { operations?: { operation_id: string }[]; next_cursor: number | null } }>(
      key("operation.list_recent"), { client_request_id: original, limit: 2 });
    if (page.status !== "ready" || !["complete", "partial"].includes(page.completeness) || !Array.isArray(page.data?.operations) || page.data.operations.length !== 1 || page.data.next_cursor !== null)
      throw new Error("No unique original run is confirmed. The saved submission remains available for inspection.");
    const id = page.data.operations[0]!.operation_id;
    if (typeof id !== "string" || !id) throw new Error("The original run identity is unavailable. The saved submission remains unconfirmed.");
    const reply = await this.client.query<{ status: string; completeness: string; data?: { record?: unknown } }>(key("operation.get"), { operation_id: id });
    if (reply.status !== "ready" || reply.completeness !== "complete" || !reply.data?.record)
      throw new Error("The original run is unavailable. The saved submission remains unconfirmed.");
    const record = object(reply.data.record), operation = object(record?.operation);
    const expected = { binding: this.binding("r.execute", 2, captured.session), arguments: {
      expected_session: captured.session, run: { code: captured.code, output_mode: "console",
        source: { view_id: captured.view, label: "Console", kind: "console" } } }, preconditions: null };
    if (!operation || operation.operation_id !== id || operation.caller?.kind !== "plugin" || operation.caller.id !== captured.view ||
      operation.client_request_id !== original || canonical(operation.capability) !== canonical(key("r.execute", 2)) ||
      canonical(operation.normalized_arguments) !== canonical(expected) || canonical(operation.preconditions) !== "[]" ||
      !["accepted", "running", "reconciling", "succeeded", "failed", "cancelled", "uncertain"].includes(record!.status))
      throw new Error("The observed Operation does not match the original Console submission.");
    const run = runFrom(record, this.source, this.runs.get(id));
    if (!run) throw new Error("The original R provider differs from this Console.");
    await this.acceptSubmission(captured, run);
    return run;
  }
  private async acceptSubmission(captured: Submission, run: Run) {
    if (canonical(this.state.submission) !== canonical(captured)) throw new Error("The saved submission changed while its original run was being inspected.");
    this.runs.set(run.id, run);
    this.state.history = addHistory(this.state.history, captured.code);
    if (this.state.input === captured.code) { this.state.input = ""; this.state.anchor = this.state.head = 0; }
    this.state.submission = null;
    try { await this.save(); }
    catch (error) {
      // The original request must remain inspectable if acknowledgement state
      // could not be saved. Preserve any newer input while keeping that identity.
      if (this.state.submission === null) this.state.submission = captured;
      throw error;
    }
  }
  async cancel(id: string, pending: boolean) {
    return this.client.control(key("operation.request_cancellation"), { operation_id: id, only_if_pending: pending });
  }
  async queueControl(pause: boolean) {
    const queue = this.queue;
    if (!queue) throw new Error("Observe the native queue first.");
    const ids = [...new Set([queue.console.current?.operation_id, queue.console.pause?.operation_id,
      ...queue.console.pending.map(run => run.operation_id), ...queue.awaiting_commit].filter((id): id is string => !!id))];
    return this.control(pause ? "r.pause_queue" : "r.resume_queue", { session_id: queue.console.session_id,
      pause_id: queue.console.pause?.id ?? null, only_operation_ids: ids.length ? ids : null }, queue.console.session_id);
  }
  async respond(request: NonNullable<ConsoleState["input"]>, value: string) {
    if (this.queue?.console.input?.request_id !== request.request_id || request.submitted) throw new Error("Observe the current R input request before answering.");
    if (bytes(value) > 65536 || value.includes("\0")) throw new Error("Input must contain at most 65536 UTF-8 bytes without NUL.");
    // Answer values and reply identities never enter persisted state or history.
    return this.control("r.respond_input", { session_id: request.session_id, operation_id: request.operation_id,
      request_id: request.request_id, reply_id: crypto.randomUUID(), value }, request.session_id);
  }
  async inspect(id: string) {
    const result = await this.client.query<{ data?: { record?: unknown } }>(key("operation.get"), { operation_id: id });
    if (!result.data?.record) throw new Error("The original Operation is unavailable.");
    const run = runFrom(result.data.record, this.source, this.runs.get(id));
    if (run) this.runs.set(run.id, run);
    return run;
  }
  async history(older = false) {
    // An exhausted cursor must never restart pagination at the newest page.
    // Keep recent/live runs in view when the bounded transcript fills up.
    if (older && this.historyLoaded && (this.cursor === null || this.historyLimited)) return;
    let before = older ? this.cursor : null, matching = 0;
    // View-state writes share the journal. Read a bounded set of pages so a
    // reopened Console can find R runs behind those unrelated records.
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const page = await this.client.query<{ data?: { operations: { operation_id: string; capability: { id: string; version: number } }[]; next_cursor: number | null } }>(
        key("operation.list_recent"), { limit: 25, before_cursor: before });
      if (!page.data) throw new Error("Operation history is unavailable.");
      for (const item of page.data.operations) if (item.capability.id === "r.execute" && [1, 2].includes(item.capability.version)) {
        if (await this.inspect(item.operation_id)) matching++;
      }
      before = page.data.next_cursor;
      if (before === null || matching >= 25) break;
    }
    if (older || !this.historyLoaded) this.cursor = before;
    this.historyLoaded = true;
    const ordered = [...this.runs.values()].filter(run => terminal(run.status))
      .sort((a, b) => a.accepted - b.accepted || a.id.localeCompare(b.id));
    const remove = ordered.slice(0, Math.max(0, ordered.length - 100));
    for (const run of remove) this.runs.delete(run.id);
    this.historyLimited = ordered.length >= 100;
  }
  async events(run: Run) {
    if (run.retained && !run.retainedLoaded) {
      const bytes = await readResource(this.client, run.retained, { signal: this.abort.signal });
      mergeEvents(run, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      run.retainedLoaded = true;
    } else if (!terminal(run.status) && this.session?.session_id === run.session &&
      (this.queue?.console.current?.operation_id === run.id || run.cursor > 0)) {
      const page = await this.query<REventsObservation>("r.output_events", { expected_session: run.session,
        operation_id: run.id, after_sequence: run.cursor, limit: 100 }, run.session);
      if (page.session_id !== run.session) throw new Error("R output belongs to a different native session.");
      mergeEvents(run, page.output);
    }
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    const task = (async () => {
      if (this.disposed) return;
      // Retained events remain readable after native release or Host restart.
      for (const run of this.runs.values()) if (run.retained) await this.events(run);
      const session = await this.query<Session>("r.session", {});
      const queue = await this.query<QueueObservation>("r.console", { expected_session: session.queue_target }, session.queue_target);
      if (queue.console.session_id !== session.queue_target) throw new Error("R queue identity changed during observation.");
      this.session = session; this.queue = queue; this.liveAvailable = true;
      const ids = new Set([...this.runs.values()].filter(run => !terminal(run.status)).map(run => run.id));
      for (const run of this.queue.console.pending) ids.add(run.operation_id);
      if (this.queue.console.current) ids.add(this.queue.console.current.operation_id);
      for (const id of this.queue.awaiting_commit) ids.add(id);
      for (const id of ids) await this.inspect(id);
      for (const run of this.runs.values()) await this.events(run);
    })();
    this.refreshing = task;
    return task.catch(error => { this.liveAvailable = false; throw error; }).finally(() => { if (this.refreshing === task) this.refreshing = null; });
  }
  dispose() { this.disposed = true; this.abort.abort(); this.client.dispose(); }
}
