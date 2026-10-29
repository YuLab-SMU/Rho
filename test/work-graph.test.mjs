import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkGraph, laneLayout, layoutGraph, lineage } from '../dist/work-graph.js';

const root = '/work/project';
const kindOf = path => /\.R$/.test(path) ? 'code' : /\.svg$/.test(path) ? 'figures' : /^results\//.test(path) ? 'results' : /\.csv$/.test(path) ? 'data' : /\.md$/.test(path) ? 'notes' : null;
const at = s => new Date(Date.UTC(2026, 9, 27, 10, 0, s)).toISOString();
const tool = (id, tool, s, detail, outcome = 'returned') => ({ kind: 'tool', id, tool, at: at(s), detail, outcome });
const turn = (id, text, sent, ended, steps, state = 'completed') => ({ id, by: 'local', text, sentAt: at(sent), startedAt: at(sent), endedAt: ended === null ? null : at(ended), state, steps, model: 'sonnet' });
const input = (turns, files) => ({ turns: turns.map(t => ({ conversationId: 'c1', conversationTitle: 'Ozone', agent: 'Claude Code', turn: t })), files, project: { root }, kindOf, now: Date.parse(at(200)) });

test('a question links what its turn read, changed and ran, and what changed on disk while it ran', () => {
  const graph = buildWorkGraph(input([
    turn('t1', 'How does ozone change by month?\nUse the airquality data.', 0, 30, [
      tool('a', 'Read', 2, root + '/data/airquality.csv'),
      tool('b', 'Read', 4, root + '/analysis.R'),
      tool('c', 'Edit', 6, root + '/analysis.R'),
      // A step's time is when it returned: the command ran from 6 until 16.
      tool('d', 'Bash', 16, 'Rscript analysis.R'),
      tool('e', 'Read', 20, root + '/results/monthly.csv'),
      { kind: 'text', at: at(25), text: 'Ozone peaks in July.' }])
  ], [
    { path: 'data/airquality.csv', bytes: 90, modifiedAt: at(-500), category: 'data' },
    { path: 'analysis.R', bytes: 60, modifiedAt: at(6), category: 'code' },
    { path: 'results/monthly.csv', bytes: 40, modifiedAt: at(14), category: 'results' },
    { path: 'results/ozone.svg', bytes: 900, modifiedAt: at(15), category: 'figures' },
    { path: 'notes.md', bytes: 10, modifiedAt: at(-900), category: 'notes' }]));
  const ids = graph.nodes.map(n => n.id);
  assert.deepEqual(ids.filter(id => id.startsWith('f:')).sort(), ['f:analysis.R', 'f:data/airquality.csv', 'f:results/monthly.csv', 'f:results/ozone.svg']);
  const q = graph.nodes.find(n => n.kind === 'question');
  assert.equal(q.title, 'How does ozone change by month?');
  assert.equal(q.answer, 'Ozone peaks in July.');
  const edges = Object.fromEntries(graph.edges.map(e => [e.from + ' > ' + e.to, e.label + ' · ' + e.basis]));
  assert.deepEqual(edges, {
    'f:data/airquality.csv > q:c1/t1': 'read · reported',
    'q:c1/t1 > f:analysis.R': 'edited · reported',
    'q:c1/t1 > r:c1/t1:3': 'ran · reported',
    'f:analysis.R > r:c1/t1:3': 'runs · named',
    'r:c1/t1:3 > f:results/monthly.csv': 'changed while it ran · observed',
    'r:c1/t1:3 > f:results/ozone.svg': 'changed while it ran · observed',
  }, 'a file read after it changed in the same turn is not drawn as its input; analysis.R is edited, not read');
  assert.equal(graph.nodes.find(n => n.id === 'r:c1/t1:3').title, 'Rscript analysis.R');
  assert.deepEqual(graph.events.map(e => e.action), ['ask', 'read', 'read', 'edit', 'run', 'changed', 'changed', 'read', 'answer']);
  assert.equal(graph.nodes.find(n => n.kind === 'run').at, Date.parse(at(6)), 'a finished command starts where the step before it returned');
  assert.equal(graph.live, null);
  const path = lineage(graph, 'f:results/ozone.svg');
  assert.deepEqual([...path.nodes].sort(), ['f:analysis.R', 'f:data/airquality.csv', 'f:results/ozone.svg', 'q:c1/t1', 'r:c1/t1:3']);
  assert.ok(!path.nodes.has('f:results/monthly.csv'), 'a sibling output is not on the path');
});

test('later questions build on earlier outputs, refused steps and files outside the project are left out, and the live step is named', () => {
  const graph = buildWorkGraph(input([
    turn('t1', 'Summarise', 0, 10, [tool('w', 'Write', 3, root + '/results/summary.csv')]),
    turn('t2', 'Plot the summary', 50, null, [
      tool('r', 'Read', 52, root + '/results/summary.csv'),
      tool('x', 'Read', 53, '/etc/hosts'),
      tool('y', 'Edit', 54, root + '/plot.R', 'rejected'),
      tool('z', 'Bash', 56, 'Rscript plot.R', 'requested')], 'running')
  ], [{ path: 'results/summary.csv', bytes: 12, modifiedAt: at(3), category: 'results' }, { path: 'plot.R', bytes: 30, modifiedAt: at(-60), category: 'code' }]));
  const edges = graph.edges.map(e => e.from + ' > ' + e.to + ' ' + e.label).sort();
  assert.deepEqual(edges, ['f:plot.R > r:c1/t2:3 runs', 'f:results/summary.csv > q:c1/t2 read', 'q:c1/t1 > f:results/summary.csv wrote', 'q:c1/t2 > r:c1/t2:3 ran']);
  assert.deepEqual(graph.live, { node: 'r:c1/t2:3', label: 'Running' });
  // The same command waiting for the person's choice says so on its node.
  const waiting = buildWorkGraph(input([turn('t3', 'Run it', 0, null, [tool('z', 'Bash', 2, 'Rscript plot.R', 'requested')], 'running')].map(t => ({ ...t, permissions: [{ id: 'p1', title: 'Rscript plot.R', toolCallId: 'z', state: 'pending', options: [{ id: 'yes', name: 'Yes', kind: 'allow_once' }] }] })), []));
  assert.deepEqual(waiting.live, { node: 'r:c1/t3:0', label: 'Needs your choice', waiting: true });
  assert.deepEqual(waiting.nodes.find(n => n.id === 'r:c1/t3:0').waiting, { conversationId: 'c1', turn: 't3', permission: 'p1', title: 'Rscript plot.R', options: [{ id: 'yes', name: 'Yes', kind: 'allow_once' }] });
  assert.equal(graph.turns.at(-1).running, true);
  assert.ok(!graph.nodes.some(n => n.path === 'plot.R' && n.events.some(e => e.action === 'edit')), 'a refused edit is not drawn');
});

test('a change on disk after the next message was sent belongs to that message, and messages of two conversations stay apart', () => {
  const two = input([turn('t1', 'First', 0, 10, []), turn('t2', 'Second', 11, 20, [tool('w', 'Write', 14, root + '/plot.R')])], [{ path: 'plot.R', bytes: 5, modifiedAt: at(12), category: 'code' }]);
  two.turns[1].conversationId = 'c2';
  const graph = buildWorkGraph(two);
  assert.deepEqual(graph.nodes.filter(n => n.kind === 'question').map(n => n.id), ['q:c1/t1', 'q:c2/t1'.replace('t1', 't2')]);
  assert.deepEqual(graph.edges.map(e => e.from + ' > ' + e.to + ' ' + e.label), ['q:c2/t2 > f:plot.R wrote'], 'not credited to the first message');
});

test('what the service recorded as changing during a message stays with it after a later message rewrites the file', () => {
  const recorded = input([
    turn('t1', 'Make a figure', 0, 20, [tool('b', 'Bash', 12, 'Rscript analysis.R')]),
    turn('t2', 'Fit a model', 30, 50, [tool('b', 'Bash', 42, 'Rscript analysis.R')]),
  ], [{ path: 'analysis.R', bytes: 9, modifiedAt: at(1), category: 'code' }, { path: 'results/figure.png', bytes: 900, modifiedAt: at(40), category: 'figures' }]);
  recorded.turns[0].turn.files = { changed: [{ path: 'results/figure.png', change: 'added', modifiedAt: at(10), bytes: 800 }, { path: 'old.csv', change: 'removed', modifiedAt: null, bytes: null }], omitted: 0, partial: false };
  recorded.turns[1].turn.files = { changed: [{ path: 'results/figure.png', change: 'modified', modifiedAt: at(40), bytes: 900 }], omitted: 0, partial: false };
  const graph = buildWorkGraph(recorded);
  assert.deepEqual(graph.edges.filter(e => e.basis === 'observed').map(e => e.from + ' > ' + e.to + ' ' + e.label), [
    'r:c1/t1:0 > f:results/figure.png changed while it ran', 'q:c1/t1 > f:old.csv removed meanwhile', 'r:c1/t2:0 > f:results/figure.png changed while it ran']);
});

test('the layout places each node after what it comes from, without overlaps, the same way each time', () => {
  const boxes = [['data', 0], ['q', 1], ['code', 2], ['run', 3], ['out1', 4], ['out2', 5], ['q2', 6], ['note', 7]].map(([id, t]) => ({ id, width: 200, height: id.startsWith('q') ? 120 : 90, at: t }));
  const links = [['data', 'q'], ['q', 'code'], ['q', 'run'], ['code', 'run'], ['run', 'out1'], ['run', 'out2'], ['out1', 'q2'], ['q2', 'note']].map(([from, to]) => ({ from, to }));
  const a = layoutGraph(boxes, links), b = layoutGraph(boxes, links);
  assert.deepEqual([...a.placed], [...b.placed]);
  const col = id => a.placed.get(id).column;
  for (const { from, to } of links) assert.ok(col(from) < col(to), from + ' before ' + to);
  // A source is placed before what reads it even when it was first touched later.
  const late = layoutGraph([{ id: 'q', width: 200, height: 100, at: 0 }, { id: 'input', width: 200, height: 100, at: 5 }, { id: 'out', width: 200, height: 100, at: 9 }], [{ from: 'input', to: 'q' }, { from: 'q', to: 'out' }]);
  assert.deepEqual(['input', 'q', 'out'].map(id => late.placed.get(id).column), [0, 1, 2]);
  assert.equal(col('data'), col('q') - 1, 'a source sits just before what it feeds');
  const all = [...a.placed.values()];
  for (const p of all) for (const o of all) if (p !== o && p.column === o.column) assert.ok(p.y + p.height <= o.y || o.y + o.height <= p.y, 'no overlap in a column');
  assert.ok(all.every(p => p.y >= 0 && p.x >= 0));
  // A cycle does not stop the layout.
  const cyclic = layoutGraph(boxes.slice(0, 2), [{ from: 'data', to: 'q' }, { from: 'q', to: 'data' }]);
  assert.equal(cyclic.placed.size, 2);
});

test('each message is a row; a file from an earlier row is referred to in the later one, and questions line up', () => {
  const graph = buildWorkGraph(input([
    turn('t1', 'Summarise', 0, 10, [tool('r', 'Read', 1, root + '/data/air.csv'), tool('w', 'Write', 3, root + '/results/summary.csv')]),
    turn('t2', 'Plot the summary', 50, 60, [tool('s', 'Read', 52, root + '/results/summary.csv'), tool('p', 'Write', 54, root + '/plot.R'), tool('b', 'Bash', 58, 'Rscript plot.R')])
  ], [{ path: 'data/air.csv', bytes: 9, modifiedAt: at(-90), category: 'data' }, { path: 'results/summary.csv', bytes: 12, modifiedAt: at(3), category: 'results' }, { path: 'plot.R', bytes: 30, modifiedAt: at(54), category: 'code' }]));
  const size = (node, proxy) => proxy ? { width: 200, height: 50 } : { width: 240, height: node.kind === 'question' ? 120 : 90 };
  const lanes = laneLayout(graph, size);
  assert.deepEqual(lanes.rows.map(r => r.turn), ['c1/t1', 'c1/t2']);
  const items = Object.fromEntries(lanes.items.map(i => [i.id, i.lane]));
  assert.deepEqual(items, { 'q:c1/t1': 0, 'f:data/air.csv': 0, 'f:results/summary.csv': 0, 'q:c1/t2': 1, 'f:plot.R': 1, 'r:c1/t2:2': 1, 'p1:f:results/summary.csv': 1 });
  assert.ok(lanes.links.some(l => l.from === 'p1:f:results/summary.csv' && l.to === 'q:c1/t2'), 'the later row reads the reference');
  const q1 = lanes.placed.get('q:c1/t1'), q2 = lanes.placed.get('q:c1/t2');
  assert.equal(q1.x + q1.width / 2, q2.x + q2.width / 2, 'questions stand in one column');
  const bottom = Math.max(...lanes.items.filter(i => i.lane === 0).map(i => lanes.placed.get(i.id).y + lanes.placed.get(i.id).height));
  assert.ok(lanes.items.filter(i => i.lane === 1).every(i => lanes.placed.get(i.id).y > bottom), 'the second row is below the first');
});

test('a command that ran and failed stays on the graph with how it ended, how long it ran and what it printed', () => {
  const graph = buildWorkGraph(input([turn('t1', 'Fit the model', 0, 20, [
    { ...tool('m', 'Bash', 9, 'rtk Rscript model.R', 'rejected'), startedAt: at(6), exitCode: 1, output: { text: 'Error in lm()\nExecution halted', lines: 2, bytes: 29, cut: false } },
    { ...tool('n', 'Bash', 12, 'rm -rf results', 'rejected') }])], [{ path: 'model.R', bytes: 30, modifiedAt: at(-60), category: 'code' }]));
  const runs = graph.nodes.filter(n => n.kind === 'run');
  assert.equal(runs.length, 1, 'the refused command did nothing and is left out');
  assert.deepEqual({ title: runs[0].title, command: runs[0].command, ran: runs[0].ran, end: runs[0].end, durationMs: runs[0].durationMs, output: runs[0].output },
    { title: 'Rscript model.R', command: 'Rscript model.R', ran: 'rtk Rscript model.R', end: 'Exit 1', durationMs: 3000, output: { text: 'Error in lm()\nExecution halted', lines: 2, cut: false } });
  assert.ok(graph.edges.some(e => e.from === 'f:model.R' && e.to === runs[0].id && e.label === 'runs'));
  assert.equal(runs[0].outcome, 'failed'); assert.equal(graph.events.find(e => e.node === runs[0].id).outcome, 'failed');
});

test('same path keeps distinct captured versions and old events do not acquire a later snapshot time',()=>{
 const captured=(id,s)=>({resource:{id,version:id.repeat(64)},kind:'file',bytes:9,observedAt:at(s),source:{kind:'disk',path:'analysis.R'}});
 const a=turn('t1','First',0,10,[tool('read','Read',2,root+'/analysis.R')]);
 const b=turn('t2','Second',20,30,[tool('edit','Edit',22,root+'/analysis.R')]);
 a.evidence={records:[{key:'a',path:'analysis.R',phase:'tool',state:'captured',snapshots:[captured('a',3)]}],omitted:0,bytes:9,snapshots:1};
 b.evidence={records:[{key:'b',path:'analysis.R',phase:'tool',state:'captured',snapshots:[captured('b',23)]}],omitted:0,bytes:9,snapshots:1};
 const graph=buildWorkGraph(input([a,b],[])),versions=graph.nodes.filter(n=>n.path==='analysis.R'&&n.resource);
 assert.deepEqual(versions.map(n=>n.resource.id),['a','b']);assert.ok(versions.every(n=>n.exists===false),'retained bytes do not assert the current file still exists');assert.ok(graph.nodes.some(n=>n.path==='analysis.R'&&!n.resource&&n.gap),'a later snapshot cannot bind an earlier path observation');
 assert.equal(versions[0].capturedAt,Date.parse(at(3)));assert.equal(versions[1].capturedAt,Date.parse(at(23)));
 assert.ok(graph.edges.filter(e=>e.label==='captured observation').every(e=>e.basis==='observed'));
 assert.ok(!graph.edges.some(e=>/produced/.test(e.label)));
});

test('one oversized turn respects the drawing cap and all drawn links reference retained nodes',()=>{
 const t=turn('t','Many outputs',0,20,Array.from({length:220},(_,i)=>tool('w'+i,'Write',3,root+'/results/'+i+'.csv')));
 const graph=buildWorkGraph(input([t],[]));assert.equal(graph.nodes.length,160);assert.ok(graph.omittedNodes>0);
 const ids=new Set(graph.nodes.map(n=>n.id));assert.ok(graph.edges.every(e=>ids.has(e.from)&&ids.has(e.to)));assert.ok(ids.has('q:c1/t'));
});
