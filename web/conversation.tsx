import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BrowserApiError, type BrowserClient, type WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import type { UiLocation } from '../src/ui-context.js';
import { agentTurnLimit, activitySummary, conversationBlocks, currentPlanEntry, durationText, stepDuration, type Activity, type AgentAction, type Block } from '../src/conversation-presentation.js';
import { projectName } from './home.js';
import { AgentMarkdown, CopyButton } from './markdown.js';
import { agentLabel, backendOf, otherAcp, modelSetting, split, useAgentSettings, valueName, type Backend, type SettingValue } from './agent-settings.js';
import { day } from './agent-work.js';
import { ComposerSettings, OpenSettings } from './settings-menu.js';
import { ProviderMark } from './brand-marks.js';
import { money, tokens } from './agent-manage.js';
import { Icon, type IconName } from './icons.js';
import { spendAmount, spendBasis, spendOf } from './holds.js';
import type { Spend } from '../src/file-describer.js';
import { stepFocus, useOutside } from './popover.js';
import { turnAt } from '../src/replay.js';
import { clock as clockAt } from './timeline-kinds.js';
import { sessionAgent, sessionWhere, type ExternalSummary, type SessionTurn } from './external-conversations.js';

// A conversation with an Agent in this project: the person's messages, the Agent's words as they
// arrive, the actions it takes and how each message ended. A session started in a terminal, an
// editor or the Agent's own app opens here too, with its history from the Agent's own record, and
// the next message continues that same session (or a copy, while another window holds it open).
type Read = RhoOutput<'conversation.read'>;
type Turn = Read['turns'][number];
type Observation = Read['observation'];
type Pending = { kind: 'start' | 'send'; changeId: string; text: string; uiContext?: UiLocation; conversationId?: string; continuationOf?: string; backend?: Backend; continue?: { session: string; copy: boolean } };
const stored = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string | null) => { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); return true; } catch { return false; } };
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const seconds = (ms: number) => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s' : Math.round(ms / 60000) + ' min';
const liveTime = (s: number) => s < 60 ? s + ' s' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const clientName = (client?: string | null) => client === 'codex' ? 'Codex' : client === 'claude-code' ? 'Claude Code' : '';
const actionIcon: Record<AgentAction, IconName> = { read: 'file', edit: 'pencil', write: 'pencil', delete: 'trash', move: 'move', search: 'search', execute: 'prompt', fetch: 'globe', project: 'spark', agents: 'spark', plan: 'list', other: 'tool' };
// A failure the Agent already put in its own words above is not said a second time. Rho masks
// private values in its copy, so those parts match anything.
function repeats(message: string, turn: Turn) {
  const said = turn.steps.filter(step => step.kind === 'text').at(-1)?.text?.trim();
  const core = message.replace(/^Internal error:\s*/i, '').trim();
  if (!said || core.length < 24) return false;
  const pattern = core.split(/\[private(?: URL)?\]/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\s]*');
  return new RegExp(pattern).test(said);
}
function ending(turn: Turn) {
  if (turn.state === 'running') {
    if (turn.stop) return 'Stopping…';
    if (turn.permissions?.some(p => p.state === 'pending')) return 'The Agent is waiting for your choice.';
    if (turn.retry) return `The model provider returned ${turn.retry.status ?? 'an error'}; the Agent is retrying${turn.retry.attempt ? ` (attempt ${turn.retry.attempt}${turn.retry.of ? ' of ' + turn.retry.of : ''})` : ''}.`;
    return 'Agent is working…';
  }
  if (turn.state === 'completed') return 'Agent finished this reply' + (turn.result?.durationMs ? ' in ' + seconds(turn.result.durationMs) : '') + '.';
  if (turn.state === 'stopped') {
    const reason = turn.stop?.reason;
    return reason === 'person' ? 'Stopped. Steps already taken stay done.' : reason === 'closing' ? 'Stopped when Rho closed. Steps already taken stay done.'
      : reason === 'wall-limit' ? 'Stopped: this message ran longer than Rho allows for one message.' : reason === 'identity' ? turn.problem ?? 'Stopped.'
      : reason === 'output-limit' || reason === 'line-limit' ? 'Stopped: the Agent wrote more than Rho keeps for one message.' : 'Turn cancelled. Steps already taken stay done; unfinished tools may still be running.';
  }
  if (turn.state === 'failed') {
    if (agentTurnLimit(turn)) return 'The Agent reached its turn limit. The analysis may be unfinished.';
    const message = turn.result?.message ?? turn.problem ?? '';
    return repeats(message, turn) ? 'Not answered.' : 'Not answered. ' + message;
  }
  return turn.problem ?? 'Outcome unknown.';
}
// During a replay the clock stands at the replayed moment.
function useElapsed(active: boolean, since: string | null | undefined, at?: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active || at != null) return;
    const timer = setInterval(() => tick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active, since, at]);
  if (!active) return null;
  const started = Date.parse(since ?? '');
  return Number.isFinite(started) ? Math.max(0, Math.floor(((at ?? Date.now()) - started) / 1000)) : null;
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
// What a command printed opens at its end, where a terminal leaves it: the last line is the result or the error.
const atEnd = (element: HTMLElement | null) => { if (element) element.scrollTop = element.scrollHeight; };
function ActivityRow({ activity }: { activity: Activity }) {
  const outcome = activity.outcome, step = activity.step, duration = stepDuration(step), printed = step.output;
  // A command that ran and exited with a failing code failed; it was not refused.
  const failed = outcome === 'failed' ? (step.exitCode ? 'exit ' + step.exitCode : 'failed') : outcome === 'rejected' ? 'refused' : null;
  const summary = <>
    <span className={'activity-icon ' + outcome} aria-hidden="true"><Icon name={actionIcon[activity.action]} size={13} /></span>
    <span className="activity-verb">{activity.verb}</span>
    {activity.target && <span className={'activity-target ' + (activity.targetKind ?? 'text')} title={activity.target}>{activity.target}</span>}
    {failed && <span className="activity-flag">{failed}</span>}
    {outcome === 'unknown' && <span className="activity-flag unknown">unknown</span>}
    {activity.action === 'execute' && duration !== null && <span className="activity-duration">{durationText(duration)}</span>}
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
        {step.exitCode !== undefined && <><dt>Exit code</dt><dd>{step.exitCode}</dd></>}
        {duration !== null && <><dt>Took</dt><dd title="From the Agent's call to its result, including any permission check">{durationText(duration)}</dd></>}
        {printed && <><dt className="activity-printed">Printed</dt><dd className="activity-printed">{printed.text ? <pre className="activity-output" ref={atEnd}>{printed.text}</pre> : 'Nothing'}
          {printed.cut && <span className="activity-cut">The last {printed.text.split('\n').length} of {printed.lines} lines.</span>}</dd></>}
        <dt>Tool status</dt><dd>{{ requested: 'still running', returned: 'completed', failed: 'failed', rejected: 'refused', unknown: 'unknown' }[outcome]}</dd>
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
function BlockView({ block }: { block: Block }) {
  if (block.kind === 'text') return <div className="turn-text-block">
    <AgentMarkdown text={block.step.text ?? ''} streaming={block.streaming} />
    {block.step.cut && <p className="turn-note">… the rest of this message was not kept.</p>}
  </div>;
  if (block.kind === 'error') return <p className="turn-error">{block.step.text}</p>;
  return block.activities.length === 1
    ? <ul className="activity-list single"><ActivityRow activity={block.activities[0]} /></ul>
    : <ActivityRun activities={block.activities} running={block.running} summary={block.summary} />;
}

function TurnView({ turn, running, observation, projectRoot, choose, choosing, askAgain, continueWork, at }: {
  turn: Turn; running: boolean; observation?: Observation; projectRoot?: string; at?: number | null;
  choose(turnId: string, permissionId: string, optionId: string): void; choosing: string | null; askAgain(text: string): void; continueWork?: () => void;
}) {
  const blocks = conversationBlocks(turn, observation, projectRoot);
  const elapsed = useElapsed(running, turn.startedAt ?? turn.sentAt, at);
  // The Agent's last words stay in the open. What it did before them, with the words it said
  // along the way and the choices made for it, folds into one line once the message ends;
  // while it works, that part stays open so the person can follow it.
  let cut = blocks.length;
  while (cut > 0 && blocks[cut - 1].kind === 'text') cut--;
  const work = blocks.slice(0, cut), answer = blocks.slice(cut);
  const choices = turn.permissions?.filter(p => p.state !== 'pending') ?? [];
  const activities = work.flatMap(block => block.kind === 'activity' ? block.activities : []);
  const errors = work.filter(block => block.kind === 'error').length;
  const [shown, setShown] = useState<boolean | null>(null);
  const open = shown ?? running;
  const said = [activitySummary(activities), choices.length ? choices.length + (choices.length === 1 ? ' choice' : ' choices') : '', errors ? errors + (errors === 1 ? ' error' : ' errors') : ''].filter(Boolean).join(' · ');
  const answerText = answer.map(block => block.kind === 'text' ? block.step.text ?? '' : '').join('\n\n').trim();
  const model = turn.model ? valueName(modelSetting(observation?.config?.options), turn.model) : '';
  return <li className={'turn ' + turn.state}>
    <div className="turn-person"><p data-user-text="">{turn.text}</p>{turn.uiContext?.workspace && <small className="turn-place">Studio · {turn.uiContext.workspace.title}</small>}{figureNote(turn.uiContext?.figureSelection)}</div>
    {(work.length > 0 || choices.length > 0) && <details className="turn-work" open={open} onToggle={event => { const next = event.currentTarget.open; if (next !== open) setShown(next); }}>
      <summary><span className="turn-work-label">{running ? 'Working' : 'Worked'}</span>{said && <span className="turn-work-said">{said}</span>}</summary>
      <div className="turn-work-body">
        {work.map(block => <BlockView key={block.key} block={block} />)}
        {choices.length > 0 && <ul className="turn-choices">{choices.map(permission => <li key={permission.id} className="turn-choice" title={permission.title}>
          <Icon name={permission.state === 'cancelled' ? 'close' : 'check'} size={12} />
          {permission.state === 'cancelled' ? <span>The Agent request was cancelled.</span> : <><span className="turn-choice-option">You chose “{permission.options.find(option => option.id === permission.selected)?.name ?? 'an option'}”</span><span className="turn-choice-what">{permission.title}</span></>}
        </li>)}</ul>}
      </div>
    </details>}
    {answer.map(block => <BlockView key={block.key} block={block} />)}
    {turn.continued && <p className="turn-note">The Agent session this conversation had been using had ended, so this message ran in a new one, told what was said here before.</p>}
    {turn.continuationOf && <p className="turn-note">Continues {turn.continuationOf} after the Agent reached its turn limit.</p>}
    {turn.omitted > 0 && <p className="turn-note">{turn.omitted} later {turn.omitted === 1 ? 'step was' : 'steps were'} not kept.</p>}
    {running && at == null && turn.permissions?.filter(p => p.state === 'pending').map(permission => <div key={permission.id} className="turn-permission" role="group" aria-label="Agent permission">
      <p className="permission-caption"><span aria-hidden="true" />Needs your choice</p>
      <p className="permission-title">{permission.title}</p>
      {permission.details && <pre>{permission.details}</pre>}
      <div>{permission.options.map(option => <button key={option.id} className="small-button" disabled={choosing === permission.id} onClick={() => choose(turn.id, permission.id, option.id)}>{option.name}</button>)}</div>
    </div>)}
    <div className="turn-foot">
      <p className={'turn-ending ' + turn.state} role={turn.state === 'running' ? 'status' : undefined}>{running && <span className="turn-spinner" aria-hidden="true" />}{ending(turn)}{running && elapsed !== null && <span className="turn-elapsed" aria-hidden="true"> · {liveTime(elapsed)}</span>}</p>
      <span className="turn-meta">{model && <span className="turn-model" title={model}>{split(model).name}</span>}<span title={new Date(turn.sentAt).toLocaleString()}>{clock(turn.sentAt)}</span></span>
      {!running && answerText && <CopyButton text={answerText} label="Copy answer" />}
      {continueWork && <button className="text-button" onClick={continueWork}>Continue unfinished work</button>}
      {turn.state === 'failed' && !running && !agentTurnLimit(turn) && <button className="text-button" onClick={() => askAgain(turn.text)}>Ask again</button>}
    </div>
  </li>;
}

// A message of the session sent from another window (or before Rho continued it), as the Agent's
// own record keeps it: what was asked, the steps taken and the answer.
function OutsideTurn({ turn, where, onPath }: { turn: SessionTurn; where: string; onPath?: (path: string) => void }) {
  const tools = turn.tools, said = turn.messages.length;
  const failed = tools.filter(t => t.outcome === 'failed').length;
  const ending = turn.state === 'running' ? 'Working' : turn.state === 'stopped' ? 'Stopped' : turn.state === 'failed' ? 'Failed' : turn.state === 'unknown' ? 'Outcome unknown' : 'Answered';
  return <li className={'turn outside ' + turn.state}>
    <div className="turn-person"><p data-user-text="">{turn.prompt}</p></div>
    {(tools.length > 0 || said > 0) && <details className="turn-work">
      <summary><span className="turn-work-label">{turn.state === 'running' ? 'Working' : 'Worked'}</span><span className="turn-work-said">{[tools.length ? tools.length + (tools.length === 1 ? ' step' : ' steps') : '', failed ? failed + ' failed' : '', turn.omittedTools ? turn.omittedTools + ' not shown' : ''].filter(Boolean).join(' · ')}</span></summary>
      <div className="turn-work-body">
        {said > 0 && turn.messages.map((message, i) => <div key={'m' + i} className="turn-text-block"><AgentMarkdown text={message.text} streaming={false} /></div>)}
        {tools.length > 0 && <ul className="activity-list">{tools.map(tool => <li key={tool.id} className="activity-row" data-outcome={tool.outcome}>
          <details><summary><span className={'activity-icon ' + tool.outcome} aria-hidden="true"><Icon name={/^(Bash|Command|exec)/i.test(tool.name) ? 'prompt' : /Edit|Write|File/i.test(tool.name) ? 'pencil' : /Read|View/i.test(tool.name) ? 'file' : /Grep|Glob|Search/i.test(tool.name) ? 'search' : 'tool'} size={13} /></span>
            <span className="activity-verb">{tool.name.replace(/^mcp__([^_]+)__/, '$1 · ')}</span>{tool.detail && <span className="activity-target text" title={tool.detail}>{tool.detail.split('\n')[0]}</span>}
            {tool.outcome === 'failed' && <span className="activity-flag">{tool.exitCode ? 'exit ' + tool.exitCode : 'failed'}</span>}{tool.outcome === 'unknown' && <span className="activity-flag unknown">unknown</span>}</summary>
            <dl className="activity-details">{tool.detail && <><dt>Input</dt><dd><code>{tool.detail}</code></dd></>}
              {tool.output && <><dt className="activity-printed">Returned</dt><dd className="activity-printed"><pre className="activity-output">{tool.output}</pre></dd></>}</dl>
          </details></li>)}</ul>}
      </div>
    </details>}
    {turn.results.length > 0 && <ul className="outside-results">{turn.results.map((result, i) => <li key={i}><button className="text-button" onClick={() => onPath?.(result.path)}>{result.path}</button>{result.version && <small>version {result.version.slice(0, 12)} recorded</small>}</li>)}</ul>}
    {turn.reply ? <div className="turn-text-block"><AgentMarkdown text={turn.reply} streaming={false} /></div> : null}
    <div className="turn-foot">
      <p className={'turn-ending ' + turn.state}>{turn.state === 'running' && <span className="turn-spinner" aria-hidden="true" />}{ending}</p>
      <span className="turn-meta"><span className="turn-where">In {turn.where ?? where}</span><span title={new Date(turn.at).toLocaleString()}>{clock(turn.at)}</span></span>
      {turn.reply && <CopyButton text={turn.reply} label="Copy answer" />}
    </div>
  </li>;
}
function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="text-button session-command" title={text} onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}>
    <Icon name={copied ? 'check' : 'prompt'} size={13} />{copied ? 'Copied' : 'Copy terminal command'}</button>;
}

// Below the message box: the session's plan and how much of its context it has used, as the
// Agent reported them. The whole record opens above it.
function SessionStrip({ observation, agent, spend, describing, onDescribing }: { observation: NonNullable<Observation>; agent: string;
  // What describing this conversation's files spent, and the person's switch for it.
  spend: Spend | null; describing: boolean; onDescribing: (enabled: boolean) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (event: MouseEvent) => { const box = ref.current; if (box?.open && !box.contains(event.target as Node)) box.open = false; };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  const plan = currentPlanEntry(observation), entries = observation.plan?.entries ?? [];
  const usage = observation.usage, share = usage && usage.size > 0 ? Math.min(1, usage.used / usage.size) : null;
  const spent = usage?.cost ? money(usage.cost.amount, usage.cost.currency) : null;
  // Escape closes the record and stays here: it does not also close the panel.
  return <details ref={ref} className="conversation-plan" onKeyDown={event => { if (event.key === 'Escape' && ref.current?.open) { event.preventDefault(); event.stopPropagation(); ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
    <summary title={plan?.content ?? 'Session details'}>
      <span className="strip-plan">{plan ? <><span className={'plan-state ' + plan.status} aria-hidden="true" />Plan · {plan.content}</>
        : entries.length ? <><span className="plan-state completed" aria-hidden="true" />Plan · complete</> : !usage ? 'Session details' : <span className="visually-hidden">Session details</span>}</span>
      {usage && <span className="strip-usage" aria-label={`Context ${tokens(usage.used)} of ${tokens(usage.size)} tokens${spent ? ', ' + spent : ''}`}>
        {share !== null && <svg className={'context-ring' + (share >= 0.8 ? ' high' : '')} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="6" strokeDasharray={`${Math.max(0.5, share * 37.7)} 37.7`} transform="rotate(-90 8 8)" /></svg>}
        {share !== null && <span>{Math.round(share * 100)}%</span>}
        <span className="strip-tokens">{tokens(usage.used)} / {tokens(usage.size)}</span>
        {spent && <span>{spent}</span>}
      </span>}
      {spend && spend.calls > 0 && <span className="strip-describe" title="What describing this conversation's files cost">descriptions {spendAmount(spend)}</span>}
    </summary>
    <div className="session-popover" role="group" aria-label="Session">
      {usage && <section className="session-context">
        <p className="session-row"><span>Context used</span><strong>{share !== null ? Math.round(share * 100) + '%' : '—'}</strong></p>
        {share !== null && <span className={'session-bar' + (share >= 0.8 ? ' high' : '')} aria-hidden="true"><span style={{ width: Math.max(0.5, share * 100) + '%' }} /></span>}
        <p className="session-note">{usage.used.toLocaleString()} of {usage.size.toLocaleString()} tokens</p>
        {spent && <p className="session-row"><span>Cost</span><strong>{spent}</strong></p>}
      </section>}
      {entries.length > 0 && <section className="session-plan-list">
        <p className="session-row"><span>Plan</span><strong>{entries.filter(e => e.status === 'completed').length} of {entries.length} done</strong></p>
        <ol>{entries.map((entry, i) => <li key={i} data-status={entry.status}><span className={'plan-state ' + entry.status} aria-label={entry.status.replace('_', ' ')} /><span>{entry.content}</span></li>)}</ol>
        {(observation.plan?.omitted ?? 0) > 0 && <p className="session-note">{observation.plan!.omitted} more entries were not kept.</p>}
      </section>}
      {!usage && !entries.length && <p className="session-note">{agent} has not reported its context, cost or a plan for this session.</p>}
      {(usage || entries.length > 0) && <p className="session-source">As {agent} reported them at {clock(usage?.at ?? observation.plan?.at ?? observation.at)}. Rho does not measure these.</p>}
      <section className="session-describe">
        <button className="session-switch" role="switch" aria-checked={describing} onClick={() => onDescribing(!describing)}>
          <span>Describe new files</span><span className={'menu-switch' + (describing ? ' on' : '')} aria-hidden="true" />
        </button>
        <p className="session-note">{describing
          ? 'One sentence on each file the Agent writes, from this conversation\'s model through your Claude Code. Figures go as images when models.dev lists the model as reading them, else as the code that made them.'
          : 'No model is asked; each file shows the facts read from it.'} For all conversations.</p>
        {spend && spend.calls > 0 && <>
          <p className="session-row"><span>Descriptions</span><strong>{spendAmount(spend)}</strong></p>
          <p className="session-note">{spendBasis(spend)} Not in the cost above; your provider's bill may differ.</p>
        </>}
      </section>
    </div>
  </details>;
}

type Summary = NonNullable<WorkspaceSnapshot['conversations']>[number];

// The panel's title opens the recent conversations: the way back to one without leaving the
// page beside it. The whole list, with its search, usage and trash, is the Agent page's.
function ConversationSwitcher({ list, openId, title, mark, onOpen, onAll }: {
  list: Summary[]; openId: string | null; title: string; mark: string | null; onOpen: (id: string) => void; onAll?: () => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  useOutside(open, root, () => setOpen(false));
  const recent = [...list].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const words = query.trim().toLocaleLowerCase();
  const shown = recent.filter(c => !words || (c.agentTitle || c.title).toLocaleLowerCase().includes(words));
  useLayoutEffect(() => {
    const box = menu.current;
    if (open && box) (box.querySelector<HTMLElement>('input') ?? box.querySelector<HTMLElement>('[data-item][aria-current="true"]') ?? box.querySelector<HTMLElement>('[data-item]'))?.focus({ preventScroll: true });
  }, [open]);
  function show(next: boolean) { setOpen(next); setQuery(''); if (!next) trigger.current?.focus({ preventScroll: true }); }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); show(false); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menu.current) { event.preventDefault(); stepFocus(menu.current, document.activeElement, event.key === 'ArrowDown' ? 1 : -1); }
  }
  const meta = (c: Summary) => [c.state === 'running' ? 'Answering now' : c.state === 'unknown' ? 'Outcome unknown' : day(c.lastAt), c.turns + ' ' + (c.turns === 1 ? 'message' : 'messages')].join(' · ');
  return <div ref={root} className="conversation-switch">
    <button ref={trigger} className="conversation-title" aria-haspopup="dialog" aria-expanded={open} disabled={!list.length}
      aria-label={title + (list.length ? ', recent conversations' : '')} title={list.length ? 'Recent conversations' : undefined} onClick={() => show(!open)}>
      {mark && <ProviderMark name={mark} size={15} />}<strong>{title}</strong>{list.length > 0 && <span className="conversation-title-chevron"><Icon name="chevron" size={11} /></span>}
    </button>
    {open && <div ref={menu} className="menu-pop history-pop" role="dialog" aria-label="Recent conversations" onKeyDown={key}>
      {recent.length > 6 && <div className="model-search"><Icon name="search" size={14} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} spellCheck={false} autoComplete="off" onChange={event => setQuery(event.target.value)} /></div>}
      <div className="history-list">
        {shown.map(c => {
          const mark = c.client === 'acp' ? c.adapter?.name || 'ACP Agent' : clientName(c.client);
          return <button key={c.conversationId} data-item className="history-row" aria-current={c.conversationId === openId ? 'true' : undefined} onClick={() => { show(false); onOpen(c.conversationId); }}>
            {mark ? <ProviderMark name={mark} size={14} /> : <span className="history-mark" aria-hidden="true" />}
            <span className="history-text"><strong>{c.agentTitle || c.title}</strong><span>{meta(c)}</span></span>
            {c.conversationId === openId && <span className="history-check"><Icon name="check" size={14} /></span>}
          </button>;
        })}
        {!shown.length && <p className="model-none">No conversation matches “{query.trim()}”.</p>}
      </div>
      {onAll && <><div className="menu-divider" role="separator" />
        <button data-item className="menu-row" onClick={() => { setOpen(false); onAll(); }}><span className="menu-label">All conversations</span><span className="menu-value"><span>{list.length}</span></span><Icon name="chevron" size={12} /></button></>}
    </div>}
  </div>;
}

// replayAt shows the open conversation as it stood at that moment, in step with its Studio;
// onStarted names the conversation a message went to once the service has it.
// The selected marks a message carried, as its sender sees them under their words.
function figureNote(brief: any) {
  if (!brief) return null;
  // A cell's plot is named by its number; a saved figure by its file.
  const where = brief.plot !== undefined ? `plot ${brief.plot}${brief.cell ? ' of cell ' + brief.cell : ''}` : `${brief.path ?? 'a saved figure'}${brief.cell ? ', saved by cell ' + brief.cell : ''}`;
  return <small className="turn-place">{brief.unavailable ? 'A figure selection that could not be read' : `${brief.count} selected mark${brief.count === 1 ? '' : 's'} · ${where}`}</small>;
}
export function AgentConversation({ snapshot, client, uiContext, attachment, onDetach, selectedId, onSelected, onOpen, onSent, onStarted, onClose, onAll, replayOf, replayAt: replaying = null, onNow, sessions, onPath }: {
  snapshot: WorkspaceSnapshot; client: BrowserClient; selectedId?: string | null; onSelected?: () => void; onOpen?: (id: string | null) => void; onSent?: () => void; onStarted?: (conversationId: string) => void; onClose?: () => void; onAll?: () => void;
  replayOf?: string | null; replayAt?: number | null; onNow?: () => void;
  // Every Agent session in the project folder (agent.sessions.list), and opening a file it names.
  sessions?: ExternalSummary[]; onPath?: (path: string) => void;
  uiContext?: UiLocation;
  // Marks selected in a figure that go with the next message (uiContext names them), and dropping them.
  attachment?: { label: string; count: number } | null; onDetach?: () => void;
}) {
  const projectId = snapshot.project.id, openKey = 'rho.conversation.open.v1:' + projectId;
  const [openId, setOpenId] = useState<string | null>(() => stored(openKey));
  const draftKey = 'rho.conversation.draft.v1:' + projectId + ':' + (openId ?? 'new'), pendingKey = 'rho.conversation.pending.v1:' + projectId;
  const [draft, setDraft] = useState(() => stored(draftKey) ?? '');
  const [pending, setPending] = useState<Pending | null>(() => { try { return JSON.parse(stored(pendingKey) ?? 'null'); } catch { return null; } });
  const [read, setRead] = useState<Read | null>(null), [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [unconfirmed, setUnconfirmed] = useState(false);
  const settings = useAgentSettings(client, projectId), [configuring, setConfiguring] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [following, setFollowing] = useState(true), [unseen, setUnseen] = useState(false);
  const replayAt = replaying !== null && openId === replayOf ? replaying : null;
  const list = snapshot.conversations ?? [];
  const summary = list.find(c => c.conversationId === openId);
  const openClient = summary?.client ?? read?.conversation.client;
  const openBackend = backendOf(openClient, summary?.backend ?? read?.conversation.backend);
  // An Agent session opened before Rho continues it, or the session a Rho conversation uses.
  const sessionOpen = !!openId && openId.startsWith('x-');
  const session = (sessionOpen ? sessions?.find(s => s.id === openId) : openId ? sessions?.find(s => s.conversationId === openId) : null) ?? null;
  const [outside, setOutside] = useState<{ id: string; turns: SessionTurn[]; earlier: boolean } | null>(null), [copy, setCopy] = useState(false);
  const agentName = sessionOpen ? (session ? sessionAgent(session) : 'Agent') : openId ? (openClient ? (otherAcp(openBackend) && !settings.available(openBackend)?.found && (summary?.adapter?.name || read?.conversation.adapter?.name)) || settings.name(openBackend) : 'Agent') : settings.name(settings.backend);
  const mark = sessionOpen ? (session ? sessionAgent(session) : null) : agentName === 'Agent' ? null : agentName;
  const end = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(stored(draftKey) ?? ''); }, [draftKey]);
  // 'new' asks for the composer of a new conversation.
  useEffect(() => { if (selectedId) { open(selectedId === 'new' ? null : selectedId); onSelected?.(); if (selectedId === 'new') setTimeout(() => input.current?.focus()); } }, [selectedId]);
  // The session's own record, read again whenever it grows.
  useEffect(() => {
    const target = session?.id;
    if (!target) { setOutside(null); return; }
    let current = true;
    client.call('agent.sessions.read', { projectId, session: target, limit: 50 }).then(value => { if (current) setOutside({ id: target, turns: value.turns, earlier: value.first > 0 || value.session.omittedTurns > 0 }); },
      () => { if (current) setOutside(kept => kept?.id === target ? kept : null); });
    return () => { current = false; };
  }, [session?.id, session?.sourceCursor, session?.lastAt]);
  useEffect(() => { setCopy(false); }, [openId]);
  // The open conversation is read again whenever its recorded version changes.
  useEffect(() => {
    if (!openId || openId.startsWith('x-')) { setRead(null); return; }
    let current = true;
    client.call('conversation.read', { projectId, conversationId: openId, limit: 50 }).then(value => { if (current) { setRead(value); setProblem(''); } }, error => {
      if (!current) return;
      if (error instanceof BrowserApiError && error.error.kind === 'not_found') { open(null); setProblem('This conversation is not available in this project. Nothing was started.'); return; }
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
    // A replay keeps its moment in view.
    if (following || replayAt !== null) {
      if (parent) parent.scrollTop = parent.scrollHeight; else end.current?.scrollIntoView({ block: 'end' });
      seen.current = version; setUnseen(false);
    } else if (seen.current !== version) setUnseen(true);
  }, [read?.conversation.version, openId, following, replayAt]);
  function open(id: string | null) { setOpenId(id); store(openKey, id); onOpen?.(id); setProblem(''); setFollowing(true); setUnseen(false); }
  function edit(text: string) { setDraft(text); if (!store(draftKey, text)) setProblem('This draft could not be stored. Send or copy it before closing this panel.'); }
  function askAgain(text: string) { setFollowing(true); edit(text); input.current?.focus(); }
  const last = read?.turns.at(-1), answering = !!openId && (last?.state === 'running' || summary?.state === 'running');
  // The request identity is chosen once, kept until the service answers, and reused by Retry,
  // so a lost reply never turns one message into two.
  async function deliver(next: Pending) {
    setBusy(true); setProblem(''); setUnconfirmed(false);
    setPending(next); store(pendingKey, JSON.stringify(next));
    try {
      const reply = next.kind === 'start'
        ? await client.call('conversation.start', { projectId, changeId: next.changeId, text: next.text, ...(next.uiContext ? { uiContext: next.uiContext } : {}), ...(next.backend ? { backend: next.backend } : {}), ...(next.continue ? { continue: next.continue } : {}) })
        : await client.call('conversation.send', { projectId, conversationId: next.conversationId!, changeId: next.changeId, text: next.text, ...(next.uiContext ? { uiContext: next.uiContext } : {}), ...(next.continuationOf ? { continuationOf: next.continuationOf } : {}) });
      setPending(null); store(pendingKey, null);
      if (!next.continuationOf) { store(draftKey, null); setDraft(''); }
      onStarted?.(reply.conversation.conversationId);
      if (next.kind === 'start') { if (next.continue) store('rho.conversation.draft.v1:' + projectId + ':' + next.continue.session, null); open(reply.conversation.conversationId); }
      else setRead(current => current && current.conversation.conversationId === reply.conversation.conversationId ? { ...current, conversation: reply.conversation, turns: [...current.turns.filter(t => t.id !== reply.turn.id), reply.turn] } : current);
    } catch (error) {
      if (error instanceof BrowserApiError) {
        // Refused: nothing was started. The words go back into the box.
        setPending(null); store(pendingKey, null); if (!next.continuationOf) { setDraft(next.text); store(draftKey, next.text); } setProblem(error.message);
      } else setUnconfirmed(true);
    } finally { setBusy(false); }
  }
  function send() {
    const text = draft.trim() ? draft : '';
    if (!text) return;
    setFollowing(true); setUnseen(false); onSent?.();
    void deliver(sessionOpen ? { kind: 'start', changeId: 'm-' + crypto.randomUUID(), text, uiContext, continue: { session: openId!, copy } }
      : openId ? { kind: 'send', conversationId: openId, changeId: 'm-' + crypto.randomUUID(), text, uiContext } : { kind: 'start', changeId: 'm-' + crypto.randomUUID(), text, uiContext });
    if (attachment) onDetach?.();
  }
  function continueWork(turn: Turn) {
    if (!openId || busy || pending || answering || !agentTurnLimit(turn)) return;
    setFollowing(true); setUnseen(false); onSent?.();
    void deliver({ kind: 'send', conversationId: openId, changeId: 'm-' + crypto.randomUUID(), continuationOf: turn.id, uiContext,
      text: 'Continue the unfinished work from the original task. First inspect the retained results and the state of any work that may still be running. Do not repeat completed actions merely to recover context. Finish what remains and report any uncertainty.' });
  }
  // A setting of the open conversation, for its next messages.
  async function configure(configId: string, value: SettingValue) {
    if (!openId) return;
    setConfiguring(true); setProblem('');
    try {
      const reply = await client.call('conversation.configure', { projectId, conversationId: openId, configId, value });
      setRead(current => current && current.conversation.conversationId === reply.conversation.conversationId ? { ...current, conversation: reply.conversation, observation: reply.observation, config: reply.config } : current);
    } catch (error) { setProblem(error instanceof Error ? error.message : 'The setting could not be changed.'); }
    finally { setConfiguring(false); }
  }
  async function stop() {
    if (!openId || !last) return;
    try { const reply = await client.call('conversation.stop', { projectId, conversationId: openId, turnId: last.id }); setRead(current => current ? { ...current, turns: current.turns.map(t => t.id === reply.turn.id ? reply.turn : t) } : current); }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The stop request could not be confirmed. Refresh to see whether it stopped.'); }
  }
  const waiting = pending && (pending.kind === 'start' ? (pending.continue ? pending.continue.session === openId : !openId) : pending.conversationId === openId) ? pending : null;
  const text = waiting ? waiting.text : draft;
  // The box grows with what is written, up to about ten lines, then scrolls.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight + 2, 240) + 'px';
  }, [text, openId]);
  const title = sessionOpen ? session?.title ?? 'Agent session' : summary?.agentTitle || summary?.title || read?.conversation.title || 'Conversation';
  const turns = replayAt === null ? read?.turns : read?.turns.flatMap(turn => { const then = turnAt(turn, replayAt); return then ? [then] : []; });
  // Messages of the session that Rho did not send: before Rho continued it, or from another window
  // between and after Rho's own, in the order they were sent.
  const where = session ? sessionWhere(session) : 'another window';
  // Each of Rho's messages is the session's turn with the same words, sent after it.
  const covered = new Set<string>();
  for (const r of read?.turns ?? []) {
    const words = r.text.trim(), from = Date.parse(r.sentAt) - 5000;
    const match = outside?.turns.find(t => !covered.has(t.id) && Date.parse(t.at) >= from && (t.prompt.trim() === words || t.prompt.includes(words)));
    if (match) covered.add(match.id);
  }
  const firstShown = read && read.first > 0 ? Date.parse(read.turns[0]?.sentAt ?? '') : -Infinity;
  const others = outside && replayAt === null ? outside.turns.filter(t => sessionOpen || (!covered.has(t.id) && Date.parse(t.at) > firstShown)) : [];
  const items: Array<{ at: number; rho?: Turn; outside?: SessionTurn }> = [...(turns ?? []).map(t => ({ at: Date.parse(t.sentAt), rho: t })), ...others.map(t => ({ at: Date.parse(t.at), outside: t }))].sort((a, b) => a.at - b.at);
  const blocked = sessionOpen && (!session || !session.continueWith || (!!session.open && !copy));
  const canSend = !busy && !waiting && !!draft.trim() && !blocked;
  return <section className="conversation" aria-label={openId ? 'Conversation' : 'New conversation'}>
    <header className="conversation-head">
      <ConversationSwitcher list={list} openId={openId} title={openId ? title : 'New conversation'} mark={openId ? mark : null} onOpen={open} onAll={onAll} />
      {openId && <button className="icon-button" aria-label="New conversation" title="New conversation" onClick={() => { open(null); setTimeout(() => input.current?.focus()); }}><Icon name="plus" size={16} /></button>}
      {onClose && <button className="icon-button" aria-label="Close Agent" title="Close" onClick={onClose}><Icon name="close" size={16} /></button>}
    </header>
    {openId && replayAt !== null && <p className="conversation-replay" role="status"><Icon name="restore" size={13} />Replaying · <strong>{clockAt(replayAt, true)}</strong>{onNow && <button className="small-button" onClick={onNow}>Back to now</button>}</p>}
    {openId ? <ol className="conversation-turns" aria-label="Messages">
      {(read?.first ?? 0) > 0 && <li className="turn-note">{read!.first} earlier {read!.first === 1 ? 'message is' : 'messages are'} kept but not shown.</li>}
      {sessionOpen && outside?.earlier && <li className="turn-note">Earlier messages of this session are not shown. {agentName} keeps them.</li>}
      {sessionOpen && !outside && <li className="turn-note">{session ? 'Reading this session…' : 'Looking for this session in the project folder…'}</li>}
      {items.map(({ rho: turn, outside: other }) => other ? <OutsideTurn key={'o-' + other.id} turn={other} where={where} onPath={onPath} /> : read && turn && <TurnView key={turn.id} turn={turn} at={replayAt} running={turn.state === 'running' && turn.id === turns?.at(-1)?.id} observation={read.observation} projectRoot={snapshot.project.root} choosing={choosing} askAgain={askAgain} continueWork={replayAt === null && turn.id === last?.id && agentTurnLimit(turn) && !waiting && !busy ? () => continueWork(turn) : undefined} choose={(turnId, permissionId, optionId) => {
        setChoosing(permissionId); setProblem('');
        void client.call('conversation.permission', { projectId, conversationId: openId!, turnId, permissionId, optionId }).then(reply => {
          setRead(current => current ? { ...current, conversation: reply.conversation, turns: current.turns.map(t => t.id === reply.turn.id ? reply.turn : t) } : current);
        }, error => setProblem(error instanceof Error ? error.message : 'The choice could not be confirmed.')).finally(() => setChoosing(null));
      }} />)}
    </ol> : <div className="conversation-intro">
      <div className="intro-lead">
        {mark && <ProviderMark name={mark} size={24} />}
        <p>Ask {agentName} to explore or change {projectName(snapshot.project)}.</p>
        <small>It runs on this machine with access to this project, and its replies appear here.</small>
      </div>
    </div>}
    <div className="conversation-composer">
      {!following && <button className={'jump-latest' + (unseen ? ' unseen' : '')} aria-label={(unseen ? 'New activity · ' : '') + 'Jump to latest'} title={unseen ? 'New activity below' : 'Jump to latest'} onClick={() => setFollowing(true)}><Icon name="arrow-down" size={15} /></button>}
      {waiting && unconfirmed && <p role="alert">Your message was not confirmed. Retry sends the same message once.<button className="small-button" disabled={busy} onClick={() => void deliver(waiting)}>Retry</button></p>}
      {problem && <p role="alert">{problem}</p>}
      {sessionOpen && session && <div className="session-notice" role="status">
        {!session.continueWith ? <p>Rho cannot continue {agentName} sessions here yet. Continue it in {where}.</p>
          : session.open && !copy ? session.producer === 'dsh' ? <p><strong>{session.open.where} is answering in this session now.</strong> Continue it here once that turn ends.</p>
            : <p><strong>Open in {session.open.where} now.</strong> Close it there to continue it here, or <button className="text-button" onClick={() => setCopy(true)}>continue a copy</button>.</p>
          : copy ? <p>Your message starts a copy of this session; the original stays as it is.{!session.open && <> <button className="text-button" onClick={() => setCopy(false)}>Continue the original</button></>}</p>
          : <p>Started in {where}. Your message continues this same {agentName} session.</p>}
        {session.resume && !session.open && <CopyCommand text={session.resume} />}
      </div>}
      <div className="composer-box" onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } }}>
        {attachment && <div className="composer-attachment" role="status" title="These marks and their rows go with your next message"><Icon name="chart" size={14} /><span>{attachment.label}</span>
          <button type="button" className="icon-button" aria-label="Don't send the selected marks" title="Don't send the selected marks" onClick={onDetach}><Icon name="close" size={13} /></button></div>}
        <label htmlFor="conversation-input" className="visually-hidden">{openId ? 'Message ' + agentName : 'Start a conversation'}</label>
        <textarea id="conversation-input" ref={input} rows={2} value={text} readOnly={!!waiting} disabled={blocked && !waiting}
          placeholder={blocked ? 'Continue it where it is open, or continue a copy.' : attachment && !answering ? 'Ask about the selected marks…' : answering ? agentName + ' is answering. You can write your next message.' : sessionOpen ? 'Continue this session with ' + agentName + '…' : openId ? 'Reply to ' + agentName + '…' : 'What should ' + agentName + ' look at or change?'} onChange={e => edit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !answering && canSend) { e.preventDefault(); send(); } }} />
        <div className="composer-bar">
          {sessionOpen ? <span /> : openId ? (openClient && <OpenSettings options={read?.observation?.config?.options ?? settings.offered(openBackend)?.options ?? null} values={read?.config ?? {}} agent={agentName}
            disabled={answering || configuring || !read} checking={settings.checking.has(openBackend)} checkProblem={settings.checkProblem[openBackend]} onCheck={() => void settings.check(openBackend)}
            onChoose={(id, value) => void configure(id, value)} />)
            : !waiting && <ComposerSettings state={settings} />}
          {answering ? <button className="composer-send stop" aria-label={last?.stop ? 'Stopping…' : 'Stop'} title={last?.stop ? 'Stopping…' : 'Stop this message'} onClick={() => void stop()} disabled={!!last?.stop}><span className="stop-square" aria-hidden="true" /></button>
            : <button className="composer-send" aria-label={busy ? 'Sending…' : openId ? 'Send' : 'Start'} title={(openId ? 'Send' : 'Start') + ' (⌘ Enter)'} disabled={!canSend} onClick={send}><Icon name="arrow-up" size={16} stroke={2} /></button>}
        </div>
      </div>
      {read?.observation && <SessionStrip observation={read.observation} agent={agentName} spend={spendOf(read.turns.map(t => t.descriptionSpend))} describing={settings.describing} onDescribing={enabled => void settings.describeFiles(enabled)} />}
    </div>
    {/* After the composer, so the newest lines end above it rather than behind it. */}
    <div ref={end} />
  </section>;
}
