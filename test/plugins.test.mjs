import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { runtime } from '../dist/runtime.js';
import { digest } from '@rho-workspace/plugin-contracts';

test('removing providers preserves drafts, native identity, table bytes and composition; reselecting resumes observation only', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-plugins-'));
  const config = { root, stateDir: path.join(root, 'state'), ...await runtime() };
  let service = await new RhoService(config).start();
  const client = () => new RhoClient({ url: service.url, token: service.adminToken });
  let c = client();
  try {
    const p = await c.call('project.create', { name: 'project' });
    let d = await c.call('document.open', { projectId: p.id, path: 'draft.R' });
    d = await c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: '# retained 中文 🧬\n' }], undoGroup: 'first' });
    const bytes = 'id,x,y\n001,2,3\n'; await fs.writeFile(path.join(p.root, 'table.csv'), bytes);
    const resource = await c.call('resource.register', { projectId: p.id, expectedDigest: digest(bytes), declaration: { path: 'table.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'x', type: 'number', nullValues: [] }, { name: 'y', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'samples' } } } });
    const ref = { id: resource.id, version: resource.version };
    await c.call('selection.set', { projectId: p.id, resource: ref, entities: ['001'] });
    await c.call('composition.put', { projectId: p.id, compositionId: 'views', expectedVersion: 0, views: [{ id: 'scatter', component: 'rho.scatter', version: '0.2.0', props: { title: 'Samples', x: 'x', y: 'y' }, bindings: { data: ref }, selection: ['001'] }], layout: {} });
    const code = 'cat("once\\n",file="entries.txt",append=TRUE)\n'; await fs.writeFile(path.join(p.root, 'run.R'), code);
    const intent = { projectId: p.id, operationId: 'once', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'run.R', digest: digest(code) }, args: [], requirements: [], artifacts: [], completion: null } };
    const accepted = await c.call('action.submit', intent);
    let observed;
    for (let n = 0; n < 100; n++) { observed = await c.call('action.observe', { projectId: p.id, operationId: 'once' }); if (observed.execution === 'completed') break; await setTimeout(20); }
    assert.equal(observed.execution, 'completed');
    await service.close();
    service = await new RhoService({ ...config, plugins: ['documents', 'files'] }).start(); c = client();
    const catalog = await c.call('capability.list', { projectId: p.id });
    assert.deepEqual(catalog.actions, []); assert.deepEqual(catalog.capabilities, ['documents', 'files']);
    assert.equal(catalog.plugins.filter(p => p.state === 'available').length, 2);
    const snapshot = await c.call('observation.snapshot', { projectId: p.id });
    assert.equal(snapshot.documents[0].bytes, Buffer.byteLength(d.content)); assert.equal('content' in snapshot.documents[0], false); assert.equal('undo' in snapshot.documents[0], false);
    assert.deepEqual(snapshot.operations[0].core, accepted.core); assert.deepEqual(snapshot.selection.entities, ['001']);
    assert.equal(snapshot.resources[0].version, ref.version); assert.equal(snapshot.host.exitCode, 3);
    assert.equal(Buffer.from((await c.call('resource.read', { projectId: p.id, resource: ref, offset: 0 })).data, 'base64').toString(), bytes);
    for (const [method, args] of [
      ['data.page', { resource: ref, offset: 0, limit: 10 }],
      ['data.plot', { resource: ref, x: 'x', y: 'y' }],
      ['action.submit', { ...intent, operationId: 'must-not-run' }],
      ['context.create', { document: { documentId: d.id, version: d.version } }]
    ]) await assert.rejects(c.call(method, { projectId: p.id, ...args }), e => e.error.kind === 'unavailable');
    // Re-delivering an already accepted identical intent returns its same facts,
    // even if its provider is now absent. It creates no new execution.
    assert.deepEqual((await c.call('action.submit', intent)).core, accepted.core);
    const kept = await c.call('composition.read', { projectId: p.id, compositionId: 'views' });
    const updated = await c.call('composition.put', { projectId: p.id, compositionId: 'views', expectedVersion: kept.version, views: kept.views, layout: kept.layout });
    assert.equal(updated.availability.scatter.state, 'unavailable'); assert.deepEqual(updated.views[0].bindings.data, ref);
    await c.call('workspace.export', { projectId: p.id, destination: 'export' });
    const target = await c.call('project.create', { name: 'restored' });
    await fs.cp(path.join(p.root, 'export'), path.join(target.root, 'import'), { recursive: true });
    const restored = await c.call('workspace.restore', { projectId: target.id, source: 'import' });
    assert.equal(restored.execution, 'not-replayed'); assert.equal(restored.resources[0].state, 'available'); assert.equal(restored.selection.state, 'unavailable');
    assert.equal((await c.call('document.read', { projectId: target.id, documentId: d.id })).content, d.content);
    await service.close();
    service = await new RhoService({ ...config, plugins: [] }).start(); c = client();
    const absent = await c.call('observation.snapshot', { projectId: p.id });
    assert.equal(absent.documents[0].bytes, Buffer.byteLength(d.content)); assert.equal('content' in absent.documents[0], false); assert.equal(absent.resources[0].version, ref.version);
    assert.deepEqual((await c.call('workspace.save', { projectId: p.id })).documents[0].undo, d.undo);
    await assert.rejects(c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: '?' }], undoGroup: 'absent' }), e => e.error.kind === 'unavailable');
    await service.close();
    service = await new RhoService(config).start(); c = client();
    assert.equal((await c.call('data.page', { projectId: p.id, resource: ref, offset: 0, limit: 10 })).rows[0].id, '001');
    assert.equal((await c.call('document.undo', { projectId: p.id, documentId: d.id, expectedVersion: d.version })).content, '');
    assert.equal(await fs.readFile(path.join(p.root, 'entries.txt'), 'utf8'), 'once\n');
    assert.equal((await c.call('capability.list', { projectId: p.id })).host.exitCode, 3);
  } finally { await service.close(); }
});

test('exported R objects remain usable without requirements, Documents or an R installation', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-object-only-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime(undefined, path.join(root, 'absent-Rscript')), plugins: ['files', 'r'], r: { maxScriptBytes: 8 } }).start();
  try {
    const c = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await c.call('project.create', { name: 'project' });
    const catalog = await c.call('capability.list', { projectId: p.id });
    assert.equal(catalog.plugins.find(p => p.id === 'r').state, 'available');
    assert.equal(catalog.plugins.find(p => p.id === 'r').nativeAvailability.state, 'missing');
    assert.equal(catalog.plugins.find(p => p.id === 'r').nativeAvailability.scope, 'executable-file');
    assert.deepEqual(catalog.actions, []);
    assert.deepEqual(catalog.unavailableActions[0].missing, ['requirements']);
    assert.ok(catalog.capabilities.includes('r-objects'));
    assert.ok(!catalog.capabilities.includes('r-execution'));
    const bytes = '{"value":"中文 🧬"}';
    await fs.writeFile(path.join(p.root, 'object.json'), bytes);
    const resource = await c.call('resource.register', { projectId: p.id, expectedDigest: digest(bytes), declaration: { path: 'object.json', kind: 'object', format: { encoding: 'json', observation: 'exported-snapshot', classes: ['list'] } } });
    assert.equal((await c.call('object.read', { projectId: p.id, resource: { id: resource.id, version: resource.version } })).value.value, '中文 🧬');
    await assert.rejects(c.call('action.submit', { projectId: p.id, operationId: 'unavailable', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'absent.R', digest: digest('') }, args: [], requirements: [], artifacts: [], completion: null } }), e => e.error.kind === 'unavailable');
    const observation = await c.call('observation.snapshot', { projectId: p.id });
    assert.equal(observation.host.exitCode, 3);
    assert.deepEqual(observation.operations, []);
    assert.deepEqual(observation.limits.r, { maxScriptBytes: 8 });
  } finally { await service.close(); }
});
