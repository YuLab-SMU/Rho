import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBeside, closeView, dockView, groupNode, moveTab, moveView, placeView, regions, resizeSplit, splitView } from '../dist/shell-layout.js';

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

test('dragging a tab reorders it, moves it into another group, and leaves nothing behind', () => {
  assert.deepEqual(drawn(moveTab(tabs('a', 'b', 'c'), 'c', 'root', 'a', id)).views, ['c', 'a', 'b']);
  assert.deepEqual(drawn(moveTab(tabs('a', 'b', 'c'), 'a', 'root', null, id)).views, ['b', 'c', 'a']);
  // Dropped where it already is: nothing to write.
  assert.equal(moveTab(tabs('a', 'b', 'c'), 'b', 'root', 'c', id), null);
  assert.equal(moveTab(tabs('a', 'b', 'c'), 'c', 'root', null, id), null);
  const split = splitView(tabs('a', 'b', 'c'), 'c', 'horizontal', id), pane = drawn(split).children[1].id;
  const joined = moveTab(split, 'a', pane, 'c', id);
  assert.deepEqual(drawn(joined).children.map(c => c.views), [['b'], ['a', 'c']]);
  // The last tab of a pane leaves it, and the split collapses into the other pane.
  assert.deepEqual(drawn(moveTab(splitView(tabs('a', 'b'), 'b', 'horizontal', id), 'b', 'root', 'a', id)), { kind: 'tabs', id: 'root', views: ['b', 'a'] });
  // A pane that is one bare view becomes a tab group when another tab joins it.
  const bare = { rootId: 's', nodes: [{ id: 's', kind: 'group', children: ['a', 'b'], presentation: { mode: 'split', axis: 'horizontal', weights: [1, 1] } }, view('a'), view('b'), { id: 'g', kind: 'group', children: [] }] };
  bare.nodes[0].children = ['g', 'b']; bare.nodes[3].children = ['a', 'x']; bare.nodes.push(view('x'));
  const into = moveTab(bare, 'x', 'b', 'b', id);
  assert.deepEqual(drawn(into).children.map(c => c.views), [['a'], ['x', 'b']]);
  assert.equal(moveTab(tabs('a', 'b'), 'a', 'missing', null, id), null);
  assert.equal(groupNode('tabs:b'), 'b'); assert.equal(groupNode('group-1'), 'group-1');
});

test('dropping a tab on a side of a group gives it a pane there', () => {
  const left = dockView(tabs('a', 'b'), 'b', 'root', 'left', id);
  assert.deepEqual(drawn(left).children.map(c => c.views), [['b'], ['a']]);
  assert.equal(drawn(left).axis, 'horizontal');
  const below = dockView(tabs('a', 'b'), 'a', 'root', 'bottom', id);
  assert.deepEqual([drawn(below).axis, drawn(below).children.map(c => c.views)], ['vertical', [['b'], ['a']]]);
  // Beside a pane of a split along the same axis: the split gains a pane, halving that one's share.
  const three = tabs('a', 'b', 'c'), right = splitView(three, 'c', 'horizontal', id), pane = drawn(right).children[1].id;
  const middle = dockView(right, 'b', pane, 'left', id);
  assert.deepEqual(drawn(middle).children.map(c => c.views), [['a'], ['b'], ['c']]);
  assert.deepEqual(drawn(middle).weights, [1, 0.5, 0.5]);
  // Across the axis it nests a split in that pane only.
  const under = dockView(right, 'b', pane, 'bottom', id), drawnUnder = drawn(under);
  assert.deepEqual(drawnUnder.children[0].views, ['a']);
  assert.deepEqual([drawnUnder.children[1].axis, drawnUnder.children[1].children.map(c => c.views)], ['vertical', [['c'], ['b']]]);
  // A view alone in its group has no side of its own to go to.
  assert.equal(dockView(tabs('a'), 'a', 'root', 'right', id), null);
  // Moving the last view of one pane beside another closes the emptied pane.
  const moved = dockView(right, 'c', 'root', 'left', id);
  assert.deepEqual(drawn(moved).children.map(c => c.views), [['c'], ['a', 'b']]);
});

test('a view added beside another gets its own pane next to that view\'s group', () => {
  const notebook = { id: 'nb', component: 'rho.notebook', version: '1', props: { title: 'Notebook' }, bindings: {} };
  // An empty page takes it as its one tab.
  const empty = { rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [] }] };
  assert.deepEqual(drawn(addBeside(empty, notebook, null, 'right', id)), { kind: 'tabs', id: 'root', views: ['nb'] });
  // Beside a table that shares its tabs: the table's group keeps its views, the Notebook sits right of it.
  const right = addBeside(tabs('a', 'table'), notebook, 'table', 'right', id);
  const top = drawn(right);
  assert.equal(top.kind, 'split'); assert.deepEqual(top.children.map(c => c.views), [['a', 'table'], ['nb']]);
  // In a split, it joins beside the named view's pane without nesting another split.
  const three = addBeside(splitView(tabs('a', 'b'), 'b', 'horizontal', id), notebook, 'a', 'right', id);
  assert.deepEqual(drawn(three).children.map(c => c.views), [['a'], ['nb'], ['b']]);
  // Without a named view it goes beside the last group; a view already there is not added twice.
  assert.deepEqual(drawn(addBeside(splitView(tabs('a', 'b'), 'b', 'horizontal', id), notebook, null, 'right', id)).children.map(c => c.views), [['a'], ['b'], ['nb']]);
  assert.equal(addBeside(right, notebook, 'a', 'right', id), null);
});
