// The item frame: Rho's shared interaction layer for the whole-task view.
// DOM-free and dependency-free so the service, the shell and any plugin entry
// read the same words. Rho fixes no list of item kinds or states: the Agent
// declares them as vocabulary terms. Rho only interprets an optional term role,
// which decides where an item is summarised ("now", "waiting for you", ...).

export interface Term {
  label: string;
  // Visual hint; unknown tones render neutral.
  tone?: string;
  // Interpreted by Rho when present: working, waiting, done, planned, unknown,
  // stopped. Any other value is kept and treated as neutral.
  role?: string;
  icon?: string;
  description?: string;
}
export interface Vocabulary { kinds: Record<string, Term>; states: Record<string, Term> }
export interface ItemLine { label?: string; text: string; tone?: string; judgment?: boolean }
export interface TaskItem {
  id: string; kind: string; state: string; title: string;
  group?: string; summary?: string; lines?: ItemLine[];
  // Counts the Agent reports from real receipts; Rho draws no other progress.
  progress?: { done: number; total?: number; unit?: string };
  // A view in the task's layout that draws this item's body.
  view?: string;
  from?: string[];
  author: string; at: string;
}
export interface PresentationRecord {
  form: string; params: Record<string, unknown>;
  author: string; human: boolean; at: string; changeId: string;
  reason?: string; suggestedBy?: string;
  previous: { form: string; params: Record<string, unknown>; author: string; human: boolean } | null;
  pinned?: { by: string; at: string };
}
export interface Suggestion {
  id: string; target: string; form: string; params: Record<string, unknown>;
  author: string; at: string; reason?: string; cause: 'pinned' | 'budget'; merged: number;
}
export interface TaskMapState {
  format: 'rho.task-map/1'; version: number;
  question: string | null; compositionId: string | null;
  vocabulary: Vocabulary; items: TaskItem[]; next: string[];
  presentation: Record<string, PresentationRecord>;
  focus: { item: string; author: string; human: boolean; at: string } | null;
  suggestions: Suggestion[];
  lastAgentFormAt: string | null;
  receipts: { changeId: string; requestDigest: string; kind: string; author: string; version: number; at: string; outcome: Record<string, unknown> }[];
  retainedFromVersion: number;
  limits?: { agentFormIntervalMs: number };
}

export const roles = ['working', 'waiting', 'done', 'planned', 'unknown', 'stopped'] as const;
export const emptyTaskMap = (): TaskMapState => ({ format: 'rho.task-map/1', version: 0, question: null, compositionId: null, vocabulary: { kinds: {}, states: {} }, items: [], next: [], presentation: {}, focus: null, suggestions: [], lastAgentFormAt: null, receipts: [], retainedFromVersion: 1 });

// Undeclared words still render: the identifier is the label.
export function term(map: Pick<TaskMapState, 'vocabulary'>, group: keyof Vocabulary, id: string): Term {
  return Object.hasOwn(map.vocabulary[group], id) ? map.vocabulary[group][id] : { label: id };
}
export function roleOf(map: Pick<TaskMapState, 'vocabulary'>, item: Pick<TaskItem, 'state'>) { return term(map, 'states', item.state).role ?? ''; }
export function toneOf(map: Pick<TaskMapState, 'vocabulary'>, item: Pick<TaskItem, 'state'>) {
  const t = term(map, 'states', item.state);
  return t.tone ?? ({ working: 'agent', waiting: 'waiting', done: 'verified', unknown: 'unknown', planned: 'planned', stopped: 'neutral' } as Record<string, string>)[t.role ?? ''] ?? 'neutral';
}

// Forms are declared by each entry with a scale; zooming walks that scale.
// These are the shared defaults, not a closed list.
export interface FormDeclaration { scale: number; label?: string; params?: Record<string, unknown> }
export type FormDeclarations = Record<string, FormDeclaration>;
export const standardForms: FormDeclarations = { inline: { scale: 0, label: 'Reference' }, card: { scale: 1, label: 'Card' }, summary: { scale: 2, label: 'Summary' }, full: { scale: 3, label: 'Full' } };
export function zoomOrder(forms: FormDeclarations) { return Object.entries(forms).sort((a, b) => a[1].scale - b[1].scale || a[0].localeCompare(b[0])).map(([name]) => name); }
// The nearest declared form one step larger (delta 1) or smaller (delta -1).
export function zoom(forms: FormDeclarations, current: string, delta: 1 | -1) {
  const order = zoomOrder(forms), scale = forms[current]?.scale ?? standardForms[current]?.scale ?? 0;
  const candidates = order.filter(name => delta > 0 ? forms[name].scale > scale : forms[name].scale < scale);
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
