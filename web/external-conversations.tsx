import { useEffect, useState } from 'react';
import type { BrowserClient, WorkspaceSnapshot } from '../src/browser.js';
import type { RhoOutput } from '../src/contract.generated.js';
import { ProviderMark } from './brand-marks.js';
import { Icon } from './icons.js';
import { openInWorkspace } from './canvas.js';
import { readBytes } from './previews.js';
import './external-conversations.css';

export type ExternalSummary = RhoOutput<'agent.sessions.list'>['sessions'][number];
export type SessionTurn = RhoOutput<'agent.sessions.read'>['turns'][number];
// Every Agent session in the project folder, wherever it was started, read again every few seconds
// while the page is visible. Reading starts nothing.
export function useExternalConversations(client: BrowserClient, projectId: string | null) {
  const [value, setValue] = useState<{ sessions: ExternalSummary[]; omitted: number }>({ sessions: [], omitted: 0 }), [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true, busy = false;
    setValue({ sessions: [], omitted: 0 }); setProblem('');
    if (!projectId) return;
    const read = async () => { if (busy || !live) return; busy = true;
      try { const next = await client.call('agent.sessions.list', { projectId }); if (live) { setValue(next); setProblem(''); } }
      catch (error) { if (live) setProblem(error instanceof Error ? error.message : 'Agent sessions could not be read.'); }
      finally { busy = false; }
    };
    void read(); const timer = setInterval(() => { if (!document.hidden) void read(); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [client, projectId]);
  return { ...value, problem };
}
// The Agent a session belongs to, in a person's words and marks.
export const sessionAgent = (summary: Pick<ExternalSummary, 'producer'>) => summary.producer === 'dsh' ? 'DeepSeek Harness' : summary.producer === 'codex' ? 'Codex' : summary.producer === 'claude-code' ? 'Claude Code' : summary.producer;
export const sessionWhere = (summary: Pick<ExternalSummary, 'producer' | 'where'>) => summary.where ?? (summary.producer === 'dsh' ? 'DeepSeek Harness' : 'another window');
type Result = RhoOutput<'agent.sessions.read'>['turns'][number]['results'][number];
export function ExternalResult({ result, client, snapshot, onPath, onOpened }: { result: Result; client: BrowserClient; snapshot: WorkspaceSnapshot; onPath: (path: string) => void; onOpened: (compositionId: string, viewId?: string) => void }) {
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
function ago(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return '';
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.round(ms / 60000) + ' min ago';
  if (ms < 86400000) return Math.round(ms / 3600000) + ' h ago';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// A session not yet continued in Rho, listed with the project's conversations. Opening it shows
// the whole session in the Agent panel, where the next message continues it.
export function SessionRow({ summary, onOpen }: { summary: ExternalSummary; onOpen: () => void }) {
  const [copied, setCopied] = useState(false);
  const running = summary.state === 'running', where = sessionWhere(summary);
  const meta = [ago(summary.lastAt), 'Started in ' + where].filter(Boolean);
  return <li className={'conv-row native-row' + (running ? ' running' : '')}>
    <div className="conv-line">
      <button className="conv-toggle" onClick={onOpen}>
        <ProviderMark name={sessionAgent(summary)} size={20} />
        <span className="conv-text"><span className="conv-title">{summary.title}</span>
          <span className="conv-meta">{meta.map((part, i) => <span key={i}>{part}</span>)}
            {summary.open ? <span className="conv-state elsewhere">{running && <span className="pulse-dot" aria-hidden="true" />}Open in {summary.open.where}</span>
              : running ? <span className="conv-state running"><span className="pulse-dot" aria-hidden="true" />Working</span> : null}</span></span>
      </button>
      <div className="conv-actions">
        <button className="conv-continue" onClick={onOpen}>{summary.continueWith ? 'Continue' : 'Open'}</button>
        {summary.resume && <button className="icon-button" aria-label={'Copy the command that continues ' + summary.title + ' in a terminal'} title={copied ? 'Copied' : 'Copy terminal command: ' + summary.resume}
          onClick={() => navigator.clipboard.writeText(summary.resume!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}><Icon name={copied ? 'check' : 'prompt'} size={16} /></button>}
      </div>
    </div>
  </li>;
}
