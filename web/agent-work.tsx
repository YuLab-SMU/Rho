import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { conversationBlocks, type Activity } from '../src/conversation-presentation.js';
import { agentName, commandFiles, projectPath } from './agent-now.js';
import { kindOf } from './sources.js';
import { AgentMarkdown } from './markdown.js';
import { Icon, type IconName } from './icons.js';

// What the Agent did in this project, one conversation at a time: what the person asked,
// the files it changed and looked at, the commands it ran and what it answered. These are
// the Agent's own reports from the conversation record; a file is shown as it is now.
type Read = RhoOutput<'conversation.read'>;
type Turn = Read['turns'][number];
type Summary = NonNullable<WorkspaceSnapshot['conversations']>[number];
// The page reads this many conversations, newest first, and this many messages of each.
export const workLimits = { conversations: 6, turns: 4 };

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function day(iso: string) {
  const at = new Date(iso), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  return at.toDateString() === today.toDateString() ? 'Today ' + clock(iso) : at.toDateString() === yesterday.toDateString() ? 'Yesterday ' + clock(iso) : at.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock(iso);
}
const took = (from?: string | null, to?: string | null) => {
  if (!from || !to) return '';
  const ms = Date.parse(to) - Date.parse(from);
  return !(ms >= 0) ? '' : ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s' : Math.round(ms / 60000) + ' min';
};
const ended: Record<string, string> = { completed: 'Answered', failed: 'Failed', stopped: 'Stopped', running: 'Answering now', unknown: 'Outcome unknown' };
export function pathIcon(path: string): IconName {
  const kind = kindOf(path);
  return kind === 'figures' ? 'image' : kind === 'code' ? 'code' : kind === 'notes' ? 'document' : kind === 'data' || kind === 'results' ? 'table' : 'file';
}

interface FileUse { path: string; wrote: number; edited: number; read: number }
interface Command { key: string; text: string; outcome: Activity['outcome'] }
// One message's work from its tool steps. Paths outside the project are counted, not named.
function work(turn: Turn, root: string, project: WorkspaceSnapshot['project'], exists: (path: string) => boolean) {
  const blocks = conversationBlocks(turn, null, root);
  const files = new Map<string, FileUse>(), commands: Command[] = [];
  let outside = 0;
  for (const block of blocks) if (block.kind === 'activity') for (const activity of block.activities) {
    if (activity.action === 'execute') { commands.push({ key: activity.key, text: activity.step.detail ?? activity.target ?? 'a command', outcome: activity.outcome }); continue; }
    if (activity.action !== 'read' && activity.action !== 'edit' && activity.action !== 'write') continue;
    if (activity.outcome === 'rejected') continue;
    const path = projectPath(activity.location ?? activity.step.detail ?? '', project);
    if (!path) { outside++; continue; }
    const use = files.get(path) ?? { path, wrote: 0, edited: 0, read: 0 };
    if (activity.action === 'write') use.wrote++; else if (activity.action === 'edit') use.edited++; else use.read++;
    files.set(path, use);
  }
  // A command names the script it ran; that file is part of the work even if no step read it.
  // Only names found in the project folders count: `Solar.R` in an R call is a column, not a file.
  for (const command of commands) for (const path of commandFiles(command.text, project)) if (!files.has(path) && exists(path)) files.set(path, { path, wrote: 0, edited: 0, read: 0 });
  const answer = [...blocks].reverse().find(block => block.kind === 'text');
  const all = [...files.values()];
  return {
    changed: all.filter(f => f.wrote || f.edited), looked: all.filter(f => !f.wrote && !f.edited && f.read), named: all.filter(f => !f.wrote && !f.edited && !f.read),
    commands, outside, answer: answer?.kind === 'text' ? answer.step.text ?? '' : '',
  };
}
function changeWords(use: FileUse) {
  return [use.wrote ? 'wrote' : '', use.edited ? 'edited' + (use.edited > 1 ? ' ' + use.edited + '×' : '') : ''].filter(Boolean).join(', ');
}

function FileChip({ path, note, onPath }: { path: string; note?: string; onPath: (path: string) => void }) {
  return <button className="work-file" title={path} onClick={() => onPath(path)}>
    <Icon name={pathIcon(path)} size={14} stroke={1.7} /><span>{path.split('/').at(-1)}</span>{note && <small>{note}</small>}
  </button>;
}
function Answer({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split('\n').length > 6;
  return <div className={'work-answer' + (long && !open ? ' clamped' : '')}>
    <AgentMarkdown text={text} streaming={streaming} />
    {long && <button className="text-button work-more" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? 'Show less' : 'Show the whole answer'}</button>}
  </div>;
}
function TurnWork({ turn, snapshot, exists, onPath }: { turn: Turn; snapshot: WorkspaceSnapshot; exists: (path: string) => boolean; onPath: (path: string) => void }) {
  const did = work(turn, snapshot.project.root, snapshot.project, exists);
  const refused = did.commands.filter(c => c.outcome === 'rejected').length;
  const failure = turn.state === 'failed' ? turn.result?.message ?? turn.problem ?? 'The Agent reported a failure.' : null;
  return <li className={'work-turn ' + turn.state}>
    <div className="work-ask"><p>{turn.text.trim()}</p><span>{day(turn.sentAt)}</span></div>
    <div className="work-did">
      {did.changed.length > 0 && <div className="work-line"><span className="work-label">Changed</span><div className="work-files">{did.changed.map(f => <FileChip key={f.path} path={f.path} note={changeWords(f)} onPath={onPath} />)}</div></div>}
      {did.looked.length > 0 && <div className="work-line"><span className="work-label">Looked at</span><div className="work-files">{did.looked.map(f => <FileChip key={f.path} path={f.path} onPath={onPath} />)}</div></div>}
      {did.commands.length > 0 && <details className="work-commands"><summary><span className="work-label">Ran</span>{did.commands.length} {did.commands.length === 1 ? 'command' : 'commands'}{refused ? ` · ${refused} refused` : ''}</summary>
        <ul>{did.commands.map(c => <li key={c.key}><code>{c.text}</code>{c.outcome !== 'returned' && <span className={'work-outcome ' + c.outcome}>{c.outcome === 'rejected' ? 'Refused' : c.outcome === 'requested' ? 'Running' : 'Outcome unknown'}</span>}</li>)}</ul>
        {did.named.length > 0 && <div className="work-files">{did.named.map(f => <FileChip key={f.path} path={f.path} onPath={onPath} />)}</div>}
      </details>}
      {did.outside > 0 && <p className="work-outside">{did.outside} {did.outside === 1 ? 'file' : 'files'} outside this project</p>}
    </div>
    {failure ? <p className="work-problem" role="note"><Icon name="info" size={15} />{failure}</p>
      : did.answer ? <Answer text={did.answer} streaming={turn.state === 'running'} /> : null}
    <p className="work-ending"><span className={'work-state ' + turn.state}>{ended[turn.state] ?? turn.state}</span>{turn.state !== 'running' && took(turn.startedAt ?? turn.sentAt, turn.endedAt) && <> · took {took(turn.startedAt ?? turn.sentAt, turn.endedAt)}</>}</p>
  </li>;
}

// A conversation is read again when its recorded version changes, at most every second
// while the Agent is answering.
function Conversation({ client, snapshot, summary, exists, onContinue, onPath }: { client: BrowserClient; snapshot: WorkspaceSnapshot; summary: Summary; exists: (path: string) => boolean; onContinue: (id: string) => void; onPath: (path: string) => void }) {
  const [read, setRead] = useState<Read | null>(null), [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => client.call('conversation.read', { projectId: snapshot.project.id, conversationId: summary.conversationId, limit: workLimits.turns })
      .then(value => { if (live) { setRead(value); setProblem(''); } }, error => { if (live) setProblem(error instanceof Error ? error.message : 'This conversation could not be read.'); }),
      read && summary.state === 'running' ? 1000 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [client, snapshot.project.id, summary.conversationId, summary.version]);
  const earlier = read?.first ?? 0;
  return <article className="work-card" aria-labelledby={'work-' + summary.conversationId}>
    <header className="work-head">
      <div><h2 id={'work-' + summary.conversationId}>{summary.title}</h2>
        <p>{[agentName(summary.client), summary.turns + ' ' + (summary.turns === 1 ? 'message' : 'messages'), day(summary.lastAt)].join(' · ')}</p></div>
      {summary.state === 'running' && <span className="nav-badge working"><span className="pulse-dot" aria-hidden="true" />Working</span>}
      <button onClick={() => onContinue(summary.conversationId)}>{summary.state === 'running' ? 'Follow' : 'Continue'}</button>
    </header>
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    {!read && !problem && <p className="muted" role="status">Reading…</p>}
    {read && <ol className="work-turns">
      {earlier > 0 && <li className="work-earlier"><button className="text-button" onClick={() => onContinue(summary.conversationId)}>{earlier} earlier {earlier === 1 ? 'message' : 'messages'} in the conversation</button></li>}
      {read.turns.map(turn => <TurnWork key={turn.id} turn={turn} snapshot={snapshot} exists={exists} onPath={onPath} />)}
    </ol>}
  </article>;
}

export function AgentWork({ client, snapshot, exists, onContinue, onPath, onNew }: { client: BrowserClient; snapshot: WorkspaceSnapshot; exists: (path: string) => boolean; onContinue: (id: string) => void; onPath: (path: string) => void; onNew: () => void }) {
  const [shown, setShown] = useState(workLimits.conversations);
  const list = [...(snapshot.conversations ?? [])].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.lastAt.localeCompare(a.lastAt));
  if (!list.length) return <div className="empty-state agent-empty"><span className="empty-symbol"><Icon name="spark" size={26} stroke={1.5} /></span><h2>No conversations yet</h2>
    <p>Ask the Agent to explore or change this project. What it reads, changes and runs is kept here.</p><button className="primary" onClick={onNew}><Icon name="prompt" size={16} />New conversation</button></div>;
  return <div className="work-list">
    {list.slice(0, shown).map(summary => <Conversation key={summary.conversationId} client={client} snapshot={snapshot} summary={summary} exists={exists} onContinue={onContinue} onPath={onPath} />)}
    {list.length > shown && <button className="work-older" onClick={() => setShown(n => n + workLimits.conversations)}>Show {Math.min(workLimits.conversations, list.length - shown)} older {list.length - shown === 1 ? 'conversation' : 'conversations'}</button>}
  </div>;
}
