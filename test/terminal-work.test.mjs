import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalWork, terminalWorkLimits } from '../dist/terminal-work.js';
import { buildWorkGraph } from '../dist/work-graph.js';
import { buildWorkLayers } from '../dist/work-layers.js';

const root = '/work/project';
const at = s => new Date(Date.UTC(2026, 10, 12, 10, 0, s)).toISOString();
const kindOf = path => /\.csv$/.test(path) ? 'data' : /\.R$/.test(path) ? 'code' : null;
const command = (id, by, started, ended, line, extra = {}) => ({ commandId: 'tc-' + id.padStart(16, '0'), terminalId: 't-' + '1'.repeat(16), command: line, cwd: '', by: [by], enteredBy: by,
  startedAt: at(started), endedAt: ended === null ? null : at(ended), state: ended === null ? 'running' : 'exited', exit: ended === null ? null : 0, output: '', outputBytes: 0, stored: false, storedBytes: 0, screens: 0, cut: false, problem: null, ...extra });
const message = (id, sent, ended, steps = []) => ({ conversationId: 'c1', conversationTitle: 'Ozone', agent: 'Claude Code', turn: { id, by: 'local', text: 'Clean the ozone data', sentAt: at(sent), startedAt: at(sent), endedAt: at(ended), state: 'completed', steps, model: null } });
const name = principal => principal === 'browser:local' ? 'You' : 'Claude Code';

test('an Agent\'s terminal commands join the message it was answering; the rest are typed-in-the-terminal messages of whoever entered them', () => {
  const turns = [message('m1', 0, 60)];
  const commands = [
    command('1', 'agent:c1', 10, 20, 'Rscript clean.R'),
    command('2', 'browser:local', 30, 31, 'ls data', { output: 'ozone.csv', outputBytes: 10 }),
    command('3', 'browser:local', 40, 45, 'head data/ozone.csv', { state: 'exited', exit: 1 }),
    // After a long pause: another message.
    command('4', 'browser:local', 50 + terminalWorkLimits.gapMs / 1000 + 10, null, 'top'),
    // The Agent, typing outside any message of its own.
    command('5', 'agent:c1', 120, 121, 'pwd'),
  ];
  const out = terminalWork(turns, commands, [{ conversationId: 'c1', principal: 'agent:c1' }], name, Date.parse(at(9999)));
  assert.equal(out.length, 4);
  const [mine, ...typed] = out;
  assert.deepEqual(mine.turn.steps.map(s => [s.tool, s.detail, s.startedAt, s.at, s.outcome, s.exitCode, s.terminal.enteredBy]), [['Bash', 'Rscript clean.R', at(10), at(20), 'returned', 0, 'Claude Code']]);
  assert.deepEqual(typed.map(t => [t.conversationId, t.conversationTitle, t.agent, t.terminal, t.turn.state, t.turn.steps.map(s => s.detail)]), [
    ['terminal:browser:local', 'Terminal', 'You', true, 'completed', ['ls data', 'head data/ozone.csv']],
    ['terminal:agent:c1', 'Claude Code in the terminal', 'Claude Code', true, 'completed', ['pwd']],
    ['terminal:browser:local', 'Terminal', 'You', true, 'running', ['top']],
  ]);
  assert.equal(typed[0].turn.endedAt, at(45));
  assert.deepEqual(typed[2].turn.steps[0].outcome, 'requested');
  assert.deepEqual(typed[0].turn.steps[1].exitCode, 1);
  assert.equal(typed[0].turn.steps[0].output.text, 'ozone.csv');
  // Nothing typed: the turns as they were.
  assert.equal(terminalWork(turns, [], [], name, 0)[0], turns[0]);
});

test('in the Graph a terminal command is a run from its start to its end, and a file is its only when it changed while it ran', () => {
  const commands = [command('1', 'browser:local', 10, 20, 'Rscript clean.R'), command('2', 'browser:local', 30, 31, 'ls')];
  // ozone.csv changed while the first ran; notes.csv between the two, by someone else.
  const files = [{ path: 'clean.R', bytes: 10, modifiedAt: at(1), category: 'code' }, { path: 'data/ozone.csv', bytes: 100, modifiedAt: at(15), category: 'data' }, { path: 'data/notes.csv', bytes: 5, modifiedAt: at(25), category: 'data' }];
  const turns = terminalWork([], commands, [], name, Date.parse(at(100)));
  const graph = buildWorkGraph({ turns, files, project: { root }, kindOf, now: Date.parse(at(100)) });
  const runs = graph.nodes.filter(n => n.kind === 'run');
  assert.deepEqual(runs.map(r => [r.command, r.at, r.end, r.terminal?.enteredBy]), [['Rscript clean.R', Date.parse(at(10)), 'Exit 0', 'You'], ['ls', Date.parse(at(30)), 'Exit 0', 'You']]);
  const labels = graph.edges.map(e => [graph.nodes.find(n => n.id === e.from).title, e.label, graph.nodes.find(n => n.id === e.to).title, e.basis]);
  assert.ok(labels.some(([from, label, to, basis]) => from === 'Rscript clean.R' && label === 'changed while it ran' && to === 'ozone.csv' && basis === 'observed'), JSON.stringify(labels));
  assert.ok(!labels.some(([, , to]) => to === 'notes.csv'), 'a change between commands is not the terminal\'s');
  assert.ok(!graph.events.some(e => e.label === 'Answered'), 'typing is not answered');
  // Its step says where it was typed and by whom.
  const layers = buildWorkLayers({ turns, graph, project: { root }, now: Date.parse(at(100)) });
  const steps = [...layers.nodes.values()].filter(n => n.level === 'step');
  assert.deepEqual(steps.map(s => s.said), ['In the terminal · typed by You', 'In the terminal · typed by You']);
  assert.deepEqual([...layers.nodes.values()].filter(n => n.level === 'line').map(l => l.title), ['Terminal']);
});
