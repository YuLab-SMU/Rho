import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { AgentActivity } from './agent-activity.js';
import { abilities } from './agents.js';
import { day } from './agent-work.js';
import { projectName } from './home.js';
import { Icon } from './icons.js';
import './outside-agents.css';

// Rho supplies one project-scoped connection protocol. Each Agent configures its own
// client; this screen observes grants and calls without a catalog of Agent brands.
export function OutsideAgents({ client, snapshot, onOpened }: { client: BrowserClient; snapshot: WorkspaceSnapshot; onOpened: (compositionId: string, viewId?: string) => void }) {
  const [instructions, setInstructions] = useState<RhoOutput<'session.instructions'> | null>(null);
  const [problem, setProblem] = useState(''), [retry, setRetry] = useState(0), [copied, setCopied] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [external, setExternal] = useState<RhoOutput<'project.work.read'>['sessions']>([]);
  const project = snapshot.project, name = projectName(project);
  const outside = (snapshot.agents ?? []).filter(agent => !agent.conversationId);
  useEffect(() => {
    let live = true; setInstructions(null); setProblem(''); setCopied(false);
    client.call('session.instructions', { projectId: project.id }).then(value => { if (live) setInstructions(value); }, error => { if (live) setProblem(error instanceof Error ? error.message : 'Could not load setup instructions.'); });
    return () => { live = false; };
  }, [client, project.id, retry]);
  useEffect(() => {
    let live = true;
    client.call('project.work.read', { projectId: project.id }).then(work => { if (live) setExternal(work.sessions.filter(s => s.source === 'external-acp')); }, () => { if (live) setExternal([]); });
    return () => { live = false; };
  }, [client, project.id, snapshot.cursor]);
  async function copy() {
    if (!instructions) return;
    try { await navigator.clipboard.writeText(instructions.prompt); setCopied(true); setProblem(''); }
    catch { setProblem('Could not copy. Open “Full setup prompt” below, then select and copy the text.'); }
  }
  return <section className="outside-agents" aria-label="Connect your agent">
    <header className="outside-head">
      <h2>Bring your own Agent</h2>
      <p>Keep using the Agent you already work with. Give it this prompt to connect to {name}; it will configure its own connection.</p>
    </header>
    <div className="connect-prompt-card">
      <span className="connect-eyebrow">Paste into your Agent</span>
      <p className="connect-request">{instructions?.request ?? `Connect yourself to my existing Rho project “${name}” so we can work on it together.`}</p>
      <div className="connect-prompt-actions"><button className="primary" disabled={!instructions} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied — paste into your Agent' : 'Copy setup prompt'}</button><span>Works with Agents that support local MCP tools.</span></div>
      {copied && <p className="connect-copy-status" role="status">Prompt copied. Connection status appears below after your Agent calls Rho.</p>}
      {problem && <p className="inline-error" role="alert">{problem}{!instructions && <button className="text-button" onClick={() => setRetry(n => n + 1)}>Try again</button>}</p>}
      {!instructions && !problem && <p role="status" className="muted">Loading setup instructions…</p>}
      {instructions && <details className="connect-full-prompt"><summary>Full setup prompt</summary><textarea aria-label="Full setup prompt" readOnly rows={8} value={instructions.prompt} /></details>}
    </div>
    <p className="connect-explanation">Your Agent keeps its chat, model and account settings. Rho shares this project's files, Notebook and workspace. If your client needs a new session to load its tools, your Agent will tell you.</p>
    <section className="outside-connections" aria-label="Project connections">
      <h3>Agents with access to this project</h3>
      {outside.length ? <ul>{outside.map(agent => <li key={agent.principal} data-rho-agent-session={agent.ended ? 'ended' : 'granted'}>
        <div className="connection-name"><strong>{agent.label ?? 'Agent session'}</strong><span className={'connection-status ' + (agent.ended || agent.last?.outcome === 'rejected' ? 'warn' : agent.last?.outcome === 'returned' ? 'verified' : '')}>
          {agent.ended ? 'Access ended' : agent.last?.outcome === 'rejected' ? 'Last call refused' : agent.last?.outcome === 'returned' ? 'Call verified' : 'Waiting for first successful call'}</span></div>
        <p>{agent.ended ? 'Ask your Agent to connect again using the setup prompt.' : abilities(agent, snapshot)}</p>
        {agent.last && <small>Last call {day(agent.last.at).toLowerCase()} · <code>{agent.last.method}</code></small>}
        {!agent.ended && !agent.last && <small>Access is ready. Configuration has not been verified. Ask your Agent to call rho_index.</small>}
        {!agent.ended && agent.last?.outcome === 'rejected' && <small>Ask your Agent to check the error and retry with the same connection.</small>}
      </li>)}</ul> : <div className="connections-empty"><Icon name="prompt" size={20} /><div><strong>No Agent has connected yet</strong><p>Paste the prompt into your Agent to get started. Copying it does not grant access.</p></div></div>}
    </section>
    <details className="outside-advanced"><summary>ACP clients and activity</summary>
      <p>For an editor using the ACP relay, keep its existing Agent command. The MCP setup prompt above connects your own Agent's tools; it does not change who holds the conversation.</p>
      {external.length > 0 && <ul className="seen-sessions">{external.map(s => <li key={s.id}><strong>{s.title}</strong><span>{s.state === 'running' ? 'Working now' : 'Seen'}{s.observation?.connected ? ' · connected' : ''}</span></li>)}</ul>}
      <details className="outside-host" open={hostOpen} onToggle={event => setHostOpen(event.currentTarget.open)}><summary>Activity from the project Host</summary>{hostOpen && <AgentActivity client={client} projectId={project.id} root={project.root} onOpened={onOpened} />}</details>
    </details>
  </section>;
}
