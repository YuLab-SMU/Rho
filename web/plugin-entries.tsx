import { useEffect, useRef, useState } from 'react';
import type { BrowserClient, CapabilityCatalog } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import type { pluginEntries } from '../src/plugin-presentation.js';
import { Icon } from './icons.js';
import { renders } from './rendered.js';

type Entries = ReturnType<typeof pluginEntries>;
type Skill = Entries['skills'][number];

export function PluginViews({ entries, note }: { entries: Entries; note: string }) {
  return <section className="plugin-entry-section plugin-views" aria-labelledby="plugin-views-title">
    <h2 id="plugin-views-title" tabIndex={-1}>Views <span className="plugin-count">{entries.views.length}</span></h2>
    {note && <p className="plugin-view-note">{note}</p>}
    {!entries.views.length && <p className="plugin-empty">No standalone view is declared. Rho may present this capability in its project pages.</p>}
    <ul>{entries.views.map(view => <li key={view.id + '@' + view.version}>
      <span className="plugin-entry-symbol" aria-hidden="true"><Icon name="layout" size={16} /></span>
      <span className="plugin-entry-copy"><span className="plugin-entry-name">{view.displayName}</span>
        {view.description && <span className="plugin-entry-description">{view.description}</span>}
        <span className="plugin-entry-identity"><code>{view.id}</code> · {view.version}</span>
        {view.package && <span className="plugin-entry-identity">From <code>{view.package}</code>{view.packageVersion && ` · ${view.packageVersion}`}</span>}
        {Object.keys(view.bindings).length > 0 && <span className="plugin-entry-description">Opens with {Object.entries(view.bindings).map(([name, kind]) => `${name} (${kind})`).join(', ')}.</span>}
      </span>
      <span className="plugin-view-state">{renders(view.id, view.version) ? 'In this browser build' : 'Not in this browser build'}</span>
    </li>)}</ul>
  </section>;
}

export function PluginSkill({ skill, client, projectId, available }: { skill: Skill; client: BrowserClient; projectId: string; available: boolean }) {
  const [read, setRead] = useState<RhoOutput<'skill.read'> | null>(null), [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function load() {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setOpen(true); setLoading(true); setError('');
    try { const value = await client.call('skill.read', { projectId, skillId: skill.id, expectedDigest: skill.digest }, controller.signal); if (!controller.signal.aborted) setRead(value); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <li className="plugin-skill">
    <div className="plugin-skill-heading">
      <span className="plugin-entry-symbol" aria-hidden="true"><Icon name="document" size={16} /></span>
      <span className="plugin-entry-copy"><span className="plugin-entry-name">{skill.presentation?.displayName || skill.id}</span>
        {(skill.presentation?.description || skill.intent) && <span className="plugin-entry-description">{skill.presentation?.description || skill.intent}</span>}
        <span className="plugin-entry-identity"><code>{skill.id}</code> · {skill.version}</span>
      </span>
      <button disabled={!available || loading} onClick={() => open ? setOpen(false) : read ? setOpen(true) : void load()}>{loading ? 'Reading…' : open ? 'Close skill' : 'Read skill'}</button>
    </div>
    {!available && <p className="plugin-entry-description">The description is retained; this Skill is not exposed to this tab.</p>}
    {open && <div className="plugin-skill-body">
      {error && <div role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>}
      {read && <pre className="plugin-skill-text">{read.content}</pre>}
      <details className="plugin-entry-details"><summary>Requirements and provenance</summary>
        {skill.intent && <p>{skill.intent}</p>}
        <p>Skill version {skill.version} · Digest <code>{skill.digest}</code></p>
        {!!skill.requires?.length && <p>Requires {skill.requires.map(m => <code key={m}>{m} </code>)}</p>}
        {skill.example && <><h3>Example operation</h3><pre>{JSON.stringify(skill.example, null, 2)}</pre></>}
        {!!skill.failureRecipes?.length && <><h3>Failure guidance</h3>{skill.failureRecipes.map((r, i) => <p key={i}><strong>{r.kind}: </strong>{r.message} {r.next}</p>)}</>}
        {skill.verify && <><h3>Verification command</h3><code>{skill.verify.command}</code><p>{skill.verify.description}</p></>}
      </details>
    </div>}
  </li>;
}

export function PluginMcp({ catalog, entries }: { catalog: CapabilityCatalog; entries: Entries }) {
  const bridge = catalog.plugins.find(p => p.id === 'agent')?.listing?.mcp;
  return <details className="plugin-mcp">
    <summary>MCP and exact operation contracts <span className="plugin-count">{entries.operations.length}</span></summary>
    <p>Agents reach plugin operations through Rho’s shared MCP connection. Each Agent’s grant determines its own subset; the availability below is for this browser tab.</p>
    {bridge ? <details className="plugin-entry-details"><summary>Shared Rho MCP tools · {bridge.transport}</summary>
      <p><code>@rho-workspace/plugin-agent{bridge.entry.slice(1)}</code></p>
      {bridge.tools.map(t => <p key={t.name}><code>{t.name}</code> — {t.description}</p>)}
    </details> : <p className="plugin-empty">MCP entry metadata is not recorded in this installation.</p>}
    {!entries.operations.length && <p className="plugin-empty">No plugin-owned operations are recorded.</p>}
    {entries.operations.map(operation => {
      const live = catalog.operations.find(o => o.owner && o.method === operation.method);
      return <details className="plugin-operation" key={operation.method}>
        <summary><code>{operation.method}</code><span>{operation.state === 'unavailable' ? 'Unavailable in this project' : operation.authorized === false ? 'Not granted to this tab' : operation.authorized === true ? 'Available to this tab' : 'Description only'}</span></summary>
        {operation.presentation?.description && <p>{operation.presentation.description}</p>}
        <p>Effect: {operation.effect ?? 'Not recorded'}</p>
        {live?.inputSchema ? <><h3>Input</h3><pre>{JSON.stringify(live.inputSchema, null, 2)}</pre><h3>Output</h3><pre>{JSON.stringify(live.outputSchema, null, 2)}</pre></>
          : <p>The operation description is retained; its live contract is not loaded.</p>}
      </details>;
    })}
  </details>;
}
