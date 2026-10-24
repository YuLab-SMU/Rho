import { useEffect, useId, useRef, useState } from 'react';
import type { BrowserClient, ResourceSummary, WorkspaceSnapshot } from '../src/browser.js';
import { executionWord, integrityWord, sameSourceKey, distinctScripts, shortPath, type RunFacts } from '../src/execution-facts.js';
import { useRuns, viewPlaces, type Place } from './executions.js';
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

export function ArtifactSource({ resource, viewId, snapshot, client, onOpenView }: { resource: ResourceSummary; viewId: string; snapshot: WorkspaceSnapshot; client: BrowserClient; onOpenView?: (viewId: string) => void }) {
  const { runs, problem, readAgain } = useRuns(client, snapshot.project.id);
  const origin = runs ? runs.find(run => (resource.provenance as { operationId?: string } | undefined)?.operationId === run.operationId) : undefined;
  // "I pointed the Agent at this version" is a fact about this tab; the delivery
  // state behind it is the owner's. Keeping the identity (not the state) in tab
  // storage means a reload re-reads the receipt instead of inventing one.
  const memoryKey = `rho.ask.v1:${snapshot.project.id}:${resource.id}:${resource.version}`;
  const [asked, setAsked] = useState<string | null>(() => { try { return sessionStorage.getItem(memoryKey); } catch { return null; } });
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false), [askProblem, setAskProblem] = useState('');
  // The person's own words need an owner. Rho keeps them in one notes document in
  // the project and references the exact range, so the Agent receives the question
  // and the object version together, and the words stay readable afterwards.
  const [composing, setComposing] = useState(false), [question, setQuestion] = useState('');
  // The rows this view has selected. A selection is scoped to the view that made it
  // and only means anything at the version it was made on, so rows picked elsewhere
  // or on another version are never attached to this object.
  type Channel = { scope?: { kind?: string; id?: string }; selection?: { resource?: { id: string; version: string }; entities?: string[] } | null };
  const channels = (snapshot.interactions ?? []) as Channel[];
  const mine = channels.find(channel => channel.scope?.id === resource.id && channel.scope?.kind === 'shared') ?? channels.find(channel => channel.scope?.id === viewId);
  const chosen = mine?.selection;
  const selected = chosen?.resource?.id === resource.id && chosen.resource.version === resource.version ? chosen.entities ?? [] : [];
  const fetched = asked ? snapshot.contexts?.find(context => (context as { contextId?: string }).contextId === asked) as { delivery?: string; fetchedAt?: string } | undefined : undefined;
  const allowed = (method: string) => snapshot.catalog.operations.some(operation => operation.method === method && operation.state === 'available' && operation.authorized);
  const canAsk = allowed('context.create');
  // Writing the question down needs the document owner and a way to open a file.
  const canWrite = canAsk && allowed('document.edit') && allowed('project.openFile');
  async function ask() {
    setAsking(true); setAskProblem('');
    try {
      const result = await client.call('context.create', { projectId: snapshot.project.id, resource: { id: resource.id, version: resource.version }, changeId: 'ask-' + viewId + '-' + Date.now(), expectedVersion: 0 }, AbortSignal.timeout(30000));
      setAsked(result.contextId);
      try { sessionStorage.setItem(memoryKey, result.contextId); } catch { /* the receipt is still shown for this session */ }
    } catch (error) { setAskProblem(error instanceof Error ? error.message : 'The context could not be prepared.'); }
    finally { setAsking(false); }
  }
  async function send() {
    const words = question.trim();
    if (!words) return;
    setAsking(true); setAskProblem('');
    try {
      const projectId = snapshot.project.id, changeId = 'ask-' + viewId + '-' + Date.now();
      const opened = await client.call('project.openFile', { projectId, path: 'questions.md', compositionId: 'workspace', expectedVersion: snapshot.compositions.find(entry => entry.compositionId === 'workspace')?.version ?? 0, changeId: changeId + '-open' }, AbortSignal.timeout(30000));
      const document = opened.document, separator = document.content.trim() ? '\n\n' : '';
      const insert = separator + words + '\n';
      // A conditional edit: this exact revision, this exact buffer version.
      const edited = await client.call('document.edit', { projectId, documentId: document.id, expectedVersion: document.version, expectedRevision: document.revision, changeId: changeId + '-edit', edits: [{ from: document.content.length, to: document.content.length, insert }], undoGroup: changeId }, AbortSignal.timeout(30000));
      const from = document.content.length + separator.length;
      const result = await client.call('context.create', {
        projectId, changeId, expectedVersion: 0,
        document: { documentId: document.id, version: edited.version, from, to: from + words.length },
        resource: { id: resource.id, version: resource.version },
        // Selected rows travel with the object, so the Agent reads the question about
        // these rows of this version rather than the file in general.
        ...(selected.length ? { entities: selected } : {})
      }, AbortSignal.timeout(30000));
      setAsked(result.contextId);
      try { sessionStorage.setItem(memoryKey, result.contextId); } catch { /* the receipt is still shown for this session */ }
      setComposing(false); setQuestion('');
      onOpenView?.(viewId);
    } catch (error) { setAskProblem(error instanceof Error ? error.message : 'The question could not be prepared.'); }
    finally { setAsking(false); }
  }
  if (!runs) return problem ? <p className="artifact-problem" role="alert">{problem}</p> : null;
  // A resource the owners never tied to an execution gets no invented provenance.
  if (!origin) return null;
  // The other files this one execution wrote are its evidence, so they are named
  // here rather than left as separate tabs to go and find.
  const siblings = snapshot.resources.filter(other => other.id !== resource.id && (other.provenance as { operationId?: string } | undefined)?.operationId === origin.operationId);
  const places = viewPlaces(snapshot);
  return <>
    <div className="artifact-source">
      <button className="artifact-origin" onClick={() => setOpen(true)} title="The execution that produced this version, and what it left behind">
        <span className={'state ' + stateClass(origin)}>{originLine(origin, origin?.integrity)}</span>
        <Icon name="chevron" size={11} stroke={1.8} />
      </button>
      {siblings.length > 0 && <span className="artifact-siblings">
        {siblings.map(other => {
          const place = places.get(other.id), label = shortPath(other.path);
          return place && onOpenView
            ? <button key={other.id} className="artifact-sibling" onClick={() => onOpenView(place.viewId)} title={`${other.path} came from the same run`}>{label}</button>
            : <span key={other.id} className="artifact-sibling-plain">{label}</span>;
        })}
      </span>}
      <span className="artifact-source-right">
        {asked ? <span className="artifact-receipt" role="status">{fetched?.delivery === 'tool-fetched'
          ? `Fetched by the Agent${fetched.fetchedAt ? ' at ' + new Date(fetched.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : ''}`
          : 'Prepared · the Agent has not fetched it yet'}</span>
          : canWrite ? <button className="artifact-ask" disabled={asking} onClick={() => setComposing(true)}>{selected.length ? `Ask about ${selected.length} selected row${selected.length === 1 ? '' : 's'}` : 'Ask about this'}</button>
          : canAsk ? <button className="artifact-ask" disabled={asking} onClick={() => void ask()}>{asking ? 'Preparing…' : 'Point the Agent here'}</button>
          : null}
      </span>
    </div>
    {composing && <div className="artifact-composer">
      <label className="visually-hidden" htmlFor={'ask-' + viewId}>Your question about this version</label>
      <input id={'ask-' + viewId} autoFocus value={question} maxLength={280} placeholder={`Ask about ${shortPath(resource.path)} at this version…`}
        onChange={event => setQuestion(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') void send(); if (event.key === 'Escape') { setComposing(false); setQuestion(''); } }} />
      <button className="artifact-send" disabled={asking || !question.trim()} onClick={() => void send()}>{asking ? 'Sending…' : 'Send'}</button>
      <button className="artifact-cancel" disabled={asking} onClick={() => { setComposing(false); setQuestion(''); }}>Cancel</button>
      <span className="artifact-composer-note">{selected.length
        ? `Kept in questions.md · the Agent gets this version and the ${selected.length} selected row${selected.length === 1 ? '' : 's'}`
        : 'Kept in questions.md · the Agent gets this exact version'}</span>
    </div>}
    {askProblem && <p className="artifact-problem" role="alert">{askProblem}</p>}
    {open && <ExecutionPanel run={origin} runs={runs} snapshot={snapshot} focus={{ path: resource.path, version: resource.version }} onClose={() => setOpen(false)} onReadAgain={readAgain} onOpenView={id => { onOpenView?.(id); setOpen(false); }} />}
  </>;
}

// One execution, as the owners recorded it. Declared, on disk and verified are
// three rows that never collapse: a failed run can fill the first two and none of
// the third. The same panel opens from an artifact and from a run on the project
// page, so a person reads one account of an execution wherever they meet it.
export function ExecutionPanel({ run, runs, snapshot, focus, onClose, onReadAgain, onOpenView }: {
  run: RunFacts; runs: RunFacts[]; snapshot?: WorkspaceSnapshot; focus?: { path: string; version?: string };
  onClose: () => void; onReadAgain?: () => void; onOpenView?: (viewId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId();
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => { if (element.open) element.close(); }; }, []);
  const lineage = sameSourceKey(runs, run.sourceKey);
  const distinct = distinctScripts(lineage);
  const present = run.declared.filter(file => file.present);
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const places = snapshot ? viewPlaces(snapshot) : new Map<string, Place>();
  // Files this run actually registered, in the layouts that already show them.
  const written = snapshot ? snapshot.resources.filter(resource => (resource.provenance as { operationId?: string } | undefined)?.operationId === run.operationId) : [];
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
        {focus && file.path === shortPath(focus.path) && <span className="execution-file-here">this version</span>}
        <span className={'state ' + (file.present ? 'good' : 'unknown')}>{file.present ? size(file.bytes) : 'not written'}</span>
      </li>)}
    </ul>}
    {written.length > 0 && <section className="execution-written">
      <h3>Also from this run</h3>
      <ul>{written.map(resource => {
        const place = places.get(resource.id), current = focus && resource.path === focus.path;
        return <li key={resource.id}>
          {place && onOpenView && !current
            ? <button className="execution-open" onClick={() => onOpenView(place.viewId)}>{shortPath(resource.path)}</button>
            : <span className={'execution-open-plain' + (current ? ' current' : '')}>{shortPath(resource.path)}</span>}
          <span className="execution-written-kind">{resource.kind}</span>
        </li>;
      })}</ul>
    </section>}
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
      <span className="execution-version">{focus?.version ? `this view: version ${focus.version.slice(0, 8)}` : `script ${(run.script ?? '').slice(0, 8)}`}</span>
      {onReadAgain && <button className="quiet-button" onClick={onReadAgain}>Read again</button>}
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
