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
    // The transcript ends a run at the Agent's lookup; Rho observed the exit itself, earlier,
    // and the lookup is only a read.
    if (t.effect?.kind === 'ended') {
      assert.equal(r.effect.kind, 'observe', `#${i}`);
      const seen = folded.facts.find(x => x.actor === 'operator' && x.effect.kind === 'ended' && x.effect.run === t.effect.run);
      assert.ok(seen && seen.seq < j && seen.effect.exit === t.effect.exit, `#${i} run ${t.effect.run} exit observed before the lookup`);
      continue;
    }
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
  // Rho also holds a call the transcript never saw (a probe before the run), and its own
  // observation of each run's exit.
  const seen = new Set(at);
  assert.deepEqual(folded.facts.filter(f => !seen.has(f.seq)).map(f => `${f.actor.slice(0, 14)} ${f.op} ${f.object ?? ''}`), [
    'agent:44957f6e capability.index ', 'operator operation.observed run:1', 'operator operation.observed run:2', 'operator operation.observed run:3',
    'operator operation.observed run:4', 'operator operation.observed run:5',
  ]);
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
  // Failed runs escalate with their exit code, the only reason Rho recorded, until a later
  // run of analysis.R completes.
  const working = [{ at: at[19], kind: 'open', target: 'artifact:effects.csv' }];
  assert.deepEqual(express(folded, working, at[44]).escalations.map(x => [x.object, x.reason]), [['run:3', 'Exit 1'], ['run:4', 'Exit 1']]);
  assert.deepEqual(express(folded, working, folded.facts.length - 1).escalations, []);
});

// The second run (docs/INTERACTION-PLAN.md S4): real Claude Code making a failing R check
// pass, recorded with nothing but Rho's own records.
const check = fold(read('check.records.json')), checkAgent = check.facts[0].actor, checkEnd = check.facts.length - 1;

test('a second run, known only from Rho records, keeps to the same rules', () => {
  assert.ok(check.facts.every(f => typeof f.at === 'string'));
  const screen = express(check, [], checkEnd);
  // The run hangs under the script it ran, though the Agent changed another file to make it pass.
  assert.deepEqual(screen.order.map(id => { const o = screen.objects[id]; return o.kind === 'source' ? `${id} v${o.version}` : o.kind === 'run' ? `${id} ${o.state} ${o.source} v${o.sourceVersion}` : id; }), [
    'source:stats.R v2', 'source:check.R v1', 'run:1 completed check.R v1', 'artifact:results.csv',
  ]);
  // check.R was only ever run, so the version Rho knows is the one on disk; stats.R is saved because a save says so.
  assert.deepEqual(['stats.R', 'check.R'].map(n => [screen.objects['source:' + n].version, screen.objects['source:' + n].savedVersion]), [[2, 2], [1, 1]]);
  assert.equal(express(check, [], check.facts.findIndex(f => f.op === 'document.edit')).objects['source:stats.R'].savedVersion, null);
  // The run is complete when Rho saw it exit, before the Agent read its output or looked it up.
  const exit = check.facts.find(f => f.actor === 'operator').seq, lookup = check.facts.findIndex(f => f.op === 'action.lookup');
  assert.ok(exit < check.facts.findIndex(f => f.op === 'action.output') && exit < lookup);
  assert.equal(express(check, [], exit).objects['run:1'].state, 'completed');
  // A follower is moved twice, a pace apart; someone working is not moved at all.
  const moves = screen.moves.filter(m => m.by === 'agent');
  assert.deepEqual(moves.map(m => m.view), ['source:stats.R', 'run:1']);
  assert.ok(Date.parse(check.facts[moves[1].seq].at) - Date.parse(check.facts[moves[0].seq].at) >= 8000);
  const working = express(check, [{ at: 9, kind: 'open', target: 'source:check.R' }], checkEnd);
  assert.deepEqual([working.moves.filter(m => m.by === 'agent').length, working.agent.placement, working.escalations.length], [0, 'marker', 0]);
  // No task map: the Agent never resolved a task.map operation, so it never met the guidance about one.
  assert.deepEqual([screen.items, screen.question, check.facts.some(f => f.op.startsWith('task.map.'))], [[], null, false]);
});

test('a run that exits before Rho records its submit still ends after it', () => {
  // Constructed: the recorded scripts all exited 100–330 ms after the submit was recorded.
  const records = read('check.records.json'), op = records.operations[0];
  const submit = records.activity.find(e => e.method === 'action.submit');
  op.exitObservedAt = new Date(Date.parse(submit.at) - 50).toISOString();
  const quick = fold(records), seq = f => quick.facts.findIndex(f);
  const started = seq(f => f.op === 'action.submit'), ended = seq(f => f.actor === 'operator');
  assert.equal(ended, started + 1);
  assert.equal(quick.facts[ended].at, submit.at);
  assert.equal(express(quick, [], ended).objects['run:1'].state, 'completed');
});

test("the second run's ledger: a few writes, one passing run, two stale catalog reads", () => {
  const l = ledger(check, checkEnd, checkAgent);
  assert.deepEqual(l.did.map(e => e.op + ' ' + e.object + (e.version ? ' v' + e.version : '')), ['document.edit source:stats.R v2', 'document.save source:stats.R v2', 'action.submit run:1']);
  assert.deepEqual(l.read.map(e => e.op + ' ' + e.object), ['document.open null', 'document.open null', 'action.output run:1', 'artifact.check run:1', 'action.lookup run:1']);
  assert.deepEqual(l.produced.runs.map(r => [r.object, r.exit, r.verified]), [['run:1', 0, ['results.csv']]]);
  assert.deepEqual(l.refused.map(g => [g.kind, g.entries.map(e => e.op)]), [['stale', ['capability.resolve', 'capability.resolve']]]);
});
