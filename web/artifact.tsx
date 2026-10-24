import { useEffect, useId, useRef, useState } from 'react';
import type { BrowserClient, ResourceSummary, WorkspaceSnapshot } from '../src/browser.js';
import { executionWord, integrityWord, sameSourceKey, distinctScripts, shortPath, type RunFacts } from '../src/execution-facts.js';
import { useRuns } from './executions.js';
import { Icon } from './icons.js';

// What produced this artifact, what that execution did, and whether anyone checked
// it. Rho draws this: it is about the object, not about the plugin's subject matter,
// so every view gets the same facts from the same owner records.
const stateClass = (run?: RunFacts) => run?.execution === 'failed' ? 'failed' : run?.execution === 'unknown' ? 'unknown' : run?.execution === 'completed' ? 'good' : run ? 'pending' : 'unknown';

function originLine(run: RunFacts | undefined, integrity: RunFacts['integrity'] | undefined) {
  if (!run) return 'no recorded execution';
  const parts = [run.operationId, executionWord(run.execution)];
  if (run.declared.length) parts.push(integrity ? integrityWord(integrity) : integrityWord(run.integrity));
  else parts.push('no declared file');
  return parts.join(' · ');
}

export function ArtifactSource({ resource, viewId, snapshot, client }: { resource: ResourceSummary; viewId: string; snapshot: WorkspaceSnapshot; client: BrowserClient }) {
  const { runs, problem, readAgain } = useRuns(client, snapshot.project.id);
  const origin = runs ? runs.find(run => (resource.provenance as { operationId?: string } | undefined)?.operationId === run.operationId) : undefined;
  // "I pointed the Agent at this version" is a fact about this tab; the delivery
  // state behind it is the owner's. Keeping the identity (not the state) in tab
  // storage means a reload re-reads the receipt instead of inventing one.
  const memoryKey = `rho.ask.v1:${snapshot.project.id}:${resource.id}:${resource.version}`;
  const [asked, setAsked] = useState<string | null>(() => { try { return sessionStorage.getItem(memoryKey); } catch { return null; } });
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false), [askProblem, setAskProblem] = useState('');
  const fetched = asked ? snapshot.contexts?.find(context => (context as { contextId?: string }).contextId === asked) as { delivery?: string; fetchedAt?: string } | undefined : undefined;
  const canAsk = snapshot.catalog.operations.some(operation => operation.method === 'context.create' && operation.state === 'available' && operation.authorized);
  async function ask() {
    setAsking(true); setAskProblem('');
    try {
      const result = await client.call('context.create', { projectId: snapshot.project.id, resource: { id: resource.id, version: resource.version }, changeId: 'ask-' + viewId + '-' + Date.now(), expectedVersion: 0 }, AbortSignal.timeout(30000));
      setAsked(result.contextId);
      try { sessionStorage.setItem(memoryKey, result.contextId); } catch { /* the receipt is still shown for this session */ }
    } catch (error) { setAskProblem(error instanceof Error ? error.message : 'The context could not be prepared.'); }
    finally { setAsking(false); }
  }
  if (!runs) return problem ? <p className="artifact-problem" role="alert">{problem}</p> : null;
  // A resource the owners never tied to an execution gets no invented provenance.
  if (!origin) return null;
  return <>
    <div className="artifact-source">
      <button className="artifact-origin" onClick={() => setOpen(true)} title="The execution that produced this version, and what it left behind">
        <span className={'state ' + stateClass(origin)}>{originLine(origin, origin?.integrity)}</span>
        <Icon name="chevron" size={11} stroke={1.8} />
      </button>
      <span className="artifact-source-right">
        {asked ? <span className="artifact-receipt" role="status">{fetched?.delivery === 'tool-fetched'
          ? `Fetched by the Agent${fetched.fetchedAt ? ' at ' + new Date(fetched.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : ''}`
          : 'Prepared · the Agent has not fetched it yet'}</span>
          : canAsk ? <button className="artifact-ask" disabled={asking} onClick={() => void ask()}>{asking ? 'Preparing…' : 'Ask about this'}</button>
          : null}
      </span>
    </div>
    {askProblem && <p className="artifact-problem" role="alert">{askProblem}</p>}
    {open && <ExecutionPanel run={origin} runs={runs} path={resource.path} version={resource.version} onClose={() => setOpen(false)} onReadAgain={readAgain} />}
  </>;
}

// One execution, as the owners recorded it. Declared, on disk and verified are
// three rows that never collapse: a failed run can fill the first two and none of
// the third.
function ExecutionPanel({ run, runs, path, version, onClose, onReadAgain }: { run: RunFacts; runs: RunFacts[]; path: string; version: string; onClose: () => void; onReadAgain: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId();
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { if (element.open) element.close(); }; }, []);
  const lineage = sameSourceKey(runs, run.sourceKey);
  const distinct = distinctScripts(lineage);
  const present = run.declared.filter(file => file.present);
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return <dialog ref={dialog} className="execution-panel" aria-labelledby={heading} onCancel={onClose} onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <header className="execution-head">
      <div>
        <h2 id={heading}>{run.operationId}</h2>
        <p><span className={'state ' + stateClass(run)}>{executionWord(run.execution)}</span> · {run.author} · {new Date(run.acceptedAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</p>
      </div>
      <button className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={14} stroke={2} /></button>
    </header>
    <dl className="execution-facts">
      <div><dt>Declared</dt><dd>{run.declared.length ? count(run.declared.length, 'file') : 'none'}</dd></div>
      <div><dt>On disk now</dt><dd>{present.length} of {run.declared.length}</dd></div>
      <div><dt>Integrity</dt><dd>{integrityWord(run.integrity)}{run.completion === 'absent' && run.declared.length ? ' · the producer wrote no inventory' : ''}</dd></div>
      <div><dt>Domain check</dt><dd>{run.domain === 'checked' ? 'recorded' : 'none recorded'}</dd></div>
      {run.hasStderr && <div><dt>Output</dt><dd>stderr was retained</dd></div>}
    </dl>
    {run.declared.length > 0 && <ul className="execution-files">
      {run.declared.map(file => <li key={file.path}>
        <span className="execution-file-name">{file.path}</span>
        <span className={'state ' + (file.present ? 'good' : 'unknown')}>{file.present ? size(file.bytes) : 'not written'}</span>
        {file.present && file.path === shortPath(path) && <span className="execution-file-here">this version</span>}
      </li>)}
    </ul>}
    {lineage.length > 1 && <section className="execution-lineage">
      <h3>One script · {lineage.length} submissions{distinct > 1 ? `, ${distinct} versions of the code` : ''}</h3>
      <ol>{lineage.map(entry => <li key={entry.operationId} aria-current={entry.operationId === run.operationId ? 'true' : undefined}>
        <span className={'state ' + stateClass(entry)}>{executionWord(entry.execution)}</span>
        <span className="execution-lineage-name">{entry.operationId}</span>
        <span className="execution-lineage-code">@{entry.script ? entry.script.slice(0, 8) : 'no code'}</span>
        <span className="execution-lineage-at">{new Date(entry.acceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
      </li>)}</ol>
    </section>}
    <footer className="execution-foot">
      <span className="execution-version">this view: version {version.slice(0, 8)}</span>
      <button className="quiet-button" onClick={onReadAgain}>Read again</button>
    </footer>
    <p className="execution-limit">Bytes are verified against the inventory the producer wrote. No execution establishes that a statistical result is correct; that is a separate domain check.</p>
  </dialog>;
}

function size(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)) + ' ' + units[unit];
}
