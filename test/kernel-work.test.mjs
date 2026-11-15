import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notebookWork } from '../dist/kernel-work.js';
import { buildWorkGraph, foldVersions } from '../dist/work-graph.js';
import { buildWorkLayers, trajectory } from '../dist/work-layers.js';

const root = '/work/project';
const at = s => new Date(Date.UTC(2026, 10, 11, 10, 0, s)).toISOString();
const cell = (id, s, code, extra = {}) => ({ cellId: id, changeId: id, by: 'browser:local', sessionId: 'session-1', language: 'python', code, purpose: null,
  queuedAt: at(s), startedAt: at(s), endedAt: at(s + 1), state: 'done', number: s, outputs: [], bytes: 0, kept: 0, cut: false, interrupt: null, problem: null, ...extra });
const kindOf = path => path.startsWith('results/') ? 'results' : path.startsWith('data/') ? 'data' : path.endsWith('.py') ? 'code' : null;

test('human Notebook cells become one person work line without duplicating the timeline answer', () => {
  const cells = [
    cell('k-1', 1, 'import pandas as pd\ndf = pd.read_csv("data/input.csv")', { files: [{ path: 'data/input.csv', how: 'read' }] }),
    cell('k-2', 3, 'df.to_csv("results/out.csv", index=False)', { files: [{ path: 'results/out.csv', how: 'wrote' }] }),
    { ...cell('k-agent', 5, 'print("Agent")'), by: 'agent:one' },
  ];
  const turns = notebookWork(cells);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].person, true);
  assert.deepEqual(turns[0].kernelCells, ['k-1', 'k-2']);
  assert.equal(turns[0].turn.steps.length, 2);
  assert.deepEqual(turns[0].turn.files.changed.map(file => file.path), ['results/out.csv']);

  const named = notebookWork(cells.map(item => ({ ...item, notebook: 'nb-growth' })), { 'nb-growth': 'Growth analysis' });
  assert.equal(named[0].conversationTitle, 'Growth analysis');

  const files = [
    { path: 'data/input.csv', bytes: 30, modifiedAt: at(0), category: 'data' },
    { path: 'results/out.csv', bytes: 40, modifiedAt: at(4), category: 'results' },
  ];
  const graph = foldVersions(buildWorkGraph({ turns, files, project: { root }, kindOf, now: Date.parse(at(20)) }));
  assert.ok(graph.turns[0].person);
  assert.equal(graph.events.filter(event => event.action === 'ask').length, 0);
  assert.equal(graph.events.filter(event => event.action === 'answer').length, 0);
  assert.equal(graph.nodes.filter(node => node.kind === 'run').length, 2);

  const layers = buildWorkLayers({ turns, graph, project: { root }, now: Date.parse(at(20)) });
  const lines = layers.nodes.get(layers.root).children.map(id => layers.nodes.get(id));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].person, true);
  assert.equal(layers.nodes.get(layers.root).steps, 2);
  assert.equal(trajectory(layers, layers.root).length, 2);
});
