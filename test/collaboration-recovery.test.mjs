import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { ObservationClient } from '../dist/observation.js';

test('format 3 retains collaboration, rejects lossy older exports and reports absent owners', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-archive3-'));
  const config = { root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing' };
  let s = await new RhoService(config).start();
  let c = new RhoClient({ url: s.url, token: s.adminToken });
  try {
    const p = await c.call('project.create', { name: 'source' });
    const call = (m, b = {}) => c.call(m, { projectId: p.id, ...b });
    let d = await call('document.open', { path: 'notes.md' });
    d = await call('document.edit', { documentId: d.id, expectedVersion: 1, edits: [{ from: 0, to: 0, insert: 'feedback 🧬' }], undoGroup: 'init' });
    const annotation = await call('annotation.create', { annotationId: 'a', changeId: 'a', expectedVersion: 0, anchor: { kind: 'document', documentId: d.id, version: 2, from: 9, to: 11 }, draft: { documentId: d.id, version: 2 } });
    const context = await call('context.create', { changeId: 'context', expectedVersion: 0, annotations: [{ annotationId: 'a', version: 1 }] });
    assert.equal((await call('observation.snapshot')).contexts[0].delivery, 'not-fetched');
    assert.equal((await call('context.read', { contextId: context.contextId })).responses[0].state, 'no-linked-response');
    await call('annotation.reply', { annotationId: 'a', changeId: 'reply', expectedVersion: 1, replyTo: annotation.messages[0].id, draft: { documentId: d.id, version: 2 } });
    assert.equal((await call('context.read', { contextId: context.contextId })).responses[0].state, 'explicit-linked-response');
    assert.equal((await call('observation.snapshot')).contexts[0].responses[0].state, 'explicit-linked-response');
    await assert.rejects(call('workspace.export', { destination: 'lossy' }), e => e.error.kind === 'condition');
    await call('workspace.export', { destination: 'export', format: 3 });
    const q = await c.call('project.create', { name: 'restored' });
    await fs.cp(path.join(p.root, 'export'), path.join(q.root, 'import'), { recursive: true });
    const corrupt = await c.call('project.create', { name: 'corrupt' });
    const importDir = path.join(corrupt.root, 'import');
    await fs.cp(path.join(p.root, 'export'), importDir, { recursive: true });
    const metadata = JSON.parse(await fs.readFile(path.join(importDir, 'workspace.json'), 'utf8'));
    metadata.annotations[0].messages[1].replyTo = 'absent';
    const bytes = Buffer.from(JSON.stringify(metadata));
    await fs.writeFile(path.join(importDir, 'workspace.json'), bytes);
    const manifest = JSON.parse(await fs.readFile(path.join(importDir, 'manifest.json'), 'utf8'));
    Object.assign(manifest.inventory.find(f => f.path === 'workspace.json'), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await fs.writeFile(path.join(importDir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(c.call('workspace.restore', { projectId: corrupt.id, source: 'import' }), e => e.error.kind === 'invalid');
    assert.deepEqual((await c.call('observation.snapshot', { projectId: corrupt.id })).documents, []);
    await s.close(); s = await new RhoService(config).start(); c = new RhoClient({ url: s.url, token: s.adminToken });
    assert.equal((await call('annotation.read', { annotationId: 'a' })).version, 2);
    const restored = await c.call('workspace.restore', { projectId: q.id, source: 'import' });
    assert.equal(restored.execution, 'not-replayed'); assert.equal(restored.annotations[0].state, 'available');
    assert.equal((await c.call('annotation.read', { projectId: q.id, annotationId: 'a' })).source.text, '🧬');
    const missing = await c.call('project.create', { name: 'missing' });
    await fs.cp(path.join(p.root, 'export'), path.join(missing.root, 'import'), { recursive: true });
    await s.close(); s = await new RhoService({ ...config, plugins: [] }).start(); c = new RhoClient({ url: s.url, token: s.adminToken });
    const partial = await c.call('workspace.restore', { projectId: missing.id, source: 'import' });
    assert.equal(partial.annotations[0].state, 'unavailable'); assert.equal(partial.documents[0].state, 'unavailable');
    assert.equal(partial.retainedArchive, 'import');
  } finally { await s.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('DOM-free observation reads snapshots before reconnect and after invalidations', async () => {
  let cursor = 0, calls = 0;
  const transport = { snapshot: async () => ({ cursor, value: ++calls }), events: async function* () { cursor++; yield { cursor, type: 'document.changed' }; } };
  const observer = new ObservationClient(transport, { maxReconnects: 1, reconnectDelayMs: 0 });
  const stream = observer.observe();
  assert.equal((await stream.next()).value.value, 1);
  assert.equal((await stream.next()).value.value, 2);
  assert.equal((await stream.next()).value.value, 3);
  await stream.return();
});

test('failed event publication interrupts observers without undoing acknowledged state', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-event-failure-'));
  const s = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const c = new RhoClient({ url: s.url, token: s.adminToken });
    const p = await c.call('project.create', { name: 'p' });
    const d = await c.call('document.open', { projectId: p.id, path: 'notes.md' });
    const stream = await fetch(s.url + '/api/v2/events?projectId=' + p.id + '&after=0', { headers: { authorization: 'Bearer ' + s.adminToken } });
    const eventFile = path.join(p.root, '.rho/rho/events.json');
    // Reads see a valid ring; atomically replacing the directory then fails.
    // Inject failure at the publication boundary, not at document persistence.
    const original = s.events.bind(s);
    s.events = async project => { const retained = await original(project); await fs.mkdir(eventFile); return retained; };
    const edited = await c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: 1, edits: [{ from: 0, to: 0, insert: 'acknowledged' }], undoGroup: 'write' });
    assert.equal(edited.content, 'acknowledged');
    assert.ok((await stream.text()).includes('event: gap'));
    s.events = original; await fs.rmdir(eventFile);
    assert.equal((await c.call('observation.snapshot', { projectId: p.id })).documents[0].bytes, Buffer.byteLength('acknowledged'));
    assert.equal((await c.call('document.read', { projectId: p.id, documentId: d.id })).content, 'acknowledged');
  } finally { await s.close(); await fs.rm(root, { recursive: true, force: true }); }
});
