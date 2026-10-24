// Folds Rho's own records into a replay Trace, and a Trace into the Agent ledger's five
// projections. The records are the call activity Rho keeps for each bound Agent and the
// owner records that name what those calls touched: document histories, operation
// records, registered resources, the composition, the task map and contexts. DOM-free,
// so the build script, the tests and the replay share it (docs/INTERACTION-PLAN.md S2).
//
// Nothing is filled in. An identity the records do not hold stays null and the screen
// says "Not recorded"; every time is a recorded one. A call refused before it reached
// Rho (the agent adapter checks contracts itself) is not in these records at all.
// A run's exit is Rho's own observation, made when the host saw it, not when the Agent
// asked: it is a fact of the operator principal, and the Agent's lookups are reads.
import type { DeclaredItem, Fact, Trace } from './expression.js';

// A task map item as the owner keeps it; its artifact reference names a resource.
export type RecordedItem = Omit<DeclaredItem, 'artifact'> & { artifact?: { id: string; version: string } };

export interface ActivityEntry {
  cursor: number; principal: string; method: string; at: string; outcome: 'returned' | 'rejected'; errorKind?: string;
  returnedVersion?: number; operationId?: string; documentId?: string; contextId?: string;
}
export interface DocumentRecord {
  // A document that was on disk before its first recorded edit starts from that text;
  // initialDigest is the recorded digest of its first version.
  id: string; path: string; initial?: string; initialDigest?: string;
  history: { version: number; at: string; author: string; afterDigest: string; edits: { from: number; to: number; insert: string }[] }[];
  receipts: { kind: string; version: number; at: string; author: string }[];
}
export interface OperationRecord {
  operationId: string; principal: string; acceptedAt: string; script: { path: string; digest: string }; declared: string[];
  exit: number | null; exitObservedAt: string | null;
}
export interface ResourceRecord { id: string; name: string; version: string; kind: string; bytes: number; operationId: string; text?: string }
export interface ContextRecord {
  id: string; principal: string; at: string; changeId: string; text: string; document: { source: string; version: number };
  resource: { id: string; version: string }; rows: string[]; fetchedBy: string | null; fetchedAt: string | null;
}
export interface OwnerRecords {
  format: 'rho.owner-records/1';
  experiment: string;
  project: string;
  principals: Trace['principals'];
  activity: ActivityEntry[];
  // Each document's content at every retained version is rebuilt from its edits; the
  // extractor checked each against the recorded digest.
  documents: DocumentRecord[];
  operations: OperationRecord[];
  resources: ResourceRecord[];
  contexts: ContextRecord[];
  composition: { history: { version: number; views: { id: string; version: string }[] }[] } | null;
  // Only the latest declaration's items are retained; earlier ones are not recorded.
  taskMap: { question: string | null; items: RecordedItem[]; declared: { version: number; at: string; author: string }[] } | null;
}

const short = (digest: string) => digest.slice(0, 8);

export function fold(records: OwnerRecords): Trace {
  const documents = new Map(records.documents.map(d => [d.id, d]));
  const resources = (operationId: string) => records.resources.filter(r => r.operationId === operationId);
  // Runs are numbered in the order Rho accepted them, not from the Agent's operation names.
  const operations = [...records.operations].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
  const runOf = (operationId: string) => operations.findIndex(o => o.operationId === operationId) + 1 || null;

  const sources: Trace['sources'] = {};
  for (const d of records.documents) {
    let text = d.initial ?? '';
    const s = sources[d.path] = { versions: { 1: text } as Record<string, string>, edited: {} as Record<string, string>, saved: {} as Record<string, string>, authors: {} as Record<string, string> };
    for (const h of d.history) {
      // A change's edits are offsets into the text before it, so they apply from the end.
      for (const e of [...h.edits].sort((a, b) => b.from - a.from)) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
      s.versions[h.version] = text; s.edited[h.version] = h.at; s.authors[h.version] = h.author;
    }
    for (const r of d.receipts) if (r.kind === 'save') s.saved[r.version] = r.at;
  }
  // A run names its script by content digest; the document history says which version that is.
  const sourceVersion = (path: string, digest: string) => {
    const d = records.documents.find(x => x.path === path);
    return d?.history.find(h => h.afterDigest === digest)?.version ?? (d?.initialDigest === digest ? 1 : null);
  };

  const runs: Trace['runs'] = {}, artifacts: Trace['artifacts'] = {};
  for (const r of records.resources) {
    const a = artifacts[r.name] ??= { kind: r.kind, versions: {} };
    const v = a.versions[short(r.version)] ??= { runs: [], bytes: r.bytes, ...(r.text !== undefined ? { text: r.text } : {}) };
    const n = runOf(r.operationId);
    if (n !== null && !v.runs.includes(n)) v.runs.push(n);
  }
  for (const a of Object.values(artifacts)) for (const v of Object.values(a.versions)) v.runs.sort((x, y) => x - y);

  // An item's artifact reference resolves to the exact resource it names: that file,
  // those bytes, that run. A reference to nothing Rho registered is dropped, not guessed.
  const declared = ({ artifact, ...item }: RecordedItem): DeclaredItem => {
    const r = artifact && records.resources.find(x => x.id === artifact.id && x.version === artifact.version), n = r ? runOf(r.operationId) : null;
    return r && n !== null ? { ...item, artifact: { object: 'artifact:' + r.name, version: short(r.version), run: n } } : item;
  };
  type Timed = { fact: Omit<Fact, 'seq'>; order: number };
  const timed: Timed[] = [];
  const submitted = new Set<string>();
  const latestDeclared = records.taskMap?.declared.at(-1)?.version ?? null;
  for (const e of [...records.activity].sort((a, b) => a.cursor - b.cursor)) {
    const fact: Omit<Fact, 'seq'> = { label: 'activity ' + e.cursor, actor: e.principal, op: e.method, outcome: e.outcome, at: e.at };
    const doc = e.documentId ? documents.get(e.documentId) : undefined;
    const op = e.operationId ? records.operations.find(o => o.operationId === e.operationId) : undefined;
    const run = e.operationId ? runOf(e.operationId) : null;
    if (doc) fact.object = 'source:' + doc.path;
    if (run !== null) fact.object = 'run:' + run;
    if (e.outcome === 'rejected') fact.reason = { kind: e.errorKind ?? 'unrecorded', message: null };
    else switch (e.method) {
      case 'capability.index': case 'capability.resolve': fact.effect = { kind: 'catalog' }; break;
      // The activity keeps the version an open returned, not which document it was.
      case 'document.open': fact.effect = { kind: 'open', source: null, version: e.returnedVersion ?? 1 }; break;
      case 'document.edit': if (doc && e.returnedVersion) fact.effect = { kind: 'edit', source: doc.path, version: e.returnedVersion }; break;
      case 'document.save': if (doc && e.returnedVersion) fact.effect = { kind: 'save', source: doc.path, version: e.returnedVersion }; break;
      case 'action.submit': {
        if (!op || run === null) break;
        if (submitted.has(op.operationId)) { fact.effect = { kind: 'retry', run }; break; }
        submitted.add(op.operationId);
        const version = sourceVersion(op.script.path, op.script.digest);
        runs[run] = { operationId: op.operationId, source: op.script.path, sourceVersion: version, declared: op.declared, acceptedAt: op.acceptedAt, exit: op.exit, observedAt: op.exitObservedAt, outputs: {} };
        fact.effect = { kind: 'submit', run, source: op.script.path, sourceVersion: version };
        break;
      }
      case 'action.lookup': if (run !== null) fact.effect = { kind: 'observe', run }; break;
      case 'action.output': if (run !== null) fact.effect = { kind: 'output', run, stream: null }; break;
      case 'artifact.check': {
        if (!op || run === null) break;
        const found = resources(op.operationId);
        if (runs[run]) runs[run]!.verified = found.map(r => ({ name: r.name, digest: short(r.version), kind: r.kind }));
        fact.effect = { kind: 'verified', run, artifacts: found.map(r => r.name) };
        break;
      }
      case 'data.page': fact.effect = { kind: 'read', artifact: null, run: null }; break;
      // A recorded layout is the whole result, so it applies as a replace.
      case 'composition.apply': {
        const snapshot = records.composition?.history.find(h => h.version === e.returnedVersion);
        fact.object = 'layout';
        if (snapshot) fact.effect = { kind: 'layout', replace: true, views: snapshot.views.flatMap(v => {
          const r = records.resources.find(x => x.id === v.id && x.version === v.version), n = r && runOf(r.operationId);
          return r && n ? [{ artifact: r.name, run: n }] : [];
        }) };
        break;
      }
      case 'task.map.declare': {
        fact.object = 'map';
        const kept = e.returnedVersion === latestDeclared && records.taskMap;
        fact.effect = { kind: 'items', question: kept ? records.taskMap!.question : null, items: kept ? records.taskMap!.items.map(declared) : null };
        break;
      }
      case 'context.read': if (e.contextId) { fact.object = 'question:' + short(e.contextId); fact.effect = { kind: 'fetched', question: fact.object }; } break;
    }
    timed.push({ fact, order: e.cursor });
  }
  // Rho can see a quick script exit before it records the call that started it; the exit
  // still follows that call, at the call's time.
  for (const op of operations) {
    const run = runOf(op.operationId), start = records.activity.filter(e => e.method === 'action.submit' && e.operationId === op.operationId).sort((a, b) => a.cursor - b.cursor)[0];
    if (run === null || !op.exitObservedAt) continue;
    const at = start && start.at > op.exitObservedAt ? start.at : op.exitObservedAt;
    timed.push({ fact: { label: op.operationId, actor: 'operator', op: 'operation.observed', outcome: 'returned', at, object: 'run:' + run, effect: { kind: 'ended', run, exit: op.exit } }, order: start ? start.cursor + 0.5 : -1 });
  }
  // What a person did reaches Rho through the browser, which has no activity record: its
  // edits come from the document histories and its questions from the contexts.
  const agent = (principal: string) => records.principals[principal]?.kind === 'agent';
  for (const d of records.documents) for (const h of d.history) if (!agent(h.author))
    timed.push({ fact: { label: `${d.path} v${h.version}`, actor: h.author, op: 'document.edit', outcome: 'returned', at: h.at, object: 'source:' + d.path, effect: { kind: 'edit', source: d.path, version: h.version } }, order: -1 });
  for (const c of records.contexts) {
    const r = records.resources.find(x => x.id === c.resource.id && x.version === c.resource.version), n = r ? runOf(r.operationId) : null;
    if (!r || n === null) continue;
    const question = 'question:' + short(c.id);
    timed.push({ fact: { label: 'context ' + short(c.id), actor: c.principal, op: 'context.create', outcome: 'returned', at: c.at, object: question, effect: {
      kind: 'ask', question, text: c.text, target: 'artifact:' + r.name, version: short(r.version), run: n, rows: c.rows, document: c.document,
    } }, order: -1 });
  }
  const facts = timed.sort((a, b) => a.fact.at!.localeCompare(b.fact.at!) || a.order - b.order).map(({ fact }, seq) => ({ seq, ...fact }) as Fact);
  return {
    format: 'rho.replay-trace/1',
    recorded: { experiment: records.experiment, project: records.project, from: facts[0]?.at ?? '', to: facts.at(-1)?.at ?? '' },
    facts, principals: { ...records.principals, operator: { kind: 'operator', name: null } }, sources, runs, artifacts,
  };
}
// Which records fact each transcript fact is: per principal, in order, the same operation
// with the same outcome (and refusal kind). -1 where Rho holds no record of the call.
export function align(transcript: Trace, records: Trace): number[] {
  const next = new Map<string, number>();
  return transcript.facts.map(f => {
    const from = next.get(f.actor) ?? 0;
    const i = records.facts.findIndex((r, k) => k >= from && r.actor === f.actor);
    const r = records.facts[i];
    if (!r || r.op !== f.op || r.outcome !== f.outcome || (r.reason?.kind ?? null) !== (f.reason?.kind ?? null)) return -1;
    next.set(f.actor, i + 1);
    return i;
  });
}

// The Agent ledger: what one Agent principal was given, did, read, produced and had
// refused, up to a step. Each entry keeps the fact it came from; an object the records
// do not name is null.
export interface LedgerEntry { seq: number; op: string; object: string | null; version: number | null }
export interface Ledger {
  given: { catalog: LedgerEntry[]; questions: LedgerEntry[] };
  did: LedgerEntry[];
  read: LedgerEntry[];
  produced: { runs: { object: string; seq: number; exit: number | null; ended: boolean; verified: string[] }[]; documents: LedgerEntry[] };
  refused: { kind: string; entries: LedgerEntry[] }[];
}
export function ledger(trace: Trace, step: number, principal: string): Ledger {
  const out: Ledger = { given: { catalog: [], questions: [] }, did: [], read: [], produced: { runs: [], documents: [] }, refused: [] };
  for (const f of trace.facts.slice(0, step + 1)) {
    // How the Agent's runs ended is Rho's observation, whoever made it.
    if (f.effect?.kind === 'ended') { const r = out.produced.runs.find(x => x.object === 'run:' + (f.effect as { run: number }).run); if (r) { r.ended = true; r.exit = f.effect.exit; } }
    if (f.actor !== principal) continue;
    const e = f.effect, entry = (object: string | null, version: number | null = null): LedgerEntry => ({ seq: f.seq, op: f.op, object, version });
    if (f.outcome === 'rejected') {
      const group = out.refused.find(g => g.kind === f.reason!.kind) ?? out.refused[out.refused.push({ kind: f.reason!.kind, entries: [] }) - 1]!;
      group.entries.push(entry(f.object ?? null));
      continue;
    }
    if (!e) continue;
    switch (e.kind) {
      case 'catalog': out.given.catalog.push(entry(null)); break;
      case 'fetched': out.given.questions.push(entry(e.question)); break;
      case 'edit': case 'save': out.did.push(entry('source:' + e.source, e.version)); if (e.kind === 'edit') out.produced.documents.push(entry('source:' + e.source, e.version)); break;
      case 'submit': out.did.push(entry('run:' + e.run)); out.produced.runs.push({ object: 'run:' + e.run, seq: f.seq, exit: null, ended: false, verified: [] }); break;
      case 'retry': out.did.push(entry('run:' + e.run)); break;
      case 'layout': out.did.push(entry('layout')); break;
      case 'items': out.did.push(entry('map')); break;
      case 'open': out.read.push(entry(e.source === null ? null : 'source:' + e.source, e.version)); break;
      case 'read': out.read.push(entry(e.artifact === null ? null : 'artifact:' + e.artifact, e.run)); break;
      case 'observe': case 'output': out.read.push(entry('run:' + e.run)); break;
      case 'ended': out.read.push(entry('run:' + e.run)); break;
      case 'verified': {
        out.read.push(entry('run:' + e.run));
        const r = out.produced.runs.find(x => x.object === 'run:' + e.run);
        if (r) r.verified = [...e.artifacts];
        break;
      }
    }
  }
  return out;
}
