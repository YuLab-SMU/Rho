import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attention, distinctScripts, executionWord, integrityWord, producerOf, readRuns, results,
  sameSourceKey, shortPath, stopState, exitWords
} from '../dist/execution-facts.js';

// These are Rho's reading of what was run and produced. They decide what the project
// page and the view chrome say, so the distinctions they keep are checked here one by
// one: declared vs present vs verified, the Agent's account vs observed execution, and
// one version vs another of the same file name.
const run = (over = {}) => ({
  operationId: 'temp-1', action: 'r.execute', execution: 'completed', delivery: 'answered',
  acceptedAt: '2026-10-24T10:00:00.000Z', author: 'Agent',
  declared: [], missing: [], completion: 'present', integrity: 'verified', domain: 'unchecked',
  script: 'a'.repeat(64), sourceKey: 'k1', hasStderr: false, ...over
});
const file = (path, present = true, bytes = 10) => ({ path, present, bytes });
const resource = (id, path, version, operationId) => ({ id, path, version, kind: 'table', bytes: 1, availability: 'available', projectId: 'p', owner: 'files', coverage: {}, provenance: { operationId } });

test('a failed run can have every file on disk and still be unverified', () => {
  const failed = run({ execution: 'failed', integrity: 'unchecked', completion: 'absent', declared: [file('a.csv'), file('b.csv', false, 0)], missing: ['b.csv'] });
  const summary = readRuns([failed]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.completed, 0);
  // Integrity is the run's own recorded state: presence never upgrades it.
  assert.equal(integrityWord(failed.integrity), 'not checked');
  assert.equal(failed.declared.filter(entry => entry.present).length, 1);
});

test('what needs attention names the failure and what is on disk', () => {
  const failed = run({ execution: 'failed', integrity: 'unchecked', declared: [file('a.csv'), file('b.csv')] });
  const wanted = attention([failed]);
  assert.equal(wanted.length, 1);
  assert.equal(wanted[0].kind, 'failed');
  assert.match(wanted[0].text, /2 of 2 declared files are on disk and nothing verified them/);
});

test('a completed run whose bytes were never checked is still worth naming', () => {
  const unchecked = run({ operationId: 'temp-9', integrity: 'unchecked', declared: [file('a.csv')] });
  const wanted = attention([unchecked]);
  assert.equal(wanted.length, 1);
  assert.equal(wanted[0].kind, 'unverified');
});

test('a verified run needs no attention', () => {
  assert.deepEqual(attention([run({ declared: [file('a.csv')] })]), []);
});

// H0 audit P0-2: a run Core never observed executing, or one still running, wrote
// nothing yet; the overview said it "wrote 4 declared files that nothing verified".
test('only a completed run is said to have written its files, counted as found', () => {
  const declared = [file('a.csv', false, 0), file('b.csv', false, 0), file('c.png', false, 0), file('d.csv', false, 0)];
  for (const execution of ['unobserved', 'active', 'unknown']) {
    const items = attention([run({ execution, integrity: 'unchecked', completion: 'absent', declared, missing: declared.map(f => f.path) })]);
    assert.ok(items.every(item => item.kind !== 'unverified'), execution + ' wrote nothing yet');
  }
  const partial = attention([run({ integrity: 'unchecked', declared: [file('a.csv'), file('b.csv', false, 0)] })]);
  assert.equal(partial.length, 1);
  assert.match(partial[0].text, /wrote 1 declared file that nothing verified/);
  assert.deepEqual(attention([run({ integrity: 'unchecked', declared: [file('a.csv', false, 0)] })]), [], 'nothing on disk, nothing to verify');
  const counts = readRuns([run({ execution: 'unobserved' }), run({ execution: 'active' })]);
  assert.equal(counts.moving, 1, 'accepted but unobserved is not running');
  assert.equal(counts.unobserved, 1);
});

test('an outcome with no observation is reported as unknown, never as done', () => {
  assert.equal(executionWord('unknown'), 'outcome unknown');
  assert.equal(executionWord('unobserved'), 'accepted, not observed');
  assert.equal(readRuns([run({ execution: 'unknown' })]).unknown, 1);
  assert.equal(attention([run({ execution: 'unknown', declared: [] })])[0].kind, 'unknown');
});

test('submissions of one file form a chain even when the code changed', () => {
  const runs = [
    run({ operationId: 'a', sourceKey: 'k1', script: 'a'.repeat(64) }),
    run({ operationId: 'b', sourceKey: 'k1', script: 'b'.repeat(64), execution: 'failed' }),
    run({ operationId: 'c', sourceKey: 'k2', script: 'c'.repeat(64) })
  ];
  const chain = sameSourceKey(runs, 'k1');
  assert.deepEqual(chain.map(entry => entry.operationId), ['a', 'b']);
  assert.equal(distinctScripts(chain), 2, 'the edited retry ran different code');
  assert.deepEqual(sameSourceKey(runs, null), [], 'an unnamed source has no chain');
});

test('the artifact names the run that produced it, and only that run', () => {
  const runs = [run({ operationId: 'temp-5' }), run({ operationId: 'temp-4', execution: 'failed' })];
  assert.equal(producerOf(resource('r1', 'x/effects.csv', 'v1', 'temp-5'), runs)?.operationId, 'temp-5');
  assert.equal(producerOf(resource('r2', 'x/effects.csv', 'v2', 'temp-4'), runs)?.operationId, 'temp-4');
  assert.equal(producerOf(resource('r3', 'x/effects.csv', 'v3', 'absent'), runs), undefined);
  assert.equal(producerOf({ ...resource('r4', 'x', 'v', 'x'), provenance: {} }, runs), undefined);
});

test('one row per artifact name, newest submission first, earlier versions counted', () => {
  const runs = [
    run({ operationId: 'temp-1', acceptedAt: '2026-10-24T10:38:00.000Z' }),
    run({ operationId: 'temp-5', acceptedAt: '2026-10-24T10:46:00.000Z' })
  ];
  const rows = results([
    resource('a', '.rho/runs/old/artifacts/effects.csv', 'v-old', 'temp-1'),
    resource('b', '.rho/runs/new/artifacts/effects.csv', 'v-new', 'temp-5'),
    resource('c', '.rho/runs/new/artifacts/temp-effect.png', 'p1', 'temp-5')
  ], runs);
  const effects = rows.find(row => shortPath(row.resource.path) === 'effects.csv');
  // The newest producing run wins, and the other version is counted rather than hidden.
  assert.equal(effects.resource.id, 'b');
  assert.equal(effects.run.operationId, 'temp-5');
  assert.equal(effects.earlier, 1);
  assert.deepEqual(rows.map(row => shortPath(row.resource.path)), ['effects.csv', 'temp-effect.png']);
});

test('versions are separate identities and never collapse by path', () => {
  // Two different versions from the same run: one row, but the version that is shown
  // is a real registered version, not a merged one.
  const rows = results([
    resource('a', 'x/effects.csv', 'v1', 'temp-5'),
    resource('b', 'x/effects.csv', 'v2', 'temp-5')
  ], [run({ operationId: 'temp-5' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].earlier, 1);
  assert.ok(['v1', 'v2'].includes(rows[0].resource.version));
});

test('a path is named the way a reader says it', () => {
  assert.equal(shortPath('.rho/plugins/runs/ab/artifacts/effects.csv'), 'effects.csv');
  assert.equal(shortPath('C:\\work\\atlas\\effects.csv'), 'effects.csv');
});

test('a stop request is not a stop: only an ended process is stopped', () => {
  const at = '2026-10-24T00:00:00Z';
  assert.equal(stopState({ Running: {} }, null), 'requested');
  assert.equal(stopState({ Starting: {} }, {}), 'requested');
  assert.equal(stopState({ Running: {} }, { term_sent_at: at }), 'signalled');
  assert.equal(stopState({ Running: {} }, { term_sent_at: at, kill_sent_at: at }), 'signalled');
  assert.equal(stopState({ Finished: { exit: { Signal: 15 } } }, { term_sent_at: at }), 'stopped');
  assert.equal(stopState({ Finished: { exit: { Code: 1 } } }, { term_sent_at: at }), 'stopped');
  assert.equal(stopState({ Finished: { exit: 'Unknown' } }, { kill_sent_at: at }), 'stopped');
  assert.equal(stopState({ NotStarted: {} }, null), 'stopped');
  // Ended on its own before any signal: it finished first, success or not.
  assert.equal(stopState({ Finished: { exit: { Code: 0 } } }, { term_sent_at: at }), 'finished-first');
  assert.equal(stopState({ Finished: { exit: { Code: 1 } } }, null), 'finished-first');
  // Core no longer knows the process: nothing is claimed.
  assert.equal(stopState({ Gone: {} }, { term_sent_at: at }), 'unconfirmed');
  assert.equal(stopState({ Detached: {} }, null), 'unconfirmed');
  // No current answer from Core: a stored "running" is not evidence either way.
  assert.equal(stopState({ Running: {} }, { term_sent_at: at }, false), 'unconfirmed');
  assert.equal(stopState({ Finished: { exit: { Signal: 15 } } }, { term_sent_at: at }, false), 'stopped');
  assert.deepEqual([exitWords({ Signal: 15 }), exitWords({ Code: 2 }), exitWords('Unknown'), exitWords(undefined)], ['signal 15', 'code 2', 'unknown', null]);
});
