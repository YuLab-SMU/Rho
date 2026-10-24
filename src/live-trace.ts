// Public snapshot observations -> the same expression facts as the recorded replay.
// Metadata reads are not reconstructed calls. Missing identities/times stay unknown.
import type { WorkspaceSnapshot, ViewDescription, CompositionSummary } from './browser.js';
import type { RhoOutput } from './contract.generated.js';
import type { ArtifactRef, Effect, Fact, Trace } from './expression.js';
export type RunSummary = RhoOutput<'project.runs'>['runs'][number];
export interface LiveIndex {
  activity: number; runs: string[]; states: Record<string, string>; documents: Record<string, string>;
  resources: Record<string, string>; composition: number; questions: Record<string, string>;
}
export const liveIndex = (): LiveIndex => ({ activity: 0, runs: [], states: {}, documents: {}, resources: {}, composition: 0, questions: {} });
export interface LiveTrace {
  trace: Trace; refs: Record<string, ArtifactRef>; names: Record<string, string>; gap: boolean;
}
const base = (path: string) => path.split('/').at(-1) ?? path;
export function snapshotTrace(snapshot: WorkspaceSnapshot, summaries: RunSummary[], composition: CompositionSummary, index: LiveIndex): LiveTrace {
  const trace: Trace = { format: 'rho.replay-trace/1', recorded: { experiment: 'live', project: snapshot.project.id, from: '', to: '' }, facts: [], principals: {}, sources: {}, runs: {}, artifacts: {} };
  const names: Record<string, string> = {}, refs: Record<string, ArtifactRef> = {};
  const emit = (op: string, actor: string, at: string | null, effect?: Effect, object?: string, reason?: Fact['reason']) => {
    trace.principals[actor] = { kind: actor.startsWith('agent:') ? 'agent' : actor.startsWith('browser:') ? 'browser' : 'operator', name: null };
    trace.facts.push({ seq: trace.facts.length, label: op, op, actor, at, effect, object, outcome: reason ? 'rejected' : 'returned', ...(reason ? { reason } : {}) });
  };
  const runNumber = (id: string) => { const n = index.runs.indexOf(id); return n < 0 ? null : n + 1; };
  const changedRuns = new Set<string>();
  for (const run of [...summaries].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))) {
    if (!index.runs.includes(run.operationId)) index.runs.push(run.operationId);
    const n = runNumber(run.operationId)!, source = run.sourceKey ?? run.operationId;
    names['run:' + n] = run.operationId;
    trace.runs[n] = { operationId: run.operationId, source, sourceVersion: null, declared: run.declared.map(d => d.path), acceptedAt: run.acceptedAt, exit: null, observedAt: null, outputs: {} };
    const state = JSON.stringify([run.execution, run.integrity]);
    if (index.states[run.operationId] !== state) changedRuns.add(run.operationId);
    if (!(run.operationId in index.states)) emit('action.accepted', 'operator', run.acceptedAt, { kind: 'submit', run: n, source, sourceVersion: null, state: 'unobserved' }, 'run:' + n);
    if (index.states[run.operationId] !== state) {
      const observed = run.execution === 'active' ? 'running' : ['completed', 'failed', 'unobserved'].includes(run.execution) ? run.execution as 'completed' | 'failed' | 'unobserved' : 'unknown';
      emit('operation.observed', 'operator', null, { kind: 'run-state', run: n, state: observed }, 'run:' + n);
    }
    index.states[run.operationId] = state;
  }
  for (const d of snapshot.documents) {
    const object = 'source:' + d.path; names[object] = d.path;
    trace.sources[d.path] = { versions: {}, edited: {}, saved: {}, authors: {} };
    const version = JSON.stringify([d.version, d.dirty]);
    if (index.documents[d.id] !== version) {
      emit('document.observed', 'operator', d.acknowledgedAt, { kind: 'source-state', source: d.path, version: d.version, savedVersion: d.dirty ? null : d.version }, object);
      index.documents[d.id] = version;
    }
    refs['document:' + d.id] = { object, artifact: '', run: null };
  }
  for (const r of snapshot.resources) {
    const provenance = r.provenance as { operationId?: string }, run = summaries.find(x => x.operationId === provenance.operationId);
    const declaration = run?.declared.find(d => r.path === d.path || r.path.endsWith('/' + d.path));
    // A filename alone never groups two outputs. Only the producing source and its
    // exact declared output path establish a version family. Otherwise use owner ID.
    const known = index.resources[r.id], suffix = '@' + r.version;
    const family = run?.sourceKey && declaration ? run.sourceKey + '/' + declaration.path : known?.endsWith(suffix) ? known.slice(0, -suffix.length) : r.id;
    const object = 'artifact:' + family, n = provenance.operationId ? runNumber(provenance.operationId) : null;
    const ref = { artifact: family, run: n, version: r.version }; refs[r.id + '@' + r.version] = ref;
    names[object] = base(r.path);
    const versions = (trace.artifacts[family] ??= { kind: r.kind, versions: {} }).versions;
    const v = versions[r.version] ??= { runs: [], bytes: r.bytes };
    if (n !== null) v.runs.push(n);
    if (index.resources[r.id] !== family + '@' + r.version) {
      emit('resource.registered', 'operator', null, { kind: 'registered', artifact: family, name: base(r.path), version: r.version, run: n }, object);
      index.resources[r.id] = family + '@' + r.version;
    }
  }
  for (const run of summaries) if (run.integrity === 'verified' && changedRuns.has(run.operationId)) {
    const n = runNumber(run.operationId)!;
    const produced = snapshot.resources.filter(r => (r.provenance as { operationId?: string }).operationId === run.operationId);
    trace.runs[n].verified = produced.map(r => ({ name: refs[r.id + '@' + r.version].artifact, digest: r.version, kind: r.kind }));
    emit('artifact.integrity.observed', 'operator', null, { kind: 'verified', run: n, artifacts: trace.runs[n].verified!.map(r => r.name) }, 'run:' + n);
  }
  // Use only exact references the view actually carries.
  for (const v of composition.views) { const ref = referenceFor(v, refs); if (ref) refs['view:' + v.id] = ref; }
  const gap = snapshot.activity.retainedFrom > index.activity + 1;
  for (const raw of snapshot.activity.entries) {
    const e = raw as typeof raw & { documentId?: string; operationId?: string; resource?: unknown; returnedVersion?: number; errorKind?: string };
    if (e.cursor <= index.activity) continue;
    const doc = snapshot.documents.find(d => d.id === e.documentId);
    const n = typeof e.operationId === 'string' ? runNumber(e.operationId) : null;
    const r = e.resource as { id?: string; version?: string } | undefined;
    const ref = r ? refs[r.id + '@' + r.version] : undefined;
    let effect: Effect | undefined, object: string | undefined;
    if (doc) object = 'source:' + doc.path;
    if (n !== null) object = 'run:' + n;
    if (ref) object = ref.object ?? 'artifact:' + ref.artifact;
    if (e.outcome === 'rejected') { emit(e.method, e.principal, e.at, undefined, object, { kind: typeof e.errorKind === 'string' ? e.errorKind : 'unrecorded', message: null }); continue; }
    if (['capability.index', 'capability.resolve'].includes(e.method)) effect = { kind: 'catalog' };
    if (doc && typeof e.returnedVersion === 'number' && ['document.open', 'document.read', 'document.edit', 'document.save'].includes(e.method)) effect = { kind: 'open', source: doc.path, version: doc.version };
    if (n !== null && ['action.submit', 'action.lookup', 'action.observe', 'artifact.check', 'action.output'].includes(e.method)) effect = { kind: 'observe', run: n };
    if (e.method === 'data.page') effect = { kind: 'read', artifact: ref?.artifact ?? null, run: ref?.run ?? null };
    emit(e.method, e.principal, e.at, effect, object);
  }
  index.activity = Math.max(index.activity, snapshot.activity.cursor);
  if (composition.version !== index.composition) {
    const views = composition.views.flatMap(v => refs['view:' + v.id] ? [refs['view:' + v.id]] : []);
    emit('composition.observed', composition.author ?? 'operator', composition.acknowledgedAt ?? null, { kind: 'layout', replace: true, views }, 'layout');
    index.composition = composition.version;
  }
  for (const raw of snapshot.annotations) {
    const t = raw as any, original = t.messages?.[0], anchor = t.anchor;
    if (anchor?.kind !== 'table' || !original) continue;
    const ref = refs[anchor.resource.id + '@' + anchor.resource.version];
    if (!ref) continue;
    const id = 'question:' + t.annotationId;
    const context = snapshot.contexts.find((c: any) => c.responses?.some((r: any) => r.annotationId === t.annotationId)) as any;
    const replied = t.messages.some((m: any) => m.replyTo === original.id && m.author.startsWith('agent:'));
    const fetched = context?.delivery === 'tool-fetched' && context.fetchedBy?.startsWith('agent:');
    const state = replied ? 'responded' : fetched ? 'fetched' : 'prepared';
    if (!(id in index.questions)) emit('annotation.create', original.author, original.at, { kind: 'ask', question: id, text: original.draft.text, target: 'artifact:' + ref.artifact, version: anchor.resource.version, run: ref.run, rows: anchor.entities, document: null }, id);
    if (index.questions[id] !== state) {
      if (fetched) emit('context.read', context.fetchedBy, context.fetchedAt, { kind: 'fetched', question: id }, id);
      if (replied) { const reply = t.messages.find((m: any) => m.replyTo === original.id && m.author.startsWith('agent:')); emit('annotation.reply', reply.author, reply.at, { kind: 'responded', question: id }, id); }
      index.questions[id] = state;
    }
  }
  return { trace, refs, names, gap };
}
export function referenceFor(view: ViewDescription, refs: Record<string, ArtifactRef>): ArtifactRef | undefined {
  for (const b of Object.values(view.bindings ?? {}) as Array<{ id?: string; version?: string | number; documentId?: string }>) {
    const ref = b.documentId ? refs['document:' + b.documentId] : refs[b.id + '@' + b.version];
    if (ref) return ref;
  }
}
