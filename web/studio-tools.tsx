import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { ConsolePage } from './console.js';
import { Icon, type IconName } from './icons.js';
import { fileIcon, size, sourceLabels, type Entry } from './project.js';
import { TerminalPane } from './terminal.js';
import { folderName, kindOf, type ProjectFiles, type ResourceRef, type SourceItem, type SourceRow } from './sources.js';
import './studio-tools.css';

// The project's own tools as views of a Studio workspace, beside the files and sessions they
// work on: the Console, the folders as a file explorer, and each kind of file as a list. A file
// chosen in one opens as a view of the same workspace, so the person stays where the work is.
export interface StudioTools {
  files: ProjectFiles; sources: Record<SourceRow, SourceItem[]> | null;
  // A project file, or a registered result as exactly that version, as a view of this workspace.
  open(target: string | ResourceRef): void;
  conversation(id: string): void;
  // The message whose commands the Console opens at.
  consoleTurn: string | null;
}
export const StudioToolsContext = createContext<StudioTools | null>(null);
const outside = <p className="tool-note">This view shows in a Studio workspace.</p>;

// The Terminal view has two forms. Terminal is the person's own shell, in the project folder.
// Commands is the record: the Agent's commands by message, the person's single commands between
// them, and a line to run one. The view keeps its form and its terminal with the page.
export type TerminalForm = 'terminal' | 'commands';
export function ConsoleView({ client, snapshot, view, headerTarget, onProps }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; view: { props: Record<string, unknown> };
  headerTarget?: HTMLElement | null; onProps?: (props: Record<string, unknown>) => void;
}) {
  const tools = useContext(StudioToolsContext);
  // Only the person at this machine has a terminal; another tab reads the commands.
  const typed = snapshot.catalog.operations.some(o => o.method === 'console.terminal.open' && o.authorized && o.state === 'available');
  const saved: TerminalForm = view.props.form === 'commands' || !typed ? 'commands' : 'terminal';
  const [form, setForm] = useState<TerminalForm>(saved);
  useEffect(() => setForm(saved), [saved]);
  // A message's commands, asked for from the board, show in the record.
  useEffect(() => { if (tools?.consoleTurn) setForm('commands'); }, [tools?.consoleTurn]);
  if (!tools) return outside;
  const choose = (next: TerminalForm) => { setForm(next); onProps?.({ form: next }); };
  return <>
    {headerTarget && typed && createPortal(<div className="tool-forms" role="group" aria-label="Show">
      <button type="button" aria-pressed={form === 'terminal'} title="Your shell, in the project folder" onClick={() => choose('terminal')}>Terminal</button>
      <button type="button" aria-pressed={form === 'commands'} title="The commands the Agent ran, by message, and single commands of your own" onClick={() => choose('commands')}>Commands</button>
    </div>, headerTarget)}
    {form === 'terminal'
      ? <TerminalPane client={client} projectId={snapshot.project.id} terminalId={typeof view.props.terminal === 'string' ? view.props.terminal : null} onTerminal={terminal => onProps?.({ terminal })} onCommands={() => choose('commands')} />
      : <div className="tool-pane tool-console"><ConsolePage client={client} snapshot={snapshot} files={tools.files} focusTurn={tools.consoleTurn} onPath={tools.open} onConversation={tools.conversation} /></div>}
  </>;
}

const day = (iso?: string) => {
  if (!iso) return '';
  const at = new Date(iso), now = new Date();
  if (Number.isNaN(at.getTime())) return '';
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
};
const entryIcon = (entry: Pick<Entry, 'path' | 'kind'>): IconName => {
  if (entry.kind === 'folder') return 'folder';
  const kind = kindOf(entry.path);
  return kind === 'figures' ? 'image' : kind === 'code' ? 'code' : kind === 'notes' ? 'document' : kind ? 'table' : 'file';
};
type Listing = { entries: Entry[]; truncated: boolean; total: number } | { problem: string } | 'reading';

// The project's folders as a file explorer: a folder opens in place, one level at a time, and a
// file opens as a view of this workspace. Filtering looks through the files the sidebar counted.
export function FilesView({ client, snapshot }: { client: BrowserClient; snapshot: WorkspaceSnapshot }) {
  const tools = useContext(StudioToolsContext);
  const projectId = snapshot.project.id;
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const [query, setQuery] = useState(''), [hidden, setHidden] = useState(false);
  const reads = useRef(0);
  async function read(path: string) {
    const mine = reads.current;
    setListings(now => now[path] && now[path] !== 'reading' ? now : { ...now, [path]: 'reading' });
    try {
      const result = await client.call('project.entries', { projectId, ...(path ? { path } : {}) });
      if (mine === reads.current) setListings(now => ({ ...now, [path]: { entries: result.entries as Entry[], truncated: !!result.truncated, total: Number((result as { total?: number }).total ?? result.entries.length) } }));
    } catch (error) { if (mine === reads.current) setListings(now => ({ ...now, [path]: { problem: error instanceof Error ? error.message : 'This folder could not be read.' } })); }
  }
  // Every folder on show is read again: after Refresh, and when the sidebar's walk found changes.
  const again = () => { reads.current++; setListings({}); void read(''); for (const path of unfolded) void read(path); };
  useEffect(again, [projectId, tools?.files.readAt]);
  function fold(path: string) {
    if (unfolded.includes(path)) { setUnfolded(unfolded.filter(p => p !== path && !p.startsWith(path + '/'))); return; }
    setUnfolded([...unfolded, path]);
    if (!listings[path]) void read(path);
  }
  const words = query.trim().toLocaleLowerCase();
  const found = useMemo(() => words ? (tools?.files.files ?? []).filter(f => f.path.toLocaleLowerCase().includes(words)).slice(0, filesLimits.matches) : [], [words, tools?.files.files]);
  if (!tools) return outside;
  const rows = (path: string, depth: number): React.ReactNode[] => {
    const listing = listings[path];
    if (!listing || listing === 'reading') return [<li key={path + ':reading'} className="files-note" style={{ paddingLeft: 12 + depth * 16 }} role="status">Reading…</li>];
    if ('problem' in listing) return [<li key={path + ':problem'} className="files-note" style={{ paddingLeft: 12 + depth * 16 }} role="alert">{listing.problem} <button className="text-button" onClick={() => void read(path)}>Try again</button></li>];
    const shown = listing.entries.filter(e => hidden || !e.hidden).sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const out: React.ReactNode[] = [];
    for (const entry of shown) {
      const open = entry.kind === 'folder' && unfolded.includes(entry.path);
      out.push(<li key={entry.path}>
        <button className={'files-row' + (entry.hidden ? ' hidden-entry' : '')} style={{ paddingLeft: 8 + depth * 16 }} aria-expanded={entry.kind === 'folder' ? open : undefined} title={entry.path}
          onClick={() => entry.kind === 'folder' ? fold(entry.path) : tools.open(entry.path)}>
          <span className={'files-twisty' + (open ? ' open' : '')} aria-hidden="true">{entry.kind === 'folder' && <Icon name="chevron" size={11} stroke={2} />}</span>
          <Icon name={entryIcon(entry)} size={15} stroke={1.7} />
          <span className="files-name">{entry.name}</span>
          <span className="files-size">{entry.kind === 'file' ? size(entry.bytes) : ''}</span>
          <span className="files-when">{day(entry.modifiedAt)}</span>
        </button>
      </li>);
      if (open) out.push(...rows(entry.path, depth + 1));
    }
    if (!shown.length) out.push(<li key={path + ':empty'} className="files-note" style={{ paddingLeft: 12 + depth * 16 }}>{listing.entries.length ? 'Only hidden files' : 'Empty'}</li>);
    if (listing.truncated) out.push(<li key={path + ':more'} className="files-note" style={{ paddingLeft: 12 + depth * 16 }}>Showing {listing.entries.length} of {listing.total} entries.</li>);
    return out;
  };
  return <div className="tool-pane tool-files">
    <div className="tool-bar">
      <label className="tool-search"><Icon name="search" size={14} /><input type="search" aria-label="Find a file by name" placeholder="Find a file" value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
      <button className={'icon-button' + (hidden ? ' on' : '')} aria-pressed={hidden} aria-label="Show hidden files" title={hidden ? 'Hide hidden files' : 'Show hidden files'} onClick={() => setHidden(!hidden)}><Icon name="eye" size={15} /></button>
      <button className="icon-button" aria-label="Read the folders again" title="Read the folders again" onClick={() => { again(); tools.files.refresh(); }}><Icon name="refresh" size={15} /></button>
    </div>
    {words ? <ul className="files-list" aria-label="Files found">
      {found.map(file => <li key={file.path}><button className="files-row" style={{ paddingLeft: 8 }} title={file.path} onClick={() => tools.open(file.path)}>
        <span className="files-twisty" aria-hidden="true" /><Icon name={entryIcon(file)} size={15} stroke={1.7} />
        <span className="files-name">{file.name}<small>{folderName(file.path, snapshot.project)}</small></span><span className="files-size">{size(file.bytes)}</span><span className="files-when">{day(file.modifiedAt)}</span>
      </button></li>)}
      {!found.length && <li className="files-note">{tools.files.reading && !tools.files.readAt ? 'Reading the project folders…' : 'No file name has “' + query.trim() + '”.'}</li>}
      {found.length === filesLimits.matches && <li className="files-note">The first {filesLimits.matches} are shown.</li>}
      {tools.files.truncated && <li className="files-note">Deeper folders were not read; open them below to look inside.</li>}
    </ul> : <ul className="files-list" aria-label="Project files">{rows('', 0)}</ul>}
  </div>;
}
// A search shows this many matching files.
export const filesLimits = { matches: 200 };

// One kind of the project's files as a list: by folder, with what each one is and when it last
// changed, newest first where the kind is what the work made. A file opens beside this list.
export function KindView({ kind, snapshot }: { kind: SourceRow; snapshot: WorkspaceSnapshot }) {
  const tools = useContext(StudioToolsContext);
  const [query, setQuery] = useState('');
  const items = tools?.sources?.[kind] ?? null;
  const modified = useMemo(() => new Map((tools?.files.files ?? []).map(f => [f.path, f.modifiedAt] as const)), [tools?.files.files]);
  if (!tools) return outside;
  const words = query.trim().toLocaleLowerCase();
  const shown = (items ?? []).filter(item => !words || item.path.toLocaleLowerCase().includes(words));
  // What the work made reads newest first; what it started from reads by folder.
  const made = kind === 'results' || kind === 'reports';
  const ordered = made ? [...shown].sort((a, b) => (modified.get(b.path) ?? '').localeCompare(modified.get(a.path) ?? '')) : shown;
  const groups = new Map<string, SourceItem[]>();
  for (const item of ordered) { const key = made ? '' : item.folder; groups.set(key, [...(groups.get(key) ?? []), item]); }
  return <div className="tool-pane tool-kind">
    <div className="tool-bar">
      <label className="tool-search"><Icon name="search" size={14} /><input type="search" aria-label={'Filter ' + sourceLabels[kind].toLowerCase()} placeholder={'Filter ' + sourceLabels[kind].toLowerCase()} value={query} spellCheck={false} onChange={event => setQuery(event.target.value)} /></label>
      <span className="tool-count" title={tools.files.truncated ? 'Deeper folders were not read' : undefined}>{items ? items.length + (tools.files.truncated ? '+' : '') : ''}</span>
      <button className="icon-button" aria-label="Read the folders again" title="Read the folders again" disabled={tools.files.reading} onClick={tools.files.refresh}><Icon name="refresh" size={15} /></button>
    </div>
    {!items ? <p className="tool-note" role="status">Reading the project folders…</p>
      : !items.length ? <p className="tool-note">{tools.files.truncated ? 'None in the folders read.' : 'None in this project yet.'}</p>
      : !shown.length ? <p className="tool-note">Nothing here has “{query.trim()}”. <button className="text-button" onClick={() => setQuery('')}>Clear</button></p>
      : <div className="files-list kind-list">{[...groups].map(([folder, list]) => <section key={folder} aria-label={folder || sourceLabels[kind]}>
        {folder && <h3 className="kind-folder"><Icon name="folder" size={13} stroke={1.7} />{folder}</h3>}
        <ul>{list.map(item => <li key={item.key}><button className="files-row" style={{ paddingLeft: folder ? 20 : 8 }} title={item.path} onClick={() => tools.open(item.resource ?? item.path)}>
          <Icon name={fileIcon(item)} size={15} stroke={1.7} />
          <span className="files-name">{item.name}{made && <small>{item.folder}</small>}</span>
          <span className="files-size">{item.resource ? 'Result' : item.bytes !== null ? size(item.bytes) : ''}</span>
          <span className="files-when">{day(modified.get(item.path))}</span>
        </button></li>)}</ul>
      </section>)}</div>}
  </div>;
}
