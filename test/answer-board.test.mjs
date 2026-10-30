import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkGraph } from '../dist/work-graph.js';
import { answerBoard, boardThreads, commandGist } from '../dist/answer-board.js';
import { askText, askedAbout } from '../dist/asking.js';

const root = '/work/project';
const kindOf = path => /\.py$/.test(path) ? 'code' : /\.png$/.test(path) ? 'figures' : /^results\//.test(path) ? 'results' : /\.csv$/.test(path) ? 'data' : /\.md$/.test(path) ? 'notes' : null;
const at = s => new Date(Date.UTC(2026, 9, 29, 8, 0, s)).toISOString();
const tool = (id, tool, s, detail, extra = {}) => ({ kind: 'tool', id, tool, at: at(s), detail, outcome: 'returned', ...extra });
const turn = (id, text, sent, ended, steps) => ({ id, by: 'local', text, sentAt: at(sent), startedAt: at(sent), endedAt: at(ended), state: 'completed', steps, model: 'sonnet' });
const graphOf = (turns, files) => buildWorkGraph({ turns: turns.map(t => ({ conversationId: 'c1', conversationTitle: 'Swarming', agent: 'Claude Code', turn: t })), files, project: { root }, kindOf, now: Date.parse(at(900)) });
const files = [
  { path: 'data/swarm.csv', bytes: 90, modifiedAt: at(-500), category: 'data' },
  { path: 'analysis.py', bytes: 60, modifiedAt: at(5), category: 'code' },
  { path: 'results/figure.png', bytes: 900, modifiedAt: at(14), category: 'figures' },
  { path: 'results/dunnett.csv', bytes: 40, modifiedAt: at(14), category: 'results' },
];
const analysis = turn('t1', 'Answer the questions from the data.', 0, 30, [
  tool('a', 'Read', 2, root + '/data/swarm.csv'),
  tool('b', 'Write', 5, root + '/analysis.py'),
  tool('c', 'Bash', 16, 'cd /work/project && python3 analysis.py > /tmp/out.txt 2>&1; echo "exit=$?"', { exitCode: 0 }),
  tool('d', 'Bash', 18, 'ls results'),
  { kind: 'text', at: at(25), text: 'See results/figure.png: four ratios differ.' }]);

test('a command is named by its first real step, without where its output went', () => {
  assert.equal(commandGist('python3 analysis.py > /tmp/x 2>&1; echo done'), 'python3 analysis.py');
  assert.equal(commandGist('cd data && head -5 a.csv'), 'head -5 a.csv');
  assert.equal(commandGist("python3 - <<'PY'\nimport csv\nPY"), 'python3 (inline script)');
});

test('the board puts the mentioned figure first, then the table, the script, the run and the data it read', () => {
  const graph = graphOf([analysis], files);
  const board = answerBoard(graph, 'c1/t1');
  const roles = Object.fromEntries(board.items.map(i => [i.node.path ?? i.node.id, i.role]));
  assert.equal(roles['results/figure.png'], 'primary');
  assert.equal(roles['results/dunnett.csv'], 'supporting');
  assert.equal(roles['analysis.py'], 'method');
  assert.equal(roles['data/swarm.csv'], 'input');
  assert.equal(board.items.find(i => i.role === 'run').node.ran.includes('python3 analysis.py'), true);
  assert.equal(board.otherCommands, 1);
});

test('a question asked in place reads back as what it was about and the person\'s own words', () => {
  const file = askText({ kind: 'file', path: 'results/figure.png', title: 'figure.png', resource: { id: 'r1', version: 'abc' } }, '  What do the red points mean?  ');
  assert.equal(file, 'About results/figure.png as this message left it (resource r1@abc):\n\nWhat do the red points mean?');
  assert.deepEqual(askedAbout(file), { about: 'results/figure.png', quote: null, question: 'What do the red points mean?' });
  const passage = askText({ kind: 'passage', text: 'Four ratios differ.\nSix do not.' }, 'Which test?');
  assert.deepEqual(askedAbout(passage), { about: null, quote: 'Four ratios differ.\nSix do not.', question: 'Which test?' });
  // A message written any other way is its own question, even one with a blank line in it.
  assert.deepEqual(askedAbout('Plot it again.\n\nUse blue.'), { about: null, quote: null, question: 'Plot it again.\n\nUse blue.' });
});

test('a later question that made no results follows the answer it asks about instead of replacing it', () => {
  const asked = turn('t2', askText({ kind: 'file', path: 'results/figure.png', title: 'figure.png' }, 'What do the red points mean?'), 40, 60, [
    tool('e', 'Read', 45, root + '/analysis.py'), { kind: 'text', at: at(58), text: 'Red points differ from Strain 1.' }]);
  const graph = graphOf([analysis, asked], files);
  const threads = boardThreads(graph);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].turn.id, 'c1/t1');
  assert.deepEqual(threads[0].followUps.map(t => t.id), ['c1/t2']);
  // The Graph names the follow-up by the person's question, not by what it was about.
  assert.equal(graph.nodes.find(n => n.id === 'q:c1/t2').title, 'What do the red points mean?');
  // A message that makes new results holds its own board, and later questions follow it.
  const rerun = turn('t3', 'Run it with the monocultures too.', 70, 90, [tool('f', 'Bash', 85, 'python3 analysis.py', { exitCode: 0 })]);
  // What the service recorded changing during the first message stays with it after the rerun.
  const first = { ...analysis, files: { changed: [{ path: 'results/figure.png', change: 'added', modifiedAt: at(14), bytes: 900 }, { path: 'results/dunnett.csv', change: 'added', modifiedAt: at(14), bytes: 40 }], omitted: 0, partial: false } };
  const later = graphOf([first, asked, rerun], [...files.slice(0, 2), { ...files[2], modifiedAt: at(80) }, { ...files[3], modifiedAt: at(80) }]);
  assert.deepEqual(boardThreads(later).map(t => [t.turn.id, t.followUps.map(f => f.id)]), [['c1/t3', []], ['c1/t1', ['c1/t2']]]);
});
