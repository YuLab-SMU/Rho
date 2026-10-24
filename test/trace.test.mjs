import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { express } from '../dist/expression.js';
import { align, fold, ledger } from '../dist/trace.js';

// The same recorded run seen two ways: the Agent's transcript (calls.jsonl plus owner
// records, prototypes/replay/trace/airquality.json) and Rho's own records alone
// (records.json, folded by src/trace.ts). docs/INTERACTION-PLAN.md S2.
const read = name => JSON.parse(fs.readFileSync(new URL('../prototypes/replay/trace/' + name, import.meta.url), 'utf8'));
const transcript = read('airquality.json'), records = read('records.json');
const folded = fold(records), at = align(transcript, folded);
const runAgent = transcript.facts[0].actor;

test("Rho's records fold into the transcript's facts wherever both hold one, and every folded fact has a recorded time", () => {
  assert.ok(folded.facts.every(f => typeof f.at === 'string'));
  assert.ok(folded.facts.every((f, i) => i === 0 || folded.facts[i - 1].at <= f.at));
  for (const [i, j] of at.entries()) {
    if (j < 0) continue;
    const t = transcript.facts[i], r = folded.facts[j];
    // An owner record never postdates the call record that returned it.
    if (t.at) assert.ok(t.at <= r.at, `#${i} owner time ${t.at} after call record ${r.at}`);
    if (t.outcome === 'rejected') continue;
    // Same effect, except identities Rho does not record, which stay null rather than guessed.
    assert.equal(r.effect?.kind, t.effect?.kind, `#${i}`);
    for (const [key, value] of Object.entries(r.effect ?? {})) if (value !== null) assert.deepEqual(value, t.effect[key], `#${i} ${key}`);
  }
  const unrecorded = at.flatMap((j, i) => j < 0 ? [] : Object.entries(folded.facts[j].effect ?? {}).filter(([, v]) => v === null).map(([k]) => `${transcript.facts[i].op} ${k}`));
  assert.deepEqual([...new Set(unrecorded)], ['document.open source', 'data.page artifact', 'data.page run', 'action.output stream', 'task.map.declare question', 'task.map.declare items']);
  // Runs, their source versions and verified bytes come out of the records whole.
  assert.deepEqual(Object.values(folded.runs).map(r => [r.sourceVersion, r.exit, r.verified?.length ?? 0]), [[2, 0, 4], [4, 0, 4], [5, 1, 0], [6, 1, 0], [9, 0, 4]]);
  const versions = trace => Object.fromEntries(Object.entries(trace.artifacts).map(([name, a]) => [name, Object.entries(a.versions).map(([digest, v]) => [digest, v.runs])]));
  assert.deepEqual(versions(folded), versions(transcript));
});

test("Rho's records hold 3 of the transcript's 7 refusals; the 4 the agent adapter refused never reached Rho", () => {
  const refused = trace => trace.facts.filter(f => f.actor === runAgent && f.outcome === 'rejected').map(f => f.reason.kind);
  assert.deepEqual(refused(transcript), ['stale', 'invalid', 'invalid', 'invalid', 'condition', 'stale', 'condition']);
  assert.deepEqual(refused(folded), ['stale', 'condition', 'stale']);
  assert.deepEqual(at.flatMap((j, i) => j < 0 ? [`#${i} ${transcript.facts[i].reason?.kind}`] : []), ['#20 invalid', '#21 invalid', '#25 invalid', '#38 condition']);
  // Rho also holds a call the transcript never saw: a probe before the run.
  const seen = new Set(at);
  assert.deepEqual(folded.facts.filter(f => !seen.has(f.seq)).map(f => `${f.actor.slice(0, 14)} ${f.op} ${f.outcome} ${f.at.slice(11, 19)}`), ['agent:44957f6e capability.index rejected 14:33:03']);
});

test('the ledger at #44 says what the Agent was given, did, read, produced and had refused, and names nothing the records do not', () => {
  const l = ledger(folded, at[44], runAgent);
  assert.equal(l.given.catalog.length, 12);
  assert.deepEqual(l.given.questions, []);
  assert.deepEqual(l.did.map(e => e.op + ' ' + e.object + (e.version ? ' v' + e.version : '')), [
    'document.edit source:analysis.R v2', 'document.save source:analysis.R v2', 'action.submit run:1', 'action.submit run:1',
    'document.edit source:analysis.R v3', 'document.edit source:analysis.R v4', 'document.save source:analysis.R v4', 'action.submit run:2',
    'document.edit source:analysis.R v5', 'document.save source:analysis.R v5', 'action.submit run:3',
    'document.edit source:analysis.R v6', 'document.save source:analysis.R v6', 'action.submit run:4',
  ]);
  // What it opened and which table pages it read are not recorded: null, never a guess.
  assert.deepEqual(l.read.filter(e => e.object === null).map(e => e.op), ['document.open', 'data.page', 'data.page']);
  assert.deepEqual(l.produced.runs.map(r => [r.object, r.ended ? r.exit : 'running', r.verified.length]), [['run:1', 0, 4], ['run:2', 0, 4], ['run:3', 1, 0], ['run:4', 1, 0]]);
  assert.deepEqual(l.refused.map(g => [g.kind, g.entries.map(e => e.op + (e.object ? ' ' + e.object : ''))]), [
    ['stale', ['capability.resolve', 'document.edit source:analysis.R']], ['condition', ['artifact.check run:3']],
  ]);
});

test('the screen folded from Rho records never shows an object it cannot name', () => {
  const screen = express(folded, [], folded.facts.length - 1), full = express(transcript, [], transcript.facts.length - 1);
  assert.ok(Object.keys(screen.objects).every(id => id in full.objects), 'no object the transcript lacks');
  assert.ok(screen.views.every(v => v.object in screen.objects));
  // The run's own declarations are not retained; the map Rho holds is the acceptance script's.
  assert.equal(screen.question, records.taskMap.question);
  assert.equal(screen.items.length, records.taskMap.items.length);
  // Failed runs escalate with their exit code, the only reason Rho recorded.
  const working = [{ at: at[19], kind: 'open', target: 'artifact:effects.csv' }];
  assert.deepEqual(express(folded, working, folded.facts.length - 1).escalations.map(x => [x.object, x.reason]), [['run:3', 'Exit 1'], ['run:4', 'Exit 1']]);
});
