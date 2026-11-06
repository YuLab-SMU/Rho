import { useCallback, useEffect, useState } from 'react';
import { ExternalConversation } from '@rho-workspace/plugin-agent/ui-external-session';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { AgentMarkdown } from './markdown.js';
import { BrandMark } from './brand-marks.js';
import { openInWorkspace } from './canvas.js';
import { readBytes } from './previews.js';
import './external-conversations.css';

export type ExternalSummary = RhoOutput<'agent.sessions.list'>['sessions'][number];
export function useExternalConversations(client: BrowserClient, projectId: string | null) {
  const [value, setValue] = useState<{ sessions: ExternalSummary[]; omitted: number }>({ sessions: [], omitted: 0 }), [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true, busy = false;
    setValue({ sessions: [], omitted: 0 }); setProblem('');
    if (!projectId) return;
    const read = async () => { if (busy || !live) return; busy = true;
      try { const next = await client.call('agent.sessions.list', { projectId }); if (live) { setValue(next); setProblem(''); } }
      catch (error) { if (live) setProblem(error instanceof Error ? error.message : 'External conversations could not be read.'); }
      finally { busy = false; }
    };
    void read(); const timer = setInterval(() => { if (!document.hidden) void read(); }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [client, projectId]);
  return { ...value, problem };
}
type Result = RhoOutput<'agent.sessions.read'>['turns'][number]['results'][number];
function ExternalResult({ result, client, snapshot, onPath, onOpened }: { result: Result; client: BrowserClient; snapshot: WorkspaceSnapshot; onPath: (path: string) => void; onOpened: (compositionId: string, viewId?: string) => void }) {
  const registered = snapshot.resources.find(r => r.id === result.id && r.version === result.version && r.path === result.path && r.projectId === result.projectId);
  const [preview, setPreview] = useState(''), [problem, setProblem] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true, url = ''; setPreview(''); setProblem('');
    if (registered?.kind === 'media' && /\.(png|jpe?g)$/i.test(result.path) && registered.bytes <= 2 * 1024 * 1024) {
      readBytes(client, snapshot.project.id, { id: registered.id, version: registered.version }, 2 * 1024 * 1024).then(bytes => {
        if (!live || bytes.length > 2 * 1024 * 1024) return;
        url = URL.createObjectURL(new Blob([bytes], { type: /\.png$/i.test(result.path) ? 'image/png' : 'image/jpeg' })); setPreview(url);
      }, () => { if (live) setProblem('The recorded version could not be read.'); });
    }
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [client, snapshot.project.id, registered?.id, registered?.version, retry]);
  async function open() {
    if (!result.id) { onPath(result.path); return; }
    if (!registered) { setProblem('The recorded version is unavailable in this project.'); return; }
    try { const opened = await openInWorkspace(client, snapshot, 'external-results', registered); if (opened) onOpened(opened.compositionId, opened.viewId); else setProblem('No viewer is available for this recorded resource.'); }
    catch (error) { setProblem(error instanceof Error ? error.message : 'Could not open the recorded result.'); }
  }
  return <div className="external-result"><button onClick={() => void open()}>{result.path}</button><small>{result.id ? 'Version recorded in the tool reply · ' + result.version?.slice(0, 12) : 'Reported by the Agent · opens current file'}</small>
    {preview && <img src={preview} alt={result.path} />}{problem && <p role="alert">{problem} <button onClick={() => setRetry(n => n + 1)}>Retry preview</button></p>}
  </div>;
}
export function ExternalConversationRow({ summary, client, snapshot, open, onToggle, onPath, onOpened }: { summary: ExternalSummary; client: BrowserClient; snapshot: WorkspaceSnapshot; open: boolean; onToggle: () => void; onPath: (path: string) => void; onOpened: (compositionId: string, viewId?: string) => void }) {
  const read = useCallback((before?: number) => client.call('agent.sessions.read', { projectId: snapshot.project.id, session: summary.id, ...(before === undefined ? {} : { before }) }), [client, snapshot.project.id, summary.id]);
  return <li className={'conv-row external-row' + (open ? ' open' : '')}>
    <div className="conv-line"><button className="conv-toggle" onClick={onToggle} aria-expanded={open}>
      <BrandMark brand="deepseek" size={20} /><span className="conv-text"><span className="conv-title">{summary.title}</span><span className="conv-meta">{summary.producer === 'dsh' ? 'DeepSeek Harness' : summary.producer} · Outside Rho · {summary.turns} turns · {summary.state === 'unknown' ? 'Outcome unknown' : summary.state}</span></span>
    </button><button onClick={onToggle}>{open ? 'Close' : 'Open'}</button></div>
    {open && <div className="conv-details"><ExternalConversation session={summary} read={read} openFile={onPath} renderText={text => <AgentMarkdown text={text} streaming={false} />}
      renderResult={result => <ExternalResult result={result} client={client} snapshot={snapshot} onPath={onPath} onOpened={onOpened} />} /></div>}
  </li>;
}
