import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalTurnAt, externalWork, workSessions } from '../dist/external-work.js';
import { buildWorkGraph } from '../dist/work-graph.js';
import { answerBoard } from '../dist/answer-board.js';
import { studioFiles } from '../dist/studio-layout.js';
import { turnsAt } from '../dist/replay.js';
import { eventMarks } from '../dist/timeline-events.js';
import { clientEntries } from '../dist/agent-connect.js';

const at = s => new Date(Date.UTC(2026, 10, 8, 11, 0, s)).toISOString();
const project = { id: 'project-a', root: '/work/means' };
const kindOf = p => /\.R$/.test(p) ? 'code' : /\.png$/.test(p) ? 'figures' : /^results\//.test(p) ? 'results' : /\.csv$/.test(p) ? 'data' : null;
const summary = { id: 'x-session', sessionId: 'native-id', producer: 'dsh', title: 'Two means', state: 'completed', lastAt: at(30), observedAt: at(40), turns: 1, sourceCursor: 12, omittedTurns: 0 };
const tool = (id, name, detail, second, extra = {}) => ({ id, name, detail, at: at(second), paths: [], output: '', outcome: 'returned', ...extra });
const read = (tools = [], extra = {}) => ({ session: summary, first: 0, turns: [{ id: 'turn:1', at: at(0), endedAt: at(30), state: 'completed', prompt: 'Compare means', reply: '[Mean table](results/means.csv) and [Figure](results/means.png).', messages: [], tools, results: [], omittedTools: 0, omittedChars: 0, ...extra }] });
const graphOf = (turns, now = Date.parse(at(50))) => buildWorkGraph({ turns, project, kindOf, files: [
  { path: 'data/input.csv', bytes: 20, category: 'data', modifiedAt: at(-20) },
  { path: 'analysis.R', bytes: 30, category: 'code', modifiedAt: at(10) },
  { path: 'results/means.csv', bytes: 20, category: 'results', modifiedAt: at(12) },
  { path: 'results/means.png', bytes: 30, category: 'figures', modifiedAt: at(12) },
  { path: 'unrelated.csv', bytes: 10, category: 'data', modifiedAt: at(12) },
], now });

test('native work uses the same Graph, Console commands and Studio roles without inventing disk observations', () => {
  const projected = externalWork(read([
    tool('write', 'write', JSON.stringify({ file_path: '/work/means/analysis.R', content: '... results/fake.csv' }), 2, { paths: ['analysis.R', 'results/fake.csv'] }),
    tool('shell', 'bash', 'Rscript analysis.R data/input.csv', 5, { output: 'mean 2 and 4', exitCode: 0 }),
    tool('private', 'read', JSON.stringify({ file_path: '/other-project/private.csv' }), 6),
    tool('failed', 'bash', 'false', 7, { outcome: 'failed', output: 'native failure' }),
  ]), project);
  assert.equal(projected[0].conversationId, summary.id);
  assert.equal(projected[0].turn.id, 'turn:1');
  assert.equal(projected[0].turn.steps.find(s => s.id === 'shell').startedAt, undefined, 'no fabricated command duration');
  const graph = graphOf(projected), runs = graph.nodes.filter(n => n.kind === 'run');
  assert.equal(runs.length, 2);
  assert.equal(runs[1].outcome, 'failed'); assert.equal(runs[1].end, 'Failed');
  assert.equal(runs[0].durationMs, null);
  assert.ok(!graph.nodes.some(n => ['unrelated.csv', 'results/fake.csv'].includes(n.path) || n.path?.includes('private.csv')));
  assert.ok(!graph.edges.some(e => e.basis === 'observed'), 'current mtimes are not reconstructed as past observations');
  assert.ok(graph.edges.some(e => e.label === 'reported result' && e.basis === 'reported'));
  assert.ok(graph.nodes.filter(n => n.kind === 'file').every(n => !n.resource), 'file links do not invent historical bytes');
  const board = answerBoard(graph, graph.turns[0].id);
  assert.equal(board.items.find(i => i.role === 'primary').node.path, 'results/means.png');
  const roles = new Map(studioFiles(graph).map(f => [f.path, f.role]));
  assert.equal(roles.get('analysis.R'), 'code'); assert.equal(roles.get('data/input.csv'), 'input');
  assert.equal(roles.get('results/means.csv'), 'result'); assert.equal(roles.get('results/means.png'), 'result');
});

test('reported versions are project scoped and a replay cannot see future results or command output', () => {
  const id = 'a'.repeat(64), version = 'b'.repeat(64);
  const projected = externalWork(read([tool('shell', 'bash', 'echo means', 5, { output: 'means', exitCode: 0 })], { results: [
    { path: 'results/means.csv', id, version, projectId: project.id, toolId: 'register' },
    { path: 'results/other.csv', id, version, projectId: 'different-project', toolId: 'foreign' },
    { path: '../outside.csv', toolId: 'outside' },
  ] }), project);
  const graph = graphOf(projected);
  assert.deepEqual(graph.nodes.find(n => n.path === 'results/means.csv').resource, { id, version });
  assert.equal(graph.nodes.find(n => n.path === 'results/other.csv').resource, undefined);
  assert.ok(!graph.nodes.some(n => n.path === '../outside.csv'));
  const earlier = turnsAt(projected, Date.parse(at(10))), before = graphOf(earlier, Date.parse(at(10)));
  const command = before.nodes.find(n => n.kind === 'run');
  assert.equal(command.outcome, 'unknown'); assert.equal(command.output, undefined);
  assert.ok(!before.edges.some(e => e.label === 'reported result'));
  const native = externalTurnAt(read([tool('shell', 'bash', 'echo means', 5, { output: 'means', exitCode: 0 })]).turns[0], Date.parse(at(10)));
  assert.equal(native.reply, ''); assert.equal(native.tools[0].outcome, 'unknown'); assert.equal(native.tools[0].output, '');
});

test('two reported versions of one resource retain separate graph nodes', () => {
  const id = 'a'.repeat(64), version = 'b'.repeat(64), next = 'c'.repeat(64);
  const first = read([], { results: [{ path: 'results/means.csv', id, version, projectId: project.id, toolId: 'first' }] });
  const second = { ...first.turns[0], id: 'turn:2', at: at(31), endedAt: at(45), results: [{ ...first.turns[0].results[0], version: next }] };
  const graph = graphOf(externalWork({ ...first, turns: [...first.turns, second] }, project));
  assert.deepEqual(graph.nodes.filter(n => n.path === 'results/means.csv').map(n => n.resource.version), [version, next]);
});

test('Notebook cells join a native conversation by the exact recorded cell, not by a shared connection grant', () => {
  const detail = { language: 'r', code: 'mean(x)', changeId: 'run-1' };
  const output = '{"apiVersion":"2.0","ok":true,"value":{"cell":{"cellId":"k-abc123","changeId":"run-1","plots":[';
  const projected = externalWork(read([tool('cell-call', 'mcp__my-project__rho_call', JSON.stringify(detail), 5, { output })]), project);
  assert.deepEqual(projected[0].kernelCells, ['k-abc123']);
  assert.equal(projected[0].turn.steps[0].operation, 'kernel.run');
  assert.equal(graphOf(projected).nodes.filter(n => n.kind === 'run').length, 0, 'a Notebook cell is not a shell command');
  const event = id => ({ source: 'kernel.events', id, by: 'shared-agent-grant', action: 'run', label: 'mean(x)', where: 'R', startedAt: at(5), endedAt: at(6), outcome: 'done' });
  const owners = [{ conversationId: summary.id, principal: null, title: summary.title, agent: 'DeepSeek Harness', eventKeys: ['kernel.events:k-abc123'] }];
  const marks = eventMarks([event('k-abc123'), event('k-def456')], owners, 0);
  assert.equal(marks[0].lane, summary.id); assert.equal(marks[1].lane, 'other');
  const ambiguous = eventMarks([event('k-abc123')], [...owners,
    { ...owners[0], conversationId: 'second-native' },
    { conversationId: 'owned', principal: 'shared-agent-grant', title: 'Owned', agent: 'Agent' }], 0);
  assert.equal(ambiguous[0].lane, 'other', 'conflicting exact receipts remain unassigned instead of falling back to a shared grant');
  assert.deepEqual(externalWork(read([tool('wrong-cell', 'mcp__my-project__rho_call', JSON.stringify({ ...detail, changeId: 'other' }), 5, { output })]), project)[0].kernelCells, []);
});

test('continuing and trashing a session do not duplicate it in the work views', () => {
  const owned = { conversationId: 'rho-session', title: 'Means', client: 'acp', state: 'completed', lastAt: at(20), version: 1 };
  const outside = { ...summary, conversationId: 'rho-session' };
  assert.deepEqual(workSessions([owned], [outside]).map(s => s.id), ['rho-session']);
  assert.deepEqual(workSessions([{ ...owned, trashedAt: at(25) }], [outside]), []);
  assert.deepEqual(workSessions([], [outside]), []);
});

test('Harness setup distinguishes scoped conversation observation from a tools-only MCP entry', () => {
  const entries = clientEntries('rho-means', ['/node', '/rho/cli.js', '--mcp', '/private/grant.json'], project.root, { DSH_HOME: '/harness' });
  assert.deepEqual(entries.dsh.workspace.mergeConfig, { command: '/node', args: ['/rho/cli.js'], connectionFiles: ['/private/grant.json'] });
  assert.equal(entries.dsh.workspace.plugin, 'dsh-rho');
  assert.match(entries.dsh.workspace.instructions, /does not observe Harness conversations/);
});
