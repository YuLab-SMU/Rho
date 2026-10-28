import { useEffect, useState, type ReactNode } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { AgentActivity } from './agent-activity.js';
import { abilities } from './agents.js';
import { day } from './agent-work.js';
import { BrandMark } from './brand-marks.js';
import { projectName } from './home.js';
import { Icon } from './icons.js';
import './outside-agents.css';

// Claude Code or Codex the person runs outside Rho, working on this project. Each one is a
// short list of steps in the state Rho observes: access to this project, Rho added to that
// Agent, and its first call. Adding is one button; the steps say what it did.
type Which = 'claude-code' | 'codex' | 'acp';
type Agent = NonNullable<WorkspaceSnapshot['agents']>[number];
type Session = RhoOutput<'project.work.read'>['sessions'][number];
const names: Record<Which, string> = { 'claude-code': 'Claude Code', codex: 'Codex', acp: 'Other ACP clients' };
const key = 'rho.outside.agent.v1';
const stored = () => { try { const value = sessionStorage.getItem(key); return value === 'codex' || value === 'acp' ? value : 'claude-code'; } catch { return 'claude-code'; } };

function useCopy() {
  const [copied, setCopied] = useState(''), [problem, setProblem] = useState('');
  async function copy(text: string) {
    setProblem('');
    try { await navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(current => current === text ? '' : current), 1600); }
    catch { setProblem('Could not copy. Select the text and copy it instead.'); }
  }
  return { copied, problem, copy };
}

function Step({ n, state, title, children }: { n: number; state: 'done' | 'next' | 'waiting' | 'warn'; title: string; children?: ReactNode }) {
  return <li className={'connect-step ' + state}>
    <span className="step-mark" aria-hidden="true">{state === 'done' ? <Icon name="check" size={13} stroke={2.4} /> : state === 'warn' ? '!' : n}</span>
    <div className="step-body"><strong>{title}<span className="visually-hidden">{state === 'done' ? ', done' : state === 'warn' ? ', needs attention' : ', not yet'}</span></strong>{children}</div>
  </li>;
}

export function OutsideAgents({ client, snapshot, onOpened }: { client: BrowserClient; snapshot: WorkspaceSnapshot; onOpened: (compositionId: string, viewId?: string) => void }) {
  const [which, setWhich] = useState<Which>(stored);
  const [busy, setBusy] = useState<Which | ''>(''), [problem, setProblem] = useState<{ which: Which; text: string } | null>(null);
  const [external, setExternal] = useState<Session[] | null>(null), [hostOpen, setHostOpen] = useState(false);
  const { copied, problem: copyProblem, copy } = useCopy();
  const project = snapshot.project, name = projectName(project);
  const outside = (snapshot.agents ?? []).filter(agent => !agent.conversationId);
  // A grant made here or with `rho --grant` for the same Agent is the same session.
  const grantOf = (agent: 'claude-code' | 'codex') => outside.find(a => a.added?.agent === agent) ?? outside.find(a => a.label === names[agent] || a.label === agent) ?? null;
  const others = outside.filter(a => a !== grantOf('claude-code') && a !== grantOf('codex'));
  useEffect(() => { try { sessionStorage.setItem(key, which); } catch { /* the choice lasts for this page only */ } }, [which]);
  // Sessions an ACP client started through Rho's relay; reading them starts nothing.
  useEffect(() => {
    let live = true;
    client.call('project.work.read', { projectId: project.id }).then(work => { if (live) setExternal(work.sessions.filter(s => s.source === 'external-acp')); }, () => { if (live) setExternal([]); });
    return () => { live = false; };
  }, [client, project.id, snapshot.cursor]);
  async function add(agent: 'claude-code' | 'codex') {
    setBusy(agent); setProblem(null);
    try { await client.call('session.connect', { projectId: project.id, agent }); }
    catch (error) { setProblem({ which: agent, text: error instanceof Error ? error.message : 'Rho could not be added.' }); }
    finally { setBusy(''); }
  }
  const stateOf = (agent: Which) => {
    if (agent === 'acp') return external?.length ? 'Seen' : '';
    const grant = grantOf(agent);
    return !grant ? '' : grant.ended ? 'Access ended' : grant.last ? 'Connected' : grant.added ? 'Added' : 'Access only';
  };
  const prompts = [
    `Use rho_index to show what the Rho project ${name} offers.`,
    `Read ${name}'s data files through Rho and summarize each one.`,
    `Open the newest figure in ${name} in Rho's workspace so I can see it.`,
  ];
  const tryIt = (agent: string) => <div className="connect-try">
    <p>Try one in {agent}:</p>
    <div className="prompt-pills">{prompts.map(prompt => <button key={prompt} className="prompt-pill" onClick={() => void copy(prompt)}>
      <Icon name={copied === prompt ? 'check' : 'copy'} size={14} /><span>{prompt}</span>{copied === prompt && <span className="visually-hidden">Copied</span>}
    </button>)}</div>
  </div>;

  function agentSteps(agent: 'claude-code' | 'codex') {
    const label = names[agent], grant = grantOf(agent), added = grant?.added?.agent === agent ? grant.added : null;
    const active = !!grant && !grant.ended;
    return <ol className="connect-steps">
      <Step n={1} state={grant?.ended ? 'warn' : active ? 'done' : 'waiting'} title={`Access to ${name}`}>
        <p>{grant?.ended ? `The access ended${grant.expiresAt ? ' ' + day(grant.expiresAt).toLowerCase() : ''}. Adding Rho again gives new access.`
          : active ? `${abilities(grant!, snapshot)} in this project, and nothing outside it.` : `${label} gets its own access to this project only.`}</p>
      </Step>
      <Step n={2} state={problem?.which === agent ? 'warn' : added && active ? 'done' : 'next'} title={`Rho in ${label}`}>
        <div className="connect-card">
          <div><span>{added && active ? <>Added as <code>{added.name}</code> {added.scope === 'folder' ? `for ${name}'s folder` : 'for every folder'} · {day(added.at)}</>
            : agent === 'claude-code' ? `Adds Rho to Claude Code for ${name}'s folder.` : 'Adds Rho to Codex, for every folder.'}</span>
            <small>Runs <code>{agent === 'codex' ? 'codex' : 'claude'} mcp add{agent === 'claude-code' ? ' -s local' : ''}</code> on this machine. Nothing is sent to {label}.</small></div>
          <button className={added && active ? '' : 'primary'} disabled={!!busy} onClick={() => void add(agent)}>
            {busy === agent ? 'Adding…' : <><BrandMark brand={agent} size={14} />{added && active ? 'Add again' : `Add to ${label}`}</>}</button>
        </div>
        {problem?.which === agent && <p className="inline-error" role="alert">{problem.text}</p>}
      </Step>
      <Step n={3} state={grant?.last ? (grant.last.outcome === 'rejected' ? 'warn' : 'done') : 'waiting'} title={`First call from ${label}`}>
        <p>{grant?.last ? <>{label} last called Rho {day(grant.last.at).toLowerCase()}: <code>{grant.last.method}</code>{grant.last.outcome === 'rejected' ? ', and Rho refused it.' : '.'}</>
          : added ? `A new ${label} session ${agent === 'claude-code' ? `started in ${name}'s folder` : ''} has Rho; a session already open does not. Its first call shows here.`.replace('  ', ' ')
          : 'Shows here when it happens.'}</p>
        {added && agent === 'claude-code' && !grant?.last && <button className="folder-chip" title="Copy the folder" onClick={() => void copy(project.root)}><Icon name={copied === project.root ? 'check' : 'folder'} size={13} /><span>{project.root}</span></button>}
      </Step>
      {tryIt(label)}
    </ol>;
  }

  const acpCommand = (agent: 'claude' | 'codex') => `rho --acp ${project.root} --acp-agent ${agent}`;
  return <section className="outside-agents" aria-label="Agents outside Rho">
    <header className="outside-head">
      <h2>Use Rho from your own Agent</h2>
      <p>Claude Code or Codex in your terminal works on {name} with the same files, runs and workspace. Its messages stay where you type them; what it does shows here.</p>
    </header>
    <div className="outside-body">
      <div className="outside-rail" role="tablist" aria-label="Agent" aria-orientation="vertical">
        {(['claude-code', 'codex', 'acp'] as const).map(agent => <button key={agent} role="tab" aria-selected={which === agent} onClick={() => setWhich(agent)}>
          {agent === 'acp' ? <span className="rail-mark"><Icon name="prompt" size={14} /></span> : <BrandMark brand={agent} size={16} />}
          <span className="rail-text"><span>{names[agent]}</span>{stateOf(agent) && <small className={stateOf(agent) === 'Connected' || stateOf(agent) === 'Seen' ? 'live' : undefined}>{stateOf(agent)}</small>}</span>
        </button>)}
      </div>
      <div className="outside-panel" role="tabpanel" aria-label={names[which]}>
        {which === 'acp' ? <ol className="connect-steps">
          <Step n={1} state={external?.length ? 'done' : 'next'} title="Rho as the client's Agent">
            <p>In Zed or another client that speaks ACP, use this as the Agent command. Prompts and permission choices stay in that client.</p>
            {(['claude', 'codex'] as const).map(agent => <div key={agent} className="command-line"><code>{acpCommand(agent)}</code>
              <button className="icon-button" aria-label={'Copy the command for ' + (agent === 'claude' ? 'Claude Code' : 'Codex')} onClick={() => void copy(acpCommand(agent))}><Icon name={copied === acpCommand(agent) ? 'check' : 'copy'} size={14} /></button></div>)}
          </Step>
          <Step n={2} state={external?.length ? 'done' : 'waiting'} title="A session from that client">
            {external?.length ? <ul className="seen-sessions">{external.map(s => <li key={s.id}><strong>{s.title}</strong><span>{s.state === 'running' ? 'Working now' : 'Seen'}{s.observation?.connected ? ' · connected' : ''}</span></li>)}</ul>
              : <p>Its plan, files and results show on the Overview once the client starts or loads a session.</p>}
          </Step>
        </ol> : agentSteps(which)}
        {copyProblem && <p className="inline-error" role="alert">{copyProblem}</p>}
      </div>
    </div>
    {others.length > 0 && <div className="outside-others"><h3>Other sessions with access</h3><ul>{others.map((agent: Agent) => <li key={agent.principal} data-rho-agent-session={agent.ended ? 'ended' : 'granted'}>
      <strong>{agent.label ?? 'Agent session'}</strong><span>{agent.ended ? 'Access ended' : abilities(agent, snapshot)}</span><small>{agent.last ? 'last call ' + day(agent.last.at).toLowerCase() : 'no calls yet'}</small></li>)}</ul></div>}
    {/* The project Host's activity is read only while this is open; opening it brings it into view
        rather than unfolding below the fold. */}
    <details className="outside-host" open={hostOpen} onToggle={event => {
      const details = event.currentTarget, open = details.open;
      setHostOpen(open);
      if (open) requestAnimationFrame(() => details.scrollIntoView({ block: 'start' }));
    }}><summary>Activity from the project Host</summary>{hostOpen && <AgentActivity client={client} projectId={project.id} root={project.root} onOpened={onOpened} />}</details>
  </section>;
}
