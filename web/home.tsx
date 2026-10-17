import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { BrowserClient, ProjectSummary } from '../src/browser.js';
import { Icon } from './icons.js';

export function projectName(project: ProjectSummary) { return project.root.split('/').filter(Boolean).at(-1) ?? 'Project'; }
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
interface Folder { root?: string; label: string }
function located(project: ProjectSummary, folder: Folder) {
  return folder.root && folder.label && (project.root === folder.root || project.root.startsWith(folder.root + '/')) ? folder.label + project.root.slice(folder.root.length) : project.root;
}
type Kind = 'new' | 'open';
interface Problem { text: string; next?: { label: string; run: () => void }; blocks?: boolean }
export function Home({ client, projects, folder, focusRequest, onFocused, onOpened, onChoose, onAccessEnded }: {
  client: BrowserClient; projects: ProjectSummary[]; folder: Folder; focusRequest: boolean; onFocused: () => void;
  onOpened: (project: ProjectSummary) => void; onChoose: (project: ProjectSummary) => void; onAccessEnded: () => void;
}) {
  const [sheet, setSheet] = useState<Kind | null>(null);
  const trigger = useRef<HTMLElement | null>(null), openButton = useRef<HTMLButtonElement>(null), firstRow = useRef<HTMLButtonElement>(null);
  const where = folder.label || 'your projects folder';
  const sorted = [...projects].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  // "Open a project…" lands on the most recent project, or on Open folder when there is none.
  useEffect(() => { if (focusRequest) { (firstRow.current ?? openButton.current)?.focus(); onFocused(); } }, [focusRequest]);
  function show(kind: Kind, from: HTMLElement) { trigger.current = from; setSheet(kind); }
  const entries = <>
    <button ref={openButton} onClick={e => show('open', e.currentTarget)}>Open folder…</button>
    <button className="primary" onClick={e => show('new', e.currentTarget)}><Icon name="plus" size={14} stroke={1.6} />New project</button>
  </>;
  return <section className="home">
    <div className="home-column">
      <header className="home-header">
        <div className="home-title"><h1>{projects.length ? 'Welcome back' : 'Welcome to Rho'}</h1>
          <p>{projects.length ? `Pick up a project in ${where}, or start a new one.` : `This tab can open projects in ${where}.`}</p></div>
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
          <p>A project is a folder. Open one that already has your files, or start an empty one. Projects you open appear here.</p>
        </div>
        <div className="home-actions">{entries}</div>
      </div>}
      <p className="home-note"><Icon name="info" size={14} stroke={1.3} />Opening a project only reads it. Nothing runs, installs or changes.</p>
    </div>
    {sheet && <ProjectSheet initial={sheet} client={client} folder={folder} onOpened={onOpened} onAccessEnded={onAccessEnded} onClose={() => { setSheet(null); trigger.current?.focus(); }} />}
  </section>;
}
const reserved = ['.', '..', '.rho', '.git'];
function ProjectSheet({ initial, client, folder, onClose, onOpened, onAccessEnded }: {
  initial: Kind; client: BrowserClient; folder: Folder; onClose: () => void; onOpened: (project: ProjectSummary) => void; onAccessEnded: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState(initial), [value, setValue] = useState('');
  // A problem names the next step: an alternative action, or what to change before trying again.
  const [failure, setFailure] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const where = folder.label || 'your projects folder';
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  useEffect(() => { input.current?.focus(); }, [kind]);
  const name = value.trim();
  // A typed absolute path inside the folder is accepted as its relative form.
  const inside = [folder.root, folder.label].find(prefix => prefix && (name === prefix || name.startsWith(prefix + '/')));
  const relative = inside ? name.slice(inside.length + 1) || '.' : name;
  const outside = kind === 'open' && (!inside && /^([/~]|[A-Za-z]:[\\/])/.test(name) || relative.split(/[\\/]/).includes('..'));
  const check: Problem | null = kind === 'new'
    ? /[\\/]/.test(name) ? { text: `A name can't include “/”. To open a folder inside ${where}, use Open folder.`, next: { label: 'Use Open folder', run: () => switchTo('open') } }
      : reserved.includes(name) ? { text: `“${name}” is reserved. Choose another name.`, blocks: true }
      : name.length > 80 ? { text: 'Use a name of 80 characters or fewer.', blocks: true } : null
    : outside ? { text: `That path is outside ${where}. Ask your Agent to open Rho for a folder that includes it.`, blocks: true } : null;
  const problem = check ?? failure;
  function switchTo(next: Kind) { setFailure(null); setKind(next); }
  // A pasted full path inside the folder keeps only the part after the fixed prefix.
  function change(text: string) {
    const prefix = kind === 'open' && [folder.root, folder.label].find(p => p && text.trim().startsWith(p + '/'));
    setValue(prefix ? text.trim().slice(prefix.length + 1) : text); setFailure(null);
  }
  async function attempt(work: () => Promise<ProjectSummary>, explain: (kind: string, message: string) => Problem) {
    setBusy(true); setFailure(null);
    try { onOpened(await work()); }
    catch (e) {
      const error = (e as { error?: { kind?: string; message?: string } }).error;
      if (error?.kind === 'unauthorized') { onAccessEnded(); return; }
      setFailure(explain(error?.kind ?? '', error?.message ?? (e instanceof Error ? e.message : 'The request could not be confirmed.')));
    } finally { setBusy(false); }
  }
  const create = (target: string) => attempt(() => client.call('project.create', { name: target }), (k, message) => k === 'conflict'
    ? { text: `${where}/${target} already exists.`, next: { label: 'Open existing', run: () => void open(target) } }
    : { text: message });
  const open = (target: string) => attempt(() => client.call('project.open', { path: target }), (k, message) => k === 'not_found'
    ? /^[^\\/]+$/.test(target) && !reserved.includes(target) && target.length <= 80
      ? { text: `${target} isn't in ${where}. Check the name, or create it as a new project.`, next: { label: 'Create it', run: () => void create(target) } }
      : { text: `${target} isn't in ${where}. Check the path.`, blocks: true }
    : k === 'scope' ? { text: `That folder can't be opened from this tab. ${message}`, blocks: true } : { text: message });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name) return;
    if (problem?.next) problem.next.run();
    else if (!problem?.blocks) void (kind === 'new' ? create(name) : open(relative));
  }
  const hint = problem?.text ?? (kind === 'new'
    ? name ? `Creates an empty folder at ${where}/${name}. Nothing is installed.` : `Creates an empty folder in ${where}. Nothing is installed.`
    : `A path inside ${where}. Folders outside it can't be opened from this tab.`);
  const title = kind === 'new' ? 'New project' : 'Open folder';
  return <dialog ref={dialog} className="sheet" aria-labelledby="sheet-title" onKeyDown={trapTab}
    onCancel={e => { if (busy) e.preventDefault(); }} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget && !busy) e.currentTarget.close(); }}>
    <form onSubmit={submit}>
      <div className="sheet-body">
        <h2 id="sheet-title">{title}</h2>
        <div className={'field' + (problem ? ' invalid' : '')}>
          <label htmlFor="sheet-input">{kind === 'new' ? 'Name' : 'Folder'}</label>
          {kind === 'new'
            ? <input id="sheet-input" ref={input} value={value} onChange={e => change(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!problem} aria-describedby="sheet-hint" />
            : <div className="prefixed-input">{folder.label && <span className="input-prefix" aria-hidden="true"><bdi>{folder.label}/</bdi></span>}
              <input id="sheet-input" ref={input} value={value} onChange={e => change(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!problem} aria-describedby="sheet-hint" /></div>}
          <p id="sheet-hint" className="field-hint" aria-live={problem ? 'polite' : 'off'}>{hint}</p>
        </div>
      </div>
      <div className="sheet-footer">
        <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !name || (!!problem?.blocks && !problem.next)}>{problem?.next?.label ?? (kind === 'new' ? 'Create' : 'Open')}</button>
      </div>
    </form>
  </dialog>;
}
