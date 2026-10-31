import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { agentName } from './agent-now.js';
import { when } from './home.js';
import { Icon } from './icons.js';
import { askCell } from './notebook-target.js';

// What was done in the project's live sessions, for the Overview: where each session with cells
// runs and what it holds, and the newest cells by their purpose. Work done only in the Notebook,
// on this machine or on a server, is work. One small read follows the project's records; a read
// never starts a session.
export const notebookWorkLimits = { cells: 3, sessions: 4 };
type Read = RhoOutput<'kernel.read'>;
type Cell = Read['cells'][number];
type Session = Read['sessions'][number];
const browser = 'browser:local';
const stateWords: Partial<Record<Cell['state'], string>> = { queued: 'waiting', running: 'running', error: 'ended with an error', interrupted: 'interrupted', 'not-run': 'not run', unknown: 'outcome unknown' };

export interface NotebookWork { read: Read | null; problem: string; cells: number }
export function useNotebookWork(client: BrowserClient, projectId: string, cursor: number, enabled: boolean): NotebookWork {
  const [state, setState] = useState<{ read: Read | null; problem: string }>({ read: null, problem: '' });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    client.call('kernel.read', { projectId, limit: notebookWorkLimits.cells }).then(read => { if (current) setState({ read, problem: '' }); },
      error => { if (current) setState(s => ({ ...s, problem: error instanceof Error ? error.message : 'The Notebook could not be read.' })); });
    return () => { current = false; };
  }, [client, projectId, cursor, enabled]);
  return { ...state, cells: state.read ? state.read.cells.length + state.read.omitted : 0 };
}

const versionOf = (s: Session) => s.version?.replace(/^R version (\S+).*$/, 'R $1') ?? (s.language === 'r' ? 'R' : 'Python');
const firstLine = (code: string) => code.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? 'A cell';

export function NotebookWorkSection({ work, snapshot, onOpen }: { work: NotebookWork; snapshot: WorkspaceSnapshot; onOpen: () => void }) {
  const { read, problem, cells } = work;
  if (!cells && !problem) return null;
  const agents = new Map((snapshot.conversations ?? []).filter(c => c.principal).map(c => [c.principal!, agentName(c.client)]));
  const author = (by: string) => by === browser ? 'You' : agents.get(by) ?? 'An Agent';
  // Sessions that ran cells, the live ones first, then the newest.
  const sessions = [...(read?.sessions ?? [])].filter(s => s.cells > 0)
    .sort((a, b) => Number(a.state === 'ended') - Number(b.state === 'ended') || b.startedAt.localeCompare(a.startedAt)).slice(0, notebookWorkLimits.sessions);
  const newest = [...(read?.cells ?? [])].reverse(), earlier = Math.max(0, cells - newest.length);
  return <section className="project-section notebook-work" aria-labelledby="notebook-work-title">
    <div className="section-heading"><h2 id="notebook-work-title">Notebook</h2><button className="text-button" onClick={onOpen}>Open Notebook</button></div>
    {problem && <p role="alert">{problem}</p>}
    {sessions.length > 0 && <ul className="notebook-work-sessions">{sessions.map(s => <li key={s.sessionId}>
      <Icon name={s.place ? 'server' : 'code'} size={15} />
      <span><strong>{versionOf(s)}</strong> {s.place ? 'on ' + s.place.label : 'on this machine'}</span>
      <small>{s.state === 'ended' ? 'ended' : s.state} · {s.cells} {s.cells === 1 ? 'cell' : 'cells'}{s.state !== 'ended' ? ` · ${s.variables.length + s.variablesOmitted} ${s.variables.length + s.variablesOmitted === 1 ? 'value' : 'values'}` : ''}</small>
    </li>)}</ul>}
    {newest.length > 0 && <div className="activity-list">{newest.map(cell => <button className="activity-row" key={cell.cellId} onClick={() => { askCell(cell.cellId); onOpen(); }}>
      <span className={'activity-symbol' + (cell.state === 'running' || cell.state === 'queued' ? ' active' : '')}><Icon name="code" size={16} /></span>
      <span className="activity-name"><strong>{cell.purpose || firstLine(cell.code)}</strong>
        <small>{author(cell.by)} · {when(cell.endedAt ?? cell.startedAt ?? cell.queuedAt).text}{stateWords[cell.state] ? ' · ' + stateWords[cell.state] : ''}</small></span>
      <Icon name="chevron" size={13} />
    </button>)}</div>}
    {earlier > 0 && <p className="quiet-empty">{earlier} earlier {earlier === 1 ? 'cell' : 'cells'} in the Notebook</p>}
  </section>;
}
