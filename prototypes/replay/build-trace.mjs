#!/usr/bin/env node
// Turns one recorded Agent run into replay input. Usage, after npm run build:
//   node prototypes/replay/build-trace.mjs [work/agent-exp-2215 | work/agent-check-…]
//
// Always: Rho's own records for that run (activity, document histories, operation
// records, registered resources, contexts, composition, task map, principals), cut to
// what src/trace.ts folds. When the run also kept the Agent's own call log
// (calls.jsonl, the first experiment), a transcript trace as well: every time in it is a
// recorded one, and a call with no recorded time keeps only the bounds of its
// neighbours. Every document version is checked against its recorded digest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fold } from '../../dist/trace.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = path.resolve(process.argv[2] ?? 'work/agent-exp-2215');
const rho = path.join(dir, 'project/.rho');
const out = path.join(here, 'trace');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = text => createHash('sha256').update(text).digest('hex');
const short = digest => digest.slice(0, 8);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

const optional = (file, otherwise) => fs.existsSync(file) ? json(file) : otherwise;
const each = folder => fs.existsSync(folder) ? fs.readdirSync(folder).filter(f => f.endsWith('.json')).map(f => ({ file: f, ...json(path.join(folder, f)) })) : [];
const report = optional(path.join(dir, 'report.json'), null);
const task = report?.task ?? 'airquality';
const calls = fs.existsSync(path.join(dir, 'calls.jsonl')) ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : null;
const events = optional(path.join(rho, 'rho/events.json'), { events: [] }).events;
const resources = optional(path.join(rho, 'plugins/resources.json'), []);
const operations = each(path.join(rho, 'rho/operations'));
const activity = json(path.join(rho, 'rho/activity.json')).entries;
const principals = json(path.join(dir, 'state/principals.json'));
const contexts = each(path.join(rho, 'rho/contexts')).map(c => ({ ...c, id: c.file.replace('.json', '') }));
const documents = Object.fromEntries(each(path.join(rho, 'plugins/documents')).map(d => [d.id, d]));

// Documents: every version's content, from the edit replies, checked against history.
const sources = {};
const docPath = id => documents[id]?.path;
function sourceOf(name) { return sources[name] ??= { versions: { 1: '' }, edited: {}, saved: {} }; }
for (const doc of Object.values(documents)) {
  if (!['analysis.R', 'findings.md', 'questions.md'].includes(doc.path)) continue;
  const s = sourceOf(doc.path);
  s.authors = {};
  for (const h of doc.history) { s.edited[h.version] = { at: h.at, digest: h.afterDigest }; s.authors[h.version] = h.author; }
  for (const r of doc.receipts) if (r.kind === 'save') s.saved[r.version] = r.at;
}
// Every document version is also rebuilt from the recorded edits alone and must reach
// each recorded digest: that is what src/trace.ts folds. questions.md is written by the
// browser, not through the Agent's calls, so this is its only content.
// A document that existed on disk before the run starts from that file: the task's seed,
// accepted only when it reaches the first recorded edit's starting digest.
const questionsDoc = Object.values(documents).find(d => d.path === 'questions.md');
const initial = {};
for (const doc of Object.values(documents)) {
  const seed = path.join(here, 'tasks', task, doc.path);
  // An unedited document's first version is its current content, if that is what disk held.
  const firstDigest = doc.history[0]?.beforeDigest ?? (doc.version === 1 && sha(doc.content) === doc.diskDigest ? doc.diskDigest : null);
  let text = [''].concat(fs.existsSync(seed) ? [fs.readFileSync(seed, 'utf8')] : [], doc.history.length ? [] : [doc.content]).find(t => sha(t) === firstDigest) ?? '';
  if (firstDigest) initial[doc.id] = { text, digest: firstDigest };
  for (const h of doc.history) {
    if (sha(text) !== h.beforeDigest) throw new Error(`${doc.path} before v${h.version} does not match its recorded digest`);
    // A change's edits are offsets into the text before it, so they apply from the end.
    for (const e of [...h.edits].sort((a, b) => b.from - a.from)) text = text.slice(0, e.from) + e.insert + text.slice(e.to);
    if (sha(text) !== h.afterDigest) throw new Error(`${doc.path} v${h.version} does not match its recorded digest`);
    if (doc === questionsDoc) sourceOf(doc.path).versions[h.version] = text;
  }
}

// Principals: the run's Agent is the one principal granted exactly the methods its
// connection lists, and Rho's activity must hold calls from it.
const connection = json(path.join(dir, 'agent-connection.json'));
const granted = principals.filter(p => p.id.startsWith('agent:') && p.methods.length === connection.methods.length && connection.methods.every(m => p.methods.includes(m)));
if (granted.length !== 1 || !activity.some(e => e.principal === granted[0].id)) throw new Error('cannot tell which principal made the run');
const runAgent = granted[0].id;
const bindingName = id => {
  if (id === runAgent) return connection.externalSessionId;
  const file = fs.readdirSync(path.join(dir, 'state')).find(f => f.startsWith(id.replace(':', '-')));
  return file ? json(path.join(dir, 'state', file)).externalSessionId : null;
};

// Rho's own records, cut to what src/trace.ts folds: no image data, no local paths, no
// connection secrets. The replay and the tests fold this instead of calls.jsonl.
const composition = each(path.join(rho, 'rho/compositions'))[0] ?? null;
const taskMap = optional(path.join(rho, 'rho/task-map.json'), null);
const principalIds = new Set([...activity.map(e => e.principal), ...Object.values(documents).flatMap(d => d.history.map(h => h.author)), ...contexts.flatMap(c => [c.principal, c.fetchedBy].filter(Boolean))]);
const records = {
  format: 'rho.owner-records/1',
  experiment: path.basename(dir),
  project: task,
  principals: Object.fromEntries([...principalIds].map(id => [id, { kind: id.split(':')[0], name: bindingName(id) }])),
  activity: activity.map(e => pick(e, ['cursor', 'principal', 'method', 'at', 'outcome', 'errorKind', 'returnedVersion', 'operationId', 'documentId', 'contextId'])),
  documents: Object.values(documents).map(d => ({
    id: d.id, path: d.path, ...(initial[d.id]?.text ? { initial: initial[d.id].text } : {}), ...(initial[d.id] ? { initialDigest: initial[d.id].digest } : {}),
    history: d.history.map(h => ({ version: h.version, at: h.at, author: h.author, afterDigest: h.afterDigest, edits: h.edits.map(e => pick(e, ['from', 'to', 'insert'])) })),
    receipts: d.receipts.map(r => pick(r, ['kind', 'version', 'at', 'author'])),
  })),
  operations: operations.map(o => {
    const execution = o.native.record.execution.Known;
    return {
      operationId: o.operationId, principal: o.principal, acceptedAt: o.acceptedAt,
      script: { path: o.request.input.script.path, digest: o.request.input.script.digest }, declared: o.request.input.artifacts.map(a => a.path),
      exit: execution?.value?.ExitObserved?.exit?.Code ?? null, exitObservedAt: execution?.value?.ExitObserved ? execution.observed_at : null,
    };
  }),
  // Small tables keep their bytes, so a trace folded from records alone can show them.
  resources: resources.map(r => ({ id: r.id, name: path.basename(r.path), version: r.version, kind: r.kind, bytes: r.bytes, operationId: r.provenance.operationId,
    ...(r.kind === 'table' && r.bytes <= 65536 ? { text: fs.readFileSync(path.join(rho, '..', r.path), 'utf8') } : {}) })),
  contexts: contexts.map(c => {
    const key = c.resource.metadata.format?.key?.column;
    return {
      id: c.id, principal: c.principal, at: c.at, changeId: c.changeId, text: c.document.text,
      document: { source: c.document.source.path, version: c.document.source.version },
      resource: { id: c.resource.reference.id, version: c.resource.reference.version },
      rows: key && c.resource.rows ? c.resource.rows.map(row => String(row[key])) : [],
      fetchedBy: c.fetchedBy ?? null, fetchedAt: c.fetchedAt ?? null,
    };
  }),
  composition: composition && { history: composition.history.map(h => ({ version: h.version, views: h.snapshot.nodes.filter(n => n.kind === 'view' && n.bindings?.data?.version).map(n => ({ id: n.bindings.data.id, version: n.bindings.data.version })) })) },
  taskMap: taskMap && {
    question: taskMap.question,
    items: taskMap.items.map(item => pick(item, ['id', 'kind', 'state', 'title', 'summary', 'artifact', 'view', 'from', 'lines', 'author'])),
    declared: taskMap.receipts.filter(r => r.kind === 'declare').map(r => pick(r, ['version', 'at', 'author'])),
  },
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, calls ? 'records.json' : task + '.records.json'), JSON.stringify(records, null, 1) + '\n');
if (!calls) {
  console.log(`${records.activity.length} activity entries, ${records.operations.length} runs → ${path.relative(process.cwd(), out)}/${task}.records.json`);
  process.exit(0);
}

const reply = c => { try { return JSON.parse(c.text); } catch { return null; } };
const resourceById = id => {
  const r = resources.find(x => x.id === id);
  return r && { name: path.basename(r.path), operationId: r.provenance.operationId, digest: r.version, kind: r.kind };
};
const runNumber = operationId => Number(operationId.split('-').pop());
// A declared item keeps only what the Agent wrote, and an artifact reference resolves to
// the exact resource it names: that file, those bytes, that run.
const declared = (item, author) => {
  const r = item.artifact && resources.find(x => x.id === item.artifact.id && x.version === item.artifact.version);
  return pick({ ...item, author, artifact: r ? { object: 'artifact:' + path.basename(r.path), version: short(r.version), run: runNumber(r.provenance.operationId) } : undefined }, ['id', 'kind', 'state', 'title', 'summary', 'artifact', 'view', 'from', 'lines', 'author']);
};
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
  const fact = { seq, label: call.label, actor: runAgent, op: '', outcome: ok ? 'returned' : 'rejected', at: null };
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
        fact.effect = { kind: 'items', question: input.question, items: input.items.map(item => declared(item, runAgent)) };
      }
      break;
    }
    default: throw new Error('Unmapped operation ' + op);
  }
  facts.push(fact);
});



// After the run, the trace continues with what Rho's records hold and the transcript
// cannot: the acceptance script's Agent redeclaring the task map, the person's questions
// (each written into questions.md first) and their receipt. They come from the same
// fold the ledger uses (src/trace.ts; run `npm run build` first).
const lastCall = facts.findLast(f => f.at).at;
for (const fact of fold(records).facts.filter(f => f.actor !== runAgent && f.at > lastCall)) facts.push({ ...fact, seq: facts.length });

// Calls with no recorded time keep the recorded times on either side.
facts.forEach((fact, i) => {
  if (fact.at) return;
  fact.after = facts.slice(0, i).findLast(f => f.at)?.at ?? null;
  fact.before = facts.slice(i + 1).find(f => f.at)?.at ?? null;
});

// Artifacts: one entry per file name, one version per distinct content.
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
  principals: Object.fromEntries([...new Set(facts.map(f => f.actor))].map(id => [id, { kind: id.split(':')[0], name: bindingName(id) }])),
  sources: Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, { versions: s.versions, edited: Object.fromEntries(Object.entries(s.edited).map(([k, e]) => [k, e.at])), saved: s.saved, authors: s.authors ?? {} }])),
  runs,
  artifacts,
};
fs.writeFileSync(path.join(out, 'airquality.json'), JSON.stringify(trace, null, 1) + '\n');

console.log(`${facts.length} facts, ${Object.keys(runs).length} runs, ${Object.keys(artifacts).length} artifacts; ${records.activity.length} activity entries → ${path.relative(process.cwd(), out)}`);
