import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { agentPaceMs, express, timeOf } from '../dist/expression.js';
import { taskMapLimits } from '../dist/task-map.js';

// The expression rules replayed over one recorded Agent run (agent-exp-2215: 61 calls,
// five R runs, two of them failing). Each test is one sentence of
// docs/INTERACTION-MODEL.md that the replay prototype has to make true.
const trace = JSON.parse(fs.readFileSync(new URL('../prototypes/replay/trace/airquality.json', import.meta.url), 'utf8'));
const last = trace.facts.length - 1;
const agentMoves = screen => screen.moves.filter(m => m.by === 'agent');
const working = [{ at: 19, kind: 'open', target: 'artifact:effects.csv' }, { at: 19, kind: 'select', target: 'artifact:effects.csv', rows: ['B', 'C'] }];

test('one pace protects attention everywhere: the task map interval and the main area are the same value', () => {
  assert.equal(agentPaceMs, taskMapLimits.agentFormIntervalMs);
});

test('a follower sees the Agent work object by object, at most once per pace window', () => {
  const screen = express(trace, [], last);
  assert.deepEqual(agentMoves(screen).map(m => m.view), [
    'source:analysis.R', 'run:1', 'artifact:effects.csv', 'source:analysis.R', 'run:2', 'source:analysis.R', 'run:3',
    'source:analysis.R', 'run:4', 'source:analysis.R', 'run:5', 'artifact:temp-effect.png', 'source:findings.md',
  ]);
  // tests.csv was read within the same recorded second as effects.csv: merged, never shown.
  assert.ok(!express(trace, [], 18).views.some(v => v.id === 'artifact:tests.csv'));
  const times = agentMoves(screen).map(m => Date.parse(timeOf(trace.facts[m.seq])));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= agentPaceMs, `move ${i} came ${times[i] - times[i - 1]} ms after the previous one`);
});

test("the Agent's focus uses one preview view; the tabs do not pile up behind it", () => {
  assert.deepEqual(express(trace, [], 36).views.map(v => [v.id, v.preview]), [['run:3', true]]);
  // What the person opened stays where it is; only the preview slot moves.
  const screen = express(trace, [{ at: 12, kind: 'open', target: 'run:1' }, { at: 12, kind: 'follow' }], 36);
  assert.deepEqual(screen.views.map(v => [v.id, v.preview]), [['run:1', false], ['run:3', true]]);
});

test('while the person works, the Agent never moves the main area; its layout becomes one suggestion', () => {
  const screen = express(trace, working, last);
  assert.ok(agentMoves(screen).every(m => m.seq < 19));
  assert.equal(screen.active, 'artifact:effects.csv');
  assert.deepEqual(screen.views.find(v => v.id === 'artifact:effects.csv').selection, ['B', 'C']);
  assert.equal(screen.agent.placement, 'marker');
  assert.equal(screen.agent.object, 'source:findings.md');
  assert.deepEqual(screen.suggestions.map(x => [x.cause, x.views.map(v => v.artifact + '@' + v.run)]), [['working', ['temp-effect.png@5', 'effects.csv@5']]]);
});

test('a failed run the person is waiting on escalates with its own error; a follower or an absent person gets none', () => {
  const screen = express(trace, working, last);
  assert.deepEqual(screen.escalations.map(x => [x.object, x.reason.slice(0, 22)]), [['run:3', "Error: unexpected ')' "], ['run:4', "Error: object 'op' not"]]);
  assert.deepEqual(express(trace, [], last).escalations, []);
  assert.deepEqual(express(trace, [{ at: 29, kind: 'leave' }], last).escalations, []);
  // Opening the run is how the person answers it.
  assert.deepEqual(express(trace, [...working, { at: 45, kind: 'open', target: 'run:3' }], last).escalations.map(x => x.object), ['run:4']);
});

test('coming back gives a digest by object and the main area is where the person left it', () => {
  const left = express(trace, [], 29);
  const screen = express(trace, [{ at: 29, kind: 'leave' }, { at: 57, kind: 'return' }], 57);
  assert.equal(screen.active, left.active);
  assert.deepEqual(screen.views.map(v => v.id), left.views.map(v => v.id));
  assert.deepEqual(screen.digest.lines.map(l => l.kind === 'source' ? `${l.object} ${l.from}→${l.to}` : l.kind === 'run' ? `${l.object} ${l.state} ${l.verified}` : l.kind === 'artifact' ? `${l.object} +${l.versions}` : `${l.kind} ${l.id ?? l.count}`), [
    'source:analysis.R 5→9', 'source:findings.md null→2', 'run:3 failed 0', 'run:4 failed 0', 'run:5 completed 4', 'artifact:temp-effect.png +1', 'suggestion layout:54',
  ]);
  assert.equal(screen.attention, 'following');
});

test('a rejected call changes nothing on screen and is counted on its object', () => {
  const before = express(trace, [], 19), after = express(trace, [], 21);
  assert.equal(trace.facts[20].outcome, 'rejected');
  assert.equal(trace.facts[21].outcome, 'rejected');
  assert.deepEqual([after.active, after.views, after.agent.object], [before.active, before.views, before.agent.object]);
  assert.equal(after.objects['source:analysis.R'].version, before.objects['source:analysis.R'].version);
  assert.equal(after.objects['source:analysis.R'].hidden, before.objects['source:analysis.R'].hidden + 2);
});

test('runs and artifact versions are linked by facts: same bytes share a version, a new figure is a new one', () => {
  const screen = express(trace, [], last);
  assert.deepEqual([3, 4, 5].map(n => [screen.objects['run:' + n].sourceVersion, screen.objects['run:' + n].state]), [[5, 'failed'], [6, 'failed'], [9, 'completed']]);
  assert.deepEqual(screen.objects['artifact:effects.csv'].versions.map(v => v.runs), [[1, 2, 5]]);
  assert.deepEqual(screen.objects['artifact:temp-effect.png'].versions.map(v => v.runs), [[1], [2], [5]]);
});

test('an Agent replace never closes what the person opened or pinned', () => {
  const screen = express(trace, [{ at: 19, kind: 'open', target: 'run:1' }, { at: 19, kind: 'pin', target: 'run:1' }, { at: 19, kind: 'follow' }], last);
  assert.ok(screen.views.some(v => v.id === 'run:1' && v.pinned));
  assert.ok(screen.views.some(v => v.id === 'artifact:temp-effect.png' && v.run === 5));
  // A pinned view keeps its version even when the Agent shows a newer one elsewhere.
  assert.equal(screen.views.find(v => v.id === 'run:1').run, null);
});

test('the Agent declares its items at the end, and they stay its account, unlinked to objects', () => {
  assert.equal(express(trace, [], 58).question, null);
  const screen = express(trace, [], last);
  assert.equal(screen.items.length, 5);
  assert.match(screen.question, /wind and sunlight/);
  assert.deepEqual(Object.keys(screen.objects), Object.keys(express(trace, [], 58).objects));
});

test('the same facts and actions always give the same screen', () => {
  assert.deepEqual(express(trace, working, 40), express(trace, working, 40));
});
