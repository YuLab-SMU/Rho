import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserClient, CompositionSummary, WorkspaceSnapshot } from '../../src/browser.js';
import { addBeside, closeView, dockView, groupNode, groupOf, moveGroup, moveTab, moveToEdge, moveView, placeView, regions, resizeSplit, selectionScope, setViewProps, splitView, tabGroups, viewOrder, type LayoutNode, type LayoutTree, type Region, type Side } from '../../src/shell-layout.js';
import type { Command, CommandGroup } from '../commands.js';
import { Icon } from '../icons.js';
import { registry } from '../registry.js';
import { useLive } from './live.js';
import { OwnerView, availableEntry, title, viewIcon } from './owner.js';
import { AgentColumn, Bar, Digest, Evidence, Interruption, waiting } from './layer.js';
import { openRun, runFirstLine, RunView, SourceLine } from './facts.js';
import { ActionForm } from './action-form.js';
import { CommandPane } from '../console.js';
import { showOnServer, type Prepared, type SessionScope } from '@rho-workspace/plugin-kernel/ui';
import { addNotebook, addObject, addSessionView, canExplore, explorableTable, languageNames, loadTable, notebookComponent, notebookView, projectPath, scriptLanguage, scriptPrepared, sessionComponents, type Language } from '../explore.js';
import { ExploreIn } from '../explore-in.js';
import { useProcess } from '../process-context.js';
import { ProcessFrame } from './process-views.js';
import { ShellContext } from '../shell-services.js';
import { WorkspaceViewsContext, type WorkspaceViews } from './workspace-views.js';
import type { ShellServices } from '../../src/ui-contract.js';
import { boundResource } from '../executions.js';
import { AddButton, Slot, Split, TabGroup, place, unplace, useTabOverflow, type Dragged, type DropTarget, type TabDrag, type TabRender, type TabTools } from './regions.js';
import type { MenuItem } from './menu.js';
import './shell.css';

type Tabs = Extract<Region, { kind: 'tabs' }>;
// A file's name shortens in its stem and keeps its extension, so a script, its figure and its
// table that share a name still read apart in narrow tabs.
function TabName({ name }: { name: string }) {
  const dot = name.lastIndexOf('.'), ext = dot > 0 && name.length - dot <= 6 && !/\s/.test(name.slice(dot)) ? name.slice(dot) : '';
  return <span className="shell-tab-name" title={name}><span className="shell-tab-stem">{ext ? name.slice(0, dot) : name}</span>{ext && <span className="shell-tab-ext">{ext}</span>}</span>;
}
export const workspaceLimits = { minSplitPx: 640 };
// The workspace shell: the owner's composition tree drawn as
// splits and tab groups, owner views mounted within the rendering budget, and a slot for
// what Rho adds above the work. It decides nothing about attention; useLive does.
export function Workspace({ composition: recorded, snapshot, client, onAbout, contextTarget, principalId, onShowContext, feedbackContextActive, openView, onCommands, agentTarget, onShowAgent, presence, onPersonMoved, onConversation, onExplore, onObject, empty, prepared: given, onPrepare, bar = true, barTarget, attention = true, following = false, arrange = true, addView }: { addView?: (into: string) => ReactNode; onConversation?: (id: string) => void; onExplore?: (path: string, language: Language) => void; onObject?: (language: Language, name: string) => void; empty?: ReactNode; prepared?: Prepared | null; onPrepare?: (prepared: Prepared | null) => void; following?: boolean; arrange?: boolean; bar?: boolean; barTarget?: HTMLElement | null; attention?: boolean; presence?: { viewId: string; label: string; verb: string; live: boolean } | null; onPersonMoved?: () => void; onCommands?: (group: CommandGroup | null) => void; composition: CompositionSummary; snapshot: WorkspaceSnapshot; client: BrowserClient; onAbout: (pluginId: string) => void; contextTarget: HTMLElement | null; principalId?: string; onShowContext: () => void; feedbackContextActive: boolean; mapChipTarget?: HTMLElement | null; openView?: string; agentTarget?: HTMLElement | null; onShowAgent?: () => void }) {
  // A conversation's Studio: its files' views show their versions, and a replay arranges nothing.
  const process = useProcess();
  const live = useLive(snapshot, recorded, client, principalId, !!process), layout = live.layout;
  // A question sent from another browser session has no context in this one. Preparing it under
  // the question's own changeId (as the table's send does) keeps one context per question version.
  async function prepareQuestion(annotationId: string) {
    const version = (snapshot.annotations as Array<{ annotationId: string; version: number }>).find(a => a.annotationId === annotationId)?.version ?? 1;
    return ((await client.call('context.create', { projectId: snapshot.project.id, changeId: version === 1 ? annotationId : annotationId + '@' + version, expectedVersion: 0, annotations: [{ annotationId, version }] } as never, AbortSignal.timeout(30000))) as { contextId: string }).contextId;
  }
  const root = useMemo(() => regions(layout), [layout]);
  const order = useMemo(() => viewOrder(root), [root]);
  const byId = useMemo(() => new Map(layout.views.map(v => [v.id, v])), [layout]);
  const [narrowWindow, setNarrowWindow] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => { const q = matchMedia('(max-width: 767px)'), change = () => setNarrowWindow(q.matches); q.addEventListener('change', change); return () => q.removeEventListener('change', change); }, []);
  // Views side by side need room: on a stage narrower than this, as when the notes and the Agent
  // panel are open beside it, they show one at a time, as on a phone. The saved layout is kept.
  const stage = useRef<HTMLDivElement>(null), [tight, setTight] = useState(false);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width) setTight(entry.contentRect.width < workspaceLimits.minSplitPx); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Which view each tab group shows, and which view has the person's (or the Agent's) focus.
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState(order[0] ?? '');
  const shown = (group: Tabs) => group.views.includes(focus) ? focus : group.views.includes(selected[group.id]) ? selected[group.id] : group.views[0];
  const bring = (id: string) => { const group = groupOf(root, id); if (group) setSelected(s => ({ ...s, [group.id]: id })); setFocus(id); };
  const show = (id: string) => { live.hold(id); bring(id); };
  // An exact version opens where it already shows, or beside the person's views.
  const openRef = (ref: { id: string; version: string }) => {
    const existing = layout.views.find(v => Object.values(v.bindings ?? {}).some(b => 'id' in b && b.id === ref.id && b.version === ref.version));
    if (existing) show(existing.id); else live.openResource(ref);
  };
  // What Rho adds above the work: one interruption at a time, hidden until it changes.
  const [evidence, setEvidence] = useState(false), [hidden, setHidden] = useState<string[]>([]);
  const items = waiting(live), unhidden = items.filter(i => !hidden.includes(i.key + ':' + i.text));
  // In a conversation's Studio the step at the moment shown decides, through openView.
  useEffect(() => {
    if (process || !live.active || !byId.has(live.active)) return;
    // Keyboard focus inside a view is the person's place: a move the owners' records make
    // that would hide it holds it instead, so the move waits as it does while the person works.
    const here = document.activeElement?.closest<HTMLElement>('[data-owner-view]')?.dataset.ownerView;
    if (live.movedBy === 'owners' && here && here !== live.active && byId.has(here) && (narrow || groupOf(root, here)?.id === groupOf(root, live.active)?.id)) { live.hold(here); return; }
    bring(live.active);
  }, [live.active, root]);
  const brought = useRef('');
  // Following the Agent only changes what is shown; a view the person opens is also held, so a
  // newer layout keeps it. A view merely followed past is not kept beside its replacement.
  useEffect(() => { if (openView && brought.current !== openView && byId.has(openView)) { brought.current = openView; if (following) bring(openView); else show(openView); } }, [openView, byId]);
  const focused = order.includes(focus) ? focus : order[0] ?? '';
  const groups = root ? tabGroups(root) : [];
  const narrow = narrowWindow || (tight && groups.length > 1);
  // One group shown alone over the stage, in this tab only, until the person restores the others
  // or a view outside it is brought forward. The saved layout is unchanged.
  const [maximized, setMaximized] = useState<string | null>(null);
  const alone = !narrow && groups.length > 1 ? groups.find(g => g.id === maximized) ?? null : null;
  useEffect(() => { if (alone && focused && !alone.views.includes(focused)) setMaximized(null); }, [focused]);
  const visible = narrow ? (focused ? [focused] : []) : alone ? [shown(alone)] : groups.map(shown);
  // Divider positions the person set in this tab, until the owner's layout changes.
  const [weights, setWeights] = useState<{ version: number; values: Record<string, number[]> }>({ version: layout.version, values: {} });
  const own = weights.version === layout.version ? weights.values : {};
  // Layout commands given without dragging: one conditional
  // replacement of the owner's tree, or the owner's own undo. The person's change is adopted
  // at once; a refusal (a protected view, a newer layout) is said, and nothing is retried.
  const [layoutProblem, setLayoutProblem] = useState('');
  const allowed = (method: string) => (arrange || !method.startsWith('composition.')) && snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized);
  const tree: LayoutTree | null = recorded.rootId && recorded.nodes?.length ? { rootId: recorded.rootId, nodes: recorded.nodes as unknown as LayoutNode[] } : null;
  // A command runs against the newest layout this tab knows: the last read, or the owner's
  // reply to this tab's own last change when that is newer than the read.
  const replied = useRef<{ compositionId: string; version: number; rootId?: string; nodes?: unknown[] } | null>(null);
  const latest = useRef(recorded);
  latest.current = replied.current && replied.current.compositionId === recorded.compositionId && replied.current.version > recorded.version ? { ...recorded, ...replied.current } as typeof recorded : recorded;
  const treeNow = (): LayoutTree | null => latest.current.rootId && latest.current.nodes?.length ? { rootId: latest.current.rootId, nodes: latest.current.nodes as unknown as LayoutNode[] } : null;
  const remember = (result: { compositionId: string; version: number; rootId?: string; nodes?: unknown[] }) => { replied.current = { compositionId: result.compositionId, version: result.version, rootId: result.rootId, nodes: result.nodes }; latest.current = { ...latest.current, ...replied.current } as typeof recorded; };
  const newId = (kind: string) => `${kind}-${crypto.randomUUID().slice(0, 8)}`;
  const refusal = (error: unknown) => setLayoutProblem(error instanceof Error ? error.message : 'The layout change was not accepted.');
  async function writeLayout(next: LayoutTree | null) {
    if (!next) return false;
    setLayoutProblem('');
    try { remember(await client.call('composition.apply', { projectId: snapshot.project.id, compositionId: latest.current.compositionId, expectedVersion: latest.current.version, changeId: 'layout-' + crypto.randomUUID(), operations: [{ op: 'replace', rootId: next.rootId, nodes: next.nodes }] } as never, AbortSignal.timeout(30000)) as never); return true; }
    catch (error) { refusal(error); return false; }
  }
  async function undoLayout() {
    setLayoutProblem('');
    try { remember(await client.call('composition.undo', { projectId: snapshot.project.id, compositionId: latest.current.compositionId, expectedVersion: latest.current.version, changeId: 'layout-undo-' + crypto.randomUUID() }, AbortSignal.timeout(30000)) as never); }
    catch (error) { refusal(error); }
  }
  // The recovery for a view this build cannot draw: the same binding in a view it can, as a
  // new tab beside it. The original view and its reference stay where the Agent put them.
  async function openBeside(viewId: string, beside: { component: string; version: string; props: Record<string, unknown>; bindings: Record<string, unknown> }) {
    const parent = treeNow()?.nodes.find(n => n.kind === 'group' && n.children?.includes(viewId));
    if (!parent) return;
    setLayoutProblem('');
    const id = newId('view');
    try { await client.call('composition.apply', { projectId: snapshot.project.id, compositionId: latest.current.compositionId, expectedVersion: latest.current.version, changeId: 'layout-beside-' + crypto.randomUUID(), operations: [{ op: 'insert', parentId: parent.id, index: parent.children!.indexOf(viewId) + 1, node: { id, kind: 'view', ...beside } }] } as never, AbortSignal.timeout(30000)).then(result => remember(result as never)); show(id); }
    catch (error) { refusal(error); }
  }
  // Exploring a file in the Notebook: the page's Notebook comes forward, or one opens in a pane
  // beside the file, in the same one conditional layout write as any arrangement. A table then
  // loads into a new value at once; a script waits in the Notebook's line for the person to run.
  // A conversation's Studio is the record of the Agent's work: what is explored from it opens on
  // the person's workspace instead, through onExplore, the way it does from the Overview.
  // Code waiting for the Notebook's line is the application's when it keeps it across pages.
  const [kept, setKept] = useState<Prepared | null>(null), [exploring, setExploring] = useState(false);
  const prepared = onPrepare ? given ?? null : kept, setPrepared = onPrepare ?? setKept;
  const exploreOn = canExplore(snapshot) && (process ? !!onExplore : !!tree);
  async function explore(viewId: string, path: string, language: Language, script: { dirty: boolean } | null) {
    if (process) { onExplore?.(path, language); return; }
    setLayoutProblem(''); setExploring(true);
    try {
      let notebook = layout.views.find(v => v.component === notebookComponent)?.id;
      if (!notebook) {
        const view = byId.get(viewId), now = treeNow(), id = 'notebook';
        const ready = view && now && placeView(now, view, newId), next = ready && addBeside(ready, notebookView(id) as never, viewId, 'right', newId);
        if (!allowed('composition.apply') || !next) { setLayoutProblem('The Notebook could not be placed beside this view.'); return; }
        if (!(await writeLayout(next))) return;
        notebook = id;
      }
      if (script) setPrepared(scriptPrepared(path, language, script.dirty));
      else await loadTable(client, snapshot.project.id, path, language);
      onPersonMoved?.(); show(notebook);
    } catch (error) { refusal(error); }
    finally { setExploring(false); }
  }
  // A value of a live session opens as a view of its own on the person's page, beside the
  // Notebook; from a conversation's Studio it opens on the person's workspace, through onObject.
  // A new view is shown once the page's layout has it.
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => { if (opening && byId.has(opening)) { setOpening(null); show(opening); } }, [opening, byId]);
  function openObject(language: Language, name: string) {
    if (process) { onObject?.(language, name); return; }
    setLayoutProblem('');
    addObject(client, snapshot.project.id, layout.compositionId, language, name, stage.current?.clientWidth).then(id => { onPersonMoved?.(); setOpening(id); }, refusal);
  }
  // A file a session on a server named is shown in the Servers view, in its folder there.
  function openRemote(placeId: string, path: string) {
    showOnServer(placeId, path);
    const servers = layout.views.find(v => v.component === sessionComponents.servers)?.id;
    if (servers) { show(servers); return; }
    setLayoutProblem('');
    addSessionView(client, snapshot.project.id, layout.compositionId, 'servers').then(id => { onPersonMoved?.(); setOpening(id); }, refusal);
  }
  // A script's line run from its editor: the person's cell in the shared session, in the order the
  // lines were run. A page without the Notebook gets one under the script, as a console sits under
  // an editor; one in another pane comes forward in it, and the script keeps the keyboard.
  const runs = useRef<Promise<unknown>>(Promise.resolve());
  const runFromScript = useRef<NonNullable<ShellServices['runCode']>>(async () => {});
  runFromScript.current = async ({ viewId, language, code, purpose }) => {
    setLayoutProblem('');
    const notebook = layout.views.find(v => v.component === notebookComponent)?.id;
    if (!notebook) {
      const view = byId.get(viewId), now = treeNow(), ready = view && now && placeView(now, view, newId);
      const next = ready && addBeside(ready, notebookView('notebook', 'console') as never, viewId, 'bottom', newId);
      if (allowed('composition.apply') && next) await writeLayout(next);
    } else {
      const group = groupOf(root, notebook);
      if (group && group.id !== groupOf(root, viewId)?.id) setSelected(s => ({ ...s, [group.id]: notebook }));
    }
    const sent = runs.current.then(() => client.call('kernel.run', { projectId: snapshot.project.id, language, code, purpose, changeId: 'script-' + crypto.randomUUID() }));
    runs.current = sent.catch(() => {});
    await sent.catch(refusal);
  };
  // A view's own choice, such as the Notebook's form, saved with the page.
  function saveProps(viewId: string, props: Record<string, unknown>) {
    const now = treeNow(), next = now && setViewProps(now, viewId, props);
    if (next && allowed('composition.apply')) void writeLayout(next);
  }
  const shellAbove = useContext(ShellContext), runnable = !process && !!tree && canExplore(snapshot);
  const shellHere = useMemo<ShellServices | undefined>(() => runnable ? { ...shellAbove, runCode: run => runFromScript.current(run) } : shellAbove, [shellAbove, runnable]);
  // What reaches a value waits in the Notebook's line, for the person to build on and run.
  function useInNotebook(language: Language, expression: string, name: string) {
    setPrepared({ key: crypto.randomUUID(), language, code: expression, note: `From the ${name} view. Build on it, then press Run.` });
    const notebook = layout.views.find(v => v.component === notebookComponent)?.id;
    if (notebook) { show(notebook); return; }
    if (!process) addNotebook(client, snapshot.project.id, layout.compositionId, null).then(id => show(id), refusal);
  }
  // In a conversation's Studio the live sessions show that conversation's share: the cells its
  // Agent and the person ran since it began, up to the moment shown.
  const principal = process ? snapshot.conversations?.find(c => c.conversationId === process.conversationId)?.principal ?? null : null;
  const starts = process ? process.whole.turns.filter(t => t.conversationId === process.conversationId).map(t => t.start) : [];
  const scope: SessionScope | undefined = process ? { principal, since: starts.length ? Math.min(...starts) : null, at: process.at, cellIds: process.kernelCells } : undefined;
  const views: WorkspaceViews = {
    openValue: openObject, openRemote, toNotebook: (language, code, from) => useInNotebook(language, code, from),
    prepared, taken: () => setPrepared(null), setProps: saveProps, has: component => layout.views.some(v => v.component === component),
    scope, openConversation: onConversation,
  };
  // A divider is written back once the person stops moving it.
  const resizing = useRef<ReturnType<typeof setTimeout>>(undefined);
  function resized(splitId: string, values: number[]) {
    setWeights(w => ({ version: layout.version, values: { ...(w.version === layout.version ? w.values : {}), [splitId]: values } }));
    clearTimeout(resizing.current);
    if (tree && allowed('composition.apply')) resizing.current = setTimeout(() => { const now = treeNow(); void writeLayout(now && resizeSplit(now, splitId, values)); }, 600);
  }
  useEffect(() => () => clearTimeout(resizing.current), []);
  // A tab or a whole group dragged to another place: the same one conditional write as a layout
  // command, so the person and the Agent keep arranging one saved layout and either can undo.
  const [dragging, setDragging] = useState<{ item: Dragged; target: DropTarget | null } | null>(null);
  function dropDragged(target: DropTarget) {
    const item = dragging?.item;
    setDragging(null);
    const now = treeNow();
    if (!item || !now) return;
    let next: LayoutTree | null = null, bringing: string | undefined;
    if (item.kind === 'group') {
      const region = groups.find(g => g.id === item.id), from = groupNode(item.id);
      if (!region) return;
      bringing = shown(region);
      next = 'edge' in target ? moveToEdge(now, from, target.edge, newId)
        : moveGroup(now, from, groupNode(target.group), target.zone === 'tab' ? 'center' : target.zone, target.zone === 'tab' ? target.before : null, newId);
    } else {
      const view = byId.get(item.id);
      if (!view || ('group' in target && target.zone === 'center' && groupOf(root, view.id)?.id === target.group)) return;
      const ready = placeView(now, view, newId);
      bringing = view.id;
      next = !ready ? null : 'edge' in target ? moveToEdge(ready, view.id, target.edge, newId)
        : target.zone === 'tab' ? moveTab(ready, view.id, groupNode(target.group), target.before, newId)
        : target.zone === 'center' ? moveTab(ready, view.id, groupNode(target.group), null, newId)
        : dockView(ready, view.id, groupNode(target.group), target.zone, newId);
    }
    if (!next) return;
    onPersonMoved?.(); if (bringing) show(bringing); void writeLayout(next);
  }
  const canArrange = !!tree && allowed('composition.apply');
  const drag: TabDrag | undefined = canArrange ? {
    dragging: dragging?.item ?? null, target: dragging?.target ?? null,
    start: item => { setMaximized(null); setDragging({ item, target: null }); }, end: () => setDragging(null),
    over: target => setDragging(d => d && { ...d, target }), drop: dropDragged
  } : undefined;
  // Closing a view the person chose: its node leaves the saved layout and its records, input and
  // runs stay with their owners. Undo is offered until the layout changes again.
  const [closed, setClosed] = useState<{ label: string; version: number } | null>(null);
  useEffect(() => { if (closed && recorded.version > closed.version) setClosed(null); }, [recorded.version]);
  useEffect(() => { if (!closed) return; const timer = setTimeout(() => setClosed(null), 10000); return () => clearTimeout(timer); }, [closed]);
  async function closeViews(ids: string[], label: string) {
    const now = treeNow();
    let next = now;
    for (const id of ids) { live.release(id); next = next && (closeView(next, id) ?? next); }
    onPersonMoved?.();
    if (next && next !== now && await writeLayout(next)) setClosed({ label, version: latest.current.version });
  }
  const closeTab = (id: string) => { const view = byId.get(id); if (view) void closeViews([id], title(view)); };
  async function undoClose() {
    const was = closed;
    setClosed(null);
    if (was && latest.current.version === was.version) await undoLayout();
  }
  // A tab's own menu: the commands of the Arrange menu for the tab it was opened on.
  function tabMenu(id: string): MenuItem[] {
    const view = byId.get(id), now = treeNow(), group = groupOf(root, id);
    if (!view || !now || !group) return [];
    const ready = placeView(now, view, newId), items: MenuItem[] = [{ id: 'close', label: 'Close', icon: 'close', keys: 'Del', run: () => closeTab(id) }];
    const others = group.views.filter(other => other !== id);
    if (others.length) items.push({ id: 'close-others', label: others.length === 1 ? 'Close the other tab' : `Close the ${others.length} other tabs`, icon: 'close', run: () => void closeViews(others, others.length === 1 ? title(byId.get(others[0])!) : `${others.length} views`) });
    const split = (axis: 'horizontal' | 'vertical') => { const t = treeNow(), r = t && placeView(t, view, newId), next = r && splitView(r, id, axis, newId); if (next) { onPersonMoved?.(); show(id); void writeLayout(next); } };
    if (ready && splitView(ready, id, 'horizontal', newId)) items.push({ id: 'split-right', label: 'Split right', icon: 'layout', run: () => split('horizontal') }, { id: 'split-down', label: 'Split down', icon: 'layout', run: () => split('vertical') });
    if (groups.length > 1) items.push(alone ? { id: 'restore', label: 'Show every group', icon: 'restore', run: () => setMaximized(null) } : { id: 'maximize', label: 'Maximize this group', icon: 'fit', run: () => { show(id); setMaximized(group.id); } });
    return items;
  }
  const toolsFor = (region: Tabs): TabTools | undefined => canArrange ? {
    close: closeTab, menu: tabMenu, add: addView ? () => addView(groupNode(region.id)) : undefined,
    movable: !alone && groups.length > 1, maximized: alone?.id === region.id, onMaximize: () => setMaximized(m => m === region.id ? null : region.id),
  } : undefined;
  // Eight mounted heavy entries is a rendering budget, never a buffer eviction: the views on
  // screen always render, then the most recently shown, then the rest in layout order. A view
  // mounts the first time it shows; a hidden one past the budget unmounts and mounts again from
  // its owner when shown, which keeps buffers and undo but not its scroll or selection.
  const feedbackEntry = registry.entries.find(e => e.component === 'rho.feedback');
  const feedbackAllowed = !!snapshot.feedback && feedbackEntry?.requiredOperations.every(method => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available'));
  const [feedbackSource, setFeedbackSource] = useState<string | null>(null), [feedbackLimit, setFeedbackLimit] = useState(false);
  useEffect(() => { setFeedbackSource(null); setFeedbackLimit(false); }, [snapshot.project.id, layout.compositionId, snapshot.feedback?.taskId, principalId]);
  const maxMounted = Math.max(1, Math.min(8, Number(import.meta.env.VITE_RHO_MAX_HEAVY_VIEWS) || 8));
  const rights = useRef(new Set<string>()), seen = useRef(new Set<string>()), recent = useRef<string[]>([]);
  for (const id of seen.current) if (!byId.has(id)) seen.current.delete(id);
  const onScreen = visible.filter(id => id && byId.has(id));
  recent.current = [...onScreen, ...recent.current.filter(id => byId.has(id) && !onScreen.includes(id))];
  const reserve = contextTarget && feedbackContextActive && feedbackSource && !feedbackLimit ? 1 : 0;
  rights.current = new Set();
  for (const id of [...recent.current, ...order]) if (rights.current.size < maxMounted - reserve && !rights.current.has(id) && availableEntry(byId.get(id)!, snapshot)) rights.current.add(id);
  for (const id of visible) seen.current.add(id);
  const requestFeedback = feedbackAllowed ? (viewId: string) => { setFeedbackLimit(rights.current.size >= maxMounted); setFeedbackSource(viewId); onShowContext(); } : undefined;
  // One element per view for as long as it is in the layout.
  const containers = useRef(new Map<string, HTMLDivElement>());
  for (const id of containers.current.keys()) if (!byId.has(id)) containers.current.delete(id);
  const container = (id: string) => {
    let element = containers.current.get(id);
    if (!element) { element = document.createElement('div'); element.className = 'shell-view'; element.dataset.ownerView = id; containers.current.set(id, element); }
    return element;
  };
  // Owner controls go to the right of their group's tabs.
  const [headers, setHeaders] = useState<Record<string, HTMLElement | null>>({});
  const headerRefs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const headerRef = useCallback((group: string) => {
    let ref = headerRefs.current.get(group);
    if (!ref) { ref = element => setHeaders(h => h[group] === element ? h : { ...h, [group]: element }); headerRefs.current.set(group, ref); }
    return ref;
  }, []);
  const headerOf = (id: string) => narrow ? headers['narrow'] ?? null : headers[groupOf(root, id)?.id ?? ''] ?? null;
  // Each view's own controls live in one element of their own, moved into its group's header
  // while it shows, so two owners never share or reorder one slot.
  const ownHeaders = useRef(new Map<string, HTMLDivElement>());
  for (const id of ownHeaders.current.keys()) if (!byId.has(id)) ownHeaders.current.delete(id);
  const ownHeader = (id: string) => {
    let element = ownHeaders.current.get(id);
    if (!element) { element = document.createElement('div'); element.className = 'shell-view-header'; element.dataset.ownerHeader = id; ownHeaders.current.set(id, element); }
    return element;
  };
  useLayoutEffect(() => {
    for (const [id, element] of ownHeaders.current) {
      const target = visible.includes(id) ? headerOf(id) : null;
      if (target) place(element, target);
      else if (element.parentElement) unplace(element, element.parentElement);
    }
  });
  const body = (id: string): ReactNode => {
    const view = byId.get(id)!, isVisible = visible.includes(id);
    if (view.component === 'rho.action') return <ActionForm view={view} snapshot={snapshot} client={client} live={live} />;
    if (view.component === 'rho.console') return <CommandPane client={client} snapshot={snapshot} />;
    if (view.component === 'rho.execution') {
      const operationId = String(view.props.operationId ?? id);
      return <RunView snapshot={snapshot} client={client} operationId={operationId} runs={live.runs} readRuns={live.readRuns} firstLine={runFirstLine(live, operationId)} opener={ref => () => openRef(ref)} onOpenRun={other => openRun(live, other)} chain />;
    }
    const resource = boundResource(view, snapshot.resources);
    // A table, or a script, is explored from its own header.
    const document = (view.bindings as Record<string, { kind?: string; documentId?: string }> | undefined)?.document;
    const script = document?.kind === 'live-document' ? snapshot.documents.find(d => d.id === document.documentId) : undefined, scriptIn = scriptLanguage(script?.path);
    const table = resource?.kind === 'table' && explorableTable(projectPath(resource)) ? projectPath(resource) : null;
    const explorer = exploreOn && isVisible && (table || (script && scriptIn)) ? createPortal(table
      ? <ExploreIn languages={['r', 'python']} busy={exploring} title={l => `${process ? 'Open it on your workspace with the Notebook beside it, and load ' : 'Load '}${table.split('/').at(-1)} as it is on disk now into the ${languageNames[l]} session as a new value${process ? '' : ', with the Notebook beside it'}`} onExplore={l => void explore(id, table, l, null)} />
      : <ExploreIn languages={[scriptIn!]} busy={exploring} title={l => `${process ? 'Open it on your workspace with the Notebook beside it, and put ' : 'Put '}a line that runs ${script!.path.split('/').at(-1)} into the ${languageNames[l]} Notebook's line, for you to check and run`} onExplore={l => void explore(id, script!.path, l, { dirty: script!.dirty })} />, ownHeader(id), 'explore-' + id) : null;
    const annotations = snapshot.catalog.plugins.find(p => p.id === 'annotations');
    const Question = resource?.kind === 'table' && annotations?.projectEnabled && annotations.dependenciesSatisfied && annotations.state === 'available' ? registry.entries.find(e => e.component === 'rho.feedback')?.TableQuestion : undefined;
    const owner = <OwnerView active={isVisible} params={{
      view, snapshot, client, principalId, compositionId: layout.compositionId, compositionVersion: layout.version,
      // One view at a time owns the context panel: the one with focus.
      contextTarget: id === focused && !feedbackContextActive ? contextTarget : null, headerTarget: isVisible ? ownHeader(id) : null,
      renderAllowed: rights.current.has(id), onAbout, onRequestFeedback: requestFeedback,
      onOpenBeside: tree && allowed('composition.apply') && tree.nodes.some(n => n.id === id) ? beside => void openBeside(id, beside) : undefined,
    }} />;
    if (process) return <>{explorer}<ProcessFrame view={view} process={process} client={client} snapshot={snapshot}>{owner}</ProcessFrame></>;
    if (!resource) return <>{explorer}{owner}</>;
    return <>{explorer}<SourceLine live={live} snapshot={snapshot} resource={resource} viewId={id} onOpenRef={openRef}>
      {Question && <Question key={resource.id + resource.version + id} projectId={snapshot.project.id} viewId={id} resource={resource} snapshot={snapshot} client={client} principalId={principalId} headerTarget={ownHeader(id)} selectionScope={selectionScope(view)} onOpenResource={openRef} requestFeedback={requestFeedback ? () => requestFeedback(id) : undefined} />}
    </SourceLine>{owner}</>;
  };
  const render: TabRender = {
    label: id => title(byId.get(id)!), container,
    name: id => title(byId.get(id)!) + (presence?.viewId === id ? ', ' + presence.verb : ''),
    title: id => { const v = byId.get(id)!; return <><Icon name={viewIcon(v, snapshot)} size={14} stroke={2} /><TabName name={title(v)} />{presence?.viewId === id && <span className={'agent-presence' + (presence.live ? ' live' : '')} title={presence.label}><span className="pulse-dot" aria-hidden="true" />{presence.verb}</span>}</>; },
  };
  const groupName = (id: string) => groups.length === 1 ? 'Views' : `Views ${groups.findIndex(g => g.id === id) + 1} of ${groups.length}`;
  const firstTitle = (region: Region): string => { const id = region.kind === 'tabs' ? shown(region) : viewOrder(region)[0]; return id ? title(byId.get(id)!) : 'view'; };
  const draw = (region: Region): ReactNode => region.kind === 'tabs'
    ? <TabGroup key={region.id} group={region} name={groupName(region.id)} selected={shown(region)} onSelect={id => { if (id !== shown(region)) onPersonMoved?.(); show(id); }} onHeader={headerRef(region.id)} render={render} drag={drag} tools={toolsFor(region)} />
    : <Split key={region.id} region={region} weights={own[region.id] ?? region.weights} onResize={values => resized(region.id, values)}
      label={i => `Resize ${firstTitle(region.children[i - 1])} and ${firstTitle(region.children[i])}`}>{region.children.map(draw)}</Split>;
  // The focused view's layout commands, offered in the command palette.
  useEffect(() => {
    if (!onCommands) return;
    const commands: Command[] = [], view = byId.get(focused), name = view ? title(view) : '';
    if (tree && view && allowed('composition.apply') && (tree.nodes.some(n => n.id === focused) || availableEntry(view, snapshot))) {
      // Offered when it applies now; computed again from the latest layout when it runs.
      // A person's command promotes only this linked view into the saved tree. It keeps
      // its exact binding, and uses the same owner conditions as every other layout edit.
      const viewId = focused;
      const offer = (id: string, label: string, change: (t: LayoutTree) => LayoutTree | null) => {
        const placed = placeView(tree, view, newId);
        if (placed && change(placed)) commands.push({ id, label, icon: 'layout', meta: name, run: () => {
          const now = treeNow(), ready = now && placeView(now, view, newId), next = ready && change(ready);
          if (next) void writeLayout(next);
        } });
      };
      offer('layout-split-right', 'Split right', t => splitView(t, viewId, 'horizontal', newId));
      offer('layout-split-down', 'Split down', t => splitView(t, viewId, 'vertical', newId));
      offer('layout-next', 'Move to the next group', t => moveView(t, viewId, 1, newId));
      offer('layout-previous', 'Move to the previous group', t => moveView(t, viewId, -1, newId));
      commands.push({ id: 'layout-close', label: 'Close view', icon: 'close', meta: name, run: () => closeTab(viewId) });
    }
    if (allowed('composition.undo') && (recorded as { history?: unknown[] }).history?.length) commands.push({ id: 'layout-undo', label: 'Undo layout change', icon: 'refresh', run: () => void undoLayout() });
    onCommands(commands.length ? { label: 'Layout', commands } : null);
  }, [focused, recorded, snapshot.catalog, layout.views]);
  useEffect(() => () => onCommands?.(null), []);
  const tabId = useId(), narrowList = useRef<HTMLDivElement>(null);
  useTabOverflow(narrowList, focused, narrow);
  function moveNarrow(event: KeyboardEvent<HTMLDivElement>) {
    const index = order.indexOf(focused), count = order.length;
    const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); show(order[next]); event.currentTarget.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  }
  const focusObject = live.screen?.views.find(v => v.id === focused)?.object ?? null;
  const toggleEvidence = () => { setEvidence(v => !v); onShowAgent?.(); live.act({ kind: 'reveal', target: evidence ? null : live.screen?.agent?.object ?? 'workspace' }); };
  const statusBar = bar && <Bar live={live} evidence={evidence} held={items.length - unhidden.length} onEvidence={toggleEvidence} attention={attention} />;
  return <ShellContext.Provider value={shellHere}><WorkspaceViewsContext.Provider value={views}><section className="workspace shell" aria-label="Layout">
    {/* In the page's own bar when it gives one; until that bar is there, nowhere. */}
    {statusBar && (barTarget ? createPortal(statusBar, barTarget) : barTarget === undefined && statusBar)}
    {agentTarget && createPortal(<AgentColumn live={live} agents={snapshot.agents} contexts={snapshot.contexts} prepare={prepareQuestion} principalId={principalId} evidence={evidence} onEvidence={toggleEvidence} focusObject={focusObject} />, agentTarget)}
    <Interruption live={live} items={unhidden} onHide={key => setHidden(h => [...h, key])} />
    {layoutProblem && <div className="shell-interruption problem" data-rho-layer="transient" data-rho-interruption="" role="alert"><span className="shell-interruption-text">{layoutProblem}</span><button className="shell-quiet" onClick={() => setLayoutProblem('')}>Dismiss</button></div>}
    <Digest live={live} />
    <div ref={stage} className="shell-stage" onPointerDownCapture={event => live.hold((event.target as HTMLElement).closest<HTMLElement>('[data-owner-view]')?.dataset.ownerView ?? focused)} onKeyDownCapture={event => { live.hold(focused); if (!event.metaKey && !event.ctrlKey && event.key.length === 1) onPersonMoved?.(); }} onCompositionStartCapture={() => live.hold(focused)}>
      {contextTarget && feedbackContextActive && feedbackSource && feedbackAllowed && feedbackEntry && snapshot.feedback?.draftDocumentId && createPortal(feedbackLimit ? <section className="unavailable" role="status"><h3>Close a view before opening feedback</h3><p>Existing views and input are kept within this layout's view limit.</p></section> : <feedbackEntry.View key={[snapshot.project.id, snapshot.feedback.taskId, feedbackSource, principalId].join(':')} viewId={'feedback:' + feedbackSource} view={{ id: 'feedback:' + feedbackSource, component: feedbackEntry.component, version: feedbackEntry.componentVersion, props: { title: 'Your question', taskId: snapshot.feedback.taskId, sourceSelectionScope: byId.get(feedbackSource) ? selectionScope(byId.get(feedbackSource)!) : { kind: 'shared', id: feedbackSource } }, bindings: { draft: { kind: 'live-document', documentId: snapshot.feedback.draftDocumentId } } }} projectId={snapshot.project.id} snapshot={snapshot} client={client} active principalId={principalId} contextTarget={null} feedbackConfiguration={{ ...snapshot.feedback, draftDocumentId: snapshot.feedback.draftDocumentId }} />, contextTarget)}
      {!root ? empty ?? <div className="empty"><h2>No views in this layout</h2><p>The saved layout is empty. No view is created automatically.</p></div>
        : narrow ? <section className="shell-group">
          <div className="shell-tabbar"><div ref={narrowList} className="shell-tabs" role="tablist" aria-label="Views" onKeyDown={moveNarrow}>
            {order.map((id, i) => <div key={id} className="shell-tab" data-closable={canArrange ? '' : undefined}>
              <button aria-label={title(byId.get(id)!)} id={tabId + i} role="tab" aria-selected={id === focused} aria-controls={tabId + 'panel'} tabIndex={id === focused ? 0 : -1} aria-keyshortcuts={canArrange ? 'Delete' : undefined} onClick={() => { if (id !== focused) onPersonMoved?.(); show(id); }}
                onKeyDown={event => { if (event.key === 'Delete' && canArrange) { event.preventDefault(); closeTab(id); } }}><TabName name={title(byId.get(id)!)} /></button>
              {canArrange && id === focused && <button className="shell-tab-close" tabIndex={-1} aria-hidden="true" title={'Close ' + title(byId.get(id)!)} onClick={() => closeTab(id)}><Icon name="close" size={12} stroke={2} /></button>}
            </div>)}
          </div>{canArrange && addView && <AddButton name="Views" content={() => addView(groupNode(groupOf(root, focused)?.id ?? root.id))} />}</div>
          <div className="shell-header-slot shell-header-narrow" ref={headerRef('narrow')} />
          {focused && <Slot key={focused} container={container(focused)} id={tabId + 'panel'} labelledBy={tabId + order.indexOf(focused)} />}
        </section>
        : draw(alone ?? root)}
      {/* While something is dragged, each side of the whole page takes it as a column or a row. */}
      {drag?.dragging && !narrow && <div className="shell-edges" aria-hidden="true">
        {(['left', 'right', 'top', 'bottom'] as Side[]).map(side => <div key={side} className="shell-edge" data-side={side} data-over={drag.target && 'edge' in drag.target && drag.target.edge === side ? '' : undefined}
          onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (!(drag.target && 'edge' in drag.target && drag.target.edge === side)) drag.over({ edge: side }); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) drag.over(null); }}
          onDrop={event => { event.preventDefault(); drag.drop({ edge: side }); }} />)}
        {drag.target && 'edge' in drag.target && <div className="shell-edge-preview" data-side={drag.target.edge} />}
      </div>}
      {closed && canArrange && <div className="shell-closed" role="status"><span>Closed {closed.label}</span><button className="shell-link" onClick={() => void undoClose()}>Undo</button><button className="shell-quiet" aria-label="Dismiss" onClick={() => setClosed(null)}><Icon name="close" size={13} /></button></div>}
      {[...seen.current].filter(id => byId.has(id)).map(id => createPortal(body(id), container(id), id))}
    </div>
  </section></WorkspaceViewsContext.Provider></ShellContext.Provider>;
}
