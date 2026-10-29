import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectSummary, ResourceSummary, WorkspaceSnapshot, CompositionSummary } from '../src/browser.js';
import { compositionName } from './canvas.js';
import { Icon, type IconName } from './icons.js';

export type Section = 'overview' | 'documents' | 'files' | 'agent' | 'settings' | 'sources' | 'file' | 'graph' | 'review';
export interface Entry { path: string; name: string; kind: 'file' | 'folder'; bytes: number; hidden: boolean; modifiedAt?: string }
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

import type { SourceItem, SourceRow } from './sources.js';
export type { SourceRow } from './sources.js';
export interface AgentBadge { running: boolean; waiting: boolean; conversations: number }
// The project's places: what it is about, where the work is laid out, the Agent, what ran,
// and its contents by the kind of file a person looks for. Counts come from one bounded
// walk of the project folders; a partial walk says so instead of claiming totals.
export function ProjectNavigation({ project, snapshot, current, sources, partial, agent, onOverview, onStudio, onLayout, onSection, onSources, onFile, onAddSource, adding }: {
  project: ProjectSummary; snapshot: WorkspaceSnapshot | null; current: string;
  sources: Record<SourceRow, SourceItem[]> | null; partial: boolean; agent: AgentBadge; adding: boolean;
  onOverview: () => void; onStudio: () => void; onLayout: (id: string) => void; onSection: (section: Section) => void;
  onSources: (row: SourceRow) => void; onFile: (row: SourceRow, item: SourceItem) => void; onAddSource: () => void;
}) {
  // Which kinds are unfolded is remembered per project for this tab; the kind of the file on
  // screen is always unfolded, so the person sees where they are.
  const openKey = 'rho.sources.open.v1:' + project.id;
  const [unfolded, setUnfolded] = useState<SourceRow[]>(() => { try { return JSON.parse(sessionStorage.getItem(openKey) ?? '[]'); } catch { return []; } });
  useEffect(() => { try { setUnfolded(JSON.parse(sessionStorage.getItem(openKey) ?? '[]')); } catch { setUnfolded([]); } }, [openKey]);
  const shownRow = current.startsWith('file:') ? current.split(':')[1] as SourceRow : null;
  function fold(row: SourceRow) {
    const next = unfolded.includes(row) ? unfolded.filter(r => r !== row) : [...unfolded, row];
    setUnfolded(next);
    try { sessionStorage.setItem(openKey, JSON.stringify(next)); } catch { /* the choice lasts for this page only */ }
  }
  const layouts = snapshot?.compositions ?? [];
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
      {row('graph', 'Graph', 'graph', () => onSection('graph'))}
      {row('review', 'Review', 'question', () => onSection('review'))}
      {/* The Agent's place is what it did here; its panel, opened from the top bar beside any page, is where to talk to it. */}
      <button className="nav-row" aria-label={'Agent' + (agent.waiting ? ', needs your choice' : agent.running ? ', working' : '')} aria-current={current === 'agent' ? 'page' : undefined} onClick={() => onSection('agent')}><Icon name="spark" size={18} /><span className="nav-row-name">Agent</span>{agentState}</button>
    </div>
    <div className="nav-sources">
      <div className="nav-heading"><span className="section-label" id="nav-sources">Sources</span><button className="icon-button nav-add" aria-label="Add source folder" disabled={adding} onClick={onAddSource}><Icon name="plus" size={15} /></button></div>
      <div role="group" aria-labelledby="nav-sources" className="nav-group">
        {sourceRows.map(([kind, label, icon, noun]) => {
          const items = sources?.[kind] ?? null, open = unfolded.includes(kind) || shownRow === kind, extra = count(items?.length, noun);
          return <div key={kind} className={'nav-source' + (open ? ' open' : '')}>
            <button className="nav-row" title={extra?.title} aria-expanded={open} aria-controls={'nav-files-' + kind} aria-current={current === 'sources:' + kind ? 'page' : undefined} onClick={() => fold(kind)}>
              <Icon name={icon} size={18} /><span className="nav-row-name">{label}</span>{extra?.node}<span className="nav-twisty" aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
            </button>
            {open && <SourceFiles id={'nav-files-' + kind} kind={kind} label={label} items={items} partial={partial} current={current} onFile={item => onFile(kind, item)} onAll={() => onSources(kind)} />}
          </div>;
        })}
        {row('files', 'Files', 'folder', () => onSection('files'))}
      </div>
    </div>
  </nav>;
}

export const sourceLabels: Record<SourceRow, string> = { data: 'Data', code: 'Code', results: 'Results & figures', notes: 'Notes' };
const sourceRows: Array<[SourceRow, string, IconName, string]> = [['data', sourceLabels.data, 'table', 'data file'], ['code', sourceLabels.code, 'code', 'script'], ['results', sourceLabels.results, 'chart', 'result'], ['notes', sourceLabels.notes, 'document', 'note']];
// The sidebar holds this many files of a kind; the rest are on the kind's own page.
export const sidebarFiles = 40;
export const fileIcon = (item: SourceItem): IconName => item.category === 'figures' ? 'image' : item.category === 'code' ? 'code' : item.category === 'notes' ? 'document' : 'table';
// The files of one kind, by folder. Choosing one shows it in place; Up and Down move along
// the list and show each file in turn.
function SourceFiles({ id, kind, label, items, partial, current, onFile, onAll }: {
  id: string; kind: SourceRow; label: string; items: SourceItem[] | null; partial: boolean; current: string; onFile: (item: SourceItem) => void; onAll: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  // Moving with the arrow keys on the page keeps the shown file in sight here.
  useEffect(() => { list.current?.querySelector('[aria-current=page]')?.scrollIntoView({ block: 'nearest' }); }, [current]);
  if (!items) return <p id={id} className="nav-files-note" role="status">Reading folders…</p>;
  if (!items.length) return <p id={id} className="nav-files-note">{partial ? 'None in the folders read' : 'None yet'}</p>;
  const shown = items.slice(0, sidebarFiles);
  const folders = new Set(shown.map(item => item.folder)).size > 1;
  function move(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.closest('.nav-files')!.querySelectorAll<HTMLButtonElement>('.nav-file')];
    const at = buttons.indexOf(event.currentTarget), to = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!to) return;
    event.preventDefault(); to.focus(); to.click();
  }
  return <ul ref={list} id={id} className="nav-files" aria-label={label}>
    {shown.map((item, index) => <li key={item.key}>
      {folders && item.folder !== shown[index - 1]?.folder && <span className="nav-folder" title={item.folder}>{item.folder}</span>}
      <button className="nav-file" title={item.path} aria-current={current === 'file:' + kind + ':' + item.key ? 'page' : undefined} onClick={() => onFile(item)} onKeyDown={move}>
        <Icon name={fileIcon(item)} size={14} stroke={1.7} /><span>{item.name}</span>
      </button>
    </li>)}
    {items.length > shown.length && <li><button className="nav-more" onClick={onAll}>All {items.length} files</button></li>}
  </ul>;
}
