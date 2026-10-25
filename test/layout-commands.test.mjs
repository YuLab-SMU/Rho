import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeView, moveView, placeView, regions, resizeSplit, splitView } from '../dist/shell-layout.js';

// Layout commands change the owner tree only, and the shell draws the result through the
// same reading as any other composition. Each case states what the person sees afterwards.
const view = id => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: id }, bindings: {} });
const tabs = (...ids) => ({ rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ids }, ...ids.map(view)] });
const drawn = tree => regions({ compositionId: 'w', version: 1, rootId: tree.rootId, nodes: tree.nodes, views: tree.nodes.filter(n => n.kind === 'view') });
let n = 0; const id = kind => `${kind}-${++n}`;

test('split takes a view out of shared tabs and shows it beside them', () => {
  const right = splitView(tabs('a', 'b', 'c'), 'b', 'horizontal', id);
  assert.deepEqual(drawn(right), { kind: 'split', id: right.rootId, axis: 'horizontal', weights: [1, 1], children: [{ kind: 'tabs', id: 'root', views: ['a', 'c'] }, { kind: 'tabs', id: right.nodes.find(x => x.children?.[0] === 'b').id, views: ['b'] }] });
  // Splitting again along the same axis adds a pane instead of nesting a split.
  const third = splitView(right, 'c', 'horizontal', id);
  const top = drawn(third);
  assert.equal(top.kind, 'split'); assert.deepEqual(top.children.map(c => c.views), [['a'], ['c'], ['b']]); assert.deepEqual(top.weights, [0.5, 0.5, 1]);
  // A view alone in its pane has nothing to split from.
  assert.equal(splitView(right, 'b', 'vertical', id), null);
  assert.equal(splitView(tabs('a'), 'a', 'horizontal', id), null);
});

test('move puts a view in the next or previous tab group; an emptied pane closes', () => {
  const split = splitView(tabs('a', 'b'), 'b', 'vertical', id);
  const back = moveView(split, 'b', -1, id);
  assert.deepEqual(drawn(back), { kind: 'tabs', id: 'root', views: ['a', 'b'] });
  assert.equal(moveView(split, 'b', 1, id), null);
  assert.equal(moveView(tabs('a', 'b'), 'a', 1, id), null);
});

test('close removes only the view; a split left with one pane becomes it', () => {
  const split = splitView(tabs('a', 'b'), 'b', 'horizontal', id);
  assert.deepEqual(drawn(closeView(split, 'b')), { kind: 'tabs', id: 'root', views: ['a'] });
  assert.deepEqual(drawn(closeView(tabs('a', 'b'), 'a')), { kind: 'tabs', id: 'root', views: ['b'] });
  assert.equal(closeView(tabs('a'), 'missing'), null);
});

test('resize keeps a divider where the person left it', () => {
  const split = splitView(tabs('a', 'b'), 'b', 'horizontal', id);
  assert.deepEqual(drawn(resizeSplit(split, split.rootId, [0.25, 0.75])).weights, [0.25, 0.75]);
  assert.equal(resizeSplit(split, split.rootId, [1]), null);
  assert.equal(resizeSplit(split, 'root', [1, 1]), null);
});

test('arranging a linked result retains both exact versions in the saved split', () => {
  const original = { ...view('old'), component: 'rho.table', bindings: { data: { id: 'table', version: 'old' } } };
  const result = { ...original, id: 'result', bindings: { data: { id: 'table', version: 'new' } } };
  const tree = { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['old'] }, original] };
  const before = structuredClone(tree);
  const saved = splitView(placeView(tree, result, id), result.id, 'horizontal', id);
  assert.deepEqual(drawn(saved).children.map(c => c.views), [['old'], ['result']]);
  assert.deepEqual(saved.nodes.find(n => n.id === 'old').bindings, original.bindings);
  assert.deepEqual(saved.nodes.find(n => n.id === 'result').bindings, result.bindings);
  assert.deepEqual(tree, before);
  assert.equal(placeView(saved, result, id), saved); // Repeat never duplicates a view.
  assert.equal(placeView(tree, { ...result, id: 'old' }, id), null); // A retained version cannot overwrite a newer same-id node.
});

test('a linked result joins a lone last pane without changing its sibling weights or bindings', () => {
  const tree = { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['a','b'], presentation: { mode: 'split', axis: 'horizontal', weights: [2, 1] } }, view('a'), view('b')] };
  const next = placeView(tree, view('linked'), id);
  assert.deepEqual(drawn(next).children.map(c => c.views), [['a'], ['b','linked']]);
  assert.deepEqual(drawn(next).weights, [2, 1]);
  const closed = closeView(next, 'linked');
  assert.deepEqual(drawn(closed).children.map(c => c.views), [['a'], ['b']]);
  assert.deepEqual(drawn(closed).weights, [2, 1]);
  assert.deepEqual(closed.nodes.filter(n => n.kind === 'view'), tree.nodes.filter(n => n.kind === 'view'));
});
