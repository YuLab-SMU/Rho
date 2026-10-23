import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';

test('project configuration, operation authorization and shipped Skills are independent facts', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-capabilities-'));
  const config = { root, stateDir: path.join(root, 'state'), coreBinary: '/nonexistent/core', rscript: '/nonexistent/Rscript', capabilityLimits: { maxReceipts: 2 } };
  let s = await new RhoService(config).start();
  let c = new RhoClient({ url: s.url, token: s.adminToken });
  try {
    const a = await c.call('project.create', { name: 'a' });
    const b = await c.call('project.create', { name: 'b' });
    const call = (m, input = {}) => c.call(m, { projectId: a.id, ...input });
    const catalog = await call('capability.list');
    assert.equal(catalog.plugins.find(p => p.id === 'documents').packagePresent, true);
    assert.equal(catalog.plugins.find(p => p.id === 'documents').uiRenderable, true);
    const cfg = await call('capability.configure', { expectedVersion: 0, changeId: 'documents-only', enabled: ['documents', 'agent'] });
    assert.equal(cfg.version, 1); assert.equal(cfg.receipt.author, 'operator');
    assert.deepEqual(await call('capability.configure', { expectedVersion: 0, changeId: 'documents-only', enabled: ['documents', 'agent'] }), cfg);
    await assert.rejects(call('capability.configure', { expectedVersion: 0, changeId: 'stale', enabled: [] }), e => e.error.kind === 'stale');
    const one = await call('capability.list');
    assert.equal(one.plugins.find(p => p.id === 'tables').projectEnabled, false);
    assert.equal((await c.call('capability.list', { projectId: b.id })).plugins.find(p => p.id === 'tables').projectEnabled, true);
    await assert.rejects(call('data.page', { resource: { id: 'x', version: '0'.repeat(64) }, offset: 0, limit: 1 }), e => e.error.kind === 'unavailable');
    const skills = await call('skill.list');
    assert.ok(skills.some(x => x.id === 'rho.workspace')); assert.ok(skills.some(x => x.id === 'documents.workspace'));
    const docSkill = skills.find(x => x.id === 'documents.workspace');
    assert.equal((await call('skill.read', { skillId: docSkill.id, expectedDigest: docSkill.digest })).digest, docSkill.digest);
    await assert.rejects(call('skill.read', { skillId: docSkill.id, expectedDigest: '0'.repeat(64) }), e => e.error.kind === 'stale');
    const file = path.join(root, 'limited.json');
    await s.agentConnection(a.id, 'limited', file, ['capability.list', 'document.read']);
    const limited = await RhoClient.fromFile(file);
    const visible = await limited.call('capability.list');
    assert.equal(visible.operations.find(x => x.method === 'document.edit').authorized, false);
    await assert.rejects(limited.call('document.open', { path: 'x.md' }), e => e.error.kind === 'unauthorized');
    await assert.rejects(limited.call('capability.list', { projectId: b.id }), e => e.error.kind === 'scope');
    await s.close(); s = await new RhoService(config).start(); c = new RhoClient({ url: s.url, token: s.adminToken });
    assert.equal((await call('capability.list')).configuration.version, 1);
    assert.equal((await call('capability.list')).plugins.find(p => p.id === 'tables').projectEnabled, false);
    for (let version = 1; version < 3; version++) await call('capability.configure', { expectedVersion: version, changeId: 'bounded-' + version, enabled: ['documents', 'agent'] });
    const retention = (await call('capability.list')).configuration;
    assert.equal(retention.retainedReceipts, 2); assert.equal(retention.retainedFromVersion, 2);
    await assert.rejects(call('capability.configure', { expectedVersion: 0, changeId: 'documents-only', enabled: ['documents', 'agent'] }), e => e.error.kind === 'stale');
  } finally { await s.close(); }
});

// Responses where Rho adds facts to an owner's declared output, and what it adds.
// Every other owner response must be the owner's schema unchanged.
// Property order is not part of a contract, so divergence is compared canonically.
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).sort().join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const applicationExtensions = new Set([
  // The application's resource view accepts every registered declaration kind and
  // names the format fields a declaration may carry; the owner's schema stops at the
  // fields its own operation returns.
  'resource.list', 'resource.read', 'resource.register', 'artifact.check', 'data.page', 'data.compare', 'data.plot', 'media.describe', 'object.read',
  // The execution bridge's retained-run report and the application's context package.
  'action.submit', 'requirements.prepare', 'context.create', 'context.read'
]);

test('all loaded operation declarations match v2 business schemas and dependency-disabled projects reject entry calls', async () => {
  const { operations, responses } = await import('../dist/protocol.js');
  const { Plugins } = await import('../dist/plugins.js');
  const plugins = await new Plugins({}).load();
  for (const descriptor of plugins.descriptors()) for (const declaration of descriptor.operations) {
    const wire = structuredClone(operations[declaration.method]);
    delete wire.properties.projectId; wire.required = wire.required.filter(p => p !== 'projectId');
    assert.deepEqual(declaration.inputSchema, wire, declaration.method);
    // A response keeps every fact its owner declares. The application may add its
    // own facts (registered resource kinds, declared namespace/column metadata), and
    // those additions are the only permitted difference: a dropped or renamed owner
    // field would be a contract the owner no longer agrees with.
    const owner = declaration.outputSchema, served = responses[declaration.method];
    const ownerProperties = Object.keys(owner.properties ?? {});
    const servedProperties = Object.keys(served.properties ?? {});
    assert.deepEqual(ownerProperties.filter(name => !servedProperties.includes(name)), [], declaration.method + ' drops an owner field');
    for (const name of owner.required ?? []) assert.ok((served.required ?? []).includes(name), declaration.method + ' stops requiring ' + name);
    if (canonical(owner) !== canonical(served)) {
      assert.ok(applicationExtensions.has(declaration.method), declaration.method + ' changes its owner response without a declared application extension');
    }
  }
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-dependency-'));
  const s = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const c = new RhoClient({ url: s.url, token: s.adminToken });
    const p = await c.call('project.create', { name: 'p' });
    await c.call('capability.configure', { projectId: p.id, expectedVersion: 0, changeId: 'no-files', enabled: ['documents', 'tables', 'charts', 'agent'] });
    const catalog = await c.call('capability.list', { projectId: p.id });
    assert.equal(catalog.plugins.find(x => x.id === 'charts').dependenciesSatisfied, false);
    assert.equal(catalog.operations.find(x => x.method === 'data.plot').state, 'unavailable');
  } finally { await s.close(); await fs.rm(root, { recursive: true, force: true }); }
});
