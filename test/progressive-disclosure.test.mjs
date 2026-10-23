import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { connectMcp, mcpEnvelope, resolveOperation } from '../scripts/mcp-consumer.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-progressive-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', plugins: ['documents', 'agent'] }).start();
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await operator.call('project.create', { name: 'project' });
  return { root, service, operator, project };
}

test('runtime protocol inspection pages authorized summaries and selects just one complete contract', async t => {
  const { root, service, operator, project } = await fixture(t);
  const first = await operator.call('protocol.describe', { limit: 2, maxBytes: 2048 });
  assert.equal(first.entries.length, 2); assert.ok(first.next); assert.equal('operations' in first, false);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 2048);
  const second = await operator.call('protocol.describe', { limit: 2, cursor: first.next, maxBytes: 2048 });
  assert.ok(second.entries.every(e => !first.entries.some(f => f.method === e.method)));
  const connection = path.join(root, 'connection.json');
  await service.agentConnection(project.id, 'reader', connection, ['protocol.describe', 'document.read']);
  const agent = await RhoClient.fromFile(connection);
  const index = await agent.call('protocol.describe', {});
  assert.ok(index.entries.every(e => ['protocol.describe', 'document.read', 'capability.index', 'capability.resolve'].includes(e.method)));
  const selected = await agent.call('protocol.describe', { method: 'document.read', maxBytes: 65536 });
  assert.deepEqual(selected.entries, []); assert.equal(selected.contract.method, 'document.read');
  assert.ok(selected.contract.inputSchema && selected.contract.outputSchema);
  await assert.rejects(agent.call('protocol.describe', { method: 'session.grant' }), e => e.error.kind === 'scope');
  await assert.rejects(agent.call('protocol.describe', { cursor: first.next }), e => e.error.kind === 'stale');
  await assert.rejects(operator.call('protocol.describe', { method: 'action.submit', maxBytes: 1024 }), e => e.error.kind === 'limit');
  // The service publishes one contract. A retired version path is refused as an
  // unknown operation rather than answered from a second schema set.
  const retired = await fetch(service.url + '/api/v1/protocol.describe', { method: 'POST', headers: { authorization: 'Bearer ' + operator.connection.token, 'content-type': 'application/json' }, body: '{}' }).then(r => r.json());
  assert.equal(retired.error.kind, 'not_found'); assert.ok(JSON.stringify(retired).length < 1024);
  assert.equal(service.bridge.owned.size, 0);
});

test('snapshot omits document bodies; default MCP pages an exact large reply without rerunning its source operation', async t => {
  const { root, service, operator, project } = await fixture(t);
  const content = '中文 🧬 <>&\n'.repeat(10000);
  await fs.writeFile(path.join(project.root, 'large.md'), content);
  const doc = await operator.call('document.open', { projectId: project.id, path: 'large.md' });
  const snapshot = await operator.call('observation.snapshot', { projectId: project.id });
  const summary = snapshot.documents[0];
  assert.equal(summary.bytes, Buffer.byteLength(content));
  for (const name of ['content', 'undo', 'history', 'receipts']) assert.equal(name in summary, false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.documents)) < 1024);
  const connection = path.join(root, 'connection.json');
  await service.agentConnection(project.id, 'reader', connection, ['document.read']);
  let reads = 0;
  const dispatch = service.dispatch.bind(service);
  service.dispatch = (request, ...args) => { if (request.method === 'document.read') reads++; return dispatch(request, ...args); };
  const client = await connectMcp(fileURLToPath(new URL('..', import.meta.url)), connection);
  t.after(() => client.close());
  const resolved = await resolveOperation(client, 'document.read');
  const result = await mcpEnvelope(client, 'rho_call', { operation: 'document.read', contractRef: resolved.entry.contractRef, input: { documentId: doc.id }, maxBytes: 1024 });
  assert.equal(result.ok, true); assert.ok(result.result.ref); assert.equal(reads, 1);
  const ref = result.result.ref;
  const shape = await mcpEnvelope(client, 'rho_read', { ref, path: '/value', maxBytes: 2048 });
  assert.ok(shape.value.entries.some(e => e.key === 'content' && e.type === 'string' && !('value' in e)));
  let offset = 0, joined = '';
  do {
    const page = await mcpEnvelope(client, 'rho_read', { ref, path: '/value/content', offset, maxBytes: 4096 });
    assert.equal(page.ok, true); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    joined += page.value.value; offset = page.value.next;
  } while (offset !== null);
  assert.equal(joined, content); assert.equal(reads, 1);
  await operator.call('capability.configure', { projectId: project.id, expectedVersion: 0, changeId: 'off', enabled: ['agent'] });
  assert.equal((await mcpEnvelope(client, 'rho_read', { ref, path: '/value/content' })).error.kind, 'scope');
  assert.equal(reads, 1); assert.equal(service.bridge.owned.size, 0);
});
