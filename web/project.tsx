import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ProjectSummary, ResourceSummary, WorkspaceSnapshot, CompositionSummary } from '../src/browser.js';
import { compositionName, processConversation } from './canvas.js';
import { Icon, type IconName } from './icons.js';
import { when } from './home.js';
import { ProviderMark } from './brand-marks.js';

export type Section = 'overview' | 'documents' | 'files' | 'agent' | 'settings' | 'sources' | 'file' | 'graph' | 'review' | 'console' | 'notebook' | 'skills';
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
import type { LiveSession, LiveValues, ValueLanguage } from '@rho-workspace/plugin-kernel/ui';
export type { SourceRow } from './sources.js';
// One of the project's places: a page of its own, shown as a tab above the work, or as a row
// in the drawer where the window has no room for tabs.
export interface PlaceRow { key: string; label: string; icon: IconName; current: boolean; run: () => void; count?: number }
// The sidebar under the projects: the open project's tasks, each an Agent session with its
// own Studio, then the person's workspaces, then its contents by the kind of file a person
// looks for. Counts come from one bounded walk of the project folders; a partial walk says so
// instead of claiming totals.
export interface SessionRow { id: string; title: string; agent: string; running: boolean; waiting: boolean; when: string }
// How many sessions the sidebar lists before the rest are reached from the Agent's place.
export const sessionRows = 8;
// How long ago a task last moved, short enough to sit beside its title: 11m, 3h, 2d, then the
// date. The row's tooltip has the time whole.
export function shortWhen(iso: string, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
  return minutes < 1 ? 'now' : minutes < 60 ? minutes + 'm' : minutes < 24 * 60 ? Math.round(minutes / 60) + 'h' : minutes < 7 * 24 * 60 ? Math.round(minutes / 1440) + 'd'
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' }) });
}
export function ProjectNavigation({ project, snapshot, current, talking = null, agentState = '', onAgents, sources, partial, sessions, places, values, onLayout, onNewLayout, onCloseLayout, onNewTask, onSection, onSources, onFile, onValue, onVariables, onAddSource, adding }: {
  project: ProjectSummary; snapshot: WorkspaceSnapshot | null; current: string; sessions: SessionRow[];
  // The task whose conversation the Agent panel shows beside the page, by its row's id.
  talking?: string | null;
  // The Agent's row: what it is doing now, for a screen reader, and its page.
  agentState?: string; onAgents: () => void;
  // The project's places as rows, where they are not tabs above the work.
  places?: PlaceRow[];
  sources: Record<SourceRow, SourceItem[]> | null; partial: boolean; adding: boolean;
  // The live sessions' values, or null where this tab cannot read the sessions.
  values: LiveValues | null;
  // A workspace of the person's is closed from its row: its views go with it, and Undo brings it back.
  onLayout: (id: string) => void; onNewLayout?: () => void; onCloseLayout?: (id: string) => void; onNewTask: () => void; onSection: (section: Section) => void;
  onSources: (row: SourceRow) => void; onFile: (row: SourceRow, item: SourceItem) => void; onValue: (language: ValueLanguage, name: string) => void; onVariables: () => void; onAddSource: () => void;
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
  // Tasks: each session, newest first and named by its section of the notes, with its Agent's
  // mark and when it last moved. Then the workspaces the person arranged, in the order they
  // were made: the first, then by number.
  const made = (id: string) => id === 'workspace' ? 1 : /^workspace-(\d+)$/.test(id) ? Number(id.slice('workspace-'.length)) : Infinity;
  const layouts = (snapshot?.compositions ?? []).filter(c => !processConversation(c.compositionId)).sort((a, b) => made(a.compositionId) - made(b.compositionId) || a.compositionId.localeCompare(b.compositionId));
  const shownSessions = sessions.filter((s, i) => i < sessionRows || current === 'studio:' + s.id || talking === s.id);
  // A row is named by its place; the count beside it is a glance, repeated in its tooltip.
  const count = (value: number | null | undefined, noun: string) => value === null || value === undefined ? undefined
    : { title: `${value}${partial && noun !== 'run' ? ' or more' : ''} ${noun}${value === 1 ? '' : 's'}`, node: <span className="nav-row-count" aria-hidden="true">{value}{partial && noun !== 'run' ? '+' : ''}</span> };
  const row = (key: string, label: string, icon: IconName, run: () => void, extra?: { title: string; node: ReactNode }) => <button className="nav-row" title={extra?.title} aria-current={current === key ? 'page' : undefined} onClick={run}><Icon name={icon} size={17} /><span className="nav-row-name">{label}</span>{extra?.node}</button>;
  return <nav aria-label="Project" className="project-sections">
    {places && <div className="nav-group nav-places">
      {places.map(p => <button key={p.key} className="nav-row" aria-current={p.current ? 'page' : undefined} onClick={p.run}><Icon name={p.icon} size={17} /><span className="nav-row-name">{p.label}</span>{p.count ? <span className="nav-row-count" aria-hidden="true">{p.count}</span> : null}</button>)}
    </div>}
    <section className="nav-section nav-tasks" aria-label="Agent">
      {/* The Agent, with its conversations under it: the row opens the Agents, + starts a conversation. */}
      <div className="nav-heading nav-parent">
        <button className="nav-row" aria-label={'Agent' + agentState} aria-current={current === 'agents' ? 'page' : undefined} title="The Agents that work on this project" onClick={onAgents}><Icon name="spark" size={17} /><span className="nav-row-name">Agent</span></button>
        <button className="icon-button nav-add" aria-label="New conversation" title="Ask the Agent in a new conversation" onClick={onNewTask}><Icon name="plus" size={15} /></button>
      </div>
      {sessions.length > 0 ? <div role="group" aria-label="Conversations" className="nav-group nav-children">
        {shownSessions.map(s => { const at = when(s.when); return <button key={s.id} className={'nav-row nav-session' + (talking === s.id ? ' talking' : '')} title={s.title + '\n' + s.agent + (at.full ? ' · ' + at.full : '') + (talking === s.id ? '\nIn the Agent panel' : '')} aria-current={current === 'studio:' + s.id ? 'page' : talking === s.id ? 'true' : undefined} onClick={() => onLayout(s.id)}>
          <ProviderMark name={s.agent} size={16} /><span className="nav-row-name">{s.title}</span>
          {s.waiting ? <span className="nav-badge waiting">Needs you</span> : s.running ? <span className="pulse-dot" aria-label="Working" /> : <span className="nav-when" aria-hidden="true">{shortWhen(s.when)}</span>}
        </button>; })}
        {sessions.length > shownSessions.length && <button className="nav-more" aria-label={'All ' + sessions.length + ' conversations'} title="Every conversation: search, usage and the trash" onClick={() => onSection('agent')}>All {sessions.length}<Icon name="chevron" size={11} stroke={2} /></button>}
      </div> : <p className="nav-files-note nav-none">No conversations yet</p>}
      {(layouts.length > 0 || onNewLayout) && <div role="group" aria-label="Workspaces" className="nav-group nav-workspaces">
        {layouts.map(c => <div key={c.compositionId} className={'nav-closing' + (onCloseLayout ? ' closable' : '')}>
          <button className="nav-row nav-workspace" title={compositionName(c.compositionId) + ' · ' + views(c)} aria-current={current === 'studio:' + c.compositionId ? 'page' : undefined} onClick={() => onLayout(c.compositionId)}><Icon name="layout" size={16} /><span className="nav-row-name">{compositionName(c.compositionId)}</span><span className="nav-row-count" aria-hidden="true">{c.views.length}</span></button>
          {onCloseLayout && <button className="icon-button nav-close" aria-label={'Close ' + compositionName(c.compositionId)} title={'Close ' + compositionName(c.compositionId) + '. Its files, sessions and conversations stay.'} onClick={() => onCloseLayout(c.compositionId)}><Icon name="close" size={13} stroke={2} /></button>}
        </div>)}
        {onNewLayout && <button className="nav-row nav-new" onClick={onNewLayout}><Icon name="plus" size={14} stroke={1.8} /><span className="nav-row-name">New workspace</span></button>}
      </div>}
    </section>
    <div className="nav-section nav-sources">
      <div className="nav-heading"><span className="section-label" id="nav-sources">Sources</span><button className="icon-button nav-add" aria-label="Add source folder" title="Add source folder" disabled={adding} onClick={onAddSource}><Icon name="plus" size={15} /></button></div>
      <div role="group" aria-labelledby="nav-sources" className="nav-group">
        {sourceRowOrder.map(kind => {
          const [label, icon, noun] = sourceRows[kind];
          const items = sources?.[kind] ?? null, open = unfolded.includes(kind) || shownRow === kind, extra = count(items?.length, noun);
          // A kind beyond the four every project has is listed while the project holds some.
          if (!baseRows.includes(kind) && !items?.length) return null;
          // The live values sit between the code that makes them and the results kept from them.
          const variables = kind === 'results' && values && <ValuesRow key="variables" values={values} open={unfolded.includes('variables')} onFold={() => fold('variables')} onValue={onValue} onOpen={onVariables} onNotebook={() => onSection('notebook')} />;
          return <Fragment key={kind}>{variables}<div className={'nav-source' + (open ? ' open' : '')}>
            <div className="nav-folding">
              <button className="nav-row" title={(extra ? extra.title + ' · ' : '') + 'Show them in the workspace'} aria-current={current === 'sources:' + kind ? 'page' : undefined} onClick={() => onSources(kind)}>
                <Icon name={icon} size={17} /><span className="nav-row-name">{label}</span>{extra?.node}
              </button>
              <button className="icon-button nav-fold" aria-label={(open ? 'Hide the ' : 'List the ') + noun + 's here'} title={(open ? 'Hide the ' : 'List the ') + noun + 's here'} aria-expanded={open} aria-controls={'nav-files-' + kind} onClick={() => fold(kind)}><span className="nav-twisty" aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span></button>
            </div>
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
function ValuesRow({ values, open, onFold, onValue, onOpen, onNotebook }: { values: LiveValues; open: boolean; onFold: () => void; onValue: (language: ValueLanguage, name: string) => void; onOpen: () => void; onNotebook: () => void }) {
  const total = values.sessions.reduce((n, s) => n + s.variables.length + (s.variablesOmitted ?? 0), 0);
  const busy = values.sessions.some(s => s.state === 'busy');
  const title = !values.read ? undefined : values.sessions.length ? `${total} value${total === 1 ? '' : 's'} in the live ${values.sessions.map(s => s.language === 'r' ? 'R' : 'Python').join(' and ')} session${values.sessions.length === 1 ? '' : 's'}` : 'No live session';
  return <div className={'nav-source' + (open ? ' open' : '')}>
    <div className="nav-folding">
      <button className="nav-row" title={(title ? title + ' · ' : '') + 'Show them in the workspace'} onClick={onOpen}>
        <Icon name="list" size={17} /><span className="nav-row-name">Variables</span>
        {busy && <span className="pulse-dot" aria-label="Running" />}
        {values.sessions.length > 0 && <span className="nav-row-count" aria-hidden="true">{total}</span>}
      </button>
      <button className="icon-button nav-fold" aria-label={(open ? 'Hide the values here' : 'List the values here')} title={(open ? 'Hide the values here' : 'List the values here')} aria-expanded={open} aria-controls="nav-values" onClick={onFold}><span className="nav-twisty" aria-hidden="true"><Icon name="chevron" size={12} stroke={2} /></span></button>
    </div>
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
