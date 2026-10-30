import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkGraph } from '../dist/work-graph.js';
import { turnAt, turnsAt } from '../dist/replay.js';
import { chapters } from '../dist/studio-chapters.js';
import { studioAt, studioFiles, studioIds, studioMerge, studioTree } from '../dist/studio-layout.js';

const root = '/work/project';
const kindOf = path => /\.py$/.test(path) ? 'code' : /\.png$/.test(path) ? 'figures' : /^results\//.test(path) ? 'results' : /\.csv$/.test(path) ? 'data' : /\.md$/.test(path) ? 'notes' : null;
const ms = s => Date.UTC(2026, 9, 30, 6, 0, s);
const at = s => new Date(ms(s)).toISOString();
const tool = (id, tool, s, detail, extra = {}) => ({ kind: 'tool', id, tool, at: at(s), detail, outcome: 'returned', ...extra });
const text = (s, words) => ({ kind: 'text', at: at(s), text: words });
const captured = (path, id, s) => ({ resource: { id, version: id.repeat(64).slice(0, 64) }, kind: 'file', bytes: 9, observedAt: at(s), source: { kind: 'disk', path } });
const record = (key, path, snapshots) => ({ key, path, phase: 'tool', state: 'captured', requestedAt: snapshots[0].observedAt, snapshots });
const files = [
  { path: 'data/swarm.csv', bytes: 90, modifiedAt: at(-500), category: 'data' },
  { path: 'analysis.py', bytes: 60, modifiedAt: at(40), category: 'code' },
  { path: 'results/figure.png', bytes: 900, modifiedAt: at(46), category: 'figures' },
  { path: 'results/dunnett.csv', bytes: 40, modifiedAt: at(46), category: 'results' },
];
// One message: read the data, look around with two commands, say what comes next, write and run
// the script twice with an edit between, then answer.
function work() {
  const turn = {
    id: 't1', by: 'local', text: 'Answer the questions from the data.', sentAt: at(0), startedAt: at(0), endedAt: at(60), state: 'completed', model: 'sonnet',
    steps: [
      tool('a', 'Read', 2, root + '/data/swarm.csv'),
      tool('b', 'Bash', 6, 'head -5 data/swarm.csv', { startedAt: at(4), exitCode: 0 }),
      tool('c', 'Bash', 9, 'wc -l data/swarm.csv', { startedAt: at(7), exitCode: 0 }),
      text(10, 'API Error: Server error mid-response.'),
      text(12, "Now I'll write the analysis script. It answers each question."),
      tool('d', 'Write', 14, root + '/analysis.py'),
      tool('e', 'Bash', 24, 'python3 analysis.py', { startedAt: at(16), exitCode: 0, output: { text: 'done', lines: 1, cut: false } }),
      tool('f', 'Edit', 30, root + '/analysis.py'),
      tool('g', 'Bash', 46, 'python3 analysis.py', { startedAt: at(40), exitCode: 0 }),
      text(55, 'Four ratios differ; see results/figure.png.'),
    ],
    evidence: { records: [
      record('d', 'analysis.py', [captured('analysis.py', 'a', 14)]),
      record('f', 'analysis.py', [captured('analysis.py', 'b', 30)]),
      record('fig1', 'results/figure.png', [captured('results/figure.png', 'c', 25)]),
      record('fig2', 'results/figure.png', [captured('results/figure.png', 'd', 47)]),
    ], omitted: 0, bytes: 36, snapshots: 4 },
    files: { changed: [{ path: 'results/figure.png', change: 'modified', modifiedAt: at(46) }, { path: 'results/dunnett.csv', change: 'modified', modifiedAt: at(46) }], partial: false, omitted: 0 },
  };
  return turn;
}
const graphOf = turns => buildWorkGraph({ turns: turns.map(turn => ({ conversationId: 'c1', conversationTitle: 'Swarming', agent: 'Claude Code', turn })), files, project: { root }, kindOf, now: ms(90) });

test('a replay cuts the record at one moment: later steps, versions and changes are absent and a step still going has no result', () => {
  const turn = work();
  assert.equal(turnAt(turn, ms(-1)), null, 'a message not yet sent is absent');
  assert.equal(turnAt(turn, ms(61)), turn, 'a message that ended by then is as recorded');
  const then = turnAt(turn, ms(20));
  assert.equal(then.state, 'running'); assert.equal(then.endedAt, null);
  assert.deepEqual(then.steps.map(s => s.id ?? s.text.slice(0, 3)), ['a', 'b', 'c', 'API', 'Now', 'd', 'e']);
  const running = then.steps.at(-1);
  assert.equal(running.outcome, 'requested'); assert.equal(running.exitCode, undefined); assert.equal(running.output, undefined);
  assert.deepEqual(then.evidence.records.map(r => r.key), ['d'], 'only versions kept by then');
  assert.deepEqual(then.files.changed, [], 'only changes made by then');
  assert.deepEqual(turnsAt([{ turn }], null)[0].turn, turn, 'null is now');
});

test('the parts of a message are named by the Agent\'s words, or by what the steps did, and folded into rounds', () => {
  const parts = chapters(work(), 't1', root);
  assert.deepEqual(parts.map(p => [p.kind, p.title]), [
    ['look', 'Read swarm.csv'],
    ['explore', 'Explored with 2 commands'],
    ['build', "Now I'll write the analysis script."],
    ['answer', 'Answered'],
  ]);
  assert.deepEqual(parts[1].notes, ['1 provider error'], 'the provider notice opens no part');
  assert.equal(parts[2].said, true); assert.equal(parts[2].start, ms(12));
  assert.deepEqual(parts[2].rounds.map(r => [r.edits, r.runs]), [[1, 1], [1, 1]], 'write and run, then edit and run again');
  const live = chapters(turnAt(work(), ms(20)), 't1', root);
  assert.equal(live.at(-1).running, true); assert.ok(!live.some(p => p.kind === 'answer'));
});

test('files take their role from the whole record and join a replay when the work first had them', () => {
  const every = studioFiles(graphOf([work()]));
  const role = Object.fromEntries(every.map(f => [f.path, f.role]));
  assert.equal(role['analysis.py'], 'code'); assert.equal(role['results/figure.png'], 'result'); assert.equal(role['data/swarm.csv'], 'input');
  assert.deepEqual(every.find(f => f.path === 'analysis.py').versions.map(v => v.at), [ms(14), ms(30)]);
  // The result the answer led with first, then the others as the work first had them.
  assert.deepEqual(every.filter(f => f.role === 'result').map(f => [f.path, f.lead]), [['results/figure.png', true], ['results/dunnett.csv', false]]);
  const early = studioAt(every, ms(20));
  assert.deepEqual(early.map(f => f.path).sort(), ['analysis.py', 'data/swarm.csv']);
  assert.equal(early.find(f => f.path === 'analysis.py').versions.length, 1, 'the version kept by then');
  const later = studioAt(every, ms(28));
  assert.equal(later.find(f => f.path === 'results/figure.png').role, 'result', 'a result read back mid-way is still a result');
});

const view = id => ({ id, kind: 'view', component: 'rho.editor', version: '1', props: { title: id }, bindings: {} });
test('the layout places inputs, code and commands down one side and figures above tables on the other', () => {
  const tree = studioTree([
    { role: 'input', node: view('in') }, { role: 'code', node: view('code') },
    { role: 'result', node: view('fig'), figure: true }, { role: 'result', node: view('table') }, { role: 'report', node: view('report') },
  ], view(studioIds.console));
  const node = id => tree.nodes.find(n => n.id === id);
  assert.equal(tree.rootId, studioIds.root);
  assert.deepEqual(node(studioIds.root).children, [studioIds.left, studioIds.right]);
  assert.deepEqual(node(studioIds.left).children, [studioIds.input, studioIds.code, studioIds.commands]);
  assert.equal(node(studioIds.left).presentation.axis, 'vertical');
  assert.deepEqual(node(studioIds.right).children, [studioIds.figures, studioIds.result]);
  assert.deepEqual(node(studioIds.result).children, ['table', 'report']);
  // Before any result, one side is the whole layout; a role with nothing has no place.
  const early = studioTree([{ role: 'input', node: view('in') }], view(studioIds.console));
  assert.equal(early.rootId, studioIds.left); assert.equal(early.nodes.some(n => n.id === studioIds.code), false);
  assert.equal(studioTree([], null), null);
});

test('a saved arrangement keeps what the person closed and takes later files into their role\'s place', () => {
  const derived = studioTree([{ role: 'input', node: view('in') }, { role: 'code', node: view('code') }, { role: 'result', node: view('table') }, { role: 'result', node: view('late') }], null);
  // The person closed the results and kept the rest; 'table' was there when they did, 'late' was not.
  const saved = { rootId: studioIds.left, nodes: structuredClone(derived.nodes.filter(n => ![studioIds.root, studioIds.right, studioIds.result, 'table', 'late'].includes(n.id))) };
  saved.nodes.find(n => n.id === 'code').props = { title: 'old' };
  const merged = studioMerge(saved, derived, id => id !== 'late');
  const ids = merged.nodes.map(n => n.id);
  assert.ok(!ids.includes('table'), 'a closed view stays closed');
  assert.ok(ids.includes('late'), 'a later file joins');
  assert.equal(merged.nodes.find(n => n.id === 'code').props.title, 'code', 'a kept view shows what the work has now');
  const root = merged.nodes.find(n => n.id === merged.rootId);
  assert.equal(root.presentation.axis, 'horizontal'); assert.deepEqual(root.children, [studioIds.left, studioIds.result]);
});
