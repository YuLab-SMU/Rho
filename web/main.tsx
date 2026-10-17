import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserClient, type BrowserConnection, type ProjectSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { Icon } from './icons.js';
import './theme.css';

const Workspace = lazy(() => import('./workspace.js').then(module => ({ default: module.Workspace })));

const sessionKey = 'rho.browser.session.v1', projectKey = 'rho.browser.project.v1';
function restoreSession(): BrowserConnection | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null');
    return saved && saved.url === location.origin && /^[a-f0-9]{64}$/.test(saved.token) && Date.parse(saved.expiresAt) > Date.now() && Array.isArray(saved.methods) ? saved : null;
  } catch { return null; }
}
function name(project: ProjectSummary) { return project.root.split('/').filter(Boolean).at(-1) ?? 'Project'; }
function humanError(error: unknown) { return error instanceof Error ? error.message : 'The request could not be confirmed. Reconnect to inspect the owner state.'; }
function App() {
  const [connection, setConnection] = useState(restoreSession);
  const [client, setClient] = useState(() => connection ? new BrowserClient(connection) : null);
  const [screen, setScreen] = useState<'home' | 'project' | 'plugins'>('home');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [status, setStatus] = useState('Not paired');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState('');
  const [code, setCode] = useState('');
  const [compositionId, setCompositionId] = useState('');
  const [context, setContext] = useState(false), [navigation, setNavigation] = useState(true);
  const [reconnect, setReconnect] = useState(0), [commands, setCommands] = useState(false);
  const [observedAt, setObservedAt] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), commandTrigger = useRef<HTMLButtonElement>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null), contextTrigger = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  const projectInput = useRef<HTMLInputElement>(null);
  async function action(work: () => Promise<void>) {
    if (busy) return; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  function chooseProject(next: ProjectSummary) {
    if (next.id !== project?.id) { setSnapshot(null); setCompositionId(''); }
    sessionStorage.setItem(projectKey, next.id); setProject(next); setScreen('project');
    if (matchMedia('(max-width: 767px)').matches) setNavigation(false);
  }
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    setStatus('Connecting');
    client.call('project.list', {}, abort.signal).then(list => {
      setProjects(list); setStatus('Paired');
      const retained = list.find(p => p.id === sessionStorage.getItem(projectKey));
      if (retained && !project) chooseProject(retained);
    }).catch(e => { if (!abort.signal.aborted) { setError(humanError(e)); setStatus('Disconnected'); } });
    return () => abort.abort();
  }, [client, reconnect]);
  useEffect(() => {
    if (!project || !client) return;
    const abort = new AbortController(); setStatus('Connecting');
    (async () => {
      try {
        for await (const value of client.observe(project.id).observe(abort.signal)) {
          if (abort.signal.aborted) return;
          setSnapshot(value); setStatus('Observing'); setObservedAt(new Date().toLocaleTimeString());
        }
      } catch (e) { if (!abort.signal.aborted) { setStatus('Disconnected'); setError(humanError(e)); } }
    })();
    return () => abort.abort();
  }, [client, project?.id, reconnect]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommands(value => !value); }
    }
    function offline() { setStatus('Disconnected'); setError('You are offline. The last confirmed project snapshot is still available.'); }
    window.addEventListener('keydown', key); window.addEventListener('offline', offline);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('offline', offline); };
  }, []);
  useEffect(() => {
    const media = matchMedia('(max-width: 767px)');
    function change() { setNarrow(media.matches); if (media.matches) setNavigation(false); }
    change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== 'Escape' || commands) return;
      if (context) { setContext(false); contextTrigger.current?.focus(); }
      else if (narrow && navigation) { setNavigation(false); navigationTrigger.current?.focus(); }
    }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [context, narrow, navigation, commands]);
  useEffect(() => { if (commands) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close(); }, [commands]);
  function command(run: () => void) { setCommands(false); run(); }
  async function pair(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      const next = await BrowserClient.pair(location.origin, code.trim());
      // No credential is written anywhere except this origin's tab session store.
      sessionStorage.setItem(sessionKey, JSON.stringify(next));
      setCode(''); setConnection(next); setClient(new BrowserClient(next));
    });
  }
  async function open(create: boolean) {
    if (!client) return;
    await action(async () => {
      const next = create ? await client.call('project.create', { name: path.trim() }) : await client.call('project.open', { path: path.trim() });
      setProjects(await client.call('project.list', {})); chooseProject(next); setPath('');
    });
  }
  function forget() {
    sessionStorage.removeItem(sessionKey); sessionStorage.removeItem(projectKey);
    setConnection(null); setClient(null); setProject(null); setSnapshot(null); setProjects([]); setStatus('Not paired'); setError('');
  }
  const composition = snapshot?.compositions.find(c => c.compositionId === compositionId) ?? snapshot?.compositions[0];
  const projectVisible = screen !== 'home' && project;
  const resources = snapshot?.resources ?? [], docs = snapshot?.documents ?? [];
  return <div className="application">
    <a className="skip-link" href="#main">Skip to workspace</a>
    <header className="topbar">
      <strong className="wordmark">Rho</strong>
      {projectVisible && <button ref={navigationTrigger} className="icon-button" aria-label="Toggle project navigation" aria-controls="project-navigation" aria-expanded={navigation} onClick={() => { setNavigation(v => !v); if (narrow) setContext(false); }}><Icon name="panel" /></button>}
      <span className="breadcrumb">{projectVisible ? name(project) : 'Home'}</span>
      <button ref={commandTrigger} className="command-trigger" onClick={() => setCommands(true)}>Commands <kbd>Ctrl / Cmd K</kbd></button>
      <span className={'connection ' + status.toLowerCase()} role="status">{status}</span>
      {connection && <button ref={contextTrigger} className="context-toggle" aria-controls="project-context" aria-expanded={context} onClick={() => { setContext(v => !v); if (narrow) setNavigation(false); }}>Context</button>}
    </header>
    <div className="app-body">
      <nav className="app-rail" aria-label="Application">
        <Rail name="Home" icon="home" active={screen === 'home'} onClick={() => setScreen('home')} />
        <Rail name="Projects" icon="project" active={screen === 'project'} onClick={() => project ? setScreen('project') : (setScreen('home'), projectInput.current?.focus())} />
        <Rail name="Plugins" icon="plugins" active={screen === 'plugins'} onClick={() => project ? setScreen('plugins') : setScreen('home')} />
        <div className="rail-spacer" />
        {connection && <button className="rail-exit" onClick={forget}>Unpair this tab</button>}
      </nav>
      {projectVisible && navigation && <aside id="project-navigation" className="project-nav" aria-label="Project navigation">
        {narrow && <button aria-label="Close project navigation" onClick={() => { setNavigation(false); navigationTrigger.current?.focus(); }}>Close navigation</button>}
        <div className="project-heading"><strong>{name(project)}</strong><span className="muted">Local project</span></div>
        <button className={screen === 'project' ? 'selected' : ''} onClick={() => setScreen('project')}>Workspace</button>
        <button className={screen === 'plugins' ? 'selected' : ''} onClick={() => setScreen('plugins')}>Capabilities &amp; access</button>
        <span className="section-label">Compositions</span>
        {snapshot?.compositions.map(c => <button key={c.compositionId} className={composition?.compositionId === c.compositionId && screen === 'project' ? 'selected' : ''} onClick={() => { setCompositionId(c.compositionId); setScreen('project'); }}>{c.compositionId}<small>v{c.version}</small></button>)}
        {!snapshot?.compositions.length && <p className="muted">No retained compositions</p>}
        <span className="section-label">Project content</span>
        <div className="fact-row"><span>Documents</span><span>{docs.length}</span></div>
        <div className="fact-row"><span>Resources</span><span>{resources.length}</span></div>
        <div className="fact-row"><span>Retained operations</span><span>{snapshot?.operations.length ?? 0}</span></div>
        <p className="nav-footnote">Local project / Read-only workspace</p>
      </aside>}
      <main id="main" tabIndex={-1} className={projectVisible ? 'main project-main' : 'main'}>
        {error && <div className="error-banner" role="alert"><strong>{status === 'Disconnected' ? 'Observation interrupted' : 'Request not confirmed'}</strong><p>{error}</p><button onClick={() => { setError(''); setReconnect(v => v + 1); }}>Reconnect and inspect</button>{connection && <button onClick={forget}>Pair again</button>}</div>}
        {!connection ? <section className="pairing page-section">
          <span className="eyebrow">Local workspace</span><h1>Connect to your work</h1>
          <p>Enter the one-time code from your local Rho launcher. This tab receives scoped project access, never the operator credential.</p>
          <form onSubmit={pair}><label htmlFor="pair-code">Pairing code</label><input id="pair-code" autoComplete="off" type="password" value={code} onChange={e => setCode(e.target.value)} required maxLength={64} autoFocus spellCheck={false} /><button className="primary" disabled={busy || !code.trim()} type="submit">Pair this browser</button></form>
          <details><summary>Where is the code?</summary><p>Start Rho locally with your projects root and private service state directory. The launcher prints a short-lived pairing code. For another tab, use the local <code>rho --pair</code> command. Never paste the private operator connection file here.</p></details>
        </section> : screen === 'home' || !project ? <section className="home page-section">
          <h1>{projects.length ? 'Continue your work' : 'A workspace for your next project'}</h1>
          <p className="muted">Open a project under the paired root, or create an empty project. Nothing starts running when you open it.</p>
          <form className="project-form" onSubmit={e => { e.preventDefault(); void open(false); }}>
            <label htmlFor="project-path">Project path, relative to your paired root</label>
            <div className="input-actions"><input id="project-path" ref={projectInput} value={path} onChange={e => setPath(e.target.value)} required placeholder="my-project" autoComplete="off" /><button className="primary" type="submit" disabled={busy || !path.trim()}>Open project</button><button type="button" disabled={busy || !path.trim()} onClick={() => void open(true)}>New project</button></div>
          </form>
          <div className="section-heading"><h2>Recent projects</h2><span className="muted">Registered with this service</span></div>
          {projects.length ? <div className="project-list">{projects.map(p => <button className="project-row" key={p.id} onClick={() => chooseProject(p)}><span className="project-icon"><Icon name="project" /></span><span className="project-row-name"><strong>{name(p)}</strong><small>Opened {new Date(p.openedAt).toLocaleString()}</small></span><Icon name="arrow" /></button>)}</div> : <div className="empty"><h2>No projects yet</h2><p>Open an existing directory, or give your new project a name to get started.</p></div>}
        </section> : !snapshot ? <div className="page-section"><h1>Reading your project</h1><p>Waiting for a bounded owner snapshot. No runtime is being started.</p></div> : screen === 'plugins' ? <section className="page-section"><h1>Capabilities &amp; access</h1><p className="muted">Package presence, project enablement, operation permission and UI renderability are separate.</p>
          <div className="capability-list">{snapshot.catalog.plugins.map(p => <article className="capability" key={p.id}><div><h2>{p.id}</h2><p className="muted">{p.version ?? 'Not installed'} {p.reason ? ' / ' + p.reason : ''}</p></div><dl><dt>Package</dt><dd>{p.packagePresent ? 'Present' : 'Missing'}</dd><dt>Project</dt><dd>{p.projectEnabled ? 'Enabled' : 'Disabled'}</dd><dt>Dependencies</dt><dd>{p.dependenciesSatisfied ? 'Satisfied' : 'Unavailable'}</dd></dl></article>)}</div>
          <details><summary>Authorized operations</summary><ul>{snapshot.catalog.operations.filter(o => o.authorized).map(o => <li key={o.method}><code>{o.method}</code> / {o.state}</li>)}</ul></details>
          <details><summary>Registered UI entries</summary><ul>{snapshot.catalog.components.map(c => <li key={c.id}><code>{c.id}@{c.version}</code> / owner: {c.owner} / renderer unavailable in U1</li>)}</ul></details>
        </section> : composition ? <Suspense fallback={<p className="page-section">Loading the workspace renderer...</p>}><Workspace composition={composition} snapshot={snapshot} client={client!} /></Suspense> : <section className="page-section overview"><h1>{name(project)}</h1><p className="muted">Your confirmed documents and resources, together in one workspace.</p>
          <div className="section-heading"><h2>Workspace</h2><button onClick={() => setScreen('plugins')}>Inspect capabilities</button></div>
          <div className="empty"><h2>No composition yet</h2><p>This project has no saved layout. Retained compositions will appear here when available.</p></div>
          <h2>Documents</h2>{docs.length ? docs.map(d => <article className="resource-fact" key={d.id}><strong>{d.path}</strong><span className="muted">v{d.version} / {d.dirty ? 'Unsaved owner buffer' : 'Saved'} / Renderer unavailable</span></article>) : <p className="muted">No opened documents.</p>}
          <h2>Resources</h2>{resources.length ? resources.map(r => <article className="resource-fact" key={r.id}><strong>{r.path}</strong><span className="muted">{r.kind} / {r.availability} / {r.bytes.toLocaleString()} bytes</span><details><summary>Version &amp; provenance</summary><pre>{JSON.stringify({ id: r.id, version: r.version, provenance: r.provenance }, null, 2)}</pre></details></article>) : <p className="muted">No registered resources.</p>}
        </section>}
      </main>
      {connection && context && <aside id="project-context" className="context-drawer" aria-label="Context and access"><div className="section-heading"><h2>Context &amp; access</h2><button className="icon-button" aria-label="Close context" onClick={() => { setContext(false); contextTrigger.current?.focus(); }}><Icon name="close" /></button></div><p>This tab has scoped local access. External Agent authorization remains with the local operator.</p><dl><dt>Observation</dt><dd>{status}</dd><dt>Last snapshot</dt><dd>{observedAt || 'Not observed'}</dd><dt>Session expires</dt><dd>{new Date(connection.expiresAt).toLocaleString()}</dd></dl>{project && <details><summary>Project reference</summary><pre>{JSON.stringify(project, null, 2)}</pre></details>}<p>Closing this tab only releases its observation. It does not cancel work or shut down a Host.</p><button onClick={() => setReconnect(v => v + 1)}>Read current snapshot</button></aside>}
    </div>
    <dialog ref={dialog} aria-labelledby="command-title" onCancel={() => setCommands(false)} onClose={() => { setCommands(false); commandTrigger.current?.focus(); }}><div className="section-heading"><h2 id="command-title">Workspace commands</h2><button aria-label="Close commands" className="icon-button" onClick={() => setCommands(false)}><Icon name="close" /></button></div><div className="command-list"><button onClick={() => command(() => { setScreen('home'); setTimeout(() => projectInput.current?.focus()); })}>Open or create a project</button>{project && <><button onClick={() => command(() => setScreen('project'))}>Show workspace</button><button onClick={() => command(() => setScreen('plugins'))}>Inspect capabilities &amp; access</button><button onClick={() => command(() => setNavigation(v => !v))}>Toggle project navigation</button></>}{connection && <><button onClick={() => command(() => setContext(v => !v))}>Toggle context</button><button onClick={() => command(() => setReconnect(v => v + 1))}>Reconnect observation</button></>}</div></dialog>
  </div>;
}
function Rail({ name, icon, active, onClick }: { name: string; icon: Parameters<typeof Icon>[0]['name']; active: boolean; onClick: () => void }) {
  return <button className={'rail-button' + (active ? ' active' : '')} aria-current={active ? 'page' : undefined} onClick={onClick}><Icon name={icon} /><span>{name}</span></button>;
}
createRoot(document.getElementById('root')!).render(<App />);
