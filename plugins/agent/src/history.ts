import type { AgentTaskDetail, AgentTaskEvent, AgentTaskEventPage, AgentNativeHistoryPage } from '../sdk/index.js';
type Read = <T>(id: string, args: unknown) => Promise<T>;
interface History {
  generation: number; session: string | null; events: AgentTaskEvent[]; cursor: number;
  earlier: boolean; browsing: boolean; loading: boolean; gap: boolean;
  nativeStarted: boolean; nativeCursor: string | null; nativeDone: boolean; nativeSeen: Set<string>;
  source: string | null; partial: boolean;
}
const bytes = (event: AgentTaskEvent) => new TextEncoder().encode(event.text).length;
function merge(previous: AgentTaskEvent[], incoming: AgentTaskEvent[], older: boolean) {
  const events = new Map(previous.map(event => [event.event_id, event]));
  for (const event of incoming) {
    const old = events.get(event.event_id);
    // Current observation wins over overlapping native history. Within the
    // observation stream a lower sequence cannot replace a newer message.
    if (!old || old.sequence <= event.sequence) events.set(event.event_id, event);
  }
  const result = [...events.values()].sort((a, b) => a.observed_at_ms - b.observed_at_ms || a.sequence - b.sequence);
  let size = result.reduce((sum, event) => sum + bytes(event), 0), trimmed = false;
  while (result.length > 500 || size > 1024 * 1024) {
    size -= bytes(older ? result.pop()! : result.shift()!); trimmed = true;
  }
  return { events: result, trimmed };
}

/** Bounded display pages. They never become draft context or native memory. */
export class NativeHistory {
  readonly events = new Map<string, AgentTaskEvent[]>();
  readonly states = new Map<string, History>();
  constructor(private read: Read, private changed: () => void) {}
  private current(detail: AgentTaskDetail) {
    const id = detail.summary.task.task_id, generation = detail.summary.history_generation, session = detail.summary.task.native_session_id;
    let state = this.states.get(id);
    if (!state || state.generation !== generation || state.session !== session) {
      state = { generation, session, events: [], cursor: 0, earlier: false, browsing: false, loading: false, gap: false,
        nativeStarted: false, nativeCursor: null, nativeDone: false, nativeSeen: new Set(), source: null, partial: false };
      this.states.set(id, state); this.events.set(id, []);
    }
    return state;
  }
  canReadEarlier(detail: AgentTaskDetail) {
    const state = this.states.get(detail.summary.task.task_id);
    return !!state && (state.earlier || this.canReadNative(detail, state));
  }
  private canReadNative(detail: AgentTaskDetail, state: History) {
    return detail.summary.task.provider === 'codex' && !!state.session && !state.nativeDone &&
      !['disconnected', 'uncertain', 'closing'].includes(detail.summary.attachment.state);
  }
  private apply(task: string, state: History, incoming: AgentTaskEvent[], older: boolean) {
    const result = merge(state.events, incoming, older);
    state.events = result.events; state.partial ||= result.trimmed; this.events.set(task, state.events);
    return result.trimmed;
  }
  private validate(page: AgentTaskEventPage, task: string, state: History, after: number | null, before: number | null) {
    if (page.task_id !== task || page.history_generation !== state.generation || page.events.length > 100 ||
      page.events.some(event => !event.event_id || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > page.durable_cursor ||
        after !== null && event.sequence <= after || before !== null && event.sequence >= before))
      throw Error('The history page no longer matches this task and reading position. Refresh the latest messages.');
    if (after !== null && page.has_more && page.next_cursor <= after)
      throw Error('The history cursor did not advance.');
  }
  async observe(detail: AgentTaskDetail) {
    const task = detail.summary.task.task_id, state = this.current(detail);
    if (state.loading || state.browsing) return;
    state.loading = true;
    try {
      const after = state.cursor || null;
      const page = await this.read<AgentTaskEventPage>('agent.native.events', { task_id: task, after, before: null, limit: 100 });
      if (this.states.get(task) !== state) return;
      this.validate(page, task, state, after, null);
      const trimmed = this.apply(task, state, page.events, false);
      if (after === null) state.earlier = page.has_more || trimmed;
      else state.earlier ||= trimmed;
      state.cursor = after !== null && page.has_more ? page.next_cursor : page.durable_cursor;
      state.gap = page.history_gap;
    } finally { state.loading = false; this.changed(); }
  }
  async earlier(detail: AgentTaskDetail) {
    const task = detail.summary.task.task_id, state = this.current(detail);
    if (state.loading) throw Error('Wait for the current history page.');
    state.loading = true; this.changed();
    try {
      if (state.earlier) {
        const positive = state.events.map(event => event.sequence).filter(sequence => sequence > 0);
        const before = positive.length ? Math.min(...positive) : null;
        const page = await this.read<AgentTaskEventPage>('agent.native.events', { task_id: task, after: null, before, limit: 100 });
        if (this.states.get(task) !== state) return;
        this.validate(page, task, state, null, before);
        if (page.has_more && !page.events.length) throw Error('The history cursor did not advance.');
        this.apply(task, state, page.events, true); state.earlier = page.has_more; state.gap = page.history_gap;
      } else if (this.canReadNative(detail, state)) {
        const cursor = state.nativeStarted ? state.nativeCursor : null;
        const page = await this.read<AgentNativeHistoryPage>('agent.native.history', { task_id: task, cursor, limit: 20 });
        if (this.states.get(task) !== state) return;
        if (page.task_id !== task || page.events.length > 500 || page.events.some(event => !event.event_id || event.native_session_id !== state.session || event.source !== 'native_history') ||
          page.next_cursor && (page.next_cursor === cursor || state.nativeSeen.has(page.next_cursor)))
          throw Error('Native history changed identity or did not advance.');
        if (page.next_cursor) state.nativeSeen.add(page.next_cursor);
        this.apply(task, state, page.events, true); state.nativeStarted = true; state.nativeCursor = page.next_cursor;
        state.nativeDone = page.next_cursor === null; state.source = page.source; state.partial ||= page.partial;
      } else return;
      state.browsing = true;
    } finally { state.loading = false; this.changed(); }
  }
  async latest(detail: AgentTaskDetail) {
    this.states.delete(detail.summary.task.task_id);
    await this.observe(detail);
  }
}
