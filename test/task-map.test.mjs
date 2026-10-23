import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { TaskMap } from '../dist/task-map.js';
import { itemsInRange, nearestForm, roleOf, standardForms, term, toneOf, zoom } from '../dist/task-frame.js';

async function fixture(taskMap = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-task-map-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing', taskMap }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.create', { name: 'p' });
  const file = path.join(root, 'agent.json');
  await service.agentConnection(p.id, 'agent', file, ['task.map.read', 'task.map.declare', 'task.map.present', 'task.map.respond']);
  const agent = await RhoClient.fromFile(file);
  const { code } = await operator.call('session.browser.pair', {});
  const grant = (await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code }) })).json()).value;
  const browser = new BrowserClient({ url: service.url, ...grant });
  return { root, service, p, agent, browser, grant, person: (m, b) => browser.call(m, { projectId: p.id, ...b }), cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
// The Agent's own words: none of these kinds or states is known to Rho.
const vocabulary = {
  kinds: { 计算: { label: '计算' }, 检查: { label: '检查' }, 结论: { label: '结论' } },
  states: { 在算: { label: '正在算', role: 'working' }, 等你回话: { label: '等你一句话', role: 'waiting' }, 核对过: { label: '核对过', role: 'done', tone: 'verified' }, 'pending-review': { label: 'Needs a second look', tone: 'lilac' } },
};
const items = [
  { id: 'filter', kind: '计算', state: '核对过', title: '只留 p_adj < 0.05 的基因', group: '准备' },
  { id: 'shrink', kind: '计算', state: '在算', title: '对剩下的基因做收缩估计', group: '估计', progress: { done: 3, total: 1620, unit: 'genes' }, from: ['filter'], view: 'table' },
  { id: 'batch', kind: '检查', state: 'pending-review', title: '两个下调是不是批次造成的', group: '检查', lines: [{ label: '核对过', text: '3 个批次里都是下调' }, { text: '不像批次效应', judgment: true }] },
  { id: 'foxp3', kind: '结论', state: '等你回话', title: '结论里要单独提 FOXP3 吗？', group: '结论' },
  { id: 'volcano', kind: 'plot', state: 'queued', title: 'Volcano plot', group: '呈现' },
];

test('the Agent declares its own kinds and states; people observe them without starting work', async () => {
  const f = await fixture();
  try {
    const declared = await f.agent.call('task.map.declare', { expectedVersion: 0, changeId: 'declare-1', question: '收缩估计之后，上调基因还成立吗？', vocabulary, items, next: ['volcano'] });
    assert.equal(declared.version, 1); assert.equal(declared.items.length, 5);
    assert.deepEqual(await f.agent.call('task.map.declare', { expectedVersion: 0, changeId: 'declare-1', question: '收缩估计之后，上调基因还成立吗？', vocabulary, items, next: ['volcano'] }).then(r => r.receipt), declared.receipt);
    await assert.rejects(f.agent.call('task.map.declare', { expectedVersion: 0, changeId: 'declare-1', items: [] }), e => e.error.kind === 'conflict');
    await assert.rejects(f.agent.call('task.map.declare', { expectedVersion: 0, changeId: 'declare-2', items: [] }), e => e.error.kind === 'stale');
    await assert.rejects(f.agent.call('task.map.declare', { expectedVersion: 1, changeId: 'bad-next', next: ['missing'] }), e => e.error.kind === 'invalid');
    await assert.rejects(f.agent.call('task.map.declare', { expectedVersion: 1, changeId: 'bad-from', items: [{ ...items[0], from: ['filter'] }] }), e => e.error.kind === 'invalid');
    const snapshot = await f.person('observation.snapshot', {});
    const map = snapshot.taskMap;
    assert.equal(map.version, 1); assert.equal(map.limits.agentFormIntervalMs, 8000);
    assert.equal(roleOf(map, map.items[1]), 'working'); assert.equal(roleOf(map, map.items[3]), 'waiting');
    // Undeclared words still render as themselves; unknown tones fall back to neutral drawing.
    assert.equal(term(map, 'kinds', 'plot').label, 'plot'); assert.equal(term(map, 'states', 'queued').label, 'queued');
    assert.equal(toneOf(map, map.items[2]), 'lilac'); assert.equal(toneOf(map, map.items[0]), 'verified');
    assert.deepEqual(map.next, ['volcano']);
    // Reading is observation: no version change, no Host, no native work.
    assert.equal((await f.person('task.map.read', {})).version, 1);
    assert.equal((await f.agent.call('task.map.read', {})).version, 1);
    assert.equal(f.service.bridge.owned.size, 0);
    await assert.rejects(f.person('task.map.declare', { expectedVersion: 1, changeId: 'person', items: [] }), e => e.error.kind === 'unauthorized');
    await assert.rejects(f.agent.call('task.map.respond', { expectedVersion: 1, changeId: 'agent-pin', target: 'map:top', action: 'pin', form: 'summary' }), e => e.error.kind === 'unauthorized');
    assert.ok(f.grant.methods.includes('task.map.present') && !f.grant.methods.includes('task.map.declare'));
    // Removing an item releases its presentation, suggestions and focus.
    const presented = await f.person('task.map.present', { expectedVersion: 1, changeId: 'focus-batch', target: 'item:batch', form: 'summary', focus: 'batch' });
    assert.equal(presented.focus.item, 'batch'); assert.equal(presented.focus.human, true);
    const removed = await f.agent.call('task.map.declare', { expectedVersion: presented.version, changeId: 'drop-batch', remove: ['batch'] });
    assert.equal(removed.presentation['item:batch'], undefined); assert.equal(removed.focus, null); assert.equal(removed.items.length, 4);
  } finally { await f.cleanup(); }
});

test('Agent form changes are attributed, paced into one suggestion, and yield to a person’s pin', async () => {
  const f = await fixture({ agentFormIntervalMs: 60000 });
  try {
    let map = await f.agent.call('task.map.declare', { expectedVersion: 0, changeId: 'declare', vocabulary, items });
    map = await f.agent.call('task.map.present', { expectedVersion: map.version, changeId: 'whole', target: 'map:top', form: 'full', reason: '两项并行' });
    assert.equal(map.receipt.outcome.applied, true);
    assert.equal(map.presentation['map:top'].human, false); assert.equal(map.presentation['map:top'].reason, '两项并行');
    // Inside the interval the change is held back and merged, never applied.
    map = await f.agent.call('task.map.present', { expectedVersion: map.version, changeId: 'compare', target: 'map:top', form: 'compare', params: { left: ['filter'], right: ['filter', 'shrink'] } });
    assert.deepEqual([map.receipt.outcome.applied, map.receipt.outcome.cause], [false, 'budget']);
    map = await f.agent.call('task.map.present', { expectedVersion: map.version, changeId: 'card', target: 'map:top', form: 'card' });
    assert.equal(map.presentation['map:top'].form, 'full');
    assert.equal(map.suggestions.length, 1); assert.equal(map.suggestions[0].merged, 2); assert.equal(map.suggestions[0].form, 'card');
    // Focus is not paced; only form changes protect the layout.
    map = await f.agent.call('task.map.present', { expectedVersion: map.version, changeId: 'agent-focus', target: 'map:top', focus: 'shrink' });
    assert.equal(map.focus.human, false);
    // The person reverts the attributed change: layout only.
    map = await f.person('task.map.respond', { expectedVersion: map.version, changeId: 'revert', target: 'map:top', action: 'revert' });
    assert.equal(map.presentation['map:top'], undefined); assert.equal(map.items.length, 5);
    await assert.rejects(f.person('task.map.respond', { expectedVersion: map.version, changeId: 'revert-again', target: 'map:top', action: 'revert' }), e => e.error.kind === 'condition');
    // Accepting the merged suggestion applies it as the person's choice.
    map = await f.person('task.map.respond', { expectedVersion: map.version, changeId: 'accept', target: 'map:top', action: 'accept', suggestionId: map.suggestions[0].id });
    assert.deepEqual([map.presentation['map:top'].form, map.presentation['map:top'].human, map.presentation['map:top'].suggestedBy.startsWith('agent:')], ['card', true, true]);
    assert.equal(map.suggestions.length, 0);
    // A pin turns every Agent change on that target into a suggestion, budget or not.
    map = await f.person('task.map.respond', { expectedVersion: map.version, changeId: 'pin', target: 'item:shrink', action: 'pin', form: 'summary', params: { subset: 'direction-flipped' } });
    map = await f.agent.call('task.map.present', { expectedVersion: map.version, changeId: 'pinned-try', target: 'item:shrink', form: 'card' });
    assert.deepEqual([map.receipt.outcome.cause, map.presentation['item:shrink'].form, map.presentation['item:shrink'].params.subset], ['pinned', 'summary', 'direction-flipped']);
    map = await f.person('task.map.respond', { expectedVersion: map.version, changeId: 'dismiss', target: 'item:shrink', action: 'dismiss', suggestionId: map.suggestions[0].id });
    assert.equal(map.suggestions.length, 0);
    await assert.rejects(f.person('task.map.present', { expectedVersion: map.version, changeId: 'missing-item', target: 'item:missing', form: 'card' }), e => e.error.kind === 'not_found');
    await assert.rejects(f.person('task.map.present', { expectedVersion: map.version, changeId: 'bad-target', target: 'elsewhere', form: 'card' }), e => e.error.kind === 'invalid');
  } finally { await f.cleanup(); }
});

test('once the configured interval passes the Agent can change the form directly again', async () => {
  // A controlled clock: the budget is about elapsed time, not machine load.
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-task-map-clock-'));
  let now = Date.parse('2026-10-22T10:00:00Z');
  const tasks = new TaskMap({ root, id: 'p' }, { agentFormIntervalMs: 8000 }, () => now);
  try {
    let map = await tasks.declare({ expectedVersion: 0, changeId: 'declare', vocabulary, items }, 'agent:a');
    map = await tasks.present({ expectedVersion: map.version, changeId: 'one', target: 'map:top', form: 'full' }, 'agent:a', false);
    now += 7999;
    map = await tasks.present({ expectedVersion: map.version, changeId: 'two', target: 'map:top', form: 'card' }, 'agent:a', false);
    assert.equal(map.receipt.outcome.cause, 'budget');
    // A person is never paced.
    map = await tasks.present({ expectedVersion: map.version, changeId: 'person', target: 'item:shrink', form: 'summary' }, 'browser:b', true);
    assert.equal(map.receipt.outcome.applied, true);
    now += 1;
    map = await tasks.present({ expectedVersion: map.version, changeId: 'three', target: 'map:top', form: 'summary', params: { range: 'all', axis: 'v' } }, 'agent:a', false);
    assert.equal(map.receipt.outcome.applied, true); assert.equal(map.suggestions.length, 0);
    assert.deepEqual(map.presentation['map:top'].previous, { form: 'full', params: {}, author: 'agent:a', human: false });
    assert.equal(map.lastAgentFormAt, new Date(now).toISOString());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('frame helpers walk declared forms and summary ranges', () => {
  const forms = { card: { scale: 1 }, full: { scale: 3 } };
  assert.equal(nearestForm(forms, 'summary'), 'card'); assert.equal(nearestForm(forms, 'inline'), 'card'); assert.equal(nearestForm(forms, 'full'), 'full');
  assert.equal(zoom(standardForms, 'card', 1), 'summary'); assert.equal(zoom(standardForms, 'inline', -1), null);
  // A comparison shares the summary's scale but is reached only by naming it.
  const named = { ...standardForms, compare: { scale: 2, zoom: false } };
  assert.equal(zoom(named, 'card', 1), 'summary'); assert.equal(zoom(named, 'full', -1), 'summary');
  assert.equal(zoom(named, 'compare', -1), 'card'); assert.equal(zoom(named, 'compare', 1), 'full');
  const map = { vocabulary, items: items.map(i => ({ ...i, author: 'agent', at: '' })) };
  assert.deepEqual(itemsInRange(map, { range: 'around', span: 1 }).map(i => i.id), ['filter', 'shrink', 'batch']);
  assert.deepEqual(itemsInRange(map, { range: 'trail', view: 'table' }).map(i => i.id), ['shrink']);
  assert.equal(itemsInRange(map, {}).length, 5);
});

test('the Agent map entry is plugin-level: it imports only the shared frame contract', async () => {
  const source = await fs.readFile(new URL('../web/agent-map/ui.tsx', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from ['"]([^'"]+)['"]|import ['"]([^'"]+)['"]/g)].map(m => m[1] ?? m[2]);
  assert.deepEqual(imports.sort(), ['../../src/task-frame.js', '../../src/ui-contract.js', './map.css']);
  const entries = JSON.parse(await fs.readFile(new URL('../ui-entries.json', import.meta.url), 'utf8'));
  assert.ok(entries.some(e => e.component === 'rho.agent-map' && e.package === null && e.source === 'web/agent-map/ui.tsx'));
});
