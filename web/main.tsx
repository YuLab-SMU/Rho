import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserClient, type BrowserConnection, type ProjectSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { Home, projectName as name } from './home.js';
import { Icon } from './icons.js';
import { PluginCatalog } from './plugins.js';
import './theme.css';
import './plugins.css';

const Workspace = lazy(() => import('./workspace.js').then(module => ({ default: module.Workspace })));

const sessionKey = 'rho.browser.session.v1', projectKey = 'rho.browser.project.v1';
// The launcher opens this page with a one-time code in the fragment, which no request or Referer carries.
// Remove it from the address bar before anything renders; App redeems it once.
const linkCode = new URLSearchParams(location.hash.slice(1)).get('pair');
if (linkCode !== null) history.replaceState(null, '', location.pathname + location.search);
let linkRedeemed = false;
function restoreSession(): BrowserConnection | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null');
    return saved && saved.url === location.origin && /^[a-f0-9]{64}$/.test(saved.token) && Date.parse(saved.expiresAt) > Date.now() && Array.isArray(saved.methods) ? saved : null;
  } catch { return null; }
}
function humanError(error: unknown) { return error instanceof Error ? error.message : 'The request could not be confirmed. Reconnect to inspect the owner state.'; }
// Only a rejected credential ends this tab's access; scope and network failures keep it.
function accessEnded(error: unknown) { const e = error as { kind?: string; error?: { kind?: string } } | null; return (e?.error?.kind ?? e?.kind) === 'unauthorized'; }
function clock(date: Date, seconds = false) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' }); }
function until(iso: string) {
  const at = new Date(iso), next = new Date(), today = next.toDateString(); next.setDate(next.getDate() + 1);
  return (at.toDateString() === today ? 'Today' : at.toDateString() === next.toDateString() ? 'Tomorrow' : at.toLocaleDateString()) + ' at ' + clock(at);
}
const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
type Phase = 'connecting' | 'live' | 'offline';
type Away = 'fresh' | 'linking' | 'used' | 'failed' | 'ended' | 'disconnected';
const awayCopy: Record<Away, [string, string]> = {
  fresh: ['Open Rho from your Agent', 'Ask Claude Code or another Agent to open Rho. It opens a tab that is already connected, so there is nothing to type here.'],
  linking: ['Connecting this tab', 'Using the link your Agent opened. Connecting only reads; it starts no work.'],
  used: ['This link has already been used', 'Each link from your Agent connects one tab, once, within five minutes. Ask your Agent to open Rho again.'],
  failed: ["This tab couldn't connect", 'Ask your Agent to open Rho again.'],
  ended: ["This tab's access has ended", 'It expired or was removed by whoever runs Rho. Ask your Agent to open Rho again.'],
  disconnected: ['This tab is disconnected', 'It no longer watches your projects. Ask your Agent to open Rho when you want to come back.'],
};
function App() {
  const [connection, setConnection] = useState(() => linkCode === null ? restoreSession() : null);
  const [client, setClient] = useState(() => connection ? new BrowserClient(connection) : null);
  const [away, setAway] = useState<Away>(linkCode === null ? 'fresh' : 'linking'), [awayDetail, setAwayDetail] = useState('');
  const [screen, setScreen] = useState<'home' | 'project' | 'plugins'>('home');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [readAt, setReadAt] = useState<Date | null>(null), [offlineAt, setOfflineAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [homeFocus, setHomeFocus] = useState(false), [mainFocus, setMainFocus] = useState(false);
  const [compositionId, setCompositionId] = useState('');
  const [context, setContext] = useState(false), [navigation, setNavigation] = useState(true);
  const [reconnect, setReconnect] = useState(0), [commands, setCommands] = useState(false), [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), commandTrigger = useRef<HTMLButtonElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null), disconnectTrigger = useRef<HTMLButtonElement>(null), confirmReturn = useRef<HTMLElement | null>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null), contextTrigger = useRef<HTMLButtonElement>(null);
  const awayHeading = useRef<HTMLHeadingElement>(null);
  // Elements behind the open palette are inert, so a command that moves focus waits for it to close.
  const afterCommands = useRef<(() => void) | null>(null);
  const current = useRef(project); current.current = project;
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  function live() { setPhase('live'); setReadAt(new Date()); setOfflineAt(null); }
  function lost(e: unknown) {
    if (accessEnded(e)) { end('ended'); return; }
    setPhase('offline'); setOfflineAt(at => at ?? new Date()); setError(humanError(e));
  }
  function chooseProject(next: ProjectSummary) {
    if (next.id !== project?.id) { setSnapshot(null); setCompositionId(''); }
    sessionStorage.setItem(projectKey, next.id); setProject(next); setScreen('project');
    if (matchMedia('(max-width: 767px)').matches) setNavigation(false);
  }
  useEffect(() => {
    if (linkCode === null || linkRedeemed) return;
    linkRedeemed = true;
    BrowserClient.pair(location.origin, linkCode).then(next => {
      // No credential is written anywhere except this origin's tab session store.
      sessionStorage.setItem(sessionKey, JSON.stringify(next));
      setConnection(next); setClient(new BrowserClient(next));
    }).catch(e => { setAway(accessEnded(e) ? 'used' : 'failed'); setAwayDetail(accessEnded(e) ? '' : humanError(e)); });
  }, []);
  useEffect(() => {
    if (!client) return;
    const abort = new AbortController();
    setPhase('connecting');
    client.call('project.list', {}, abort.signal).then(list => {
      setProjects(list);
      const retained = list.find(p => p.id === sessionStorage.getItem(projectKey));
      // An open project's observation reports the connection; otherwise this read does.
      if (retained && !current.current) chooseProject(retained);
      else if (!current.current) live();
    }).catch(e => { if (!abort.signal.aborted) lost(e); });
    return () => abort.abort();
  }, [client, reconnect]);
  useEffect(() => {
    if (!project || !client) return;
    const abort = new AbortController(); setPhase('connecting');
    (async () => {
      try {
        for await (const value of client.observe(project.id).observe(abort.signal)) {
          if (abort.signal.aborted) return;
          setSnapshot(value); live();
        }
      } catch (e) { if (!abort.signal.aborted) lost(e); }
    })();
    return () => abort.abort();
  }, [client, project?.id, reconnect]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (!connection || confirming) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommands(value => !value); }
    }
    function offline() { setPhase('offline'); setOfflineAt(at => at ?? new Date()); setError('You are offline. The last confirmed project snapshot is still available.'); }
    window.addEventListener('keydown', key); window.addEventListener('offline', offline);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('offline', offline); };
  }, [connection, confirming]);
  useEffect(() => {
    const media = matchMedia('(max-width: 767px)');
    function change() { setNarrow(media.matches); if (media.matches) setNavigation(false); }
    change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== 'Escape' || commands || confirming) return;
      if (context) { setContext(false); contextTrigger.current?.focus(); }
      else if (narrow && navigation) { setNavigation(false); navigationTrigger.current?.focus(); }
    }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [context, narrow, navigation, commands, confirming]);
  useEffect(() => { if (commands) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close(); }, [commands]);
  useEffect(() => { if (confirming) confirmDialog.current?.showModal(); else if (confirmDialog.current?.open) confirmDialog.current.close(); }, [confirming]);
  useEffect(() => { if (!connection && away !== 'fresh' && away !== 'linking') awayHeading.current?.focus(); }, [connection, away]);
  // The sheet leaves with the home page; once it is gone, focus moves to the project instead of the document body.
  useEffect(() => { if (mainFocus) { setMainFocus(false); document.getElementById('main')?.focus(); } }, [mainFocus]);
  function command(run: () => void) { setCommands(false); run(); }
  function reread() { setError(''); setReconnect(v => v + 1); }
  // Disconnecting forgets this tab's credential only; server authorization, projects and work are unchanged.
  function askDisconnect(trigger: HTMLElement | null) { confirmReturn.current = trigger; setCommands(false); setConfirming(true); }
  function opened(next: ProjectSummary) {
    setProjects(list => list.some(p => p.id === next.id) ? list : [...list, next]); chooseProject(next); setMainFocus(true);
  }
  function goHome() { setScreen('home'); setHomeFocus(true); }
  function end(reason: Away) {
    sessionStorage.removeItem(sessionKey); sessionStorage.removeItem(projectKey); confirmReturn.current = null;
    setConnection(null); setClient(null); setProject(null); setSnapshot(null); setProjects([]); setError(''); setReadAt(null); setOfflineAt(null);
    setContext(false); setCommands(false); setConfirming(false); setScreen('home'); setAway(reason); setAwayDetail('');
  }
  if (!connection) {
    const [title, body] = awayCopy[away];
    return <div className="application"><main id="main" className="away"><section className="standalone" aria-live="polite">
      <strong className="wordmark">Rho</strong>
      <h1 ref={awayHeading} tabIndex={-1}>{title}</h1>
      <p>{body}</p>
      {awayDetail && <p className="away-detail">{awayDetail}</p>}
      {away !== 'fresh' && away !== 'linking' && <p className="away-note">Your projects and any running work are unchanged.</p>}
    </section></main></div>;
  }
  const composition = snapshot?.compositions.find(c => c.compositionId === compositionId) ?? snapshot?.compositions[0];
  const projectVisible = screen !== 'home' && project;
  const resources = snapshot?.resources ?? [], docs = snapshot?.documents ?? [];
  const connectionNote = phase === 'live' ? `Last read ${clock(readAt ?? new Date(), true)}. Refreshing reads the project again; it never starts work.`
    : phase === 'offline' ? (readAt ? `Showing what was read at ${clock(readAt, true)}. ` : 'Nothing has been read yet. ') + "Reconnecting only reads again; it doesn't restart Rho or any work."
    : readAt ? `Reading again. Last read ${clock(readAt, true)}; reading never starts work.` : 'Reading the project. Reading never starts work.';
  return <div className="application">
    <a className="skip-link" href="#main">Skip to workspace</a>
    <header className="topbar">
      <div className="topbar-lead">{projectVisible && <button ref={navigationTrigger} className="icon-button" aria-label="Toggle project navigation" aria-controls="project-navigation" aria-expanded={navigation} onClick={() => { setNavigation(v => !v); if (narrow) setContext(false); }}><Icon name="sidebar" size={18} stroke={1.7} /></button>}</div>
      <div className="location">
        {screen === 'project' && project ? <>
          <span className="location-name">{name(project)}</span>
          {composition && <> <span className="location-separator" aria-hidden="true">/</span> <span className="location-layout">{composition.compositionId}</span></>}
          {' '}<span className="read-only" title="This tab can open and watch projects. It can't edit or run anything."><Icon name="lock" size={12} stroke={2} /><span className="read-only-label">Read-only</span></span>
        </> : <span className="location-name">{screen === 'plugins' ? 'Plugins' : 'Home'}</span>}
      </div>
      <span className={'connection ' + phase} role="status">
        <span className="connection-label">{phase === 'live' ? 'Up to date' : phase === 'offline' ? 'Offline' : 'Connecting'}</span>
        {readAt && <>{' '}<span className="connection-time">{(phase === 'live' ? '' : 'last read ') + clock(readAt)}</span></>}
      </span>
      <button ref={commandTrigger} className="command-trigger" aria-keyshortcuts="Meta+K Control+K" onClick={() => setCommands(true)}>Commands <kbd>{shortcut}</kbd></button>
      <button ref={contextTrigger} className="icon-button context-toggle" aria-label="Context & access" aria-controls="project-context" aria-expanded={context} onClick={() => { setContext(v => !v); if (narrow) setNavigation(false); }}><Icon name="context" size={18} stroke={1.7} /></button>
    </header>
    <div className="app-body">
      <nav className="app-rail" aria-label="Application">
        <Rail name="Home" icon="home" active={screen === 'home'} onClick={() => setScreen('home')} />
        <Rail name="Projects" icon="project" active={screen === 'project'} onClick={() => project ? setScreen('project') : goHome()} />
        <Rail name="Plugins" icon="plugins" active={screen === 'plugins'} onClick={() => project ? setScreen('plugins') : setScreen('home')} />
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
        {error && <div className="error-banner" role="alert"><strong>{phase === 'offline' ? 'Observation interrupted' : 'Request not confirmed'}</strong><p>{error}</p><button onClick={reread}>Reconnect and inspect</button></div>}
        {screen === 'home' || !project ? <Home client={client!} projects={projects} folder={{ root: connection.root, label: connection.rootLabel ?? connection.root ?? '' }}
          focusRequest={homeFocus} onFocused={() => setHomeFocus(false)} onChoose={chooseProject} onOpened={opened} onAccessEnded={() => end('ended')} />
          : !snapshot ? <div className="page-section"><h1>Reading your project</h1><p>Waiting for a bounded owner snapshot. No runtime is being started.</p></div> : screen === 'plugins' ? <PluginCatalog catalog={snapshot.catalog} /> : composition ? <Suspense fallback={<p className="page-section">Loading the workspace renderer...</p>}><Workspace composition={composition} snapshot={snapshot} client={client!} /></Suspense> : <section className="page-section overview"><h1>{name(project)}</h1><p className="muted">Your confirmed documents and resources, together in one workspace.</p>
          <div className="section-heading"><h2>Workspace</h2><button onClick={() => setScreen('plugins')}>Inspect capabilities</button></div>
          <div className="empty"><h2>No composition yet</h2><p>This project has no saved layout. Retained compositions will appear here when available.</p></div>
          <h2>Documents</h2>{docs.length ? docs.map(d => <article className="resource-fact" key={d.id}><strong>{d.path}</strong><span className="muted">v{d.version} / {d.dirty ? 'Unsaved owner buffer' : 'Saved'} / Renderer unavailable</span></article>) : <p className="muted">No opened documents.</p>}
          <h2>Resources</h2>{resources.length ? resources.map(r => <article className="resource-fact" key={r.id}><strong>{r.path}</strong><span className="muted">{r.kind} / {r.availability} / {r.bytes.toLocaleString()} bytes</span><details><summary>Version &amp; provenance</summary><pre>{JSON.stringify({ id: r.id, version: r.version, provenance: r.provenance }, null, 2)}</pre></details></article>) : <p className="muted">No registered resources.</p>}
        </section>}
      </main>
      {context && <aside id="project-context" className="context-drawer" aria-label="Context and access">
        <div className="drawer-heading"><h2>Context &amp; access</h2><button className="icon-button" aria-label="Close context" onClick={() => { setContext(false); contextTrigger.current?.focus(); }}><Icon name="close" size={14} stroke={2} /></button></div>
        <section className="context-section">
          <h3 className="caption">Connection</h3>
          <div className="connection-line"><span className={'status-dot ' + phase} /><strong>{phase === 'live' ? 'Up to date' : phase === 'offline' ? 'Offline' + (offlineAt ? ' since ' + clock(offlineAt) : '') : 'Connecting'}</strong><button className="small-button" onClick={reread}>{phase === 'offline' ? 'Reconnect' : 'Refresh'}</button></div>
          <p>{connectionNote}</p>
        </section>
        <section className="context-section">
          <h3 className="caption">This tab</h3>
          <dl><dt>Folder</dt><dd>{connection.root ? (connection.rootLabel ?? connection.root) + ' and below' : 'Set by whoever runs Rho'}</dd><dt>Can</dt><dd>Open, create and watch projects. No edits or runs.</dd><dt>Expires</dt><dd>{until(connection.expiresAt)}</dd></dl>
          <button ref={disconnectTrigger} className="danger-link" onClick={() => askDisconnect(disconnectTrigger.current)}>Disconnect this tab</button>
        </section>
        <section className="context-section">
          <h3 className="caption">Agents</h3>
          <p className="context-agents">Claude Code and other Agents get access from whoever runs Rho on this machine, not from this page.</p>
        </section>
        <p className="context-footnote">Closing this tab only stops watching. Work that is running keeps running.</p>
      </aside>}
    </div>
    <dialog ref={dialog} aria-labelledby="command-title" onCancel={() => setCommands(false)} onClose={() => { setCommands(false); const next = afterCommands.current; afterCommands.current = null; if (next) next(); else commandTrigger.current?.focus(); }}>
      <div className="section-heading"><h2 id="command-title">Workspace commands</h2><button aria-label="Close commands" className="icon-button" onClick={() => setCommands(false)}><Icon name="close" /></button></div>
      <div className="command-list">
        <div className="command-group" role="group" aria-label="Go to"><span className="command-heading" aria-hidden="true">Go to</span>
          <button onClick={() => command(() => setScreen('home'))}>Home</button>
          {project && <><button onClick={() => command(() => setScreen('project'))}>Workspace<span className="command-meta">{name(project)}</span></button><button onClick={() => command(() => setScreen('plugins'))}>Plugins</button></>}
          <button onClick={() => { afterCommands.current = () => setHomeFocus(true); command(() => setScreen('home')); }}>{project ? 'Open another project…' : 'Open a project…'}</button>
        </div>
        <div className="command-group" role="group" aria-label="View"><span className="command-heading" aria-hidden="true">View</span>
          {projectVisible && <button onClick={() => command(() => setNavigation(v => !v))}>{navigation ? 'Hide' : 'Show'} project navigation</button>}
          <button onClick={() => command(() => setContext(v => !v))}>{context ? 'Hide' : 'Show'} context &amp; access</button>
        </div>
        <div className="command-group" role="group" aria-label="Connection"><span className="command-heading" aria-hidden="true">Connection</span>
          <button onClick={() => command(reread)}>{phase === 'offline' ? 'Reconnect' : 'Refresh'}<span className="command-meta">Reads again · starts nothing</span></button>
        </div>
        <div className="command-group" role="group" aria-label="This tab"><span className="command-heading" aria-hidden="true">This tab</span>
          <button className="command-danger" onClick={() => askDisconnect(commandTrigger.current)}>Disconnect this tab</button>
        </div>
      </div>
      <p className="command-footer">Commands only. To ask about your work, use Claude Code.</p>
    </dialog>
    <dialog ref={confirmDialog} className="confirm" aria-labelledby="disconnect-title" aria-describedby="disconnect-body" onCancel={() => setConfirming(false)} onClose={() => { setConfirming(false); confirmReturn.current?.focus(); }}>
      <h2 id="disconnect-title">Disconnect this tab?</h2>
      <p id="disconnect-body">This tab stops watching and forgets its access. Your projects and running work don't change. To come back, ask your Agent to open Rho.</p>
      <div className="dialog-actions"><button onClick={() => setConfirming(false)}>Cancel</button><button className="danger" onClick={() => end('disconnected')}>Disconnect</button></div>
    </dialog>
  </div>;
}
function Rail({ name, icon, active, onClick }: { name: string; icon: Parameters<typeof Icon>[0]['name']; active: boolean; onClick: () => void }) {
  return <button className={'rail-button' + (active ? ' active' : '')} aria-current={active ? 'page' : undefined} onClick={onClick}><Icon name={icon} /><span>{name}</span></button>;
}
createRoot(document.getElementById('root')!).render(<App />);
