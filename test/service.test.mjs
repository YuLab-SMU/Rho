import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { runtime } from '../dist/runtime.js';
const native = await runtime();
test('HTTP auth, origins, scope, project read has no Host, and two callers share one buffer', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-service-'));
  const unavailableR = await runtime(native.coreBinary, path.join(root, 'missing-Rscript'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...unavailableR, eventRetention: 2 }).start();
  try {
    const human = new RhoClient({ url: service.url, token: service.adminToken });
    const project = await human.call('project.create', { name: 'project' });
    const opened = await human.call('project.open', { path: 'project' });
    assert.equal(opened.host.exitCode, 3);
    assert.equal((await human.call('requirements.check', { projectId: project.id, action: 'airway.analyze' })).status, 'unknown');
    await assert.rejects(human.call('action.submit', { projectId: project.id, operationId: 'missing-r', action: 'airway.analyze', actionVersion: '0.1.0', input: { bootstrapReplicates: 1 } }), e => e.error.kind === 'condition');
    await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
    let response = await fetch(service.url + '/api/v1/project.list', { method: 'POST', headers: { authorization: 'Bearer ' + service.adminToken, 'content-type': 'application/json', origin: 'http://unrelated.invalid' }, body: '{}' });
    assert.equal(response.status, 403);
    response = await fetch(service.url + '/api/v1/project.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    const descriptor = await service.agentConnection(project.id, 'external-a', path.join(root, 'agent.json'), ['protocol.describe', 'binding.activity', 'document.open', 'document.read', 'document.edit', 'action.lookup']);
    const agent = new RhoClient(descriptor);
    await assert.rejects(agent.call('project.open', { path: '..' }), e => e.error.kind === 'unauthorized');
    await assert.rejects(agent.call('document.open', { path: '.rho/rho/operations/secret.json' }), e => e.error.kind === 'scope');
    await assert.rejects(agent.call('document.open', { path: '.git/config' }), e => e.error.kind === 'scope');
    await assert.rejects(human.call('project.open', { path: 'project/.rho' }), e => e.error.kind === 'scope');
    const first = await human.call('document.open', { projectId: project.id, path: 'analysis.R' });
    const edited = await agent.call('document.edit', { documentId: first.id, expectedVersion: first.version, edits: [{ from: 0, to: 0, insert: '# 中文 🧬\nx <- 1\n' }], undoGroup: 'agent-1' });
    assert.equal((await human.call('document.read', { projectId: project.id, documentId: first.id })).content, edited.content);
    await assert.rejects(agent.call('document.edit', { documentId: first.id, expectedVersion: first.version, edits: [{ from: 0, to: 0, insert: 'stale' }], undoGroup: 'old' }), e => e.error.kind === 'stale');
    const activity = await agent.call('binding.activity', {});
    assert.ok(activity.entries.some(e => e.method === 'document.edit' && e.returnedVersion === edited.version));
    assert.ok(activity.entries.some(e => e.method === 'document.edit' && e.errorKind === 'stale'));
    assert.ok(activity.entries.every(e => !('input' in e) && !('token' in e)));
    const other = await human.call('project.create', { name: 'other' });
    await assert.rejects(agent.call('document.read', { projectId: other.id, documentId: first.id }), e => e.error.kind === 'scope');
    await fs.symlink(root, path.join(project.root, 'linked'));
    await assert.rejects(agent.call('document.open', { path: 'linked/agent.json' }), e => e.error.kind === 'scope');
  } finally { await service.close(); }
});

test('one writer per service and project; failed startup releases its own locks', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-leases-'));
  const first = await new RhoService({ root, stateDir: path.join(root, 'one'), ...native }).start();
  let second, third;
  try {
    const c = new RhoClient({ url: first.url, token: first.adminToken });
    await c.call('project.create', { name: 'project' });
    await assert.rejects(new RhoService({ root, stateDir: path.join(root, 'one'), ...native }).start(), e => e.kind === 'conflict');
    second = await new RhoService({ root, stateDir: path.join(root, 'two'), ...native }).start();
    const d = new RhoClient({ url: second.url, token: second.adminToken });
    await assert.rejects(d.call('project.open', { path: 'project' }), e => e.error.kind === 'conflict');
    // A listen failure must not leave a live helper holding the new state lock.
    const port = Number(new URL(first.url).port);
    await assert.rejects(new RhoService({ root, stateDir: path.join(root, 'three'), ...native, port }).start(), { code: 'EADDRINUSE' });
    third = await new RhoService({ root, stateDir: path.join(root, 'three'), ...native }).start();
    await first.close();
    const reopened = await d.call('project.open', { path: 'project' });
    assert.equal(reopened.host.exitCode, 3);
  } finally {
    if (first.server.listening) await first.close();
    await second?.close(); await third?.close();
  }
});

test('long native socket paths fail with an explicit condition before Host startup', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-long-'));
  const project = path.join(root, 'project-' + 'x'.repeat(80)); await fs.mkdir(project);
  const { CoreBridge } = await import('../dist/bridge.js');
  const bridge = new CoreBridge(native.coreBinary, native.rscript);
  await assert.rejects(bridge.ensureOwnedHost(await fs.realpath(project)), e => e.kind === 'condition' && e.details.nativeCondition === 'unix-socket-path-bytes');
  await assert.rejects(fs.stat(path.join(project, '.rho/host.sock')), { code: 'ENOENT' });
  assert.deepEqual(await bridge.close(), []);
});
