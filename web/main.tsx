const Reviews = lazy(() => import('./review.js'));
import { lazy, Fragment, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserClient, type BrowserConnection, type ProjectSummary, type WorkspaceSnapshot } from '../src/browser.js';
import { Home, projectHue, projectName as name, trapTab } from './home.js';
import { AgentRequest } from './agents.js';
import { AgentConversation } from './conversation.js';
import { ProjectNavigation, sourceLabels, type Section, type SourceRow } from './project.js';
import { sourceItems, useProjectFiles, type SourceItem } from './sources.js';
import { useAgentNow, type AgentNow } from './agent-now.js';
import { compositionName, defaultWorkspace, fileKey, openInWorkspace } from './canvas.js';
import { Icon } from './icons.js';
import { CommandPalette, type Command, type CommandGroup } from './commands.js';
import { PluginCatalog, PluginNavigation } from './plugins.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { ProjectRail, railProjects, useProjectStates } from './project-rail.js';
import { shortcut } from './platform.js';
import { ShellContext, shellServices } from './shell-services.js';
import './theme.css';
import './plugins.css';
import './access.css';

const Workspace = lazy(() => import('./shell/workspace.js').then(module => ({ default: module.Workspace })));
const ProjectOverview = lazy(() => import('./overview.js').then(module => ({ default: module.ProjectOverview })));
const FilePreview = lazy(() => import('./preview.js').then(module => ({ default: module.FilePreview })));
const WorkGraph = lazy(() => import('./graph.js').then(module => ({ default: module.WorkGraph })));
const ConsolePage = lazy(() => import('./console.js').then(module => ({ default: module.ConsolePage })));

const sessionKey = 'rho.browser.session.v1', projectKey = 'rho.browser.project.v1';
// Opening this page on this machine is the access: the service answers a same-origin request as
// the local person, so there is no link, code or credential to carry. A narrower, expiring link
// stays available for a shared or subfolder-scoped tab; only then does the fragment hold a code,
// which no request or Referer carries.
const linked = new URLSearchParams(location.hash.slice(1)), linkCode = linked.get('pair');
if (linkCode !== null) history.replaceState(null, '', location.pathname + location.search);
let linkRedeemed = false;
// The service records that person as `browser:local`; naming it here lets owners tell their own
// changes and undo from another tab's.
const localConnection: BrowserConnection = { url: location.origin, principalId: 'browser:local' };
function restoreSession(): BrowserConnection | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null');
    return saved && saved.url === location.origin && /^[a-f0-9]{64}$/.test(saved.token) && Date.parse(saved.expiresAt) > Date.now() && Array.isArray(saved.methods) ? saved : null;
  } catch { return null; }
}
function humanError(error: unknown) {
  // A request that never reached the service says so, not in the browser's own words.
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return 'Rho did not answer at this address.';
  return error instanceof Error ? error.message : 'The request could not be confirmed. Reconnect to inspect the owner state.';
}
// Only a rejected credential ends this tab's access; scope and network failures keep it.
function accessEnded(error: unknown) { const e = error as { kind?: string; error?: { kind?: string } } | null; return (e?.error?.kind ?? e?.kind) === 'unauthorized'; }
function clock(date: Date, seconds = false) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' }); }
function until(iso: string) {
  const at = new Date(iso), next = new Date(), today = next.toDateString(); next.setDate(next.getDate() + 1);
  return (at.toDateString() === today ? 'Today' : at.toDateString() === next.toDateString() ? 'Tomorrow' : at.toLocaleDateString()) + ' at ' + clock(at);
}
type Phase = 'connecting' | 'live' | 'offline';
// Where the person was in a project: switching back from the rail returns there.
interface Place { screen: 'project' | 'plugins'; overview: boolean; section: Section; category: SourceRow; shownFile: { row: SourceRow; key: string } | null; compositionId: string; pluginId: string }
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
  const [graphResource,setGraphResource]=useState<{id:string;version:string}|null>(null);
  const [reviewId, setReviewId] = useState(''), [reviewAnchor,setReviewAnchor] = useState<any>(null);
  const [context, setContext] = useState(false), [navigation, setNavigation] = useState(true);
  const [feedbackContext, setFeedbackContext] = useState(false);
  const [category, setCategory] = useState<SourceRow>('data'), [addingSource, setAddingSource] = useState(false);
  // The file shown in place from Sources, by its kind and its key in that kind's list.
  const [shownFile, setShownFile] = useState<{ row: SourceRow; key: string } | null>(null);
  const places = useRef(new Map<string, Place>());
  // Following: what the Agent reads and changes opens in the workspace the person shares with
  // it and is brought forward there. It starts when the person sends a message here or asks to
  // follow, and stops when they go somewhere else themselves. The Graph follows the same turn.
  const [following, setFollowing] = useState(false);
  const [consoleTurn, setConsoleTurn] = useState<string | null>(null);
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
  // Closing the Agent panel returns focus to the button that shows it, at the end of the top bar.
  const agentReturn = () => agentTrigger.current?.focus();

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
    if (next.id !== project?.id) { setSnapshot(null); setCompositionId(''); setPluginId(''); setFollowing(false); }
    // The project opens on its own question, not on whichever layout was last open:
    // a person arriving should see what the work is and where it stands.
    if (!restoreLayout) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + next.id);
    const retainedLayout = restoreLayout ? sessionStorage.getItem('rho.layout.v1:' + connection?.principalId + ':' + next.id) : null;
    const retainedReview = restoreLayout && sessionStorage.getItem('rho.review.open:' + connection?.principalId + ':' + next.id) === 'true';
    setReviewId(''); setReviewAnchor(null); setSection(retainedReview ? 'review' : 'overview'); setOverview(retainedReview || !retainedLayout); if (retainedLayout) setCompositionId(retainedLayout); setPluginReturn(false);
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
  function place(id: string, view?: string, followed = false) { if (project) { sessionStorage.removeItem('rho.review.open:' + connection?.principalId + ':' + project.id); sessionStorage.setItem('rho.layout.v1:' + connection?.principalId + ':' + project.id, id); sessionStorage.setItem(workspaceKey(project.id), id); } setCompositionId(id); setOpenView(view ?? ''); setOpenFollowed(followed); setOverview(false); setScreen('project'); }
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
  function showOverview() { if (project) sessionStorage.removeItem('rho.review.open:' + connection?.principalId + ':' + project.id); setFollowing(false); setSection('overview'); if (project) sessionStorage.removeItem('rho.layout.v1:' + connection?.principalId + ':' + project.id); setOverview(true); setScreen('project'); }
  function showSection(next: Section) { if(next==='review'){setReviewId('');setReviewAnchor(null);} showOverview(); if (project && next === 'review') sessionStorage.setItem('rho.review.open:' + connection?.principalId + ':' + project.id, 'true'); setScreen('project'); setSection(next); }
  // The Graph keeps following the Agent's turn; the workspace keeps receiving its files.
  function showGraph() { setGraphResource(null); const was = following; showSection('graph'); if (was) setFollowing(true); }
  // The Console, opened at one message's commands when a board asks for them.
  function showConsole(turn?: string) { setConsoleTurn(turn ?? null); showSection('console'); }
  function showSources(next: SourceRow) { setCategory(next); showSection('sources'); }
  function showFile(row: SourceRow, item: SourceItem) { setShownFile({ row, key: item.key }); setCategory(row); showSection('file'); }
  // A file the Agent named: shown in place among its kind, or in the workspace when it has no kind.
  function showPath(path: string) {
    for (const row of ['results', 'data', 'code', 'notes'] as const) {
      const item = sources?.[row].find(entry => entry.path === path);
      if (item) { showFile(row, item); return; }
    }
    openIn(sharedWorkspace(), path);
  }
  // Opens a file in a workspace and shows it there, or says why it could not.
  function openIn(workspace: string, path: string) {
    if (!snapshot) return;
    openInWorkspace(client, snapshot, workspace, path).then(placed => placed ? layout(placed.compositionId, placed.viewId) : setNotice(path + ' · Rho has no viewer for this kind of file yet.'),
      error => setNotice(path + ' · ' + (error instanceof Error ? error.message : 'It could not be opened.')));
  }
  // A project file a view links to: in Studio it opens in the workspace on screen, elsewhere in place.
  function openLinked(path: string) {
    const here = studioOpen ? composition?.compositionId ?? compositionId : '';
    if (here) openIn(here, path); else showPath(path);
  }
  // The Agent panel, ready for a new conversation or showing the one chosen.
  function talk(conversationId = 'new') { setSelectedConversation(conversationId); setAgentOpen(true); setContext(false); }
  // Studio opens the workspace last open here, or the first one.
  function studio() { layout(sharedWorkspace()); }
  // Following shows the answer filling in on the Overview's board; from the Graph or the Console
  // it stays there. Studio keeps the person's own arrangement and opens nothing by itself.
  function follow() {
    followTarget.current = sharedWorkspace();
    if (!(screen === 'project' && overview && (section === 'graph' || section === 'console'))) showOverview();
    setFollowing(true);
  }
  function plugins() { setFollowing(false); setPluginId(''); setPluginReturn(false); setScreen('plugins'); }
  function about(id: string) { setPluginId(id); setPluginReturn(true); setScreen('plugins'); }
  function goHome() { remember(); setFollowing(false); setScreen('home'); setHomeFocus(true); }
  function remember() { if (project && screen !== 'home') places.current.set(project.id, { screen, overview, section, category, shownFile, compositionId, pluginId }); }
  // Switching between projects keeps each one where the person left it in this tab; choosing a
  // project from the list still opens it on its Overview.
  function switchProject(next: ProjectSummary) {
    if (next.id === project?.id && screen !== 'home') return;
    remember();
    const kept = places.current.get(next.id);
    chooseProject(next);
    if (!kept) return;
    setScreen(kept.screen); setOverview(kept.overview); setSection(kept.section); setCategory(kept.category); setShownFile(kept.shownFile); setPluginId(kept.pluginId);
    if (!kept.overview) setCompositionId(kept.compositionId);
  }
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
  // When the file of an open document changes on disk (an Agent's own editor, another
  // program), opening it again lets its owner take the change into the buffer, merging it with
  // unsaved text where the two changed different lines. Only files seen before are followed.
  const documentFiles = useRef<{ projectId: string; modified: Map<string, string | undefined> } | null>(null);
  useEffect(() => {
    if (!snapshot || !files.readAt) return;
    const projectId = snapshot.project.id, modified = new Map(files.files.map(f => [f.path, f.modifiedAt] as const));
    const before = documentFiles.current?.projectId === projectId ? documentFiles.current.modified : null;
    documentFiles.current = { projectId, modified };
    if (!before) return;
    for (const d of snapshot.documents) {
      if (before.has(d.path) && modified.has(d.path) && before.get(d.path) !== modified.get(d.path))
        client.call('document.open', { projectId, path: d.path }).catch(() => undefined);
    }
  }, [files.readAt]);
  // Where the Agent is in the workspace now: the view of the file its newest action named.
  const presence = useMemo(() => agentPresence(agentNow, snapshot, composition), [agentNow, snapshot, composition]);
  const folder = { root: connection.root, label: connection.rootLabel ?? connection.root ?? '' };
  const projectVisible = screen !== 'home' && project;
  // Plugins has its own sidebar; the plugin shown names the page.
  const sidebarName = screen === 'plugins' ? 'Plugin navigation' : 'Project navigation';
  const shownPlugin = screen === 'plugins' && pluginId ? snapshot?.catalog.plugins.find(p => p.id === pluginId) : undefined;
  const pluginTitle = shownPlugin ? pluginPresentation(shownPlugin).displayName : '';
  function choosePlugin(id: string) { setPluginId(id); if (!id) setPluginReturn(false); }
  const connectionNote = (readAt ? (phase === 'offline' ? 'Showing what was read at ' : 'Last read ') + clock(readAt, true) + '. ' : 'Nothing has been read yet. ')
    + (phase === 'offline' ? "Reconnecting only reads again; it doesn't restart Rho or any work." : 'Reading never starts work.');
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
  // What this tab may do, and what a narrower link leaves out.
  const can = edits ? ['Open and watch projects', 'Edit open documents and pick table rows', ...(runs ? ['Run an action an Agent proposed, and stop a run'] : []), 'Save documents in the editor'] : ['Open, create and watch projects'];
  const cannot = edits ? (runs ? [] : ['Run actions or stop runs']) : ['Edit documents', 'Run actions or stop runs'];
  const linkFolder = link?.root ? (link.rootLabel ?? link.root).split(/[\\/]/).filter(Boolean).at(-1) ?? link.root : '';
  const contextSections = <>
    <div ref={setContextSlot} className="context-slot" />
    {!feedbackContext && <>
    <section className="context-section" aria-labelledby="connection-heading">
      <h3 className="caption" id="connection-heading">Connection</h3>
      <div className={'access-card ' + phase}>
        <div className="access-head">
          <span className="access-mark" aria-hidden="true"><Icon name={phase === 'offline' ? 'offline' : phase === 'live' ? 'signal' : 'refresh'} size={16} /></span>
          <div className="access-title"><strong>{phase === 'live' ? 'Up to date' : phase === 'offline' ? "Can't reach Rho" : 'Connecting'}</strong>
            <small>{phase === 'live' ? 'Changes show as Rho records them' : phase === 'offline' ? (offlineAt ? 'Since ' + clock(offlineAt) : 'Not reached yet') : readAt ? 'Reading the project again' : 'Reading the project'}</small></div>
          <button className={'small-button' + (phase === 'offline' ? ' primary' : '')} onClick={reread}>{phase === 'offline' ? 'Reconnect' : 'Refresh'}</button>
        </div>
        <p className="access-foot">{connectionNote}</p>
        {phase === 'offline' && error && <p className="access-problem">{error}</p>}
      </div>
    </section>
    <section className="context-section" aria-labelledby="tab-access-heading">
      <h3 className="caption" id="tab-access-heading">This tab</h3>
      <div className="access-card">
        <div className="access-head">
          <span className="access-mark" aria-hidden="true"><Icon name={link ? 'link' : 'monitor'} size={16} /></span>
          <div className="access-title"><strong>{link ? 'Opened from a link' : 'This machine'}</strong>
            <small>{link ? (link.expiresAt ? 'Expires ' + until(link.expiresAt).replace(/^(Today|Tomorrow)/, word => word.toLowerCase()) : 'No expiry') : 'Opened directly on this machine; nothing was sent to it'}</small></div>
        </div>
        <p className="access-scope" title={link?.root}><Icon name="folder" size={14} /><span>{link ? (linkFolder ? <><strong>{linkFolder}</strong> and the folders in it</> : 'The folder whoever runs Rho chose') : 'Every project in the folder Rho serves'}</span></p>
        <ul className="access-can" aria-label="What this tab can do">
          {can.map(item => <li key={item}><Icon name="check" size={13} stroke={2.2} /><span>{item}</span></li>)}
          {cannot.map(item => <li key={item} className="not"><Icon name="minus" size={13} stroke={2.2} /><span>{item}<span className="visually-hidden">: not allowed</span></span></li>)}
        </ul>
        {link && <button ref={disconnectTrigger} className="access-leave" onClick={() => askDisconnect(disconnectTrigger.current)}><Icon name="unlink" size={14} />Use this machine's access instead</button>}
      </div>
    </section>
    </>}
  </>;
  // Each kind's files, from the last walk; results also list registered results.
  const sources = useMemo(() => project && files.readAt ? Object.fromEntries((['data', 'code', 'results', 'notes'] as const).map(row => [row, sourceItems(row, files.files, snapshot?.resources ?? [], project, snapshot?.operations)])) as Record<SourceRow, SourceItem[]> : null,
    [files.files, files.readAt, snapshot?.resources, snapshot?.operations, project?.id, project?.root, project?.sources]);
  const linked = useRef(openLinked); linked.current = openLinked;
  const shellNow = useRef({ snapshot, files: files.files }); shellNow.current = { snapshot, files: files.files };
  const reviewNavigation=useRef<(id?:string,anchor?:any)=>void>(()=>{});
  reviewNavigation.current=(id,anchor)=>{showSection('review');setReviewId(id??'');setReviewAnchor(anchor??null);};
  const shell = useMemo(() => shellServices(client, () => shellNow.current, path => linked.current(path), (id, anchor) => reviewNavigation.current(id,anchor)), [client]);
  const fileOnScreen = section === 'file' && shownFile ? sources?.[shownFile.row].find(item => item.key === shownFile.key) : undefined;
  const here = screen === 'plugins' ? 'plugins' : screen !== 'project' ? '' : studioOpen ? 'studio:' + (composition?.compositionId ?? compositionId) : section === 'sources' ? 'sources:' + category : section === 'file' && shownFile ? 'file:' + shownFile.row + ':' + shownFile.key : section === 'documents' ? 'files' : section;
  const initials = project ? name(project).split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map(w => [...w][0]!.toUpperCase()).join('') || 'P' : '';
  // The projects list has the application's own sidebar even while a project stays chosen.
  const inProject = !!project && screen !== 'home';
  const navigationContents = <>
    {project && inProject ? <>
      <button className="nav-back" onClick={pick(goHome)}><Icon name="back" size={15} /><span>All projects</span></button>
      <details className="project-card">
        <summary aria-label={'Project ' + name(project) + '. Switch project'}><span className={'project-avatar ' + projectHue(project.id + name(project))} aria-hidden="true">{initials}</span><span className="project-card-name"><small>Project</small><strong>{name(project)}</strong></span><Icon name="updown" size={16} /></summary>
        <div className="project-menu" role="group" aria-label="Switch project">
          {projects.filter(p => p.id !== project.id).slice(0, 8).map(p => <button key={p.id} onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); pick(() => switchProject(p))(); }}><span className={'project-avatar small ' + projectHue(p.id + name(p))} aria-hidden="true">{name(p).slice(0, 1).toUpperCase()}</span><span>{name(p)}</span></button>)}
          <button onClick={e => { e.currentTarget.closest('details')?.removeAttribute('open'); pick(goHome)(); }}><Icon name="folder" size={16} /><span>All projects…</span></button>
        </div>
      </details>
      {screen === 'plugins' ? <><button className="nav-row" onClick={pick(showOverview)}><Icon name="back" size={14} /><span>Back to project</span></button><PluginNavigation catalog={snapshot?.catalog} pluginId={pluginId} onSelect={id => pick(() => choosePlugin(id))()} /></>
      : <ProjectNavigation project={project} snapshot={snapshot} current={here} sources={sources} partial={files.truncated}
          agent={{ running: !!agentNow?.running, waiting: !!agentNow?.waiting, conversations: snapshot?.conversations?.length ?? 0 }} adding={addingSource}
          onOverview={pick(showOverview)} onStudio={pick(studio)} onLayout={id => pick(() => layout(id))()}
          onSection={next => pick(() => next === 'graph' ? showGraph() : showSection(next))()} onSources={next => pick(() => showSources(next))()} onFile={(row, item) => pick(() => showFile(row, item))()} onAddSource={() => void addSource()} />}
    </> : <>
      <button className="brand" onClick={goHome} aria-label="Rho home"><span className="brand-mark">ρ</span><strong>Rho</strong></button>
      <button className="project-switcher" onClick={pick(goHome)}><Icon name="folder" size={18} /><span>Your projects</span><Icon name="chevron" size={13} /></button>
    </>}
    <div className="navigation-footer">
      {inProject && <button className="nav-row" aria-current={screen === 'project' && overview && section === 'settings' ? 'page' : undefined} onClick={pick(() => showSection('settings'))}><Icon name="context" size={17} /><span>Project settings</span></button>}
      {inProject && <button className="nav-row" aria-current={screen === 'plugins' ? 'page' : undefined} onClick={pick(plugins)}><Icon name="plugins" size={17} /><span>Plugins</span></button>}
    </div>
  </>;
  // Each recent project's Agent state; the open project's comes from its own live record.
  const railList = railProjects(projects), railStates = { ...useProjectStates(client, railList, !link) };
  if (project && agentNow) { if (agentNow.running) railStates[project.id] = agentNow.waiting ? 'waiting' : 'working'; else delete railStates[project.id]; }
  const rail = <ProjectRail projects={railList} current={project?.id ?? null} home={!inProject} states={railStates} onHome={pick(goHome)} onProject={next => pick(() => switchProject(next))()}
    accessOpen={context && !feedbackContext} accessTrigger={contextTrigger} onAccess={pick(() => { setFeedbackContext(false); setContext(v => feedbackContext || !v); setAgentOpen(false); })} />;
  const closeAgent = () => { setAgentOpen(false); agentReturn(); };
  // A conversation's own header holds its title, the recent conversations and Close.
  const agentContents = <>
    {(link || !snapshot) && <div className="drawer-heading"><h2>Agent</h2><button className="icon-button" aria-label="Close Agent" onClick={closeAgent}><Icon name="close" size={18} /></button></div>}
    {snapshot && (link ? <AgentRequest key={snapshot.project.id} snapshot={snapshot} principalId={connection.principalId ?? 'local'} />
      : <AgentConversation key={snapshot.project.id} snapshot={snapshot} client={client} selectedId={selectedConversation} onSelected={() => setSelectedConversation(null)} onSent={() => { if (!studioOpen) follow(); }}
        onClose={closeAgent} onAll={() => { showSection('agent'); if (narrow) setAgentOpen(false); }} />)}
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
  return <ShellContext.Provider value={shell}><div className="application">
    <a className="skip-link" href="#main">Skip to workspace</a>
    <div className="app-body">
      {!narrow && rail}
      {!narrow && navigation && inProject && <aside className="project-nav" aria-label={sidebarName}>{navigationContents}</aside>}
      <div className="app-content">
        <header className="topbar">
          {(inProject || narrow) && <button ref={navigationTrigger} className="icon-button" aria-label={navigation ? 'Hide navigation' : 'Open navigation'} aria-expanded={navigation} onClick={() => setNavigation(v => !v)}><Icon name="sidebar" size={19} /></button>}
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
            {/* The one way to the Agent panel, on every page, above where it opens. */}
            {projectVisible && <button ref={agentTrigger} className="agent-toggle" aria-expanded={agentOpen} aria-label="Agent panel" title={agentOpen ? 'Hide the Agent panel' : 'Talk to the Agent beside this page'} onClick={() => { setAgentOpen(v => !v); setContext(false); }}><Icon name="chat" size={16} /><span>Agent</span></button>}
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
                  {/* Studio is the person's own arrangement; following the Agent happens on the answer board. */}
                  {agentNow?.running && <button className="follow-toggle" aria-pressed="false" title={'See the answer take shape on the Overview as ' + agentNow.agent + ' works. Nothing opens here by itself.'} onClick={follow}><Icon name="follow" size={15} />Follow {agentNow.agent}</button>}
                  {composition && layoutCommands && <details className="view-menu"><summary><Icon name="layout" size={15} />Arrange views</summary><div>{layoutCommands.commands.map(c => <button key={c.id} onClick={e => { c.run(); e.currentTarget.closest('details')?.removeAttribute('open'); }}><Icon name={c.icon} size={15} />{c.label}</button>)}</div></details>}
                </div>
                {composition ? <Suspense fallback={<Loading text="Opening workspace…" />}><Workspace key={snapshot.project.id + composition.compositionId} composition={composition} snapshot={snapshot} client={client!} onAbout={about} contextTarget={context ? contextSlot : null} principalId={connection.principalId} feedbackContextActive={feedbackContext} onShowContext={() => { setFeedbackContext(true); setContext(true); setAgentOpen(false); }} openView={openView} onCommands={setLayoutCommands} agentTarget={agentOpen ? agentSlot : null} onShowAgent={() => setAgentOpen(true)}
                    presence={presence} onPersonMoved={() => setFollowing(false)} attention={false} following={followingHere && openFollowed} /></Suspense>
                  : <StudioEmpty root={project.root} agent={agentNow} following={followingHere} onAgent={() => { setAgentOpen(true); setContext(false); }} onFiles={() => showSources('data')} />}
              </> : section === 'file' && shownFile ? (fileOnScreen ? <Suspense fallback={<Loading text="Opening file…" />}><FilePreview client={client!} snapshot={snapshot} item={fileOnScreen} items={sources![shownFile.row]} kind={sourceLabels[shownFile.row]} principalId={connection.principalId} workspace={sharedWorkspace}
                  onMove={item => showFile(shownFile.row, item)} onStudio={layout} onList={() => showSources(shownFile.row)} onAbout={about} /></Suspense>
                : !sources ? <Loading text="Reading the project folders…" />
                : <div className="studio-empty"><span className="empty-symbol"><Icon name="file" size={26} stroke={1.5} /></span><h2>This file is no longer in the project</h2><p>{shownFile.key.replace(/^\w+:/, '')} was not found when the folders were last read. It may have been moved or removed.</p><div className="empty-actions"><button onClick={() => showSources(shownFile.row)}>All {sourceLabels[shownFile.row].toLowerCase()}</button></div></div>)
              : section === 'review' ? <Suspense fallback={<Loading text="Opening review…" />}><Reviews key={snapshot.project.id+':'+connection.principalId} client={client!} snapshot={snapshot} principalId={connection.principalId} annotationId={reviewId} initialAnchor={reviewAnchor} onGraph={ref=>{showSection('graph');setGraphResource(ref);}} onSent={id => { setSelectedConversation(id); setAgentOpen(true); }} /></Suspense>
              : section === 'console' ? <section className="project-page console-section" aria-labelledby="console-title"><header className="page-heading"><div><h1 id="console-title">Console</h1></div></header>
                  <Suspense fallback={<Loading text="Opening the Console…" />}><ConsolePage client={client!} snapshot={snapshot} files={files} focusTurn={consoleTurn} onPath={showPath} onConversation={id => { setSelectedConversation(id); setAgentOpen(true); setContext(false); }} /></Suspense></section>
              : section === 'graph' ? <Suspense fallback={<Loading text="Opening the graph…" />}><WorkGraph initialResource={graphResource} client={client!} snapshot={snapshot} files={files} agentNow={agentNow} following={following} principalId={connection.principalId}
                  onFollow={follow} onStopFollowing={() => setFollowing(false)} onStudio={layout} workspace={sharedWorkspace} onAbout={about} onAgent={id => { if (id) setSelectedConversation(id); setAgentOpen(true); setContext(false); }} /></Suspense>
              : <Suspense fallback={<Loading text="Opening project…" />}><ProjectOverview key={project.id} section={section} workspace={sharedWorkspace} category={category} files={files} sources={sources} onFile={showFile} linked={!!link} onPath={showPath} onNewConversation={() => talk()} onSection={showSection} onConsole={showConsole} onAgent={id => { if (id) setSelectedConversation(id); setAgentOpen(true); }} client={client!} onProjectChanged={next => { setProject(next); setProjects(list => list.map(p => p.id === next.id ? next : p)); }} project={project} snapshot={snapshot} onLayout={layout} onOpened={(id, view) => { layout(id, view); reread(); }} /></Suspense>}
          </main>
          {projectVisible && agentOpen && !narrow && <SidePanel label="Agent panel">{agentContents}</SidePanel>}
          {context && !narrow && <aside id="project-context" className="context-drawer inspector-pane" aria-label={feedbackContext ? 'Your question' : 'Context and access'}><div className="drawer-heading"><h2>{feedbackContext ? 'Your question' : 'Connection & access'}</h2><button className="icon-button" aria-label="Close context" onClick={() => { setContext(false); contextTrigger.current?.focus(); }}><Icon name="close" size={18} /></button></div>{contextSections}</aside>}
        </div>
      </div>
    </div>
    {narrow && navigation && <Overlay className="drawer" label="Navigation" returnFocus={navigationTrigger} onClose={() => setNavigation(false)}><button className="icon-button drawer-close" aria-label="Close navigation" onClick={() => setNavigation(false)}><Icon name="close" size={18} /></button><div className="drawer-split">{rail}<div className="drawer-nav">{navigationContents}</div></div></Overlay>}
    {narrow && agentOpen && <Overlay className="context-sheet" label="Agent panel" returnFocus={agentTrigger} onClose={() => setAgentOpen(false)}>{agentContents}</Overlay>}
    {narrow && context && <Overlay className="context-sheet" label={feedbackContext ? 'Your question' : 'Context and access'} returnFocus={contextTrigger} onClose={() => setContext(false)}><div className="drawer-heading"><h2>{feedbackContext ? 'Your question' : 'Connection & access'}</h2><button className="done-button" onClick={() => setContext(false)}>Done</button></div>{contextSections}</Overlay>}
    <dialog ref={dialog} className="commands" aria-label="Commands" onCancel={() => setCommands(false)} onClose={e => { if (e.currentTarget.open) return; setCommands(false); const next = afterCommands.current; afterCommands.current = null; if (next) next(); else commandReturn()?.focus(); }} onClick={e => { if (e.target === e.currentTarget) setCommands(false); }}>{commands && <CommandPalette groups={groups} onRun={runCommand} />}</dialog>
    <dialog ref={confirmDialog} className="confirm" aria-labelledby="disconnect-title" aria-describedby="disconnect-body" onCancel={() => setConfirming(false)} onClose={() => { setConfirming(false); confirmReturn.current?.focus(); }}>
      <h2 id="disconnect-title">Use this machine's access?</h2><p id="disconnect-body">This tab stops using its link and keeps working as this machine. Open projects, unsaved edits and running work are unchanged.</p><div className="dialog-actions"><button onClick={() => setConfirming(false)}>Cancel</button><button className="danger" onClick={() => useLocalAccess('This tab now uses this machine.')}>Use this machine</button></div>
    </dialog>
  </div></ShellContext.Provider>;
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
