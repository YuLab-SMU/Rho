import { useEffect, useState } from 'react';
import { DockviewReact, themeLight, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewPanelHeaderProps } from 'dockview-react';
import type { BrowserClient, CompositionSummary, ViewDescription, WorkspaceSnapshot } from '../src/browser.js';
import { registry } from './registry.js';
import 'dockview/dist/styles/dockview.css';

interface ViewParams { view: ViewDescription; snapshot: WorkspaceSnapshot; client: BrowserClient }
function OwnerView({ params, active }: { params: ViewParams; active: boolean }) {
  const entry = registry.entries.find(e => e.component === params.view.component && e.componentVersion === params.view.version);
  const owner = params.snapshot.catalog.components.find(c => c.id === params.view.component && c.version === params.view.version);
  const available = entry && owner && entry.requiredOperations.every(method => params.snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized));
  if (available) return <entry.View viewId={params.view.id} view={params.view} projectId={params.snapshot.project.id} snapshot={params.snapshot} client={params.client} active={active} />;
  return <section className="unavailable" aria-label={String(params.view.props.title ?? params.view.component)}>
    <span className="eyebrow">Retained view</span><h2>This view is unavailable</h2>
    <p>The required renderer is not available in this build or project. The owner retains the resource and confirmed content. Nothing is installed or replayed.</p>
    {params.view.protected && <p className="badge">Protected view</p>}
    <details><summary>View reference</summary><pre>{JSON.stringify({ viewId: params.view.id, component: params.view.component, version: params.view.version, bindings: params.view.bindings }, null, 2)}</pre></details>
  </section>;
}
function ViewContent({ params, api }: IDockviewPanelProps<ViewParams>) {
  const [active, setActive] = useState(api.isActive);
  useEffect(() => { const listener = api.onDidActiveChange(event => setActive(event.isActive)); return () => listener.dispose(); }, [api]);
  return <OwnerView params={params} active={active} />;
}
function Tab({ params }: IDockviewPanelHeaderProps<ViewParams>) {
  return <span className="retained-tab">{params.view.protected ? 'Protected / ' : ''}{String(params.view.props.title ?? params.view.component)}</span>;
}
const components = { owner: ViewContent }, tabs = { retained: Tab };
export function Workspace({ composition, snapshot, client }: { composition: CompositionSummary; snapshot: WorkspaceSnapshot; client: BrowserClient }) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [active, setActive] = useState(composition.views[0]?.id ?? '');
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = matchMedia('(max-width: 767px)');
    const changed = () => setNarrow(query.matches);
    query.addEventListener('change', changed); return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!api || narrow) return;
    const current = api;
    for (const panel of current.panels) if (!composition.views.some(v => v.id === panel.id)) current.removePanel(panel);
    for (const view of composition.views) {
      const panel = current.getPanel(view.id);
      if (panel) { panel.api.updateParameters({ view, snapshot, client }); panel.api.setTitle(String(view.props.title ?? view.component)); }
      else current.addPanel({ id: view.id, component: 'owner', tabComponent: 'retained', title: String(view.props.title ?? view.component), params: { view, snapshot, client }, inactive: true });
    }
    const target = current.getPanel(active) ?? current.panels[0];
    if (!current.activePanel && target) target.api.setActive();
  }, [composition, snapshot, client, api, narrow]);
  useEffect(() => {
    if (!api || narrow) return;
    const listener = api.onDidActivePanelChange(({ panel }) => { if (panel) setActive(panel.id); });
    return () => listener.dispose();
  }, [api, narrow]);
  function onReady(event: DockviewReadyEvent) { setApi(event.api); }
  const selected = composition.views.find(v => v.id === active) ?? composition.views[0];
  return <section className="workspace" aria-label="Composition workspace">
    <div className="workspace-actions">
      <div className="view-picker"><label htmlFor="workspace-view">View</label><select id="workspace-view" value={selected?.id ?? ''} onChange={e => { setActive(e.target.value); if (!narrow) api?.getPanel(e.target.value)?.api.setActive(); }}>
        {composition.views.map(v => <option key={v.id} value={v.id}>{String(v.props.title ?? v.component)}</option>)}
      </select></div>
      <span className="muted">Read-only layout</span>
    </div>
    {!composition.views.length ? <div className="empty"><h2>No views in this composition</h2><p>The retained layout is empty. No view is created automatically.</p></div> :
      narrow ? <div className="mobile-view">{selected && <OwnerView params={{ view: selected, snapshot, client }} active />}</div> :
        <div className="dock-container"><DockviewReact theme={themeLight} className="rho-dock" components={components} tabComponents={tabs} onReady={onReady} disableDnd disableFloatingGroups /></div>}
  </section>;
}
