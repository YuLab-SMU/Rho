import type { RhoOutput } from './contract.generated.js';

// The item frame: Rho's shared interaction layer for the whole-task view.
// DOM-free and dependency-free so the service, the shell and any plugin entry
// read the same words. Rho fixes no list of item kinds or states: the Agent
// declares them as vocabulary terms. Rho only interprets an optional term role,
// which decides where an item is summarised ("now", "waiting for you", ...).

// The state the Agent declares is a wire contract (task.map.*). Every type below is
// derived from that one contract, so the frame, the shell and the service cannot
// disagree about a field. Only the interpretation helpers stay hand-written.
export type TaskMapState = RhoOutput<'task.map.read'>;
export type Term = TaskMapState['vocabulary']['kinds'][string];
export type Vocabulary = TaskMapState['vocabulary'];
export type ItemLine = NonNullable<TaskMapState['items'][number]['lines']>[number];
export type TaskItem = TaskMapState['items'][number];
export type PresentationRecord = TaskMapState['presentation'][string];
export type Suggestion = TaskMapState['suggestions'][number];

export const roles = ['working', 'waiting', 'done', 'planned', 'unknown', 'stopped'] as const;
// A local placeholder is not a server response: it carries no receipt, no limits and
// version 0, and it is never mistaken for an acknowledged declaration.
export const emptyTaskMap = (): TaskMapState => ({ format: 'rho.task-map/1', version: 0, question: null, compositionId: null, vocabulary: { kinds: {}, states: {} }, items: [], next: [], presentation: {}, focus: null, suggestions: [], lastAgentFormAt: null, receipts: [], retainedFromVersion: 1, limits: { agentFormIntervalMs: 0 } });

// Undeclared words still render: the identifier is the label.
export function term(map: Pick<TaskMapState, 'vocabulary'>, group: keyof Vocabulary, id: string): Term {
  return Object.hasOwn(map.vocabulary[group], id) ? map.vocabulary[group][id] : { label: id };
}
export function roleOf(map: Pick<TaskMapState, 'vocabulary'>, item: Pick<TaskItem, 'state'>) { return term(map, 'states', item.state).role ?? ''; }
// Rho reserves the tones that mean a fact Rho established. An item is the Agent's
// own account of its work, so a declared "verified" is not a verification: it falls
// back to the role's tone, and "done" is quiet rather than green. The Agent keeps
// every other word it likes.
export const systemTones = ['verified', 'failed', 'unknown'] as const;
export function toneOf(map: Pick<TaskMapState, 'vocabulary'>, item: Pick<TaskItem, 'state'>) {
  const t = term(map, 'states', item.state);
  const declared = t.tone && !(systemTones as readonly string[]).includes(t.tone) ? t.tone : undefined;
  return declared ?? ({ working: 'agent', waiting: 'waiting', done: 'settled', unknown: 'unknown', planned: 'planned', stopped: 'neutral' } as Record<string, string>)[t.role ?? ''] ?? 'neutral';
}

// Forms are declared by each entry with a scale; zooming walks that scale.
// These are the shared defaults, not a closed list. A form with `zoom: false`
// is reached only by naming it (a comparison, say), never by stepping.
export interface FormDeclaration { scale: number; label?: string; params?: Record<string, unknown>; zoom?: false }
export type FormDeclarations = Record<string, FormDeclaration>;
export const standardForms: FormDeclarations = { inline: { scale: 0, label: 'Reference' }, card: { scale: 1, label: 'Card' }, summary: { scale: 2, label: 'Summary' }, full: { scale: 3, label: 'Full' } };
export function zoomOrder(forms: FormDeclarations) { return Object.entries(forms).sort((a, b) => a[1].scale - b[1].scale || a[0].localeCompare(b[0])).map(([name]) => name); }
// The nearest declared form one step larger (delta 1) or smaller (delta -1).
export function zoom(forms: FormDeclarations, current: string, delta: 1 | -1) {
  const order = zoomOrder(forms), scale = forms[current]?.scale ?? standardForms[current]?.scale ?? 0;
  const candidates = order.filter(name => forms[name].zoom !== false && (delta > 0 ? forms[name].scale > scale : forms[name].scale < scale));
  return delta > 0 ? candidates[0] ?? null : candidates.at(-1) ?? null;
}
// The declared form closest to the requested one; a plugin is never asked to draw a form it lacks.
export function nearestForm(forms: FormDeclarations, wanted: string) {
  if (forms[wanted]) return wanted;
  const scale = standardForms[wanted]?.scale ?? 1;
  return zoomOrder(forms).reduce<string | null>((best, name) => best === null || Math.abs(forms[name].scale - scale) < Math.abs(forms[best].scale - scale) ? name : best, null);
}

// Map placements are presentation targets ("map:top"); items are "item:<id>".
export const mapDefaults: Record<string, { form: string; params: Record<string, unknown> }> = {
  top: { form: 'summary', params: { range: 'around', span: 2, axis: 'h' } },
  bottom: { form: 'summary', params: { range: 'trail', axis: 'h' } },
};
export function presentationOf(map: TaskMapState, target: string, fallback: { form: string; params: Record<string, unknown> }) {
  const record = map.presentation[target];
  return record ? { form: record.form, params: record.params, record } : { ...fallback, record: undefined };
}
export const itemTarget = (id: string) => 'item:' + id;

// Items in declared order, filtered by the summary parameters.
export function itemsInRange(map: TaskMapState, params: Record<string, unknown>) {
  const items = map.items;
  if (params.range === 'trail') return items.filter(i => typeof params.view === 'string' ? i.view === params.view : !!i.view);
  if (params.range !== 'around') return items;
  const span = typeof params.span === 'number' && params.span >= 0 ? params.span : 2;
  const now = items.findIndex(i => roleOf(map, i) === 'working');
  const center = now >= 0 ? now : Math.max(0, items.findIndex(i => roleOf(map, i) !== 'done'));
  return items.slice(Math.max(0, center - span), center + span + 1);
}
export function counts(map: TaskMapState) {
  const by = (role: string) => map.items.filter(i => roleOf(map, i) === role).length;
  return { total: map.items.length, working: by('working'), waiting: by('waiting'), done: by('done') };
}
export function authorLabel(author: string, principalId?: string) {
  return author === principalId ? 'You' : author.startsWith('browser:') ? 'Someone in another tab' : author === 'operator' ? 'Rho' : 'The Agent';
}
