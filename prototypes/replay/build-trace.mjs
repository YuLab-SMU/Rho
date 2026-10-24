#!/usr/bin/env node
// Turns one recorded Agent run into the replay trace. Usage:
//   node prototypes/replay/build-trace.mjs [work/agent-exp-2215]
//
// Inputs are what that run left behind: the Agent's own call log (calls.jsonl), and
// the project's owner state (event stream, document histories, operation records,
// registered resources, run outputs). Every time in the trace is one of those
// recorded times; a call with no recorded time keeps only the bounds of its
// neighbours. Every document version is checked against its recorded digest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = path.resolve(process.argv[2] ?? 'work/agent-exp-2215');
const rho = path.join(dir, 'project/.rho');
const out = path.join(here, 'trace');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const short = digest => digest.slice(0, 8);

const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const events = json(path.join(rho, 'rho/events.json')).events;
const resources = json(path.join(rho, 'plugins/resources.json'));
const operations = fs.readdirSync(path.join(rho, 'rho/operations')).map(f => json(path.join(rho, 'rho/operations', f)));
const documents = Object.fromEntries(fs.readdirSync(path.join(rho, 'plugins/documents')).map(f => json(path.join(rho, 'plugins/documents', f))).map(d => [d.id, d]));

// Documents: every version's content, from the edit replies, checked against history.
const sources = {};
const docPath = id => documents[id]?.path;
function sourceOf(name) { return sources[name] ??= { versions: { 1: '' }, edited: {}, saved: {} }; }
for (const doc of Object.values(documents)) {
  if (!['analysis.R', 'findings.md'].includes(doc.path)) continue;
  const s = sourceOf(doc.path);
  for (const h of doc.history) s.edited[h.version] = { at: h.at, digest: h.afterDigest };
  for (const r of doc.receipts) if (r.kind === 'save') s.saved[r.version] = r.at;
}

const reply = c => { try { return JSON.parse(c.text); } catch { return null; } };
const resourceById = id => {
  const r = resources.find(x => x.id === id);
  return r && { name: path.basename(r.path), operationId: r.provenance.operationId, digest: r.version, kind: r.kind };
};
const runNumber = operationId => Number(operationId.split('-').pop());
const opRecord = id => operations.find(o => o.operationId === id);
const observedAt = id => events.find(e => e.type === 'operation.observed' && e.subject === id)?.at ?? null;

const facts = [];
const runs = {};
const seenRuns = new Set();
let compositionEvents = events.filter(e => e.type === 'composition.changed' && e.at < '2026-10-24T15:00');
let mapEvents = events.filter(e => e.type === 'task.map.changed' && e.at < '2026-10-24T15:00');

calls.forEach((call, seq) => {
  const value = reply(call);
  const ok = value?.ok === true && !call.isError;
  const fact = { seq, label: call.label, actor: 'agent', op: '', outcome: ok ? 'returned' : 'rejected', at: null };
  if (!ok) fact.reason = { kind: value?.error?.kind ?? 'error', message: value?.error?.message ?? '' };
  if (call.name !== 'rho_call') {
    fact.op = call.name === 'rho_index' ? 'capability.index' : 'capability.resolve';
    fact.effect = { kind: 'catalog' };
    return facts.push(fact);
  }
  const op = call.args.operation, input = call.args.input ?? {};
  fact.op = op;
  const v = value?.value;
  switch (op) {
    case 'document.open': {
      fact.object = 'source:' + input.path;
      if (ok) { fact.at = v.acknowledgedAt; fact.effect = { kind: 'open', source: input.path, version: v.version }; }
      break;
    }
    case 'document.edit': {
      const name = docPath(input.documentId);
      fact.object = 'source:' + name;
      if (ok) {
        const s = sourceOf(name), recorded = s.edited[v.version];
        if (!recorded || sha(v.content) !== recorded.digest) throw new Error(`${name} v${v.version} does not match its recorded digest`);
        s.versions[v.version] = v.content;
        fact.at = recorded.at;
        fact.effect = { kind: 'edit', source: name, version: v.version };
      }
      break;
    }
    case 'document.save': {
      const name = docPath(input.documentId);
      fact.object = 'source:' + name;
      if (ok) { fact.at = sourceOf(name).saved[v.version]; fact.effect = { kind: 'save', source: name, version: v.version }; }
      break;
    }
    case 'action.submit': {
      const id = input.operationId, n = runNumber(id);
      fact.object = 'run:' + n;
      if (!ok) break;
      if (seenRuns.has(id)) { fact.effect = { kind: 'retry', run: n }; break; }
      seenRuns.add(id);
      const record = opRecord(id), native = record.native.record;
      const script = input.input.script;
      const version = Number(Object.entries(sourceOf(script.path).edited).find(([, e]) => e.digest === script.digest)?.[0]);
      if (!version) throw new Error(`run ${n}: script digest matches no recorded version`);
      const exit = native.execution.Known.value.ExitObserved?.exit?.Code ?? null;
      runs[n] = { operationId: id, source: script.path, sourceVersion: version, declared: input.input.artifacts.map(a => a.path), acceptedAt: native.accepted_at, exit, observedAt: observedAt(id), outputs: {} };
      fact.at = native.accepted_at;
      fact.effect = { kind: 'submit', run: n, source: script.path, sourceVersion: version };
      break;
    }
    case 'action.lookup': {
      const n = runNumber(input.operationId);
      fact.object = 'run:' + n;
      if (ok && runs[n] && !runs[n].ended) {
        runs[n].ended = true;
        fact.at = runs[n].observedAt;
        fact.effect = { kind: 'ended', run: n, exit: runs[n].exit };
      } else if (ok) fact.effect = { kind: 'observe', run: n };
      break;
    }
    case 'action.output': {
      const n = runNumber(input.operationId), stream = input.stream;
      fact.object = 'run:' + n;
      if (ok) {
        const text = v.reply.value.text;
        runs[n].outputs[stream] = text;
        fact.effect = { kind: 'output', run: n, stream };
      }
      break;
    }
    case 'artifact.check': {
      const n = runNumber(input.operationId);
      fact.object = 'run:' + n;
      if (ok) {
        const found = v.resources.map(r => ({ name: path.basename(r.path), digest: short(r.version), kind: r.kind }));
        runs[n].verified = found;
        fact.effect = { kind: 'verified', run: n, artifacts: found.map(f => f.name) };
      }
      break;
    }
    case 'data.page': {
      const r = resourceById(input.resource.id);
      fact.object = 'artifact:' + r.name;
      fact.effect = { kind: 'read', artifact: r.name, run: runNumber(r.operationId) };
      break;
    }
    case 'composition.apply': {
      fact.object = 'layout';
      const views = input.operations.flatMap(o => o.nodes ?? []).filter(n => n.kind === 'view').map(n => {
        const r = resourceById(n.bindings.data.id);
        return { artifact: r.name, run: runNumber(r.operationId) };
      });
      if (ok) { fact.at = compositionEvents.shift()?.at ?? null; fact.effect = { kind: 'layout', replace: input.operations.some(o => o.op === 'replace'), views }; }
      break;
    }
    case 'task.map.declare': {
      fact.object = 'map';
      if (ok) {
        fact.at = mapEvents.shift()?.at ?? null;
        fact.effect = { kind: 'items', question: input.question, items: input.items.map(({ id, kind, state, title, summary }) => ({ id, kind, state, title, summary })), vocabulary: input.vocabulary ?? null };
      }
      break;
    }
    default: throw new Error('Unmapped operation ' + op);
  }
  facts.push(fact);
});

// Calls with no recorded time keep the recorded times on either side.
facts.forEach((fact, i) => {
  if (fact.at) return;
  fact.after = facts.slice(0, i).findLast(f => f.at)?.at ?? null;
  fact.before = facts.slice(i + 1).find(f => f.at)?.at ?? null;
});

// Artifacts: one entry per file name, one version per distinct content.
fs.mkdirSync(out, { recursive: true });
const artifacts = {};
for (const r of resources) {
  const name = path.basename(r.path), n = runNumber(r.provenance.operationId);
  const a = artifacts[name] ??= { kind: r.kind, versions: {} };
  const key = short(r.version);
  const version = a.versions[key] ??= { runs: [], bytes: r.bytes };
  version.runs.push(n);
  const file = path.join(rho, '..', r.path);
  if (r.kind === 'table') version.text ??= fs.readFileSync(file, 'utf8');
  else if (n === 5) { version.file = 'temp-effect.run-5.png'; fs.copyFileSync(file, path.join(out, version.file)); }
}
for (const a of Object.values(artifacts)) for (const v of Object.values(a.versions)) v.runs.sort((x, y) => x - y);

const trace = {
  format: 'rho.replay-trace/1',
  recorded: { experiment: path.basename(dir), project: 'airquality', from: facts.find(f => f.at).at, to: facts.findLast(f => f.at).at },
  facts,
  sources: Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, { versions: s.versions, edited: Object.fromEntries(Object.entries(s.edited).map(([k, e]) => [k, e.at])), saved: s.saved }])),
  runs,
  artifacts,
};
fs.writeFileSync(path.join(out, 'airquality.json'), JSON.stringify(trace, null, 1) + '\n');
console.log(`${facts.length} facts, ${Object.keys(runs).length} runs, ${Object.keys(artifacts).length} artifacts → ${path.relative(process.cwd(), out)}`);
