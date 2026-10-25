import { useLayoutEffect, useRef, useState } from 'react';
import type { DigestLine, ObjectState, QuestionState, RunObject, Screen } from '../../src/expression.js';
import { liveLimits } from '../../src/live-workspace.js';
import type { Live } from './live.js';

// What Rho adds above the work (docs/WORKSPACE-PLAN.md §2): one persistent line, at most
// one interruption, a capped digest on return and the recorded evidence on request. Every
// word comes from Screen and the owner records; nothing here decides what moves.
export type Namer = (object: string) => string;
export function namer(live: Live): Namer {
  const name = (object: string): string => {
    const item = live.screen?.objects[object];
    return item?.kind === 'question' ? 'Question about ' + name(item.target) : live.state?.names[object] ?? item?.name ?? object;
  };
  return name;
}
const runWords: Record<string, string> = { running: 'running', completed: 'completed', failed: 'failed', unknown: 'outcome unknown', unobserved: 'accepted, not observed' };
const questionWords: Record<string, string> = { prepared: 'prepared, not fetched', fetched: 'fetched by the Agent', responded: 'answered by the Agent' };
// An object's state in the words a reader uses.
export function stateOf(item: ObjectState | undefined): string {
  if (!item) return '';
  if (item.kind === 'run') return runWords[item.state] ?? item.state;
  if (item.kind === 'source') return item.savedVersion !== null && item.savedVersion !== item.version ? `version ${item.version}, unsaved` : `version ${item.version}`;
  if (item.kind === 'artifact') return item.versions.length === 1 ? '1 version' : `${item.versions.length} versions`;
  return questionWords[item.state] ?? item.state;
}
// The runs of the source the Agent is on (or the person is looking at), oldest first.
export function chainOf(screen: Screen, focus: string | null): RunObject[] {
  const objects = Object.values(screen.objects);
  const item = focus ? screen.objects[focus] : undefined;
  const source = item?.kind === 'run' ? item.source : item?.kind === 'source' ? item.id
    : item?.kind === 'artifact' ? objects.find((o): o is RunObject => o.kind === 'run' && item.versions.some(v => v.runs.includes(o.run)))?.source : undefined;
  return source ? objects.filter((o): o is RunObject => o.kind === 'run' && o.source === source).sort((a, b) => a.run - b.run) : [];
}

// Whether a failed run is still the current state of its script: a later run of the same
// script that completed replaced it, so it keeps its shape and steps back (R7).
function superseded(screen: Screen, run: RunObject) {
  return run.state === 'failed' && Object.values(screen.objects).some(o => o.kind === 'run' && o.source === run.source && o.run > run.run && o.state === 'completed');
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Time along the bar, with long quiet stretches cut short: a pause of more than two minutes
// takes the room of two minutes and is drawn as a break, so hours of quiet never crush the work.
const longest = 120000;
function axis(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b), stops: Array<[number, number]> = [], breaks: number[] = [];
  let at = 0;
  sorted.forEach((t, i) => { if (i) { const gap = t - sorted[i - 1]; at += Math.min(gap, longest); if (gap > longest) breaks.push(at - longest / 2); } stops.push([t, at]); });
  const total = Math.max(1, at);
  const x = (t: number) => { let i = stops.findIndex(([time]) => time >= t); if (i < 0) i = stops.length - 1; return stops.length ? stops[i][1] / total : 0; };
  return { x, breaks: breaks.map(b => b / total) };
}
// The recorded activity along time: one tick per recorded fact, a numbered mark where each
// run was submitted. Ticks are the record, never a progress estimate.
function Timeline({ live, narrow }: { live: Live; narrow: boolean }) {
  const screen = live.screen!, state = live.state!, name = namer(live), act = live.act;
  const facts = state.evidence.filter(f => f.at), place = axis(facts.map(f => Date.parse(f.at!)));
  const runs = Object.values(screen.objects).filter((o): o is RunObject => o.kind === 'run').sort((a, b) => a.run - b.run);
  const [width, setWidth] = useState(0), track = useRef<HTMLSpanElement>(null);
  // The latest runs, as many as the bar has room for.
  const shown = runs.slice(narrow ? -4 : -Math.min(12, width ? Math.max(1, Math.floor(width / 26) + 1) : 12));
  const at = (run: RunObject) => { const f = state.evidence.find(f => f.object === run.id && f.at); return f ? place.x(Date.parse(f.at!)) : null; };
  const kind = (actor: string) => state.trace.principals[actor]?.kind ?? 'operator';
  useLayoutEffect(() => {
    const el = track.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width)); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Marks keep their order and never overlap: each sits at its time or just after the one before,
  // and when that runs past the end they close up from the right.
  const gap = width ? Math.min(24 / width, 1 / Math.max(1, shown.length - 1)) : 0.035;
  const xs = shown.map((run, i) => at(run) ?? (shown.length > 1 ? i / (shown.length - 1) : 1));
  for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap);
  for (let i = xs.length - 1; i >= 0; i--) xs[i] = Math.min(xs[i], i === xs.length - 1 ? 1 : xs[i + 1] - gap);
  const marks = shown.map((run, i) => ({ run, x: Math.max(0, xs[i]) }));
  const latest = runs.at(-1);
  return <span ref={track} className={'shell-timeline' + (narrow ? ' inline' : '')} role="group" aria-label="Runs over time">
    {!narrow && facts.length > 0 && <span className="shell-ticks" aria-hidden="true">
      {facts.map(f => <i key={f.seq} className={kind(f.actor)} style={{ left: (place.x(Date.parse(f.at!)) * 100).toFixed(2) + '%' }} />)}
      {place.breaks.map(b => <b key={b} className="shell-gap" style={{ left: (b * 100).toFixed(2) + '%' }} />)}
    </span>}
    {marks.map(({ run, x }) => <button key={run.id} className={'shell-mark ' + run.state + (superseded(screen, run) ? ' superseded' : '') + (run === latest ? ' latest' : '')} style={narrow ? undefined : { left: `calc(${(x * 100).toFixed(2)}% - 10px)` }}
      aria-label={`${name(run.id)} ${run.state}`} title={`${name(run.id)} · ${runWords[run.state] ?? run.state}${superseded(screen, run) ? ' · a later run completed' : ''}`} onClick={() => act({ kind: 'open', target: run.id })}>{run.run}</button>)}
  </span>;
}

// The Agent's object and its state, one press from the object itself (E1).
function AgentMarker({ live, who = true }: { live: Live; who?: boolean }) {
  const screen = live.screen!, agent = screen.agent, name = namer(live);
  if (!agent) return null;
  return <button className="shell-agent" data-rho-agent="" title={`The Agent's latest object: ${name(agent.object)}`} onClick={() => live.act({ kind: 'open', target: agent.object })}>
    <span className={who ? 'shell-agent-who' : 'visually-hidden'}>Agent</span>{' '}<span className="shell-agent-object">{name(agent.object)}</span>{' '}<span className="shell-agent-state">{stateOf(screen.objects[agent.object])}{agent.placement === 'pending' ? ' · shows when you pause' : ''}</span>
  </button>;
}

// The activity bar under the work: what was recorded and when, which runs it holds, and the
// person's own place (following, working, away). Below 1280 it also names the Agent's object,
// which the Agent column says above it.
export function Bar({ live, evidence, onEvidence, held, narrow, column }: { live: Live; evidence: boolean; onEvidence: () => void; held: number; narrow: boolean; column: boolean }) {
  const { screen, act } = live;
  if (!screen || !live.state) return <div className="shell-bar" data-rho-layer="persistent" role="status">Reading what the Agent did…</div>;
  const following = screen.attention === 'following', notes = screen.items.length;
  const times = live.state.evidence.filter(f => f.at).map(f => f.at!).sort();
  return <div className="shell-bar" data-rho-layer="persistent" data-attention={screen.attention}>
    {!narrow && times.length > 0 && <span className="shell-span"><strong>{live.state.evidence.length} actions</strong> {clock(times[0])} – {clock(times.at(-1)!)}</span>}
    {!column && <AgentMarker live={live} />}
    <span className="shell-break" aria-hidden="true" />
    <Timeline live={live} narrow={narrow} />
    {held > 0 && <span className="shell-held" role="status">{held} waiting</span>}
    <button className="shell-follow" aria-pressed={following} title={following ? 'The main area follows the Agent; any input of yours stops that' : 'Your views stay where you put them'} onClick={() => act({ kind: following ? 'unfollow' : 'follow' })}>
      <span className="shell-switch" aria-hidden="true" /><span className="shell-follow-word">{following ? 'Following' : screen.attention === 'away' ? 'Away' : 'Working'}</span>
    </button>
    <button className="shell-quiet" onClick={() => act({ kind: screen.attention === 'away' ? 'return' : 'leave' })}>{screen.attention === 'away' ? 'Return' : 'Step away'}</button>
    <button className="shell-quiet shell-evidence-toggle" aria-expanded={evidence} onClick={onEvidence}>{notes > 0 && `${notes} Agent ${notes === 1 ? 'note' : 'notes'} · `}<span className="shell-wide-word">Recorded evidence</span><span className="shell-narrow-word" aria-hidden="true">Evidence</span></button>
  </div>;
}

// What a declared item's state means to Rho, when the Agent gave it a role.
function roleOf(live: Live, id: string) {
  const item = live.map?.items.find(i => i.id === id);
  return item ? live.map!.vocabulary.states[item.state]?.role ?? '' : '';
}
const questionLong: Record<string, string> = { prepared: 'Prepared · not fetched by the Agent', fetched: 'Fetched by the Agent · no linked response yet', responded: 'Answered by the Agent' };
// The Agent's column (1280 and wider): who is working and on what, the items it declared
// in its own words, the person's questions and how far each got, and the recorded calls on
// request. Every line is the Agent's statement or an owner record; nothing is estimated.
export function AgentColumn({ live, principalId, evidence, onEvidence, focusObject }: { live: Live; principalId?: string; evidence: boolean; onEvidence: () => void; focusObject: string | null }) {
  const screen = live.screen, state = live.state, name = namer(live);
  if (!screen || !state) return null;
  const agents = Object.entries(state.trace.principals).filter(([, p]) => p.kind === 'agent');
  const who = agents.find(([, p]) => p.name)?.[1].name ?? 'The Agent';
  const lastAgent = [...state.evidence].reverse().find(f => f.at && state.trace.principals[f.actor]?.kind === 'agent');
  const running = Object.values(screen.objects).some(o => o.kind === 'run' && o.state === 'running');
  const questions = Object.values(screen.objects).filter((o): o is QuestionState => o.kind === 'question');
  // The item the person is looking at, or the one the Agent says it is working on, opens up.
  const current = screen.items.find(i => focusObject && (i.artifact?.object === focusObject)) ?? screen.items.find(i => roleOf(live, i.id) === 'working');
  return <aside className="agent-column" aria-label={who} data-scroll-region="" tabIndex={0}>
    <section className="agent-card">
      <header className="agent-card-head"><span className={'agent-dot' + (running ? ' running' : '')} aria-hidden="true" /><strong>{who}</strong>
        <span className="agent-card-meta">{running ? 'running' : lastAgent ? 'last action ' + clock(lastAgent.at!) : 'no recorded action'}</span></header>
      <AgentMarker live={live} who={false} />
      {screen.items.length > 0 && <section className="agent-items" aria-label="The Agent's notes">
        <ol>{screen.items.map(i => {
          const role = roleOf(live, i.id), open = i === current, target = i.artifact?.object;
          // The artifact's name, unless the title already says it.
          const where = target && !i.title.includes(name(target)) ? name(target) : '';
          return <li key={i.id} className={'agent-item ' + (role || 'declared') + (open ? ' current' : '')} data-fact="agent">
            <span className="agent-item-mark" aria-hidden="true" />
            {target ? <button className="agent-item-title" onClick={() => live.act({ kind: 'open', target, run: i.artifact!.run, version: i.artifact!.version })}>{i.title}</button> : <span className="agent-item-title">{i.title}</span>}
            <span className="agent-item-meta">{where}{role === 'done' ? <span className="visually-hidden">{where && ' · '}{i.state}</span> : (where && ' · ') + i.state}</span>
            {open && (i.summary || i.lines?.length) ? <div className="agent-item-body">
              {i.summary && <p>{i.summary}</p>}
              {i.lines?.map((l, k) => <p key={k}>{l.label ? l.label + ': ' : ''}{l.text}{l.judgment ? " · the Agent's reading" : ''}</p>)}
            </div> : null}
          </li>;
        })}</ol>
      </section>}
    </section>
    {questions.length > 0 && <section className="agent-card" aria-label="Your questions">
      <header className="agent-card-head"><strong>Your questions</strong></header>
      <ul className="agent-questions">{questions.map(q => <li key={q.id} className={'agent-question ' + q.state}>
        <p data-user-text="">{q.name}</p>
        <button className="shell-link" onClick={() => live.act({ kind: 'open', target: q.target })}>{name(q.target)}</button>
        <span className="agent-question-state">{questionLong[q.state] ?? q.state}</span>
      </li>)}</ul>
    </section>}
    <section className="agent-card agent-record">
      <button className="shell-quiet agent-record-toggle" aria-expanded={evidence} onClick={onEvidence}>Recorded calls<span className="agent-card-meta">{state.evidence.length}</span></button>
      {evidence && <Evidence live={live} principalId={principalId} notes={false} />}
    </section>
  </aside>;
}

type Waiting = { key: string; kind: 'problem' | 'escalation' | 'suggestion'; text: string; object?: string; suggestion?: string };
export function waiting(live: Live): Waiting[] {
  const screen = live.screen, items: Waiting[] = [];
  if (live.problem) items.push({ key: 'problem', kind: 'problem', text: live.problem });
  for (const e of screen?.escalations ?? []) items.push({ key: 'e:' + e.object, kind: 'escalation', object: e.object, text: e.reason });
  for (const s of screen?.suggestions ?? []) items.push({ key: 's:' + s.id, kind: 'suggestion', suggestion: s.id, text: 'The Agent arranged a new layout' + (s.merged ? ` · ${s.merged + 1} changes combined` : '') });
  return items;
}
// The one interruption: a failure the person waits on, or a layout waiting for their
// decision. More of them are counted, never stacked.
export function Interruption({ live, items, onHide }: { live: Live; items: Waiting[]; onHide: (key: string) => void }) {
  const [index, setIndex] = useState(0), name = namer(live), item = items[Math.min(index, items.length - 1)];
  if (!item) return null;
  return <div className={'shell-interruption ' + item.kind} data-rho-layer="transient" data-rho-interruption="" role={item.kind === 'problem' ? 'alert' : 'status'}>
    {item.object && <button className="shell-link" onClick={() => live.act({ kind: 'open', target: item.object! })}>{name(item.object)}</button>}
    <span className="shell-interruption-text">{item.text}</span>
    {item.suggestion && <><button onClick={() => live.act({ kind: 'accept', suggestion: item.suggestion! })}>Open update</button><button onClick={() => live.act({ kind: 'dismiss', suggestion: item.suggestion! })}>Dismiss</button></>}
    {items.length > 1 && <button className="shell-quiet" onClick={() => setIndex(i => (i + 1) % items.length)}>Next of {items.length}</button>}
    {!item.suggestion && <button className="shell-quiet" aria-label="Hide until it changes" onClick={() => onHide(item.key + ':' + item.text)}>Hide</button>}
  </div>;
}

function line(l: DigestLine) {
  switch (l.kind) {
    case 'source': return l.from === null ? `edited, now version ${l.to}` : `version ${l.from} → ${l.to}`;
    case 'run': return [runWords[l.state] ?? l.state, l.verified ? `${l.verified} file${l.verified === 1 ? '' : 's'} verified` : '', l.firstLine ?? '', l.earlier.length ? `${l.earlier.length} earlier run${l.earlier.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    case 'artifact': return l.versions === 1 ? '1 new version' : `${l.versions} new versions`;
    case 'question': return questionWords[l.state] ?? l.state;
    case 'suggestion': return 'The Agent arranged a new layout';
    case 'items': return `the Agent's notes changed · ${l.count} now`;
  }
}
// What changed while the person was away, one line per object, at most six lines.
export function Digest({ live }: { live: Live }) {
  const screen = live.screen, name = namer(live), [all, setAll] = useState(false);
  if (!screen?.digest) return null;
  // A layout still waiting for a decision is the interruption's to say; the digest does not repeat it.
  const lines = screen.digest.lines.filter(l => l.kind !== 'suggestion' || !screen.suggestions.length), shown = all ? lines : lines.slice(0, lines.length > 6 ? 5 : 6);
  if (!lines.length) return null;
  return <section className="shell-digest" data-rho-layer="transient" data-rho-digest="" aria-label="Changes while away" {...(all ? { 'data-scroll-region': '', tabIndex: 0 } : {})}>
    <header><strong>While you were away</strong><button className="shell-quiet" onClick={() => live.act({ kind: 'dismiss-digest' })}>Dismiss</button></header>
    <ul>{shown.map((l, i) => <li key={i}>{'object' in l ? <button className="shell-link" onClick={() => live.act({ kind: 'open', target: l.object })}>{name(l.object)}</button> : null}<span>{line(l)}</span></li>)}</ul>
    {shown.length < lines.length && <button className="shell-quiet" onClick={() => setAll(true)}>{lines.length - shown.length} more</button>}
  </section>;
}

// The recorded calls behind the screen, with each principal named.
export function Evidence({ live, principalId, notes = true }: { live: Live; principalId?: string; notes?: boolean }) {
  const state = live.state, name = namer(live);
  if (!state) return null;
  const who = (actor: string) => {
    if (principalId && actor === principalId) return 'You';
    const p = state.trace.principals[actor];
    return p?.kind === 'agent' ? (p.name ?? 'The Agent') : p?.kind === 'browser' ? 'Another browser tab' : actor === 'operator' ? 'Rho' : p?.name ?? 'Unrecorded principal';
  };
  return <section className="shell-evidence" data-rho-layer="transient" data-rho-evidence="" data-scroll-region="" tabIndex={0} aria-label="Recorded activity">
    {notes && live.screen && live.screen.items.length > 0 && <section aria-label="The Agent's notes" className="shell-notes">
      <h3>The Agent's notes{live.screen.question ? ' · ' + live.screen.question : ''}</h3>
      <ul>{live.screen.items.map(i => <li key={i.id} data-fact="agent">
        <strong>{i.title}</strong><span> · {i.kind} · {i.state}</span>
        {i.artifact && <button className="shell-link" onClick={() => live.act({ kind: 'open', target: i.artifact!.object, run: i.artifact!.run, version: i.artifact!.version })}>{name(i.artifact.object)}</button>}
        {i.summary && <p>{i.summary}</p>}
        {i.lines?.map((l, k) => <p key={k}>{l.label ? l.label + ': ' : ''}{l.text}{l.judgment ? " · the Agent's reading" : ''}</p>)}
      </li>)}</ul>
    </section>}
    <p>Owner observations and the Agent's recorded calls. Calls an adapter refused on its own are not recorded here.</p>
    {state.gap && <p role="status">Earlier activity is outside the retained window. No missing calls were reconstructed.</p>}
    <ol>{state.evidence.slice().reverse().map((f, i) => <li key={i}>
      <time>{f.at ? new Date(f.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Time not recorded'}</time>
      <strong>{who(f.actor)}</strong><code>{f.op}</code><span>{f.object ? name(f.object) : 'Object not recorded'}{f.outcome === 'rejected' ? ` · refused (${f.reason?.kind ?? 'reason not recorded'})` : ''}</span>
    </li>)}</ol>
    <p>The latest {state.evidence.length} facts are kept (limit {liveLimits.maxEvidence}).</p>
  </section>;
}
