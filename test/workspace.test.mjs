import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Files } from '@rho-workspace/plugin-files';
import { declarationValidator } from '@rho-workspace/plugin-tables';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { runtime } from '../dist/runtime.js';
const native = await runtime();
test('export/restore verifies actual bytes, drafts, undo, stable selection and unavailable views without execution', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-workspace-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native }).start();
  try {
    const c = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await c.call('project.create', { name: 'source' });
    const call = (m, b = {}) => c.call(m, { projectId: p.id, ...b });
    let d = await call('document.open', { path: 'analysis.R' });
    d = await call('document.edit', { documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: '# 中文 🧬 unsaved\n' }], undoGroup: 'draft' });
    await fs.writeFile(path.join(p.root, 'fixture.csv'), 'gene_id,symbol,baseMean,log2FoldChange\ng1,KLF15,5,2\n');
    const resource = await new Files(p.root, p.id, {}, [declarationValidator]).register('fixture.csv', { operationId: 'contract-fixture', evidence: 'Synthetic transport test, no scientific claim.' }, 'partial', {}, { path: 'fixture.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'gene_id', type: 'string', nullValues: [] }, { name: 'symbol', type: 'string', nullValues: [] }, { name: 'baseMean', type: 'number', nullValues: [''] }, { name: 'log2FoldChange', type: 'number', nullValues: [''] }], key: { column: 'gene_id', namespace: 'fixture-entities' } } });
    const ref = { id: resource.id, version: resource.version };
    await call('selection.set', { resource: ref, entities: ['g1'] });
    const view = { id: 'table', component: 'rho.table', version: '0.2.0', props: { title: 'Result' }, bindings: { data: ref }, selection: ['g1'] };
    await assert.rejects(call('composition.put', { compositionId: 'wrong', expectedVersion: 0, views: [{ ...view, component: 'rho.editor' }], layout: {} }), e => e.error.kind === 'invalid');
    const scatter = { ...view, component: 'rho.scatter', props: { title: 'Explicit axes', x: 'baseMean', y: 'log2FoldChange' } };
    await call('composition.put', { compositionId: 'scatter', expectedVersion: 0, views: [scatter], layout: {} });
    await assert.rejects(call('composition.put', { compositionId: 'bad-scatter', expectedVersion: 0, views: [{ ...scatter, props: { ...scatter.props, x: 'symbol' } }], layout: {} }), e => e.error.kind === 'condition');
    const views = [view, { id: 'missing', component: 'future.view', version: '9.0.0', props: {}, bindings: { data: ref } }, { id: 'editor', component: 'rho.editor', version: '0.2.0', props: { title: 'Script' }, bindings: { document: { documentId: d.id, version: d.version } } }];
    const comp = await call('composition.put', { compositionId: 'workspace', expectedVersion: 0, views, layout: { direction: 'horizontal' } });
    assert.equal(comp.availability.missing.state, 'unavailable');
    await assert.rejects(call('composition.put', { compositionId: 'workspace', expectedVersion: 0, views, layout: {} }), e => e.error.kind === 'stale');
    const exported = await call('workspace.export', { destination: 'export' }); assert.equal(exported.state, 'complete');
    await assert.rejects(call('workspace.export', { destination: 'export' }));
    await assert.rejects(call('workspace.export', { destination: '../other' }), e => e.error.kind === 'scope');
    const q = await c.call('project.create', { name: 'restored' });
    await fs.cp(path.join(p.root, 'export'), path.join(q.root, 'import'), { recursive: true });
    const restored = await c.call('workspace.restore', { projectId: q.id, source: 'import' });
    assert.equal(restored.execution, 'not-replayed'); assert.equal(restored.documents[0].state, 'available');
    assert.equal(restored.resources[0].state, 'available'); assert.equal(restored.selection.state, 'available');
    const draft = await c.call('document.read', { projectId: q.id, documentId: d.id }); assert.equal(draft.content, d.content); assert.equal(draft.undo.length, 1); assert.equal(draft.dirty, true);
    const snapshot = await c.call('observation.snapshot', { projectId: q.id }); assert.equal(snapshot.operations.length, 0); assert.equal(snapshot.host.exitCode, 3); assert.equal(snapshot.compositions.find(c => c.compositionId === 'workspace').views.length, 3);
    assert.equal((await c.call('data.page', { projectId: q.id, resource: ref, offset: 0, limit: 1 })).rows[0].symbol, 'KLF15');
    // Missing artifacts are reported individually; a corrupt existing file is rejected.
    const r = await c.call('project.create', { name: 'missing' });
    await fs.cp(path.join(p.root, 'export'), path.join(r.root, 'import'), { recursive: true });
    const artifact = (await fs.readdir(path.join(r.root, 'import/artifacts')))[0]; await fs.unlink(path.join(r.root, 'import/artifacts', artifact));
    const missing = await c.call('workspace.restore', { projectId: r.id, source: 'import' }); assert.equal(missing.resources[0].state, 'missing'); assert.equal(missing.selection.state, 'unavailable');
    await fs.appendFile(path.join(r.root, 'import/workspace.json'), ' ');
    await assert.rejects(c.call('workspace.restore', { projectId: r.id, source: 'import' }), e => e.error.kind === 'condition');
    assert.deepEqual(await service.close(), []);
  } finally { if (service.server.listening) await service.close(); }
});
test('event gaps, subscription release, request/page/document budgets preserve acknowledged facts', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-budgets-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...native, maxRequestBytes: 512, eventRetention: 2, maxSubscriptions: 1, documents: { maxBufferBytes: 20 } }).start();
  try {
    const c = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await c.call('project.create', { name: 'project' });
    let d = await c.call('document.open', { projectId: p.id, path: 'a.R' });
    for (let i = 0; i < 3; i++) d = await c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'x' }], undoGroup: 'edit-' + i });
    await assert.rejects(c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'x'.repeat(50) }], undoGroup: 'over' }), e => e.error.kind === 'limit' && e.error.details.limit === 'maxBufferBytes');
    await assert.rejects(c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'x'.repeat(1000) }], undoGroup: 'request-over' }), e => e.error.kind === 'limit' && e.error.details.limit === 'maxRequestBytes');
    assert.equal((await c.call('document.read', { projectId: p.id, documentId: d.id })).content, 'xxx');
    const headers = { authorization: 'Bearer ' + service.adminToken };
    const gap = await fetch(service.url + '/api/v1/events?projectId=' + p.id + '&after=0', { headers });
    assert.equal((await gap.json()).error.kind, 'event_gap');
    const snapshot = await c.call('observation.snapshot', { projectId: p.id }); assert.equal(snapshot.cursor, 3); assert.equal(snapshot.host.exitCode, 3);
    const events = await fetch(service.url + '/api/v1/events?projectId=' + p.id + '&after=' + snapshot.cursor, { headers });
    const rejected = await fetch(service.url + '/api/v1/events?projectId=' + p.id + '&after=' + snapshot.cursor, { headers }); assert.equal((await rejected.json()).error.kind, 'limit');
    await events.body.cancel();
    await assert.rejects(fs.stat(path.join(p.root, '.rho/host.sock')), { code: 'ENOENT' });
  } finally { await service.close(); }
});
