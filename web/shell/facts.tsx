import { useEffect, useId, useState, type ReactNode } from 'react';
import type { BrowserClient, ResourceSummary, WorkspaceSnapshot } from '../../src/browser.js';
import { executionWord, integrityWord, producerOf, sameSourceKey, shortPath, stopState, type RunFacts } from '../../src/execution-facts.js';
import type { Live } from './live.js';
import { Icon, type IconName } from '../icons.js';
// The run view also opens on the project page, which loads no other part of the shell.
import './shell.css';

type Ref = { id: string; version: string };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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
      <span data-fact="observed" className={'shell-state ' + run.execution}><span className="shell-run-id">{run.operationId}</span> · {executionWord(run.execution)}</span>
    </button> : runs && <span data-fact="observed" className="shell-meta">{(resource.provenance as { source?: string })?.source === 'current-filesystem-observation' ? 'Observed file snapshot · producer unconfirmed' : (resource.provenance as { operationId?: string })?.operationId?.startsWith('registration:') ? 'Registered file' : 'No recorded run'}</span>}
    {run && (() => { const integrity = run.declared.length ? integrityWord(run.integrity) : 'no declared file', checked = `${integrity} · ${domainWord(run)}`;
      // What Rho checked, then what nothing checked: only the first may carry the verified colour.
      return <span data-fact="verified" className={'shell-verified ' + run.integrity} title={checked}><span className="shell-integrity">{integrity}</span> · {domainWord(run)}</span>; })()}
    {words && <span data-fact="agent" className="shell-agent-words" title={words}>Agent: “{words}”</span>}
    {notes.map(i => <span key={i.id} data-fact="agent" className="shell-agent-words" title={[i.title, i.summary].filter(Boolean).join(' — ')}>Agent: {i.title} · {i.state}</span>)}
    {newer && <button className="shell-link" onClick={() => onOpenRef({ id: newer.id, version: newer.version })}>Newer version · {newerName}</button>}
  </div>
  {/* The person's own question on this version is a temporary addition, on its own line.
      A long answer scrolls inside it, so the work keeps most of the view. */}
  {children && <div className="shell-question" data-rho-layer="transient" data-scroll-region="" role="region" aria-label="Question and answers" tabIndex={0}>{children}</div>}</>;
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
export function RunView({ snapshot, client, operationId, runs, readRuns, firstLine = null, opener, onOpenRun, chain: showChain = true }: {
  snapshot: WorkspaceSnapshot; client: BrowserClient; operationId: string; runs: RunFacts[] | null; readRuns: () => void;
  // How to open one version this run wrote, or null where it cannot be opened from here.
  firstLine?: string | null; opener: (ref: Ref) => (() => void) | null; onOpenRun: (operationId: string) => void;
  // The other attempts at the same script; the workspace's activity bar already places them.
  chain?: boolean;
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
  // A failure a later run repaired is history: readable, but no longer in the failed colour.
  const repaired = repairs.some(r => r.execution === 'completed');
  // The live trace carries no output, so a failed run reads its own cause: the first "Error"
  // line of its stderr, else the first line, verbatim.
  const failed = !!run && ['failed', 'unknown'].includes(run.execution);
  const [cause, setCause] = useState<string | null>(null);
  useEffect(() => {
    if (firstLine || !failed || !run?.hasStderr || !allowed('action.output')) return;
    let current = true;
    tail(client, projectId, operationId, 'stderr').then(t => {
      if (!current) return;
      const lines = t.text.split('\n').map(l => l.trim()).filter(Boolean);
      setCause(lines.find(l => /^Error\b/.test(l)) ?? lines[0] ?? null);
    }, () => {});
    return () => { current = false; };
  }, [client, projectId, operationId, failed, firstLine, run?.hasStderr]);
  const error = firstLine ?? cause;
  // Core reports that a process ended only when asked; while this run can still change, ask.
  useEffect(() => { if (!active) return; const timer = setInterval(readRuns, 1500); return () => clearInterval(timer); }, [active, readRuns]);
  // A running process has a clock; the last time the same script ran to its end says roughly how long to expect.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (run?.execution !== 'active') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [run?.execution]);
  const previous = run ? chain.filter(r => r.operationId !== operationId && r.execution === 'completed' && took(r) !== null && r.acceptedAt < run.acceptedAt).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt)).at(-1) : undefined;
  const [stopping, setStopping] = useState(false), [stopProblem, setStopProblem] = useState('');
  const [output, setOutput] = useState(false), [exporting, setExporting] = useState(false), outputRegion = useId();
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
  const declaredPaths = new Set(run?.declared.map(d => shortPath(d.path)) ?? []);
  const fileCard = (name: string, state: string, className: string, ref?: ResourceSummary) => {
    const open = ref && opener({ id: ref.id, version: ref.version }), key = ref && ref.id + '@' + ref.version;
    return <li key={name} className={'shell-run-file ' + className}>
      <Icon name={fileIcon(name)} size={16} stroke={1.8} />
      {open ? <button className="shell-run-file-name" data-rho-artifact={key} onClick={open}>{name}</button> : <span className="shell-run-file-name" data-rho-artifact={key}>{name}</span>}
      <span className="shell-run-file-state">{state}</span>
    </li>;
  };
  return <section className="shell-run" data-owner-body="" aria-label={operationId}>
    <header className="shell-run-head">
      <h2>{operationId}</h2>
      {run && <div className="shell-run-actions">
        {active && !stopped && allowed('action.cancel') && <button className="shell-stop" disabled={stopping} onClick={stop}>{stopping ? 'Requesting stop…' : 'Stop run'}</button>}
        {allowed('action.output') && <button aria-expanded={output} aria-controls={outputRegion} onClick={() => setOutput(value => !value)}>{output ? 'Hide output' : 'Show output'}</button>}
        {!active && allowed('action.export') && <button aria-expanded={exporting} onClick={() => setExporting(value => !value)}>Export files…</button>}
      </div>}
    </header>
    {!runs ? <p role="status">Reading the project's executions…</p> : !run ? <p role="status">This run is outside the latest 50 retained executions.</p> : <>
      <p data-fact="observed" data-rho-execution={run.execution} className="shell-run-status"><span className={'shell-state ' + run.execution + (repaired ? ' superseded' : '')}>{executionWord(run.execution)}</span>{partial ? ` · partial output, ${present} of ${run.declared.length} files` : ''}{code} · submitted by {whoWords[run.author] ?? run.author} at {time(run.acceptedAt)}{run.hasStderr && !error ? ' · stderr retained' : ''}</p>
      {run.execution === 'active' ? <p data-fact="observed" className="shell-run-clock" title={run.startedAt ? 'Since Core saw the process start at ' + time(run.startedAt) : 'Since Rho accepted it at ' + time(run.acceptedAt)}><span className="shell-run-elapsed">{minutes(now - Date.parse(run.startedAt ?? run.acceptedAt))}</span>{previous && <> · {previous.operationId} took {minutes(took(previous)!)}</>}</p>
        : took(run) !== null && <p data-fact="observed" className="shell-run-clock">{took(run)! < 1000 ? 'took less than a second' : 'took ' + minutes(took(run)!)}</p>}
      {stopped && <p data-fact="observed" data-rho-stop={stopped.state} role="status">{stopWords[stopped.state] ?? stopped.state}{stopped.exit ? ' · ' + stopped.exit : ''} · asked by {whoWords[stopped.by] ?? stopped.by} at {time(stopped.requestedAt)}</p>}
      {stopProblem && <p role="alert">{stopProblem}</p>}
      {error && <p data-fact="observed" className={'shell-run-error' + (repaired ? ' superseded' : '')}>{error}</p>}
      {failed && allowed('context.create') && <Repair snapshot={snapshot} client={client} operationId={operationId} repaired={repairs.length > 0} />}
      {(run.repairOf || repairs.length > 0) && <p className="shell-run-repair">
        {run.repairOf && <>Repairs <button className="shell-link" data-rho-repair-of={run.repairOf} onClick={() => onOpenRun(run.repairOf!)}>{run.repairOf}</button></>}
        {run.repairOf && repairs.length > 0 && ' · '}
        {repairs.length > 0 && <>{repaired ? 'Repaired by' : 'Repair'} {repairs.map((r, i) => <span key={r.operationId}>{i ? ', ' : ''}<button className={'shell-link ' + r.execution} data-rho-repaired-by={r.operationId} onClick={() => onOpenRun(r.operationId)}>{r.operationId}</button>{r.execution !== 'completed' && <> <span className={'shell-state ' + r.execution}>{executionWord(r.execution)}</span></>}</span>)}</>}
      </p>}
      {(run.declared.length > 0 || outputs.length > 0) && <ul className="shell-run-files" data-fact="observed" aria-label="Declared files">
        {run.declared.map(d => fileCard(shortPath(d.path), d.present ? size(d.bytes) : active ? 'not written yet' : 'not on disk', d.present ? 'present' : active ? 'shell-not-yet' : 'missing', outputs.find(r => shortPath(r.path) === shortPath(d.path))))}
        {outputs.filter(r => !declaredPaths.has(shortPath(r.path))).map(r => fileCard(shortPath(r.path), "this run's version", 'present', r))}
      </ul>}
      <p data-fact="verified" className="shell-run-checks">{run.declared.length ? integrityWord(run.integrity) : 'no declared file'} · {domainWord(run)} · no run establishes a statistical result
        {!active && present > 0 && (outputs.length === 0 || run.completion === 'present' && run.integrity !== 'verified') && <CheckFiles client={client} projectId={projectId} operationId={operationId} inventory={run.completion === 'present'} readRuns={readRuns} />}</p>
      {showChain && chain.length > 1 && <p className="shell-run-chain">{chain.map(other => <button key={other.operationId} className={'shell-chip ' + other.execution + (runs?.some(r => r.repairOf === other.operationId && r.execution === 'completed') ? ' superseded' : '')} aria-current={other.operationId === operationId || undefined} disabled={other.operationId === operationId} onClick={() => onOpenRun(other.operationId)}>{other.operationId}</button>)}</p>}
      {exporting && !active && allowed('action.export') && <ExportRun client={client} projectId={projectId} operationId={operationId} />}
      {output && allowed('action.output') && <Output client={client} projectId={projectId} operationId={operationId} runs={runs} active={active} region={outputRegion} />}
    </>}
  </section>;
}

// Minutes and seconds, as a run's clock reads them.
const minutes = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// How long Core saw a run's process live: from its spawn to the exit it observed.
const took = (run: RunFacts) => run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null;
export const fileIcon = (name: string): IconName => /\.(png|jpe?g|gif|svg|webp)$/i.test(name) ? 'image' : /\.(csv|tsv|parquet)$/i.test(name) ? 'table' : 'file';

// The files a run declared become openable once they are registered with their provenance.
// With an inventory the run wrote, registering checks each file's bytes against it; without
// one, the files are listed as found and stay unchecked.
function CheckFiles({ client, projectId, operationId, inventory, readRuns }: { client: BrowserClient; projectId: string; operationId: string; inventory: boolean; readRuns: () => void }) {
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState('');
  async function check() {
    setBusy(true); setProblem('');
    try { await client.call(inventory ? 'artifact.check' : 'resource.list', { projectId, operationId }, AbortSignal.timeout(60000)); readRuns(); }
    catch (error: any) { setProblem((error?.error ?? error)?.message ?? 'The files could not be checked.'); }
    finally { setBusy(false); }
  }
  return <>{' '}<button className="shell-quiet" disabled={busy} onClick={check}>{busy ? 'Checking…' : inventory ? 'Check its files' : 'List its files'}</button>{problem && <span role="alert"> · {problem}</span>}</>;
}

// Taking a run out of Rho: its script, outputs and their provenance as ordinary files in a new
// project folder. The owner decides what is complete; when the script has unsaved changes it
// asks, and the person answers here, so unsaved text never leaves or stays behind by default.
type Exported = { destination: string; exported: number; partial: boolean; files: Array<{ role: string; path: string; state: string; file?: string; reason?: string }> };
function ExportRun({ client, projectId, operationId }: { client: BrowserClient; projectId: string; operationId: string }) {
  const [folder, setFolder] = useState('exports/' + operationId), field = useId();
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [unsaved, setUnsaved] = useState<string | null>(null), [done, setDone] = useState<Exported | null>(null);
  async function send(choice?: 'include' | 'leave') {
    setBusy(true); setProblem('');
    try { setDone(await client.call('action.export', { projectId, operationId, destination: folder.trim(), ...(choice ? { unsaved: choice } : {}) }, AbortSignal.timeout(60000)) as Exported); setUnsaved(null); }
    catch (error: any) {
      const refusal = error?.error ?? error;
      if (refusal?.kind === 'condition' && refusal.details?.unsaved?.length) setUnsaved(String(refusal.details.unsaved[0].path));
      else setProblem(refusal?.message ?? 'The export did not finish.');
    } finally { setBusy(false); }
  }
  if (done) {
    const left = done.files.filter(f => f.state !== 'exported');
    return <div className="shell-run-export" data-rho-export="done">
      <p role="status">Exported {done.exported} {done.exported === 1 ? 'file' : 'files'} to {done.destination}{done.partial ? ' · partial' : ''}</p>
      {left.length > 0 && <ul>{left.map(f => <li key={f.role + f.path}>{f.file ?? f.path} · {f.reason}</li>)}</ul>}
    </div>;
  }
  return <div className="shell-run-export" data-rho-export="ready">
    <div className="shell-field"><label htmlFor={field}>Folder</label><input id={field} value={folder} disabled={busy || !!unsaved} onChange={event => setFolder(event.target.value)} /></div>
    {unsaved
      ? <p role="status" className="shell-run-fix">{unsaved} has unsaved changes.
        <button disabled={busy} onClick={() => send('include')}>Include them</button>
        <button disabled={busy} onClick={() => send('leave')}>Leave them out</button></p>
      : <p><button disabled={busy || !folder.trim()} onClick={() => send()}>{busy ? 'Exporting…' : 'Export'}</button></p>}
    {problem && <p role="alert">{problem}</p>}
  </div>;
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
function Output({ client, projectId, operationId, runs, active, region }: { client: BrowserClient; projectId: string; operationId: string; runs: unknown; active: boolean; region: string }) {
  const [streams, setStreams] = useState<Record<string, Tail>>({}), [problem, setProblem] = useState('');
  // Read on opening, again each time the runs are read while the process may still write, and once when it ends.
  useEffect(() => {
    let current = true;
    Promise.all((['stderr', 'stdout'] as const).map(async stream => [stream, await tail(client, projectId, operationId, stream)] as const))
      .then(read => { if (current) { setStreams(Object.fromEntries(read)); setProblem(''); } }, (error: unknown) => { if (current) setProblem(error instanceof Error ? error.message : 'The output could not be read.'); });
    return () => { current = false; };
  }, [client, projectId, operationId, active ? runs : active]);
  return <div className="shell-run-output">
    <div id={region}>
      {problem && <p role="alert">{problem}</p>}
      {(['stderr', 'stdout'] as const).map(stream => { const t = streams[stream]; return t && <section key={stream} aria-label={stream} data-rho-output={stream}>
        <h3>{stream}</h3>
        {t.from > 0 && <p data-rho-cut="earlier">Last {size(t.retained - t.from)} of {size(t.retained)} shown</p>}
        {t.truncated && <p data-rho-cut="core">Core kept {size(t.retained)} of the {size(t.observed)} written</p>}
        {t.text ? <pre data-scroll-region="" tabIndex={0}>{t.text}</pre> : <p>No output</p>}
      </section>; })}
    </div>
  </div>;
}

// Asking the Agent to fix a failed run: Rho freezes the run's facts (its error text, script
// and files) as a context, and the person pastes the Agent a request that names it.
function Repair({ snapshot, client, operationId, repaired }: { snapshot: WorkspaceSnapshot; client: BrowserClient; operationId: string; repaired: boolean }) {
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
  // Once a repair exists there is nothing to ask; what happened to the request is still said.
  if (repaired && !contextId) return null;
  return <div className="shell-run-fix" data-rho-repair="">
    {!contextId ? <button className="primary" disabled={asking} onClick={ask}>{asking ? 'Preparing…' : 'Ask the Agent to fix'}</button> : <>
      <span role="status">{prepared?.delivery === 'tool-fetched' ? `Fetched by the Agent${prepared.fetchedAt ? ' at ' + time(prepared.fetchedAt) : ''}` : 'Prepared · the Agent has not fetched it yet'}</span>
      {/* The request names the context by its identity, which is the Agent's to read, not the person's. */}
      {!repaired && <button className="shell-run-copy" onClick={copy}>{copied ? 'Copied' : 'Copy request for the Agent'}</button>}
    </>}
    {problem && <p role="alert">{problem}</p>}
  </div>;
}
