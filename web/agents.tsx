import { useState } from 'react';
import type { WorkspaceSnapshot } from '../src/browser.js';
import { projectName } from './home.js';

// The Agent sessions with access to this project, in a person's terms: which session, what
// it may do, what it last did and whether its access ended. Access is granted by whoever runs
// Rho on this machine; this page never grants it, so an ended session offers what carries on.
type Agent = NonNullable<WorkspaceSnapshot['agents']>[number];
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const runsCode = new Set(['action.submit', 'action.retry', 'requirements.prepare']);
function abilities(agent: Agent, snapshot: WorkspaceSnapshot) {
  const presentation = new Map(snapshot.catalog.operations.map(o => [o.method, o.presentation as { readOnly?: boolean; runsCode?: boolean } | undefined]));
  let reads = false, changes = false, runs = false;
  for (const method of agent.methods) {
    const p = presentation.get(method);
    if (runsCode.has(method) || p?.runsCode) runs = true;
    else if (p?.readOnly === false || /\.(edit|save|revert|undoOwn|apply|undo|create|reply|declare|register|open|close|cancel)$/.test(method)) changes = true;
    else reads = true;
  }
  const words = [reads && 'read', changes && 'change', runs && 'run code'].filter(Boolean) as string[];
  return words.length ? 'Can ' + (words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words.at(-1) : words[0]) : 'No calls granted';
}
export function AgentAccess({ snapshot }: { snapshot?: WorkspaceSnapshot | null }) {
  const agents = snapshot?.agents ?? [], [copied, setCopied] = useState(''), [problem, setProblem] = useState('');
  async function copy(agent: Agent, request: string) {
    setProblem(''); setCopied('');
    try { await navigator.clipboard.writeText(request); setCopied(agent.principal); } catch { setProblem('Could not copy. Select and copy the request text instead.'); }
  }
  if (!snapshot) return <p className="context-agents">Claude Code and other Agents get access from whoever runs Rho on this machine, not from this page.</p>;
  if (!agents.length) return <p className="context-agents">No Agent has access to {projectName(snapshot.project)}. Access comes from whoever runs Rho on this machine, not from this page.</p>;
  return <ul className="context-agent-list">{agents.map(agent => {
    const lastRun = agent.last?.operationId;
    const request = `Continue in the Rho project ${projectName(snapshot.project)} (${snapshot.project.id})${lastRun ? `; read run ${lastRun} by its operationId` : ''}.`;
    return <li key={agent.principal} data-rho-agent-session={agent.ended ? 'ended' : 'granted'}>
      <strong>{agent.label ?? 'Agent session'}</strong>
      <span>{agent.ended ? `Access ended${agent.expiresAt ? ' at ' + clock(agent.expiresAt) : ''}` : abilities(agent, snapshot)}</span>
      <span className="context-agent-last">{agent.last ? `Last active ${clock(agent.last.at)}${agent.last.outcome === 'rejected' ? ' · last call refused' : ''}${lastRun ? ' · ' + lastRun : ''}` : 'No calls yet'}</span>
      {agent.ended && <button className="small-button" onClick={() => copy(agent, request)}>{copied === agent.principal ? 'Copied' : 'Copy request for a new session'}</button>}
    </li>;
  })}
    {problem && <li role="alert">{problem}</li>}
  </ul>;
}
