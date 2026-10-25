import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Plugins } from '../dist/plugins.js';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { pluginEntries, pluginGroups, pluginPresentation } from '../dist/plugin-presentation.js';

test('browser catalogs and snapshots preserve owner presentation through project and permission enrichment', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-presentation-'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    const project = await operator.call('project.create', { name: 'project' });
    const pairing = await service.browser.createPairing();
    const paired = await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code: pairing.code }) });
    const { value } = await paired.json();
    const browser = new BrowserClient({ url: service.url, ...value });
    const catalog = await browser.call('capability.list', { projectId: project.id });
    assert.equal(service.plugins.descriptors().length, 9);
    for (const descriptor of service.plugins.descriptors()) {
      assert.deepEqual(catalog.plugins.find(p => p.id === descriptor.id).presentation, descriptor.presentation);
      for (const operation of descriptor.operations) assert.deepEqual(catalog.operations.find(o => o.method === operation.method).presentation, operation.presentation);
      for (const component of descriptor.components ?? []) {
        const observed = catalog.components.find(c => c.id === component.id);
        assert.equal(observed.pluginId, descriptor.id);
        assert.deepEqual(observed.presentation, component.presentation);
      }
      for (const action of descriptor.actions ?? []) {
        const observed = catalog.actions.find(a => a.id === action.id);
        assert.equal(observed.pluginId, descriptor.id);
        assert.deepEqual(observed.presentation, action.presentation);
      }
    }
    const disabledId = service.plugins.availableIds()[0];
    await operator.call('capability.configure', { projectId: project.id, changeId: 'disabled', expectedVersion: 0, enabled: service.plugins.availableIds().filter(id => id !== disabledId) });
    const snapshot = await browser.call('observation.snapshot', { projectId: project.id });
    const disabled = snapshot.catalog.plugins.find(p => p.id === disabledId);
    assert.equal(disabled.projectEnabled, false);
    assert.deepEqual(disabled.presentation, catalog.plugins.find(p => p.id === disabledId).presentation);
    for (const operation of snapshot.catalog.operations.filter(o => o.owner === disabledId)) {
      assert.equal(operation.state, 'unavailable');
      assert.deepEqual(operation.presentation, catalog.operations.find(o => o.method === operation.method).presentation);
    }
    const denied = snapshot.catalog.operations.find(o => o.method === 'artifact.check');
    assert.equal(denied.authorized, false);
    assert.deepEqual(denied.presentation, catalog.operations.find(o => o.method === denied.method).presentation);
    assert.equal(snapshot.host.exitCode, 3);
    assert.equal(service.bridge.owned.size, 0);
    const source = await fs.readFile(new URL('../web/plugins.tsx', import.meta.url), 'utf8');
    for (const descriptor of service.plugins.descriptors()) {
      assert.ok(!source.includes(descriptor.presentation.tagline));
      for (const prompt of descriptor.presentation.examplePrompts) assert.ok(!source.includes(prompt));
    }
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('missing presentation shows the plugin ID and empty fields, never inferred copy or access markers', () => {
  const plugin = { id: 'documents', package: 'fixture', state: 'available' };
  assert.deepEqual(pluginPresentation(plugin), { displayName: 'documents', tagline: '', category: '', examplePrompts: [], viewNote: '', readOnly: undefined, runsCode: undefined });
  assert.deepEqual(pluginPresentation({ ...plugin, presentation: {} }), pluginPresentation(plugin));
  assert.deepEqual(pluginGroups([plugin]), [{ category: '', plugins: [plugin] }]);
  const catalog = { plugins: [plugin], operations: [{ method: 'document.read', owner: plugin.id, effect: 'read' }], components: [{ id: 'rho.editor', pluginId: plugin.id, version: '1', ui: 'unavailable' }], actions: [{ id: 'r.execute', pluginId: plugin.id }] };
  assert.deepEqual(pluginEntries(catalog, plugin.id), { actions: [], skills: [], views: [{ id: 'rho.editor', version: '1', ui: 'unavailable', displayName: '', description: '', readOnly: undefined, runsCode: undefined }] });
  const partial = pluginPresentation({ ...plugin, presentation: { displayName: 'Owner name', tagline: 'Owner copy' } });
  assert.equal(partial.displayName, 'Owner name'); assert.equal(partial.category, ''); assert.deepEqual(partial.examplePrompts, []);
});

test('unavailable actions retain their own copy; grouped operations do not mislabel writes as read-only', async () => {
  const plugins = await new Plugins({ plugins: ['files', 'r'] }).load();
  const unavailable = plugins.catalog.unavailableActions[0];
  assert.deepEqual(unavailable.presentation, plugins.descriptor('r').actions[0].presentation);
  assert.equal(unavailable.pluginId, 'r');
  assert.equal(unavailable.presentation.runsCode, true);
  assert.equal(plugins.catalog.plugins.find(p => p.id === 'documents').presentation.displayName, 'Documents');
  assert.equal(plugins.catalog.operations.some(o => o.owner === 'documents'), false);
  assert.equal(plugins.catalog.skills.some(s => s.id === 'documents.workspace'), false);
  const catalog = (await new Plugins({}).load()).catalog;
  const actions = pluginEntries(catalog, 'agent').actions;
  assert.equal(actions.length, 4);
  assert.equal(actions.find(a => a.displayName === catalog.operations.find(o => o.method === 'context.create').presentation.displayName).readOnly, false);
  const reads = actions.find(a => a.displayName === catalog.operations.find(o => o.method === 'binding.activity').presentation.displayName);
  // Native observation append is a metadata write in the existing Activity
  // group; grouping must not present the whole group as read-only.
  assert.equal(reads.readOnly, false); assert.equal(reads.runsCode, false);
  assert.equal(pluginEntries(catalog, 'r').actions.length, 2);
});
