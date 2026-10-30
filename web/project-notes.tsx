import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import { notesSections, projectNotesPath, sessionTitles, type NotesSection } from '../src/project-notes.js';
import type { ProjectFiles } from './sources.js';
import { OwnerView } from './shell/owner.js';
import { Icon } from './icons.js';
import './notes.css';

// The person's own edits to the notes reach the file after this pause, so every session reads
// them with its own tools. An Agent's edits in the buffer are saved by the Agent.
export const notesTiming = { saveAfterMs: 1500 };
export type NotesSave = { state: 'saved' | 'saving' | 'unsaved' | 'failed'; at?: number; note?: string } | null;
export interface ProjectNotes {
  documentId: string | null; text: string; sections: NotesSection[]; titles: Map<string, string>;
  save: NotesSave; problem: string;
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// The project's notes, kept open in their one shared buffer for as long as the project is: the
// text, its sections and the session titles they give. The buffer follows the file when an Agent
// writes it with its own tools.
export function useProjectNotes(client: BrowserClient, snapshot: WorkspaceSnapshot | null, files: ProjectFiles, principalId?: string): ProjectNotes {
  const projectId = snapshot?.project.id;
  const can = (method: string) => !!snapshot?.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized);
  const readable = can('document.open') && can('document.read'), saveable = can('document.save');
  const [documentId, setDocumentId] = useState<string | null>(null), [text, setText] = useState(''), [problem, setProblem] = useState('');
  const [save, setSave] = useState<NotesSave>(null);
  useEffect(() => { setDocumentId(null); setText(''); setProblem(''); setSave(null); }, [projectId]);
  const file = files.files.find(f => f.path === projectNotesPath)?.modifiedAt ?? null;
  // Opening again when the file changes lets Documents take the new text into the buffer.
  useEffect(() => {
    if (!projectId || !readable) return;
    let live = true;
    client.call('document.open', { projectId, path: projectNotesPath }).then(d => { if (live) { setDocumentId(d.id); setProblem(''); } },
      error => { if (live) setProblem(error instanceof Error ? error.message : 'The project notes could not be opened.'); });
    return () => { live = false; };
  }, [client, projectId, readable, file]);
  const doc = documentId ? snapshot?.documents.find(d => d.id === documentId) : undefined;
  useEffect(() => {
    if (!projectId || !documentId) return;
    let live = true;
    client.call('document.read', { projectId, documentId }).then(b => { if (live) setText(b.content); }, () => undefined);
    return () => { live = false; };
  }, [client, projectId, documentId, doc?.version]);
  // Saved after a pause in the person's own typing, with the conditions the buffer stood at;
  // a lost reply repeats the same request once.
  useEffect(() => {
    if (!projectId || !doc || !saveable) return;
    if (!doc.dirty) { setSave(s => s?.state === 'saving' || s?.state === 'unsaved' ? { state: 'saved', at: Date.now() } : s); return; }
    if (principalId && doc.author !== principalId) return;
    setSave({ state: 'unsaved' });
    const input = { projectId, documentId: doc.id, expectedVersion: doc.version, expectedRevision: doc.revision ?? 0, expectedDiskDigest: doc.diskDigest, changeId: 'notes-' + crypto.randomUUID() };
    const timer = setTimeout(() => {
      setSave({ state: 'saving' });
      const attempt = (again: boolean): Promise<unknown> => client.call('document.save', input).catch(error => {
        if (again && !(error as { error?: { kind?: string } })?.error?.kind) return attempt(false);
        throw error;
      });
      attempt(true).then(() => setSave({ state: 'saved', at: Date.now() }), error => setSave({ state: 'failed', note: error instanceof Error ? error.message : 'The notes could not be saved.' }));
    }, notesTiming.saveAfterMs);
    return () => clearTimeout(timer);
  }, [client, projectId, doc?.id, doc?.version, doc?.dirty, saveable, principalId]);
  const sections = useMemo(() => notesSections(text), [text]), titles = useMemo(() => sessionTitles(text), [text]);
  return { documentId, text, sections, titles, save, problem };
}

const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
// The notes beside every Studio layout: one view of the shared buffer, read formatted, ticked in
// place and edited as Markdown. In a session's Studio it opens at that session's section.
export function NotesPanel({ notes, snapshot, client, principalId, section, onClose, onAbout }: {
  notes: ProjectNotes; snapshot: WorkspaceSnapshot; client: BrowserClient; principalId?: string;
  section: string | null; onClose: () => void; onAbout: (pluginId: string) => void;
}) {
  const [header, setHeader] = useState<HTMLElement | null>(null), body = useRef<HTMLDivElement>(null);
  const reader = snapshot.catalog.components.find(c => c.id === 'markdown.reader') ?? snapshot.catalog.components.find(c => c.id === 'rho.editor');
  const view = useMemo(() => notes.documentId && reader ? { id: 'project-notes', component: reader.id, version: reader.version, props: { title: 'Project notes' }, bindings: { document: { kind: 'live-document' as const, documentId: notes.documentId } } } : null, [notes.documentId, reader?.id, reader?.version]);
  // The session's own section comes to the top of the panel when its Studio opens.
  useLayoutEffect(() => {
    const root = body.current;
    if (!root || !section) return;
    const find = () => [...root.querySelectorAll<HTMLElement>('[data-rho-heading]')].find(h => normal(h.textContent ?? '') === normal(section));
    let tries = 0;
    const timer = setInterval(() => {
      const heading = find();
      if (heading || ++tries > 20) { clearInterval(timer); root.querySelectorAll('.notes-current').forEach(h => h.classList.remove('notes-current')); if (heading) { heading.classList.add('notes-current'); heading.scrollIntoView({ block: 'start' }); } }
    }, 100);
    return () => clearInterval(timer);
  }, [section, notes.documentId]);
  const save = notes.save;
  return <aside className="notes-panel" aria-label="Project notes">
    <header className="notes-head">
      <Icon name="document" size={15} />
      <span className="notes-title"><strong>Project notes</strong>
        {save && <small className={'notes-save ' + save.state} role="status" title={save.note}>{save.state === 'saved' ? 'Saved ' + clock(save.at!) : save.state === 'saving' ? 'Saving…' : save.state === 'unsaved' ? 'Unsaved' : 'Not saved'}</small>}</span>
      <span ref={setHeader} className="notes-modes" />
      <button className="icon-button" aria-label="Hide notes" title="Hide notes" onClick={onClose}><Icon name="close" size={15} /></button>
    </header>
    <div ref={body} className="notes-body">
      {notes.problem ? <p className="notes-note" role="alert">{notes.problem}</p>
        : !view ? <p className="notes-note">Opening the notes…</p>
        : <>
          {!notes.text.trim() && <p className="notes-note">Each session started in Rho keeps a section here: its question, data and method, key results and what is left to do. You can write here too.</p>}
          <OwnerView active params={{ view, snapshot, client, principalId, compositionId: 'project-notes', compositionVersion: 0, contextTarget: null, headerTarget: header, renderAllowed: true, onAbout }} />
        </>}
    </div>
  </aside>;
}
