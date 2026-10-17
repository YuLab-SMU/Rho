import { useEffect, useState } from 'react';
import { DockviewReact, themeLight, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewPanelHeaderProps } from 'dockview-react';
import type { BrowserClient, CompositionSummary, ViewDescription, WorkspaceSnapshot } from '../src/browser.js';
import { pluginPresentation } from '../src/plugin-presentation.js';
import { Icon, type IconName } from './icons.js';
import { resourceIcon } from './project.js';
import { registry } from './registry.js';
import 'dockview/dist/styles/dockview.css';

interface ViewParams { view: ViewDescription; snapshot: WorkspaceSnapshot; client: BrowserClient; onAbout: (pluginId: string) => void }
type Binding = { documentId?: string; id?: string; version?: string | number };
const title = (view: ViewDescription) => String(view.props.title ?? view.component);
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
  const entry = registry.entries.find(e => e.component === view.component && e.componentVersion === view.version);
  const owner = snapshot.catalog.components.find(c => c.id === view.component && c.version === view.version);
  const available = entry && owner && entry.requiredOperations.every(method => snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized));
  if (available) return <entry.View viewId={view.id} view={view} projectId={snapshot.project.id} snapshot={snapshot} client={params.client} active={active} />;
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
  return <span className="retained-tab"><Icon name={viewIcon(params.view, params.snapshot)} size={14} stroke={2} />{title(params.view)}</span>;
}
const components = { owner: ViewContent }, tabs = { retained: Tab };
export function Workspace({ composition, snapshot, client, onAbout }: { composition: CompositionSummary; snapshot: WorkspaceSnapshot; client: BrowserClient; onAbout: (pluginId: string) => void }) {
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
      const panel = current.getPanel(view.id), params = { view, snapshot, client, onAbout };
      if (panel) { panel.api.updateParameters(params); panel.api.setTitle(title(view)); }
      else current.addPanel({ id: view.id, component: 'owner', tabComponent: 'retained', title: title(view), params, inactive: true });
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
  return <section className="workspace" aria-label="Layout">
    {!composition.views.length ? <div className="empty"><h2>No views in this layout</h2><p>The saved layout is empty. No view is created automatically.</p></div> :
      narrow ? <>
        <div className="workspace-actions"><div className="view-picker"><label htmlFor="workspace-view">View</label><select id="workspace-view" value={selected?.id ?? ''} onChange={e => setActive(e.target.value)}>
          {composition.views.map(v => <option key={v.id} value={v.id}>{title(v)}</option>)}
        </select></div></div>
        <div className="mobile-view">{selected && <OwnerView params={{ view: selected, snapshot, client, onAbout }} active />}</div>
      </> :
        <div className="dock-container"><DockviewReact theme={themeLight} className="rho-dock" components={components} tabComponents={tabs} onReady={onReady} disableDnd disableFloatingGroups /></div>}
  </section>;
}
