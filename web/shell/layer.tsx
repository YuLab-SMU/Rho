import { useState } from 'react';
import type { DigestLine, ObjectState, RunObject, Screen } from '../../src/expression.js';
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

export function Bar({ live, focusObject, evidence, onEvidence, held, narrow }: { live: Live; focusObject: string | null; evidence: boolean; onEvidence: () => void; held: number; narrow: boolean }) {
  const { screen, act } = live;
  if (!screen) return <div className="shell-bar" data-rho-layer="persistent" role="status">Reading what the Agent did…</div>;
  const name = namer(live), agent = screen.agent, following = screen.attention === 'following';
  const chain = chainOf(screen, agent?.object ?? focusObject), shown = chain.slice(narrow ? -4 : -8), notes = screen.items.length;
  return <div className="shell-bar" data-rho-layer="persistent" data-attention={screen.attention}>
    <button className="shell-follow" aria-pressed={following} title={following ? 'The main area follows the Agent; any input of yours stops that' : 'Your views stay where you put them'} onClick={() => act({ kind: following ? 'unfollow' : 'follow' })}>
      <span className="shell-switch" aria-hidden="true" /><span className="shell-follow-word">{following ? 'Following' : screen.attention === 'away' ? 'Away' : 'Working'}</span>
    </button>
    {agent && <button className="shell-agent" data-rho-agent="" title={`The Agent's latest object: ${name(agent.object)}`} onClick={() => act({ kind: 'open', target: agent.object })}>
      <span className="shell-agent-who">Agent</span>{' '}<span className="shell-agent-object">{name(agent.object)}</span>{' '}<span className="shell-agent-state">{stateOf(screen.objects[agent.object])}{agent.placement === 'pending' ? ' · shows when you pause' : ''}</span>
    </button>}
    <span className="shell-break" aria-hidden="true" />
    {shown.length > 0 && <span className="shell-chain" role="group" aria-label="Runs of this script">
      {chain.length > shown.length && <span className="shell-chain-more">+{chain.length - shown.length}</span>}
      {shown.map(run => <button key={run.id} className={'shell-mark ' + run.state} aria-label={`${name(run.id)} ${run.state}`} title={`${name(run.id)} · ${runWords[run.state] ?? run.state}`} onClick={() => act({ kind: 'open', target: run.id })}>{run.run}</button>)}
    </span>}
    <span className="shell-spacer" />
    {held > 0 && <span className="shell-held" role="status">{held} waiting</span>}
    <button className="shell-quiet" onClick={() => act({ kind: screen.attention === 'away' ? 'return' : 'leave' })}>{screen.attention === 'away' ? 'Return' : 'Step away'}</button>
    <button className="shell-quiet shell-evidence-toggle" aria-expanded={evidence} onClick={onEvidence}>{notes > 0 && `${notes} Agent ${notes === 1 ? 'note' : 'notes'} · `}<span className="shell-wide-word">Recorded evidence</span><span className="shell-narrow-word" aria-hidden="true">Evidence</span></button>
  </div>;
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
export function Evidence({ live, principalId }: { live: Live; principalId?: string }) {
  const state = live.state, name = namer(live);
  if (!state) return null;
  const who = (actor: string) => {
    if (principalId && actor === principalId) return 'You';
    const p = state.trace.principals[actor];
    return p?.kind === 'agent' ? (p.name ?? 'The Agent') : p?.kind === 'browser' ? 'Another browser tab' : actor === 'operator' ? 'Rho' : p?.name ?? 'Unrecorded principal';
  };
  return <section className="shell-evidence" data-rho-layer="transient" data-rho-evidence="" data-scroll-region="" tabIndex={0} aria-label="Recorded activity">
    {live.screen && live.screen.items.length > 0 && <section aria-label="The Agent's notes" className="shell-notes">
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
