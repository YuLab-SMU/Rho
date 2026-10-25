import { useEffect, useId, useState, type ReactNode } from 'react';
import type { BrowserClient, ResourceSummary, WorkspaceSnapshot } from '../../src/browser.js';
import { executionWord, integrityWord, producerOf, sameSourceKey, shortPath, stopState, type RunFacts } from '../../src/execution-facts.js';
import type { Live } from './live.js';
// The run view also opens on the project page, which loads no other part of the shell.
import './shell.css';

type Ref = { id: string; version: string };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// The trace object of a run, so opening it goes through the same rules as the Agent's focus.
export function runObject(live: Live, operationId: string) { return Object.entries(live.state?.names ?? {}).find(([key, value]) => key.startsWith('run:') && value === operationId)?.[0]; }
// What the Agent explicitly said about this exact version: its replies that link it.
function agentWords(snapshot: WorkspaceSnapshot, ref: Ref) {
  for (const thread of (snapshot.annotations ?? []) as any[]) for (const m of thread.messages ?? []) {
    if (String(m.author ?? '').startsWith('agent:') && m.resources?.some((r: Ref) => r.id === ref.id && r.version === ref.version) && m.draft?.text) return String(m.draft.text);
  }
  return null;
}
// What the replies to questions on this exact version link.
function linkedFrom(snapshot: WorkspaceSnapshot, ref: Ref): Ref[] {
  return ((snapshot.annotations ?? []) as any[]).filter(t => t.anchor?.resource?.id === ref.id && t.anchor.resource.version === ref.version).flatMap(t => (t.messages ?? []).flatMap((m: any) => m.resources ?? []));
}
const domainWord = (run: RunFacts) => run.domain === 'checked' ? 'domain check recorded' : 'no domain check';

// One line above an artifact's view: the run that produced this version and how it
// ended (observed), what checked its bytes and its meaning (verification), and the Agent's
// own words about it when it linked this version (its statement). Each says itself once.
export function SourceLine({ live, snapshot, resource, viewId, onOpenRef, children }: { live: Live; snapshot: WorkspaceSnapshot; resource: ResourceSummary; viewId: string; onOpenRef: (ref: Ref) => void; children?: ReactNode }) {
  const runs = live.runs, run = runs ? producerOf(resource, runs) : undefined;
  const object = run && runObject(live, run.operationId), words = agentWords(snapshot, resource);
  // Items the Agent declared about this exact version, or about this view.
  const ref = live.state?.refs[resource.id + '@' + resource.version], artifact = ref && (ref.object ?? 'artifact:' + ref.artifact);
  const notes = (live.screen?.items ?? []).filter(i => i.view === viewId || !!artifact && i.artifact?.object === artifact && i.artifact.version === resource.version);
  const view = live.screen?.views.find(v => v.id === viewId), newerName = view?.newer ? live.state?.names['run:' + view.newer] : undefined;
  const found = newerName ? snapshot.resources.find(r => shortPath(r.path) === shortPath(resource.path) && (r.provenance as { operationId?: string })?.operationId === newerName) : undefined;
  // When a reply on this version already links the newer one, that link says it.
  const newer = found && !linkedFrom(snapshot, resource).some(r => r.id === found.id && r.version === found.version) ? found : undefined;
  if (!runs && !children) return null;
  return <><div className="shell-source" data-rho-layer="persistent">
    {run ? <button className="shell-producer" data-rho-producer="" disabled={!object} title={object ? `Open ${run.operationId}, the run that produced this version` : 'This run is outside the retained records'} onClick={() => object && live.act({ kind: 'open', target: object })}>
      <span data-fact="observed" className={'shell-state ' + run.execution}>{run.operationId} · {executionWord(run.execution)}</span>
    </button> : runs && <span data-fact="observed" className="shell-meta">{(resource.provenance as { operationId?: string })?.operationId?.startsWith('registration:') ? 'Registered file' : 'No recorded run'}</span>}
    {run && <span data-fact="verified" className={'shell-verified ' + run.integrity}>{run.declared.length ? integrityWord(run.integrity) : 'no declared file'} · {domainWord(run)}</span>}
    {words && <span data-fact="agent" className="shell-agent-words" title={words}>Agent: “{words}”</span>}
    {notes.map(i => <span key={i.id} data-fact="agent" className="shell-agent-words" title={[i.title, i.summary].filter(Boolean).join(' — ')}>Agent: {i.title} · {i.state}</span>)}
    {newer && <button className="shell-link" onClick={() => onOpenRef({ id: newer.id, version: newer.version })}>Newer version · {newerName}</button>}
  </div>
  {/* The person's own question on this version is a temporary addition (M2), on its own line. */}
  {children && <div className="shell-question" data-rho-layer="transient">{children}</div>}</>;
}

// What a stop request has led to, in Core's terms: a request is not a stop, and only an
// ended process is called stopped.
const stopWords: Record<string, string> = {
  requested: 'Stop requested · Core has not acted on it yet', signalled: 'Stop signalled · the process has not ended yet',
  stopped: 'Stopped', 'finished-first': 'Ended before the stop took effect',
  unconfirmed: 'Stop requested · Core no longer reports this process, so whether it stopped is unknown'
};
const whoWords: Record<string, string> = { Agent: 'the Agent', Person: 'a browser tab', Operator: 'Rho' };
const allowedIn = (snapshot: WorkspaceSnapshot) => (method: string) => snapshot.catalog.operations.some(o => o.method === method && o.state === 'available' && o.authorized);
export const openRun = (live: Live, operationId: string) => { const o = runObject(live, operationId); if (o) live.act({ kind: 'open', target: o }); };
// The first line of a run's error, as the live session read it from the run's output.
export function runFirstLine(live: Live, operationId: string) {
  const item = Object.values(live.screen?.objects ?? {}).find(o => o.kind === 'run' && live.state?.names[o.id] === operationId);
  return item?.kind === 'run' ? item.firstLine : null;
}

// One execution as the owners recorded it. The shell opens it from its mark or from an
// artifact, the project page from a run that needs attention; each passes the runs it read
// and its own way to open a version or another run.
export function RunView({ snapshot, client, operationId, runs, readRuns, firstLine = null, opener, onOpenRun }: {
  snapshot: WorkspaceSnapshot; client: BrowserClient; operationId: string; runs: RunFacts[] | null; readRuns: () => void;
  // How to open one version this run wrote, or null where it cannot be opened from here.
  firstLine?: string | null; opener: (ref: Ref) => (() => void) | null; onOpenRun: (operationId: string) => void;
}) {
  const run = runs?.find(r => r.operationId === operationId), allowed = allowedIn(snapshot), projectId = snapshot.project.id;
  const outputs = snapshot.resources.filter(r => (r.provenance as { operationId?: string })?.operationId === operationId);
  const chain = run && runs ? sameSourceKey(runs, run.sourceKey) : [];
  // The owner records a script by the digest of its code; a reader needs which version of it ran.
  const versions = [...new Set(chain.map(r => r.script).filter(Boolean))];
  const code = !run?.script ? ' · code not recorded' : versions.length > 1 ? ` · code version ${versions.indexOf(run.script) + 1} of ${versions.length}` : '';
  const active = !!run && ['active', 'unobserved'].includes(run.execution);
  const present = run?.declared.filter(d => d.present).length ?? 0;
  const partial = !!run && run.execution !== 'completed' && present > 0 && present < run.declared.length;
  const repairs = runs?.filter(r => r.repairOf === operationId) ?? [];
  // Core reports that a process ended only when asked; while this run can still change, ask.
  useEffect(() => { if (!active) return; const timer = setInterval(readRuns, 1500); return () => clearInterval(timer); }, [active, readRuns]);
  const [stopping, setStopping] = useState(false), [stopProblem, setStopProblem] = useState('');
  // Core's answer to the request itself, shown until the project's runs are read again.
  const [answered, setAnswered] = useState<RunFacts['stop']>(null);
  async function stop() {
    setStopping(true); setStopProblem('');
    try {
      const result = await client.call('action.cancel', { projectId, operationId }, AbortSignal.timeout(30000)) as { native?: { status?: object; cancel?: object }; cancellation?: { requestedAt?: string } };
      // Only a stop still in progress is shown from the reply; an end is the next read's to say,
      // together with the run's own state.
      const state = stopState(result.native?.status ?? {}, result.native?.cancel);
      setAnswered(state === 'requested' || state === 'signalled' ? { requestedAt: result.cancellation?.requestedAt ?? new Date().toISOString(), by: 'Person', state, exit: null } : null);
      readRuns();
    }
    catch (error) { setStopProblem(error instanceof Error ? error.message : 'The stop request was not accepted.'); }
    finally { setStopping(false); }
  }
  const stopped = run?.stop ?? answered;
  return <section className="shell-run" data-owner-body="" aria-label={operationId}>
    <h2>{operationId}</h2>
    {!runs ? <p role="status">Reading the project's executions…</p> : !run ? <p role="status">This run is outside the latest 50 retained executions.</p> : <>
      <p data-fact="observed" data-rho-execution={run.execution}><span className={'shell-state ' + run.execution}>{executionWord(run.execution)}</span>{partial ? ` · partial output, ${present} of ${run.declared.length} files` : ''}{code} · submitted by {whoWords[run.author] ?? run.author} at {time(run.acceptedAt)}{run.hasStderr && !firstLine ? ' · stderr retained' : ''}
        {active && !stopped && allowed('action.cancel') && <button className="shell-quiet shell-stop" disabled={stopping} onClick={stop}>{stopping ? 'Requesting stop…' : 'Stop run'}</button>}</p>
      {stopped && <p data-fact="observed" data-rho-stop={stopped.state} role="status">{stopWords[stopped.state] ?? stopped.state}{stopped.exit ? ' · ' + stopped.exit : ''} · asked by {whoWords[stopped.by] ?? stopped.by} at {time(stopped.requestedAt)}</p>}
      {stopProblem && <p role="alert">{stopProblem}</p>}
      {firstLine && <p data-fact="observed" className="shell-run-error">{firstLine}</p>}
      {(run.repairOf || repairs.length > 0) && <p className="shell-run-repair">
        {run.repairOf && <>Repairs <button className="shell-link" data-rho-repair-of={run.repairOf} onClick={() => onOpenRun(run.repairOf!)}>{run.repairOf}</button></>}
        {run.repairOf && repairs.length > 0 && ' · '}
        {repairs.length > 0 && <>Repaired by {repairs.map((r, i) => <span key={r.operationId}>{i ? ', ' : ''}<button className={'shell-link ' + r.execution} data-rho-repaired-by={r.operationId} onClick={() => onOpenRun(r.operationId)}>{r.operationId}</button></span>)}</>}
      </p>}
      {['failed', 'unknown'].includes(run.execution) && allowed('context.create') && <Repair snapshot={snapshot} client={client} operationId={operationId} />}
      {run.declared.length > 0 && <ul className="shell-run-files" data-fact="observed">{run.declared.map(d => <li key={d.path}>{shortPath(d.path)} · {d.present ? 'on disk' : 'not on disk'}</li>)}</ul>}
      <p data-fact="verified">{run.declared.length ? integrityWord(run.integrity) : 'no declared file'} · {domainWord(run)} · no run establishes a statistical result</p>
      {outputs.length > 0 && <ul className="shell-run-outputs">{outputs.map(r => {
        const open = opener({ id: r.id, version: r.version });
        return <li key={r.id + r.version}>{open ? <button className="shell-link" data-rho-artifact={r.id + '@' + r.version} onClick={open}>{shortPath(r.path)}</button> : <span data-rho-artifact={r.id + '@' + r.version}>{shortPath(r.path)}</span>}<span> · this run's version</span></li>;
      })}</ul>}
      {chain.length > 1 && <p className="shell-run-chain">{chain.map(other => <button key={other.operationId} className={'shell-link ' + other.execution} aria-current={other.operationId === operationId || undefined} disabled={other.operationId === operationId} onClick={() => onOpenRun(other.operationId)}>{other.operationId}</button>)}</p>}
      {allowed('action.output') && <Output client={client} projectId={projectId} operationId={operationId} runs={runs} active={active} />}
    </>}
  </section>;
}

// The end of each retained stream, at most outputBytes of it, with every cut said: the
// earlier bytes not shown here, and the bytes Core observed but did not keep.
export const outputBytes = 16384;
type Tail = { text: string; from: number; retained: number; observed: number; truncated: boolean };
async function tail(client: BrowserClient, projectId: string, operationId: string, stream: 'stdout' | 'stderr'): Promise<Tail> {
  const read = async (offset: number) => {
    const result = await client.call('action.output', { projectId, operationId, stream, offset, maxBytes: outputBytes }, AbortSignal.timeout(30000)) as { reply?: { ok?: boolean; value?: any; error?: { message?: string } } };
    if (!result.reply?.ok || !result.reply.value) throw new Error(result.reply?.error?.message ?? 'Core did not return this output.');
    return result.reply.value as { text: string; info: { retained_bytes: number; observed_bytes: number; truncated: boolean } };
  };
  let chunk = await read(0), from = 0;
  if (chunk.info.retained_bytes > outputBytes) { from = chunk.info.retained_bytes - outputBytes; chunk = await read(from); }
  // A start inside a multi-byte character decodes as replacement characters; drop them.
  return { text: from > 0 ? chunk.text.replace(/^\uFFFD+/, '') : chunk.text, from, retained: chunk.info.retained_bytes, observed: chunk.info.observed_bytes, truncated: chunk.info.truncated };
}
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
function Output({ client, projectId, operationId, runs, active }: { client: BrowserClient; projectId: string; operationId: string; runs: unknown; active: boolean }) {
  const [open, setOpen] = useState(false), [streams, setStreams] = useState<Record<string, Tail>>({}), [problem, setProblem] = useState(''), region = useId();
  // Read on opening, again each time the runs are read while the process may still write, and once when it ends.
  useEffect(() => {
    if (!open) return;
    let current = true;
    Promise.all((['stderr', 'stdout'] as const).map(async stream => [stream, await tail(client, projectId, operationId, stream)] as const))
      .then(read => { if (current) { setStreams(Object.fromEntries(read)); setProblem(''); } }, (error: unknown) => { if (current) setProblem(error instanceof Error ? error.message : 'The output could not be read.'); });
    return () => { current = false; };
  }, [open, client, projectId, operationId, active ? runs : active]);
  return <div className="shell-run-output">
    <button className="shell-quiet" aria-expanded={open} aria-controls={region} onClick={() => setOpen(value => !value)}>{open ? 'Hide output' : 'Show output'}</button>
    {open && <div id={region}>
      {problem && <p role="alert">{problem}</p>}
      {(['stderr', 'stdout'] as const).map(stream => { const t = streams[stream]; return t && <section key={stream} aria-label={stream} data-rho-output={stream}>
        <h3>{stream}</h3>
        {t.from > 0 && <p data-rho-cut="earlier">Last {size(t.retained - t.from)} of {size(t.retained)} shown</p>}
        {t.truncated && <p data-rho-cut="core">Core kept {size(t.retained)} of the {size(t.observed)} written</p>}
        {t.text ? <pre data-scroll-region="" tabIndex={0}>{t.text}</pre> : <p>No output</p>}
      </section>; })}
    </div>}
  </div>;
}

// Asking the Agent to fix a failed run: Rho freezes the run's facts (its error text, script
// and files) as a context, and the person pastes the Agent a request that names it.
function Repair({ snapshot, client, operationId }: { snapshot: WorkspaceSnapshot; client: BrowserClient; operationId: string }) {
  const prepared = (snapshot.contexts ?? []).filter(c => (c as { run?: string }).run === operationId).at(-1) as { contextId: string; delivery?: string; fetchedAt?: string } | undefined;
  const [asking, setAsking] = useState(false), [problem, setProblem] = useState(''), [copied, setCopied] = useState(false), [made, setMade] = useState<string | null>(null);
  const contextId = prepared?.contextId ?? made;
  const request = contextId ? `Repair the failed Rho run ${operationId}: read context ${contextId}, fix the cause, and submit the fix as a new operationId with repairOf "${operationId}".` : '';
  async function ask() {
    setAsking(true); setProblem('');
    try { setMade((await client.call('context.create', { projectId: snapshot.project.id, run: { operationId }, changeId: 'repair-' + operationId + '-' + Date.now(), expectedVersion: 0 }, AbortSignal.timeout(30000))).contextId); }
    catch (error) { setProblem(error instanceof Error ? error.message : "The run's facts could not be prepared."); }
    finally { setAsking(false); }
  }
  async function copy() {
    setCopied(false);
    try { await navigator.clipboard.writeText(request); setCopied(true); } catch { setProblem('Could not copy. Select and copy the request text instead.'); }
  }
  return <div className="shell-run-fix" data-rho-repair="">
    {!contextId ? <button disabled={asking} onClick={ask}>{asking ? 'Preparing…' : 'Ask the Agent to fix'}</button> : <>
      <span role="status">{prepared?.delivery === 'tool-fetched' ? `Fetched by the Agent${prepared.fetchedAt ? ' at ' + time(prepared.fetchedAt) : ''}` : 'Prepared · the Agent has not fetched it yet'}</span>
      {/* The request names the context by its identity, which is the Agent's to read, not the person's. */}
      <button className="shell-quiet" onClick={copy}>{copied ? 'Copied' : 'Copy request for the Agent'}</button>
    </>}
    {problem && <p role="alert">{problem}</p>}
  </div>;
}
