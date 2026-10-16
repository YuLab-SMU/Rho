import { Files } from '@rho-workspace/plugin-files';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Ajv } from 'ajv';
import { canonical, digest } from '@rho-workspace/plugin-contracts';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { responseEnvelope } from '../dist/legacy-protocol.js';
import { runtime } from '../dist/runtime.js';
test('v1 retained frozen requests and resource bytes stay observable without recipes or Host startup', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-legacy-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), ...await runtime() }).start();
  try {
    const current = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await current.call('project.create', { name: 'project' });
    const old = new RhoClient({ ...current.connection, apiVersion: '1.0' });
    const request = { projectId: p.id, operationId: 'retained-v1', action: 'airway.analyze', actionVersion: '0.1.0', input: { bootstrapReplicates: 1 } };
    const core = { caller: 'retained-native-caller', requestId: 'retained-native-request' };
    const run = { operationId: request.operationId, principal: 'operator', projectId: p.id, requestDigest: digest(canonical(request)), request, action: request.action, actionVersion: request.actionVersion, acceptedAt: new Date().toISOString(), core, delivery: 'answered', execution: 'active', native: null, integrity: { state: 'incomplete' }, domain: { state: 'unchecked' }, interpretation: { state: 'absent' }, plan: { code: 'stop("frozen historical source must never be replayed by reads")', args: ['retained-native-argument'], source: { kind: 'historical-acceptance-fixture' }, output: 'retained-artifacts' } };
    const directory = path.join(p.root, '.rho/rho/operations'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, digest(canonical(['operator', p.id, request.operationId])) + '.json'), JSON.stringify(run));
    await fs.writeFile(path.join(p.root, 'retained.txt'), 'retained bytes');
    const resources = new Files(p.root, p.id);
    const resource = await resources.register('retained.txt', { operationId: run.operationId }, 'partial');
    // Simulate the old registry's descriptor, preserving its native resource ID.
    await fs.writeFile(path.join(p.root, '.rho/plugins/resources.json'), JSON.stringify([{ ...resource, format: 'text' }]));
    const ajv = new Ajv({ strict: false, allowUnionTypes: true });
    for (const method of ['action.lookup', 'action.observe', 'action.retry', 'resource.list']) {
      const reply = await old.envelope(method, { projectId: p.id, operationId: run.operationId });
      const validate = ajv.compile(responseEnvelope(method)); assert.ok(validate(reply), JSON.stringify(validate.errors));
      if (method === 'resource.list') assert.equal(reply.value.resources[0].id, resource.id);
      else { assert.deepEqual(reply.value.core, core); assert.equal(reply.value.action, request.action); assert.equal(reply.value.plan.codeDigest, digest(run.plan.code)); }
    }
    assert.equal((await current.call('capability.list', { projectId: p.id })).host.exitCode, 3);
    const bytes = await old.call('resource.read', { projectId: p.id, resource: { id: resource.id, version: resource.version }, offset: 0, maxBytes: 64 });
    assert.equal(Buffer.from(bytes.data, 'base64').toString(), 'retained bytes');
    assert.equal('format' in bytes.resource, false);
    await assert.rejects(old.call('action.submit', request), e => e.error.kind === 'unavailable');
  } finally { await service.close(); }
});
