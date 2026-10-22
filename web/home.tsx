import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { beneath, lastSegment, type BrowserClient, type FolderSelection, type ProjectSummary, type SourceFolder } from '../src/browser.js';
import { onPlatform } from './platform.js';
import { Icon } from './icons.js';

export function projectName(project: ProjectSummary) { return project.name ?? (lastSegment(project.root) || 'Project'); }
// Today at 05:47 / Yesterday / Oct 9; the full date and time go in the tooltip.
export function when(iso: string, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { text: '', full: '' };
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86400000);
  const text = days === 0 ? 'Today at ' + at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : days === 1 ? 'Yesterday'
    : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return { text, full: at.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }) };
}
// Keyboard focus stays inside an open sheet; Escape and the backdrop close it.
export function trapTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
  const first = items[0], last = items.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
export interface Folder { root?: string; label: string }
export function located(project: ProjectSummary, folder: Folder) {
  if (project.sources) return project.sources.length + (project.sources.length === 1 ? ' source folder' : ' source folders');
  return folder.root && folder.label && beneath(project.root, folder.root) ? folder.label + project.root.slice(folder.root.length) : project.root;
}
interface Problem { text: string; next?: { label: string; run: () => void }; blocks?: boolean }
export function Home({ client, projects, folder, focusRequest, onFocused, onOpened, onChoose, onAccessEnded }: {
  client: BrowserClient; projects: ProjectSummary[]; folder: Folder; focusRequest: boolean; onFocused: () => void;
  onOpened: (project: ProjectSummary) => void; onChoose: (project: ProjectSummary) => void; onAccessEnded: () => void;
}) {
  const [sheet, setSheet] = useState(false), [picking, setPicking] = useState(false), [failure, setFailure] = useState('');
  const trigger = useRef<HTMLElement | null>(null), openButton = useRef<HTMLButtonElement>(null), firstRow = useRef<HTMLButtonElement>(null);
  const sorted = [...projects].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  // "Open a project…" lands on the most recent project, or on Open folder when there is none.
  useEffect(() => { if (focusRequest) { (firstRow.current ?? openButton.current)?.focus(); onFocused(); } }, [focusRequest]);
  async function pickFolder(from: HTMLElement | null) {
    if (picking) return;
    trigger.current = from; setFailure(''); setPicking(true);
    try {
      // The OS dialog has its own bounded lifetime. Do not abort after the SDK's
      // ordinary 30-second read timeout or retry a still-open native window.
      const result = await client.call('project.pick', {}, new AbortController().signal);
      if (result.project) onOpened(result.project);
      else from?.focus();
    } catch (e) {
      const error = (e as { error?: { kind?: string; message?: string } }).error;
      if (error?.kind === 'unauthorized') onAccessEnded();
      else setFailure(error?.message ?? 'The folder could not be confirmed. Check the system folder window, then try again.');
      from?.focus();
    } finally { setPicking(false); requestAnimationFrame(() => from?.focus()); }
  }
  const entries = <>
    <button ref={openButton} disabled={picking} onClick={e => void pickFolder(e.currentTarget)}>Open folder…</button>
    <button className="primary" disabled={picking} onClick={e => { trigger.current = e.currentTarget; setSheet(true); }}><Icon name="plus" size={14} stroke={1.6} />New project</button>
  </>;
  return <section className="home">
    <div className="home-column">
      <header className="home-header">
        <div className="home-title"><h1>{projects.length ? 'Welcome back' : 'Welcome to Rho'}</h1>
          <p>{projects.length ? 'Pick up a project, or open another folder on ' + onPlatform + '.' : 'Open a folder on ' + onPlatform + ', or start a new project.'}</p></div>
        {projects.length > 0 && <div className="home-actions">{entries}</div>}
      </header>
      {projects.length ? <div className="project-list" role="group" aria-labelledby="project-list-label">
        <div className="project-list-heading"><span id="project-list-label">Projects</span><span aria-hidden="true">Added</span></div>
        {sorted.map((p, index) => {
          const added = when(p.openedAt);
          return <button ref={index === 0 ? firstRow : undefined} className="project-row" key={p.id} onClick={() => onChoose(p)}>
            <span className="project-icon"><Icon name="folder" size={18} stroke={1.7} /></span>
            <span className="project-row-name"><strong>{projectName(p)}</strong><small>{located(p, folder)}</small></span>
            <span className="project-row-time" title={added.full}>{added.text && <span className="visually-hidden">Added </span>}{added.text}</span>
            <span className="project-row-chevron"><Icon name="chevron" size={16} stroke={1.5} /></span>
          </button>;
        })}
      </div> : <div className="home-empty">
        <div className="home-empty-text">
          <span className="home-empty-icon"><Icon name="folder-plus" size={22} /></span>
          <h2>No projects yet</h2>
          <p>A project brings your folders together. Create one with the folders you need, or open a folder to get started.</p>
        </div>
        <div className="home-actions">{entries}</div>
      </div>}
      {picking && <p className="home-note" role="status">Choose a folder in the system window. Cancel to return here.</p>}
      {failure && <p className="home-note" role="alert">{failure}</p>}
      <p className="home-note"><Icon name="info" size={14} stroke={1.3} />Opening a folder starts no tasks and installs nothing.</p>
    </div>
    {sheet && <ProjectSheet client={client} folder={folder} onOpened={onOpened} onAccessEnded={onAccessEnded} onClose={() => { setSheet(false); trigger.current?.focus(); }} />}
  </section>;
}
function ProjectSheet({ client, onClose, onOpened, onAccessEnded }: {
  client: BrowserClient; folder: Folder; onClose: () => void; onOpened: (project: ProjectSummary) => void; onAccessEnded: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(''), [folders, setFolders] = useState<FolderSelection[]>([]);
  const creation = useRef<{ key: string; changeId: string } | null>(null);
  // A problem names the next step: an alternative action, or what to change before trying again.
  const [failure, setFailure] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  const name = value.trim();
  const check: Problem | null = name.length > 80 ? { text: 'Use a name of 80 characters or fewer.', blocks: true } : null;
  const problem = check ?? failure;
  function change(text: string) { setValue(text); setFailure(null); }
  async function attempt(work: () => Promise<ProjectSummary>, explain: (kind: string, message: string) => Problem) {
    setBusy(true); setFailure(null);
    try { onOpened(await work()); }
    catch (e) {
      const error = (e as { error?: { kind?: string; message?: string } }).error;
      if (error?.kind === 'unauthorized') { onAccessEnded(); return; }
      setFailure(explain(error?.kind ?? '', error?.message ?? (e instanceof Error ? e.message : 'The request could not be confirmed.')));
    } finally { setBusy(false); }
  }
  async function addFolder(from: HTMLButtonElement) {
    setBusy(true); setFailure(null);
    try {
      const { selection } = await client.call('project.source.pick', {}, new AbortController().signal);
      if (selection) setFolders(previous => previous.some(f => f.root === selection.root) ? previous : [...previous, selection]);
    } catch (e) {
      const error = (e as { error?: { kind?: string; message?: string } }).error;
      if (error?.kind === 'unauthorized') onAccessEnded(); else setFailure({ text: error?.message ?? 'The folder could not be selected. Try Add folder again.' });
    } finally { setBusy(false); requestAnimationFrame(() => from.focus()); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name || !folders.length || problem?.blocks) return;
    const selectionIds = folders.map(f => f.selectionId), key = JSON.stringify({ name, selectionIds });
    if (creation.current?.key !== key) creation.current = { key, changeId: crypto.randomUUID() };
    void attempt(() => client.call('project.createWorkspace', { name, selectionIds, changeId: creation.current!.changeId }), (_k, message) => ({ text: message }));
  }
  return <dialog ref={dialog} className="sheet project-sheet" aria-labelledby="sheet-title" onKeyDown={trapTab}
    onCancel={e => { if (busy) e.preventDefault(); }} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget && !busy) e.currentTarget.close(); }}>
    <form onSubmit={submit}>
      <div className="sheet-body">
        <h2 id="sheet-title">Create project</h2>
        <div className={'field' + (problem ? ' invalid' : '')}>
          <label htmlFor="sheet-input">Project name</label>
          <input id="sheet-input" ref={input} placeholder="Project name" value={value} onChange={e => change(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!check} />
        </div>
        <div className="field"><span id="source-folders-label">Source folders</span>
          <SourceFolders folders={folders} busy={busy} onAdd={from => void addFolder(from)} onRemove={id => setFolders(previous => previous.filter(f => f.id !== id))} />
        </div>
        {problem && <p className="field-hint project-problem" role="alert">{problem.text}</p>}
      </div>
      <div className="sheet-footer">
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !name || !folders.length || !!problem?.blocks}>Create project</button>
      </div>
    </form>
  </dialog>;
}

export function SourceFolders({ folders, busy, onAdd, onRemove }: { folders: SourceFolder[]; busy: boolean; onAdd: (from: HTMLButtonElement) => void; onRemove?: (id: string) => void }) {
  return <div className="source-folders" role="group" aria-label="Source folders">
    {folders.length ? <ul>{folders.map(folder => <li key={folder.id}>
      <Icon name="folder" size={18} /><span className="source-folder-name"><strong>{folder.name}</strong><small>{folder.root}</small></span>
      {onRemove && <button type="button" className="icon-button" disabled={busy} aria-label={'Remove ' + folder.name} onClick={() => onRemove(folder.id)}>×</button>}
    </li>)}</ul> : <p>Add a folder on this computer</p>}
    <button type="button" disabled={busy} onClick={e => onAdd(e.currentTarget)}><Icon name="folder-plus" size={16} />{busy ? 'Choosing folder…' : 'Add folder…'}</button>
  </div>;
}
