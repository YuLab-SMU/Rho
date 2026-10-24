// Rho's expression layer: what the screen shows, given the facts Rho observed about
// objects and what the person is doing. DOM-free, so the shell, the replay prototype
// and the tests all read the same rules (docs/INTERACTION-MODEL.md).
//
// Facts are about objects; the Agent is only their author. The Agent never asks the
// screen to show anything. It works, and the work moves the screen through six rules:
//   Respond  a fact updates its object wherever the object appears;
//   Focus    the Agent's attention is read from what it last opened, wrote, ran or read;
//   Compose  an Agent layout change applies only while the person follows;
//   Connect  source version, run and artifact version are linked by the facts alone;
//   Reveal   catalog reads, rejected calls and retries wait behind their object;
//   Revisit  a person coming back gets a digest of what changed, never a replay.
// One attention rule decides whether the main area may move: only while the person
// follows, and at most once per agentPaceMs. Moving never re-versions a view the person
// made theirs: the Agent's newer version opens beside it, and theirs offers the update.

// Same protected resource and value as taskMapLimits.agentFormIntervalMs: the
// person's attention and layout stability. Kept equal by test.
export const agentPaceMs = 8000;

export type Effect =
  | { kind: 'catalog' }
  | { kind: 'open'; source: string; version: number }
  | { kind: 'edit'; source: string; version: number }
  | { kind: 'save'; source: string; version: number }
  | { kind: 'submit'; run: number; source: string; sourceVersion: number }
  | { kind: 'retry'; run: number }
  | { kind: 'ended'; run: number; exit: number | null }
  | { kind: 'observe'; run: number }
  | { kind: 'output'; run: number; stream: 'stdout' | 'stderr' }
  | { kind: 'verified'; run: number; artifacts: string[] }
  | { kind: 'read'; artifact: string; run: number }
  | { kind: 'layout'; replace: boolean; views: ArtifactRef[] }
  | { kind: 'items'; question: string; items: DeclaredItem[] };
export interface ArtifactRef { artifact: string; run: number }
export interface DeclaredItem { id: string; kind: string; state: string; title: string; summary?: string }
export interface Fact {
  seq: number;
  label: string;
  actor: 'agent';
  op: string;
  outcome: 'returned' | 'rejected';
  // A recorded time, or only the recorded times on either side of it.
  at: string | null;
  after?: string | null;
  before?: string | null;
  reason?: { kind: string; message: string };
  object?: string;
  effect?: Effect | null;
}
export interface Trace {
  format: 'rho.replay-trace/1';
  recorded: { experiment: string; project: string; from: string; to: string };
  facts: Fact[];
  sources: Record<string, { versions: Record<string, string>; edited: Record<string, string>; saved: Record<string, string> }>;
  runs: Record<string, {
    operationId: string; source: string; sourceVersion: number; declared: string[]; acceptedAt: string;
    exit: number | null; observedAt: string | null; outputs: { stdout?: string; stderr?: string };
    verified?: { name: string; digest: string; kind: string }[];
  }>;
  artifacts: Record<string, { kind: string; versions: Record<string, { runs: number[]; bytes: number; text?: string; file?: string }> }>;
}

export type Attention = 'following' | 'working' | 'away';
export type PersonIntent =
  | { kind: 'follow' } | { kind: 'unfollow' }
  | { kind: 'open'; target: string }
  | { kind: 'select'; target: string; rows: string[] }
  | { kind: 'type'; target: string }
  | { kind: 'close'; target: string }
  | { kind: 'pin'; target: string } | { kind: 'unpin'; target: string }
  | { kind: 'leave' } | { kind: 'return' }
  | { kind: 'accept'; suggestion: string } | { kind: 'dismiss'; suggestion: string }
  | { kind: 'dismiss-digest' }
  | { kind: 'reveal'; target: string | null }
  | { kind: 'update'; target: string };
// A target names a view by its id. The first view of an object takes the object's id,
// so naming an object reaches its view. The person acts after seeing fact `at`; -1 is
// before the first fact.
export type PersonAction = PersonIntent & { at: number };

export type RunState = 'running' | 'completed' | 'failed' | 'unknown';
export interface SourceState { id: string; kind: 'source'; name: string; version: number; savedVersion: number | null; changedAt: number; touchedAt: number; hidden: number }
export interface RunObject {
  id: string; kind: 'run'; name: string; run: number; source: string; sourceVersion: number; state: RunState;
  exit: number | null; firstLine: string | null; verified: string[]; changedAt: number; touchedAt: number; hidden: number;
}
export interface ArtifactState {
  id: string; kind: 'artifact'; name: string;
  // One entry per distinct content, oldest first; runs that produced the same bytes share it.
  versions: { digest: string; runs: number[] }[];
  changedAt: number; touchedAt: number; hidden: number;
}
export type ObjectState = SourceState | RunObject | ArtifactState;
// A view the Agent's focus opened stays a preview: the next Agent move replaces it in
// place. The person opening, selecting in or pinning it makes it theirs, and a view of
// theirs keeps the version it shows until they update it; `newer` is the latest run whose
// bytes differ, when there is one. Two views may show two versions of one object.
export interface View {
  id: string; object: string; run: number | null; openedBy: 'agent' | 'person'; pinned: boolean; preview: boolean; selection: string[];
  newer: number | null;
}
export interface Suggestion { id: string; views: ArtifactRef[]; cause: 'working' | 'away' | 'pinned'; from: number; merged: number }
export interface Escalation { object: string; reason: string; from: number }
export type DigestLine =
  | { kind: 'source'; object: string; from: number | null; to: number }
  | { kind: 'run'; object: string; state: RunState; firstLine: string | null; verified: number }
  | { kind: 'artifact'; object: string; versions: number }
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
  moves: Move[];
}

interface Work extends Screen {
  lastMove: number | null;
  pending: { kind: 'focus'; object: string; run: number | null } | { kind: 'layout'; views: ArtifactRef[]; replace: boolean } | null;
  away: { from: number; prior: Exclude<Attention, 'away'>; baseline: Record<string, ObjectState>; suggestions: string[]; items: number } | null;
}

// A fact with no recorded time is placed at the last recorded time before it, so the
// pace never assumes more time passed than was recorded.
export function timeOf(fact: Fact): string | null { return fact.at ?? fact.after ?? null; }
const ms = (time: string | null) => time === null ? null : Date.parse(time);

export function express(trace: Trace, actions: PersonAction[], step: number, start: Exclude<Attention, 'away'> = 'following'): Screen {
  const s: Work = {
    step: -1, time: null, attention: start, question: null, objects: {}, order: [], views: [], active: null, agent: null,
    suggestions: [], escalations: [], digest: null, items: [], hidden: { catalog: 0, rejected: 0, retries: 0 }, revealed: null,
    moves: [], lastMove: null, pending: null, away: null,
  };
  const last = Math.min(step, trace.facts.length - 1);
  for (const a of actions) if (a.at < 0) person(s, trace, a);
  for (let i = 0; i <= last; i++) {
    agent(s, trace, trace.facts[i]);
    for (const a of actions) if (a.at === i) person(s, trace, a);
  }
  for (const v of s.views) v.newer = newer(s, v);
  const { lastMove, pending, away, ...screen } = s;
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
  switch (e.kind) {
    case 'catalog': s.hidden.catalog++; return settle(s);
    case 'open': source(s, e.source, f.seq).version = e.version; return focus(s, f, 'source:' + e.source, null);
    case 'edit': { const o = source(s, e.source, f.seq); o.version = e.version; o.changedAt = f.seq; return focus(s, f, o.id, null); }
    case 'save': { const o = source(s, e.source, f.seq); o.savedVersion = e.version; o.changedAt = f.seq; return focus(s, f, o.id, null); }
    case 'submit': {
      add<RunObject>(s, { id: 'run:' + e.run, kind: 'run', name: 'Run ' + e.run, run: e.run, source: e.source, sourceVersion: e.sourceVersion, state: 'running', exit: null, firstLine: null, verified: [], changedAt: f.seq, touchedAt: f.seq, hidden: 0 });
      return focus(s, f, 'run:' + e.run, null);
    }
    case 'retry': { const run = s.objects['run:' + e.run]; if (run) run.hidden++; s.hidden.retries++; return settle(s); }
    case 'ended': {
      const run = s.objects['run:' + e.run] as RunObject;
      run.exit = e.exit; run.state = e.exit === 0 ? 'completed' : e.exit === null ? 'unknown' : 'failed'; run.changedAt = f.seq;
      if (run.state !== 'completed') escalate(s, run, f.seq);
      return focus(s, f, run.id, null);
    }
    case 'observe': return focus(s, f, 'run:' + e.run, null);
    case 'output': {
      const run = s.objects['run:' + e.run] as RunObject, text = trace.runs[e.run]?.outputs[e.stream] ?? '';
      if (e.stream === 'stderr' || !run.firstLine) run.firstLine = firstLine(text);
      const raised = s.escalations.find(x => x.object === run.id);
      if (raised && run.firstLine) raised.reason = run.firstLine;
      return focus(s, f, run.id, null);
    }
    case 'verified': {
      const run = s.objects['run:' + e.run] as RunObject, recorded = trace.runs[e.run]?.verified ?? [];
      run.verified = [...e.artifacts]; run.changedAt = f.seq;
      for (const name of e.artifacts) {
        const a = artifact(s, name, f.seq), digest = recorded.find(r => r.name === name)?.digest ?? 'unknown';
        const known = a.versions.find(v => v.digest === digest);
        if (known) { if (!known.runs.includes(e.run)) known.runs.push(e.run); }
        else { a.versions.push({ digest, runs: [e.run] }); a.changedAt = f.seq; }
      }
      return focus(s, f, run.id, null);
    }
    case 'read': {
      const a = artifact(s, e.artifact, f.seq);
      a.touchedAt = f.seq;
      return focus(s, f, a.id, e.run);
    }
    case 'layout': return compose(s, f, e.views, e.replace);
    case 'items': s.question = e.question; s.items = e.items; return settle(s);
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
  const now = ms(timeOf(f)) ?? ms(s.time);
  return s.lastMove !== null && now !== null && now - s.lastMove < agentPaceMs;
}
function moved(s: Work, f: Pick<Fact, 'seq' | 'at'>, by: Move['by'], rule: Move['rule']) {
  if (by === 'agent') s.lastMove = ms(timeOf(f as Fact)) ?? ms(s.time) ?? s.lastMove;
  s.moves.push({ seq: f.seq, by, view: s.active, rule });
}

// The person goes to the view they hold of the object. The Agent goes to a view already
// showing that version, else re-versions one of its own, else takes the preview slot.
function show(s: Work, object: string, run: number | null, by: View['openedBy']) {
  const of = s.views.filter(v => v.object === object);
  let v = by === 'person' ? named(s, object)
    : of.find(x => run === null || x.run === run) ?? of.find(x => !theirs(x));
  if (v && by === 'agent' && run !== null) v.run = run;
  if (!v) {
    v = fresh(s, object, run, by, by === 'agent');
    const slot = by === 'agent' ? s.views.findIndex(x => x.preview) : -1;
    if (slot >= 0) s.views[slot] = v; else s.views.push(v);
  }
  if (by === 'person') { v.preview = false; v.openedBy = 'person'; }
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
    const object = 'artifact:' + r.artifact, of = s.views.filter(v => v.object === object);
    let v = of.find(x => x.run === r.run) ?? of.find(x => !x.pinned && (by === 'person' || !theirs(x)));
    if (v) { v.run = r.run; v.preview = false; } else s.views.push(v = fresh(s, object, r.run, by, false));
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
  const shown = s.objects[view(s, s.active)?.object ?? ''];
  const related = shown && (shown.id === run.id || shown.id === 'source:' + run.source
    || (shown.kind === 'run' && shown.source === run.source)
    || (shown.kind === 'artifact' && shown.versions.some(v => v.runs.some(n => (s.objects['run:' + n] as RunObject | undefined)?.source === run.source))));
  if (related && !s.escalations.some(x => x.object === run.id)) s.escalations.push({ object: run.id, reason: run.exit === null ? 'Outcome unknown' : 'Exit ' + run.exit, from: seq });
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
      s.views = s.views.filter(x => x === v || x.pinned || x.object !== v.object || x.run !== run);
      s.active = v.id;
      s.moves.push({ seq: f.seq, by: 'person', view: s.active, rule: 'person' });
      return;
    }
    case 'leave':
      if (s.attention === 'away') return;
      s.away = { from: s.step, prior: s.attention, baseline: structuredClone(s.objects), suggestions: s.suggestions.map(x => x.id), items: s.items.length };
      s.attention = 'away';
      return;
    case 'return': {
      if (!s.away) return;
      s.digest = { from: s.away.from, to: s.step, lines: digest(s, s.away) };
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
    case 'dismiss': s.suggestions = s.suggestions.filter(y => y.id !== a.suggestion); return;
    case 'dismiss-digest': s.digest = null; return;
    case 'reveal': s.revealed = a.target; return;
  }
}

// Revisit: what changed while the person was away, by object, never as a replay.
function digest(s: Work, away: NonNullable<Work['away']>): DigestLine[] {
  const lines: DigestLine[] = [];
  const rank = { source: 0, run: 1, artifact: 2 } as const;
  for (const id of [...s.order].sort((a, b) => rank[s.objects[a]!.kind] - rank[s.objects[b]!.kind])) {
    const now = s.objects[id]!, then = away.baseline[id];
    if (now.kind === 'source' && (!then || (then as SourceState).version !== now.version)) lines.push({ kind: 'source', object: id, from: then ? (then as SourceState).version : null, to: now.version });
    if (now.kind === 'run' && (!then || (then as RunObject).state !== now.state || (then as RunObject).verified.length !== now.verified.length)) lines.push({ kind: 'run', object: id, state: now.state, firstLine: now.state === 'completed' ? null : now.firstLine, verified: now.verified.length });
    if (now.kind === 'artifact' && now.versions.length !== ((then as ArtifactState | undefined)?.versions.length ?? 0)) lines.push({ kind: 'artifact', object: id, versions: now.versions.length - ((then as ArtifactState | undefined)?.versions.length ?? 0) });
  }
  for (const x of s.suggestions) if (!away.suggestions.includes(x.id)) lines.push({ kind: 'suggestion', id: x.id });
  if (s.items.length !== away.items) lines.push({ kind: 'items', count: s.items.length });
  return lines;
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
