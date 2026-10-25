import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regions, viewOrder, groupOf, resize } from '../dist/shell-layout.js';

const view = id => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: id }, bindings: {} });
const layout = (nodes, extra = []) => ({ compositionId: 'c', version: 1, rootId: 'root', nodes, views: [...nodes.filter(n => n.kind === 'view'), ...extra].map(({ kind, ...v }) => v) });

test('a plain or tab group is one tab group in its recorded order', () => {
  assert.deepEqual(regions(layout([{ id: 'root', kind: 'group', children: ['a'] }, view('a')])), { kind: 'tabs', id: 'root', views: ['a'] });
  assert.deepEqual(regions(layout([{ id: 'root', kind: 'group', children: ['b', 'a'], presentation: { mode: 'tabs' } }, view('a'), view('b')])), { kind: 'tabs', id: 'root', views: ['b', 'a'] });
});

test('splits keep axis, weights and nesting; a lone view in a split is its own tab group', () => {
  const r = regions(layout([
    { id: 'root', kind: 'group', children: ['a', 'right'], presentation: { mode: 'split', axis: 'horizontal', weights: [2, 1] } },
    { id: 'right', kind: 'group', children: ['b', 'tabs'], presentation: { mode: 'split', axis: 'vertical', weights: [1, 3] } },
    { id: 'tabs', kind: 'group', children: ['c', 'd'] }, view('a'), view('b'), view('c'), view('d'),
  ]));
  assert.deepEqual(r, { kind: 'split', id: 'root', axis: 'horizontal', weights: [2, 1], children: [
    { kind: 'tabs', id: 'tabs:a', views: ['a'] },
    { kind: 'split', id: 'right', axis: 'vertical', weights: [1, 3], children: [{ kind: 'tabs', id: 'tabs:b', views: ['b'] }, { kind: 'tabs', id: 'tabs', views: ['c', 'd'] }] },
  ] });
  assert.deepEqual(viewOrder(r), ['a', 'b', 'c', 'd']);
  assert.equal(groupOf(r, 'd').id, 'tabs');
});

test('views the live layout added outside the tree join the last tab group', () => {
  const r = regions(layout([{ id: 'root', kind: 'group', children: ['a', 'b'], presentation: { mode: 'split', axis: 'horizontal', weights: [1, 1] } }, view('a'), view('b')], [view('result:x')]));
  assert.deepEqual(r.children[1], { kind: 'tabs', id: 'tabs:b', views: ['b', 'result:x'] });
  assert.deepEqual(regions({ compositionId: 'legacy', version: 1, views: [view('a'), view('b')] }), { kind: 'tabs', id: 'tabs:root', views: ['a', 'b'] });
});

test('a split that loses all but one child collapses to it; missing views are skipped', () => {
  const r = regions({ compositionId: 'c', version: 2, rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['a', 'gone'], presentation: { mode: 'split', axis: 'vertical', weights: [1, 1] } }, view('a'), view('gone')], views: [view('a')] });
  assert.deepEqual(r, { kind: 'tabs', id: 'tabs:a', views: ['a'] });
  assert.equal(regions({ compositionId: 'c', version: 1, views: [] }), null);
});

test('resizing moves one divider and keeps both neighbours above the floor', () => {
  assert.deepEqual(resize([1, 1, 2], 0, 0.1).map(x => Math.round(x * 100) / 100), [1.4, 0.6, 2]);
  const squeezed = resize([1, 1], 0, 0.9);
  assert.ok(squeezed[1] >= 0.24 - 1e-9 && Math.abs(squeezed[0] + squeezed[1] - 2) < 1e-9);
});
