import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

test('conditional structured composition, protected ancestors, isolated selection and layout-only undo', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-collaboration-'));
  const s = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const c = new RhoClient({ url: s.url, token: s.adminToken });
    const p = await c.call('project.create', { name: 'p' });
    const call = (m, b = {}) => c.call(m, { projectId: p.id, ...b });
    const d = await call('document.open', { path: 'notes.md' });
    const view = { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Notes' }, bindings: { document: { documentId: d.id, version: d.version } } };
    const input = { compositionId: 'work', expectedVersion: 0, changeId: 'first', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['left', 'right'] }, { id: 'left', kind: 'group', children: ['notes'] }, { id: 'right', kind: 'group', children: [] }, view] }] };
    const first = await call('composition.apply', input);
    assert.equal(first.format, 'rho.composition/1'); assert.equal(first.receipt.author, 'operator');
    assert.deepEqual(await call('composition.apply', input), first);
    await assert.rejects(call('composition.apply', { ...input, changeId: 'stale' }), e => e.error.kind === 'stale');
    const protectedState = await call('view.protection.set', { compositionId: 'work', viewId: 'notes', expectedVersion: first.version, changeId: 'protect', protected: true });
    const change = (operations, changeId = 'move') => call('composition.apply', { compositionId: 'work', expectedVersion: protectedState.version, changeId, operations });
    await assert.rejects(change([{ op: 'move', id: 'left', parentId: 'right', index: 0 }]), e => e.error.kind === 'condition');
    await assert.rejects(call('view.close', { compositionId: 'work', viewId: 'notes', expectedVersion: protectedState.version, changeId: 'close' }), e => e.error.kind === 'condition');
    await assert.rejects(call('composition.put', { compositionId: 'work', expectedVersion: protectedState.version, views: [], layout: {} }), e => e.error.kind === 'condition');
    await assert.rejects(change([{ op: 'move', id: 'right', parentId: 'right', index: 0 }], 'cycle'), e => e.error.kind === 'invalid');
    const next = await change([{ op: 'insert', parentId: 'right', index: 0, node: { id: 'free', kind: 'group', children: [] } }], 'valid');
    assert.equal(next.version, protectedState.version + 1);
    await call('document.edit', { documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'human' }], undoGroup: 'human' });
    const undo = await call('composition.undo', { compositionId: 'work', expectedVersion: next.version, changeId: 'undo' });
    assert.equal(undo.nodes.some(n => n.id === 'free'), false); assert.equal(undo.nodes.find(n => n.id === 'notes').protected, true);
    assert.equal((await call('document.read', { documentId: d.id })).content, 'human');
    const agentFile = path.join(root, 'agent.json');
    await s.agentConnection(p.id, 'peer', agentFile, ['interaction.selection.read', 'interaction.selection.set']);
    const agent = await RhoClient.fromFile(agentFile);
    const own = { kind: 'caller' };
    await call('interaction.selection.set', { scope: own, expectedVersion: 0, changeId: 'select', selection: { document: { documentId: d.id, version: 2, from: 0, to: 5 } } });
    assert.equal((await agent.call('interaction.selection.read', { scope: own })).version, 0);
    assert.equal((await call('interaction.selection.read', { scope: own })).version, 1);
    assert.equal((await call('observation.snapshot')).operations.length, 0);
    assert.equal(s.bridge.children?.size ?? 0, 0);
  } finally { await s.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('composition receipt and undo eviction expose boundaries and never make stale replays new work', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-retention-'));
  const s = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', workspace: { maxReceipts: 2, maxUndo: 2 } }).start();
  try {
    const c = new RhoClient({ url: s.url, token: s.adminToken });
    const p = await c.call('project.create', { name: 'p' });
    const call = b => c.call('composition.apply', { projectId: p.id, compositionId: 'work', ...b });
    const original = { expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [] }] }] };
    let state = await call(original);
    for (let n = 0; n < 4; n++) state = await call({ expectedVersion: state.version, changeId: 'insert-' + n, operations: [{ op: 'insert', parentId: 'root', index: n, node: { id: 'g' + n, kind: 'group', children: [] } }] });
    assert.equal(state.history.length, 2); assert.equal(state.receipts.length, 2); assert.equal(state.retainedFromVersion, 4);
    await assert.rejects(call(original), e => e.error.kind === 'stale');
    assert.equal((await c.call('composition.read', { projectId: p.id, compositionId: 'work' })).version, 5);
    const agentFile = path.join(root, 'agent.json');
    await s.agentConnection(p.id, 'limited', agentFile, ['composition.apply']);
    const agent = await RhoClient.fromFile(agentFile);
    await assert.rejects(agent.call('view.protection.set', { compositionId: 'work', viewId: 'missing', expectedVersion: 5, changeId: 'unprotect', protected: false }), e => e.error.kind === 'unauthorized');
  } finally { await s.close(); await fs.rm(root, { recursive: true, force: true }); }
});
