import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserClient, type BrowserConnection, type ProjectSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { Home, located, projectName as name, trapTab } from './home.js';
import { AgentAccess, AgentRequest } from './agents.js';
import { ProjectNavigation, type Section } from './project.js';
import { Icon } from './icons.js';
import { CommandPalette, type Command, type CommandGroup } from './commands.js';
import { PluginCatalog, PluginNavigation } from './plugins.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { shortcut } from './platform.js';
import './theme.css';
import './plugins.css';

const Workspace = lazy(() => import('./shell/workspace.js').then(module => ({ default: module.Workspace })));
const ProjectOverview = lazy(() => import('./overview.js').then(module => ({ default: module.ProjectOverview })));

const sessionKey = 'rho.browser.session.v1', projectKey = 'rho.browser.project.v1';
// Opening this page on this machine is the access: the service answers a same-origin request as
// the local person, so there is no link, code or credential to carry. A narrower, expiring link
// stays available for a shared or subfolder-scoped tab; only then does the fragment hold a code,
// which no request or Referer carries.
const linked = new URLSearchParams(location.hash.slice(1)), linkCode = linked.get('pair');
if (linkCode !== null) history.replaceState(null, '', location.pathname + location.search);
let linkRedeemed = false;
const localConnection: BrowserConnection = { url: location.origin };
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
function App() {
  // The narrowed link this tab uses, if any. Without one the tab is simply the local person.
  const [link, setLink] = useState<BrowserConnection | null>(() => linkCode === null ? restoreSession() : null);
  const connection = link ?? localConnection;
  const client = useMemo(() => new BrowserClient(connection), [link]);
  // A link that could not be used is said once, without taking this machine's access away.
  const [notice, setNotice] = useState(linkCode === null ? '' : 'Using the link in this tab. If it is not accepted, this page falls back to this machine.');
  const [screen, setScreen] = useState<'home' | 'project' | 'plugins'>('home');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  // An open workspace can contribute recorded activity to the optional inspector.
  const [agentSlot, setAgentSlot] = useState<HTMLElement | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [readAt, setReadAt] = useState<Date | null>(null), [offlineAt, setOfflineAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [homeFocus, setHomeFocus] = useState(false), [mainFocus, setMainFocus] = useState(false);
  const [compositionId, setCompositionId] = useState(''), [openView, setOpenView] = useState(''), [overview, setOverview] = useState(false), [section, setSection] = useState<Section>('overview');
  // About from a view opens that plugin and offers the way back to the project.
  const [pluginId, setPluginId] = useState(''), [pluginReturn, setPluginReturn] = useState(false);
  const [context, setContext] = useState(false), [navigation, setNavigation] = useState(true);
  const [feedbackContext, setFeedbackContext] = useState(false);
  // The layout commands the workspace offers for its focused view.
  const [layoutCommands, setLayoutCommands] = useState<CommandGroup | null>(null);
  // A view may place its own section (for example Changes) at the top of the context panel.
  const [contextSlot, setContextSlot] = useState<HTMLDivElement | null>(null);
  const [reconnect, setReconnect] = useState(0), [commands, setCommands] = useState(false), [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), commandTrigger = useRef<HTMLButtonElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null), disconnectTrigger = useRef<HTMLButtonElement>(null), confirmReturn = useRef<HTMLElement | null>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null), contextTrigger = useRef<HTMLButtonElement>(null);
  const agentTrigger = useRef<HTMLButtonElement>(null);

  // Elements behind the open palette are inert, so a command that moves focus waits for it to close.
  const afterCommands = useRef<(() => void) | null>(null);
  const current = useRef(project); current.current = project;
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  function live() { setPhase('live'); setReadAt(new Date()); setOfflineAt(null); }
  function lost(e: unknown) {
    if (accessEnded(e)) { useLocalAccess('That link is no longer valid. This tab uses this machine. Reconnecting only reads again.'); return; }
    setPhase('offline'); setOfflineAt(at => at ?? new Date()); setError(humanError(e));
  }
  function chooseProject(next: ProjectSummary, restoreLayout = false) {
    if (next.id !== project?.id) { setSnapshot(null); setCompositionId(''); setPluginId(''); }
    // The project opens on its own question, not on whichever layout was last open:
    // a person arriving should see what the work is and where it stands.
    if (!restoreLayout) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + next.id);
    const retainedLayout = restoreLayout ? sessionStorage.getItem('rho.layout.v1:' + connection?.principalId + ':' + next.id) : null;
    setSection('overview'); setOverview(!retainedLayout); if (retainedLayout) setCompositionId(retainedLayout); setPluginReturn(false);
    sessionStorage.setItem(projectKey, next.id); setProject(next); setScreen('project');
    if (matchMedia('(max-width: 767px)').matches) setNavigation(false);
  }
  useEffect(() => {
    if (linkCode === null || linkRedeemed) return;
    linkRedeemed = true;
    BrowserClient.pair(location.origin, linkCode).then(next => {
      // No credential is written anywhere except this origin's tab session store.
      sessionStorage.setItem(sessionKey, JSON.stringify(next));
      setNotice(''); setLink(next);
    }).catch(e => setNotice('That link could not be used. This tab uses this machine instead.' + (accessEnded(e) ? '' : ' ' + humanError(e))));
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
  // Between 768 and 1023 a layout needs the width: the project navigation folds away while one
  // is open and comes back with the Overview. The Projects button opens it again.
  const layoutOpen = screen === 'project' && !overview;
  useEffect(() => { if (!narrow && matchMedia('(max-width: 1023px)').matches) setNavigation(!layoutOpen); }, [layoutOpen, narrow]);
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key !== 'Escape' || commands || confirming) return;
      if (context) { setContext(false); contextTrigger.current?.focus(); }
      else if (agentOpen) { setAgentOpen(false); agentTrigger.current?.focus(); }
      else if (narrow && navigation) { setNavigation(false); navigationTrigger.current?.focus(); }
    }
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [context, agentOpen, narrow, navigation, commands, confirming]);
  useEffect(() => {
    if (commands && narrow) { setNavigation(false); setContext(false); }
    if (commands) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close();
  }, [commands]);
  useEffect(() => { if (confirming) confirmDialog.current?.showModal(); else if (confirmDialog.current?.open) confirmDialog.current.close(); }, [confirming]);
  // The sheet leaves with the home page; once it is gone, focus moves to the project instead of the document body.
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
  function showOverview() { setSection('overview'); if (project) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + project.id); setOverview(true); setScreen('project'); }
  function showSection(next: Section) { showOverview(); setScreen('project'); setSection(next); }
  function plugins() { setPluginId(''); setPluginReturn(false); setScreen('plugins'); }
  function about(id: string) { setPluginId(id); setPluginReturn(true); setScreen('plugins'); }
  function goHome() { setScreen('home'); setHomeFocus(true); }
  // A choice in the drawer closes it; focus returns to the navigation button unless the choice moves it.
  const pick = (run: () => void) => () => { run(); if (narrow) setNavigation(false); };
  // Leaving a link keeps the page: the same person at the same machine keeps reading the same
  // folders. Only the tab's credential is forgotten, and nothing is resubmitted.
  function useLocalAccess(message = '') {
    sessionStorage.removeItem(sessionKey); confirmReturn.current = null;
    setLink(null); setNotice(message); setConfirming(false); setError(''); setReconnect(v => v + 1);
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
    // After navigation, so the default choice is never a change to the layout.
    ...(screen === 'project' && composition && layoutCommands ? [layoutCommands] : []),
    { label: 'Connection', commands: [{ id: 'read', label: phase === 'offline' ? 'Reconnect' : 'Refresh', icon: 'refresh', meta: 'Reads again · starts nothing', run: reread }] },
    ...(link ? [{ label: 'This tab', commands: [{ id: 'disconnect', label: "Use this machine's access", icon: 'unlink', danger: true, run: () => askDisconnect(commandReturn()) }] satisfies Command[] }] : []),
  ];
  // Session grants decide the access copy; older read-only sessions keep theirs.
  const edits = link ? !!link.methods?.includes('document.edit') : true, runs = link ? !!link.methods?.includes('action.submit') : true;
  const access = edits ? `Open and watch projects, edit open documents and pick table rows.${runs ? ' Run an action an Agent proposed and stop a run.' : ''} Save documents using the editor.` : 'Open, create and watch projects. No edits or runs.';
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
      <dl>{link && <><dt>Link</dt><dd>{link.root ? (link.rootLabel ?? link.root) + ' and below' : 'Set by whoever runs Rho'}</dd></>}<dt>Can</dt><dd>{access}</dd>{link?.expiresAt && <><dt>Expires</dt><dd>{until(link.expiresAt)}</dd></>}</dl>
      {link
        ? <button ref={disconnectTrigger} className="danger-link" onClick={() => askDisconnect(disconnectTrigger.current)}>Use this machine's access instead</button>
        : <p className="context-note">This tab was opened directly on this machine, so nothing has to be sent to it. The folder is set by whoever runs Rho.</p>}
    </section>
    <section className="context-section">
      <h3 className="caption">Agents</h3>
      <AgentAccess snapshot={projectVisible ? snapshot : null} />
    </section>
    </>}
  </>;
  const navigationContents = <>
    <button className="brand" onClick={goHome} aria-label="Rho home"><span className="brand-mark">ρ</span><strong>Rho</strong></button>
    <button className="project-switcher" onClick={pick(goHome)}><Icon name="folder" size={18} /><span>{project ? name(project) : 'Your projects'}</span><Icon name="chevron" size={13} /></button>
    {project && <>
      {screen === 'plugins' ? <><button className="nav-row" onClick={pick(showOverview)}><Icon name="chevron" size={14} /><span>Back to project</span></button><PluginNavigation catalog={snapshot?.catalog} pluginId={pluginId} onSelect={id => pick(() => choosePlugin(id))()} /></>
      : <ProjectNavigation project={project} location={located(project, folder)} snapshot={snapshot} overview={!composition && screen === 'project'} section={section} compositionId={composition?.compositionId ?? ''}
          onOverview={pick(showOverview)} onLayout={id => pick(() => layout(id))()} onSection={next => pick(() => showSection(next))()} />}
    </>}
    <div className="navigation-footer">
      {project && <button className="nav-row" aria-current={screen === 'plugins' ? 'page' : undefined} onClick={pick(plugins)}><Icon name="plugins" size={17} /><span>Plugins</span></button>}
      <button className="nav-row" onClick={() => { setNavigation(false); setFeedbackContext(false); setContext(true); }}><Icon name="context" size={17} /><span>Connection & access</span></button>
    </div>
  </>;
  const agentContents = <>
    <div className="drawer-heading"><h2>Agent</h2><button className="icon-button" aria-label="Close Agent" onClick={() => { setAgentOpen(false); agentTrigger.current?.focus(); }}><Icon name="close" size={18} /></button></div>
    {snapshot && <AgentRequest key={snapshot.project.id} snapshot={snapshot} principalId={connection.principalId ?? 'local'} />}
    <div ref={setAgentSlot} className="agent-slot" />
    {!composition && <section className="context-section"><h3>Sessions</h3><AgentAccess snapshot={snapshot} /></section>}
  </>;
  const currentTitle = screen === 'home' ? 'Projects' : screen === 'plugins' ? pluginTitle || 'Plugins' : composition?.compositionId ?? ({ overview: 'Overview', files: 'Files', documents: 'Files', activity: 'Activity', settings: 'Project settings' }[section]);
  return <div className="application">
    <a className="skip-link" href="#main">Skip to workspace</a>
    <div className="app-body">
      {!narrow && navigation && <aside className="project-nav" aria-label={sidebarName}>{navigationContents}</aside>}
      <div className="app-content">
        <header className="topbar">
          <button ref={navigationTrigger} className="icon-button" aria-label={navigation ? 'Hide navigation' : 'Open navigation'} aria-expanded={navigation} onClick={() => setNavigation(v => !v)}><Icon name="sidebar" size={19} /></button>
          <div className="location"><span className="location-name">{currentTitle}</span>{!edits && <span className="read-only"><Icon name="lock" size={12} />Read-only</span>}</div>
          <div className="topbar-actions">
            <button ref={commandTrigger} className="command-trigger" aria-label="Commands · Type a command" aria-keyshortcuts="Meta+K Control+K" onClick={() => setCommands(true)}><Icon name="search" size={16} /><span>Commands</span><kbd>{shortcut}</kbd></button>
            <span className={'connection ' + phase} role="status" title={connectionNote}><span className="status-dot" /><span className="connection-label">{phase === 'live' ? 'Connected' : phase === 'offline' ? 'Offline' : 'Connecting'}</span></span>
            {projectVisible && <button ref={agentTrigger} className="agent-toggle" aria-expanded={agentOpen} aria-label="Agent" onClick={() => { setAgentOpen(v => !v); setContext(false); }}><Icon name="prompt" size={17} /><span>Agent</span></button>}
            <button ref={contextTrigger} className="icon-button context-toggle" aria-label="Context & access" aria-expanded={context && !feedbackContext} onClick={() => { setFeedbackContext(false); setContext(v => feedbackContext || !v); setAgentOpen(false); }}><Icon name="context" size={18} /></button>
          </div>
        </header>
        <div className="content-row">
          <main id="main" tabIndex={-1} className={composition && screen === 'project' ? 'main project-main workspace-main' : 'main'}>
            {notice && <div className="offline-bar notice-bar" role="status"><Icon name="info" size={17} /><p>{notice}</p><button onClick={() => setNotice('')}>Dismiss</button></div>}
            {screen === 'project' && snapshot?.presentation?.pending && <div className="offline-bar" role="status"><p>New output is ready. Your current views are kept.</p><button onClick={() => showSection('files')}>Show files</button></div>}
            {(phase === 'offline' || reconnecting) && <div className="offline-bar" role="alert"><Icon name="offline" size={17} /><p>{reconnecting ? 'Reconnecting. ' : "Can't reach Rho. "}{seen}</p><button disabled={reconnecting} onClick={reread}>Reconnect</button></div>}
            {screen === 'home' || !project ? <Home client={client!} projects={projects} folder={folder} focusRequest={homeFocus} onFocused={() => setHomeFocus(false)} onChoose={chooseProject} onOpened={opened} onAccessEnded={() => useLocalAccess('That access has ended. This tab uses this machine.')} />
              : !snapshot ? <Loading text="Opening project…" />
              : screen === 'plugins' ? <PluginCatalog catalog={snapshot.catalog} project={name(project)} pluginId={pluginId} onSelect={choosePlugin} back={pluginReturn ? { label: 'Back to project', run: () => { setPluginReturn(false); setPluginId(''); setScreen('project'); setMainFocus(true); } } : undefined} />
              : composition ? <>
                <div className="workspace-tools"><button className="text-button" onClick={showOverview}><Icon name="chevron" size={13} />Project</button><span className="workspace-question">{snapshot.taskMap?.question ?? name(project)}</span>
                  {layoutCommands && <details className="view-menu"><summary><Icon name="layout" size={15} />Arrange views</summary><div>{layoutCommands.commands.map(c => <button key={c.id} onClick={e => { c.run(); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Icon name={c.icon} size={15} />{c.label}</button>)}</div></details>}
                </div>
                <Suspense fallback={<Loading text="Opening workspace…" />}><Workspace key={snapshot.project.id + composition.compositionId} composition={composition} snapshot={snapshot} client={client!} onAbout={about} contextTarget={context ? contextSlot : null} principalId={connection.principalId} feedbackContextActive={feedbackContext} onShowContext={() => { setFeedbackContext(true); setContext(true); setAgentOpen(false); }} openView={openView} onCommands={setLayoutCommands} agentTarget={agentOpen ? agentSlot : null} onShowAgent={() => setAgentOpen(true)} /></Suspense>
              </> : <Suspense fallback={<Loading text="Opening project…" />}><ProjectOverview key={project.id} section={section} onSection={showSection} onAgent={() => setAgentOpen(true)} client={client!} onProjectChanged={next => { setProject(next); setProjects(list => list.map(p => p.id === next.id ? next : p)); }} project={project} location={located(project, folder)} snapshot={snapshot} onLayout={layout} onOpened={id => { layout(id); reread(); }} /></Suspense>}
          </main>
          {projectVisible && agentOpen && !narrow && <aside className="inspector-pane" aria-label="Agent panel">{agentContents}</aside>}
          {context && !narrow && <aside id="project-context" className="context-drawer inspector-pane" aria-label={feedbackContext ? 'Your question' : 'Context and access'}><div className="drawer-heading"><h2>{feedbackContext ? 'Your question' : 'Connection & access'}</h2><button className="icon-button" aria-label="Close context" onClick={() => { setContext(false); contextTrigger.current?.focus(); }}><Icon name="close" size={18} /></button></div>{contextSections}</aside>}
        </div>
      </div>
    </div>
    {narrow && navigation && <Overlay className="drawer" label="Navigation" returnFocus={navigationTrigger} onClose={() => setNavigation(false)}><button className="icon-button drawer-close" aria-label="Close navigation" onClick={() => setNavigation(false)}><Icon name="close" size={18} /></button>{navigationContents}</Overlay>}
    {narrow && agentOpen && <Overlay className="context-sheet" label="Agent panel" returnFocus={agentTrigger} onClose={() => setAgentOpen(false)}>{agentContents}</Overlay>}
    {narrow && context && <Overlay className="context-sheet" label={feedbackContext ? 'Your question' : 'Context and access'} returnFocus={contextTrigger} onClose={() => setContext(false)}><div className="drawer-heading"><h2>{feedbackContext ? 'Your question' : 'Connection & access'}</h2><button className="done-button" onClick={() => setContext(false)}>Done</button></div>{contextSections}</Overlay>}
    <dialog ref={dialog} className="commands" aria-label="Commands" onCancel={() => setCommands(false)} onClose={e => { if (e.currentTarget.open) return; setCommands(false); const next = afterCommands.current; afterCommands.current = null; if (next) next(); else commandReturn()?.focus(); }} onClick={e => { if (e.target === e.currentTarget) setCommands(false); }}>{commands && <CommandPalette groups={groups} onRun={runCommand} />}</dialog>
    <dialog ref={confirmDialog} className="confirm" aria-labelledby="disconnect-title" aria-describedby="disconnect-body" onCancel={() => setConfirming(false)} onClose={() => { setConfirming(false); confirmReturn.current?.focus(); }}>
      <h2 id="disconnect-title">Use this machine's access?</h2><p id="disconnect-body">This tab stops using its link and keeps working as this machine. Open projects, unsaved edits and running work are unchanged.</p><div className="dialog-actions"><button onClick={() => setConfirming(false)}>Cancel</button><button className="danger" onClick={() => useLocalAccess('This tab now uses this machine.')}>Use this machine</button></div>
    </dialog>
  </div>;
}
function Loading({ text }: { text: string }) { return <div className="loading-state" role="status"><span className="loading-dot" /><span>{text}</span></div>; }

// A modal overlay below 768. Focus stays inside; Escape, the backdrop or its own button closes it,
// and focus returns to the button that opened it.
function Overlay({ className, label, returnFocus, onClose, children }: { className: string; label: string; returnFocus: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    // Portalled owner content follows a different React ancestor. Trap actual DOM keys
    // so its last focusable control stays inside this modal too.
    dialog.addEventListener('keydown', trapTab);
    return () => { dialog.removeEventListener('keydown', trapTab); if (dialog.open) dialog.close(); returnFocus.current?.focus(); };
  }, []);
  return <dialog ref={ref} className={className} aria-label={label} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>{children}</dialog>;
}
createRoot(document.getElementById('root')!).render(<App />);
