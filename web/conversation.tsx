import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { projectName } from './home.js';

// A conversation the person starts here. Rho holds its input, so this panel is where it
// continues: the person's messages, the Agent's replies and the steps it took, and how each
// message ended. A session started in another window keeps that window as its entry.
type Read = RhoOutput<'conversation.read'>;
type Turn = Read['turns'][number];
type Step = Turn['steps'][number];
type Pending = { kind: 'start' | 'send'; changeId: string; text: string; conversationId?: string };
const stored = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string | null) => { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); return true; } catch { return false; } };
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const seconds = (ms: number) => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s' : Math.round(ms / 60000) + ' min';
function toolWords(step: Step) {
  if (step.tool === 'mcp__rho__rho_call') return step.operation ? 'Called ' + step.operation : 'Called a project operation';
  if (step.tool === 'mcp__rho__rho_index') return 'Looked up project operations';
  if (step.tool === 'mcp__rho__rho_resolve') return 'Read operation contracts';
  if (step.tool === 'mcp__rho__rho_read') return 'Read a kept result';
  return 'Used ' + (step.tool ?? 'a tool');
}
const outcomeWords = { requested: '', returned: '', rejected: ' · refused', unknown: ' · outcome unknown' } as const;
function ending(turn: Turn) {
  if (turn.state === 'running') {
    if (turn.stop) return 'Stopping…';
    if (turn.permissions?.some(p => p.state === 'pending')) return 'Claude Code is waiting for your choice.';
    if (turn.retry) return `The model provider returned ${turn.retry.status ?? 'an error'}; Claude Code is retrying${turn.retry.attempt ? ` (attempt ${turn.retry.attempt}${turn.retry.of ? ' of ' + turn.retry.of : ''})` : ''}.`;
    return 'Claude Code is working…';
  }
  if (turn.state === 'completed') return 'Done' + (turn.result?.durationMs ? ' in ' + seconds(turn.result.durationMs) : '');
  if (turn.state === 'stopped') {
    const reason = turn.stop?.reason;
    return reason === 'person' ? 'Stopped. Steps already taken stay done.' : reason === 'closing' ? 'Stopped when Rho closed. Steps already taken stay done.'
      : reason === 'wall-limit' ? 'Stopped: this message ran longer than Rho allows for one message.' : reason === 'identity' ? turn.problem ?? 'Stopped.' : 'Stopped: Claude Code wrote more than Rho keeps for one message.';
  }
  if (turn.state === 'failed') {
    if (turn.result?.kind === 'error_max_turns') return 'Stopped at the step limit for one message. Ask it to continue.';
    return 'Not answered. ' + (turn.result?.message ?? turn.problem ?? '');
  }
  return turn.problem ?? 'Outcome unknown.';
}
// Consecutive tool steps fold into one line; the Agent's words stay in the open.
function groups(steps: Step[]) {
  const out: Array<{ kind: 'text' | 'error'; step: Step } | { kind: 'tools'; steps: Step[] }> = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.kind === 'tool') { if (last?.kind === 'tools') last.steps.push(step); else out.push({ kind: 'tools', steps: [step] }); }
    else out.push({ kind: step.kind, step });
  }
  return out;
}
function TurnView({ turn, running, choose, choosing }: { turn: Turn; running: boolean; choose(turnId: string, permissionId: string, optionId: string): void; choosing: string | null }) {
  const failure = turn.state === 'failed' ? turn.result?.message ?? turn.problem : null;
  const shown = groups(turn.steps.filter(step => !(step.kind === 'error' && step.text === failure)));
  return <li className={'turn ' + turn.state}>
    <div className="turn-person"><p data-user-text="">{turn.text}</p><span>{clock(turn.sentAt)}</span></div>
    {shown.map((group, i) => group.kind === 'tools'
      ? <details key={i} className="turn-tools">
          <summary>{running && i === shown.length - 1 ? toolWords(group.steps.at(-1)!) + (group.steps.at(-1)!.outcome === 'requested' ? '…' : '') : `Worked in the project · ${group.steps.length} ${group.steps.length === 1 ? 'step' : 'steps'}`}</summary>
          <ol>{group.steps.map((step, k) => <li key={k} className={step.outcome}>{toolWords(step)}{outcomeWords[step.outcome ?? 'requested']}</li>)}</ol>
        </details>
      : <p key={i} className={group.kind === 'error' ? 'turn-error' : 'turn-text'}>{group.step.text}{group.step.cut ? ' … (cut; the rest was not kept)' : ''}</p>)}
    {turn.omitted > 0 && <p className="turn-note">{turn.omitted} later {turn.omitted === 1 ? 'step was' : 'steps were'} not kept.</p>}
    {running && turn.permissions?.filter(p => p.state === 'pending').map(permission => <div key={permission.id} className="turn-permission" role="group" aria-label="Agent permission">
      <p>{permission.title}</p>
      {permission.details && <pre>{permission.details}</pre>}
      <div>{permission.options.map(option => <button key={option.id} disabled={choosing === permission.id} onClick={() => choose(turn.id, permission.id, option.id)}>{option.name}</button>)}</div>
    </div>)}
    <p className={'turn-ending ' + turn.state} role={turn.state === 'running' ? 'status' : undefined}>{ending(turn)}</p>
  </li>;
}

export function AgentConversation({ snapshot, client }: { snapshot: WorkspaceSnapshot; client: BrowserClient }) {
  const projectId = snapshot.project.id, openKey = 'rho.conversation.open.v1:' + projectId;
  const [openId, setOpenId] = useState<string | null>(() => stored(openKey));
  const draftKey = 'rho.conversation.draft.v1:' + projectId + ':' + (openId ?? 'new'), pendingKey = 'rho.conversation.pending.v1:' + projectId;
  const [draft, setDraft] = useState(() => stored(draftKey) ?? '');
  const [pending, setPending] = useState<Pending | null>(() => { try { return JSON.parse(stored(pendingKey) ?? 'null'); } catch { return null; } });
  const [read, setRead] = useState<Read | null>(null), [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [unconfirmed, setUnconfirmed] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const list = snapshot.conversations ?? [];
  const summary = list.find(c => c.conversationId === openId);
  const end = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(stored(draftKey) ?? ''); }, [draftKey]);
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
  useLayoutEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [read?.conversation.version, openId]);
  function open(id: string | null) { setOpenId(id); store(openKey, id); setProblem(''); }
  function edit(text: string) { setDraft(text); if (!store(draftKey, text)) setProblem('This draft could not be stored. Send or copy it before closing this panel.'); }
  const last = read?.turns.at(-1), answering = !!openId && (last?.state === 'running' || summary?.state === 'running');
  // The request identity is chosen once, kept until the service answers, and reused by Retry,
  // so a lost reply never turns one message into two.
  async function deliver(next: Pending) {
    setBusy(true); setProblem(''); setUnconfirmed(false);
    setPending(next); store(pendingKey, JSON.stringify(next));
    try {
      const reply = next.kind === 'start'
        ? await client.call('conversation.start', { projectId, changeId: next.changeId, text: next.text })
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
    void deliver(openId ? { kind: 'send', conversationId: openId, changeId: 'm-' + crypto.randomUUID(), text } : { kind: 'start', changeId: 'm-' + crypto.randomUUID(), text });
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
    </header> : <header className="conversation-head"><strong>Claude Code</strong></header>}
    {openId ? <ol className="conversation-turns" aria-label="Messages">
      {(read?.first ?? 0) > 0 && <li className="turn-note">{read!.first} earlier {read!.first === 1 ? 'message is' : 'messages are'} kept but not shown.</li>}
      {read?.turns.map((turn, i) => <TurnView key={turn.id} turn={turn} running={turn.state === 'running' && i === read.turns.length - 1} choosing={choosing} choose={(turnId, permissionId, optionId) => {
        setChoosing(permissionId); setProblem('');
        void client.call('conversation.permission', { projectId, conversationId: openId!, turnId, permissionId, optionId }).then(reply => {
          setRead(current => current ? { ...current, conversation: reply.conversation, turns: current.turns.map(t => t.id === reply.turn.id ? reply.turn : t) } : current);
        }, error => setProblem(error instanceof Error ? error.message : 'The choice could not be confirmed.')).finally(() => setChoosing(null));
      }} />)}
    </ol> : <div className="conversation-intro">
      <p>Ask Claude Code to explore or change {projectName(snapshot.project)}. It runs on this machine with access to this project, and its replies appear here.</p>
      {list.length > 0 && <ul className="conversation-list" aria-label="Conversations">{list.map(c => <li key={c.conversationId}>
        <button onClick={() => open(c.conversationId)}><strong>{c.title}</strong><span>{c.state === 'running' ? 'Answering now' : c.state === 'unknown' ? 'Last message: outcome unknown' : clock(c.lastAt)} · {c.turns} {c.turns === 1 ? 'message' : 'messages'}</span></button>
      </li>)}</ul>}
    </div>}
    <div className="conversation-composer">
      {waiting && unconfirmed && <p role="alert">Your message was not confirmed. Retry sends the same message once.<button className="small-button" disabled={busy} onClick={() => void deliver(waiting)}>Retry</button></p>}
      {problem && <p role="alert">{problem}</p>}
      <label htmlFor="conversation-input" className="visually-hidden">{openId ? 'Message Claude Code' : 'Start a conversation'}</label>
      <textarea id="conversation-input" ref={input} rows={3} value={waiting ? waiting.text : draft} readOnly={!!waiting} placeholder={openId ? 'Reply to Claude Code…' : 'What should Claude Code look at or change?'} onChange={e => edit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !answering && !busy && !waiting) { e.preventDefault(); send(); } }} />
      <div className="conversation-actions">
        <span>{answering ? 'Claude Code is answering. You can write your next message.' : openId ? 'Resumes this conversation.' : 'Starts a new conversation.'}</span>
        {answering ? <button onClick={() => void stop()} disabled={!!last?.stop}>{last?.stop ? 'Stopping…' : 'Stop'}</button>
          : <button className="primary" disabled={busy || !!waiting || !draft.trim()} onClick={send}>{busy ? 'Sending…' : openId ? 'Send' : 'Start'}</button>}
      </div>
    </div>
    {/* After the composer, so the newest lines end above it rather than behind it. */}
    <div ref={end} />
  </section>;
}
