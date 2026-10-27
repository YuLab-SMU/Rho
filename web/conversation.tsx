import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { conversationBlocks, currentPlanEntry, type Activity } from '../src/conversation-presentation.js';
import { projectName } from './home.js';
import { AgentMarkdown } from './markdown.js';
import { SessionProgress } from '@rho-workspace/plugin-agent/ui';

// A conversation the person starts here. Rho holds its input, so this panel is where it
// continues: the person's messages, the Agent's words as they arrive, the actions it takes
// and how each message ended. A session started in another window keeps that window as its entry.
type Read = RhoOutput<'conversation.read'>;
type Turn = Read['turns'][number];
type Observation = Read['observation'];
type Pending = { kind: 'start' | 'send'; changeId: string; text: string; conversationId?: string; backend?: 'claude-acp' | 'codex-acp' };
const stored = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string | null) => { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); return true; } catch { return false; } };
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const seconds = (ms: number) => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s' : Math.round(ms / 60000) + ' min';
const liveTime = (s: number) => s < 60 ? s + ' s' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const clientName = (client?: string | null) => client === 'codex' ? 'Codex' : client === 'claude-code' ? 'Claude Code' : '';
function ending(turn: Turn) {
  if (turn.state === 'running') {
    if (turn.stop) return 'Stopping…';
    if (turn.permissions?.some(p => p.state === 'pending')) return 'The Agent is waiting for your choice.';
    if (turn.retry) return `The model provider returned ${turn.retry.status ?? 'an error'}; the Agent is retrying${turn.retry.attempt ? ` (attempt ${turn.retry.attempt}${turn.retry.of ? ' of ' + turn.retry.of : ''})` : ''}.`;
    return 'Agent is working…';
  }
  if (turn.state === 'completed') return 'Done' + (turn.result?.durationMs ? ' in ' + seconds(turn.result.durationMs) : '');
  if (turn.state === 'stopped') {
    if (turn.result?.reason === 'cancelled') return 'Turn cancelled. Steps already taken stay done; unfinished tools may still be running.';
    const reason = turn.stop?.reason;
    return reason === 'person' ? 'Stopped. Steps already taken stay done.' : reason === 'closing' ? 'Stopped when Rho closed. Steps already taken stay done.'
      : reason === 'wall-limit' ? 'Stopped: this message ran longer than Rho allows for one message.' : reason === 'identity' ? turn.problem ?? 'Stopped.' : 'Stopped: the Agent wrote more than Rho keeps for one message.';
  }
  if (turn.state === 'failed') {
    if (turn.result?.kind === 'error_max_turns') return 'Stopped at the step limit for one message. Ask it to continue.';
    return 'Not answered. ' + (turn.result?.message ?? turn.problem ?? '');
  }
  return turn.problem ?? 'Outcome unknown.';
}
function useElapsed(active: boolean, since: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active, since]);
  if (!active) return null;
  const started = Date.parse(since ?? '');
  return Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : null;
}
// The panel follows new activity only while the person is at its end. Scrolling up to read
// keeps that position; new lines wait behind an explicit way back to the latest.
function scrollParent(node: HTMLElement | null) {
  for (let next = node?.parentElement; next; next = next.parentElement) {
    const style = getComputedStyle(next);
    if (/(auto|scroll)/.test(style.overflowY)) return next;
  }
  return document.scrollingElement as HTMLElement | null;
}

function ActivityRow({ activity }: { activity: Activity }) {
  const outcome = activity.outcome;
  const summary = <>
    <span className={'activity-dot ' + outcome} aria-hidden="true" />
    <span className="activity-verb">{activity.verb}</span>
    {activity.target && <span className={'activity-target ' + (activity.targetKind ?? 'text')} title={activity.target}>{activity.target}</span>}
    {outcome === 'rejected' && <span className="activity-flag">refused</span>}
    {outcome === 'unknown' && <span className="activity-flag unknown">unknown</span>}
  </>;
  const details = activity.title || activity.location || activity.step.operation || activity.step.tool || activity.step.detail;
  if (!details) return <li className="activity-row" data-action={activity.action} data-outcome={outcome}><p>{summary}</p></li>;
  return <li className="activity-row" data-action={activity.action} data-outcome={outcome}>
    <details>
      <summary>{summary}</summary>
      <dl className="activity-details">
        {activity.step.tool && <><dt>Tool</dt><dd>{activity.step.tool}</dd></>}
        {activity.step.toolKind && <><dt>Category</dt><dd>{activity.step.toolKind}</dd></>}
        {activity.title && <><dt>Agent said</dt><dd>{activity.title}</dd></>}
        {activity.step.detail && <><dt>Input</dt><dd><code>{activity.step.detail}</code></dd></>}
        {activity.step.operation && <><dt>Operation</dt><dd><code>{activity.step.operation}</code></dd></>}
        {activity.location && <><dt>Reported path</dt><dd><code>{activity.location}</code></dd></>}
        <dt>Tool status</dt><dd>{{ requested: 'still running', returned: 'completed', rejected: 'refused', unknown: 'unknown' }[outcome]}</dd>
      </dl>
    </details>
  </li>;
}
function ActivityRun({ activities, running, summary }: { activities: Activity[]; running: boolean; summary: string }) {
  const list = <ul className="activity-list">{activities.map(activity => <ActivityRow key={activity.key} activity={activity} />)}</ul>;
  if (running) return <div className="activity-live">{list}</div>;
  // Short runs stay readable as individual actions; a long run folds into what it
  // accomplished, with every row one click away.
  if (activities.length <= 3) return list;
  return <details className="activity-group"><summary>{summary}</summary>{list}</details>;
}

function TurnView({ turn, running, observation, projectRoot, choose, choosing, askAgain }: {
  turn: Turn; running: boolean; observation?: Observation; projectRoot?: string;
  choose(turnId: string, permissionId: string, optionId: string): void; choosing: string | null; askAgain(text: string): void;
}) {
  const blocks = conversationBlocks(turn, observation, projectRoot);
  const elapsed = useElapsed(running, turn.startedAt ?? turn.sentAt);
  return <li className={'turn ' + turn.state}>
    <div className="turn-person"><p data-user-text="">{turn.text}</p><span>{clock(turn.sentAt)}</span></div>
    {blocks.map(block => block.kind === 'text'
      ? <div key={block.key} className="turn-text-block">
        <AgentMarkdown text={block.step.text ?? ''} streaming={block.streaming} />
        {block.step.cut && <p className="turn-note">… the rest of this message was not kept.</p>}
      </div>
      : block.kind === 'error' ? <p key={block.key} className="turn-error">{block.step.text}</p>
        : block.activities.length === 1
          ? <ul key={block.key} className="activity-list single"><ActivityRow activity={block.activities[0]} /></ul>
          : <ActivityRun key={block.key} activities={block.activities} running={block.running} summary={block.summary} />)}
    {turn.omitted > 0 && <p className="turn-note">{turn.omitted} later {turn.omitted === 1 ? 'step was' : 'steps were'} not kept.</p>}
    {running && turn.permissions?.filter(p => p.state === 'pending').map(permission => <div key={permission.id} className="turn-permission" role="group" aria-label="Agent permission">
      <p className="permission-caption"><span aria-hidden="true" />Needs your choice</p>
      <p className="permission-title">{permission.title}</p>
      {permission.details && <pre>{permission.details}</pre>}
      <div>{permission.options.map(option => <button key={option.id} className="small-button" disabled={choosing === permission.id} onClick={() => choose(turn.id, permission.id, option.id)}>{option.name}</button>)}</div>
    </div>)}
    {turn.permissions?.filter(p => p.state !== 'pending').map(permission => <p key={permission.id} className="turn-choice">
      {permission.state === 'cancelled' ? 'The Agent request was cancelled.' : <>You chose “{permission.options.find(option => option.id === permission.selected)?.name ?? 'an option'}”<span className="turn-choice-what"> · {permission.title}</span></>}
    </p>)}
    <div className="turn-ending-line">
      <p className={'turn-ending ' + turn.state} role={turn.state === 'running' ? 'status' : undefined}>{ending(turn)}{running && elapsed !== null && <span className="turn-elapsed" aria-hidden="true"> · {liveTime(elapsed)}</span>}</p>
      {turn.state === 'failed' && !running && <button className="text-button" onClick={() => askAgain(turn.text)}>Ask again</button>}
    </div>
  </li>;
}

export function AgentConversation({ snapshot, client, selectedId, onSelected, onSent }: { snapshot: WorkspaceSnapshot; client: BrowserClient; selectedId?: string | null; onSelected?: () => void; onSent?: () => void }) {
  const projectId = snapshot.project.id, openKey = 'rho.conversation.open.v1:' + projectId;
  const [openId, setOpenId] = useState<string | null>(() => stored(openKey));
  const draftKey = 'rho.conversation.draft.v1:' + projectId + ':' + (openId ?? 'new'), pendingKey = 'rho.conversation.pending.v1:' + projectId;
  const [draft, setDraft] = useState(() => stored(draftKey) ?? '');
  const [pending, setPending] = useState<Pending | null>(() => { try { return JSON.parse(stored(pendingKey) ?? 'null'); } catch { return null; } });
  const [read, setRead] = useState<Read | null>(null), [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [unconfirmed, setUnconfirmed] = useState(false);
  const [backend, setBackend] = useState<'' | 'claude-acp' | 'codex-acp'>('');
  const [choosing, setChoosing] = useState<string | null>(null);
  const [following, setFollowing] = useState(true), [unseen, setUnseen] = useState(false);
  const list = snapshot.conversations ?? [];
  const summary = list.find(c => c.conversationId === openId);
  const agentName = (summary?.client ?? read?.conversation.client) === 'codex' || (!openId && backend === 'codex-acp') ? 'Codex' : (summary?.client ?? read?.conversation.client) === 'claude-code' || (!openId && backend === 'claude-acp') ? 'Claude Code' : 'Agent';
  const end = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(stored(draftKey) ?? ''); }, [draftKey]);
  useEffect(() => { if (selectedId) { open(selectedId); onSelected?.(); } }, [selectedId]);
  // The open conversation is read again whenever its recorded version changes.
  useEffect(() => {
    if (!openId) { setRead(null); return; }
    let current = true;
    client.call('conversation.read', { projectId, conversationId: openId, limit: 50 }).then(value => { if (current) { setRead(value); setProblem(''); } }, error => {
      if (!current) return;
      if (error instanceof BrowserApiError && error.error.kind === 'not_found') { open(null); return; }
      setProblem('This conversation could not be read. It is kept; refresh to try again.');
    });
    return () => { current = false; };
  }, [openId, summary?.version]);
  // Follow only while the person is at the end of the panel. A scroll away keeps what they
  // are reading in place; unseen activity waits behind the composer's way back.
  useEffect(() => {
    const parent = scrollParent(end.current);
    if (!parent) return;
    const onScroll = () => {
      const near = parent.scrollHeight - parent.scrollTop - parent.clientHeight <= 64;
      setFollowing(near);
      if (near) setUnseen(false);
    };
    parent.addEventListener('scroll', onScroll, { passive: true });
    return () => parent.removeEventListener('scroll', onScroll);
  }, [openId]);
  const seen = useRef('');
  useLayoutEffect(() => {
    const version = String(read?.conversation.version ?? '');
    const parent = scrollParent(end.current);
    if (following) {
      if (parent) parent.scrollTop = parent.scrollHeight; else end.current?.scrollIntoView({ block: 'end' });
      seen.current = version; setUnseen(false);
    } else if (seen.current !== version) setUnseen(true);
  }, [read?.conversation.version, openId, following]);
  function open(id: string | null) { setOpenId(id); store(openKey, id); setProblem(''); setFollowing(true); setUnseen(false); }
  function edit(text: string) { setDraft(text); if (!store(draftKey, text)) setProblem('This draft could not be stored. Send or copy it before closing this panel.'); }
  function askAgain(text: string) { setFollowing(true); edit(text); input.current?.focus(); }
  const last = read?.turns.at(-1), answering = !!openId && (last?.state === 'running' || summary?.state === 'running');
  const plan = currentPlanEntry(read?.observation ?? null), planEntries = read?.observation?.plan?.entries ?? [];
  // The request identity is chosen once, kept until the service answers, and reused by Retry,
  // so a lost reply never turns one message into two.
  async function deliver(next: Pending) {
    setBusy(true); setProblem(''); setUnconfirmed(false);
    setPending(next); store(pendingKey, JSON.stringify(next));
    try {
      const reply = next.kind === 'start'
        ? await client.call('conversation.start', { projectId, changeId: next.changeId, text: next.text, ...(next.backend ? { backend: next.backend } : {}) })
        : await client.call('conversation.send', { projectId, conversationId: next.conversationId!, changeId: next.changeId, text: next.text });
      setPending(null); store(pendingKey, null);
      store(draftKey, null); setDraft('');
      if (next.kind === 'start') open(reply.conversation.conversationId);
      else setRead(current => current && current.conversation.conversationId === reply.conversation.conversationId ? { ...current, conversation: reply.conversation, turns: [...current.turns.filter(t => t.id !== reply.turn.id), reply.turn] } : current);
    } catch (error) {
      if (error instanceof BrowserApiError) {
        // Refused: nothing was started. The words go back into the box.
        setPending(null); store(pendingKey, null); setDraft(next.text); store(draftKey, next.text); setProblem(error.message);
      } else setUnconfirmed(true);
    } finally { setBusy(false); }
  }
  function send() {
    const text = draft.trim() ? draft : '';
    if (!text) return;
    setFollowing(true); setUnseen(false); onSent?.();
    void deliver(openId ? { kind: 'send', conversationId: openId, changeId: 'm-' + crypto.randomUUID(), text } : { kind: 'start', changeId: 'm-' + crypto.randomUUID(), text, ...(backend ? { backend } : {}) });
  }
  async function stop() {
    if (!openId || !last) return;
    try { const reply = await client.call('conversation.stop', { projectId, conversationId: openId, turnId: last.id }); setRead(current => current ? { ...current, turns: current.turns.map(t => t.id === reply.turn.id ? reply.turn : t) } : current); }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The stop request could not be confirmed. Refresh to see whether it stopped.'); }
  }
  const waiting = pending && (pending.kind === 'start' ? !openId : pending.conversationId === openId) ? pending : null;
  return <section className="conversation" aria-label={openId ? 'Conversation' : 'New conversation'}>
    {openId ? <header className="conversation-head">
      <button className="text-button" onClick={() => open(null)}>All conversations</button>
      <strong title={summary?.title ?? read?.conversation.title}>{summary?.title ?? read?.conversation.title ?? 'Conversation'}</strong>
      {clientName(summary?.client ?? read?.conversation.client) && <span className="conversation-client">{clientName(summary?.client ?? read?.conversation.client)}</span>}
    </header> : <header className="conversation-head"><label>Agent <select aria-label="Conversation Agent" value={backend} disabled={busy || !!pending} onChange={e => setBackend(e.target.value as typeof backend)}><option value="">Configured default</option><option value="claude-acp">Claude Code</option><option value="codex-acp">Codex</option></select></label></header>}
    {openId ? <ol className="conversation-turns" aria-label="Messages">
      {(read?.first ?? 0) > 0 && <li className="turn-note">{read!.first} earlier {read!.first === 1 ? 'message is' : 'messages are'} kept but not shown.</li>}
      {read?.turns.map((turn, i) => <TurnView key={turn.id} turn={turn} running={turn.state === 'running' && i === read.turns.length - 1} observation={read.observation} projectRoot={snapshot.project.root} choosing={choosing} askAgain={askAgain} choose={(turnId, permissionId, optionId) => {
        setChoosing(permissionId); setProblem('');
        void client.call('conversation.permission', { projectId, conversationId: openId!, turnId, permissionId, optionId }).then(reply => {
          setRead(current => current ? { ...current, conversation: reply.conversation, turns: current.turns.map(t => t.id === reply.turn.id ? reply.turn : t) } : current);
        }, error => setProblem(error instanceof Error ? error.message : 'The choice could not be confirmed.')).finally(() => setChoosing(null));
      }} />)}
    </ol> : <div className="conversation-intro">
      <p>Ask {agentName} to explore or change {projectName(snapshot.project)}. It runs on this machine with access to this project, and its replies appear here.</p>
      {list.length > 0 && <ul className="conversation-list" aria-label="Conversations">{list.map(c => <li key={c.conversationId}>
        <button onClick={() => open(c.conversationId)}><strong>{c.title}</strong><span>{c.state === 'running' ? 'Answering now' : c.state === 'unknown' ? 'Last message: outcome unknown' : clock(c.lastAt)} · {[clientName(c.client), c.turns + ' ' + (c.turns === 1 ? 'message' : 'messages')].filter(Boolean).join(' · ')}</span></button>
      </li>)}</ul>}
    </div>}
    {read?.observation && <details className="conversation-plan">
      <summary title={plan?.content}>{plan ? <><span className={'plan-state ' + plan.status} aria-hidden="true" />Plan · {plan.content}</>
        : planEntries.length ? <><span className="plan-state completed" aria-hidden="true" />Plan · complete</> : 'Session plan & usage'}</summary>
      <SessionProgress observation={read.observation} />
    </details>}
    <div className="conversation-composer">
      {waiting && unconfirmed && <p role="alert">Your message was not confirmed. Retry sends the same message once.<button className="small-button" disabled={busy} onClick={() => void deliver(waiting)}>Retry</button></p>}
      {problem && <p role="alert">{problem}</p>}
      <label htmlFor="conversation-input" className="visually-hidden">{openId ? 'Message ' + agentName : 'Start a conversation'}</label>
      <textarea id="conversation-input" ref={input} rows={3} value={waiting ? waiting.text : draft} readOnly={!!waiting} placeholder={openId ? 'Reply to ' + agentName + '…' : 'What should the Agent look at or change?'} onChange={e => edit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !answering && !busy && !waiting) { e.preventDefault(); send(); } }} />
      <div className="conversation-actions">
        <span>{answering ? agentName + ' is answering. You can write your next message.' : openId ? 'Resumes this conversation.' : 'Starts a new conversation.'}{!following && unseen && <span className="following-note"> New activity below.</span>}</span>
        {!following && <button className="small-button jump-latest" onClick={() => setFollowing(true)}>{unseen ? 'New activity · ' : ''}Jump to latest</button>}
        {answering ? <button onClick={() => void stop()} disabled={!!last?.stop}>{last?.stop ? 'Stopping…' : 'Stop'}</button>
          : <button className="primary" disabled={busy || !!waiting || !draft.trim()} onClick={send}>{busy ? 'Sending…' : openId ? 'Send' : 'Start'}</button>}
      </div>
    </div>
    {/* After the composer, so the newest lines end above it rather than behind it. */}
    <div ref={end} />
  </section>;
}
