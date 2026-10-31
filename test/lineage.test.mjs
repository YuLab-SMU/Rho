import assert from 'node:assert/strict';
import test from 'node:test';
import { lanes, lineage, related } from '../dist/lineage.js';

const cell = (number, code, record = {}) => ({ cellId: 'c' + number, number, state: 'ok', code, purpose: null, plots: 0, defined: [], removed: [], used: [], files: [], ...record });
// A results object and an annotation table, merged, changed in place, drawn and written; then the
// annotation is cut down after the merge used it.
const cells = [
  cell(1, 'res <- readRDS("res.rds")', { defined: ['res'], files: [{ path: 'res.rds', how: 'read' }] }),
  cell(2, 'ann <- read.csv("ann.csv")', { defined: ['ann'], files: [{ path: 'ann.csv', how: 'read' }] }),
  cell(3, 'df <- as.data.frame(res)', { defined: ['df'], used: ['res'] }),
  cell(4, 'm <- merge(df, ann)', { defined: ['m'], used: ['df', 'ann'] }),
  cell(5, 'm$lfc2 <- m$log2FoldChange * 2', { defined: ['m'], used: ['m'] }),
  cell(6, 'plot(m$lfc2)', { used: ['m'], plots: 1 }),
  cell(7, 'write.csv(m, "out/m.csv")', { used: ['m'], files: [{ path: 'out/m.csv', how: 'wrote' }] }),
  cell(8, 'print(m)', { used: ['m'] }),
  cell(9, 'ann <- ann[1:10, ]', { defined: ['ann'], used: ['ann'] }),
];
const values = ['res', 'ann', 'df', 'm'];
const shape = graph => graph.steps.map(s => [s.id, s.layer, s.nodes.map(n => n.id).join(' ')]);

test('each cell that made something still there is a step, linked from what it read as it is now', () => {
  const graph = lineage(cells, values);
  assert.deepEqual(shape(graph), [
    ['cell:c1', 0, 'value:res'],
    ['cell:c9', 0, 'value:ann'],
    ['cell:c3', 1, 'value:df'],
    ['cell:c5', 2, 'value:m'],
    ['cell:c6', 3, 'plot:c6'],
    ['cell:c7', 3, 'wrote:out/m.csv'],
  ]);
  assert.deepEqual(graph.links.map(l => l.from + '>' + l.to).sort(), [
    'value:df>cell:c5', 'value:m>cell:c6', 'value:m>cell:c7', 'value:res>cell:c3',
  ]);
  // The files a cell read are named in its box; cutting the annotation continues reading it.
  assert.deepEqual(graph.steps.map(s => s.reads.join(' ')), ['res.rds', 'ann.csv', '', '', '', '']);
  const step = id => graph.steps.find(s => s.id === id);
  // Changing m in place continues the merge, and reads what it read; cutting ann continues reading it.
  assert.deepEqual(step('cell:c5').earlier.map(c => c.number), [4]);
  assert.deepEqual(step('cell:c9').earlier.map(c => c.number), [2]);
  // The merge read the annotation before it was cut.
  assert.deepEqual(step('cell:c5').stale, ['ann']);
  assert.equal(step('cell:c9').latest, true);
  assert.equal(graph.steps.filter(s => s.latest).length, 1);
  assert.equal(graph.layers, 4);
  assert.deepEqual([...related(graph, 'cell:c3')].sort(), ['cell:c1', 'cell:c3', 'cell:c5', 'cell:c6', 'cell:c7']);
  // In the order the cells ran, res runs past the annotation's box in a lane of its own, and m's
  // lane down to the plot and the file is free again by then for nothing else.
  const laid = lanes(graph);
  assert.deepEqual(laid.order.map(s => s.id), ['cell:c1', 'cell:c3', 'cell:c5', 'cell:c6', 'cell:c7', 'cell:c9']);
  assert.deepEqual(Object.fromEntries(laid.lane), { 'value:res': 0, 'value:df': 0, 'value:m': 0 });
  assert.equal(laid.count, 1);
});

test('a file read before a cell wrote it again is named as read in an earlier version', () => {
  const graph = lineage([
    cell(1, 'd <- read.csv("d.csv")', { defined: ['d'], files: [{ path: 'd.csv', how: 'read' }] }),
    cell(2, 'write.csv(d[1:2, ], "d.csv")', { used: ['d'], files: [{ path: 'd.csv', how: 'wrote' }] }),
    cell(3, 'e <- read.csv("d.csv")', { defined: ['e'], files: [{ path: 'd.csv', how: 'read' }] }),
  ], ['d', 'e']);
  const step = id => graph.steps.find(s => s.id === id);
  assert.deepEqual(step('cell:c1').stale, ['d.csv']);
  assert.deepEqual(graph.links.map(l => l.from + '>' + l.to).sort(), ['value:d>cell:c2', 'wrote:d.csv>cell:c3']);
  assert.equal(step('cell:c3').layer, 2);
  assert.deepEqual(step('cell:c1').reads, [], 'the file it read is not there as it read it');
});

test('values made before the kept cells, cells recorded without reads and the limits are said', () => {
  const graph = lineage([
    cell(1, 'x <- 1', { defined: ['x'], used: undefined }),
    cell(2, 'y <- x + 1', { defined: ['y'], used: ['x'] }),
    cell(3, 'z <- y + old', { defined: ['z'], used: ['y', 'old'] }),
  ], ['old', 'x', 'y', 'z'], { values: 3, plots: 8, files: 24 });
  assert.deepEqual(shape(graph), [['cell:c1', 0, 'value:x'], ['cell:c2', 1, 'value:y'], ['cell:c3', 2, 'value:z']]);
  assert.equal(graph.omitted.values, 1);
  assert.equal(graph.steps[0].unknownInputs, true);
  assert.equal(graph.steps[1].unknownInputs, false);
  const all = lineage([cell(1, 'z <- old', { defined: ['z'], used: ['old'] })], ['old', 'z']);
  assert.deepEqual(shape(all), [['earlier', 0, 'value:old'], ['cell:c1', 1, 'value:z']]);
  // A cell still running has made nothing yet.
  assert.deepEqual(lineage([cell(1, 'q <- 1', { state: 'running', defined: ['q'] })], ['q']).steps.map(s => s.id), ['earlier']);
});

test('lanes that overlap take separate places in the margin', () => {
  const graph = lineage([
    cell(1, 'a <- 1', { defined: ['a'] }),
    cell(2, 'b <- 2', { defined: ['b'] }),
    cell(3, 'c <- a + b', { defined: ['c'], used: ['a', 'b'] }),
    cell(4, 'd <- a * c', { defined: ['d'], used: ['a', 'c'] }),
  ], ['a', 'b', 'c', 'd']);
  const laid = lanes(graph);
  assert.deepEqual(laid.order.map(s => s.cell.number), [1, 2, 3, 4]);
  assert.deepEqual(Object.fromEntries(laid.lane), { 'value:a': 0, 'value:b': 1, 'value:c': 1 });
  assert.equal(laid.count, 2);
});

test('what a changed value came from goes with the value, to the cell that has it now', () => {
  const graph = lineage([
    cell(1, 'raw = load("alignments")', { defined: ['raw'], files: [{ path: 'alignments/', how: 'read' }] }),
    cell(2, 'lengths = table(raw)', { defined: ['lengths'], used: ['raw'] }),
    cell(3, 'own = load("clipkit")\nlengths["clipkit"] = 1', { defined: ['lengths', 'own'], used: ['lengths'], files: [{ path: 'clipkit/', how: 'read' }] }),
    cell(4, 'lengths["r"] = f(own)', { defined: ['lengths'], used: ['lengths', 'own'] }),
  ], ['raw', 'lengths', 'own']);
  const step = id => graph.steps.find(s => s.id === id);
  assert.deepEqual(step('cell:c3').nodes.map(n => n.id), ['value:own']);
  assert.deepEqual(step('cell:c3').earlier, [], 'the box no longer holds the value it changed');
  assert.deepEqual(step('cell:c3').reads, ['clipkit/']);
  assert.deepEqual(step('cell:c4').earlier.map(c => c.number), [2, 3]);
  assert.deepEqual(graph.links.map(l => l.from + '>' + l.to).sort(), ['value:own>cell:c4', 'value:raw>cell:c4']);
  assert.deepEqual(step('cell:c4').reads, ['clipkit/'], 'what the change in 3 read goes with lengths');
});
