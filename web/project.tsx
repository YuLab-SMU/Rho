import type { ProjectSummary, ResourceSummary, WorkspaceSnapshot, CompositionSummary } from '../src/browser.js';
import { projectName } from './home.js';
import { Icon, type IconName } from './icons.js';

export type Section = 'documents' | 'files';
export interface Entry { path: string; name: string; kind: 'file' | 'folder'; bytes: number; hidden: boolean }
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
export function views(composition: CompositionSummary) { return composition.views.length + (composition.views.length === 1 ? ' view' : ' views'); }

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
      <button className="nav-row" onClick={() => onSection('files')} title="Files registered with Rho; the Overview lists everything in the folder"><Icon name="folder" size={16} stroke={1.8} /><span className="nav-row-name">Files<span style={{ color: 'var(--color-meta)', fontWeight: 400 }}> · registered</span></span><span className="nav-row-count">{snapshot?.resources.length ?? ''}</span></button>
      {operations > 0 && <div className="nav-row nav-fact"><span className="nav-row-name">Retained operations</span><span className="nav-row-count">{operations}</span></div>}
    </div>
  </>;
}

