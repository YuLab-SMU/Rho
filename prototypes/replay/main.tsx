import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/theme.css';
import './replay.css';
import traceJson from './trace/airquality.json';
import figureUrl from './trace/temp-effect.run-5.png';
import {
  express, when,
  type ArtifactState, type Attention, type DigestLine, type Fact, type ObjectState, type PersonAction, type PersonIntent, type RunObject, type Screen, type SourceState, type Trace, type View,
} from '../../src/expression.js';

// A behavior prototype, not a product page: the shell above the dock is drawn only
// from express(trace, actions, step). The dock replays the recorded Agent run and
// records what the person does, at the step where they do it.
const trace = traceJson as unknown as Trace;
const last = trace.facts.length - 1;

type Scenario = { id: string; label: string; start: Exclude<Attention, 'away'>; actions: PersonAction[] };
const scenarios: Scenario[] = [
  { id: 'follow', label: 'Follow throughout', start: 'following', actions: [] },
  { id: 'work', label: 'Work in effects.csv from #20', start: 'following', actions: [{ at: 19, kind: 'open', target: 'artifact:effects.csv' }, { at: 19, kind: 'select', target: 'artifact:effects.csv', rows: ['B', 'C'] }] },
  { id: 'away', label: 'Leave at #30, return at #57', start: 'following', actions: [{ at: 29, kind: 'leave' }, { at: 57, kind: 'return' }] },
];

function App() {
  const [step, setStep] = useState(0);
  const [scenario, setScenario] = useState('follow');
  const [actions, setActions] = useState<PersonAction[]>([]);
  const [playing, setPlaying] = useState(false);
  const start = scenarios.find(s => s.id === scenario)?.start ?? 'following';
  const screen = useMemo(() => express(trace, actions, step, start), [actions, step, start]);

  useEffect(() => {
    if (!playing) return;
    if (step >= last) { setPlaying(false); return; }
    const timer = setTimeout(() => setStep(n => Math.min(last, n + 1)), 650);
    return () => clearTimeout(timer);
  }, [playing, step]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowRight') setStep(n => Math.min(last, n + 1));
      else if (e.key === 'ArrowLeft') setStep(n => Math.max(0, n - 1));
      else if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else return;
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // A person's action rewrites what they did after this step, never before it.
  const act = (action: PersonIntent) => setActions(list => [...list.filter(a => a.at <= step), { ...action, at: step }]);
  const pick = (id: string) => { const s = scenarios.find(x => x.id === id)!; setScenario(id); setActions(s.actions); };

  return <div className="replay">
    <Shell screen={screen} act={act} />
    <Dock step={step} setStep={setStep} playing={playing} setPlaying={setPlaying} screen={screen} actions={actions} scenario={scenario} pick={pick} act={act} />
  </div>;
}

type Act = (action: PersonIntent) => void;

function Shell({ screen, act }: { screen: Screen; act: Act }) {
  const active = screen.views.find(v => v.id === screen.active) ?? null;
  return <div className="shell" data-attention={screen.attention}>
    <header className="titlebar">
      <span className="brand">Rho</span>
      <span className="project">{trace.recorded.project}</span>
      {screen.question && <span className="question">{screen.question}</span>}
      <span className="spacer" />
      <button type="button" className="follow" aria-pressed={screen.attention === 'following'} disabled={screen.attention === 'away'} onClick={() => act({ kind: screen.attention === 'following' ? 'unfollow' : 'follow' })}>
        <span className="switch" aria-hidden />Follow
      </button>
    </header>
    <div className="body">
      <Objects screen={screen} act={act} />
      <main className="work">
        <Tabs screen={screen} act={act} />
        {screen.digest && <Digest screen={screen} act={act} />}
        {screen.suggestions.map(x => <div key={x.id} className="strip suggestion">
          <Glyph />
          {x.views.map(v => <span key={v.artifact} className="chip">{v.artifact} <small>run {v.run}</small></span>)}
          {x.merged > 0 && <small>+{x.merged}</small>}
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => act({ kind: 'accept', suggestion: x.id })}>Show</button>
          <button type="button" onClick={() => act({ kind: 'dismiss', suggestion: x.id })}>Dismiss</button>
        </div>)}
        {screen.escalations.map(x => <div key={x.object} className="strip escalation" role="status">
          <strong>{label(screen.objects[x.object])} failed</strong>
          <code>{x.reason}</code>
          <span className="spacer" />
          <button type="button" onClick={() => act({ kind: 'open', target: x.object })}>Open</button>
        </div>)}
        {active ? <ViewBody screen={screen} view={active} act={act} /> : <div className="empty" />}
      </main>
      {screen.revealed && <Reveal screen={screen} act={act} />}
    </div>
  </div>;
}

function Objects({ screen, act }: { screen: Screen; act: Act }) {
  const objects = screen.order.map(id => screen.objects[id]!);
  const runsOf = (name: string) => objects.filter((o): o is RunObject => o.kind === 'run' && o.source === name);
  const rejected = objects.reduce((n, o) => n + o.hidden, 0) + screen.hidden.rejected - screen.hidden.retries;
  const row = (o: ObjectState) => <button type="button" className="object" aria-current={screen.active === o.id} data-fresh={o.changedAt === screen.step || undefined} onClick={() => act({ kind: 'open', target: o.id })}>
    <Mark object={o} />
    <span className="name">{label(o)}</span>
    <span className="fact">{fact(o)}</span>
    {screen.agent?.object === o.id ? <Glyph placement={screen.agent.placement} /> : <span />}
  </button>;
  const artifacts = objects.filter(o => o.kind === 'artifact');
  return <nav className="objects" aria-label="Objects">
    <ul>{objects.filter(o => o.kind === 'source').map(o => <li key={o.id}>
      {row(o)}
      {runsOf(o.name).length > 0 && <ul className="runs">{runsOf(o.name).map(r => <li key={r.id}>{row(r)}</li>)}</ul>}
    </li>)}</ul>
    {artifacts.length > 0 && <ul>{artifacts.map(o => <li key={o.id}>{row(o)}</li>)}</ul>}
    {screen.items.length > 0 && <ol className="account">
      {screen.items.map(item => <li key={item.id}><Glyph /><span>{item.title}</span></li>)}
    </ol>}
    <span className="spacer" />
    <button type="button" className="unseen" onClick={() => act({ kind: 'reveal', target: '*' })}>
      {screen.hidden.catalog} catalog reads · {rejected} rejected{screen.hidden.retries ? ` · ${screen.hidden.retries} retry` : ''}
    </button>
  </nav>;
}

function Tabs({ screen, act }: { screen: Screen; act: Act }) {
  if (!screen.views.length) return null;
  return <div className="tabs" role="tablist">
    {screen.views.map(v => <div key={v.id} role="tab" aria-selected={v.id === screen.active} className="tab" data-pinned={v.pinned || undefined} data-preview={v.preview || undefined}>
      <button type="button" onClick={() => act({ kind: 'open', target: v.id })}>
        <Mark object={screen.objects[v.id]} />{label(screen.objects[v.id])}
        {screen.agent?.object === v.id && <Glyph placement={screen.agent.placement} />}
      </button>
      <button type="button" className="close" aria-label={'Close ' + label(screen.objects[v.id])} onClick={() => act({ kind: 'close', target: v.id })}>×</button>
    </div>)}
  </div>;
}

function ViewBody({ screen, view, act }: { screen: Screen; view: View; act: Act }) {
  const o = screen.objects[view.id];
  if (!o) return null;
  const tools = <span className="tools">
    <button type="button" aria-pressed={view.pinned} onClick={() => act({ kind: view.pinned ? 'unpin' : 'pin', target: view.id })}>{view.pinned ? 'Pinned' : 'Pin'}</button>
    <button type="button" onClick={() => act({ kind: 'reveal', target: view.id })}>History</button>
  </span>;
  if (o.kind === 'source') return <Source key={o.id} source={o} screen={screen} tools={tools} />;
  if (o.kind === 'run') return <Run run={o} screen={screen} tools={tools} act={act} />;
  return <Artifact artifact={o} view={view} screen={screen} tools={tools} act={act} />;
}

function Source({ source, screen, tools }: { source: SourceState; screen: Screen; tools: ReactNode }) {
  const versions = trace.sources[source.name]!.versions;
  const text = versions[source.version] ?? '', previous = new Set((versions[source.version - 1] ?? '').split('\n'));
  const lines = text ? text.split('\n') : [];
  const pre = useRef<HTMLPreElement>(null);
  // A follower is taken to the Agent's change; a person working keeps their scroll.
  const following = screen.attention === 'following';
  useEffect(() => {
    if (following) pre.current?.querySelector('[data-changed]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [source.version, following]);
  return <section className="view">
    <header>
      <h1>{source.name}</h1>
      <span className="fact">v{source.version}{source.savedVersion === source.version ? '' : ' · unsaved'}</span>
      <span className="fact">{edited(source.name, source.version)}</span>
      {tools}
    </header>
    {lines.length ? <pre ref={pre} className={source.name.endsWith('.md') ? 'prose' : 'code'}>{lines.map((line, i) => <span key={i} className="line" data-changed={source.version > 2 && !previous.has(line) || undefined}><i>{i + 1}</i>{line || ' '}{'\n'}</span>)}</pre> : <div className="empty" />}
  </section>;
}

function Run({ run, screen, tools, act }: { run: RunObject; screen: Screen; tools: ReactNode; act: Act }) {
  const recorded = trace.runs[run.run]!;
  const output = run.firstLine && (run.state === 'failed' ? recorded.outputs.stderr : recorded.outputs.stdout);
  return <section className="view">
    <header>
      <h1>{run.name}</h1>
      <span className={'state ' + run.state}>{run.state === 'running' ? 'running' : run.state}{run.exit !== null && run.exit !== 0 ? ' · exit ' + run.exit : ''}</span>
      <button type="button" className="link" onClick={() => act({ kind: 'open', target: 'source:' + run.source })}>{run.source} v{run.sourceVersion}</button>
      {tools}
    </header>
    {output && <pre className={'output ' + run.state}>{output}</pre>}
    <ul className="files">
      {recorded.declared.map(name => {
        const verified = run.verified.includes(name);
        return <li key={name}>
          <button type="button" className="link" disabled={!verified} onClick={() => act({ kind: 'open', target: 'artifact:' + name })}>{name}</button>
          <span className="fact">{verified ? 'bytes verified' : run.state === 'running' ? '' : 'not verified'}</span>
        </li>;
      })}
    </ul>
  </section>;
}

function Artifact({ artifact, view, screen, tools, act }: { artifact: ArtifactState; view: View; screen: Screen; tools: ReactNode; act: Act }) {
  const run = view.run ?? artifact.versions.at(-1)?.runs.at(-1) ?? null;
  const version = artifact.versions.find(v => run !== null && v.runs.includes(run));
  const recorded = version && Object.entries(trace.artifacts[artifact.name]!.versions).find(([digest]) => digest === version.digest)?.[1];
  const earlier = version?.runs.filter(n => n !== run && n < (run ?? 0)) ?? [];
  return <section className="view">
    <header>
      <h1>{artifact.name}</h1>
      {run !== null && <button type="button" className="link" onClick={() => act({ kind: 'open', target: 'run:' + run })}>Run {run}</button>}
      {run !== null && <span className="fact">{trace.runs[run]!.source} v{trace.runs[run]!.sourceVersion}</span>}
      {earlier.length > 0 && <span className="fact">same bytes as run {earlier.join(', ')}</span>}
      {artifact.versions.length > 1 && <span className="fact">{artifact.versions.length} versions</span>}
      {tools}
    </header>
    {recorded?.text ? <Table text={recorded.text} selection={view.selection} onSelect={rows => act({ kind: 'select', target: view.id, rows })} />
      : recorded?.file ? <img className="figure" src={figureUrl} alt={artifact.name + ' from run ' + run} />
      : <div className="empty"><span className="fact">Only run 5's image is kept in this trace</span></div>}
  </section>;
}

function Table({ text, selection, onSelect }: { text: string; selection: string[]; onSelect: (rows: string[]) => void }) {
  const [head, ...rows] = parseCsv(text);
  const toggle = (key: string) => onSelect(selection.includes(key) ? selection.filter(k => k !== key) : [...selection, key]);
  return <div className="table"><table>
    <thead><tr>{head!.map(h => <th key={h}>{h}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row[0] + row[3]} aria-selected={selection.includes(row[0]!)} onClick={() => toggle(row[0]!)}>
      {row.map((cell, i) => <td key={i} title={cell}>{number(cell)}</td>)}
    </tr>)}</tbody>
  </table></div>;
}

function Digest({ screen, act }: { screen: Screen; act: Act }) {
  const d = screen.digest!;
  return <section className="digest" aria-label="While you were away">
    <header>
      <strong>{when(trace.facts[d.from]!)} – {when(trace.facts[d.to]!)}</strong>
      <span className="spacer" />
      <button type="button" onClick={() => act({ kind: 'dismiss-digest' })}>Dismiss</button>
    </header>
    <ul>{d.lines.map((line, i) => <li key={i}>{digestLine(line, screen, act)}</li>)}</ul>
  </section>;
}

function digestLine(line: DigestLine, screen: Screen, act: Act): ReactNode {
  const open = (target: string, text: ReactNode) => <button type="button" className="link" onClick={() => act({ kind: 'open', target })}>{text}</button>;
  switch (line.kind) {
    case 'source': return <>{open(line.object, label(screen.objects[line.object]))} {line.from === null ? 'v' + line.to : `v${line.from} → v${line.to}`}</>;
    case 'run': return <>{open(line.object, label(screen.objects[line.object]))} <span className={'state ' + line.state}>{line.state}</span> {line.firstLine ? <code>{line.firstLine}</code> : line.verified ? `${line.verified} files verified` : null}</>;
    case 'artifact': return <>{open(line.object, label(screen.objects[line.object]))} +{line.versions} version</>;
    case 'suggestion': return <>Layout suggestion waiting</>;
    case 'items': return <>{line.count} items declared by the Agent</>;
  }
}

function Reveal({ screen, act }: { screen: Screen; act: Act }) {
  const target = screen.revealed!;
  const facts = trace.facts.slice(0, screen.step + 1).filter(f => target === '*' ? !f.object || f.outcome === 'rejected' || f.effect?.kind === 'retry' : f.object === target);
  return <aside className="reveal" aria-label="History">
    <header>
      <strong>{target === '*' ? 'Not shown on screen' : label(screen.objects[target])}</strong>
      <span className="spacer" />
      <button type="button" aria-label="Close history" onClick={() => act({ kind: 'reveal', target: null })}>×</button>
    </header>
    <ol>{facts.map(f => <li key={f.seq} data-rejected={f.outcome === 'rejected' || undefined}>
      <span className="seq">#{f.seq}</span>
      <span className="op">{f.op}</span>
      <span className="time">{when(f)}</span>
      {f.reason && <span className="reason">{f.reason.kind}: {f.reason.message}</span>}
    </li>)}</ol>
  </aside>;
}

function Dock({ step, setStep, playing, setPlaying, screen, actions, scenario, pick, act }: {
  step: number; setStep: (n: number) => void; playing: boolean; setPlaying: (p: boolean) => void; screen: Screen;
  actions: PersonAction[]; scenario: string; pick: (id: string) => void; act: Act;
}) {
  const f = trace.facts[step]!;
  return <footer className="dock" aria-label="Replay">
    <div className="controls">
      <button type="button" aria-label="Previous call" onClick={() => setStep(Math.max(0, step - 1))}>‹</button>
      <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (step >= last) setStep(0); setPlaying(!playing); }}>{playing ? '❚❚' : '▶'}</button>
      <button type="button" aria-label="Next call" onClick={() => setStep(Math.min(last, step + 1))}>›</button>
      <span className="now">
        <b>#{f.seq}</b> {f.op} <i>{target(f)}</i> {f.outcome === 'rejected' && <em>rejected · {f.reason?.kind}</em>} <time>{when(f)}</time>
      </span>
      <span className="spacer" />
      <span className="attention" data-attention={screen.attention}>{screen.attention}</span>
      <button type="button" onClick={() => act({ kind: screen.attention === 'away' ? 'return' : 'leave' })}>{screen.attention === 'away' ? 'Return' : 'Leave'}</button>
    </div>
    <Scrubber step={step} setStep={setStep} actions={actions} screen={screen} />
    <div className="scenarios" role="radiogroup" aria-label="Person">
      {scenarios.map(s => <button key={s.id} type="button" role="radio" aria-checked={scenario === s.id} onClick={() => pick(s.id)}>{s.label}</button>)}
      <span className="spacer" />
      <span className="source">{trace.recorded.experiment} · {trace.facts.length} calls · {trace.recorded.from.slice(11, 19)}–{trace.recorded.to.slice(11, 19)}</span>
    </div>
  </footer>;
}

// One tick per recorded call: writes and runs tall, reads short, catalog faint,
// rejected red; the person's actions sit below the line.
function Scrubber({ step, setStep, actions, screen }: { step: number; setStep: (n: number) => void; actions: PersonAction[]; screen: Screen }) {
  const width = 100 / trace.facts.length;
  return <div className="scrubber">
    <svg viewBox={`0 0 ${trace.facts.length} 30`} preserveAspectRatio="none" aria-hidden>
      {trace.facts.map(f => <rect key={f.seq} x={f.seq + 0.4} width={0.2} y={tickY(f)} height={20 - tickY(f)} className={'tick ' + tickKind(f)} />)}
      {screen.moves.map((m, i) => <rect key={'m' + i} x={m.seq + 0.15} width={0.7} y={22.5} height={1.5} className={'move ' + m.by} />)}
      {actions.map((a, i) => <circle key={'a' + i} cx={a.at + 0.5} cy={27} r={0.45} className="person" />)}
    </svg>
    <input type="range" min={0} max={last} value={step} onChange={e => setStep(Number(e.target.value))} aria-label="Call" style={{ ['--progress' as string]: `${(step + 0.5) * width}%` }} />
  </div>;
}

function tickKind(f: Fact) {
  if (f.outcome === 'rejected') return 'rejected';
  const k = f.effect?.kind;
  if (k === 'catalog') return 'catalog';
  if (k === 'ended') return trace.runs[(f.effect as { run: number }).run]?.exit === 0 ? 'ok' : 'failed';
  if (k === 'edit' || k === 'save' || k === 'submit' || k === 'layout' || k === 'items' || k === 'verified') return 'write';
  return 'read';
}
const tickY = (f: Fact) => ({ catalog: 16, read: 11, write: 5, ok: 1, failed: 1, rejected: 15 } as Record<string, number>)[tickKind(f)] ?? 10;
function target(f: Fact) {
  const e = f.effect;
  if (!e) return f.object?.replace(/^\w+:/, '') ?? '';
  if ('source' in e && e.kind !== 'submit') return e.source + ' v' + e.version;
  if (e.kind === 'submit') return `run ${e.run} · ${e.source} v${e.sourceVersion}`;
  if (e.kind === 'read') return `${e.artifact} · run ${e.run}`;
  if (e.kind === 'layout') return e.views.map(v => v.artifact).join(', ');
  if (e.kind === 'items') return e.items.length + ' items';
  if ('run' in e) return 'run ' + e.run + (e.kind === 'ended' ? ` · exit ${e.exit}` : e.kind === 'output' ? ' · ' + e.stream : '');
  return '';
}

function Mark({ object }: { object?: ObjectState }) {
  if (!object) return null;
  if (object.kind === 'run') return <span className={'mark run ' + object.state} aria-hidden>{object.run}</span>;
  return <span className={'mark ' + (object.kind === 'source' ? (object.name.endsWith('.md') ? 'doc' : 'code') : trace.artifacts[object.name]?.kind === 'media' ? 'image' : 'table')} aria-hidden />;
}
function Glyph({ placement }: { placement?: 'main' | 'pending' | 'marker' }) {
  return <svg className="glyph" data-placement={placement} viewBox="0 0 16 16" aria-label="Agent"><path d="M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" /></svg>;
}
function label(o?: ObjectState) { return o?.name ?? ''; }
// Versions as dots: one per distinct content, so "same bytes" needs no words.
function fact(o: ObjectState): ReactNode {
  if (o.kind === 'source') return 'v' + o.version;
  if (o.kind === 'run') return 'v' + o.sourceVersion;
  return <span className="dots" aria-label={o.versions.length + ' versions'}>{o.versions.map(v => <i key={v.digest} />)}</span>;
}
function edited(name: string, version: number) {
  const at = trace.sources[name]!.edited[version];
  return at ? 'Agent · ' + at.slice(11, 19) : '';
}
function number(cell: string) {
  const n = Number(cell);
  return cell !== '' && !Number.isNaN(n) && /[.e]/.test(cell) ? (Math.abs(n) < 1e-3 ? n.toExponential(2) : n.toPrecision(4)) : cell;
}
function parseCsv(text: string) {
  const rows: string[][] = [];
  for (const line of text.trim().split('\n')) {
    const cells: string[] = []; let cell = '', quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cell); cell = ''; }
      else cell += ch;
    }
    rows.push([...cells, cell]);
  }
  return rows;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
