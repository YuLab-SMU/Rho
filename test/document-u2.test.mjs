import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { Documents } from '@rho-workspace/plugin-documents';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-u2-contract-'));
  const config = { root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing' };
  const s = await new RhoService(config).start();
  t.after(async () => { if (s.server.listening) await s.close(); await fs.rm(root, { recursive: true, force: true }); });
  let starts = 0, dispatches = 0;
  s.bridge.ensureOwnedHost = async () => { starts++; throw new Error('Unexpected Host start'); };
  const nativeCall = s.bridge.call.bind(s.bridge);
  s.bridge.call = async (root, method, ...args) => {
    if (method === 'submit') { dispatches++; throw new Error('Unexpected native dispatch'); }
    return nativeCall(root, method, ...args);
  };
  const c = new CheckedClient({ url: s.url, token: s.adminToken });
  const p = await c.call('project.create', { name: 'source' });
  return { root, config, s, c, p, call: (m, b = {}) => c.call(m, { projectId: p.id, ...b }), native: () => ({ starts, dispatches }) };
}

test('typed Fetch document calls preserve original requests after lost HTTP replies and concurrent retries', async t => {
  const f = await fixture(t);
  // Exercise SDK transport with an operator test credential. Shipped browser
  // grants remain read-only until the frontend input/recovery adapter is ready.
  let lose = '';
  const sdk = new BrowserClient({ url: f.s.url, token: f.s.adminToken }, async (...args) => {
    const result = await fetch(...args);
    if (lose && String(args[0]).endsWith('/' + lose)) { lose = ''; await result.text(); throw new TypeError('injected lost reply'); }
    return result;
  });
  const d = await sdk.call('document.open', { projectId: f.p.id, path: 'notes.md' });
  const edit = { projectId: f.p.id, documentId: d.id, expectedVersion: d.version, expectedRevision: d.revision, changeId: 'edit', undoGroup: 'typing', edits: [{ from: 0, to: 0, insert: '中文 🧬' }] };
  lose = 'document.edit'; await assert.rejects(sdk.call('document.edit', edit), /lost reply/);
  const duplicates = await Promise.all([sdk.call('document.edit', edit), sdk.call('document.edit', edit)]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  const e = duplicates[0]; assert.equal(e.content, '中文 🧬'); assert.equal(e.revision, 1); assert.equal(e.undo.length, 1);
  const save = { projectId: f.p.id, documentId: d.id, expectedVersion: e.version, expectedRevision: e.revision, changeId: 'save', expectedDiskDigest: null };
  lose = 'document.save'; await assert.rejects(sdk.call('document.save', save), /lost reply/);
  const saved = await sdk.call('document.save', save); assert.equal(saved.revision, 2); assert.equal(saved.dirty, false);
  const undo = { projectId: f.p.id, documentId: d.id, expectedVersion: saved.version, expectedRevision: saved.revision, changeId: 'undo' };
  lose = 'document.undo'; await assert.rejects(sdk.call('document.undo', undo), /lost reply/);
  const undone = await sdk.call('document.undo', undo); assert.equal(undone.revision, 3); assert.equal(undone.content, '');
  for (const input of [{ ...edit, changeId: undefined }, { ...edit, expectedRevision: undefined }]) await assert.rejects(f.c.call('document.edit', input), e => e.error.kind === 'invalid');
  const pair = await f.s.browser.createPairing();
  const grant = await BrowserClient.pair(f.s.url, pair.code, (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: f.s.url } }));
  const browser = new BrowserClient(grant);
  assert.equal((await browser.call('document.read', { projectId: f.p.id, documentId: d.id })).revision, 3);
  await assert.rejects(browser.call('document.edit', edit), e => e.error.kind === 'unauthorized');
  // Test the future dispatch guard with an intentionally injected test grant;
  // BrowserAccess itself still refuses to issue such a grant.
  const principal = f.s.state.principals.find(p => p.kind === 'browser');
  principal.methods.push('document.edit');
  const guarded = await f.call('document.open', { path: 'guarded.md' });
  const guardedEdit = { projectId: f.p.id, documentId: guarded.id, expectedVersion: 1, undoGroup: 'guard', edits: [{ from: 0, to: 0, insert: 'guarded' }] };
  await assert.rejects(browser.call('document.edit', guardedEdit), e => e.error.kind === 'invalid');
  await browser.call('document.edit', { ...guardedEdit, expectedRevision: 0, changeId: 'guarded' });
  await f.c.call('session.browser.revoke', { sessionId: principal.id });
  await assert.rejects(browser.call('document.edit', { ...guardedEdit, expectedRevision: 0, changeId: 'guarded' }), e => e.error.kind === 'unauthorized');
  assert.deepEqual(f.native(), { starts: 0, dispatches: 0 });
  await f.s.close();
  const restarted = await new RhoService(f.config).start();
  t.after(() => restarted.close());
  const reconnected = new CheckedClient({ url: restarted.url, token: restarted.adminToken });
  assert.deepEqual(await reconnected.call('document.undo', undo), undone);
  assert.equal((await reconnected.call('document.read', { projectId: f.p.id, documentId: d.id })).revision, 3);
});

test('live editor bindings follow a buffer without changing exact-version bindings or protected layout', async t => {
  const f = await fixture(t);
  const d = await f.call('document.open', { path: 'notes.md' });
  const view = (id, binding) => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: id }, bindings: { document: binding } });
  const live = { kind: 'live-document', documentId: d.id };
  const create = (id, views) => f.call('composition.apply', { compositionId: id, expectedVersion: 0, changeId: 'create-' + id, operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: views.map(v => v.id) }, ...views] }] });
  const first = await create('work', [view('live-a', live), view('live-b', live), view('exact', { documentId: d.id, version: 1 })]);
  const protectedLayout = await f.call('view.protection.set', { compositionId: 'work', expectedVersion: first.version, changeId: 'protect', viewId: 'live-a', protected: true });
  const edited = await f.call('document.edit', { documentId: d.id, expectedVersion: 1, expectedRevision: 0, changeId: 'typing', undoGroup: 'a', edits: [{ from: 0, to: 0, insert: 'human' }] });
  await create('live-after-edit', [view('live', live)]);
  await assert.rejects(create('stale-exact', [view('exact', { documentId: d.id, version: 1 })]), e => e.error.kind === 'stale');
  for (const binding of [{ ...live, version: edited.version }, { kind: 'live-document', documentId: '0'.repeat(64) }]) await assert.rejects(create('invalid', [view('bad', binding)]));
  await assert.rejects(create('unknown-component', [{ ...view('bad', live), component: 'future.editor' }]), e => e.error.kind === 'invalid');
  const retained = await f.call('composition.read', { compositionId: 'work' });
  assert.equal(retained.version, protectedLayout.version); assert.equal(retained.nodes.find(n => n.id === 'live-a').protected, true);
  assert.equal(retained.views.find(v => v.id === 'exact').bindings.document.version, 1);
  assert.deepEqual(retained.views.find(v => v.id === 'live-a').bindings.document, live);
  const legacy = await fetch(f.s.url + '/api/v1/document.read', { method: 'POST', headers: { authorization: 'Bearer ' + f.s.adminToken, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: f.p.id, documentId: d.id }) }).then(r => r.json());
  assert.equal(legacy.ok, true); assert.equal('revision' in legacy.value, false);
  const oldLayout = await fetch(f.s.url + '/api/v1/composition.read', { method: 'POST', headers: { authorization: 'Bearer ' + f.s.adminToken, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: f.p.id, compositionId: 'work' }) }).then(r => r.json());
  assert.equal(oldLayout.error.kind, 'unavailable');
  await f.call('workspace.export', { destination: 'export', format: 3 });
  const q = await f.c.call('project.create', { name: 'restored' });
  await fs.cp(path.join(f.p.root, 'export'), path.join(q.root, 'import'), { recursive: true });
  const report = await f.c.call('workspace.restore', { projectId: q.id, source: 'import' });
  assert.equal(report.documents[0].state, 'available');
  const restored = await f.c.call('document.read', { projectId: q.id, documentId: d.id });
  assert.equal(restored.revision, edited.revision); assert.deepEqual(restored.receipts, edited.receipts);
  assert.deepEqual((await f.c.call('composition.read', { projectId: q.id, compositionId: 'work' })).views[0].bindings.document, live);
  assert.deepEqual(f.native(), { starts: 0, dispatches: 0 });
});

test('a pending save that can no longer complete is abandoned over HTTP without writing disk or granting the browser', async t => {
  const f = await fixture(t);
  const d = await f.call('document.open', { path: 'stuck.md' });
  const edited = await f.call('document.edit', { documentId: d.id, expectedVersion: 1, expectedRevision: 0, changeId: 'draft', undoGroup: 'a', edits: [{ from: 0, to: 0, insert: '草稿 🧬' }] });
  // Interrupt a save after its intent is durable, as a process crash would.
  const owner = new Documents(f.p.root); const persist = owner.persist.bind(owner);
  owner.persist = async state => { await persist(state); if (state.pendingSave) throw new Error('injected crash before replacement'); };
  await assert.rejects(owner.save(d.id, edited.version, null, 'operator', { changeId: 'save', expectedRevision: edited.revision }), /injected crash/);
  const pending = await f.call('document.read', { documentId: d.id });
  const input = { documentId: d.id, expectedVersion: pending.version, expectedRevision: pending.revision, changeId: 'give-up', pendingRequestDigest: pending.pendingSave.requestDigest };
  await assert.rejects(f.call('document.abandonSave', input), e => e.error.kind === 'condition', 'a resumable save is not dropped');
  await fs.writeFile(path.join(f.p.root, 'stuck.md'), 'outside');
  for (const missing of ['changeId', 'pendingRequestDigest']) await assert.rejects(f.call('document.abandonSave', { ...input, [missing]: undefined }), e => e.error.kind === 'invalid');
  const pair = await f.s.browser.createPairing();
  const browser = new BrowserClient(await BrowserClient.pair(f.s.url, pair.code, (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: f.s.url } })));
  await assert.rejects(browser.call('document.abandonSave', { projectId: f.p.id, ...input }), e => e.error.kind === 'unauthorized');
  const abandoned = await f.call('document.abandonSave', input);
  assert.equal(abandoned.pendingSave, undefined); assert.equal(abandoned.receipt.kind, 'abandon-save');
  assert.equal(abandoned.content, edited.content); assert.equal(abandoned.dirty, true);
  assert.deepEqual(await f.call('document.abandonSave', input), abandoned);
  assert.equal(await fs.readFile(path.join(f.p.root, 'stuck.md'), 'utf8'), 'outside');
  await f.call('document.edit', { documentId: d.id, expectedVersion: abandoned.version, expectedRevision: abandoned.revision, changeId: 'after', undoGroup: 'b', edits: [{ from: 0, to: 0, insert: '+' }] });
  assert.deepEqual(f.native(), { starts: 0, dispatches: 0 });
});
