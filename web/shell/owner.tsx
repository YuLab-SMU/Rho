import { useContext } from 'react';
import type { BrowserClient, ViewDescription, WorkspaceSnapshot } from '../../src/browser.js';
import { pluginPresentation } from '../../src/plugin-presentation.js';
import { Icon, type IconName } from '../icons.js';
import { resourceIcon } from '../project.js';
import { registry } from '../registry.js';
import { ShellContext } from '../shell-services.js';
import { selectionScope } from '../../src/shell-layout.js';

export interface OwnerParams {
  view: ViewDescription; snapshot: WorkspaceSnapshot; client: BrowserClient; principalId?: string;
  compositionId: string; compositionVersion: number; contextTarget: HTMLElement | null; headerTarget: HTMLElement | null;
  renderAllowed: boolean; onAbout: (pluginId: string) => void; onRequestFeedback?: (viewId: string) => void;
  // Opens a view that can show this one's exact binding beside it; absent when the layout cannot be written.
  onOpenBeside?: (view: { component: string; version: string; props: Record<string, unknown>; bindings: Record<string, unknown> }) => void;
}
const clientEpoch = crypto.randomUUID();
type Binding = { documentId?: string; id?: string; version?: string | number };
function bindings(view: ViewDescription) { return Object.entries(view.bindings ?? {}) as [string, Binding][]; }
// A tab carries only the object: the run that produced its version is named once, on the
// view's source line.
export function title(view: ViewDescription) {
  return String(view.props.title ?? view.props.label ?? view.component);
}
// The tab icon follows what the view is bound to.
export function viewIcon(view: ViewDescription, snapshot: WorkspaceSnapshot): IconName {
  if (view.component === 'rho.console') return 'prompt';
  if (view.component === 'rho.notebook') return 'code';
  if (view.component === 'rho.object') return 'braces';
  if (view.component === 'rho.variables') return 'list';
  if (view.component === 'rho.plots') return 'chart';
  if (view.component === 'rho.execution' || view.component === 'rho.action') return 'layout';
  if (view.component === 'rho.media') return 'image';
  const [, first] = bindings(view)[0] ?? [];
  if (first?.documentId) return 'document';
  const resource = first?.id ? snapshot.resources.find(r => r.id === first.id) : undefined;
  return resource ? resourceIcon(resource.kind) : 'layout';
}
export function availableEntry(view: ViewDescription, snapshot: WorkspaceSnapshot) {
  const entry = registry.entries.find(e => e.component === view.component && e.componentVersion === view.version);
  const owner = snapshot.catalog.components.find(c => c.id === view.component && c.version === view.version);
  const provider = snapshot.catalog.plugins.find(p => p.id === owner?.pluginId);
  const ok = entry && owner && provider?.projectEnabled && provider.dependenciesSatisfied && provider.state === 'available' && entry.requiredOperations.every(method => snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized));
  return ok ? entry : undefined;
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
// A view this build can draw for an unavailable view's exact binding: the same table version
// in a table, the same document in the editor. The unavailable view and its reference stay.
function besideOf(view: ViewDescription, snapshot: WorkspaceSnapshot) {
  const named = String(view.props.title ?? view.component);
  for (const [, b] of bindings(view)) {
    const table = b.id ? snapshot.resources.find(r => r.id === b.id && r.version === b.version && r.kind === 'table') : undefined;
    const candidate = table ? { component: 'rho.table', version: '0.2.0', props: { title: named + ' · as a table' }, bindings: { data: { id: b.id, version: b.version } }, label: 'Open this version in a table' }
      : b.documentId ? { component: 'rho.editor', version: '0.2.0', props: { title: named + ' · in the editor' }, bindings: { document: { kind: 'live-document', documentId: b.documentId } }, label: 'Open this document in the editor' } : null;
    if (!candidate) continue;
    const probe = { id: "probe", component: candidate.component, version: candidate.version, props: candidate.props, bindings: candidate.bindings } as unknown as ViewDescription;
    if (availableEntry(probe, snapshot)) return { label: candidate.label, view: { component: candidate.component, version: candidate.version, props: candidate.props, bindings: candidate.bindings } };
  }
  return null;
}
// One owner view in the layout. The owner draws its content; the shell attaches the exact
// layout/build/client identity to the owner's own visibility evidence.
export function OwnerView({ params, active }: { params: OwnerParams; active: boolean }) {
  const { view, snapshot } = params, shell = useContext(ShellContext);
  const entry = availableEntry(view, snapshot);
  if (entry && !params.renderAllowed) return <section className="unavailable" role="status"><h2>This layout has reached its view limit</h2><p>Existing views and input are kept. Close another view before opening this one.</p></section>;
  if (entry) {
    const matchesOwner = snapshot.compositions.some(c => c.compositionId === params.compositionId && c.version === params.compositionVersion && c.views.some(v => v.id === view.id && JSON.stringify(v.bindings) === JSON.stringify(view.bindings)));
    const witness = matchesOwner && snapshot.presentation?.witnesses.find(w => w.compositionId === params.compositionId && w.compositionVersion === params.compositionVersion && w.views.some(v => v.viewId === view.id));
    const observation = witness && params.principalId && snapshot.catalog.operations.some(o => o.method === 'view.observe' && o.authorized && o.state === 'available') ? async (value: any) => {
      const input = { ...value, projectId: snapshot.project.id, taskId: snapshot.presentation!.taskId, compositionId: params.compositionId, compositionVersion: params.compositionVersion, witnessId: witness.witnessId, viewId: view.id, observationId: crypto.randomUUID(), clientId: params.principalId, clientEpoch, rendererBuild: import.meta.env.VITE_RHO_RENDERER_BUILD };
      // Retry an uncertain transport with exactly the same observation identity.
      try { await params.client.call('view.observe', input); }
      catch (error: any) { if (error?.error?.kind || error?.kind) throw error; await params.client.call('view.observe', input); }
    } : undefined;
    return <div className="shell-owner" data-owner-body=""><entry.View viewId={view.id} view={view} projectId={snapshot.project.id} snapshot={snapshot} client={params.client} active={active} contextTarget={params.contextTarget} principalId={params.principalId} selectionScope={selectionScope(view)} headerTarget={params.headerTarget} renderObservation={observation} requestFeedback={params.onRequestFeedback ? () => params.onRequestFeedback!(view.id) : undefined} shell={shell} /></div>;
  }
  const why = explain(view, snapshot), fallback = besideOf(view, snapshot);
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
      {fallback && params.onOpenBeside && <button className="quiet-button" onClick={() => params.onOpenBeside!(fallback.view)}>{fallback.label}</button>}
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
