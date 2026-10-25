import type { ProjectSummary, ResourceSummary, WorkspaceSnapshot, CompositionSummary } from '../src/browser.js';
import { projectName } from './home.js';
import { Icon, type IconName } from './icons.js';

export type Section = 'overview' | 'documents' | 'files' | 'activity' | 'settings';
export interface Entry { path: string; name: string; kind: 'file' | 'folder'; bytes: number; hidden: boolean }
export function size(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)) + ' ' + units[unit];
}
export function resourceIcon(kind: string): IconName { return kind === 'table' ? 'table' : ['image', 'media'].includes(kind) ? 'image' : 'file'; }
export function availability(resource: ResourceSummary) {
  return resource.availability === 'available' ? 'Available' : resource.availability === 'partial' ? 'Partly readable' : resource.availability === 'missing' ? "Can't be read" : 'Not checked';
}
export function views(composition: CompositionSummary) { return composition.views.length + (composition.views.length === 1 ? ' view' : ' views'); }

export function ProjectNavigation({ snapshot, overview, section, compositionId, onOverview, onLayout, onSection }: {
  project: ProjectSummary; location: string; snapshot: WorkspaceSnapshot | null; overview: boolean; section: Section; compositionId: string;
  onOverview: () => void; onLayout: (id: string) => void; onSection: (section: Section) => void;
}) {
  const layouts = snapshot?.compositions ?? [];
  const row = (id: Section, label: string, icon: IconName) => <button className="nav-row" aria-current={overview && (section === id || id === 'files' && section === 'documents') ? 'page' : undefined} onClick={() => id === 'overview' ? onOverview() : onSection(id)}><Icon name={icon} size={18} /><span className="nav-row-name">{label}</span></button>;
  return <nav aria-label="Project">
    <div className="nav-group">{row('overview', 'Overview', 'overview')}{row('files', 'Files', 'folder')}{row('activity', 'Activity', 'run')}</div>
    {layouts.length > 0 && <div className="nav-workspaces"><span className="section-label" id="nav-layouts">Workspaces</span><div role="group" aria-labelledby="nav-layouts" className="nav-group">
      {layouts.map(c => <button key={c.compositionId} className="nav-row" aria-current={!overview && compositionId === c.compositionId ? 'page' : undefined} onClick={() => onLayout(c.compositionId)}><Icon name="layout" size={17} /><span className="nav-row-name">{c.compositionId}</span><span className="nav-row-count" title={views(c)}>{c.views.length}</span></button>)}
    </div></div>}
    <div className="nav-settings">{row('settings', 'Project settings', 'context')}</div>
  </nav>;
}
