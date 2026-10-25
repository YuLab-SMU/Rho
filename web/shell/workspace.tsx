import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserClient, CompositionSummary, WorkspaceSnapshot } from '../../src/browser.js';
import { groupOf, regions, tabGroups, viewOrder, type Region } from '../../src/shell-layout.js';
import { Icon } from '../icons.js';
import { registry } from '../registry.js';
import { useLive } from './live.js';
import { OwnerView, availableEntry, title, viewIcon } from './owner.js';
import { Bar, Digest, Evidence, Interruption, waiting } from './layer.js';
import { RunView, SourceLine } from './facts.js';
import { ActionForm } from './action-form.js';
import { boundResource } from '../executions.js';
import { Slot, Split, TabGroup, place, unplace, useTabOverflow, type TabRender } from './regions.js';
import './shell.css';

type Tabs = Extract<Region, { kind: 'tabs' }>;
// The workspace shell (docs/WORKSPACE-PLAN.md W1): the owner's composition tree drawn as
// splits and tab groups, owner views mounted within the rendering budget, and a slot for
// what Rho adds above the work. It decides nothing about attention; useLive does.
export function Workspace({ composition: recorded, snapshot, client, onAbout, contextTarget, principalId, onShowContext, feedbackContextActive, openView }: { composition: CompositionSummary; snapshot: WorkspaceSnapshot; client: BrowserClient; onAbout: (pluginId: string) => void; contextTarget: HTMLElement | null; principalId?: string; onShowContext: () => void; feedbackContextActive: boolean; mapChipTarget?: HTMLElement | null; openView?: string }) {
  const live = useLive(snapshot, recorded, client, principalId), layout = live.layout;
  const root = useMemo(() => regions(layout), [layout]);
  const order = useMemo(() => viewOrder(root), [root]);
  const byId = useMemo(() => new Map(layout.views.map(v => [v.id, v])), [layout]);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => { const q = matchMedia('(max-width: 767px)'), change = () => setNarrow(q.matches); q.addEventListener('change', change); return () => q.removeEventListener('change', change); }, []);
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
  useEffect(() => {
    if (!live.active || !byId.has(live.active)) return;
    // Keyboard focus inside a view is the person's place: a move the owners' records make
    // that would hide it holds it instead, so the move waits as it does while the person works.
    const here = document.activeElement?.closest<HTMLElement>('[data-owner-view]')?.dataset.ownerView;
    if (live.movedBy === 'owners' && here && here !== live.active && byId.has(here) && (narrow || groupOf(root, here)?.id === groupOf(root, live.active)?.id)) { live.hold(here); return; }
    bring(live.active);
  }, [live.active, root]);
  const brought = useRef('');
  useEffect(() => { if (openView && brought.current !== openView && byId.has(openView)) { brought.current = openView; show(openView); } }, [openView, byId]);
  const focused = order.includes(focus) ? focus : order[0] ?? '';
  const groups = root ? tabGroups(root) : [];
  const visible = narrow ? (focused ? [focused] : []) : groups.map(shown);
  // Divider positions the person set in this tab, until the owner's layout changes.
  const [weights, setWeights] = useState<{ version: number; values: Record<string, number[]> }>({ version: layout.version, values: {} });
  const own = weights.version === layout.version ? weights.values : {};
  // Eight mounted heavy entries is a rendering budget, never a buffer eviction: render
  // rights go to the first eight available views in layout order, and a view mounts the
  // first time it shows.
  const feedbackEntry = registry.entries.find(e => e.component === 'rho.feedback');
  const feedbackAllowed = !!snapshot.feedback && feedbackEntry?.requiredOperations.every(method => snapshot.catalog.operations.some(o => o.method === method && o.authorized && o.state === 'available'));
  const [feedbackSource, setFeedbackSource] = useState<string | null>(null), [feedbackLimit, setFeedbackLimit] = useState(false);
  useEffect(() => { setFeedbackSource(null); setFeedbackLimit(false); }, [snapshot.project.id, layout.compositionId, snapshot.feedback?.taskId, principalId]);
  const maxMounted = Math.max(1, Math.min(8, Number(import.meta.env.VITE_RHO_MAX_HEAVY_VIEWS) || 8));
  const rights = useRef(new Set<string>()), seen = useRef(new Set<string>());
  for (const id of rights.current) if (!byId.has(id)) rights.current.delete(id);
  for (const id of seen.current) if (!byId.has(id)) seen.current.delete(id);
  const reserve = contextTarget && feedbackContextActive && feedbackSource && !feedbackLimit ? 1 : 0;
  for (const id of order) if (rights.current.size < maxMounted - reserve && availableEntry(byId.get(id)!, snapshot)) rights.current.add(id);
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
    if (view.component === 'rho.execution') return <RunView live={live} snapshot={snapshot} client={client} operationId={String(view.props.operationId ?? id)} onOpenRef={openRef} />;
    const resource = boundResource(view, snapshot.resources);
    const annotations = snapshot.catalog.plugins.find(p => p.id === 'annotations');
    const Question = resource?.kind === 'table' && annotations?.projectEnabled && annotations.dependenciesSatisfied && annotations.state === 'available' ? registry.entries.find(e => e.component === 'rho.feedback')?.TableQuestion : undefined;
    const owner = <OwnerView active={isVisible} params={{
      view, snapshot, client, principalId, compositionId: layout.compositionId, compositionVersion: layout.version,
      // One view at a time owns the context panel: the one with focus.
      contextTarget: id === focused && !feedbackContextActive ? contextTarget : null, headerTarget: isVisible ? ownHeader(id) : null,
      renderAllowed: rights.current.has(id), onAbout, onRequestFeedback: requestFeedback,
    }} />;
    if (!resource) return owner;
    return <><SourceLine live={live} snapshot={snapshot} resource={resource} viewId={id} onOpenRef={openRef}>
      {Question && <Question key={resource.id + resource.version + id} projectId={snapshot.project.id} viewId={id} resource={resource} snapshot={snapshot} client={client} principalId={principalId} headerTarget={ownHeader(id)} onOpenResource={openRef} requestFeedback={requestFeedback ? () => requestFeedback(id) : undefined} />}
    </SourceLine>{owner}</>;
  };
  const render: TabRender = {
    label: id => title(byId.get(id)!, snapshot), container,
    title: id => { const v = byId.get(id)!; return <><Icon name={viewIcon(v, snapshot)} size={14} stroke={2} /><span className="shell-tab-name">{title(v, snapshot)}</span></>; },
  };
  const groupName = (id: string) => groups.length === 1 ? 'Views' : `Views ${groups.findIndex(g => g.id === id) + 1} of ${groups.length}`;
  const firstTitle = (region: Region): string => { const id = region.kind === 'tabs' ? shown(region) : viewOrder(region)[0]; return id ? title(byId.get(id)!, snapshot) : 'view'; };
  const draw = (region: Region): ReactNode => region.kind === 'tabs'
    ? <TabGroup key={region.id} group={region} name={groupName(region.id)} selected={shown(region)} onSelect={show} onHeader={headerRef(region.id)} render={render} />
    : <Split key={region.id} region={region} weights={own[region.id] ?? region.weights} onResize={values => setWeights(w => ({ version: layout.version, values: { ...(w.version === layout.version ? w.values : {}), [region.id]: values } }))}
      label={i => `Resize ${firstTitle(region.children[i - 1])} and ${firstTitle(region.children[i])}`}>{region.children.map(draw)}</Split>;
  const tabId = useId(), narrowList = useRef<HTMLDivElement>(null);
  useTabOverflow(narrowList, focused, narrow);
  function moveNarrow(event: KeyboardEvent<HTMLDivElement>) {
    const index = order.indexOf(focused), count = order.length;
    const next = { ArrowRight: (index + 1) % count, ArrowLeft: (index - 1 + count) % count, Home: 0, End: count - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); show(order[next]); (event.currentTarget.children[next] as HTMLElement).focus();
  }
  return <section className="workspace shell" aria-label="Layout">
    <Bar live={live} focusObject={live.screen?.views.find(v => v.id === focused)?.object ?? null} evidence={evidence} held={items.length - unhidden.length} narrow={narrow}
      onEvidence={() => { setEvidence(v => !v); live.act({ kind: 'reveal', target: evidence ? null : live.screen?.agent?.object ?? 'workspace' }); }} />
    <Interruption live={live} items={unhidden} onHide={key => setHidden(h => [...h, key])} />
    {evidence ? <Evidence live={live} principalId={principalId} /> : <Digest live={live} />}
    <div className="shell-stage" onPointerDownCapture={event => live.hold((event.target as HTMLElement).closest<HTMLElement>('[data-owner-view]')?.dataset.ownerView ?? focused)} onKeyDownCapture={() => live.hold(focused)} onCompositionStartCapture={() => live.hold(focused)}>
      {contextTarget && feedbackContextActive && feedbackSource && feedbackAllowed && feedbackEntry && snapshot.feedback?.draftDocumentId && createPortal(feedbackLimit ? <section className="unavailable" role="status"><h3>Close a view before opening feedback</h3><p>Existing views and input are kept within this layout's view limit.</p></section> : <feedbackEntry.View key={[snapshot.project.id, snapshot.feedback.taskId, feedbackSource, principalId].join(':')} viewId={'feedback:' + feedbackSource} view={{ id: 'feedback:' + feedbackSource, component: feedbackEntry.component, version: feedbackEntry.componentVersion, props: { title: 'Your question', taskId: snapshot.feedback.taskId, sourceSelectionScope: { kind: 'shared', id: feedbackSource } }, bindings: { draft: { kind: 'live-document', documentId: snapshot.feedback.draftDocumentId } } }} projectId={snapshot.project.id} snapshot={snapshot} client={client} active principalId={principalId} contextTarget={null} feedbackConfiguration={{ ...snapshot.feedback, draftDocumentId: snapshot.feedback.draftDocumentId }} />, contextTarget)}
      {!root ? <div className="empty"><h2>No views in this layout</h2><p>The saved layout is empty. No view is created automatically.</p></div>
        : narrow ? <section className="shell-group">
          <div className="shell-tabbar"><div ref={narrowList} className="shell-tabs" role="tablist" aria-label="Views" onKeyDown={moveNarrow}>
            {order.map((id, i) => <button key={id} id={tabId + i} role="tab" aria-selected={id === focused} aria-controls={tabId + 'panel'} tabIndex={id === focused ? 0 : -1} onClick={() => show(id)}><span className="shell-tab-name">{title(byId.get(id)!, snapshot)}</span></button>)}
          </div></div>
          <div className="shell-header-slot shell-header-narrow" ref={headerRef('narrow')} />
          {focused && <Slot key={focused} container={container(focused)} id={tabId + 'panel'} labelledBy={tabId + order.indexOf(focused)} />}
        </section>
        : draw(root)}
      {[...seen.current].filter(id => byId.has(id)).map(id => createPortal(body(id), container(id), id))}
    </div>
  </section>;
}
