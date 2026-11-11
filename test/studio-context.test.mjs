import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { captureUiContext } from '../dist/ui-context.js';

test('Studio workspace deletion is scoped, conditional, reversible and never deletes a recreated layout on retry', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-studio-delete-'));
  let service = await new RhoService({ root, stateDir: path.join(root, 'state'), workspace: { maxCompositions: 3 } }).start();
  try {
    const c = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await c.call('project.create', { name: 'populated-project' });
    await fs.mkdir(path.join(p.root, 'data'));
    await fs.writeFile(path.join(p.root, 'data/counts.csv'), 'sample,count\na,12\n');
    const call = (method, input) => c.call(method, { projectId: p.id, ...input });
    const replace = (id, expectedVersion, changeId, nodes = [{ id: 'root', kind: 'group', children: [] }]) => call('composition.apply', { compositionId: id, expectedVersion, changeId, operations: [{ op: 'replace', rootId: 'root', nodes }] });
    await replace('workspace-2', 0, 'make-2'); await replace('workspace-3', 0, 'make-3');
    // An ordinary Agent grant discovers and invokes the operation without more authority.
    const connection = await service.agentConnection(p.id, 'studio-agent', path.join(root, 'agent.json'));
    const agent = new RhoClient(connection);
    assert.ok(connection.methods.includes('composition.delete'));
    const request = { projectId: p.id, compositionId: 'workspace-3', expectedVersion: 1, changeId: 'delete-3' };
    await assert.rejects(agent.call('composition.delete', { ...request, expectedVersion: 0 }), e => e.error.kind === 'stale');
    const deleted = await agent.call('composition.delete', request);
    assert.equal(deleted.deleted, true); assert.equal(deleted.version, 2);
    assert.equal(deleted.receipt.kind, 'delete');
    assert.deepEqual((await call('observation.snapshot', {})).compositions.map(x => x.compositionId), ['workspace-2']);
    assert.equal((await agent.call('composition.delete', request)).receipt.version, 2);
    await assert.rejects(agent.call('composition.delete', { ...request, expectedVersion: 2 }), e => e.error.kind === 'conflict');
    const undo = await agent.call('composition.undo', { projectId: p.id, compositionId: 'workspace-3', expectedVersion: 2, changeId: 'undo-3' });
    assert.ok(!undo.deleted); assert.equal(undo.version, 3);
    await agent.call('composition.delete', { ...request, expectedVersion: 3, changeId: 'delete-again' });
    const recreated = await replace('workspace-3', 4, 'recreate-3');
    assert.equal(recreated.version, 5); assert.ok(!recreated.deleted);
    const replayed = await agent.call('composition.delete', request);
    assert.equal(replayed.receipt.version, 2); assert.equal(replayed.version, 5); assert.ok(!replayed.deleted);
    assert.ok((await call('observation.snapshot', {})).compositions.some(x => x.compositionId === 'workspace-3'));
    // A workspace goes with its views, as closing them would: a real document and its dirty
    // buffer stay, and undo brings the views back. A protected view keeps its workspace.
    const doc = await call('document.open', { path: 'analysis.R' });
    await call('document.edit', { documentId: doc.id, expectedVersion: doc.version, edits: [{ from: 0, to: 0, insert: '# unsaved\n' }], undoGroup: 'unsaved' });
    const editor = [
      { id: 'root', kind: 'group', children: ['editor'] },
      { id: 'editor', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'analysis.R' }, bindings: { document: { kind: 'live-document', documentId: doc.id } } }
    ];
    await replace('workspace-3', 5, 'put-view', editor);
    const closed = await agent.call('composition.delete', { ...request, expectedVersion: 6, changeId: 'nonempty' });
    assert.equal(closed.deleted, true);
    assert.ok(!(await call('observation.snapshot', {})).compositions.some(x => x.compositionId === 'workspace-3'));
    assert.equal((await call('document.read', { documentId: doc.id })).content, '# unsaved\n');
    const back = await call('composition.undo', { compositionId: 'workspace-3', expectedVersion: 7, changeId: 'undo-nonempty' });
    assert.ok(!back.deleted); assert.deepEqual(back.nodes.find(n => n.id === 'editor')?.bindings, editor[1].bindings);
    await call('view.protection.set', { compositionId: 'workspace-3', expectedVersion: 8, changeId: 'protect-editor', viewId: 'editor', protected: true });
    await assert.rejects(agent.call('composition.delete', { ...request, expectedVersion: 9, changeId: 'protected' }), e => e.error.kind === 'condition');
    await replace('conversation-c-example', 0, 'process');
    await assert.rejects(agent.call('composition.delete', { ...request, compositionId: 'conversation-c-example', changeId: 'process-delete' }), e => e.error.kind === 'condition');
    const other = await c.call('project.create', { name: 'other' });
    await assert.rejects(agent.call('composition.delete', { ...request, projectId: other.id }), e => e.error.kind === 'scope' || e.error.kind === 'unauthorized');
    await call('composition.delete', { compositionId: 'workspace-2', expectedVersion: 1, changeId: 'delete-2' });
    await assert.rejects(replace('extra-identity', 0, 'over-budget'), e => e.error.kind === 'limit');
    const archive = await call('workspace.save', { format: 3 });
    assert.equal(archive.compositions.find(x => x.compositionId === 'workspace-2').deleted, true);
    assert.equal(await fs.readFile(path.join(p.root, 'data/counts.csv'), 'utf8'), 'sample,count\na,12\n');
    const snapshot = await call('observation.snapshot', {});
    assert.equal(snapshot.operations.length, 0); assert.equal(snapshot.host.exitCode, 3);
    await assert.rejects(fs.stat(path.join(p.root, '.rho/host.sock')), { code: 'ENOENT' });
    // Retained deletion and undo survive service restart.
    await service.close();
    service = await new RhoService({ root, stateDir: path.join(root, 'state') }).start();
    const person = new BrowserClient({ url: service.url });
    const kept = await person.call('composition.read', { projectId: p.id, compositionId: 'workspace-2' });
    assert.equal(kept.deleted, true);
    const restored = await person.call('composition.undo', { projectId: p.id, compositionId: 'workspace-2', expectedVersion: kept.version, changeId: 'restore-after-restart' });
    assert.ok(!restored.deleted);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('interface observations bound titles and views, preserve uncertainty and never read a named file', async () => {
  const project = { id: 'project', name: 'Example', root: '/unused' };
  let reads = 0;
  const read = async () => { reads++; return { version: 3, views: Array.from({ length: 40 }, (_, i) => ({ id: 'v' + i, component: 'rho.editor', props: { title: '🧬'.repeat(1000), private: 'not copied' } })) }; };
  const context = await captureUiContext(project, { page: 'studio', compositionId: 'workspace-3', compositionVersion: 1 }, read, { maxUiContextViews: 4, maxUiContextBytes: 1600 });
  assert.equal(reads, 1); assert.equal(context.workspace.state, 'changed');
  assert.ok(context.workspace.omittedViews >= 36); assert.equal(context.workspace.viewCount, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 1600);
  assert.ok(!JSON.stringify(context).includes('not copied'));
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  const unknown = await captureUiContext(project, { page: 'studio', compositionId: 'conversation-abc' }, missing, { maxUiContextViews: 4, maxUiContextBytes: 1600 });
  assert.equal(unknown.workspace.state, 'derived'); assert.equal(unknown.workspace.empty, null);
  await captureUiContext(project, { page: 'file', path: '../a-title-is-not-authority' }, async () => { throw new Error('must not read'); }, { maxUiContextViews: 4, maxUiContextBytes: 1600 });
});
