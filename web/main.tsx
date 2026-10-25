import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserClient, type BrowserConnection, type ProjectSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { Home, located, projectName as name, trapTab } from './home.js';
import { ProjectNavigation, type Section } from './project.js';
import { Icon } from './icons.js';
import { CommandPalette, type Command, type CommandGroup } from './commands.js';
import { PluginCatalog, PluginNavigation } from './plugins.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { shortcut } from './platform.js';
import './theme.css';
import './plugins.css';

const LegacyWorkspace = lazy(() => import('./workspace.js').then(module => ({ default: module.Workspace })));
const ShellWorkspace = lazy(() => import('./shell/workspace.js').then(module => ({ default: module.Workspace })));
const ProjectOverview = lazy(() => import('./overview.js').then(module => ({ default: module.ProjectOverview })));

const sessionKey = 'rho.browser.session.v1', projectKey = 'rho.browser.project.v1';
// The launcher opens this page with a one-time code in the fragment, which no request or Referer carries.
// Remove it from the address bar before anything renders; App redeems it once.
const linked = new URLSearchParams(location.hash.slice(1)), linkCode = linked.get('pair');
// The workspace shell is chosen per tab (docs/WORKSPACE-PLAN.md): #shell=next or #shell=legacy.
const shellKey = 'rho.shell.v1', shellChoice = linked.get('shell');
if (shellChoice === 'next' || shellChoice === 'legacy') sessionStorage.setItem(shellKey, shellChoice);
if (linkCode !== null || shellChoice !== null) history.replaceState(null, '', location.pathname + location.search);
const Workspace = sessionStorage.getItem(shellKey) === 'next' ? ShellWorkspace : LegacyWorkspace;
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
  // The Agent map's reference form lives in the title bar; the workspace draws it here.
  const [mapChip, setMapChip] = useState<HTMLSpanElement | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [readAt, setReadAt] = useState<Date | null>(null), [offlineAt, setOfflineAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [homeFocus, setHomeFocus] = useState(false), [mainFocus, setMainFocus] = useState(false);
  const [compositionId, setCompositionId] = useState(''), [openView, setOpenView] = useState(''), [overview, setOverview] = useState(false), [section, setSection] = useState<Section | null>(null);
  // About from a view opens that plugin and offers the way back to the project.
  const [pluginId, setPluginId] = useState(''), [pluginReturn, setPluginReturn] = useState(false);
  const [context, setContext] = useState(false), [navigation, setNavigation] = useState(true);
  const [feedbackContext, setFeedbackContext] = useState(false);
  // A view may place its own section (for example Changes) at the top of the context panel.
  const [contextSlot, setContextSlot] = useState<HTMLDivElement | null>(null);
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
  function chooseProject(next: ProjectSummary, restoreLayout = false) {
    if (next.id !== project?.id) { setSnapshot(null); setCompositionId(''); setPluginId(''); }
    // The project opens on its own question, not on whichever layout was last open:
    // a person arriving should see what the work is and where it stands.
    if (!restoreLayout) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + next.id);
    const retainedLayout = restoreLayout ? sessionStorage.getItem('rho.layout.v1:' + connection?.principalId + ':' + next.id) : null;
    setOverview(!retainedLayout); if (retainedLayout) setCompositionId(retainedLayout); setPluginReturn(false);
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
      if (retained && !current.current) chooseProject(retained, true);
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
          setSnapshot(value); setProject(value.project); setProjects(list => list.map(p => p.id === value.project.id ? value.project : p)); live();
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
    function offline() { setPhase('offline'); setOfflineAt(at => at ?? new Date()); setError('This browser reports no network connection.'); }
    window.addEventListener('keydown', key); window.addEventListener('offline', offline);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('offline', offline); };
  }, [connection, confirming]);
  useEffect(() => {
    const media = matchMedia('(max-width: 767px)');
    function change() { setNarrow(media.matches); setNavigation(!media.matches); }
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
  useEffect(() => {
    if (commands && narrow) { setNavigation(false); setContext(false); }
    if (commands) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close();
  }, [commands]);
  useEffect(() => { if (confirming) confirmDialog.current?.showModal(); else if (confirmDialog.current?.open) confirmDialog.current.close(); }, [confirming]);
  useEffect(() => { if (!connection && away !== 'fresh' && away !== 'linking') awayHeading.current?.focus(); }, [connection, away]);
  // The sheet leaves with the home page; once it is gone, focus moves to the project instead of the document body.
  useEffect(() => { if (section && snapshot && screen === 'project') { document.getElementById('overview-' + section)?.focus(); setSection(null); } }, [section, snapshot, screen]);
  useEffect(() => { if (mainFocus) { setMainFocus(false); document.getElementById('main')?.focus(); } }, [mainFocus]);
  function command(run: () => void) { setCommands(false); run(); }
  function runCommand(next: Command) { command(next.run); }
  // Below 768 the Commands button is hidden; the palette and its confirmations return to the navigation button.
  const commandReturn = () => (narrow ? navigationTrigger : commandTrigger).current;
  function reread() { setError(''); setReconnect(v => v + 1); }
  // Disconnecting forgets this tab's credential only; server authorization, projects and work are unchanged.
  function askDisconnect(trigger: HTMLElement | null) { confirmReturn.current = trigger; setCommands(false); setConfirming(true); }
  function opened(next: ProjectSummary) {
    setProjects(list => list.some(p => p.id === next.id) ? list : [...list, next]); chooseProject(next); setMainFocus(true);
  }
  // Opening a layout may name the view to bring forward: from the project page a
  // person picks an artifact, not a tab.
  function layout(id: string, view?: string) { if (project) sessionStorage.setItem('rho.layout.v1:' + connection?.principalId + ':' + project.id, id); setCompositionId(id); setOpenView(view ?? ''); setOverview(false); setScreen('project'); }
  function showOverview() { if (project) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + project.id); setOverview(true); setScreen('project'); }
  function showSection(next: Section) { showOverview(); setScreen('project'); setSection(next); }
  function plugins() { setPluginId(''); setPluginReturn(false); setScreen('plugins'); }
  function about(id: string) { setPluginId(id); setPluginReturn(true); setScreen('plugins'); }
  function goHome() { setScreen('home'); setHomeFocus(true); }
  // A choice in the drawer closes it; focus returns to the navigation button unless the choice moves it.
  const pick = (run: () => void) => () => { run(); setNavigation(false); };
  function end(reason: Away) {
    sessionStorage.removeItem(sessionKey); sessionStorage.removeItem(projectKey); sessionStorage.removeItem(shellKey); confirmReturn.current = null;
    for (const key of Object.keys(sessionStorage)) if (['rho.layout.v1:', 'rho-expression/1:', 'rho-table-question/1:'].some(prefix => key.startsWith(prefix))) sessionStorage.removeItem(key);
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
  const composition = overview ? undefined : snapshot?.compositions.find(c => c.compositionId === compositionId) ?? snapshot?.compositions[0];
  const folder = { root: connection.root, label: connection.rootLabel ?? connection.root ?? '' };
  const projectVisible = screen !== 'home' && project;
  // Plugins has its own sidebar; the plugin shown names the page.
  const sidebarName = screen === 'plugins' ? 'Plugin navigation' : 'Project navigation';
  const shownPlugin = screen === 'plugins' && pluginId ? snapshot?.catalog.plugins.find(p => p.id === pluginId) : undefined;
  const pluginTitle = shownPlugin ? pluginPresentation(shownPlugin).displayName : '';
  function choosePlugin(id: string) { setPluginId(id); if (!id) setPluginReturn(false); }
  const connectionNote = phase === 'live' ? `Last read ${clock(readAt ?? new Date(), true)}. Refreshing reads the project again; it never starts work.`
    : phase === 'offline' ? (readAt ? `Showing what was read at ${clock(readAt, true)}. ` : 'Nothing has been read yet. ') + "Reconnecting only reads again; it doesn't restart Rho or any work." + (error ? ` Last attempt: ${error}` : '')
    : readAt ? `Reading again. Last read ${clock(readAt, true)}; reading never starts work.` : 'Reading the project. Reading never starts work.';
  // Reconnecting keeps the notice until a read succeeds; the last read stays on screen meanwhile.
  const reconnecting = phase === 'connecting' && offlineAt !== null;
  const seen = readAt ? `You're seeing what was read at ${clock(readAt)}.` : 'Nothing has been read yet.';
  const groups: CommandGroup[] = [
    { label: 'Go to', commands: [
      { id: 'home', label: 'Home', icon: 'home', run: () => setScreen('home') },
      ...(project ? [
        { id: 'overview', label: 'Overview', icon: 'overview', meta: name(project), run: showOverview },
        { id: 'plugins', label: 'Plugins', icon: 'plugins', run: plugins },
      ] satisfies Command[] : []),
      { id: 'open', label: project ? 'Open another project…' : 'Open a project…', icon: 'folder', run: () => { afterCommands.current = () => setHomeFocus(true); setScreen('home'); } },
    ] },
    { label: 'View', commands: [
      ...(narrow ? [{ id: 'navigation', label: 'Show navigation', icon: 'sidebar', run: () => setNavigation(true) }] satisfies Command[]
        : projectVisible ? [{ id: 'navigation', label: (navigation ? 'Hide ' : 'Show ') + sidebarName.toLowerCase(), icon: 'sidebar', run: () => setNavigation(v => !v) }] satisfies Command[] : []),
      { id: 'context', label: (context && !feedbackContext ? 'Hide' : 'Show') + ' context & access', icon: 'context', run: () => { setFeedbackContext(false); setContext(v => feedbackContext || !v); } },
    ] },
    { label: 'Connection', commands: [{ id: 'read', label: phase === 'offline' ? 'Reconnect' : 'Refresh', icon: 'refresh', meta: 'Reads again · starts nothing', run: reread }] },
    { label: 'This tab', commands: [{ id: 'disconnect', label: 'Disconnect this tab', icon: 'unlink', danger: true, run: () => askDisconnect(commandReturn()) }] },
  ];
  // Session grants decide the access copy; older read-only sessions keep theirs.
  const edits = connection.methods.includes('document.edit');
  const access = edits ? 'Open and watch projects, edit open documents and pick table rows. Saving and runs stay with Claude Code.' : 'Open, create and watch projects. No edits or runs.';
  const contextSections = <>
    <div ref={setContextSlot} className="context-slot" />
    {!feedbackContext && <>
    <section className="context-section">
      <h3 className="caption">Connection</h3>
      <div className="connection-line"><span className={'status-dot ' + phase} /><strong>{phase === 'live' ? 'Up to date' : phase === 'offline' ? 'Offline' + (offlineAt ? ' since ' + clock(offlineAt) : '') : 'Connecting'}</strong><button className="small-button" onClick={reread}>{phase === 'offline' ? 'Reconnect' : 'Refresh'}</button></div>
      <p>{connectionNote}</p>
    </section>
    <section className="context-section">
      <h3 className="caption">This tab</h3>
      <dl><dt>Folder</dt><dd>{connection.root ? (connection.rootLabel ?? connection.root) + ' and below' : 'Set by whoever runs Rho'}</dd><dt>Can</dt><dd>{access}</dd><dt>Expires</dt><dd>{until(connection.expiresAt)}</dd></dl>
      <button ref={disconnectTrigger} className="danger-link" onClick={() => askDisconnect(disconnectTrigger.current)}>Disconnect this tab</button>
    </section>
    <section className="context-section">
      <h3 className="caption">Agents</h3>
      <p className="context-agents">Claude Code and other Agents get access from whoever runs Rho on this machine, not from this page.</p>
    </section>
    </>}
  </>;
  return <div className="application">
    <a className="skip-link" href="#main">Skip to workspace</a>
    <header className="topbar">
      <div className="topbar-lead">{narrow ? <button ref={navigationTrigger} className="icon-button" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={navigation} onClick={() => setNavigation(true)}><Icon name="sidebar" size={18} stroke={1.7} /></button>
        : projectVisible && <button ref={navigationTrigger} className="icon-button" aria-label={'Toggle ' + sidebarName.toLowerCase()} aria-controls="project-navigation" aria-expanded={navigation} onClick={() => setNavigation(v => !v)}><Icon name="sidebar" size={18} stroke={1.7} /></button>}</div>
      {narrow ? <div className="location location-stack">
        <span className="location-name">{screen === 'project' && project ? composition?.compositionId ?? name(project) : screen === 'plugins' ? pluginTitle || 'Plugins' : 'Home'}</span>
        {pluginTitle && <span className="location-detail">Plugins</span>}
        {screen === 'project' && project && <span className="location-detail">{composition ? name(project) : 'Overview'}{!edits && <> · <span title="This tab can open and watch projects. It can't edit or run anything.">Read-only</span></>}</span>}
      </div> : <div className="location">
        {screen === 'project' && project ? <>
          <span className="location-name">{name(project)}</span>
          {composition && screen === 'project' && <> <span className="location-separator" aria-hidden="true">/</span> <span className="location-layout">{composition.compositionId}</span></>}
          {!edits && <>{' '}<span className="read-only" title="This tab can open and watch projects. It can't edit or run anything."><Icon name="lock" size={12} stroke={2} /><span className="read-only-label">Read-only</span></span></>}
        </> : pluginTitle ? <>
          <button className="location-link" onClick={() => choosePlugin('')}>Plugins</button>
          <span className="location-separator" aria-hidden="true"><Icon name="chevron" size={12} stroke={1.6} /></span>
          <span className="location-name">{pluginTitle}</span>
        </> : <span className="location-name">{screen === 'plugins' ? 'Plugins' : 'Home'}</span>}
      </div>}
      <span ref={setMapChip} className="map-chip-slot" />
      <span className={'connection ' + phase} role="status">
        <span className="connection-label">{phase === 'live' ? 'Up to date' : phase === 'offline' ? 'Offline' : 'Connecting'}</span>
        {readAt && <>{' '}<span className="connection-time">{(phase === 'live' ? '' : 'last read ') + clock(readAt)}</span></>}
      </span>
      <button ref={commandTrigger} className="command-trigger" aria-keyshortcuts="Meta+K Control+K" onClick={() => setCommands(true)}>Commands <kbd>{shortcut}</kbd></button>
      <button ref={contextTrigger} className="icon-button context-toggle" aria-label="Context & access" aria-controls={narrow ? undefined : 'project-context'} aria-haspopup={narrow ? 'dialog' : undefined} aria-expanded={context && !feedbackContext} onClick={() => { setFeedbackContext(false); setContext(v => feedbackContext || !v); }}><Icon name="context" size={18} stroke={1.7} /></button>
    </header>
    <div className="app-body">
      <nav className="app-rail" aria-label="Application">
        <Rail name="Home" icon="home" active={screen === 'home'} onClick={() => setScreen('home')} />
        <Rail name="Projects" icon="project" active={screen === 'project'} onClick={() => project ? setScreen('project') : goHome()} />
        <Rail name="Plugins" icon="plugins" active={screen === 'plugins'} onClick={() => project ? plugins() : setScreen('home')} />
      </nav>
      {!narrow && projectVisible && navigation && <aside id="project-navigation" className="project-nav" aria-label={sidebarName}>
        {screen === 'plugins' ? <PluginNavigation catalog={snapshot?.catalog} pluginId={pluginId} onSelect={choosePlugin} /> : <ProjectNavigation project={project} location={located(project, folder)} snapshot={snapshot} overview={screen === 'project' && !composition} compositionId={screen === 'project' ? composition?.compositionId ?? '' : ''}
          onOverview={showOverview} onLayout={layout} onSection={showSection} />}
      </aside>}
      <main id="main" tabIndex={-1} className={projectVisible ? 'main project-main' : 'main'}>
        {screen === 'project' && snapshot?.presentation?.pending && <div className="offline-bar" role="status">
          <p>New output is ready. Its display could not be confirmed; your current views are kept.</p>
          <button className="small-button" onClick={() => showSection('files')}>Show files</button>
        </div>}
        {(phase === 'offline' || reconnecting) && <div className="offline-bar" role="alert">
          <Icon name="offline" size={16} stroke={1.6} />
          <p>{reconnecting ? 'Reconnecting. ' : "Can't reach Rho. "}{seen}</p>
          <button className="small-button" disabled={reconnecting} onClick={reread}>Reconnect</button>
        </div>}
        {screen === 'home' || !project ? <Home client={client!} projects={projects} folder={folder}
          focusRequest={homeFocus} onFocused={() => setHomeFocus(false)} onChoose={chooseProject} onOpened={opened} onAccessEnded={() => end('ended')} />
          : !snapshot ? <div className="page-section"><h1>Reading your project</h1><p>Waiting for a bounded owner snapshot. No runtime is being started.</p></div>
          : screen === 'plugins' ? <PluginCatalog catalog={snapshot.catalog} project={name(project)} pluginId={pluginId} onSelect={choosePlugin}
            back={pluginReturn ? { label: 'Back to ' + name(project), run: () => { setPluginReturn(false); setPluginId(''); setScreen('project'); setMainFocus(true); } } : undefined} />
          : composition ? <Suspense fallback={<p className="page-section">Loading the workspace renderer...</p>}><Workspace key={snapshot.project.id + composition.compositionId} composition={composition} snapshot={snapshot} client={client!} onAbout={about} contextTarget={context ? contextSlot : null} principalId={connection.principalId} feedbackContextActive={feedbackContext} onShowContext={() => { setFeedbackContext(true); setContext(true); }} mapChipTarget={mapChip} openView={openView} /></Suspense>
          : <Suspense fallback={<p className="page-section">Loading the project page…</p>}><ProjectOverview client={client!} onProjectChanged={next => { setProject(next); setProjects(list => list.map(p => p.id === next.id ? next : p)); }} project={project} location={located(project, folder)} snapshot={snapshot} onLayout={layout} onOpened={id => { layout(id); reread(); }} /></Suspense>}
      </main>
      {context && !narrow && <aside id="project-context" className="context-drawer" aria-label={feedbackContext ? 'Your question' : 'Context and access'}>
        <div className="drawer-heading"><h2>{feedbackContext ? 'Your question' : 'Context & access'}</h2><button className="icon-button" aria-label="Close context" onClick={() => { setContext(false); contextTrigger.current?.focus(); }}><Icon name="close" size={14} stroke={2} /></button></div>
        {contextSections}
        {!feedbackContext && <p className="context-footnote">Closing this tab only stops watching. Work that is running keeps running.</p>}
      </aside>}
    </div>
    {narrow && navigation && <Overlay className="drawer" label="Navigation" returnFocus={navigationTrigger} onClose={() => setNavigation(false)}>
      <div className="drawer-top"><strong>Rho</strong><button className="icon-button" aria-label="Close navigation" onClick={() => setNavigation(false)}><Icon name="close" size={16} stroke={1.8} /></button></div>
      <nav className="drawer-sections" aria-label="Application">
        <Rail name="Home" icon="home" active={screen === 'home'} onClick={pick(() => setScreen('home'))} />
        <Rail name="Projects" icon="project" active={screen === 'project'} onClick={pick(() => project ? setScreen('project') : goHome())} />
        <Rail name="Plugins" icon="plugins" active={screen === 'plugins'} onClick={pick(() => project ? plugins() : setScreen('home'))} />
      </nav>
      {projectVisible && <div className="drawer-project">{screen === 'plugins' ? <PluginNavigation catalog={snapshot?.catalog} pluginId={pluginId} onSelect={id => pick(() => choosePlugin(id))()} /> : <ProjectNavigation project={project} location={located(project, folder)} snapshot={snapshot} overview={screen === 'project' && !composition} compositionId={screen === 'project' ? composition?.compositionId ?? '' : ''}
        onOverview={pick(showOverview)} onLayout={id => pick(() => layout(id))()} onSection={next => pick(() => showSection(next))()} />}</div>}
      <div className="drawer-foot"><button className="nav-row" onClick={() => { setNavigation(false); setCommands(true); }}><Icon name="prompt" size={16} stroke={1.8} /><span className="nav-row-name">Commands</span></button></div>
    </Overlay>}
    {narrow && context && <Overlay className="context-sheet" label={feedbackContext ? 'Your question' : 'Context and access'} returnFocus={contextTrigger} onClose={() => setContext(false)}>
      <span className="sheet-handle" aria-hidden="true" />
      <div className="drawer-heading"><h2>{feedbackContext ? 'Your question' : 'Context & access'}</h2><button className="done-button" onClick={() => setContext(false)}>Done</button></div>
      {contextSections}
    </Overlay>}
    <dialog ref={dialog} className="commands" aria-label="Commands" onCancel={() => setCommands(false)} onClose={e => { if (e.currentTarget.open) return; setCommands(false); const next = afterCommands.current; afterCommands.current = null; if (next) next(); else commandReturn()?.focus(); }}
      onClick={e => { if (e.target === e.currentTarget) setCommands(false); }}>
      {commands && <CommandPalette groups={groups} onRun={runCommand} />}
    </dialog>
    <dialog ref={confirmDialog} className="confirm" aria-labelledby="disconnect-title" aria-describedby="disconnect-body" onCancel={() => setConfirming(false)} onClose={() => { setConfirming(false); confirmReturn.current?.focus(); }}>
      <h2 id="disconnect-title">Disconnect this tab?</h2>
      <p id="disconnect-body">This tab stops watching and forgets its access. Your projects and running work don't change. To come back, ask your Agent to open Rho.</p>
      <div className="dialog-actions"><button onClick={() => setConfirming(false)}>Cancel</button><button className="danger" onClick={() => end('disconnected')}>Disconnect</button></div>
    </dialog>
  </div>;
}
// A modal overlay below 768. Focus stays inside; Escape, the backdrop or its own button closes it,
// and focus returns to the button that opened it.
function Overlay({ className, label, returnFocus, onClose, children }: { className: string; label: string; returnFocus: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    return () => { if (dialog.open) dialog.close(); returnFocus.current?.focus(); };
  }, []);
  return <dialog ref={ref} className={className} aria-label={label} onKeyDown={trapTab} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>{children}</dialog>;
}
function Rail({ name, icon, active, onClick }: { name: string; icon: Parameters<typeof Icon>[0]['name']; active: boolean; onClick: () => void }) {
  return <button className={'rail-button' + (active ? ' active' : '')} aria-current={active ? 'page' : undefined} onClick={onClick}><Icon name={icon} /><span>{name}</span></button>;
}
createRoot(document.getElementById('root')!).render(<App />);
