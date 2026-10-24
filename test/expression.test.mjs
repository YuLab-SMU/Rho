import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { agentPaceMs, express, questionsOn, timeOf } from '../dist/expression.js';
import { taskMapLimits } from '../dist/task-map.js';

// The expression rules replayed over one recorded Agent run (agent-exp-2215: 61 calls,
// five R runs, two of them failing), followed by the two questions a browser asked about
// its results and the one receipt. Each test is one sentence of
// docs/INTERACTION-MODEL.md that the replay prototype has to make true.
const trace = JSON.parse(fs.readFileSync(new URL('../prototypes/replay/trace/airquality.json', import.meta.url), 'utf8'));
const last = trace.facts.length - 1;
const runEnd = trace.facts.findLastIndex(f => f.actor === trace.facts[0].actor);
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

test("a view the person opened keeps its version; the Agent's newer one opens beside it", () => {
  const kept = [{ at: 15, kind: 'open', target: 'artifact:temp-effect.png' }, { at: 15, kind: 'follow' }];
  const figures = screen => screen.views.filter(v => v.object === 'artifact:temp-effect.png').map(v => [v.openedBy, v.run, v.newer]);
  assert.deepEqual(figures(express(trace, kept, 28)), [['person', 1, 2]]);
  const at54 = express(trace, kept, 54);
  assert.deepEqual(figures(at54), [['person', 1, 5], ['agent', 5, null]]);
  assert.equal(at54.views.find(v => v.id === at54.active).run, 5);
  // Taking the newer version is the person's act; the Agent's view of it then closes.
  const updated = express(trace, [...kept, { at: 57, kind: 'update', target: 'artifact:temp-effect.png' }], last);
  assert.deepEqual(figures(updated), [['person', 5, null]]);
  // The Agent's focus follows the same rule. Constructed: the recorded run never reads the
  // figure, so #53 (a catalog read) is replaced with a read of run 5's.
  const constructed = structuredClone(trace);
  Object.assign(constructed.facts[53], { op: 'data.page', object: 'artifact:temp-effect.png', effect: { kind: 'read', artifact: 'temp-effect.png', run: 5 } });
  const read = express(constructed, [kept[0], { at: 52, kind: 'follow' }], 53);
  // The preview slot keeps its place, ahead of the view the person opened at #15.
  assert.deepEqual(read.views.map(v => [v.id, v.run, v.preview]), [['artifact:temp-effect.png@5', 5, true], ['artifact:temp-effect.png', 1, false]]);
  assert.equal(read.active, 'artifact:temp-effect.png@5');
});

test('the Agent declares its items at the end, and they stay its account, unlinked to objects', () => {
  assert.equal(express(trace, [], 58).question, null);
  const screen = express(trace, [], runEnd);
  assert.equal(screen.items.length, 5);
  assert.match(screen.question, /wind and sunlight/);
  assert.deepEqual(Object.keys(screen.objects), Object.keys(express(trace, [], 58).objects));
});

test('what a person records changes its objects in place; only the Agent moves the screen', () => {
  const end = express(trace, [], last), run = express(trace, [], runEnd);
  assert.deepEqual(trace.facts.slice(runEnd + 1).map(f => trace.principals[f.actor].kind + ' ' + f.op), [
    'browser document.edit', 'browser context.create', 'agent context.read', 'browser document.edit', 'browser context.create',
  ]);
  assert.equal(end.objects['source:questions.md'].version, 3);
  assert.deepEqual([end.active, end.views, end.agent, end.moves], [run.active, run.views, run.agent, run.moves]);
});

test('a question stays on the version it was asked about; newer versions do not move it', () => {
  // Simulated: the person asks about run 1's figure; runs 2 and 5 then make new figures.
  const asked = [{ at: 15, kind: 'open', target: 'artifact:temp-effect.png' }, { at: 15, kind: 'ask', target: 'artifact:temp-effect.png', rows: [], text: 'Why is D lower than A?' }, { at: 15, kind: 'follow' }];
  const screen = express(trace, asked, runEnd), figure = screen.objects['artifact:temp-effect.png'];
  const q = screen.objects['question:asked-1'];
  assert.deepEqual([q.target, q.run, q.version, q.state, q.author], ['artifact:temp-effect.png', 1, figure.versions[0].digest, 'prepared', null]);
  assert.equal(figure.versions.length, 3);
  assert.deepEqual(screen.views.filter(v => v.object === figure.id).map(v => [v.run, questionsOn(screen, v).map(x => x.id)]), [[1, ['question:asked-1']], [5, []]]);
  // Recorded: each question from 18:19 sits on the version its context names, and opens there.
  const end = express(trace, [], last);
  assert.deepEqual(['question:70d07e4a', 'question:7d3dbf6a'].map(id => { const r = end.objects[id]; return [r.target, r.version, r.run, r.rows, r.document.version]; }), [
    ['artifact:temp-effect.png', '985b7955', 5, [], 2], ['artifact:effects.csv', '1f305e10', 5, ['A', 'D'], 3],
  ]);
  for (const id of ['question:70d07e4a', 'question:7d3dbf6a']) {
    const opened = express(trace, [{ at: last, kind: 'open', target: id }], last);
    assert.ok(questionsOn(opened, opened.views.find(v => v.id === opened.active)).some(x => x.id === id), id + ' opens on its version');
  }
});

test('a fetch is a receipt: only the question changes, and nothing after it is claimed', () => {
  const fetch = trace.facts.findIndex(f => f.effect?.kind === 'fetched');
  const before = express(trace, [], fetch - 1), after = express(trace, [], fetch);
  const q = after.objects['question:70d07e4a'];
  assert.deepEqual([before.objects[q.id].state, q.state, trace.principals[q.fetchedBy].name, trace.facts[q.fetchedAt].at], ['prepared', 'fetched', 'acceptance-fetch', '2026-10-24T18:19:25.129Z']);
  assert.deepEqual([after.active, after.views, after.agent, after.moves, after.escalations, after.suggestions], [before.active, before.views, before.agent, before.moves, before.escalations, before.suggestions]);
  // The second question was never fetched, and no record makes either one responded.
  const end = express(trace, [], last);
  assert.equal(end.objects['question:7d3dbf6a'].state, 'prepared');
  assert.ok(!Object.values(end.objects).some(o => o.kind === 'question' && o.state === 'responded'));
  // Someone away meets the receipt in the digest, by object.
  const back = express(trace, [{ at: runEnd, kind: 'leave' }, { at: last, kind: 'return' }], last);
  assert.deepEqual(back.digest.lines.map(l => l.kind + ' ' + l.object + ' ' + (l.state ?? l.to)), ['source source:questions.md 3', 'question question:70d07e4a fetched', 'question question:7d3dbf6a prepared']);
});

test('the same facts and actions always give the same screen', () => {
  assert.deepEqual(express(trace, working, 40), express(trace, working, 40));
});
