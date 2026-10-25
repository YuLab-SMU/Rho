// Rho's expression layer: what the screen shows, given the facts Rho observed about
// objects and what the person is doing. DOM-free, shared by the shell and tests.
//
// Facts are about objects; the Agent is only their author. The Agent never asks the
// screen to show anything. It works, and the work moves the screen through six rules:
//   Respond  a fact updates its object wherever the object appears;
//   Focus    the Agent's attention is read from what it last opened, wrote, ran or read;
//   Compose  an Agent layout change applies only while the person follows;
//   Connect  source version, run and artifact version are linked by the facts alone;
//   Reveal   catalog reads, rejected calls, retries and earlier runs wait behind their object;
//   Revisit  a person coming back gets a digest of what changed, never a replay.
// Only the Agent's work moves its attention. What a person or another principal records
// (an edit, a question, a receipt) updates its objects in place.
// One attention rule decides whether the main area may move: only while the person
// follows, and at most once per agentPaceMs. Moving never re-versions a view the person
// made theirs: the Agent's newer version opens beside it, and theirs offers the update.

// Same protected resource and value as taskMapLimits.agentFormIntervalMs: the
// person's attention and layout stability. Kept equal by test.
export const agentPaceMs = 8000;

// An identity a record does not hold is null (src/trace.ts folds Rho's own records, which
// keep less than the Agent's transcript); the screen never guesses it.
export type Effect =
  | { kind: 'catalog' }
  | { kind: 'open'; source: string | null; version: number }
  | { kind: 'edit'; source: string; version: number }
  | { kind: 'save'; source: string; version: number }
  | { kind: 'source-state'; source: string; version: number; savedVersion: number | null }
  | { kind: 'submit'; run: number; source: string; sourceVersion: number | null; state?: RunState }
  | { kind: 'run-state'; run: number; state: RunState }
  | { kind: 'retry'; run: number }
  | { kind: 'ended'; run: number; exit: number | null; state?: RunState }
  | { kind: 'registered'; artifact: string; name: string; version: string; run: number | null }
  | { kind: 'observe'; run: number }
  | { kind: 'output'; run: number; stream: 'stdout' | 'stderr' | null }
  | { kind: 'verified'; run: number; artifacts: string[] }
  | { kind: 'read'; artifact: string | null; run: number | null }
  | { kind: 'layout'; replace: boolean; views: ArtifactRef[] }
  | { kind: 'items'; question: string | null; items: DeclaredItem[] | null }
  | { kind: 'ask'; question: string; text: string; target: string; version: string; run: number | null; rows: string[]; document: { source: string; version: number } | null }
  | { kind: 'fetched'; question: string }
  | { kind: 'responded'; question: string };
export interface ArtifactRef { artifact: string; run: number | null; object?: string; version?: string }
// What the Agent declared, in its own words. Only its explicit references connect it to
// objects: an artifact (that file, those bytes, that run), a view, earlier items it
// branches from. A title that names an object connects nothing. Lines marked judgment
// are the Agent's reading, the others what it reports; neither is a fact Rho observed.
export interface DeclaredItem {
  id: string; kind: string; state: string; title: string; summary?: string; author?: string;
  artifact?: { object: string; version: string; run: number }; view?: string; from?: string[];
  lines?: { text: string; label?: string; tone?: string; judgment?: boolean }[];
}
export interface Fact {
  seq: number;
  label: string;
  // The principal that made it: `agent:…`, `browser:…` or `operator`.
  actor: string;
  op: string;
  outcome: 'returned' | 'rejected';
  // A recorded time, or only the recorded times on either side of it.
  at: string | null;
  after?: string | null;
  before?: string | null;
  reason?: { kind: string; message: string | null };
  object?: string;
  effect?: Effect | null;
}
export interface Trace {
  format: 'rho.replay-trace/1';
  recorded: { experiment: string; project: string; from: string; to: string };
  facts: Fact[];
  // Who each principal is: its kind, and the name its binding gave it, when there is one.
  principals: Record<string, { kind: 'agent' | 'browser' | 'operator'; name: string | null }>;
  sources: Record<string, { versions: Record<string, string>; edited: Record<string, string>; saved: Record<string, string>; authors: Record<string, string> }>;
  runs: Record<string, {
    operationId: string; source: string; sourceVersion: number | null; declared: string[]; acceptedAt: string;
    exit: number | null; observedAt: string | null; outputs: { stdout?: string; stderr?: string };
    verified?: { name: string; digest: string; kind: string }[];
  }>;
  artifacts: Record<string, { kind: string; versions: Record<string, { runs: number[]; bytes: number; text?: string; file?: string }> }>;
}

export type Attention = 'following' | 'working' | 'away';
export type PersonIntent =
  | { kind: 'follow' } | { kind: 'unfollow' }
  | { kind: 'open'; target: string; run?: number | null; version?: string }
  | { kind: 'select'; target: string; rows: string[] }
  | { kind: 'type'; target: string }
  | { kind: 'close'; target: string }
  | { kind: 'pin'; target: string } | { kind: 'unpin'; target: string }
  | { kind: 'leave' } | { kind: 'return' }
  | { kind: 'accept'; suggestion: string } | { kind: 'dismiss'; suggestion: string }
  | { kind: 'dismiss-digest' }
  | { kind: 'reveal'; target: string | null }
  | { kind: 'update'; target: string }
  | { kind: 'ask'; target: string; rows: string[]; text: string }
  | { kind: 'expand'; target: string } | { kind: 'collapse'; target: string };
// A target names a view by its id. The first view of an object takes the object's id,
// so naming an object reaches its view. The person acts after seeing fact `at`; -1 is
// before the first fact.
export type PersonAction = PersonIntent & { at: number };

export type RunState = 'unobserved' | 'running' | 'completed' | 'failed' | 'unknown';
export interface SourceState { id: string; kind: 'source'; name: string; version: number; savedVersion: number | null; changedAt: number; touchedAt: number; hidden: number }
export interface RunObject {
  id: string; kind: 'run'; name: string; run: number; source: string; sourceVersion: number | null; state: RunState;
  exit: number | null; firstLine: string | null; verified: string[]; changedAt: number; touchedAt: number; hidden: number;
}
export interface ArtifactState {
  id: string; kind: 'artifact'; name: string;
  // One entry per distinct content, oldest first; runs that produced the same bytes share it.
  versions: { digest: string; runs: number[] }[];
  changedAt: number; touchedAt: number; hidden: number;
}
// A question about one version of an object. It stays on that version when newer ones
// appear. `fetched` is the context's receipt; `responded` needs an explicit link back
// from the Agent. A null author is the person at this screen in a simulated replay.
export interface QuestionState {
  id: string; kind: 'question'; name: string; author: string | null; target: string; version: string; run: number | null; rows: string[];
  document: { source: string; version: number } | null;
  state: 'prepared' | 'fetched' | 'responded'; fetchedBy: string | null; fetchedAt: number | null;
  changedAt: number; touchedAt: number; hidden: number;
}
export type ObjectState = SourceState | RunObject | ArtifactState | QuestionState;
// A view the Agent's focus opened stays a preview: the next Agent move replaces it in
// place. The person opening, selecting in or pinning it makes it theirs, and a view of
// theirs keeps the version it shows until they update it; `newer` is the latest run whose
// bytes differ, when there is one. Two views may show two versions of one object.
export interface View {
  id: string; object: string; run: number | null; version?: string; openedBy: 'agent' | 'person'; pinned: boolean; preview: boolean; selection: string[];
  newer: number | null;
}
export interface Suggestion { id: string; views: ArtifactRef[]; cause: 'working' | 'away' | 'pinned'; from: number; merged: number }
export interface Escalation { object: string; reason: string; from: number }
export type DigestLine =
  | { kind: 'source'; object: string; from: number | null; to: number }
  // One line per source: its latest run that changed, and the others that changed, in order.
  | { kind: 'run'; object: string; state: RunState; firstLine: string | null; verified: number; earlier: string[] }
  | { kind: 'artifact'; object: string; versions: number }
  | { kind: 'question'; object: string; state: QuestionState['state'] }
  | { kind: 'suggestion'; id: string }
  | { kind: 'items'; count: number };
export interface Move { seq: number; by: 'agent' | 'person'; view: string | null; rule: 'agent-focus' | 'agent-layout' | 'catch-up' | 'person' | 'accept' }
export interface Screen {
  step: number;
  time: string | null;
  attention: Attention;
  question: string | null;
  objects: Record<string, ObjectState>;
  order: string[];
  views: View[];
  active: string | null;
  // Where the Agent is, and whether that moved the main area, waits for the pace, or is only a marker.
  agent: { object: string; run: number | null; seq: number; placement: 'main' | 'pending' | 'marker' } | null;
  suggestions: Suggestion[];
  escalations: Escalation[];
  digest: { from: number; to: number; lines: DigestLine[] } | null;
  items: DeclaredItem[];
  hidden: { catalog: number; rejected: number; retries: number };
  revealed: string | null;
  // Sources whose earlier runs the person unfolded.
  expanded: string[];
  moves: Move[];
}

export interface ExpressionState extends Screen {
  presentationClock?: number;
  lastMove: number | null;
  pending: { kind: 'focus'; object: string; run: number | null } | { kind: 'layout'; views: ArtifactRef[]; replace: boolean } | null;
  away: { from: number; prior: Exclude<Attention, 'away'>; baseline: Record<string, ObjectState>; suggestions: string[]; items: string } | null;
}
type Work = ExpressionState;

// A fact with no recorded time is placed at the last recorded time before it, so the
// pace never assumes more time passed than was recorded.
export function timeOf(fact: Fact): string | null { return fact.at ?? fact.after ?? null; }
const ms = (time: string | null) => time === null ? null : Date.parse(time);

export function express(trace: Trace, actions: PersonAction[], step: number, start: Exclude<Attention, 'away'> = 'following'): Screen {
  const s = startExpression(start);
  const last = Math.min(step, trace.facts.length - 1);
  for (const a of actions) if (a.at < 0) person(s, trace, a);
  for (let i = 0; i <= last; i++) {
    agent(s, trace, trace.facts[i]);
    for (const a of actions) if (a.at === i) person(s, trace, a);
  }
  return expressionScreen(s);
}

// The live shell advances the same reducer once per newly observed fact. It retains
// presentation state, not a second execution journal or copies of document buffers.
export function startExpression(start: Exclude<Attention, 'away'> = 'following'): ExpressionState {
  return {
    step: -1, time: null, attention: start, question: null, objects: {}, order: [], views: [], active: null, agent: null,
    suggestions: [], escalations: [], digest: null, items: [], hidden: { catalog: 0, rejected: 0, retries: 0 }, revealed: null,
    expanded: [], moves: [], lastMove: null, pending: null, away: null,
  };
}
export function observeExpression(s: ExpressionState, trace: Trace, fact: Fact, observedAt?: number) { s.presentationClock = observedAt; agent(s, trace, { ...fact, seq: s.step + 1 }); }
export function actExpression(s: ExpressionState, trace: Trace, intent: PersonIntent) { person(s, trace, { ...intent, at: s.step }); }
// Wall time only releases a paced presentation; it never creates an execution fact.
export function settleExpression(s: ExpressionState, now: number) {
  const recordedTime = s.time;
  s.presentationClock = now; s.time = new Date(now).toISOString(); settle(s); s.time = recordedTime;
}
export function expressionScreen(s: ExpressionState): Screen {
  for (const v of s.views) v.newer = newer(s, v);
  const { lastMove, pending, away, presentationClock, ...screen } = s;
  return structuredClone(screen);
}

function add<T extends ObjectState>(s: Work, object: T): T {
  if (!s.objects[object.id]) { s.objects[object.id] = object; s.order.push(object.id); }
  return s.objects[object.id] as T;
}
const source = (s: Work, name: string, seq: number) => add<SourceState>(s, { id: 'source:' + name, kind: 'source', name, version: 1, savedVersion: null, changedAt: seq, touchedAt: seq, hidden: 0 });
const artifact = (s: Work, name: string, seq: number) => add<ArtifactState>(s, { id: 'artifact:' + name, kind: 'artifact', name, versions: [], changedAt: seq, touchedAt: seq, hidden: 0 });
const view = (s: Work, id: string | null) => s.views.find(v => v.id === id);
const theirs = (v: View) => v.openedBy === 'person' || v.pinned;
// A view by its id, else the object's view the person holds, else any view of it.
const named = (s: Work, target: string) => view(s, target) ?? s.views.find(v => v.object === target && theirs(v)) ?? s.views.find(v => v.object === target);
const showing = (s: Work, object: string, run: number | null) => { const v = view(s, s.active); return !!v && v.object === object && (run === null || v.run === run); };
// A second view of an object adds the version it shows to the object's id.
function key(s: Work, object: string, run: number | null) {
  let id = object;
  while (view(s, id)) id += '@' + run;
  return id;
}
const fresh = (s: Work, object: string, run: number | null, by: View['openedBy'], preview: boolean): View =>
  ({ id: key(s, object, run), object, run, openedBy: by, pinned: false, preview, selection: [], newer: null });

function agent(s: Work, trace: Trace, f: Fact) {
  s.step = f.seq;
  s.time = timeOf(f) ?? s.time;
  const object = f.object ? s.objects[f.object] : undefined;
  if (object) object.touchedAt = f.seq;
  // Reveal: a rejected call changes nothing on screen; it is counted on its object.
  if (f.outcome === 'rejected') { if (object) object.hidden++; else s.hidden.rejected++; return settle(s); }
  const e = f.effect;
  if (!e) return settle(s);
  const byAgent = trace.principals[f.actor]?.kind === 'agent';
  const at = (id: string, run: number | null) => byAgent ? focus(s, f, id, run) : settle(s);
  switch (e.kind) {
    case 'catalog': s.hidden.catalog++; return settle(s);
    // A document first seen when it is opened or run is the copy on disk: saved, until an edit says otherwise.
    case 'open': { if (e.source === null) return settle(s); const seen = !!s.objects['source:' + e.source], o = source(s, e.source, f.seq); o.version = e.version; if (!seen) o.savedVersion = e.version; return at(o.id, null); }
    case 'edit': { const o = source(s, e.source, f.seq); o.version = e.version; o.changedAt = f.seq; return at(o.id, null); }
    case 'save': { const o = source(s, e.source, f.seq); o.savedVersion = e.version; o.changedAt = f.seq; return at(o.id, null); }
    case 'source-state': { const o = source(s, e.source, f.seq); o.version = e.version; o.savedVersion = e.savedVersion; o.changedAt = f.seq; return settle(s); }
    case 'submit': {
      // A run names the script it ran; that script is an object even if nothing opened it.
      if (e.sourceVersion !== null && !s.objects['source:' + e.source]) { const o = source(s, e.source, f.seq); o.version = o.savedVersion = e.sourceVersion; }
      add<RunObject>(s, { id: 'run:' + e.run, kind: 'run', name: 'Run ' + e.run, run: e.run, source: e.source, sourceVersion: e.sourceVersion, state: e.state ?? 'running', exit: null, firstLine: null, verified: [], changedAt: f.seq, touchedAt: f.seq, hidden: 0 });
      return at('run:' + e.run, null);
    }
    case 'retry': { const run = s.objects['run:' + e.run]; if (run) run.hidden++; s.hidden.retries++; return settle(s); }
    case 'run-state':
    case 'ended': {
      const run = s.objects['run:' + e.run] as RunObject;
      if (!run) return settle(s);
      if (e.kind === 'ended') { run.exit = e.exit; run.state = e.state ?? (e.exit === 0 ? 'completed' : e.exit === null ? 'unknown' : 'failed'); }
      else run.state = e.state;
      run.changedAt = f.seq;
      if (run.state === 'failed' || run.state === 'unknown') escalate(s, run, f.seq);
      // The chain counts its last run: once a later run of the source completes, nobody is
      // waiting on the earlier failures. They stay on the chain and in the evidence.
      if (run.state === 'completed') s.escalations = s.escalations.filter(x => { const r = s.objects[x.object]; return !(r?.kind === 'run' && r.source === run.source && r.run < run.run); });
      return at(run.id, null);
    }
    case 'observe': return at('run:' + e.run, null);
    case 'output': {
      const run = s.objects['run:' + e.run] as RunObject, text = e.stream ? trace.runs[e.run]?.outputs[e.stream] ?? '' : '';
      if (e.stream === 'stderr' || (e.stream && !run.firstLine)) run.firstLine = firstLine(text);
      const raised = s.escalations.find(x => x.object === run.id);
      if (raised && run.firstLine) raised.reason = run.firstLine;
      return at(run.id, null);
    }
    case 'verified': {
      const run = s.objects['run:' + e.run] as RunObject, recorded = trace.runs[e.run]?.verified ?? [];
      if (!run) return settle(s);
      run.verified = [...e.artifacts]; run.changedAt = f.seq;
      for (const name of e.artifacts) {
        const a = artifact(s, name, f.seq), digest = recorded.find(r => r.name === name)?.digest ?? 'unknown';
        const known = a.versions.find(v => v.digest === digest);
        if (known) { if (!known.runs.includes(e.run)) known.runs.push(e.run); }
        else { a.versions.push({ digest, runs: [e.run] }); a.changedAt = f.seq; }
      }
      return at(run.id, null);
    }
    case 'registered': {
      const a = artifact(s, e.artifact, f.seq); a.name = e.name;
      const known = a.versions.find(v => v.digest === e.version);
      if (known) { if (e.run !== null && !known.runs.includes(e.run)) known.runs.push(e.run); }
      else { a.versions.push({ digest: e.version, runs: e.run === null ? [] : [e.run] }); a.changedAt = f.seq; }
      return settle(s);
    }
    case 'read': {
      if (e.artifact === null) return settle(s);
      const a = artifact(s, e.artifact, f.seq);
      a.touchedAt = f.seq;
      return at(a.id, e.run);
    }
    case 'layout': return byAgent ? compose(s, f, e.views, e.replace) : settle(s);
    case 'items': if (e.question !== null) s.question = e.question; if (e.items) s.items = e.items; return settle(s);
    case 'ask':
      add<QuestionState>(s, { id: e.question, kind: 'question', name: e.text, author: f.actor, target: e.target, version: e.version, run: e.run, rows: [...e.rows], document: e.document, state: 'prepared', fetchedBy: null, fetchedAt: null, changedAt: f.seq, touchedAt: f.seq, hidden: 0 });
      return settle(s);
    // A receipt, not attention: the question changes wherever it appears, the main area and
    // the Agent's marker stay, and nothing after the fetch is claimed.
    case 'fetched': {
      const q = s.objects[e.question];
      if (q?.kind === 'question') { if (q.state !== 'responded') q.state = 'fetched'; q.fetchedBy = f.actor; q.fetchedAt = f.seq; q.changedAt = f.seq; }
      return settle(s);
    }
    case 'responded': {
      const q = s.objects[e.question];
      if (q?.kind === 'question') { q.state = 'responded'; q.changedAt = f.seq; }
      return settle(s);
    }
  }
}

// Focus: the Agent's attention always lands on its object as a marker. The main area
// follows only while the person follows, and only once per pace window.
function focus(s: Work, f: Fact, object: string, run: number | null) {
  if (s.attention !== 'following') { s.agent = { object, run, seq: f.seq, placement: 'marker' }; return; }
  if (showing(s, object, run)) { s.agent = { object, run, seq: f.seq, placement: 'main' }; s.pending = null; return; }
  if (paced(s, f)) { s.pending = { kind: 'focus', object, run }; s.agent = { object, run, seq: f.seq, placement: 'pending' }; return; }
  s.pending = null;
  show(s, object, run, 'agent');
  s.agent = { object, run, seq: f.seq, placement: 'main' };
  moved(s, f, 'agent', 'agent-focus');
}

// A fact that names no new place still lets a waiting move through once the pace allows.
function settle(s: Work) {
  if (!s.pending || s.attention !== 'following') return;
  const f = { seq: s.step, at: s.time } as Fact;
  if (paced(s, f)) return;
  const p = s.pending; s.pending = null;
  if (p.kind === 'focus') { show(s, p.object, p.run, 'agent'); if (s.agent) s.agent.placement = 'main'; moved(s, f, 'agent', 'agent-focus'); }
  else arrange(s, f, p.views, p.replace);
}

function paced(s: Work, f: Fact) {
  const now = s.presentationClock ?? ms(timeOf(f)) ?? ms(s.time);
  return s.lastMove !== null && now !== null && now - s.lastMove < agentPaceMs;
}
function moved(s: Work, f: Pick<Fact, 'seq' | 'at'>, by: Move['by'], rule: Move['rule']) {
  if (by === 'agent') s.lastMove = s.presentationClock ?? ms(timeOf(f as Fact)) ?? ms(s.time) ?? s.lastMove;
  s.moves.push({ seq: f.seq, by, view: s.active, rule });
}

// The person goes to the view they hold of the object. The Agent goes to a view already
// showing that version, else re-versions one of its own, else takes the preview slot.
function show(s: Work, object: string, run: number | null, by: View['openedBy'], version?: string) {
  const of = s.views.filter(v => v.object === object);
  let v = by === 'person' ? named(s, object)
    : of.find(x => (run === null || x.run === run) && (!version || x.version === version)) ?? of.find(x => !theirs(x));
  if (v && by === 'agent' && run !== null) v.run = run;
  if (!v) {
    v = fresh(s, object, run, by, by === 'agent');
    const slot = by === 'agent' ? s.views.findIndex(x => x.preview) : -1;
    if (slot >= 0) s.views[slot] = v; else s.views.push(v);
  }
  if (by === 'person') { v.preview = false; v.openedBy = 'person'; }
  if (version) v.version = version;
  s.active = v.id;
}

// Compose: applied while following (and paced); otherwise one pending suggestion per
// author, merged rather than stacked. A pinned active view always turns it into a suggestion.
function compose(s: Work, f: Fact, views: ArtifactRef[], replace: boolean) {
  const pinned = s.views.some(v => v.pinned && v.id === s.active);
  if (s.attention === 'following' && !pinned) {
    if (paced(s, f)) { s.pending = { kind: 'layout', views, replace }; return; }
    return arrange(s, f, views, replace);
  }
  const cause = s.attention === 'away' ? 'away' : pinned ? 'pinned' : 'working';
  const open = s.suggestions.find(x => x.id.startsWith('layout'));
  if (open) { open.views = views; open.merged++; open.cause = cause; }
  else s.suggestions.push({ id: 'layout:' + f.seq, views, cause, from: f.seq, merged: 0 });
}
// Never closes or re-versions what the person holds, even for an Agent "replace": the
// Agent's version opens beside it. Accepting the layout is the person's own update.
function arrange(s: Work, f: Pick<Fact, 'seq' | 'at'>, views: ArtifactRef[], replace: boolean, by: View['openedBy'] = 'agent') {
  if (replace) s.views = s.views.filter(theirs);
  let first: string | null = null;
  for (const r of views) {
    const object = r.object ?? 'artifact:' + r.artifact, of = s.views.filter(v => v.object === object);
    let v = of.find(x => x.run === r.run && (!r.version || x.version === r.version)) ?? of.find(x => !theirs(x));
    if (v) { v.run = r.run; v.preview = false; } else s.views.push(v = fresh(s, object, r.run, by, false));
    if (r.version) v.version = r.version;
    first ??= v.id;
  }
  s.active = first ?? s.active;
  moved(s, f, by === 'agent' ? 'agent' : 'person', by === 'agent' ? 'agent-layout' : 'accept');
}

// Supervise: a run the person is waiting on that failed or went unknown. Waiting means
// the main area shows that run, its source, or another run or artifact of that source.
// A follower already sees it in place; someone away gets it in the digest instead.
function escalate(s: Work, run: RunObject, seq: number) {
  if (s.attention !== 'working') return;
  if (Object.values(s.objects).some(o => o.kind === 'run' && o.source === run.source && o.run > run.run && o.state === 'completed')) return;
  const shown = s.objects[view(s, s.active)?.object ?? ''];
  const related = shown && (shown.id === run.id || shown.id === 'source:' + run.source
    || (shown.kind === 'run' && shown.source === run.source)
    || (shown.kind === 'artifact' && shown.versions.some(v => v.runs.some(n => (s.objects['run:' + n] as RunObject | undefined)?.source === run.source))));
  if (related && !s.escalations.some(x => x.object === run.id)) s.escalations.push({ object: run.id, reason: run.state === 'unknown' ? 'Outcome unknown' : run.exit === null ? 'Execution failed' : 'Exit ' + run.exit, from: seq });
}

function person(s: Work, trace: Trace, a: PersonAction) {
  const f = { seq: Math.max(a.at, -1), at: s.time };
  const working = () => { if (s.attention === 'following') s.attention = 'working'; };
  switch (a.kind) {
    case 'follow':
      s.attention = 'following';
      if (s.agent && !showing(s, s.agent.object, s.agent.run)) { show(s, s.agent.object, s.agent.run, 'agent'); s.moves.push({ seq: f.seq, by: 'person', view: s.active, rule: 'catch-up' }); }
      if (s.agent) s.agent.placement = 'main';
      s.pending = null;
      return;
    case 'unfollow': s.attention = 'working'; return;
    case 'open': {
      working();
      if (a.version !== undefined || a.run !== undefined) {
        let v = s.views.find(x => x.object === a.target && x.run === (a.run ?? null) && (!a.version || x.version === a.version));
        if (!v) { v = fresh(s, a.target, a.run ?? null, 'person', false); s.views.push(v); }
        if (a.version) v.version = a.version;
        v.openedBy = 'person'; v.preview = false; s.active = v.id;
        s.escalations = s.escalations.filter(x => x.object !== a.target);
        s.moves.push({ seq: f.seq, by: 'person', view: s.active, rule: 'person' }); return;
      }
      // A question opens on the version it was asked about, an item on the version it
      // names, beside any other version of the same object.
      const q = s.objects[a.target], item = s.items.find(x => 'item:' + x.id === a.target);
      const anchor = q?.kind === 'question' ? { object: q.target, version: q.version, run: q.run } : item?.artifact;
      if (anchor) {
        const v = s.views.find(x => x.object === anchor.object && (x.version ?? versionOf(s, anchor.object, x.run)) === anchor.version);
        if (v) { v.preview = false; v.openedBy = 'person'; s.active = v.id; } else { const n = fresh(s, anchor.object, anchor.run, 'person', false); n.version = anchor.version; s.views.push(n); s.active = n.id; }
        s.moves.push({ seq: f.seq, by: 'person', view: s.active, rule: 'person' });
        return;
      }
      const held = named(s, a.target), object = held?.object ?? a.target;
      if (held) { held.preview = false; held.openedBy = 'person'; s.active = held.id; }
      else show(s, object, object.startsWith('artifact:') ? latest(s, object) : null, 'person');
      s.escalations = s.escalations.filter(x => x.object !== object);
      s.moves.push({ seq: f.seq, by: 'person', view: s.active, rule: 'person' });
      return;
    }
    case 'select': { working(); const v = named(s, a.target); if (v) { v.selection = [...a.rows]; v.preview = false; v.openedBy = 'person'; } return; }
    case 'type': working(); return;
    case 'close': {
      const v = named(s, a.target);
      s.views = s.views.filter(x => x !== v);
      if (v && s.active === v.id) s.active = s.views.at(-1)?.id ?? null;
      return;
    }
    case 'pin': case 'unpin': { const v = named(s, a.target); if (v) { v.pinned = a.kind === 'pin'; v.preview = false; v.openedBy = 'person'; } return; }
    // The update a view of theirs offers: it takes the newest version, and a view that
    // already showed that version closes rather than doubling it.
    case 'update': {
      working();
      const v = named(s, a.target), run = v ? newer(s, v) : null;
      if (!v || run === null) return;
      v.run = run;
      if (v.version) v.version = versionOf(s, v.object, run) ?? undefined;
      s.views = s.views.filter(x => x === v || x.pinned || x.object !== v.object || x.run !== run);
      s.active = v.id;
      s.moves.push({ seq: f.seq, by: 'person', view: s.active, rule: 'person' });
      return;
    }
    case 'leave':
      if (s.attention === 'away') return;
      s.pending = null;
      s.away = { from: s.step, prior: s.attention, baseline: structuredClone(s.objects), suggestions: s.suggestions.map(x => x.id), items: JSON.stringify(s.items) };
      s.attention = 'away';
      return;
    case 'return': {
      if (!s.away) return;
      // Nothing changed, nothing to say: an empty digest would be a card to dismiss.
      const lines = digest(s, s.away);
      s.digest = lines.length ? { from: s.away.from, to: s.step, lines } : null;
      s.attention = s.away.prior; s.away = null;
      return;
    }
    case 'accept': {
      const x = s.suggestions.find(y => y.id === a.suggestion);
      if (!x) return;
      s.suggestions = s.suggestions.filter(y => y !== x);
      arrange(s, f, x.views, false, 'person');
      return;
    }
    // Asking anchors the question on the version the view shows. The replay records no
    // context for it, so it stays prepared.
    case 'ask': {
      working();
      const v = named(s, a.target), version = v ? versionOf(s, v.object, v.run) : null;
      if (!v || version === null || v.run === null) return;
      const id = 'question:asked-' + (s.order.filter(x => x.startsWith('question:asked-')).length + 1);
      add<QuestionState>(s, { id, kind: 'question', name: a.text, author: null, target: v.object, version, run: v.run, rows: [...a.rows], document: null, state: 'prepared', fetchedBy: null, fetchedAt: null, changedAt: f.seq, touchedAt: f.seq, hidden: 0 });
      return;
    }
    case 'dismiss': s.suggestions = s.suggestions.filter(y => y.id !== a.suggestion); return;
    case 'dismiss-digest': s.digest = null; return;
    case 'reveal': s.revealed = a.target; return;
    case 'expand': if (!s.expanded.includes(a.target)) s.expanded.push(a.target); return;
    case 'collapse': s.expanded = s.expanded.filter(x => x !== a.target); return;
  }
}

// Revisit: what changed while the person was away, by object, never as a replay.
function digest(s: Work, away: NonNullable<Work['away']>): DigestLine[] {
  const lines: DigestLine[] = [];
  const rank = { source: 0, run: 1, artifact: 2, question: 3 } as const;
  for (const id of [...s.order].sort((a, b) => rank[s.objects[a]!.kind] - rank[s.objects[b]!.kind])) {
    const now = s.objects[id]!, then = away.baseline[id];
    if (now.kind === 'source' && (!then || (then as SourceState).version !== now.version)) lines.push({ kind: 'source', object: id, from: then ? (then as SourceState).version : null, to: now.version });
    // Runs of one source make one line, led by the latest: the chain counts its last run.
    if (now.kind === 'run' && (!then || (then as RunObject).state !== now.state || (then as RunObject).verified.length !== now.verified.length)) {
      const line: DigestLine = { kind: 'run', object: id, state: now.state, firstLine: now.state === 'completed' ? null : now.firstLine, verified: now.verified.length, earlier: [] };
      const i = lines.findIndex(l => l.kind === 'run' && (s.objects[l.object] as RunObject).source === now.source);
      if (i < 0) lines.push(line);
      else { const before = lines[i] as Extract<DigestLine, { kind: 'run' }>; line.earlier = [...before.earlier, before.object]; lines[i] = line; }
    }
    if (now.kind === 'artifact' && now.versions.length !== ((then as ArtifactState | undefined)?.versions.length ?? 0)) lines.push({ kind: 'artifact', object: id, versions: now.versions.length - ((then as ArtifactState | undefined)?.versions.length ?? 0) });
    if (now.kind === 'question' && (!then || (then as QuestionState).state !== now.state)) lines.push({ kind: 'question', object: id, state: now.state });
  }
  for (const x of s.suggestions) if (!away.suggestions.includes(x.id)) lines.push({ kind: 'suggestion', id: x.id });
  if (JSON.stringify(s.items) !== away.items) lines.push({ kind: 'items', count: s.items.length });
  return lines;
}

// Scale: a source's runs fold behind the latest, the one the chain counts. Folding never
// hides the run the main area shows, the run the Agent is on, or one escalated to the person.
export function chain(screen: Pick<Screen, 'objects' | 'order' | 'views' | 'active' | 'agent' | 'escalations' | 'expanded'>, source: string): { shown: RunObject[]; folded: RunObject[] } {
  const runs = screen.order.map(id => screen.objects[id]!).filter((o): o is RunObject => o.kind === 'run' && o.source === source);
  if (screen.expanded.includes('source:' + source)) return { shown: runs, folded: [] };
  const shown = screen.views.find(v => v.id === screen.active)?.object;
  const keep = (r: RunObject) => r === runs.at(-1) || r.id === shown || r.id === screen.agent?.object || screen.escalations.some(x => x.object === r.id);
  return { shown: runs.filter(keep), folded: runs.filter(r => !keep(r)) };
}

const versionOf = (s: Pick<Screen, 'objects'>, object: string, run: number | null) => {
  const o = s.objects[object];
  return o?.kind === 'artifact' && run !== null ? o.versions.find(x => x.runs.includes(run))?.digest ?? null : null;
};
// What an item gathers, only through its artifact reference: the version it names and the
// run that made it, whose source version is one more step. Null without a reference, or
// before the screen knows that version.
export function collect(screen: Pick<Screen, 'objects'>, item: DeclaredItem): { artifact: ArtifactState; version: string; run: RunObject } | null {
  const ref = item.artifact, o = ref && screen.objects[ref.object], run = ref && screen.objects['run:' + ref.run];
  return ref && o?.kind === 'artifact' && run?.kind === 'run' && o.versions.some(v => v.digest === ref.version) ? { artifact: o, version: ref.version, run } : null;
}
// An item's account appears on views of the version it names, as the Agent's statement.
export function itemsOn(screen: Pick<Screen, 'objects' | 'items'>, view: View): DeclaredItem[] {
  const version = versionOf(screen, view.object, view.run);
  return screen.items.filter(item => item.artifact?.object === view.object && item.artifact.version === version);
}
// A question appears on a view only while the view shows the version it was asked about.
export function questionsOn(screen: Pick<Screen, 'objects' | 'order'>, view: View): QuestionState[] {
  const version = view.version ?? versionOf(screen, view.object, view.run);
  return screen.order.map(id => screen.objects[id]!).filter((q): q is QuestionState => q.kind === 'question' && q.target === view.object && q.version === version);
}
const latest = (s: Work, object: string) => (s.objects[object] as ArtifactState | undefined)?.versions.at(-1)?.runs.at(-1) ?? null;
function newer(s: Work, v: View): number | null {
  const o = s.objects[v.object];
  if (o?.kind !== 'artifact' || v.run === null || !theirs(v)) return null;
  const shown = o.versions.findIndex(x => x.runs.includes(v.run!));
  return shown >= 0 && shown < o.versions.length - 1 ? latest(s, v.object) : null;
}

export function firstLine(text: string) { return text.split('\n').map(l => l.trim()).find(Boolean) ?? null; }
// Where a fact sits in time, in the words the replay and the Reveal panel use.
export function when(fact: Fact): string {
  const clock = (t: string) => t.slice(11, 19);
  if (fact.at) return clock(fact.at);
  if (fact.after && fact.before) return clock(fact.after) + '–' + clock(fact.before);
  if (fact.before) return 'before ' + clock(fact.before);
  if (fact.after) return 'after ' + clock(fact.after);
  return 'time not recorded';
}
