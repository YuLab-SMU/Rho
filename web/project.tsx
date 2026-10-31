import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectSummary, ResourceSummary, WorkspaceSnapshot, CompositionSummary } from '../src/browser.js';
import { compositionName, processConversation } from './canvas.js';
import { Icon, type IconName } from './icons.js';
import { when } from './home.js';

export type Section = 'overview' | 'documents' | 'files' | 'agent' | 'settings' | 'sources' | 'file' | 'graph' | 'review' | 'console' | 'notebook';
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

import { baseRows, sourceRowOrder, type SourceItem, type SourceRow } from './sources.js';
import type { LiveSession, LiveValues, ValueLanguage } from './session-values.js';
export type { SourceRow } from './sources.js';
export interface AgentBadge { running: boolean; waiting: boolean; conversations: number }
// The project's places: what it is about, where the work is laid out, the Agent, what ran,
// and its contents by the kind of file a person looks for. Counts come from one bounded
// walk of the project folders; a partial walk says so instead of claiming totals.
export interface SessionRow { id: string; title: string; running: boolean; when: string }
// How many sessions Studio lists before the rest are reached from the Agent's place.
export const sessionRows = 8;
export function ProjectNavigation({ project, snapshot, current, sources, partial, agent, sessions, values, onOverview, onStudio, onLayout, onNewLayout, onSection, onSources, onFile, onValue, onAddSource, adding }: {
  project: ProjectSummary; snapshot: WorkspaceSnapshot | null; current: string; sessions: SessionRow[];
  sources: Record<SourceRow, SourceItem[]> | null; partial: boolean; agent: AgentBadge; adding: boolean;
  // The live sessions' values, or null where this tab cannot read the sessions.
  values: LiveValues | null;
  onOverview: () => void; onStudio: () => void; onLayout: (id: string) => void; onNewLayout?: () => void; onSection: (section: Section) => void;
  onSources: (row: SourceRow) => void; onFile: (row: SourceRow, item: SourceItem) => void; onValue: (language: ValueLanguage, name: string) => void; onAddSource: () => void;
}) {
  // Which kinds are unfolded is remembered per project for this tab; the kind of the file on
  // screen is always unfolded, so the person sees where they are.
  const openKey = 'rho.sources.open.v1:' + project.id;
  const [unfolded, setUnfolded] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem(openKey) ?? '[]'); } catch { return []; } });
  useEffect(() => { try { setUnfolded(JSON.parse(sessionStorage.getItem(openKey) ?? '[]')); } catch { setUnfolded([]); } }, [openKey]);
  const shownRow = current.startsWith('file:') ? current.split(':')[1] as SourceRow : null;
  function fold(row: string) {
    const next = unfolded.includes(row) ? unfolded.filter(r => r !== row) : [...unfolded, row];
    setUnfolded(next);
    try { sessionStorage.setItem(openKey, JSON.stringify(next)); } catch { /* the choice lasts for this page only */ }
  }
  // Under Studio: each session's own Studio, newest first and named by its section of the notes,
  // then the workspaces the person arranged.
  // The person's workspaces in the order they were made: the first, then by number.
  const made = (id: string) => id === 'workspace' ? 1 : /^workspace-(\d+)$/.test(id) ? Number(id.slice('workspace-'.length)) : Infinity;
  const layouts = (snapshot?.compositions ?? []).filter(c => !processConversation(c.compositionId)).sort((a, b) => made(a.compositionId) - made(b.compositionId) || a.compositionId.localeCompare(b.compositionId));
  const shownSessions = sessions.filter((s, i) => i < sessionRows || current === 'studio:' + s.id);
  // A row is named by its place; the count beside it is a glance, repeated in its tooltip.
  const count = (value: number | null | undefined, noun: string) => value === null || value === undefined ? undefined
    : { title: `${value}${partial && noun !== 'run' ? ' or more' : ''} ${noun}${value === 1 ? '' : 's'}`, node: <span className="nav-row-count" aria-hidden="true">{value}{partial && noun !== 'run' ? '+' : ''}</span> };
  const row = (key: string, label: string, icon: IconName, run: () => void, extra?: { title: string; node: ReactNode }) => <button className="nav-row" title={extra?.title} aria-current={current === key ? 'page' : undefined} onClick={run}><Icon name={icon} size={18} /><span className="nav-row-name">{label}</span>{extra?.node}</button>;
  const agentState = agent.waiting ? <span className="nav-badge waiting">Needs you</span> : agent.running ? <span className="nav-badge working"><span className="pulse-dot" aria-hidden="true" />Working</span> : agent.conversations ? <span className="nav-row-count" aria-hidden="true">{agent.conversations}</span> : null;
  return <nav aria-label="Project">
    <div className="nav-group">
      {row('overview', 'Overview', 'overview', onOverview)}
      <button className={'nav-row' + (current.startsWith('studio:') ? ' within' : '')} aria-current={current.startsWith('studio:') && !layouts.some(c => current === 'studio:' + c.compositionId) && !sessions.some(s => current === 'studio:' + s.id) ? 'page' : undefined} onClick={onStudio}><Icon name="layout" size={18} /><span className="nav-row-name">Studio</span></button>
      {sessions.length > 0 && <div role="group" aria-label="Sessions" className="nav-sub">
        {shownSessions.map(s => { const at = when(s.when); return <button key={s.id} className="nav-row nav-sub-row nav-session" title={s.title + (at.full ? '\n' + at.full : '')} aria-current={current === 'studio:' + s.id ? 'page' : undefined} onClick={() => onLayout(s.id)}>{s.running ? <span className="pulse-dot" aria-label="Working" /> : null}<span className="nav-row-name">{s.title}</span></button>; })}
        {sessions.length > shownSessions.length && <button className="nav-row nav-sub-row nav-more" onClick={() => onSection('agent')}><span className="nav-row-name">All {sessions.length} sessions</span></button>}
      </div>}
      {(layouts.length > 0 || onNewLayout) && <div role="group" aria-label="Workspaces" className="nav-sub">
        {layouts.map(c => <button key={c.compositionId} className="nav-row nav-sub-row" aria-current={current === 'studio:' + c.compositionId ? 'page' : undefined} onClick={() => onLayout(c.compositionId)}><span className="nav-row-name">{compositionName(c.compositionId)}</span><span className="nav-row-count" title={views(c)}>{c.views.length}</span></button>)}
        {onNewLayout && <button className="nav-row nav-sub-row nav-new" onClick={onNewLayout}><Icon name="plus" size={13} stroke={2} /><span className="nav-row-name">New workspace</span></button>}
      </div>}
      {row('graph', 'Graph', 'graph', () => onSection('graph'))}
      {row('console', 'Console', 'prompt', () => onSection('console'))}
      {snapshot?.catalog.plugins.some(p => p.id === 'kernel') && row('notebook', 'Notebook', 'code', () => onSection('notebook'))}
      {/* Asking about an answer and deciding on it happen on the answer itself; the review records
          made before keep their page while a project has them. */}
      {((snapshot?.annotations?.length ?? 0) > 0 || current === 'review') && row('review', 'Review', 'question', () => onSection('review'), count(snapshot?.annotations?.length, 'question'))}
      {/* The Agent's place is what it did here; its panel, opened from the top bar beside any page, is where to talk to it. */}
      <button className="nav-row" aria-label={'Agent' + (agent.waiting ? ', needs your choice' : agent.running ? ', working' : '')} aria-current={current === 'agent' ? 'page' : undefined} onClick={() => onSection('agent')}><Icon name="spark" size={18} /><span className="nav-row-name">Agent</span>{agentState}</button>
    </div>
    <div className="nav-sources">
      <div className="nav-heading"><span className="section-label" id="nav-sources">Sources</span><button className="icon-button nav-add" aria-label="Add source folder" disabled={adding} onClick={onAddSource}><Icon name="plus" size={15} /></button></div>
      <div role="group" aria-labelledby="nav-sources" className="nav-group">
        {sourceRowOrder.map(kind => {
          const [label, icon, noun] = sourceRows[kind];
          const items = sources?.[kind] ?? null, open = unfolded.includes(kind) || shownRow === kind, extra = count(items?.length, noun);
          // A kind beyond the four every project has is listed while the project holds some.
          if (!baseRows.includes(kind) && !items?.length) return null;
          // The live values sit between the code that makes them and the results kept from them.
          const variables = kind === 'results' && values && <ValuesRow key="variables" values={values} open={unfolded.includes('variables')} onFold={() => fold('variables')} onValue={onValue} onNotebook={() => onSection('notebook')} />;
          return <Fragment key={kind}>{variables}<div className={'nav-source' + (open ? ' open' : '')}>
            <button className="nav-row" title={extra?.title} aria-expanded={open} aria-controls={'nav-files-' + kind} aria-current={current === 'sources:' + kind ? 'page' : undefined} onClick={() => fold(kind)}>
              <Icon name={icon} size={18} /><span className="nav-row-name">{label}</span>{extra?.node}<span className="nav-twisty" aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
            </button>
            {open && <SourceFiles id={'nav-files-' + kind} kind={kind} label={label} items={items} partial={partial} current={current} onFile={item => onFile(kind, item)} onAll={() => onSources(kind)} />}
          </div></Fragment>;
        })}
        {row('files', 'Files', 'folder', () => onSection('files'))}
      </div>
    </div>
  </nav>;
}

export const sourceLabels: Record<SourceRow, string> = { data: 'Data', code: 'Code', results: 'Results & figures', notes: 'Notes', workflows: 'Workflows', reports: 'Reports', references: 'References', environment: 'Environment' };
const sourceRows: Record<SourceRow, [string, IconName, string]> = {
  data: [sourceLabels.data, 'table', 'data file'], code: [sourceLabels.code, 'code', 'script'], workflows: [sourceLabels.workflows, 'workflow', 'workflow file'],
  results: [sourceLabels.results, 'chart', 'result'], reports: [sourceLabels.reports, 'report', 'report file'], notes: [sourceLabels.notes, 'document', 'note'],
  references: [sourceLabels.references, 'book', 'reference file'], environment: [sourceLabels.environment, 'tool', 'environment file'],
};
// The sidebar holds this many files of a kind; the rest are on the kind's own page.
export const sidebarFiles = 40;
export const fileIcon = (item: SourceItem): IconName => item.category === 'figures' ? 'image' : item.category === 'code' ? 'code' : item.category === 'notes' ? 'document' : item.category ? 'table' : 'file';
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

// The live sessions' values as one more place in Sources: each session, then its values by
// name with their type. A value opens in Studio beside the Notebook. Nothing is listed for a
// session that ended; its values are gone with it.
const sessionName = (s: LiveSession) => s.version?.replace(/^R version (\S+).*$/, 'R $1').replace(/^Python (\S+).*$/, 'Python $1') ?? (s.language === 'r' ? 'R' : 'Python');
function ValuesRow({ values, open, onFold, onValue, onNotebook }: { values: LiveValues; open: boolean; onFold: () => void; onValue: (language: ValueLanguage, name: string) => void; onNotebook: () => void }) {
  const total = values.sessions.reduce((n, s) => n + s.variables.length + (s.variablesOmitted ?? 0), 0);
  const busy = values.sessions.some(s => s.state === 'busy');
  const title = !values.read ? undefined : values.sessions.length ? `${total} value${total === 1 ? '' : 's'} in the live ${values.sessions.map(s => s.language === 'r' ? 'R' : 'Python').join(' and ')} session${values.sessions.length === 1 ? '' : 's'}` : 'No live session';
  return <div className={'nav-source' + (open ? ' open' : '')}>
    <button className="nav-row" title={title} aria-expanded={open} aria-controls="nav-values" onClick={onFold}>
      <Icon name="list" size={18} /><span className="nav-row-name">Variables</span>
      {busy && <span className="pulse-dot" aria-label="Running" />}
      {values.sessions.length > 0 && <span className="nav-row-count" aria-hidden="true">{total}</span>}
      <span className="nav-twisty" aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span>
    </button>
    {open && (!values.read ? <p id="nav-values" className="nav-files-note" role="status">Reading the live sessions…</p>
      : values.problem && !values.sessions.length ? <p id="nav-values" className="nav-files-note" role="alert">{values.problem}</p>
      : !values.sessions.length ? <div id="nav-values" className="nav-files-note">No live session. Values show here once R or Python runs a cell.<button className="nav-more" onClick={onNotebook}>Open the Notebook</button></div>
      : <ul id="nav-values" className="nav-files nav-values" aria-label="Variables">
        {values.sessions.map(s => <Fragment key={s.language}>
          <li><span className="nav-folder">{sessionName(s)}{s.state === 'busy' ? ' · running' : ''}</span></li>
          {s.variables.length ? s.variables.slice(0, sidebarFiles).map(v => <li key={s.language + ':' + v.name}>
            <button className="nav-file nav-value" title={`${v.name} · ${v.type}${v.size ? ' · ' + v.size : ''}${v.summary ? '\n' + v.summary : ''}`} onClick={() => onValue(s.language, v.name)}>
              <span>{v.name}</span><small>{v.type}</small>
            </button>
          </li>) : <li><span className="nav-files-note nav-values-none">No values yet</span></li>}
          {s.variables.length > sidebarFiles || s.variablesOmitted ? <li><button className="nav-more" onClick={onNotebook}>All {s.variables.length + (s.variablesOmitted ?? 0)} in the Notebook</button></li> : null}
        </Fragment>)}
      </ul>)}
  </div>;
}
