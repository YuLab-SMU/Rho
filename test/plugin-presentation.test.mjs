import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Plugins } from '../dist/plugins.js';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';
import { pluginEntries, pluginGroups, pluginKinds, pluginMatches, pluginPresentation, viewSubject } from '../dist/plugin-presentation.js';
import { packageFacts } from '../dist/plugin-inventory.js';

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
    assert.equal(service.plugins.descriptors().length, 13);
    for (const descriptor of service.plugins.descriptors()) {
      assert.deepEqual(catalog.plugins.find(p => p.id === descriptor.id).presentation, descriptor.presentation);
      for (const operation of descriptor.operations) assert.deepEqual(catalog.operations.find(o => o.method === operation.method).presentation, operation.presentation);
      for (const component of descriptor.components ?? []) {
        const observed = catalog.components.find(c => c.id === component.id && c.version === component.version);
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
    const denied = snapshot.catalog.operations.find(o => o.method === 'resource.register');
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
  const entries = pluginEntries(catalog, plugin.id);
  assert.equal(entries.actions[0].displayName, 'document.read');
  assert.deepEqual(entries.actions[0].identities, ['document.read']);
  assert.equal(entries.actions[0].readOnly, false);
  assert.equal(entries.views[0].displayName, 'rho.editor');
  assert.equal(entries.views[0].package, 'fixture');
  assert.deepEqual(entries.skills, []);
  assert.equal(entries.operations[0].method, 'document.read');
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
  for (const o of catalog.operations.filter(o => o.owner === 'agent')) assert.ok(actions.some(a => a.identities.includes(o.method)), o.method);
  assert.equal(actions.find(a => a.displayName === catalog.operations.find(o => o.method === 'context.create').presentation.displayName).readOnly, false);
  const reads = actions.find(a => a.displayName === catalog.operations.find(o => o.method === 'binding.activity').presentation.displayName);
  // Native observation append is a metadata write in the existing Activity
  // group; grouping must not present the whole group as read-only.
  assert.equal(reads.readOnly, false); assert.equal(reads.runsCode, false);
  assert.equal(pluginEntries(catalog, 'r').actions.length, 2);
});

test('every selected owner retains its complete entry inventory without activation or Skill content', async () => {
  const full = await new Plugins({}).load(), reduced = await new Plugins({ plugins: [] }).load();
  assert.deepEqual(reduced.availableIds(), []);
  assert.deepEqual(reduced.catalog.operations, []);
  assert.deepEqual(reduced.catalog.skills, []);
  for (const p of full.descriptors()) {
    const retained = reduced.catalog.plugins.find(x => x.id === p.id);
    assert.ok(retained.presentation?.displayName, p.id);
    assert.deepEqual(retained.listing.operations.map(o => o.method), p.operations.map(o => o.method));
    assert.deepEqual(retained.listing.views.map(v => [v.id, v.version]), (p.components ?? []).map(v => [v.id, v.version]));
    assert.deepEqual(retained.listing.skills.map(s => s.id), p.skills.map(s => s.id));
    assert.ok(retained.listing.skills.every(s => !Object.hasOwn(s, 'content')));
    const entries = pluginEntries(reduced.catalog, p.id);
    assert.equal(entries.operations.length, p.operations.length);
    assert.equal(entries.skills.length, p.skills.length);
    assert.equal(entries.views.length, (p.components ?? []).length);
  }
  assert.ok(pluginMatches(full.catalog, full.catalog.plugins.find(p => p.id === 'kernel'), 'data flow'));
  assert.ok(pluginMatches(full.catalog, full.catalog.plugins.find(p => p.id === 'kernel'), 'kernel.session'));
  assert.ok(pluginMatches(full.catalog, full.catalog.plugins.find(p => p.id === 'documents'), 'PreToolUse'));
  assert.deepEqual(full.catalog.plugins.find(p => p.id === 'agent').listing.mcp.tools.map(t => t.name), ['rho_index', 'rho_resolve', 'rho_call', 'rho_read']);
});

test('live views replace their retained descriptions by exact identity and version', () => {
  const plugin = { id: 'documents', package: 'owner', version: '3', listing: { views: [{ id: 'reader', version: '1', ui: './ui' }, { id: 'reader', version: '2', ui: './ui' }] } };
  const catalog = { plugins: [plugin], operations: [], components: [{ id: 'reader', version: '1', pluginId: 'documents', ui: './ui', uiPackage: 'reader-package', uiPackageVersion: '4', presentation: { displayName: 'Reader' } }] };
  const views = pluginEntries(catalog, 'documents').views;
  assert.equal(views.length, 2);
  assert.equal(views[0].displayName, 'Reader'); assert.equal(views[0].package, 'reader-package');
  assert.equal(views[1].displayName, 'reader'); assert.equal(views[1].version, '2');
  assert.ok(pluginMatches(catalog, plugin, 'reader-package'));
});

test('plugin kinds name each way a plugin is reached from declared or installed entries, never from its name', async () => {
  const catalog = (await new Plugins({}).load()).catalog;
  const kinds = id => pluginKinds(catalog.plugins.find(p => p.id === id), pluginEntries(catalog, id));
  const names = id => kinds(id).map(k => k.kind);
  assert.deepEqual(names('documents'), ['ui', 'mcp', 'skills', 'claude-code']);
  assert.deepEqual(names('files'), ['page', 'mcp', 'skills']);
  assert.equal(kinds('files')[0].label, 'No view');
  assert.equal(kinds('console')[0].label, 'Rho page');
  assert.equal(kinds('annotations')[0].kind, 'ui');
  assert.equal(pluginKinds({ id: 'x', package: 'fixture', state: 'available', presentation: { viewNote: 'Inside other views' } }, pluginEntries({ plugins: [], operations: [], components: [], actions: [] }, 'x'))[0].label, 'In other views');
  assert.deepEqual(names('kernel'), ['ui', 'mcp', 'skills']);
  assert.equal(kinds('kernel')[0].count, 6);
  // The Agent package links command-line programs in its own manifest; the catalog records them as read.
  const agent = kinds('agent');
  assert.deepEqual(agent.map(k => k.kind), ['ui', 'mcp', 'skills', 'mcp-server', 'cli']);
  const cli = agent.find(k => k.kind === 'cli');
  assert.ok(cli.count >= 1 && cli.detail.includes('rho-agent-mcp'), cli.detail);
  assert.equal(agent.find(k => k.kind === 'mcp-server').count, catalog.plugins.find(p => p.id === 'agent').listing.mcp.tools.length);
  const facts = await packageFacts('@rho-workspace/plugin-agent');
  assert.equal(facts.version, catalog.plugins.find(p => p.id === 'agent').packageVersion);
  assert.ok(facts.cli.includes('rho-agent-mcp'));
  assert.deepEqual(await packageFacts('@rho-workspace/no-such-plugin'), { cli: [] });
  // Without owner copy or a linked command there is only the honest default.
  const bare = pluginKinds({ id: 'x', package: 'fixture', state: 'available' }, pluginEntries({ plugins: [], operations: [], components: [], actions: [] }, 'x'));
  assert.deepEqual(bare, [{ kind: 'page', label: 'No view', detail: 'No view of its own; your Agent uses it' }]);
  for (const [view, expected] of [[{ id: 'rho.editor', bindings: { document: 'document' } }, 'document'], [{ id: 'markdown.reader', bindings: { document: 'document' } }, 'markdown'], [{ id: 'html.reader', bindings: { document: 'document' } }, 'html'],
    [{ id: 'rho.scatter', bindings: { data: 'table' } }, 'table'], [{ id: 'rho.media', bindings: { data: 'media' } }, 'media'], [{ id: 'rho.object', bindings: { data: 'object' } }, 'object'], [{ id: 'rho.feedback', bindings: { draft: 'document' } }, 'draft'], [{ id: 'rho.notebook', bindings: {} }, 'none']]) assert.equal(viewSubject(view), expected, view.id);
});
