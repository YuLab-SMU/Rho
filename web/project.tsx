import type { CapabilityCatalog, CompositionSummary, ProjectSummary, ResourceSummary, WorkspaceSnapshot } from '../src/browser.js';
import { projectName, when } from './home.js';
import { Icon, type IconName } from './icons.js';
import { registry } from './registry.js';

export type Section = 'documents' | 'files';
export function size(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)) + ' ' + units[unit];
}
export function resourceIcon(kind: string): IconName { return kind === 'table' ? 'table' : kind === 'image' ? 'image' : 'file'; }
export function availability(resource: ResourceSummary) {
  return resource.availability === 'available' ? 'Available' : resource.availability === 'partial' ? 'Partly readable' : resource.availability === 'missing' ? "Can't be read" : 'Not checked';
}
function views(composition: CompositionSummary) { return composition.views.length + (composition.views.length === 1 ? ' view' : ' views'); }
// A document viewer exists only when this build renders a component that binds documents.
function documentViewer(catalog: CapabilityCatalog) {
  const viewer = catalog.components.find(c => Object.values(c.bindings).includes('document') && registry.entries.some(e => e.component === c.id && e.componentVersion === c.version));
  return viewer ? viewer.presentation?.displayName ?? viewer.id : 'Not in this build';
}

export function ProjectNavigation({ project, location, snapshot, overview, compositionId, onOverview, onLayout, onSection }: {
  project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot | null; overview: boolean; compositionId: string;
  onOverview: () => void; onLayout: (id: string) => void; onSection: (section: Section) => void;
}) {
  const layouts = snapshot?.compositions ?? [], operations = snapshot?.operations.length ?? 0;
  return <>
    <div className="project-heading"><strong>{projectName(project)}</strong><span>{location}</span></div>
    <button className="nav-row" aria-current={overview ? 'page' : undefined} onClick={onOverview}><Icon name="overview" size={16} stroke={1.8} /><span className="nav-row-name">Overview</span></button>
    <span className="section-label" id="nav-layouts">Layouts</span>
    <div role="group" aria-labelledby="nav-layouts" className="nav-group">
      {layouts.map(c => <button key={c.compositionId} className="nav-row" aria-current={!overview && compositionId === c.compositionId ? 'page' : undefined} onClick={() => onLayout(c.compositionId)}>
        <Icon name="layout" size={16} stroke={1.8} /><span className="nav-row-name">{c.compositionId}</span><span className="nav-row-count">{views(c)}</span>
      </button>)}
      {snapshot && !layouts.length && <p className="nav-empty">None saved yet</p>}
    </div>
    <span className="section-label" id="nav-content">Content</span>
    <div role="group" aria-labelledby="nav-content" className="nav-group">
      <button className="nav-row" onClick={() => onSection('documents')}><Icon name="document" size={16} stroke={1.8} /><span className="nav-row-name">Documents</span><span className="nav-row-count">{snapshot?.documents.length ?? ''}</span></button>
      <button className="nav-row" onClick={() => onSection('files')}><Icon name="folder" size={16} stroke={1.8} /><span className="nav-row-name">Files</span><span className="nav-row-count">{snapshot?.resources.length ?? ''}</span></button>
      {operations > 0 && <div className="nav-row nav-fact"><span className="nav-row-name">Retained operations</span><span className="nav-row-count">{operations}</span></div>}
    </div>
  </>;
}

export function ProjectOverview({ project, location, snapshot, onLayout }: { project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot; onLayout: (id: string) => void }) {
  const added = when(project.openedAt), docs = snapshot.documents, files = snapshot.resources, viewer = documentViewer(snapshot.catalog);
  return <section className="overview" aria-labelledby="overview-title">
    <header className="overview-header">
      <h1 id="overview-title">{projectName(project)}</h1>
      <p><span>{location}</span>{added.text && <> · <span title={added.full}>added {added.text.replace(/^[TY]/, c => c.toLowerCase())}</span></>}</p>
    </header>
    {snapshot.compositions.length ? <section className="overview-section" aria-labelledby="overview-layouts">
      <h2 id="overview-layouts" tabIndex={-1}>Layouts <span>{snapshot.compositions.length}</span></h2>
      <table><thead><tr><th>Name</th><th className="column-state">Views</th></tr></thead>
        <tbody>{snapshot.compositions.map(c => <tr key={c.compositionId}>
          <td><button className="overview-link" onClick={() => onLayout(c.compositionId)}><Icon name="layout" size={16} stroke={1.8} />{c.compositionId}</button></td>
          <td className="column-state">{views(c)}</td>
        </tr>)}</tbody></table>
    </section> : <div className="layout-empty">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray="3 2.4" /></svg>
      <div><strong>No saved layout yet</strong><p>A layout appears here once you or an Agent saves one for this project. Your documents and files are listed below.</p></div>
    </div>}
    <section className="overview-section" aria-labelledby="overview-documents">
      <h2 id="overview-documents" tabIndex={-1}>Documents <span>{docs.length}</span></h2>
      {docs.length ? <table><thead><tr><th>Name</th><th className="column-short optional">Version</th><th className="column-state">State</th><th className="column-wide optional">Viewer</th></tr></thead>
        <tbody>{docs.map(d => <tr key={d.id}>
          <td><span className="overview-name"><Icon name="file" size={16} stroke={1.8} />{d.path}</span></td>
          <td className="column-short optional">{d.version}</td>
          <td className="column-state"><span className={'state ' + (d.dirty ? 'pending' : 'good')}>{d.dirty ? 'Unsaved changes' : 'Saved'}</span></td>
          <td className="column-wide optional meta">{viewer}</td>
        </tr>)}</tbody></table> : <p className="overview-none">No documents are open in this project.</p>}
    </section>
    <section className="overview-section" aria-labelledby="overview-files">
      <h2 id="overview-files" tabIndex={-1}>Files <span>{files.length}</span></h2>
      {files.length ? <table><thead><tr><th>Name</th><th className="column-short optional">Kind</th><th className="column-state">State</th><th className="column-wide">Size</th></tr></thead>
        <tbody>{files.map(r => <tr key={r.id}>
          <td><span className="overview-name"><Icon name={resourceIcon(r.kind)} size={16} stroke={1.8} />{r.path}</span></td>
          <td className="column-short optional">{r.kind.charAt(0).toUpperCase() + r.kind.slice(1)}</td>
          <td className="column-state"><span className={'state ' + (r.availability === 'available' ? 'good' : 'unknown')}>{availability(r)}</span></td>
          <td className="column-wide muted">{(r.availability === 'available' ? '' : 'Last seen ') + size(r.bytes)}</td>
        </tr>)}</tbody></table> : <p className="overview-none">No files are registered in this project.</p>}
    </section>
  </section>;
}
