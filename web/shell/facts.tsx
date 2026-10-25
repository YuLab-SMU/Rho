import type { ReactNode } from 'react';
import type { ResourceSummary, WorkspaceSnapshot } from '../../src/browser.js';
import { executionWord, integrityWord, producerOf, sameSourceKey, shortPath, type RunFacts } from '../../src/execution-facts.js';
import type { Live } from './live.js';

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

// One execution as the owners recorded it, opened from its mark or from an artifact.
export function RunView({ live, snapshot, operationId, onOpenRef }: { live: Live; snapshot: WorkspaceSnapshot; operationId: string; onOpenRef: (ref: Ref) => void }) {
  const runs = live.runs, run = runs?.find(r => r.operationId === operationId);
  const item = Object.values(live.screen?.objects ?? {}).find(o => o.kind === 'run' && live.state?.names[o.id] === operationId);
  const firstLine = item?.kind === 'run' ? item.firstLine : null;
  const outputs = snapshot.resources.filter(r => (r.provenance as { operationId?: string })?.operationId === operationId);
  const chain = run && runs ? sameSourceKey(runs, run.sourceKey) : [];
  // The owner records a script by the digest of its code; a reader needs which version of it ran.
  const versions = [...new Set(chain.map(r => r.script).filter(Boolean))];
  const code = !run?.script ? ' · code not recorded' : versions.length > 1 ? ` · code version ${versions.indexOf(run.script) + 1} of ${versions.length}` : '';
  return <section className="shell-run" data-owner-body="" aria-label={operationId}>
    <h2>{operationId}</h2>
    {!runs ? <p role="status">Reading the project's executions…</p> : !run ? <p role="status">This run is outside the latest 50 retained executions.</p> : <>
      <p data-fact="observed"><span className={'shell-state ' + run.execution}>{executionWord(run.execution)}</span>{code} · accepted {time(run.acceptedAt)}{run.hasStderr && !firstLine ? ' · stderr retained' : ''}</p>
      {firstLine && <p data-fact="observed" className="shell-run-error">{firstLine}</p>}
      {run.declared.length > 0 && <ul className="shell-run-files" data-fact="observed">{run.declared.map(d => <li key={d.path}>{shortPath(d.path)} · {d.present ? 'on disk' : 'not on disk'}</li>)}</ul>}
      <p data-fact="verified">{run.declared.length ? integrityWord(run.integrity) : 'no declared file'} · {domainWord(run)} · no run establishes a statistical result</p>
      {outputs.length > 0 && <ul className="shell-run-outputs">{outputs.map(r => <li key={r.id + r.version}><button className="shell-link" data-rho-artifact={r.id + '@' + r.version} onClick={() => onOpenRef({ id: r.id, version: r.version })}>{shortPath(r.path)}</button><span> · this run's version</span></li>)}</ul>}
      {chain.length > 1 && <p className="shell-run-chain">{chain.map(other => <button key={other.operationId} className={'shell-link ' + other.execution} aria-current={other.operationId === operationId || undefined} disabled={other.operationId === operationId} onClick={() => { const o = runObject(live, other.operationId); if (o) live.act({ kind: 'open', target: o }); }}>{other.operationId}</button>)}</p>}
    </>}
  </section>;
}
