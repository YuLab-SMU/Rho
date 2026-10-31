import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceSnapshot } from '../../src/browser.js';
import type { DigestLine, ObjectState, QuestionState, RunObject, Screen } from '../../src/expression.js';
import { liveLimits } from '../../src/live-workspace.js';
import { Icon } from '../icons.js';
import type { Live } from './live.js';
import { fileIcon } from './facts.js';

// What Rho adds above the work: one persistent line, at most
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
const runWords: Record<string, string> = { running: 'running', completed: 'completed', failed: 'failed', unknown: 'outcome unknown', unobserved: 'accepted, not seen running yet' };
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
// script that completed replaced it, so it keeps its shape and steps back.
function superseded(screen: Screen, run: RunObject) {
  return run.state === 'failed' && Object.values(screen.objects).some(o => o.kind === 'run' && o.source === run.source && o.run > run.run && o.state === 'completed');
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// A time with its day when that is not today; a span names both days when it crosses one.
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const minutes = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const when = (iso: string) => (sameDay(iso, new Date().toISOString()) ? '' : day(iso) + ' ') + clock(iso);
const span = (a: string, b: string) => sameDay(a, b) ? when(a) + ' – ' + clock(b) : `${day(a)} ${clock(a)} – ${day(b)} ${clock(b)}`;
// The Agent's object and its state, one press from the object itself.
function AgentMarker({ live, who = true }: { live: Live; who?: boolean }) {
  const screen = live.screen!, agent = screen.agent, name = namer(live);
  if (!agent) return null;
  return <button className="shell-agent" data-rho-agent="" title={`The Agent's latest object: ${name(agent.object)}`} onClick={() => live.act({ kind: 'open', target: agent.object })}>
    <span className={who ? 'shell-agent-who' : 'visually-hidden'}>Agent</span>{' '}<span className="shell-agent-object">{name(agent.object)}</span>{' '}<span className="shell-agent-state">{stateOf(screen.objects[agent.object])}{agent.placement === 'pending' ? ' · shows when you pause' : ''}</span>
  </button>;
}

// Where the application follows the Agent itself, the bar leaves following to it.
export function Bar({ live, evidence, onEvidence, held, attention = true }: { live: Live; evidence: boolean; onEvidence: () => void; held: number; attention?: boolean }) {
  const { screen, act } = live;
  if (!screen || !live.state) return <div className="shell-bar" role="status">Reading workspace…</div>;
  const following = screen.attention === 'following';
  return <div className="shell-bar" data-attention={screen.attention}>
    <AgentMarker live={live} />
    <span className="shell-break" />
    {held > 0 && <span className="shell-held" role="status">{held} updates</span>}
    {attention && <button className="shell-follow" aria-pressed={following} title="Follow the Agent's current view. Your input stops following." onClick={() => act({ kind: following ? 'unfollow' : 'follow' })}><Icon name="eye" size={14} />{following ? 'Following Agent' : 'Follow Agent'}</button>}
    {attention && <button className="shell-quiet" onClick={() => act({ kind: screen.attention === 'away' ? 'return' : 'leave' })}>{screen.attention === 'away' ? 'Return' : 'Step away'}</button>}
    <button className="shell-quiet shell-evidence-toggle" aria-expanded={evidence} title="Activity: the calls recorded for this workspace" onClick={onEvidence}><Icon name="list" size={15} /><span>Activity</span></button>
  </div>;
}

// What a declared item's state means to Rho, when the Agent gave it a role.
function roleOf(live: Live, id: string) {
  const item = live.map?.items.find(i => i.id === id);
  return item ? live.map!.vocabulary.states[item.state]?.role ?? '' : '';
}
const questionLong: Record<string, string> = { prepared: 'Prepared · not fetched by the Agent', fetched: 'Fetched by the Agent · no linked response yet', responded: 'Answered by the Agent' };
// The optional Agent panel: who is working and on what, the items it declared
// in its own words, the person's questions and how far each got, and the recorded calls on
// request. Every line is the Agent's statement or an owner record; nothing is estimated.
// The Agent learns of a question only when the person hands it over: Rho cannot push into the
// Agent's conversation. The request names the context, which is the Agent's to read, so it goes
// to the clipboard rather than onto the page. Same words as the table's own copy button.
function CopyRequest({ contextId, prepare }: { contextId?: string; prepare?: () => Promise<string> }) {
  const [copied, setCopied] = useState(false), [problem, setProblem] = useState('');
  async function copy() {
    setProblem('');
    try {
      const id = contextId ?? await prepare!();
      await navigator.clipboard.writeText(`Answer my question in Rho: read context ${id}. It holds the table version, the rows I asked about and my question. Reply to it with annotation.reply, and link any new result you make.`); setCopied(true);
    } catch { setProblem('Could not copy. Try again.'); }
  }
  return <><button className="agent-question-copy" onClick={copy}>{copied ? 'Copied' : 'Copy request for the Agent'}</button>{problem && <span role="alert">{problem}</span>}</>;
}

export function AgentColumn({ live, agents, contexts = [], prepare, principalId, evidence, onEvidence, focusObject, onClose }: { live: Live; agents?: WorkspaceSnapshot['agents']; contexts?: WorkspaceSnapshot['contexts']; prepare?: (annotationId: string) => Promise<string>; principalId?: string; evidence: boolean; onEvidence: () => void; focusObject: string | null; onClose?: () => void }) {
  // Opened calls come into view at the column's top; below 1280 the opened inspector takes focus.
  const record = useRef<HTMLElement>(null), column = useRef<HTMLElement>(null);
  useEffect(() => { if (evidence) record.current?.scrollIntoView({ block: 'start' }); }, [evidence]);
  useEffect(() => { if (onClose) column.current?.focus(); }, [!!onClose]);
  const screen = live.screen, state = live.state, name = namer(live);
  const running = Object.values(screen?.objects ?? {}).find(o => o.kind === 'run' && o.state === 'running');
  const [now, setNow] = useState(Date.now()), [earlier, setEarlier] = useState(false);
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [!!running]);
  if (!screen || !state) return null;
  // Who: the label given to the Agent's session when it was granted, and its last call as the
  // owner recorded it. The most recently active session speaks for the column.
  const latest = [...(agents ?? [])].sort((a, b) => (a.last?.at ?? '').localeCompare(b.last?.at ?? '')).at(-1);
  const who = latest?.label || Object.values(state.trace.principals).find(p => p.kind === 'agent' && p.name)?.name || 'The Agent';
  const lastAt = latest?.last?.at;
  const agentRun = running && live.runs?.find(r => r.operationId === name(running.id) && r.execution === 'active');
  const since = agentRun ? agentRun.startedAt ?? agentRun.acceptedAt : undefined;
  // Newest first: the table's question toggle names the latest one, and so does the top of this list.
  const questions = Object.values(screen.objects).filter((o): o is QuestionState => o.kind === 'question').reverse();
  // The item the person is looking at, or the one the Agent says it is working on, opens up.
  const current = screen.items.find(i => focusObject && (i.artifact?.object === focusObject)) ?? screen.items.find(i => roleOf(live, i.id) === 'working');
  // The files the current item's run declared, as Core recorded them; a check only where Rho verified the bytes.
  const producer = current?.artifact && Object.values(screen.objects).find((o): o is RunObject => o.kind === 'run' && o.run === current.artifact!.run);
  const outputs = producer ? live.runs?.find(r => r.operationId === name(producer.id)) : undefined;
  const referenceFor = (file: string) => outputs?.sourceKey ? Object.values(state.refs).find(ref => ref.artifact === outputs.sourceKey + '/' + file && ref.run === producer?.run) : undefined;
  // The newest question leads; earlier ones fold behind it.
  const shownQuestions = earlier ? questions : questions.slice(0, 1);
  // Nothing to report and not asked for: the conversation above stays the whole panel. Activity
  // in the workspace bar still opens the recorded calls here.
  if (!running && !screen.items.length && !outputs?.declared.length && !questions.length && !evidence) return null;
  return <aside ref={column} className={'agent-column' + (onClose ? ' drawer' : '')} aria-label={who} data-scroll-region="" tabIndex={0} onKeyDown={event => { if (onClose && event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <section className="agent-card">
      <header className="agent-card-head"><span className={'agent-dot' + (running ? ' running' : '')} aria-hidden="true" /><strong>{who}</strong>
        <span className="agent-card-meta">{running ? 'running' + (since ? ' ' + minutes(now - Date.parse(since)) : '') : lastAt ? 'last action ' + when(lastAt) : 'no recorded action'}</span>
        {onClose && <button className="icon-button agent-close" aria-label={'Close ' + who} onClick={onClose}><Icon name="close" size={14} stroke={2} /></button>}</header>
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
    {outputs && outputs.declared.length > 0 && <section className="agent-card agent-outputs" aria-label={'Outputs of ' + outputs.operationId}>
      <header className="agent-card-head"><strong>Outputs</strong><span className="agent-card-sub">{outputs.operationId}</span><span className="agent-card-count">{outputs.declared.length}</span></header>
      <ul>{outputs.declared.map(file => {
        const ref = referenceFor(file.path), object = ref ? 'artifact:' + ref.artifact : null;
        const here = !!ref && object === focusObject && screen.views.find(v => v.id === live.active)?.version === ref.version;
        return <li key={file.path} className={here ? 'current' : undefined}>
          <Icon name={fileIcon(file.path)} size={15} stroke={1.8} />
          {object && ref ? <button className="agent-output-name" aria-current={here || undefined} onClick={() => live.act({ kind: 'open', target: object, run: ref.run, version: ref.version })}>{file.path}</button> : <span className="agent-output-name">{file.path}</span>}
          {outputs.integrity === 'verified' && file.present ? <span className="agent-output-check" title="Bytes verified"><Icon name="check" size={14} stroke={2} /></span> : !file.present ? <span className="agent-output-state">not on disk</span> : null}
        </li>;
      })}</ul>
    </section>}
    {questions.length > 0 && <section className="agent-card" aria-label="Your questions">
      <header className="agent-card-head"><strong>Your questions</strong>{questions.length > 1 && <button className="shell-quiet agent-card-meta" aria-expanded={earlier} onClick={() => setEarlier(v => !v)}>{earlier ? 'Newest only' : `${questions.length - 1} earlier`}</button>}</header>
      <ul className="agent-questions">{shownQuestions.map(q => <li key={q.id} className={'agent-question ' + q.state}>
        <p data-user-text="">{q.name}</p>
        <button className="shell-link" onClick={() => live.act({ kind: 'open', target: q.target })}>{name(q.target)}</button>
        {(() => {
          // Contexts are listed per browser session, so a question sent from another session
          // shows no context here; it says so in the table's own words instead of "Prepared",
          // and copying prepares this session's context for the question first.
          const context = (contexts as Array<{ contextId?: string; responses?: Array<{ annotationId?: string }> }>).find(c => c.responses?.some(r => 'question:' + r.annotationId === q.id));
          const words = q.state === 'prepared' && !context ? 'Question retained · context not confirmed' : questionLong[q.state] ?? q.state;
          const ready = context?.contextId ?? (prepare ? undefined : null);
          return <><span className="agent-question-state">{words}</span>{q.state !== 'responded' && ready !== null && <CopyRequest contextId={ready} prepare={() => prepare!(q.id.slice('question:'.length))} />}</>;
        })()}
      </li>)}</ul>
    </section>}
    <section ref={record} className="agent-card agent-record">
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
    // A principal outside the retained trace still says what it is by its id's prefix.
    const kind = p?.kind ?? (actor.startsWith('agent:') ? 'agent' : actor.startsWith('browser:') ? 'browser' : undefined);
    return kind === 'agent' ? (p?.name ?? 'The Agent') : kind === 'browser' ? 'Another browser tab' : actor === 'operator' ? 'Rho' : p?.name ?? 'Unrecorded principal';
  };
  const today = new Date().toISOString(), ordered = state.evidence.map((f, i) => ({ f, i })).sort((a, b) => (b.f.at ?? '').localeCompare(a.f.at ?? '') || b.i - a.i);
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
    {state.gap && <p role="status">Earlier activity is outside the retained window. No missing calls were reconstructed.</p>}
    {/* Newest first by recorded time, 24-hour with seconds; a day that is not today heads its calls. */}
    <ol>{(() => { let shown = ''; return ordered.map(({ f, i }) => {
      const d = f.at && !sameDay(f.at, today) ? day(f.at) : '', head = d !== shown ? (shown = d) : '';
      return <Fragment key={i}>{head && <li className="shell-evidence-day">{head}</li>}<li>
        <time>{f.at ? new Date(f.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : 'Time not recorded'}</time>
        <strong>{who(f.actor)}</strong><span className="shell-evidence-what"><code>{f.op}</code> {f.object ? name(f.object) : 'Object not recorded'}{f.outcome === 'rejected' ? ` · refused (${f.reason?.kind ?? 'reason not recorded'})` : ''}</span>
      </li></Fragment>;
    }); })()}</ol>
    <p>The latest {state.evidence.length} facts are kept (limit {liveLimits.maxEvidence}). Calls an adapter refused on its own are not recorded here.</p>
  </section>;
}
