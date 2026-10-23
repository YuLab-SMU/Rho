import path from 'node:path';
import { atomicJson, canonical, digest, readJson, requireThat, stateDirectory } from '@rho-workspace/plugin-contracts';
import type { Project } from './state.js';
import { emptyTaskMap, type PresentationRecord, type TaskMapState } from './task-frame.js';
import type { RhoInput } from './contract.generated.js';

// Protected resource for agentFormIntervalMs: layout stability and the person's
// attention. An Agent form change inside the interval is not applied; it is
// merged into that target's single pending suggestion.
export const taskMapLimits = { maxItems: 256, maxTerms: 128, maxTargets: 288, maxSuggestions: 64, maxReceipts: 256, maxParamsBytes: 4096, maxBytes: 2 * 1024 * 1024, agentFormIntervalMs: 8000 };
const target = /^(map:[a-z0-9-]{1,32}|item:[A-Za-z0-9._:@-]{1,128})$/;
const summary = (p: PresentationRecord) => ({ form: p.form, params: p.params, author: p.author, human: p.human });

export class TaskMap {
  limits: typeof taskMapLimits;
  constructor(public project: Project, limits: Partial<typeof taskMapLimits> = {}, private clock: () => number = Date.now) { this.limits = { ...taskMapLimits, ...limits }; }
  private async file() { return path.join(await stateDirectory(this.project.root, '.rho/rho'), 'task-map.json'); }
  // Observation only: reading starts, resumes or reruns nothing.
  async read(): Promise<TaskMapState> {
    const state = await readJson<TaskMapState>(await this.file(), emptyTaskMap());
    requireThat(state.format === 'rho.task-map/1', 'condition', 'Task map state is not a supported version.');
    return { ...state, limits: { agentFormIntervalMs: this.limits.agentFormIntervalMs } };
  }
  // The three kinds are the contract's vocabulary: a map change is exactly one of
  // declaring, presenting a form, or a person's response to one.
  private async commit(kind: 'declare' | 'present' | 'respond', b: { changeId: string; expectedVersion: number }, author: string, change: (s: TaskMapState, at: string) => Record<string, unknown>) {
    const file = await this.file(), { limits: _, ...current } = await this.read();
    const requestDigest = digest(canonical({ kind, b, author }));
    const old = current.receipts.find(r => r.changeId === b.changeId);
    if (old) {
      requireThat(old.requestDigest === requestDigest, 'conflict', 'changeId already names a different task map change or author.');
      return { ...current, limits: { agentFormIntervalMs: this.limits.agentFormIntervalMs }, receipt: old };
    }
    requireThat(current.version === b.expectedVersion, 'stale', 'Task map version changed. Missing receipts do not authorize replay.', { actualVersion: current.version, retainedFromVersion: current.retainedFromVersion });
    const next = structuredClone(current), at = new Date(this.clock()).toISOString();
    const outcome = change(next, at);
    const receipt = { changeId: b.changeId, requestDigest, kind, author, version: current.version + 1, at, outcome };
    next.version = receipt.version; next.receipts = [...next.receipts, receipt].slice(-this.limits.maxReceipts); next.retainedFromVersion = next.receipts[0].version;
    requireThat(Buffer.byteLength(JSON.stringify(next)) <= this.limits.maxBytes, 'limit', 'Task map byte budget reached; the current map is preserved.', { limit: 'maxBytes', maximum: this.limits.maxBytes });
    await atomicJson(file, next);
    return { ...next, limits: { agentFormIntervalMs: this.limits.agentFormIntervalMs }, receipt };
  }
  private target(s: TaskMapState, id: string) {
    requireThat(target.test(id), 'invalid', 'Choose a map placement (map:<slot>) or an item (item:<id>).');
    if (id.startsWith('item:')) requireThat(s.items.some(i => i.id === id.slice(5)), 'not_found', 'The item is not declared in this task map.');
  }
  private params(params: unknown) {
    requireThat(Buffer.byteLength(JSON.stringify(params ?? {})) <= this.limits.maxParamsBytes, 'limit', 'Form parameters exceed their byte budget.', { limit: 'maxParamsBytes', maximum: this.limits.maxParamsBytes });
    return structuredClone(params ?? {}) as Record<string, unknown>;
  }
  // Agent only: items, their words and the declared next steps. Rho never infers them.
  declare(b: RhoInput<'task.map.declare'>, author: string) {
    return this.commit('declare', b, author, (s, at) => {
      if (b.question !== undefined) s.question = b.question;
      if (b.compositionId !== undefined) s.compositionId = b.compositionId;
      for (const group of ['kinds', 'states'] as const) {
        for (const [id, value] of Object.entries<any>(b.vocabulary?.[group] ?? {})) value === null ? delete s.vocabulary[group][id] : s.vocabulary[group][id] = value;
        requireThat(Object.keys(s.vocabulary[group]).length <= this.limits.maxTerms, 'limit', 'Task vocabulary budget reached.', { limit: 'maxTerms', maximum: this.limits.maxTerms });
      }
      const removed = new Set<string>(b.remove ?? []);
      s.items = s.items.filter(i => !removed.has(i.id));
      for (const input of b.items ?? []) {
        requireThat(!removed.has(input.id), 'invalid', 'An item cannot be declared and removed in one change.');
        const index = s.items.findIndex(i => i.id === input.id), item = { ...structuredClone(input), author, at };
        if (index >= 0) s.items[index] = item; else s.items.push(item);
      }
      requireThat(s.items.length <= this.limits.maxItems, 'limit', 'Task item budget reached; existing items are kept.', { limit: 'maxItems', maximum: this.limits.maxItems });
      const ids = new Set(s.items.map(i => i.id));
      for (const input of b.items ?? []) requireThat((input.from ?? []).every((id: string) => ids.has(id) && id !== input.id), 'invalid', 'An item can only come from other declared items.');
      for (const item of s.items) if (item.from) item.from = item.from.filter(id => ids.has(id));
      if (b.next !== undefined) { requireThat(b.next.every((id: string) => ids.has(id)), 'invalid', 'Next names an undeclared item.'); s.next = [...b.next]; }
      else s.next = s.next.filter(id => ids.has(id));
      for (const key of Object.keys(s.presentation)) if (key.startsWith('item:') && !ids.has(key.slice(5))) delete s.presentation[key];
      s.suggestions = s.suggestions.filter(x => !x.target.startsWith('item:') || ids.has(x.target.slice(5)));
      if (s.focus && !ids.has(s.focus.item)) s.focus = null;
      return { declared: (b.items ?? []).length, removed: removed.size };
    });
  }
  // Shared by the Agent and people: form, parameters (including a subset) and focus.
  present(b: RhoInput<'task.map.present'>, author: string, human: boolean) {
    return this.commit('present', b, author, (s, at) => {
      this.target(s, b.target);
      requireThat(b.form !== undefined || b.focus !== undefined, 'invalid', 'Change a form, its parameters or the focus.');
      requireThat(b.params === undefined || b.form !== undefined, 'invalid', 'Parameters belong to a form; name the form.');
      if (b.focus !== undefined) {
        requireThat(b.focus === null || s.items.some(i => i.id === b.focus), 'not_found', 'The focused item is not declared.');
        s.focus = b.focus === null ? null : { item: b.focus, author, human, at };
      }
      if (b.form === undefined) return { applied: true, focus: b.focus };
      const params = this.params(b.params), current = s.presentation[b.target];
      if (current && current.form === b.form && canonical(current.params) === canonical(params)) return { applied: true, unchanged: true };
      if (!human) {
        const recent = s.lastAgentFormAt !== null && this.clock() - Date.parse(s.lastAgentFormAt) < this.limits.agentFormIntervalMs;
        const cause = current?.pinned ? 'pinned' as const : recent ? 'budget' as const : null;
        if (cause) {
          const existing = s.suggestions.find(x => x.target === b.target && x.author === author);
          const suggestion = { id: existing?.id ?? 'suggestion:' + digest(author + ':' + b.changeId).slice(0, 24), target: b.target, form: b.form, params, author, at, ...(b.reason ? { reason: b.reason } : {}), cause, merged: (existing?.merged ?? 0) + 1 };
          s.suggestions = [...s.suggestions.filter(x => x !== existing), suggestion];
          requireThat(s.suggestions.length <= this.limits.maxSuggestions, 'limit', 'Pending suggestion budget reached; existing suggestions are kept.', { limit: 'maxSuggestions', maximum: this.limits.maxSuggestions });
          return { applied: false, suggestion: suggestion.id, cause, merged: suggestion.merged };
        }
        s.lastAgentFormAt = at;
      }
      // A person deciding a target settles every pending suggestion for it.
      s.suggestions = s.suggestions.filter(x => x.target !== b.target || (!human && x.author !== author));
      s.presentation[b.target] = { form: b.form, params, author, human, at, changeId: b.changeId, ...(b.reason ? { reason: b.reason } : {}), previous: current ? summary(current) : null, ...(current?.pinned ? { pinned: current.pinned } : {}) };
      requireThat(Object.keys(s.presentation).length <= this.limits.maxTargets, 'limit', 'Presentation target budget reached.', { limit: 'maxTargets', maximum: this.limits.maxTargets });
      return { applied: true };
    });
  }
  // People only: pin, unpin, revert an Agent change, accept or dismiss a suggestion.
  // Reverting changes layout only; it never undoes work the Agent did.
  respond(b: RhoInput<'task.map.respond'>, author: string) {
    return this.commit('respond', b, author, (s, at) => {
      this.target(s, b.target);
      const current = s.presentation[b.target], base = { author, human: true, at, changeId: b.changeId };
      if (b.action === 'pin') {
        requireThat(b.form !== undefined || current, 'invalid', 'Pin the form you are seeing.');
        s.presentation[b.target] = b.form !== undefined ? { form: b.form, params: this.params(b.params), ...base, previous: current ? summary(current) : null, pinned: { by: author, at } } : { ...current!, pinned: { by: author, at } };
        return { pinned: true };
      }
      if (b.action === 'unpin') { requireThat(current?.pinned, 'condition', 'Nothing is pinned here.'); delete current!.pinned; return { pinned: false }; }
      if (b.action === 'revert') {
        requireThat(current && !current.human, 'condition', 'Only a form the Agent chose can be reverted; your own choices stay.');
        if (current!.previous) s.presentation[b.target] = { form: current!.previous.form, params: current!.previous.params, ...base, previous: null, ...(current!.pinned ? { pinned: current!.pinned } : {}) };
        else delete s.presentation[b.target];
        return { reverted: true, from: current!.form };
      }
      const suggestion = s.suggestions.find(x => x.id === b.suggestionId && x.target === b.target);
      requireThat(suggestion, 'not_found', 'The suggestion is no longer pending.');
      s.suggestions = s.suggestions.filter(x => x !== suggestion);
      if (b.action === 'dismiss') return { dismissed: suggestion!.id };
      s.presentation[b.target] = { form: suggestion!.form, params: suggestion!.params, ...base, suggestedBy: suggestion!.author, previous: current ? summary(current) : null, ...(current?.pinned ? { pinned: current.pinned } : {}) };
      return { accepted: suggestion!.id };
    });
  }
}
