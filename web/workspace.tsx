import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { DockviewReact, themeLight, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewPanelHeaderProps } from 'dockview-react';
import { createPortal } from 'react-dom';
import type { BrowserClient, CompositionSummary, ViewDescription, WorkspaceSnapshot } from '../src/browser.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { Icon, type IconName } from './icons.js';
import { resourceIcon } from './project.js';
import { registry } from './registry.js';
import { FrameProvider, MapPlacement, ViewItemHeader, itemForView, useFrameContext, useTaskFrame } from './frame.js';
import { ArtifactSource } from './artifact.js';
import { boundResource } from './executions.js';
import 'dockview/dist/styles/dockview.css';

interface ViewParams { view: ViewDescription; snapshot: WorkspaceSnapshot; client: BrowserClient; onAbout: (pluginId: string) => void; contextTarget: HTMLElement | null; principalId?: string; renderAllowed?: boolean; headerTarget?: HTMLElement | null; compositionId: string; compositionVersion: number; onRequestFeedback?: (viewId: string) => void; onOpenView?: (viewId: string) => void }
const clientEpoch = crypto.randomUUID();
type Binding = { documentId?: string; id?: string; version?: string | number };
const title = (view: ViewDescription) => String(view.props.title ?? view.props.label ?? view.component);
function bindings(view: ViewDescription) { return Object.entries(view.bindings ?? {}) as [string, Binding][]; }
// The tab and body icon follow what the view is bound to.
function viewIcon(view: ViewDescription, snapshot: WorkspaceSnapshot): IconName {
  const [, first] = bindings(view)[0] ?? [];
  if (first?.documentId) return 'document';
  const resource = first?.id ? snapshot.resources.find(r => r.id === first.id) : undefined;
  return resource ? resourceIcon(resource.kind) : 'layout';
}
// Explains an unavailable view in the reader's terms; identifiers stay in the View reference.
function explain(view: ViewDescription, snapshot: WorkspaceSnapshot) {
  const { catalog } = snapshot;
  const component = catalog.components.find(c => c.id === view.component && c.version === view.version) ?? catalog.components.find(c => c.id === view.component);
  const plugin = component?.pluginId ? catalog.plugins.find(p => p.id === component.pluginId) : undefined;
  const viewName = component?.presentation?.displayName ?? view.component, pluginName = plugin ? pluginPresentation(plugin).displayName : '';
  const shown = bindings(view).map(([, b]) => {
    if (b.documentId) {
      const doc = snapshot.documents.find(d => d.id === b.documentId);
      return doc ? { subject: doc.path + ' and its saved content are', line: `${doc.path} · version ${b.version} · ${doc.dirty ? 'unsaved changes' : 'saved'}` } : { subject: 'Its document is', line: "A document that isn't open in this project" };
    }
    const resource = snapshot.resources.find(r => r.id === b.id);
    return resource ? { subject: resource.path + ' is', line: `${resource.path} · ${resource.kind}` } : { subject: 'Its file is', line: "A file that isn't registered in this project" };
  });
  const untouched = `${shown[0]?.subject ?? 'Its content is'} untouched. Nothing was installed or rerun.`;
  let lead: string, build: string;
  if (!plugin) { lead = 'No plugin in this build provides this view.'; build = 'No installed plugin provides this view'; }
  else if (!plugin.selected || !plugin.packagePresent || plugin.state !== 'available') { lead = `The ${viewName} view comes from ${pluginName}, which isn't available in this build.`; build = `${pluginName} isn't available in this build`; }
  else if (!plugin.projectEnabled) { lead = `${pluginName} is off for this project, so its ${viewName} view isn't shown.`; build = `${pluginName} is off for this project`; }
  else if (!plugin.dependenciesSatisfied) { lead = `${pluginName} is waiting for a plugin it needs, so its ${viewName} view isn't shown.`; build = `${pluginName} is waiting for a plugin it needs`; }
  else { lead = `This build doesn't include the ${viewName} view yet.`; build = `${pluginName} is on here; its view isn't in this build yet`; }
  return { lead: lead + ' ' + untouched, shows: shown.map(s => s.line).join('; '), needs: plugin ? `The ${viewName} view, from the ${pluginName} plugin` : `The ${viewName} view`, build, plugin, pluginName };
}
function OwnerView({ params, active }: { params: ViewParams; active: boolean }) {
  const { view, snapshot } = params;
  const frame = useFrameContext(), item = itemForView(frame?.map, view.id);
  const entry = registry.entries.find(e => e.component === view.component && e.componentVersion === view.version);
  const owner = snapshot.catalog.components.find(c => c.id === view.component && c.version === view.version);
  const provider = snapshot.catalog.plugins.find(p => p.id === owner?.pluginId);
  const available = entry && owner && provider?.projectEnabled && provider.dependenciesSatisfied && provider.state === 'available' && entry.requiredOperations.every(method => snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized));
  if (available && params.renderAllowed === false) return <section className="unavailable" role="status"><h2>This layout has reached its view limit</h2><p>Existing views and input are kept. Close another view before opening this one.</p></section>;
  const witness = snapshot.presentation?.witnesses.find(w => w.compositionId === params.compositionId && w.compositionVersion === params.compositionVersion && w.views.some(v => v.viewId === view.id));
  const observation = witness && params.principalId && snapshot.catalog.operations.some(o => o.method === 'view.observe' && o.authorized && o.state === 'available') ? async (value: any) => {
    const input = { ...value, projectId: snapshot.project.id, taskId: snapshot.presentation!.taskId, compositionId: params.compositionId, compositionVersion: params.compositionVersion, witnessId: witness.witnessId, viewId: view.id, observationId: crypto.randomUUID(), clientId: params.principalId, clientEpoch, rendererBuild: import.meta.env.VITE_RHO_RENDERER_BUILD };
    // Retry an uncertain transport with exactly the same observation identity.
    try { await params.client.call('view.observe', input); }
    catch (error: any) { if (error?.error?.kind || error?.kind) throw error; await params.client.call('view.observe', input); }
  } : undefined;
  if (available) {
    const body = <entry.View viewId={view.id} view={view} projectId={snapshot.project.id} snapshot={snapshot} client={params.client} active={active} contextTarget={params.contextTarget} principalId={params.principalId} headerTarget={params.headerTarget} renderObservation={observation} requestFeedback={params.onRequestFeedback ? () => params.onRequestFeedback!(view.id) : undefined}
      frame={frame ? { ...frame, form: 'full', params: frame.map.presentation['item:' + item?.id]?.params ?? {}, item } : undefined} />;
    // Which execution produced this version, and what checks it did or did not pass,
    // belongs to the object and is drawn once by the shell above the owner's body.
    const resource = boundResource(view, snapshot.resources);
    const source = resource ? <ArtifactSource resource={resource} viewId={view.id} snapshot={snapshot} client={params.client} onOpenView={params.onOpenView} /> : null;
    if (item) return <div className="framed-view"><ViewItemHeader item={item} />{source}<div className="framed-view-body">{body}</div></div>;
    return source ? <div className="framed-view">{source}<div className="framed-view-body">{body}</div></div> : body;
  }
  const why = explain(view, snapshot);
  return <section className="unavailable" aria-label={title(view)}>
    <span className="unavailable-icon"><Icon name={viewIcon(view, snapshot)} size={22} stroke={1.7} /></span>
    <h2>This view can't be shown here yet</h2>
    <p>{why.lead}</p>
    <dl className="unavailable-facts">
      {why.shows && <div><dt>Shows</dt><dd>{why.shows}</dd></div>}
      <div><dt>Needs</dt><dd>{why.needs}</dd></div>
      <div><dt>In this build</dt><dd>{why.build}</dd></div>
    </dl>
    <div className="unavailable-actions">
      {why.plugin && <button className="quiet-button" onClick={() => params.onAbout(why.plugin!.id)}>About {why.pluginName}</button>}
      <details className="view-reference"><summary>View reference</summary>
        <dl>
          <div><dt>View</dt><dd>{view.id}</dd></div>
          <div><dt>Component</dt><dd>{view.component}@{view.version}</dd></div>
          {bindings(view).map(([key, b]) => <div key={key}><dt>{key}</dt><dd>{(b.documentId ?? b.id) + '@' + b.version}</dd></div>)}
          {view.protected && <div><dt>Protected</dt><dd>yes</dd></div>}
        </dl>
      </details>
    </div>
  </section>;
}
function ViewContent({ params, api }: IDockviewPanelProps<ViewParams>) {
  const [active, setActive] = useState(api.isActive);
  useEffect(() => { const listener = api.onDidActiveChange(event => setActive(event.isActive)); return () => listener.dispose(); }, [api]);
  return <OwnerView params={params} active={active} />;
}
function Tab({ params }: IDockviewPanelHeaderProps<ViewParams>) {
  return <span className="retained-tab" style={params.view.presentation?.emphasis === 'highlight' ? { boxShadow: 'inset 0 -2px var(--color-accent)', color: 'var(--color-accent)' } : undefined}><Icon name={viewIcon(params.view, params.snapshot)} size={14} stroke={2} />{title(params.view)}</span>;
}
const HeaderSlotContext = createContext<(target: HTMLDivElement | null) => void>(() => {});
function HeaderSlot() { return <div className="owner-header-slot" style={{ display: 'flex', alignItems: 'center', minHeight: 32, flexShrink: 0 }} ref={useContext(HeaderSlotContext)} />; }
const components = { owner: ViewContent }, tabs = { retained: Tab };
export function Workspace({ composition, snapshot, client, onAbout, contextTarget, principalId, onShowContext, feedbackContextActive, mapChipTarget, openView }: { composition: CompositionSummary; snapshot: WorkspaceSnapshot; client: BrowserClient; onAbout: (pluginId: string) => void; contextTarget: HTMLElement | null; principalId?: string; onShowContext: () => void; feedbackContextActive: boolean; mapChipTarget?: HTMLElement | null; openView?: string }) {
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [feedbackSource, setFeedbackSource] = useState<string | null>(null), [feedbackLimit, setFeedbackLimit] = useState(false);
  const mounted = useRef(new Set<string>());
  const maxMountedViews = Math.max(1, Math.min(8, Number(import.meta.env.VITE_RHO_MAX_HEAVY_VIEWS) || 8));
  for (const id of mounted.current) if (!composition.views.some(v => v.id === id)) mounted.current.delete(id);
  for (const view of composition.views) if (mounted.current.size < maxMountedViews - (contextTarget && feedbackContextActive && feedbackSource && !feedbackLimit ? 1 : 0) && registry.entries.some(e => e.component === view.component)) mounted.current.add(view.id);
  const [api, setApi] = useState<DockviewApi | null>(null);
  // Switching to a view that already exists: an artifact names the other files of
  // its execution and the shell brings that view forward rather than opening another.
  const showView = useCallback((id: string) => { setActive(id); api?.getPanel(id)?.api.setActive(); }, [api]);
  const arranged = useRef('');
  const [active, setActive] = useState(composition.views[0]?.id ?? '');
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  // The wide Dockview instance is disposed when the narrow tab surface mounts.
  // Do not reuse its API during the first render after returning to wide mode.
  useEffect(() => { if (narrow) { setApi(null); arranged.current = ''; } }, [narrow]);
  const feedbackEntry = registry.entries.find(e => e.component === 'rho.feedback');
  const feedbackAllowed = !!snapshot.feedback && feedbackEntry?.requiredOperations.every(method => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available'));
  useEffect(() => { setFeedbackSource(null); setFeedbackLimit(false); }, [snapshot.project.id, composition.compositionId, snapshot.feedback?.taskId, principalId]);
  const requestFeedback = feedbackAllowed ? (viewId: string) => { setFeedbackLimit(mounted.current.size >= maxMountedViews); setFeedbackSource(viewId); onShowContext(); } : undefined;
  useEffect(() => {
    const query = matchMedia('(max-width: 767px)');
    const changed = () => setNarrow(query.matches);
    query.addEventListener('change', changed); return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!api || narrow) return;
    const current = api, previousActive = current.activePanel?.id;
    for (const panel of current.panels) if (!composition.views.some(v => v.id === panel.id)) current.removePanel(panel);
    for (const view of composition.views) {
      const panel = current.getPanel(view.id), params = { view, snapshot, client, onAbout, contextTarget: feedbackContextActive ? null : contextTarget, principalId, renderAllowed: mounted.current.has(view.id), headerTarget, compositionId: composition.compositionId, compositionVersion: composition.version, onRequestFeedback: requestFeedback, onOpenView: showView };
      if (panel) { panel.api.updateParameters(params); panel.api.setTitle(title(view)); }
      // New views join the existing group as tabs, in layout order, rather than opening a new group.
      else current.addPanel({ id: view.id, component: 'owner', tabComponent: 'retained', title: title(view), params, inactive: true, ...(current.panels.length ? { position: { referencePanel: current.panels.at(-1)!.id } } : {}) });
    }
    const signature = JSON.stringify([composition.compositionId, composition.rootId, composition.nodes?.map(n => n.kind === 'group' ? n : { id: n.id })]);
    if (signature !== arranged.current && composition.nodes && composition.rootId) {
      const nodes = new Map(composition.nodes.map(n => [n.id, n]));
      const leaves = (id: string): string[] => { const n = nodes.get(id); return !n ? [] : n.kind === 'view' ? [n.id] : n.children.flatMap(leaves); };
      const arrange = (id: string) => {
        const group = nodes.get(id);
        if (!group || group.kind !== 'group') return;
        const parts = group.children.map(child => leaves(child)).filter(ids => ids.length);
        for (let i = 1; i < parts.length; i++) {
          const target = current.getPanel(parts[i - 1][0]), panel = current.getPanel(parts[i][0]);
          if (!target || !panel) continue;
          if (group.presentation?.mode === 'split') panel.api.moveTo({ group: target.api.group, position: group.presentation.axis === 'vertical' ? 'bottom' : 'right', skipSetActive: true });
          else for (const id of parts[i]) current.getPanel(id)?.api.moveTo({ group: target.api.group, position: 'center', skipSetActive: true });
        }
        group.children.forEach(arrange);
        if (group.presentation?.mode === 'split') {
          const weights = group.presentation.weights!, total = weights.reduce((a, b) => a + b, 0);
          for (let i = 0; i < parts.length; i++) {
            const panel = current.getPanel(parts[i][0]);
            if (panel) { panel.api.group.api.setSize(group.presentation.axis === 'vertical' ? { height: current.height * weights[i] / total } : { width: current.width * weights[i] / total }); panel.api.setActive(); }
          }
        }
      };
      const focused = document.activeElement as HTMLElement | null;
      arrange(composition.rootId); arranged.current = signature;
      if (previousActive) current.getPanel(previousActive)?.api.setActive();
      if (focused?.isConnected && focused !== document.body) focused.focus({ preventScroll: true });
    }
    const target = current.getPanel(active) ?? current.panels[0];
    if (!current.activePanel && target) target.api.setActive();
  }, [composition, snapshot, client, api, narrow, contextTarget, principalId, headerTarget, feedbackContextActive]);
  useEffect(() => {
    if (!api || narrow) return;
    const listener = api.onDidActivePanelChange(({ panel }) => { if (panel) setActive(panel.id); });
    return () => listener.dispose();
  }, [api, narrow]);
  // A named view is one the person chose on the project page; it is brought forward
  // once, and their own tab changes are left alone afterwards.
  const brought = useRef('');
  useEffect(() => {
    if (!openView || brought.current === openView || !composition.views.some(v => v.id === openView)) return;
    brought.current = openView; setActive(openView);
    api?.getPanel(openView)?.api.setActive();
  }, [openView, composition, api]);
  function onReady(event: DockviewReadyEvent) { arranged.current = ''; setApi(event.api); }
  const frame = useTaskFrame({ snapshot, client, principalId, composition, activeViewId: active });
  // A person opening an item brings its view forward; the Agent's focus only highlights.
  const opened = useRef('');
  useEffect(() => {
    const focus = frame?.map.focus, item = focus && frame.map.items.find(i => i.id === focus.item);
    if (!focus || !focus.human || focus.author !== principalId || opened.current === focus.at || !item?.view || !composition.views.some(v => v.id === item.view)) return;
    opened.current = focus.at; setActive(item.view);
    api?.getPanel(item.view)?.api.setActive();
  }, [frame?.map.focus, composition, api, principalId]);
  const whole = frame?.map.presentation['map:top']?.form === 'full';
  const trail = !!frame && frame.map.items.some(i => i.view === active);
  const selected = composition.views.find(v => v.id === active) ?? composition.views[0];
  const tabId = useId();
  // Below 768 the views are tabs: arrows, Home and End move between them and show the view.
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    const count = composition.views.length, index = composition.views.findIndex(v => v.id === selected?.id);
    const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); setActive(composition.views[next].id);
    (event.currentTarget.children[next] as HTMLElement).focus();
  }
  return <FrameProvider value={frame}><HeaderSlotContext.Provider value={setHeaderTarget}><section className="workspace" aria-label="Layout">
    {mapChipTarget && frame && createPortal(<MapPlacement slot="title" inline />, mapChipTarget)}
    <MapPlacement slot="top" />
    {/* The whole-task form is a band above the work, not a replacement for it: a
        person can read the map and still act on the artifact underneath. */}
    <div className="workspace-stage">
    {contextTarget && feedbackContextActive && feedbackSource && feedbackAllowed && feedbackEntry && snapshot.feedback?.draftDocumentId && createPortal(feedbackLimit ? <section className="unavailable" role="status"><h3>Close a view before opening feedback</h3><p>Existing views and input are kept within this layout's view limit.</p></section> : <feedbackEntry.View key={[snapshot.project.id, snapshot.feedback.taskId, feedbackSource, principalId].join(':')} viewId={'feedback:' + feedbackSource} view={{ id: 'feedback:' + feedbackSource, component: feedbackEntry.component, version: feedbackEntry.componentVersion, props: { title: 'Your question', taskId: snapshot.feedback.taskId, sourceSelectionScope: { kind: 'shared', id: feedbackSource } }, bindings: { draft: { kind: 'live-document', documentId: snapshot.feedback.draftDocumentId } } }} projectId={snapshot.project.id} snapshot={snapshot} client={client} active principalId={principalId} contextTarget={null} feedbackConfiguration={{ ...snapshot.feedback, draftDocumentId: snapshot.feedback.draftDocumentId }} />, contextTarget)}
    {!composition.views.length ? <div className="empty"><h2>No views in this layout</h2><p>The saved layout is empty. No view is created automatically.</p></div> :
      narrow ? <>
        <div className="view-tabs" role="tablist" aria-label="Views" onKeyDown={moveTab}>
          {composition.views.map((v, index) => <button key={v.id} id={tabId + index} role="tab" style={v.presentation?.emphasis === 'highlight' ? { boxShadow: 'inset 0 -2px var(--color-accent)', color: 'var(--color-accent)' } : undefined} aria-selected={v === selected} aria-controls={tabId + 'panel'} tabIndex={v === selected ? 0 : -1} onClick={() => setActive(v.id)}>{title(v)}</button>)}
        </div>
        <HeaderSlot />
        <div id={tabId + 'panel'} className="mobile-view" role="tabpanel" aria-labelledby={tabId + composition.views.indexOf(selected!)}>{selected && <OwnerView params={{ view: selected, snapshot, client, onAbout, contextTarget: feedbackContextActive ? null : contextTarget, principalId, renderAllowed: true, headerTarget, compositionId: composition.compositionId, compositionVersion: composition.version, onRequestFeedback: requestFeedback, onOpenView: showView }} active />}</div>
      </> :
        <div className="dock-container"><DockviewReact rightHeaderActionsComponent={HeaderSlot} theme={themeLight} className="rho-dock" components={components} tabComponents={tabs} onReady={onReady} disableDnd disableFloatingGroups /></div>}
    </div>
    {!whole && trail && <MapPlacement slot="bottom" compact />}
  </section></HeaderSlotContext.Provider></FrameProvider>;
}
