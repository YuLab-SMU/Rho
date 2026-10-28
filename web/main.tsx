import { lazy, Fragment, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserClient, type BrowserConnection, type ProjectSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { Home, projectHue, projectName as name, trapTab } from './home.js';
import { AgentAccess, AgentRequest } from './agents.js';
import { AgentConversation } from './conversation.js';
import { ProjectNavigation, sourceLabels, type Section, type SourceRow } from './project.js';
import { capturable, sourceItems, useProjectFiles, type SourceItem } from './sources.js';
import { useAgentNow, type AgentNow } from './agent-now.js';
import { compositionName, defaultWorkspace, fileKey, openInWorkspace } from './canvas.js';
import { Icon } from './icons.js';
import { CommandPalette, type Command, type CommandGroup } from './commands.js';
import { PluginCatalog, PluginNavigation } from './plugins.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { shortcut } from './platform.js';
import './theme.css';
import './plugins.css';

const Workspace = lazy(() => import('./shell/workspace.js').then(module => ({ default: module.Workspace })));
const ProjectOverview = lazy(() => import('./overview.js').then(module => ({ default: module.ProjectOverview })));
const FilePreview = lazy(() => import('./preview.js').then(module => ({ default: module.FilePreview })));
const WorkGraph = lazy(() => import('./graph.js').then(module => ({ default: module.WorkGraph })));

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
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  // An open workspace can contribute recorded activity to the optional inspector.
  const [agentSlot, setAgentSlot] = useState<HTMLElement | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [readAt, setReadAt] = useState<Date | null>(null), [offlineAt, setOfflineAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [homeFocus, setHomeFocus] = useState(false), [mainFocus, setMainFocus] = useState(false);
  const [compositionId, setCompositionId] = useState(''), [openView, setOpenView] = useState(''), [openFollowed, setOpenFollowed] = useState(false), [overview, setOverview] = useState(false), [section, setSection] = useState<Section>('overview');
  // About from a view opens that plugin and offers the way back to the project.
  const [pluginId, setPluginId] = useState(''), [pluginReturn, setPluginReturn] = useState(false);
  const [context, setContext] = useState(false), [navigation, setNavigation] = useState(true);
  const [feedbackContext, setFeedbackContext] = useState(false);
  const [category, setCategory] = useState<SourceRow>('data'), [addingSource, setAddingSource] = useState(false);
  // The file shown in place from Sources, by its kind and its key in that kind's list.
  const [shownFile, setShownFile] = useState<{ row: SourceRow; key: string } | null>(null);
  // Following: what the Agent reads and changes opens in the workspace the person shares with
  // it and is brought forward there. It starts when the person sends a message here or asks to
  // follow, and stops when they go somewhere else themselves. The Graph follows the same turn.
  const [following, setFollowing] = useState(false), [followNote, setFollowNote] = useState('');
  const followingNow = useRef(false); followingNow.current = following;
  const followTarget = useRef(defaultWorkspace);
  // The layout commands the workspace offers for its focused view.
  const [layoutCommands, setLayoutCommands] = useState<CommandGroup | null>(null);
  // A view may place its own section (for example Changes) at the top of the context panel.
  const [contextSlot, setContextSlot] = useState<HTMLDivElement | null>(null);
  const [reconnect, setReconnect] = useState(0), [commands, setCommands] = useState(false), [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), commandTrigger = useRef<HTMLButtonElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null), disconnectTrigger = useRef<HTMLButtonElement>(null), confirmReturn = useRef<HTMLElement | null>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null), contextTrigger = useRef<HTMLButtonElement>(null);
  const agentTrigger = useRef<HTMLButtonElement>(null);
  // Closing the Agent panel returns focus to the button that shows it: the sidebar's, or the topbar's while the sidebar is hidden.
  const agentReturn = () => (agentTrigger.current ?? document.querySelector<HTMLButtonElement>('.project-nav .nav-panel'))?.focus();

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
    if (next.id !== project?.id) { setSnapshot(null); setCompositionId(''); setPluginId(''); setFollowing(false); setFollowNote(''); }
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
      else if (agentOpen) { setAgentOpen(false); agentReturn(); }
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
  // A view brought while following only changes what is shown; one the person opens is held.
  function place(id: string, view?: string, followed = false) { if (project) { sessionStorage.setItem('rho.layout.v1:' + connection?.principalId + ':' + project.id, id); sessionStorage.setItem(workspaceKey(project.id), id); } setCompositionId(id); setOpenView(view ?? ''); setOpenFollowed(followed); setOverview(false); setScreen('project'); }
  // A workspace the person opens is their choice; following goes on only in the one it follows into.
  function layout(id: string, view?: string) { if (id !== followTarget.current) setFollowing(false); place(id, view); }
  // The workspace the person and the Agent share in this tab: the one on screen, the one last
  // open here, the first, or a new one.
  const workspaceKey = (projectId: string) => 'rho.workspace.v1:' + connection?.principalId + ':' + projectId;
  function sharedWorkspace() {
    if (screen === 'project' && !overview && (composition?.compositionId ?? compositionId)) return composition?.compositionId ?? compositionId;
    const list = snapshot?.compositions ?? [], kept = project ? sessionStorage.getItem(workspaceKey(project.id)) : null;
    return list.find(c => c.compositionId === kept)?.compositionId ?? list[0]?.compositionId ?? defaultWorkspace;
  }
  function showOverview() { setFollowing(false); setSection('overview'); if (project) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + project.id); setOverview(true); setScreen('project'); }
  function showSection(next: Section) { showOverview(); setScreen('project'); setSection(next); }
  // The Graph keeps following the Agent's turn; the workspace keeps receiving its files.
  function showGraph() { const was = following; showSection('graph'); if (was) setFollowing(true); }
  function showSources(next: SourceRow) { setCategory(next); showSection('sources'); }
  function showFile(row: SourceRow, item: SourceItem) { setShownFile({ row, key: item.key }); setCategory(row); showSection('file'); }
  // A file the Agent named: shown in place among its kind, or in the workspace when it has no kind.
  function showPath(path: string) {
    for (const row of ['results', 'data', 'code', 'notes'] as const) {
      const item = sources?.[row].find(entry => entry.path === path);
      if (item) { showFile(row, item); return; }
    }
    if (!snapshot) return;
    openInWorkspace(client, snapshot, sharedWorkspace(), path).then(placed => placed ? layout(placed.compositionId, placed.viewId) : setNotice(path + ' · Rho has no viewer for this kind of file yet.'),
      error => setNotice(path + ' · ' + (error instanceof Error ? error.message : 'It could not be opened.')));
  }
  // The Agent panel, ready for a new conversation or showing the one chosen.
  function talk(conversationId = 'new') { setSelectedConversation(conversationId); setAgentOpen(true); setContext(false); }
  // Studio opens the workspace last open here, or the first one.
  function studio() { layout(sharedWorkspace()); }
  // Following from the Graph stays on the Graph; anywhere else it brings the shared workspace.
  function follow() {
    const target = sharedWorkspace();
    followTarget.current = target; setFollowing(true); setFollowNote('');
    if (!(screen === 'project' && overview && section === 'graph')) place(target, shownView.current, true);
  }
  function plugins() { setFollowing(false); setPluginId(''); setPluginReturn(false); setScreen('plugins'); }
  function about(id: string) { setPluginId(id); setPluginReturn(true); setScreen('plugins'); }
  function goHome() { setFollowing(false); setScreen('home'); setHomeFocus(true); }
  async function addSource() {
    if (!project) return;
    setAddingSource(true);
    try { const result = await client.call('project.source.add', { projectId: project.id }, new AbortController().signal); if (result.project) { setProject(result.project); setProjects(list => list.map(p => p.id === result.project!.id ? result.project! : p)); files.refresh(); } }
    catch (e) { setNotice(e instanceof Error ? e.message : 'The folder could not be added.'); }
    finally { setAddingSource(false); }
  }
  // A choice in the drawer closes it; focus returns to the navigation button unless the choice moves it.
  const pick = (run: () => void) => () => { run(); if (narrow) setNavigation(false); };
  // Leaving a link keeps the page: the same person at the same machine keeps reading the same
  // folders. Only the tab's credential is forgotten, and nothing is resubmitted.
  function useLocalAccess(message = '') {
    sessionStorage.removeItem(sessionKey); confirmReturn.current = null;
    setLink(null); setNotice(message); setConfirming(false); setError(''); setReconnect(v => v + 1);
  }
  // The workspace followed into may be asked for before its first view exists; Studio then shows it empty.
  const composition = overview ? undefined : snapshot?.compositions.find(c => c.compositionId === compositionId) ?? (compositionId === followTarget.current || compositionId === defaultWorkspace ? undefined : snapshot?.compositions[0]);
  const studioOpen = screen === 'project' && !overview;
  const files = useProjectFiles(client, project && screen !== 'home' ? project.id : undefined, snapshot?.cursor);
  const agentNow = useAgentNow(client, project && snapshot?.project.id === project.id ? snapshot : null);
  const shownView = useRef('');
  // Each file the Agent's running turn names is opened in the shared workspace once: a read as
  // soon as it is reported, an edit or a write once it returned, so the workspace shows the new text.
  const followed = useRef(new Set<string>());
  useEffect(() => { followed.current.clear(); }, [project?.id, agentNow?.conversationId]);
  useEffect(() => {
    if (!following || !snapshot || !agentNow?.running) return;
    const fresh = agentNow.files.filter(f => !followed.current.has(f.key + ':' + f.path) && (f.action === 'read' ? f.outcome !== 'rejected' : f.outcome === 'returned'));
    for (const file of fresh.slice(-6)) {
      followed.current.add(file.key + ':' + file.path);
      openInWorkspace(client, snapshot, followTarget.current, file.path).then(placed => {
        // A command may name a file it removed or never made; only what exists is shown.
        if (!placed) { if (file.action !== 'run') setFollowNote(`${file.verb} ${file.path} · Rho has no viewer for this kind of file yet.`); return; }
        setFollowNote('');
        shownView.current = placed.viewId;
        bringForward(placed.compositionId, placed.viewId);
      }, error => { if (file.action !== 'run') setFollowNote(`${file.verb} ${file.path} · ${error instanceof Error ? error.message : 'It could not be opened.'}`); });
    }
  }, [following, agentNow, snapshot?.project.id]);
  // Outputs that appear or change on disk while a turn runs are shown too, whether or not a
  // step named them: the walk observes the folder, it does not say who wrote the file. The
  // walk after the turn ends is included, since the last outputs often land just then.
  const outputs = useRef<{ conversationId: string; sizes: Map<string, number>; endedAt: number; done: boolean } | null>(null);
  useEffect(() => {
    if (!agentNow || !snapshot) return;
    const sizes = new Map(files.files.map(f => [f.path, f.bytes]));
    const seen = outputs.current;
    if (agentNow.running && (!seen || seen.conversationId !== agentNow.conversationId || seen.done || seen.endedAt)) { outputs.current = { conversationId: agentNow.conversationId, sizes, endedAt: 0, done: false }; return; }
    if (!seen || seen.done || seen.conversationId !== agentNow.conversationId) return;
    if (!agentNow.running) {
      if (!seen.endedAt) seen.endedAt = Date.now();
      else if (files.readAt > seen.endedAt) seen.done = true;
    }
    if (following && files.readAt) {
      const changed = files.files.filter(f => (f.category === 'figures' || f.category === 'results') && capturable(f.path) && seen.sizes.get(f.path) !== f.bytes);
      for (const file of changed.slice(-4)) openInWorkspace(client, snapshot, followTarget.current, file.path).then(placed => {
        if (!placed) return;
        shownView.current = placed.viewId;
        bringForward(placed.compositionId, placed.viewId);
      }, () => undefined);
    }
    seen.sizes = sizes;
  }, [files.readAt, agentNow?.running, agentNow?.conversationId]);
  // A followed view comes forward in the workspace; on the Graph the person stays where they are.
  const onGraph = useRef(false); onGraph.current = screen === 'project' && overview && section === 'graph';
  function bringForward(id: string, view: string) { if (followingNow.current && !onGraph.current) place(id, view, true); }
  // Where the Agent is in the workspace now: the view of the file its newest action named.
  const presence = useMemo(() => agentPresence(agentNow, snapshot, composition), [agentNow, snapshot, composition]);
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
  // Each kind's files, from the last walk; results also list registered results.
  const sources = useMemo(() => project && files.readAt ? Object.fromEntries((['data', 'code', 'results', 'notes'] as const).map(row => [row, sourceItems(row, files.files, snapshot?.resources ?? [], project, snapshot?.operations)])) as Record<SourceRow, SourceItem[]> : null,
    [files.files, files.readAt, snapshot?.resources, snapshot?.operations, project?.id, project?.root, project?.sources]);
  const fileOnScreen = section === 'file' && shownFile ? sources?.[shownFile.row].find(item => item.key === shownFile.key) : undefined;
  const here = screen === 'plugins' ? 'plugins' : screen !== 'project' ? '' : studioOpen ? 'studio:' + (composition?.compositionId ?? compositionId) : section === 'sources' ? 'sources:' + category : section === 'file' && shownFile ? 'file:' + shownFile.row + ':' + shownFile.key : section === 'documents' ? 'files' : section;
  const initials = project ? name(project).split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map(w => [...w][0]!.toUpperCase()).join('') || 'P' : '';
  const navigationContents = <>
    {project ? <>
      <button className="nav-back" onClick={pick(goHome)}><Icon name="back" size={15} /><span>All projects</span></button>
      <details className="project-card">
        <summary aria-label={'Project ' + name(project) + '. Switch project'}><span className={'project-avatar ' + projectHue(project.id + name(project))} aria-hidden="true">{initials}</span><span className="project-card-name"><small>Project</small><strong>{name(project)}</strong></span><Icon name="updown" size={16} /></summary>
        <div className="project-menu" role="group" aria-label="Switch project">
          {projects.filter(p => p.id !== project.id).slice(0, 8).map(p => <button key={p.id} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); pick(() => chooseProject(p))(); }}><span className={'project-avatar small ' + projectHue(p.id + name(p))} aria-hidden="true">{name(p).slice(0, 1).toUpperCase()}</span><span>{name(p)}</span></button>)}
          <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); pick(goHome)(); }}><Icon name="folder" size={16} /><span>All projects…</span></button>
        </div>
      </details>
      {screen === 'plugins' ? <><button className="nav-row" onClick={pick(showOverview)}><Icon name="back" size={14} /><span>Back to project</span></button><PluginNavigation catalog={snapshot?.catalog} pluginId={pluginId} onSelect={id => pick(() => choosePlugin(id))()} /></>
      : <ProjectNavigation project={project} snapshot={snapshot} current={here} sources={sources} partial={files.truncated}
          agent={{ running: !!agentNow?.running, waiting: !!agentNow?.waiting, conversations: snapshot?.conversations?.length ?? 0 }} agentOpen={agentOpen} adding={addingSource}
          onOverview={pick(showOverview)} onStudio={pick(studio)} onAgentPanel={pick(() => { setAgentOpen(v => !v); setContext(false); })} onLayout={id => pick(() => layout(id))()}
          onSection={next => pick(() => next === 'graph' ? showGraph() : showSection(next))()} onSources={next => pick(() => showSources(next))()} onFile={(row, item) => pick(() => showFile(row, item))()} onAddSource={() => void addSource()} />}
    </> : <>
      <button className="brand" onClick={goHome} aria-label="Rho home"><span className="brand-mark">ρ</span><strong>Rho</strong></button>
      <button className="project-switcher" onClick={pick(goHome)}><Icon name="folder" size={18} /><span>Your projects</span><Icon name="chevron" size={13} /></button>
    </>}
    <div className="navigation-footer">
      {project && <button className="nav-row" aria-current={screen === 'project' && overview && section === 'settings' ? 'page' : undefined} onClick={pick(() => showSection('settings'))}><Icon name="context" size={17} /><span>Project settings</span></button>}
      {project && <button className="nav-row" aria-current={screen === 'plugins' ? 'page' : undefined} onClick={pick(plugins)}><Icon name="plugins" size={17} /><span>Plugins</span></button>}
      <button className="nav-row" onClick={() => { setNavigation(false); setFeedbackContext(false); setContext(true); }}><Icon name="context" size={17} /><span>Connection & access</span></button>
    </div>
  </>;
  const agentContents = <>
    <div className="drawer-heading"><h2>Agent</h2><button className="icon-button" aria-label="Close Agent" onClick={() => { setAgentOpen(false); agentReturn(); }}><Icon name="close" size={18} /></button></div>
    {snapshot && (link ? <AgentRequest key={snapshot.project.id} snapshot={snapshot} principalId={connection.principalId ?? 'local'} />
      : <AgentConversation key={snapshot.project.id} snapshot={snapshot} client={client} selectedId={selectedConversation} onSelected={() => setSelectedConversation(null)} onSent={follow} />)}
    <div ref={setAgentSlot} className="agent-slot" />
  </>;
  // Where this tab is: the projects list, then the project, then the open workspace. The page
  // heading names the section itself, so the trail carries only the path back.
  const crumbs: Array<{ label: string; run?: () => void }> = !project || screen === 'home' ? [{ label: 'Projects' }]
    : screen === 'plugins' ? [{ label: 'Projects', run: goHome }, { label: name(project), run: showOverview }, { label: pluginTitle || 'Plugins' }]
    : studioOpen ? [{ label: 'Projects', run: goHome }, { label: name(project), run: showOverview }, { label: compositionName(composition?.compositionId ?? compositionId) }]
    : section === 'file' && shownFile ? [{ label: 'Projects', run: goHome }, { label: name(project), run: showOverview }, { label: sourceLabels[shownFile.row], run: () => showSources(shownFile.row) }, { label: fileOnScreen?.name ?? shownFile.key.split('/').at(-1)! }]
    : [{ label: 'Projects', run: goHome }, { label: name(project) }];
  const shownId = composition?.compositionId ?? compositionId;
  const studioList = [...(snapshot?.compositions ?? [])];
  if (studioOpen && shownId && !studioList.some(c => c.compositionId === shownId)) studioList.unshift({ compositionId: shownId, views: [] } as unknown as typeof studioList[number]);
  const followingHere = following && shownId === followTarget.current;
  return <div className="application">
    <a className="skip-link" href="#main">Skip to workspace</a>
    <div className="app-body">
      {!narrow && navigation && <aside className="project-nav" aria-label={sidebarName}>{navigationContents}</aside>}
      <div className="app-content">
        <header className="topbar">
          <button ref={navigationTrigger} className="icon-button" aria-label={navigation ? 'Hide navigation' : 'Open navigation'} aria-expanded={navigation} onClick={() => setNavigation(v => !v)}><Icon name="sidebar" size={19} /></button>
          <nav className="location" aria-label="Location">
            {crumbs.map((crumb, index) => <Fragment key={crumb.label + index}>
              {index > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
              {index === crumbs.length - 1 ? <span className="location-name" aria-current="page">{crumb.label}</span>
                : <button className="crumb" onClick={crumb.run}>{crumb.label}</button>}
            </Fragment>)}
            {!edits && <span className="read-only"><Icon name="lock" size={12} />Read-only</span>}
          </nav>
          <div className="topbar-actions">
            {projectVisible && agentNow?.running && <button className={'agent-chip ' + (agentNow.waiting ? 'waiting' : 'working')} title={agentNow.title}
              onClick={() => { if (agentNow.waiting) { setAgentOpen(true); setContext(false); } else follow(); }}>
              <span className="pulse-dot" aria-hidden="true" /><strong>{agentNow.waiting ? 'Needs your choice' : agentNow.agent}</strong><span className="agent-chip-what">{agentNow.waiting ?? doing(agentNow, project?.root)}</span></button>}
            <button ref={commandTrigger} className="command-trigger" aria-label="Commands · Type a command" aria-keyshortcuts="Meta+K Control+K" onClick={() => setCommands(true)}><Icon name="search" size={16} /><span>Commands</span><kbd>{shortcut}</kbd></button>
            <span className={'connection ' + phase} role="status" title={connectionNote}><span className="status-dot" /><span className="connection-label">{phase === 'live' ? 'Connected' : phase === 'offline' ? 'Offline' : 'Connecting'}</span></span>
            {/* With the sidebar in view its Agent row holds the panel button; this one stands in while the sidebar is not shown. */}
            {projectVisible && (narrow || !navigation) && <button ref={agentTrigger} className="agent-toggle" aria-expanded={agentOpen} aria-label="Agent panel" onClick={() => { setAgentOpen(v => !v); setContext(false); }}><Icon name="spark" size={17} /><span>Agent</span></button>}
            <button ref={contextTrigger} className="icon-button context-toggle" aria-label="Context & access" aria-expanded={context && !feedbackContext} onClick={() => { setFeedbackContext(false); setContext(v => feedbackContext || !v); setAgentOpen(false); }}><Icon name="context" size={18} /></button>
          </div>
        </header>
        <div className="content-row">
          <main id="main" tabIndex={-1} className={(studioOpen || (screen === 'project' && (section === 'file' || section === 'graph'))) && snapshot ? 'main project-main workspace-main' : 'main'}>
            {notice && <div className="offline-bar notice-bar" role="status"><Icon name="info" size={17} /><p>{notice}</p><button onClick={() => setNotice('')}>Dismiss</button></div>}
            {screen === 'project' && snapshot?.presentation?.pending && <div className="offline-bar" role="status"><p>New output is ready. Your current views are kept.</p><button onClick={() => showSection('files')}>Show files</button></div>}
            {(phase === 'offline' || reconnecting) && <div className="offline-bar" role="alert"><Icon name="offline" size={17} /><p>{reconnecting ? 'Reconnecting. ' : "Can't reach Rho. "}{seen}</p><button disabled={reconnecting} onClick={reread}>Reconnect</button></div>}
            {screen === 'home' || !project ? <Home client={client!} projects={projects} folder={folder} focusRequest={homeFocus} onFocused={() => setHomeFocus(false)} onChoose={chooseProject} onOpened={opened} onAccessEnded={() => useLocalAccess('That access has ended. This tab uses this machine.')} />
              : !snapshot ? <Loading text="Opening project…" />
              : screen === 'plugins' ? <PluginCatalog catalog={snapshot.catalog} project={name(project)} pluginId={pluginId} onSelect={choosePlugin} back={pluginReturn ? { label: 'Back to project', run: () => { setPluginReturn(false); setPluginId(''); setScreen('project'); setMainFocus(true); } } : undefined} />
              : studioOpen ? <>
                <div className="studio-bar">
                  <nav className="studio-tabs" aria-label="Workspaces">
                    {studioList.map(c => <button key={c.compositionId} className="studio-tab" aria-current={c.compositionId === shownId ? 'page' : undefined} onClick={() => layout(c.compositionId)}>
                      <span>{compositionName(c.compositionId)}</span><small>{c.views.length ? c.views.length + (c.views.length === 1 ? ' view' : ' views') : 'empty'}</small></button>)}
                  </nav>
                  {agentNow?.running && (followingHere
                    ? <button className="follow-toggle on" aria-pressed="true" title="Files the Agent reads and changes open here. Choosing another view stops following." onClick={() => setFollowing(false)}><span className="pulse-dot" aria-hidden="true" />Following {agentNow.agent}</button>
                    : <button className="follow-toggle" aria-pressed="false" title="Open the files the Agent reads and changes in this workspace as it goes." onClick={follow}><Icon name="follow" size={15} />Follow {agentNow.agent}</button>)}
                  {composition && layoutCommands && <details className="view-menu"><summary><Icon name="layout" size={15} />Arrange views</summary><div>{layoutCommands.commands.map(c => <button key={c.id} onClick={e => { c.run(); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Icon name={c.icon} size={15} />{c.label}</button>)}</div></details>}
                </div>
                {followingHere && followNote && <div className="canvas-note" role="status"><p>{followNote}</p><button className="small-button" onClick={() => setFollowNote('')}>Dismiss</button></div>}
                {composition ? <Suspense fallback={<Loading text="Opening workspace…" />}><Workspace key={snapshot.project.id + composition.compositionId} composition={composition} snapshot={snapshot} client={client!} onAbout={about} contextTarget={context ? contextSlot : null} principalId={connection.principalId} feedbackContextActive={feedbackContext} onShowContext={() => { setFeedbackContext(true); setContext(true); setAgentOpen(false); }} openView={openView} onCommands={setLayoutCommands} agentTarget={agentOpen ? agentSlot : null} onShowAgent={() => setAgentOpen(true)}
                    presence={presence} onPersonMoved={() => setFollowing(false)} attention={false} following={followingHere && openFollowed} /></Suspense>
                  : <StudioEmpty root={project.root} agent={agentNow} following={followingHere} onAgent={() => { setAgentOpen(true); setContext(false); }} onFiles={() => showSources('data')} />}
              </> : section === 'file' && shownFile ? (fileOnScreen ? <Suspense fallback={<Loading text="Opening file…" />}><FilePreview client={client!} snapshot={snapshot} item={fileOnScreen} items={sources![shownFile.row]} kind={sourceLabels[shownFile.row]} principalId={connection.principalId} workspace={sharedWorkspace}
                  onMove={item => showFile(shownFile.row, item)} onStudio={layout} onList={() => showSources(shownFile.row)} onAbout={about} /></Suspense>
                : !sources ? <Loading text="Reading the project folders…" />
                : <div className="studio-empty"><span className="empty-symbol"><Icon name="file" size={26} stroke={1.5} /></span><h2>This file is no longer in the project</h2><p>{shownFile.key.replace(/^\w+:/, '')} was not found when the folders were last read. It may have been moved or removed.</p><div className="empty-actions"><button onClick={() => showSources(shownFile.row)}>All {sourceLabels[shownFile.row].toLowerCase()}</button></div></div>)
              : section === 'graph' ? <Suspense fallback={<Loading text="Opening the graph…" />}><WorkGraph client={client!} snapshot={snapshot} files={files} agentNow={agentNow} following={following} principalId={connection.principalId}
                  onFollow={follow} onStopFollowing={() => setFollowing(false)} onStudio={layout} workspace={sharedWorkspace} onAbout={about} onAgent={id => { if (id) setSelectedConversation(id); setAgentOpen(true); setContext(false); }} /></Suspense>
              : <Suspense fallback={<Loading text="Opening project…" />}><ProjectOverview key={project.id} section={section} workspace={sharedWorkspace} category={category} files={files} sources={sources} onFile={showFile} linked={!!link} onPath={showPath} onNewConversation={() => talk()} onSection={showSection} onAgent={id => { if (id) setSelectedConversation(id); setAgentOpen(true); }} client={client!} onProjectChanged={next => { setProject(next); setProjects(list => list.map(p => p.id === next.id ? next : p)); }} project={project} snapshot={snapshot} onLayout={layout} onOpened={(id, view) => { layout(id, view); reread(); }} /></Suspense>}
          </main>
          {projectVisible && agentOpen && !narrow && <SidePanel label="Agent panel">{agentContents}</SidePanel>}
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
// The newest thing the Agent reported doing, in the words the Agent panel uses.
// Paths inside the project read as the project names them.
function doing(now: AgentNow, root?: string) {
  if (!now.latest) return 'Answering';
  let text = [now.latest.verb, now.latest.target].filter(Boolean).join(' ');
  if (root) text = text.split(root.replace(/\/+$/, '') + '/').join('').split(root.replace(/\/+$/, '')).join('.');
  return text;
}
// While a turn runs, the view of the last file the Agent's actions named, in the workspace
// on screen. It is live while that action is the newest one and still running.
function agentPresence(now: AgentNow | null, snapshot: WorkspaceSnapshot | null, composition?: WorkspaceSnapshot['compositions'][number]) {
  const file = now?.files.at(-1);
  if (!now?.running || !snapshot || !composition || !file) return null;
  const document = snapshot.documents.find(d => d.path === file.path), key = fileKey(file.path);
  const view = composition.views.find(v => v.id.startsWith(key)
    || (!!document && Object.values(v.bindings ?? {}).some(b => (b as { documentId?: unknown }).documentId === document.id)));
  if (!view) return null;
  const live = file.outcome === 'requested' && now.latest?.key === file.key;
  const label = file.action === 'read' ? (live ? 'Reading' : 'Read') : file.action === 'edit' ? (live ? 'Editing' : 'Edited') : file.action === 'run' ? (live ? 'Running' : 'Ran') : (live ? 'Writing' : 'Wrote');
  return { viewId: view.id, label: `${now.agent} · ${label} ${file.path}`, verb: label, live };
}
// A workspace before anything is open in it says what will appear there.
function StudioEmpty({ root, agent, following, onAgent, onFiles }: { root: string; agent: AgentNow | null; following: boolean; onAgent: () => void; onFiles: () => void }) {
  const working = !!agent?.running;
  return <div className="studio-empty">
    <span className="empty-symbol">{working ? <span className="pulse-dot large" aria-hidden="true" /> : <Icon name="layout" size={26} stroke={1.5} />}</span>
    <h2>{working ? `${agent!.agent} is working` : 'Nothing open in this workspace yet'}</h2>
    <p>{working ? (following ? `Files it reads or changes open here as it goes. Now: ${doing(agent!, root)}.` : `Now: ${doing(agent!, root)}.`) : 'Files the Agent reads or changes open here while you follow it. You can also open files from Sources.'}</p>
    <div className="empty-actions"><button className={working ? undefined : 'primary'} onClick={onAgent}><Icon name="prompt" size={17} stroke={1.6} /><span>{working ? 'Show conversation' : 'Ask Agent'}</span></button><button onClick={onFiles}><Icon name="table" size={17} stroke={1.6} /><span>Browse data</span></button></div>
  </div>;
}
function Loading({ text }: { text: string }) { return <div className="loading-state" role="status"><span className="loading-dot" /><span>{text}</span></div>; }

// The Agent panel's width, set by dragging its edge or with the arrow keys on it. It is this
// viewer's own preference, kept in this browser only.
const panelWidths = { min: 280, max: 760, initial: 340, step: 24 };
const panelKey = 'rho.agentPanel.width.v1';
function readWidth() { try { const value = Number(localStorage.getItem(panelKey)); return value >= panelWidths.min ? value : panelWidths.initial; } catch { return panelWidths.initial; } }
function SidePanel({ label, children }: { label: string; children: ReactNode }) {
  const [width, setWidth] = useState(readWidth);
  const widest = () => Math.max(panelWidths.min, Math.min(panelWidths.max, Math.round(innerWidth * 0.6)));
  const set = (value: number) => { const next = Math.round(Math.min(widest(), Math.max(panelWidths.min, value))); setWidth(next); try { localStorage.setItem(panelKey, String(next)); } catch {} };
  function drag(event: ReactPointerEvent<HTMLDivElement>) {
    const handle = event.currentTarget, start = event.clientX, from = width;
    handle.setPointerCapture(event.pointerId); document.body.dataset.resizing = 'col';
    const move = (e: PointerEvent) => set(from + start - e.clientX);
    const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop); delete document.body.dataset.resizing; };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
  }
  const shown = Math.min(width, widest());
  return <aside className="inspector-pane side-panel" aria-label={label} style={{ flexBasis: shown, width: shown }}>
    <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label={'Resize ' + label} tabIndex={0} aria-valuemin={panelWidths.min} aria-valuemax={widest()} aria-valuenow={shown}
      onPointerDown={drag} onDoubleClick={() => set(panelWidths.initial)}
      onKeyDown={event => { const step = event.key === 'ArrowLeft' ? panelWidths.step : event.key === 'ArrowRight' ? -panelWidths.step : 0; if (step) { event.preventDefault(); set(shown + step); } }} />
    <div className="side-panel-body">{children}</div>
  </aside>;
}

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
