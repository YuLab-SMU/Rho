import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { AgentActivity } from './agent-activity.js';
import { projectName } from './home.js';
import { Icon } from './icons.js';
import './outside-agents.css';

// Rho supplies one project-scoped connection protocol. Each Agent configures its own client;
// once it calls Rho it is listed with the other Agents above, under its own name and mark.
export function OutsideAgents({ client, snapshot, onOpened }: { client: BrowserClient; snapshot: WorkspaceSnapshot; onOpened: (compositionId: string, viewId?: string) => void }) {
  const [instructions, setInstructions] = useState<RhoOutput<'session.instructions'> | null>(null);
  const [problem, setProblem] = useState(''), [retry, setRetry] = useState(0), [copied, setCopied] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [external, setExternal] = useState<RhoOutput<'project.work.read'>['sessions']>([]);
  const project = snapshot.project, name = projectName(project);
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
      <h2>Use {name} from your own Agent window</h2>
      <p>To work on this project from an Agent in its own window, such as Claude Code in a terminal, Codex, OpenCode, DeepSeek Harness or any Agent with MCP tools, give it this prompt. It connects itself to this project's Notebook and files and then appears in the list above.</p>
    </header>
    <div className="connect-prompt-card">
      <span className="connect-eyebrow">Paste into your Agent</span>
      <p className="connect-request">{instructions?.request ?? `Connect yourself to my existing Rho project “${name}” so we can work on it together.`}</p>
      <div className="connect-prompt-actions"><button className="primary" disabled={!instructions} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied — paste into your Agent' : 'Copy setup prompt'}</button><span>Works with Agents that support local MCP tools.</span></div>
      {copied && <p className="connect-copy-status" role="status">Prompt copied. Your Agent appears in the list above once it calls Rho.</p>}
      {problem && <p className="inline-error" role="alert">{problem}{!instructions && <button className="text-button" onClick={() => setRetry(n => n + 1)}>Try again</button>}</p>}
      {!instructions && !problem && <p role="status" className="muted">Loading setup instructions…</p>}
      {instructions && <details className="connect-full-prompt"><summary>Full setup prompt</summary><textarea aria-label="Full setup prompt" readOnly rows={8} value={instructions.prompt} /></details>}
    </div>
    <p className="connect-explanation">If your client needs a new session to load its tools, your Agent will tell you.</p>
    <details className="outside-advanced"><summary>ACP clients and activity</summary>
      <p>For an editor using the ACP relay, keep its existing Agent command. The MCP setup prompt above connects your own Agent's tools; it does not change who holds the conversation.</p>
      {external.length > 0 && <ul className="seen-sessions">{external.map(s => <li key={s.id}><strong>{s.title}</strong><span>{s.state === 'running' ? 'Working now' : 'Seen'}{s.observation?.connected ? ' · connected' : ''}</span></li>)}</ul>}
      <details className="outside-host" open={hostOpen} onToggle={event => setHostOpen(event.currentTarget.open)}><summary>Activity from the project Host</summary>{hostOpen && <AgentActivity client={client} projectId={project.id} root={project.root} onOpened={onOpened} />}</details>
    </details>
  </section>;
}
