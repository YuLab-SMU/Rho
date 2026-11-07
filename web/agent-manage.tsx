import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { agentLabel, backends, effortSetting, modelSetting, ModelPicker, ordered, refreshAgentSettings, SettingSelect, split, useAgentSettings, valueName, when, type AgentSettingsState, type Backend, type SettingOption, type SettingValue } from './agent-settings.js';
import { ConversationTurns, day } from './agent-work.js';
import { BrandMark, ProviderMark } from './brand-marks.js';
import { Icon } from './icons.js';
import { OutsideAgents } from './outside-agents.js';
import './agent-manage.css';
import { SessionRow, useExternalConversations, type ExternalSummary } from './external-conversations.js';

// The Agent page: every conversation with an Agent in this project, wherever it was started, to
// find, continue, export or clear away; and the Agents on this computer, with the model new
// conversations use and the setup that lets an Agent you run elsewhere use this project.
type Summary = NonNullable<WorkspaceSnapshot['conversations']>[number];
type Listed = RhoOutput<'conversation.list'>['conversations'][number];
type Tab = 'conversations' | 'agents';

const tabKey = 'rho.agent.tab.v1';
type AgentKey = 'claude-code' | 'codex' | 'other';
const agentKeys: AgentKey[] = ['claude-code', 'codex', 'other'];
const agentNames: Record<AgentKey, string> = { 'claude-code': 'Claude Code', codex: 'Codex', other: 'Other Agents' };
const backendOf = (summary: Pick<Summary, 'backend' | 'client'>): Backend | null => summary.backend === 'codex-acp' || summary.backend === 'claude-acp' || summary.backend === 'acp' ? summary.backend : summary.client === 'codex' ? 'codex-acp' : summary.client === 'acp' ? 'acp' : summary.backend === 'claude-cli' ? null : 'claude-acp';
const agentOf = (client: string) => client === 'codex' ? 'Codex' : client === 'acp' ? 'ACP Agent' : 'Claude Code';
const brandOf = (client: string) => client === 'codex' ? 'codex' as const : client === 'acp' ? 'deepseek' as const : 'claude-code' as const;
export function tokens(n: number) { return n < 1000 ? String(Math.round(n)) : n < 1e6 ? (n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K' : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; }
export function money(amount: number, currency = 'USD') {
  const sign = currency === 'USD' ? '$' : currency + ' ';
  return amount > 0 && amount < 0.001 ? '<' + sign + '0.001' : sign + amount.toFixed(amount < 1 ? 3 : 2);
}
function ago(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return day(iso);
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.round(ms / 60000) + ' min ago';
  if (ms < 6 * 3600000) return Math.round(ms / 3600000) + ' h ago';
  return day(iso);
}
function dayGroup(iso: string) {
  const at = new Date(iso), today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  return at.toDateString() === today.toDateString() ? 'Today' : at.toDateString() === yesterday.toDateString() ? 'Yesterday' : at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const stateNames: Record<string, string> = { running: 'Working', failed: 'Failed', stopped: 'Stopped', unknown: 'Outcome unknown', idle: 'Not started' };
const cost = (summary: Pick<Summary, 'usage' | 'costUsd'>) => summary.usage?.cost ? money(summary.usage.cost.amount, summary.usage.cost.currency) : typeof summary.costUsd === 'number' ? money(summary.costUsd) : null;

// What a row says about the model and effort, in the Agent's own names when it offered them.
function names(summary: Summary | Listed, settings: AgentSettingsState) {
  const backend = backendOf(summary), options = backend ? settings.offered(backend)?.options : null;
  const model = modelSetting(options), effort = effortSetting(options);
  const modelName = summary.model ? valueName(model, summary.model) : '';
  const effortValue = effort && summary.config && effort.id in summary.config ? summary.config[effort.id] : null;
  return { model: split(modelName).name, modelFull: modelName, effort: effort && effortValue !== null ? valueName(effort, effortValue) : '' };
}

export function AgentPage({ client, snapshot, exists, onContinue, onPath, onNew, onOpened, extra }: { client: BrowserClient; snapshot: WorkspaceSnapshot; exists: (path: string) => boolean; onContinue: (id: string) => void; onPath: (path: string) => void; onNew: () => void; onOpened: (compositionId: string, viewId?: string) => void; extra?: ReactNode }) {
  const settings = useAgentSettings(client, snapshot.project.id);
  useEffect(() => refreshAgentSettings(client, snapshot.project.id), [client, snapshot.project.id]);
  // A conversation's first session tells Rho what its Agent offers: while a row's Agent has no
  // names here, they are read again each time that conversation changes.
  const unnamed = (snapshot.conversations ?? []).filter(c => { const backend = backendOf(c); return backend && !settings.offered(backend); }).map(c => c.conversationId + '@' + c.version).join();
  useEffect(() => { if (unnamed) refreshAgentSettings(client, snapshot.project.id); }, [client, snapshot.project.id, unnamed]);
  const [tab, setTab] = useState<Tab>(() => { try { return /^(agents|outside)$/.test(sessionStorage.getItem(tabKey) ?? '') ? 'agents' : 'conversations'; } catch { return 'conversations'; } });
  const choose = (next: Tab) => { setTab(next); try { sessionStorage.setItem(tabKey, next); } catch { /* The tab is remembered only while storage works. */ } };
  const external = useExternalConversations(client, snapshot.project.id);
  const count = (snapshot.conversations?.length ?? 0) + external.sessions.filter(s => !s.conversationId).length;
  return <div className="agent-page">
    <div className="agent-tabs" role="tablist" aria-label="Agent page">
      <button role="tab" aria-selected={tab === 'conversations'} onClick={() => choose('conversations')}>Conversations{count > 0 && <span className="tab-count">{count}</span>}</button>
      <button role="tab" aria-selected={tab === 'agents'} onClick={() => choose('agents')}>Agents</button>
    </div>
    {tab === 'conversations' ? <>
      <Conversations client={client} snapshot={snapshot} settings={settings} exists={exists} onContinue={onContinue} onPath={onPath} onNew={onNew} external={external} />
      {extra}
    </> : <AgentsTab key={snapshot.project.id} state={settings} client={client} snapshot={snapshot} onOpened={onOpened} />}
  </div>;
}

// ——— Conversations ———

function Conversations({ client, snapshot, settings, exists, onContinue, onPath, onNew, external }: { external: ReturnType<typeof useExternalConversations>; client: BrowserClient; snapshot: WorkspaceSnapshot; settings: AgentSettingsState; exists: (path: string) => boolean; onContinue: (id: string) => void; onPath: (path: string) => void; onNew: () => void }) {
  const projectId = snapshot.project.id;
  const [query, setQuery] = useState(''), [agent, setAgent] = useState<'all' | AgentKey>('all');
  const [open, setOpen] = useState<string | null>(null), [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState<Listed[] | null>(null), [problem, setProblem] = useState(''), [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const list = useMemo(() => [...(snapshot.conversations ?? [])].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.lastAt.localeCompare(a.lastAt)), [snapshot.conversations]);
  const signature = list.map(c => c.conversationId + '@' + c.version).join('|');
  // The trash is read with the page and again whenever the project's conversations change.
  useEffect(() => {
    let live = true;
    client.call('conversation.list', { projectId, trashed: true }).then(value => { if (live) setTrash(value.conversations); }, () => { if (live) setTrash(null); });
    return () => { live = false; };
  }, [client, projectId, signature]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(timer); }, [notice]);
  // Sessions a Rho conversation already continues are listed as that conversation.
  const sessions = external.sessions.filter(c => !c.conversationId);
  const keyOf = (c: Summary | ExternalSummary): AgentKey => 'producer' in c ? (c.producer === 'claude-code' ? 'claude-code' : c.producer === 'codex' ? 'codex' : 'other') : c.client === 'codex' ? 'codex' : c.client === 'acp' ? 'other' : 'claude-code';
  const all: Array<Summary | ExternalSummary> = [...list, ...sessions];
  const counts = Object.fromEntries(agentKeys.map(key => [key, all.filter(c => keyOf(c) === key).length])) as Record<AgentKey, number>;
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = (c: Summary | ExternalSummary) => ('producer' in c ? [c.title, c.where ?? '', c.sessionId] : [c.agentTitle, c.title, names(c, settings).modelFull, c.origin?.where ?? '']).concat(agentNames[keyOf(c)]).join(' ').toLowerCase();
  const combined = all.filter(c => (agent === 'all' || keyOf(c) === agent) && words.every(word => text(c).includes(word)));
  combined.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.lastAt.localeCompare(a.lastAt));
  const groups = [...new Set(combined.map(c => dayGroup(c.lastAt)))].map(label => ({ label, rows: combined.filter(c => dayGroup(c.lastAt) === label) }));
  async function act(method: 'conversation.trash' | 'conversation.restore' | 'conversation.delete', summary: Summary | Listed) {
    setProblem('');
    try {
      await client.call(method, { projectId, conversationId: summary.conversationId });
      const title = '“' + (summary.agentTitle || summary.title) + '”';
      if (method === 'conversation.trash') { setNotice({ text: 'Moved ' + title + ' to the trash.', undo: () => void act('conversation.restore', summary) }); if (open === summary.conversationId) setOpen(null); }
      else if (method === 'conversation.restore') setNotice({ text: 'Restored ' + title + '.' });
      else setNotice({ text: 'Deleted ' + title + '.' });
      const next = await client.call('conversation.list', { projectId, trashed: true });
      setTrash(next.conversations);
    } catch (error) { setProblem(error instanceof Error ? error.message : 'That did not work.'); }
  }
  if (!all.length && !external.problem && !external.omitted && !trash?.length) return <div className="empty-state agent-empty"><span className="empty-symbol"><Icon name="spark" size={26} stroke={1.5} /></span><h2>No conversations yet</h2>
    <p>Ask the Agent to explore or change this project. What it reads, changes and runs is kept here.</p><button className="primary" onClick={onNew}><Icon name="prompt" size={16} />New conversation</button></div>;
  return <section className="conversations" aria-label="Conversations">
    <div className="conv-toolbar">
      <label className="conv-search"><Icon name="search" size={15} /><input type="search" placeholder="Search conversations" aria-label="Search conversations" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {Object.values(counts).filter(n => n > 0).length > 1 && <div className="agent-choice conv-filter" role="radiogroup" aria-label="Agent">
        {(['all', ...agentKeys] as const).filter(which => which === 'all' || counts[which] > 0).map(which => <button key={which} role="radio" aria-checked={agent === which} className={agent === which ? 'selected' : ''} onClick={() => setAgent(which)}>
          {which !== 'all' && <BrandMark brand={which === 'other' ? 'deepseek' : which} size={14} />}{which === 'all' ? 'All' : agentNames[which]}<span className="tab-count">{which === 'all' ? all.length : counts[which]}</span></button>)}
      </div>}
      <button className={'conv-trash-toggle' + (showTrash ? ' selected' : '')} aria-pressed={showTrash} onClick={() => setShowTrash(v => !v)}><Icon name="trash" size={15} />Trash{trash && trash.length > 0 && <span className="tab-count">{trash.length}</span>}</button>
    </div>
    {notice && <p className="conv-notice" role="status">{notice.text}{notice.undo && <button className="text-button" onClick={() => { notice.undo!(); setNotice(null); }}>Undo</button>}</p>}
    {problem && <p className="inline-error" role="alert">{problem}</p>}
    {external.problem && <p className="inline-error" role="alert">Sessions started outside Rho could not be read: {external.problem} Retrying.</p>}
    {external.omitted > 0 && <p className="conv-notice" role="status">{external.omitted} more {external.omitted === 1 ? 'session' : 'sessions'} in this folder {external.omitted === 1 ? 'is' : 'are'} not listed.</p>}
    {showTrash ? <TrashList trash={trash} settings={settings} onRestore={summary => void act('conversation.restore', summary)} onDelete={summary => void act('conversation.delete', summary)} />
      : groups.length ? groups.map(group => <div key={group.label} className="conv-day">
        <h3 className="conv-day-label">{group.label}</h3>
        <ul className="conv-rows">{group.rows.map(summary => 'producer' in summary ? <SessionRow key={summary.id} summary={summary} onOpen={() => onContinue(summary.id)} /> : <ConversationRow key={summary.conversationId} client={client} snapshot={snapshot} summary={summary} settings={settings} expanded={open === summary.conversationId}
          onToggle={() => setOpen(id => id === summary.conversationId ? null : summary.conversationId)} exists={exists} onContinue={onContinue} onPath={onPath} onTrash={() => void act('conversation.trash', summary)} onProblem={setProblem} />)}</ul>
      </div>)
      : <div className="empty-state compact"><p>{all.length ? 'No conversation matches “' + query.trim() + '”.' : 'Every conversation is in the trash.'}</p>{query && <button onClick={() => setQuery('')}>Clear search</button>}</div>}
  </section>;
}

function Usage({ summary }: { summary: Summary | Listed }) {
  const usage = summary.usage, spent = cost(summary);
  if (!usage && !spent) return null;
  const share = usage && usage.size > 0 ? Math.min(1, usage.used / usage.size) : null;
  return <div className="conv-usage" title={usage ? `${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens of context in use` : undefined}>
    {usage && <span className="conv-context">{tokens(usage.used)}<small> / {tokens(usage.size)}</small>{share !== null && <span className="conv-meter" aria-hidden="true"><span style={{ width: Math.max(2, share * 100) + '%' }} /></span>}</span>}
    {spent && <span className="conv-cost">{spent}</span>}
  </div>;
}

function ConversationRow({ client, snapshot, summary, settings, expanded, onToggle, exists, onContinue, onPath, onTrash, onProblem }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; summary: Summary; settings: AgentSettingsState; expanded: boolean; onToggle: () => void;
  exists: (path: string) => boolean; onContinue: (id: string) => void; onPath: (path: string) => void; onTrash: () => void; onProblem: (text: string) => void;
}) {
  const named = names(summary, settings), running = summary.state === 'running', title = summary.agentTitle || summary.title;
  const meta = [ago(summary.lastAt), named.model, named.effort && named.effort + ' effort', summary.turns + (summary.turns === 1 ? ' message' : ' messages'), summary.origin && (summary.origin.copyOf ? 'Copy of a session from ' : 'Started in ') + summary.origin.where].filter(Boolean);
  const [exporting, setExporting] = useState(false);
  async function exportIt() {
    setExporting(true);
    try { await exportMarkdown(client, snapshot, summary, named.modelFull); } catch (error) { onProblem(error instanceof Error ? error.message : 'The conversation could not be exported.'); } finally { setExporting(false); }
  }
  return <li className={'conv-row' + (expanded ? ' open' : '') + (running ? ' running' : '')}>
    <div className="conv-line">
      <button className="conv-toggle" onClick={() => onContinue(summary.conversationId)}>
        <BrandMark brand={brandOf(summary.client)} size={20} />
        <span className="conv-text">
          <span className="conv-title">{title}</span>
          <span className="conv-meta">{meta.map((part, i) => <span key={i} title={i === 1 ? named.modelFull : undefined}>{part}</span>)}
            {(stateNames[summary.state] || summary.turnLimit) && <span className={'conv-state ' + summary.state}>{running && <span className="pulse-dot" aria-hidden="true" />}{summary.turnLimit ? 'Turn limit reached' : summary.waitingPermission ? 'Needs your choice' : stateNames[summary.state]}</span>}</span>
        </span>
      </button>
      <Usage summary={summary} />
      <div className="conv-actions">
        <button className="conv-continue" onClick={() => onContinue(summary.conversationId)}>{running ? 'Follow' : 'Open'}</button>
        <button className="icon-button" aria-label={'Export ' + title + ' as Markdown'} title="Export as Markdown" disabled={exporting} onClick={() => void exportIt()}><Icon name="download" size={16} /></button>
        <button className="icon-button" aria-label={'Move ' + title + ' to the trash'} title={running ? 'Stop the Agent before moving this to the trash' : 'Move to the trash'} disabled={running} onClick={onTrash}><Icon name="trash" size={16} /></button>
        <button className="icon-button conv-chevron" aria-label={(expanded ? 'Hide' : 'Show') + ' details of ' + title} aria-expanded={expanded} onClick={onToggle}><Icon name="chevron" size={15} /></button>
      </div>
    </div>
    {expanded && <div className="conv-details">
      <Facts summary={summary} modelFull={named.modelFull} settings={settings} />
      <div className="conv-work"><h4>What it did</h4><ConversationTurns client={client} snapshot={snapshot} summary={summary} exists={exists} onContinue={onContinue} onPath={onPath} /></div>
    </div>}
  </li>;
}

function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="conv-copy"><code>{text}</code><button className="icon-button" aria-label={'Copy ' + label} title={copied ? 'Copied' : 'Copy'} onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}><Icon name={copied ? 'check' : 'copy'} size={14} /></button></span>;
}
// The record's facts, in the order a person asks about them.
function Facts({ summary, modelFull, settings }: { summary: Summary | Listed; modelFull: string; settings: AgentSettingsState }) {
  const backend = backendOf(summary), options = backend ? settings.offered(backend)?.options ?? [] : [];
  // The person's choices besides the model, which has its own line.
  const chosen = Object.entries(summary.config ?? {}).map(([id, value]) => { const option = options.find(o => o.id === id); return option && option.category !== 'model' ? (option.category === 'thought_level' ? 'Effort' : option.name) + ' ' + valueName(option, value) : null; }).filter(Boolean);
  const usage = summary.usage, spent = cost(summary);
  const first = new Date(summary.createdAt), last = new Date(summary.lastAt);
  const span = day(summary.createdAt) + (Math.abs(last.getTime() - first.getTime()) > 60000 ? ' – ' + (first.toDateString() === last.toDateString() ? last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : day(summary.lastAt)) : '');
  return <dl className="conv-facts">
    {summary.agentTitle && summary.agentTitle !== summary.title && <><dt>Asked</dt><dd>{summary.title}</dd></>}
    <dt>Time</dt><dd>{span}</dd>
    <dt>Agent</dt><dd>{agentOf(summary.client)}{summary.adapter ? ' · ' + summary.adapter.name.split('/').at(-1) + (summary.adapter.version ? ' ' + summary.adapter.version : '') : ''}</dd>
    {summary.model && <><dt>Model</dt><dd>{modelFull !== summary.model ? <>{modelFull} <code className="conv-value">{summary.model}</code></> : <code className="conv-value">{summary.model}</code>}</dd></>}
    {chosen.length > 0 && <><dt>Settings</dt><dd>{chosen.join(' · ')}</dd></>}
    {usage && <><dt>Context</dt><dd>{tokens(usage.used)} of {tokens(usage.size)} tokens · {Math.round(usage.used / Math.max(1, usage.size) * 100)}%</dd></>}
    {spent && <><dt>Cost</dt><dd>{spent}, as {agentOf(summary.client)} reported it</dd></>}
    {summary.sessionId && <><dt>Session</dt><dd><Copyable text={summary.sessionId} label="session identity" /></dd></>}
    {summary.sessionId && (summary.client === 'claude-code' || summary.client === 'codex') && <><dt>In a terminal</dt><dd><Copyable text={(summary.client === 'codex' ? 'codex resume ' : 'claude --resume ') + summary.sessionId} label="command that continues this session in a terminal" /></dd></>}
    <dt>Record</dt><dd><Copyable text={'.rho/rho/conversations/' + summary.conversationId + '.json'} label="record path" /></dd>
  </dl>;
}

function TrashList({ trash, settings, onRestore, onDelete }: { trash: Listed[] | null; settings: AgentSettingsState; onRestore: (summary: Listed) => void; onDelete: (summary: Listed) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!trash) return <p className="muted" role="status">Reading the trash…</p>;
  if (!trash.length) return <div className="empty-state compact"><p>The trash is empty.</p></div>;
  return <div className="conv-trash">
    <p className="conv-trash-note">Conversations here are kept whole and can be restored. Deleting removes Rho's record; the Agent keeps its own copy of the session.</p>
    <ul className="conv-rows">{trash.map(summary => {
      const named = names(summary, settings), title = summary.agentTitle || summary.title;
      return <li key={summary.conversationId} className="conv-row trashed">
        <div className="conv-line">
          <div className="conv-toggle static"><BrandMark brand={brandOf(summary.client)} size={20} /><span className="conv-text"><span className="conv-title">{title}</span>
            <span className="conv-meta">{['Moved here ' + (summary.trashedAt ? ago(summary.trashedAt) : ''), named.model, summary.turns + (summary.turns === 1 ? ' message' : ' messages')].filter(Boolean).map((part, i) => <span key={i}>{part}</span>)}</span></span></div>
          <Usage summary={summary} />
          <div className="conv-actions">
            {confirm === summary.conversationId ? <span className="conv-confirm" role="group" aria-label={'Delete ' + title}>
              <span>Delete for good?</span><button className="danger" onClick={() => { setConfirm(null); onDelete(summary); }}>Delete</button><button onClick={() => setConfirm(null)}>Cancel</button></span>
              : <><button onClick={() => onRestore(summary)}><Icon name="restore" size={15} />Restore</button>
                <button className="icon-button" aria-label={'Delete ' + title} title="Delete" onClick={() => setConfirm(summary.conversationId)}><Icon name="close" size={15} /></button></>}
          </div>
        </div>
      </li>;
    })}</ul>
  </div>;
}

// The whole conversation as Markdown: each message, what the Agent did step by step and what it
// answered. Paths inside the project are written relative to it.
async function exportMarkdown(client: BrowserClient, snapshot: WorkspaceSnapshot, summary: Summary, model: string) {
  const read = await client.call('conversation.read', { projectId: snapshot.project.id, conversationId: summary.conversationId, limit: 200 });
  const agent = agentOf(summary.client), root = snapshot.project.root.replace(/\/+$/, '') + '/';
  const local = (text: string) => text.split(root).join('');
  const stamp = (iso: string) => new Date(iso).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const out = ['# ' + (summary.agentTitle || summary.title), '', [agent, model, read.turns.length + (read.turns.length === 1 ? ' message' : ' messages'), stamp(summary.createdAt)].filter(Boolean).join(' · '), ''];
  if (read.first > 0) out.push(`_${read.first} earlier ${read.first === 1 ? 'message is' : 'messages are'} not included._`, '');
  for (const turn of read.turns) {
    out.push('## You · ' + stamp(turn.sentAt), '', turn.text.trim(), '', '## ' + agent + (turn.endedAt ? ' · ' + stamp(turn.endedAt) : ''), '');
    let listing = false;
    for (const step of turn.steps) {
      if (step.kind === 'tool') {
        const detail = step.detail ? ' `' + local(step.detail).replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 300) + '`' : '';
        out.push('- ' + (step.title ? local(step.title) : step.tool ?? 'Step') + (step.title && step.detail && local(step.title).includes(local(step.detail).slice(0, 40)) ? '' : detail) + (step.outcome && step.outcome !== 'returned' ? ' _(' + (step.outcome === 'rejected' ? 'refused' : step.outcome) + ')_' : ''));
        listing = true; continue;
      }
      if (listing) { out.push(''); listing = false; }
      if (step.kind === 'text' && step.text) out.push(step.text.trim() + (step.cut ? '\n\n_(cut)_' : ''), '');
      if (step.kind === 'error' && step.text) out.push('> ' + step.text.trim(), '');
    }
    if (listing) out.push('');
    if (turn.state !== 'completed') out.push('_' + (turn.state === 'running' ? 'Still answering when exported.' : (stateNames[turn.state] ?? turn.state) + '.') + (turn.problem ? ' ' + turn.problem : '') + '_', '');
  }
  const name = (summary.agentTitle || summary.title).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'conversation';
  const url = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name + '.md'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ——— Agents ———

const providerOf = (value: { name: string; group?: string }) => value.group ?? split(value.name).group;
const markOf = (which: Backend) => which === 'codex-acp' ? 'codex' as const : which === 'acp' ? 'deepseek' as const : 'claude-code' as const;

// The Agents Rho can run here, and the setup that lets an Agent the person runs elsewhere use
// this project. Sessions of either kind appear under Conversations.
function AgentsTab({ state, client, snapshot, onOpened }: { state: AgentSettingsState; client: BrowserClient; snapshot: WorkspaceSnapshot; onOpened: (compositionId: string, viewId?: string) => void }) {
  return <div className="agents-tab">
    <section className="agents-section" aria-labelledby="agents-here">
      <header className="agents-section-head">
        <h2 id="agents-here">Agents on this computer</h2>
        <p>Rho runs your own installed Agents, with their sign-in and settings. Every session of theirs in this folder, from Rho, a terminal or an editor, is under Conversations and continues there.</p>
      </header>
      <AgentsPanel state={state} />
    </section>
    <OutsideAgents client={client} snapshot={snapshot} onOpened={onOpened} />
  </div>;
}

export function AgentsPanel({ state }: { state: AgentSettingsState }) {
  const [open, setOpen] = useState<Backend | null>(null);
  if (!state.settings) return <p className="muted" role={state.problem ? 'alert' : 'status'}>{state.problem || 'Reading…'}</p>;
  // An ACP Agent is listed only when the person named its command.
  const shown = backends.filter(which => which !== 'acp' || state.available('acp')?.found);
  return <>
    <ul className="agent-rows" role="radiogroup" aria-label="Agent for new conversations">{shown.map(which => <AgentRow key={which} which={which} state={state} open={open === which} onToggle={() => setOpen(current => current === which ? null : which)} />)}</ul>
    {state.problem && <p className="inline-error" role="alert">{state.problem}</p>}
  </>;
}

function AgentRow({ which, state, open, onToggle }: { which: Backend; state: AgentSettingsState; open: boolean; onToggle: () => void }) {
  const offered = state.offered(which), choices = state.choices(which), agent = state.name(which), available = state.available(which);
  const found = available?.found !== false, checking = state.checking.has(which), problem = state.checkProblem[which], isDefault = which === state.backend;
  const { model } = ordered(offered?.options ?? []);
  const chosen = model && model.id in choices ? choices[model.id] as string : null;
  const current = model?.values?.find(v => v.value === (chosen ?? model.current));
  const status = !found ? { tone: 'missing', text: 'Not found on this computer' }
    : checking ? { tone: 'busy', text: 'Asking ' + agent + ' what it offers…' }
    : problem ? { tone: 'failed', text: problem }
    : { tone: 'ready', text: isDefault ? 'New conversations use ' + agent : 'Ready' };
  return <li className={'agent-row' + (open ? ' open' : '') + (isDefault ? ' default' : '') + (found ? '' : ' missing')}>
    <div className="agent-row-head">
      <button role="radio" aria-checked={isDefault} className="agent-radio" disabled={!found} title={found ? 'Use ' + agent + ' for new conversations' : available?.problem} aria-label={'Use ' + agent + ' for new conversations'} onClick={() => void state.chooseAgent(which)}><span aria-hidden="true" /></button>
      <span className="agent-row-mark">{which === 'acp' && agent !== 'DeepSeek Harness' ? <ProviderMark name={agent} size={22} /> : <BrandMark brand={markOf(which)} size={22} />}</span>
      <div className="agent-row-name">
        <strong>{agent}</strong>
        <span className={'agent-row-status ' + status.tone} role={status.tone === 'failed' ? 'alert' : undefined} title={!found ? available?.problem : undefined}>{status.text}</span>
      </div>
      {found && <div className="agent-row-actions">
        <ModelPicker option={model} value={chosen} agent={agent} allowDefault checking={checking} checkProblem={problem} className="agent-row-model"
          onChoose={next => model && void state.choose(which, model.id, next)} onCheck={() => void state.check(which)}
          summary={<span className="agent-model-value">{current ? <ProviderMark name={providerOf(current) || agent} size={15} /> : null}<span>{current ? split(current.name).name : agent + "'s default model"}</span>{chosen === null && current && <small>default</small>}</span>}
          summaryText={'Model for new ' + agent + ' conversations: ' + (current?.name ?? 'default')} />
        <button className="icon-button agent-details-toggle" aria-expanded={open} aria-label={(open ? 'Hide ' : 'Show ') + agent + ' settings'} title={open ? 'Hide settings' : 'More settings'} onClick={onToggle}><Icon name="chevron" size={15} /></button>
      </div>}
    </div>
    {open && found && <AgentDetails which={which} state={state} />}
  </li>;
}

function AgentDetails({ which, state }: { which: Backend; state: AgentSettingsState }) {
  const offered = state.offered(which), choices = state.choices(which), agent = state.name(which);
  const checking = state.checking.has(which);
  const { model, effort, mode, rest } = ordered(offered?.options ?? []);
  const choose = (id: string) => (value: SettingValue | null) => void state.choose(which, id, value);
  const value = (option: SettingOption) => option.id in choices ? choices[option.id] : null;
  const chosen = model && model.id in choices ? choices[model.id] as string : null;
  const values = model?.values ?? [];
  const providers = [...new Set(values.map(providerOf).filter(Boolean))].map(name => ({ name, values: values.filter(v => providerOf(v) === name) }));
  // Values with no provider are the Agent's own names (Claude Code's opus, sonnet…) when others
  // carry one; otherwise they are simply its models.
  const own = values.filter(v => !providerOf(v));
  const [provider, setProvider] = useState<string | null>(null);
  const shown = providers.find(p => p.name === provider) ?? null;
  const settings = [effort, mode, ...rest].filter((o): o is SettingOption => !!o);
  if (!offered) return <div className="agent-details"><p className="agent-details-empty">Rho has not asked {agent} which models and settings it offers. Asking starts {agent} in a project for a few seconds; no message is sent.
    <button className="small-button" disabled={checking} onClick={() => void state.check(which)}>{checking ? 'Asking…' : 'Ask ' + agent}</button></p></div>;
  const pick = (next: string) => model && void state.choose(which, model.id, next === chosen ? null : next);
  return <div className="agent-details">
    {settings.length > 0 && <div className="agent-detail-row"><span className="agent-detail-label">Settings</span>
      <div className="agent-detail-body agent-settings-row">{settings.map(option => <SettingSelect key={option.id} option={option} value={value(option)} allowDefault onChoose={choose(option.id)} />)}</div></div>}
    {own.length > 0 && providers.length > 0 && <div className="agent-detail-row"><span className="agent-detail-label">{agent}'s names</span>
      <div className="agent-detail-body">
        <p className="agent-detail-note">{agent} decides what each of these runs, from its own settings.</p>
        <ul className="agent-tiers">{own.map(v => <li key={v.value} className={v.value === (chosen ?? model!.current) ? 'current' : ''}>
          <code>{v.value}</code><span className="agent-tier-name">{split(v.name).name}</span><span className="agent-tier-runs">{v.description ?? ''}</span>
          <button className={'small-button' + (v.value === chosen ? ' selected' : '')} aria-pressed={v.value === chosen} onClick={() => pick(v.value)}>{v.value === chosen ? 'Chosen' : 'Choose'}</button>
        </li>)}</ul>
      </div></div>}
    {values.length > 0 && <div className="agent-detail-row"><span className="agent-detail-label">Models</span>
      <div className="agent-detail-body">
        {providers.length > 0 ? <div className="agent-providers" role="group" aria-label="Providers">{providers.map(p => <button key={p.name} className={'agent-provider' + (p.name === provider ? ' selected' : '') + (p.values.some(v => v.value === chosen) ? ' holds' : '')} aria-pressed={p.name === provider}
          onClick={() => setProvider(current => current === p.name ? null : p.name)}><ProviderMark name={p.name} size={16} /><span>{p.name}</span><small>{p.values.length}</small></button>)}</div> : null}
        {(shown ?? (providers.length ? null : { name: agent, values })) && <ul className="agent-model-list" aria-label={(shown?.name ?? agent) + ' models'}>{(shown?.values ?? values).map(v => <li key={v.value}>
          <button className={v.value === chosen ? 'selected' : ''} aria-pressed={v.value === chosen} title={v.value + (v.description ? '\n' + v.description : '')} onClick={() => pick(v.value)}>
            <span>{split(v.name).name}</span>{v.value === model!.current && <small>{agent}'s default</small>}{v.value === chosen && <Icon name="check" size={14} />}</button></li>)}</ul>}
      </div></div>}
    <div className="agent-detail-row"><span className="agent-detail-label">Offered by</span>
      <div className="agent-detail-body"><p className="agent-detail-note">{offered.adapter ? offered.adapter.name.split('/').at(-1) + (offered.adapter.version ? ' ' + offered.adapter.version : '') : agent}, {offered.source === 'check' ? 'checked ' : 'seen in a conversation '}{when(offered.at)}.{offered.omitted ? ` ${offered.omitted} more ${offered.omitted === 1 ? 'value is' : 'values are'} not listed.` : ''}
        <button className="text-button" disabled={checking} onClick={() => void state.check(which)}>{checking ? 'Asking…' : 'Check again'}</button></p></div></div>
  </div>;
}
