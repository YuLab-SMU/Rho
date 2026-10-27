import { useEffect, useRef, useState } from 'react';
import { SessionProgress } from '@rho-workspace/plugin-agent/ui';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';

type Work = RhoOutput<'project.work.read'>;
const stateWords: Record<string, string> = { running: 'Answering', completed: 'Last message answered', failed: 'Last message failed', stopped: 'Stopped', unknown: 'Outcome unknown', retained: 'Retained native activity', idle: 'No messages' };
export function WorkProgress({ client, snapshot, openFile, openConversation, openActivity, onPresence }: {
  client: BrowserClient; snapshot: WorkspaceSnapshot; openFile: (path: string) => void;
  openConversation: (id: string) => void; openActivity: () => void; onPresence: (present: boolean) => void;
}) {
  const [work, setWork] = useState<Work | null>(null), [problem, setProblem] = useState(''), [reading, setReading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), request = useRef<(() => void) | null>(null);
  useEffect(() => {
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
    return () => { live = false; controller.abort(); if (timer.current) clearTimeout(timer.current); timer.current = null; request.current = null; };
  }, [client, snapshot.project.id]);
  useEffect(() => { request.current?.(); }, [snapshot.cursor]);
  return <section className="project-section project-work" aria-label="Project work">
    <div className="section-heading"><h2>Work progress</h2><button className="text-button" disabled={reading} onClick={() => request.current?.()}>{reading ? 'Reading…' : 'Refresh'}</button></div>
    <div className="shared-notes"><div><strong>Shared notes</strong><p>{work?.notes.dirty ? 'Unsaved changes in the shared document. Save before asking Agent to read the file.' : 'Project notes for you and Agent. Save changes, then ask Agent to read project-notes.md.'}</p></div><button onClick={() => openFile(work?.notes.path ?? 'project-notes.md')}>Open shared notes</button></div>
    {problem && <p role="alert">{problem} Retained observations remain below.</p>}
    {!work && !problem && <p role="status">Reading project work…</p>}
    {work && <>
      <div className="work-sessions">{work.sessions.map(session => <article className="work-session" key={session.id}>
        <header><div><h3>{session.title}</h3><p>{stateWords[session.state] ?? session.state} · {session.source === 'acp' ? 'ACP' : session.source === 'native-transcript' ? 'Native transcript' : 'Claude CLI'}</p></div>
          {session.conversationId ? <button onClick={() => openConversation(session.conversationId!)}>Continue conversation</button> : <button onClick={openActivity}>View activity</button>}</header>
        {session.observation ? <SessionProgress observation={session.observation} /> : session.source === 'native-transcript' ? <p className="muted">Input stays in the original window. Retained through cursor {session.cursor}; {session.droppedEvents ?? 0} events dropped.</p> : <p className="muted">No session projection retained yet.</p>}
        {session.operationIds.length > 0 && <p className="work-references">Managed run references: {session.operationIds.join(', ')}</p>}
        {session.resourceRefs.length > 0 && <p className="work-references">{session.resourceRefs.length} resource versions referenced. Results keep their own integrity and provenance.</p>}
      </article>)}</div>
      {work.omitted.conversations > 0 && <p className="muted">{work.omitted.conversations} earlier conversations are available in the Agent panel.</p>}
      {work.files.length > 0 && <div className="work-files"><h3>Referenced files</h3><p className="muted">Current file observations. A tool reference does not establish who wrote these bytes.</p><ul>{work.files.map(file => <li key={file.path}>
        <div><button className="text-button" disabled={file.state !== 'observed'} onClick={() => openFile(file.path)}>{file.path}</button><small>{file.state === 'observed' ? `${file.bytes} bytes · SHA-256 ${file.sha256?.slice(0, 12)}` : file.state.replaceAll('-', ' ')} · {file.references.length} tool references</small></div>
        <details><summary>Sources</summary><ul>{file.references.map(ref => <li key={ref.session + ref.tool}>{work.sessions.find(s => s.id === ref.session)?.title ?? ref.session} · {ref.tool}</li>)}</ul><p>{file.observedAt}</p>{file.sha256 && <code>{file.sha256}</code>}</details>
      </li>)}</ul></div>}
      {work.omitted.fileReferences > 0 && <p className="muted">{work.omitted.fileReferences} file references were outside project scope or observation limits.</p>}
      <p className="work-native-note">{work.native.message}{work.native.state === 'available' && <button className="text-button" onClick={openActivity}>View native activity</button>}</p>
    </>}
  </section>;
}
