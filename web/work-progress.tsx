import { useEffect, useRef, useState } from 'react';
import { SessionProgress } from '@rho-workspace/plugin-agent/ui';
import { Icon, type IconName } from './icons.js';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';

export type Work = RhoOutput<'project.work.read'>;
export interface ProjectWork { work: Work | null; problem: string; reading: boolean; refresh: () => void }
const stateWords: Record<string, string> = { running: 'Answering', completed: 'Last message answered', failed: 'Last message failed', stopped: 'Stopped', unknown: 'Outcome unknown', retained: 'Retained native activity', idle: 'No messages' };
// The project's work as one bounded read, repeated while it is shown: linked Agent sessions,
// the files their tools named and the shared notes. Reading starts no Agent or Host.
export function useProjectWork(client: BrowserClient, snapshot: WorkspaceSnapshot, enabled: boolean, onPresence: (present: boolean) => void): ProjectWork {
  const [work, setWork] = useState<Work | null>(null), [problem, setProblem] = useState(''), [reading, setReading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), request = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true, busy = false, again = false;
    const controller = new AbortController();
    const read = async () => {
      if (busy) { again = true; return; } busy = true; setReading(true);
      try {
        const next = await client.call('project.work.read', { projectId: snapshot.project.id }, controller.signal);
        if (live) { setWork(next); setProblem(''); onPresence(next.sessions.length > 0); }
      } catch (e) { if (live) setProblem(e instanceof Error ? e.message : 'Could not read project work.'); }
      finally { busy = false; if (live) { setReading(false); if (again) { again = false; schedule(); } } }
    };
    const schedule = () => { if (!timer.current) timer.current = setTimeout(() => { timer.current = null; void read(); }, 750); };
    request.current = schedule; void read();
    // External ACP connections are owned outside this service and have their own cursor.
    const external = setInterval(() => { if (!document.hidden) schedule(); }, 1500);
    return () => { clearInterval(external); live = false; controller.abort(); if (timer.current) clearTimeout(timer.current); timer.current = null; request.current = null; };
  }, [client, snapshot.project.id, enabled]);
  useEffect(() => { request.current?.(); }, [snapshot.cursor]);
  return { work, problem, reading, refresh: () => request.current?.() };
}

// Work in progress: a conversation started in Rho shows here while it answers or waits for a
// choice. Finished ones are listed once, on the Agent page.
export function WorkSessions({ state, openConversation, openActivity }: { state: ProjectWork; openConversation: (id: string) => void; openActivity: () => void }) {
  const { work, problem, reading, refresh } = state;
  const shown = work?.sessions.filter(session => !session.conversationId || session.state === 'running' || (session.pendingPermissions ?? 0) > 0) ?? [];
  if (!shown.length && !problem) return null;
  return <section className="project-section project-work" aria-label="Project work">
    <div className="section-heading"><h2>Work progress</h2><button className="text-button" disabled={reading} onClick={refresh}>{reading ? 'Reading…' : 'Refresh'}</button></div>
    {problem && <p role="alert">{problem} Retained observations remain below.</p>}
    {shown.length > 0 && <div className="work-sessions">{shown.map(session => <article className="work-session" key={session.id}>
      <header><div><h3>{session.title}</h3><p>{stateWords[session.state] ?? session.state} · {session.source === 'acp' ? (session.agent === 'codex' ? 'Codex · ACP' : 'Claude Code · ACP') : session.source === 'external-acp' ? 'External ACP' : session.source === 'native-transcript' ? 'Native transcript' : 'Claude CLI'}</p></div>
        {session.conversationId ? <button onClick={() => openConversation(session.conversationId!)}>Continue conversation</button> : session.source === 'external-acp' ? <span className="muted">Input stays in the original client</span> : <button onClick={openActivity}>View activity</button>}</header>
      {session.observation ? <SessionProgress observation={session.observation} /> : session.source === 'native-transcript' ? <p className="muted">Input stays in the original window. Retained through cursor {session.cursor}; {session.droppedEvents ?? 0} events dropped.</p> : <p className="muted">No session projection retained yet.</p>}
      {session.source === 'external-acp' && <>
        {(session.pendingPermissions ?? 0) > 0 && <p role="status">Waiting for a permission choice in the original client.</p>}
        {session.lastMessage && <details><summary>Latest reply · read only</summary><p className="external-reply">{session.lastMessage}</p>{(session.omittedMessageChars ?? 0) > 0 && <small>Later reply text was not retained.</small>}</details>}
      </>}
    </article>)}</div>}
  </section>;
}

const iconFor = (path: string): IconName => /\.(png|jpe?g|svg|gif|pdf|tiff?|webp)$/i.test(path) ? 'image' : /\.(csv|tsv|xlsx?|parquet|rds|rda|feather)$/i.test(path) ? 'table'
  : /\.(R|r|py|sh|sql|js|ts|jl|Rmd|qmd)$/.test(path) ? 'code' : /\.(md|txt)$/i.test(path) ? 'document' : 'file';
// The files the Agent's tools named, most used first, each with a bar for how often. A tool
// naming a file does not say who wrote it; the file's own bytes and history stay in Files.
export function TouchedFiles({ work, openFile, openActivity }: { work: Work | null; openFile: (path: string) => void; openActivity: () => void }) {
  if (!work || (!work.files.length && !work.omitted.fileReferences)) return null;
  const files = [...work.files].sort((a, b) => b.references.length - a.references.length);
  const most = Math.max(1, ...files.map(file => file.references.length)), omitted = work.omitted.fileReferences;
  return <section className="project-section touched-files" aria-labelledby="touched-title">
    <div className="section-heading"><h2 id="touched-title">Files the Agent used</h2><span className="touched-unit">Tool calls</span></div>
    <ul className="touched-list">{files.map((file, i) => {
      const parts = file.path.split('/'), name = parts.pop()!, folder = parts.join('/'), observed = file.state === 'observed';
      const sessions = [...new Set(file.references.map(ref => work.sessions.find(s => s.id === ref.session)?.title ?? ref.session))];
      return <li key={file.path}><button className={'touched-row' + (i === 0 ? ' top' : '')} aria-label={file.path} title={`${file.path}\nNamed in ${sessions.join(', ')}`} disabled={!observed} onClick={() => openFile(file.path)}>
        <Icon name={iconFor(name)} size={16} stroke={1.6} />
        <span className="touched-name"><strong>{name}</strong><small>{observed ? folder || 'Project folder' : file.state.replaceAll('-', ' ')}</small>
          <i aria-hidden="true" style={{ width: `${Math.max(4, file.references.length / most * 100)}%` }} /></span>
        <span className="touched-count">{file.references.length}</span>
      </button></li>;
    })}</ul>
    {omitted > 0 && <p className="touched-more">{omitted} more outside the project or past the limit</p>}
    {work.native.state === 'available' && <button className="text-button touched-native" onClick={openActivity}>View native activity <Icon name="chevron" size={12} /></button>}
  </section>;
}

// The notes the person and the Agent keep together; the editor owns its buffer and history.
export function SharedNotes({ work, openFile }: { work: Work | null; openFile: (path: string) => void }) {
  const path = work?.notes.path ?? 'project-notes.md';
  return <button className="notes-card" aria-label="Open shared notes" onClick={() => openFile(path)}>
    <span className="notes-sheet" aria-hidden="true"><i /><i /><i /></span>
    <span className="notes-name"><strong>Shared notes</strong><small>{path}</small></span>
    <Icon name="chevron" size={14} />
  </button>;
}
