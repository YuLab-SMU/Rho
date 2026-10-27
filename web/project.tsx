import type { ReactNode } from 'react';
import type { ProjectSummary, ResourceSummary, WorkspaceSnapshot, CompositionSummary } from '../src/browser.js';
import { canvasId, compositionName } from './canvas.js';
import { Icon, type IconName } from './icons.js';

export type Section = 'overview' | 'documents' | 'files' | 'activity' | 'settings' | 'sources';
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

export type SourceRow = 'data' | 'code' | 'results' | 'notes';
export interface AgentBadge { running: boolean; waiting: boolean; conversations: number }
// The project's places: what it is about, where the work is laid out, the Agent, what ran,
// and its contents by the kind of file a person looks for. Counts come from one bounded
// walk of the project folders; a partial walk says so instead of claiming totals.
export function ProjectNavigation({ snapshot, current, counts, partial, runs, agent, agentOpen, onOverview, onStudio, onAgent, onLayout, onSection, onSources, onAddSource, adding }: {
  project: ProjectSummary; snapshot: WorkspaceSnapshot | null; current: string;
  counts: Record<SourceRow, number> | null; partial: boolean; runs: number | null; agent: AgentBadge; agentOpen: boolean; adding: boolean;
  onOverview: () => void; onStudio: () => void; onAgent: () => void; onLayout: (id: string) => void; onSection: (section: Section) => void; onSources: (row: SourceRow) => void; onAddSource: () => void;
}) {
  const layouts = [...(snapshot?.compositions ?? [])].sort((a, b) => Number(b.compositionId === canvasId) - Number(a.compositionId === canvasId));
  // A row is named by its place; the count beside it is a glance, repeated in its tooltip.
  const count = (value: number | null | undefined, noun: string) => value === null || value === undefined ? undefined
    : { title: `${value}${partial && noun !== 'run' ? ' or more' : ''} ${noun}${value === 1 ? '' : 's'}`, node: <span className="nav-row-count" aria-hidden="true">{value}{partial && noun !== 'run' ? '+' : ''}</span> };
  const row = (key: string, label: string, icon: IconName, run: () => void, extra?: { title: string; node: ReactNode }) => <button className="nav-row" title={extra?.title} aria-current={current === key ? 'page' : undefined} onClick={run}><Icon name={icon} size={18} /><span className="nav-row-name">{label}</span>{extra?.node}</button>;
  const agentState = agent.waiting ? <span className="nav-badge waiting">Needs you</span> : agent.running ? <span className="nav-badge working"><span className="pulse-dot" aria-hidden="true" />Working</span> : agent.conversations ? <span className="nav-row-count" aria-hidden="true">{agent.conversations}</span> : null;
  return <nav aria-label="Project">
    <div className="nav-group">
      {row('overview', 'Overview', 'overview', onOverview)}
      <button className={'nav-row' + (current.startsWith('studio:') ? ' within' : '')} aria-current={current.startsWith('studio:') && !layouts.some(c => current === 'studio:' + c.compositionId) ? 'page' : undefined} onClick={onStudio}><Icon name="layout" size={18} /><span className="nav-row-name">Studio</span></button>
      {layouts.length > 0 && <div role="group" aria-label="Workspaces" className="nav-sub">
        {layouts.map(c => <button key={c.compositionId} className="nav-row nav-sub-row" aria-current={current === 'studio:' + c.compositionId ? 'page' : undefined} onClick={() => onLayout(c.compositionId)}><span className="nav-row-name">{compositionName(c.compositionId)}</span><span className="nav-row-count" title={views(c)}>{c.views.length}</span></button>)}
      </div>}
      <button className="nav-row" aria-label={'Agent conversations' + (agent.waiting ? ', needs your choice' : agent.running ? ', working' : '')} aria-expanded={agentOpen} onClick={onAgent}><Icon name="spark" size={18} /><span className="nav-row-name">Agent</span>{agentState}</button>
      {row('activity', 'Activity', 'run', () => onSection('activity'), count(runs, 'run'))}
    </div>
    <div className="nav-sources">
      <div className="nav-heading"><span className="section-label" id="nav-sources">Sources</span><button className="icon-button nav-add" aria-label="Add source folder" disabled={adding} onClick={onAddSource}><Icon name="plus" size={15} /></button></div>
      <div role="group" aria-labelledby="nav-sources" className="nav-group">
        {row('sources:data', 'Data', 'table', () => onSources('data'), count(counts?.data, 'data file'))}
        {row('sources:code', 'Code', 'code', () => onSources('code'), count(counts?.code, 'script'))}
        {row('sources:results', 'Results & figures', 'chart', () => onSources('results'), count(counts?.results, 'result'))}
        {row('sources:notes', 'Notes', 'document', () => onSources('notes'), count(counts?.notes, 'note'))}
        {row('files', 'Files', 'folder', () => onSection('files'))}
      </div>
    </div>
  </nav>;
}
