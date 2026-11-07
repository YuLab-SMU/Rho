import { useEffect, useRef, useState } from 'react';
import type { BrowserClient, CapabilityCatalog, ViewDescription, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { viewSubject, type pluginEntries } from '../src/plugin-presentation.js';
import { canCapture, viewFor, type ResourceTarget } from './canvas.js';
import { Icon } from './icons.js';
import { renders } from './rendered.js';
import { readPreview } from './previews.js';
import { OwnerView } from './shell/owner.js';
import { kindOf, type ProjectFile } from './sources.js';
import { viewPreview } from './view-previews.js';

type Entries = ReturnType<typeof pluginEntries>;
type Skill = Entries['skills'][number];
type View = Entries['views'][number];

export interface LiveSessionValues { language: string; state: string; variables: { name: string; type: string }[] }
export interface LiveContext { client: BrowserClient; snapshot: WorkspaceSnapshot; files: ProjectFile[]; values?: LiveSessionValues[]; principalId?: string; onAbout: (pluginId: string) => void }
type Subject = { path?: string; resource?: ResourceTarget; props?: Record<string, unknown>; name: string } | { reason: string };
// The real thing in this project a view can show now, by what the view declares it is
// bound to; or why nothing here fits it yet. Nothing is created to make a picture.
const requiredProps = (view: View) => (view.propsSchema?.required ?? []).filter(k => !['title', 'x', 'y'].includes(k));
const plots = (view: View) => ['x', 'y'].every(k => view.propsSchema?.required?.includes(k));
function subjectFor(view: View, live: LiveContext): Subject {
  const subject = viewSubject(view);
  if (subject === 'draft') return { reason: 'Opens from a review of a result; it has no file of its own.' };
  // A view whose content the Agent supplies (a note, a bound task) has nothing in a project to stand in for it.
  if (requiredProps(view).length) return { reason: 'Opened by the Agent with its own content; nothing in this project stands in for it.' };
  const files = live.files.filter(f => f.kind === 'file' && !f.hidden);
  const first = (test: (path: string) => boolean) => files.find(f => test(f.path));
  const registered = (kinds: string[], keyed = false) => live.snapshot.resources.find(r => kinds.includes(r.kind) && (!keyed || !!(r as { format?: { key?: unknown } }).format?.key));
  const file = (f: ProjectFile | undefined) => f ? { path: f.path, name: f.path } : null;
  const result = (r: WorkspaceSnapshot['resources'][number] | undefined) => r ? { resource: { id: r.id, version: String(r.version), kind: r.kind, path: r.path }, name: r.path } : null;
  switch (subject) {
    case 'none': {
      // A view of one named value of a live session shows the first value a session holds now.
      const named = view.propsSchema?.properties ?? {};
      if (!('name' in named && 'language' in named)) return { name: '' };
      const session = (live.values ?? []).find(s => s.variables.length);
      return session ? { name: session.variables[0].name + ' in ' + (session.language === 'r' ? 'R' : 'Python'), props: { title: session.variables[0].name, language: session.language, name: session.variables[0].name } }
        : { reason: 'Shown for one value of a live R or Python session; none holds a value here yet.' };
    }
    case 'document': return file(first(p => kindOf(p) === 'code') ?? first(p => /\.(txt|md|markdown)$/i.test(p))) ?? { reason: 'This project has no code or text file yet.' };
    case 'markdown': return file(first(p => /\.(md|markdown)$/i.test(p))) ?? { reason: 'This project has no Markdown file yet.' };
    case 'html': return file(first(p => /\.html?$/i.test(p))) ?? { reason: 'This project has no HTML page yet.' };
    // A project file first, named as the person knows it; a registered result only when no file fits.
    // A plot of points needs a table the Agent registered with a key column, so only a registered table fits it.
    case 'table': return plots(view) ? result(registered(['table'], true)) ?? { reason: 'Shown for a table the Agent registered with a key column; this project has none yet.' }
      : (canCapture(live.snapshot) ? file(first(p => /\.csv$/i.test(p))) : null) ?? result(registered(['table'])) ?? { reason: 'This project has no CSV table or registered table yet.' };
    case 'media': return (canCapture(live.snapshot) ? file(first(p => /\.(png|jpe?g|svg)$/i.test(p))) : null) ?? result(registered(['media', 'image'])) ?? { reason: 'This project has no figure yet.' };
    case 'object': return { reason: 'Shown when the Agent registers an R value in this project.' };
  }
}
const subjectKey = (s: Subject) => 'reason' in s ? 'reason:' + s.reason : s.resource ? 'resource:' + s.resource.id + '@' + s.resource.version : s.props ? 'props:' + JSON.stringify(s.props) : 'path:' + (s.path ?? '');

// The actual view, mounted the way Studio mounts it, on a real file of this project.
function LiveView({ view, live, onClose }: { view: View; live: LiveContext; onClose: () => void }) {
  const [shown, setShown] = useState<{ view: ViewDescription; columns?: string[] } | { problem: string } | null>(null);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  // A plot's two columns: the person's choice, else the first two numeric ones.
  const [axes, setAxes] = useState<{ x?: string; y?: string }>({});
  const subject = subjectFor(view, live), key = subjectKey(subject);
  useEffect(() => {
    let alive = true;
    setShown(null); setAxes({});
    if ('reason' in subject) { setShown({ problem: subject.reason }); return; }
    (async () => {
      try {
        let described: ViewDescription;
        if (subject.path || subject.resource) {
          const made = await viewFor(live.client, live.snapshot, subject.resource ?? subject.path!);
          if (!made) throw new Error('Rho has no viewer for this file.');
          const [own] = Object.keys(view.bindings), [bound] = Object.values(made.node.bindings as Record<string, unknown>);
          const props: Record<string, unknown> = made.node.props ?? {};
          let columns: string[] | undefined;
          if (plots(view)) {
            // The first two columns the registration declares as numbers; without a declaration, the
            // first two whose sampled values are all numbers.
            const declared = ((live.snapshot.resources.find(r => r.id === subject.resource?.id) as { format?: { columns?: { name: string; type?: string }[] } } | undefined)?.format?.columns ?? []).filter(c => c.type === 'number').map(c => c.name);
            let numeric = declared;
            if (numeric.length < 2) {
              const read = await readPreview(live.client, live.snapshot, subject.resource ? { path: subject.resource.path, resource: subject.resource } : { path: subject.path! });
              if (read.kind !== 'table') throw new Error(`${subject.name} could not be read as a table.`);
              numeric = read.columns.filter(c => read.rows.length > 0 && read.rows.every(r => r[c] !== '' && r[c] !== null && Number.isFinite(Number(r[c]))));
            }
            if (numeric.length < 2) throw new Error(`${subject.name} has fewer than two numeric columns, so there is nothing to plot.`);
            columns = numeric;
          }
          described = { id: 'plugin-' + made.node.id, component: view.id, version: view.version, props, bindings: own ? { [own]: bound } : {} } as unknown as ViewDescription;
          if (alive) setShown({ view: described, columns });
          return;
        } else described = { id: 'plugin-' + view.id, component: view.id, version: view.version, props: subject.props ?? { title: view.displayName }, bindings: {} } as unknown as ViewDescription;
        if (alive) setShown({ view: described });
      } catch (e) { if (alive) setShown({ problem: e instanceof Error ? e.message : String(e) }); }
    })();
    return () => { alive = false; };
  }, [live.client, live.snapshot.project.id, view.id, view.version, key]);
  const columns = shown && 'view' in shown ? shown.columns ?? [] : [];
  const x = axes.x ?? columns[0], y = axes.y ?? (columns.find(c => c !== x) ?? columns[1]);
  const drawn = shown && 'view' in shown ? (columns.length ? { ...shown.view, props: { ...shown.view.props, x, y } } as ViewDescription : shown.view) : null;
  const axis = (label: string, value: string, set: (v: string) => void) => <label>{label}
    <select aria-label={label === 'x' ? 'Column across' : 'Column up'} value={value} onChange={e => set(e.target.value)}>{columns.map(c => <option key={c} value={c}>{c}</option>)}</select>
  </label>;
  return <div className="plugin-view-live">
    <div className="plugin-view-live-bar">
      <span>{'reason' in subject ? <>Nothing in this project fits the {view.displayName} view yet.</> : subject.props ? <>The real {view.displayName} view of <code>{subject.name}</code>, from this project’s live session.</> : subject.name ? <>The real {view.displayName} on <code>{subject.name}</code> from this project. What you do here is real.</> : <>The real {view.displayName} view of this project.</>}</span>
      {columns.length >= 2 && <span className="plugin-view-axes">{axis('x', x, v => setAxes(a => ({ ...a, x: v })))}{axis('y', y, v => setAxes(a => ({ ...a, y: v })))}</span>}
      <div ref={setHeader} className="preview-owner-header" />
      <button className="plugin-view-hide" onClick={onClose}>Hide</button>
    </div>
    <div className="plugin-view-live-body">
      {drawn ? <OwnerView key={drawn.id + ':' + x + ':' + y} active params={{ view: drawn, snapshot: live.snapshot, client: live.client, principalId: live.principalId, compositionId: 'plugin-preview', compositionVersion: 0, contextTarget: null, headerTarget: header, renderAllowed: true, onAbout: live.onAbout }} />
        : shown && 'problem' in shown ? <div className="studio-empty"><span className="empty-symbol"><Icon name="layout" size={26} stroke={1.5} /></span><h2>{view.displayName}</h2><p>{shown.problem}</p></div>
        : <div className="loading-state" role="status"><span className="loading-dot" /><span>Opening {view.displayName}…</span></div>}
    </div>
  </div>;
}

function ViewRow({ view, live }: { view: View; live?: LiveContext }) {
  const [open, setOpen] = useState(false);
  const preview = viewPreview(view.id, view.version), inBuild = renders(view.id, view.version);
  const captured = preview && new Date(preview.capturedAt);
  return <li data-component={view.id} data-version={view.version}>
    <div className="plugin-view-row">
      <span className="plugin-view-figure">{preview ? <img src={preview.url} alt={`${view.displayName} showing ${preview.shows}`} loading="lazy" /> : <span className="plugin-view-figure-empty"><Icon name="layout" size={22} stroke={1.5} /></span>}</span>
      <span className="plugin-entry-copy"><span className="plugin-entry-name">{view.displayName}</span>
        {view.description && <span className="plugin-entry-description">{view.description}</span>}
        {preview && <span className="plugin-entry-identity">Pictured showing <code>{preview.shows}</code>{captured && !Number.isNaN(captured.getTime()) ? ' · captured ' + captured.toISOString().slice(0, 10) : ''}{preview.packageVersion && preview.packageVersion !== view.packageVersion ? ` · from ${preview.packageVersion}` : ''}</span>}
        <span className="plugin-entry-identity"><code>{view.id}</code> · {view.version}</span>
        {view.package && <span className="plugin-entry-identity">From <code>{view.package}</code>{view.packageVersion && ` · ${view.packageVersion}`}</span>}
        {Object.keys(view.bindings).length > 0 && <span className="plugin-entry-description">Opens with {Object.entries(view.bindings).map(([name, kind]) => `${name} (${kind})`).join(', ')}.</span>}
      </span>
      <span className="plugin-view-actions">
        <button disabled={!inBuild || !live} onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show it here'}</button>
        <span className="plugin-view-state">{inBuild ? 'In this browser build' : 'Not in this browser build'}</span>
      </span>
    </div>
    {open && live && <LiveView view={view} live={live} onClose={() => setOpen(false)} />}
  </li>;
}

export function PluginViews({ entries, note, live }: { entries: Entries; note: string; live?: LiveContext }) {
  return <section className="plugin-entry-section plugin-views" aria-labelledby="plugin-views-title">
    <h2 id="plugin-views-title" tabIndex={-1}>Views <span className="plugin-count">{entries.views.length}</span></h2>
    {note && <p className="plugin-view-note">{note}</p>}
    {entries.views.length > 0 && <p className="plugin-section-note">Each picture is the view itself, captured in the example project. Show it here opens the real view on a file of this project.</p>}
    {!entries.views.length && <p className="plugin-empty">No standalone view is declared. Rho may present this capability in its project pages.</p>}
    <ul>{entries.views.map(view => <ViewRow key={view.id + '@' + view.version} view={view} live={live} />)}</ul>
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
