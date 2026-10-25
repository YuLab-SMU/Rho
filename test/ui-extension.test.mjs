import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUiPlugin } from '../scripts/ui-plugin.mjs';
import { readUiPackage, extensionPackages } from '../scripts/ui-selection.mjs';
import { validateUiExtension, uiExtensionLimits } from '../dist/ui-extension.js';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-ui-author-'));
  const directory = path.join(root, 'notes');
  await createUiPlugin(directory, { name: '@example/notes', component: 'example.notes' });
  await fs.mkdir(path.join(directory, 'dist'));
  // The backend must never execute the UI module to discover its component.
  await fs.writeFile(path.join(directory, 'dist/ui.js'), 'throw new Error("UI module executed on the server");');
  const entry = readUiPackage(directory);
  return { root, directory, entry, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
test('a scaffold creates an independent typed view without overwriting existing work', async () => {
  const f = await fixture();
  try {
    assert.equal(f.entry.component, 'example.notes');
    assert.equal(f.entry.package, '@example/notes');
    assert.match(await fs.readFile(path.join(f.directory, 'src/ui.tsx'), 'utf8'), /@rho-workspace\/local\/ui-contract/);
    const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const toolchain = JSON.parse(await fs.readFile(new URL('../scripts/ui-toolchain.json', import.meta.url), 'utf8'));
    for (const [name, version] of Object.entries(toolchain)) assert.equal(version, packageJson.devDependencies[name]);
    await assert.rejects(createUiPlugin(f.directory), { code: 'EEXIST' });
    assert.equal(extensionPackages(path.join(f.directory, 'rho-selection.json'))[0].localOverride, true);
    const selection = { format: 'rho.ui-selection/1', packages: [{ package: '@example/notes', version: '99.0.0', directory: '.' }] };
    await fs.writeFile(path.join(f.directory, 'rho-selection.json'), JSON.stringify(selection));
    assert.throws(() => extensionPackages(path.join(f.directory, 'rho-selection.json')), /identity\/version mismatch/);
  } finally { await f.cleanup(); }
});
test('metadata refuses reserved identities, executable fields, external schema references and escaped entry files', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ component: 'rho.editor' }, { operations: [] }, { propsSchema: { type: 'object', $ref: 'https://example.invalid/schema' } }, { development: '../secret.tsx' }, { export: 'View;alert(1)' }, { requiredOperations: ['document.read', 'document.read'] }]) assert.throws(() => validateUiExtension({ ...f.entry.extension, ...patch }), /UI extension/);
    assert.throws(() => validateUiExtension({ ...f.entry.extension, description: 'x'.repeat(uiExtensionLimits.maxManifestBytes) }), /maxManifestBytes/);
    await fs.writeFile(path.join(f.root, 'outside.js'), 'private');
    await fs.rm(path.join(f.directory, 'dist/ui.js')); await fs.symlink(path.join(f.root, 'outside.js'), path.join(f.directory, 'dist/ui.js'));
    assert.throws(() => readUiPackage(f.directory), /inside its package/);
  } finally { await f.cleanup(); }
});
test('a selected UI entry uses existing document authority, validates props and bindings, and remains readable after removal', async () => {
  const f = await fixture(); let service;
  try {
    const webRoot = path.join(f.root, 'web'); await fs.mkdir(webRoot);
    await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>test</title>');
    const { source, directory, ...installed } = f.entry;
    const manifest = { format: 'rho.web-build/1', ownerEntries: [installed] };
    await fs.writeFile(path.join(webRoot, 'composition.json'), JSON.stringify(manifest));
    const config = { root: path.join(f.root, 'projects'), stateDir: path.join(f.root, 'state'), coreBinary: '/missing', rscript: '/missing', webRoot };
    await fs.mkdir(config.root);
    service = await new RhoService(config).start();
    const client = new CheckedClient({ url: service.url, token: service.adminToken });
    const project = await client.call('project.create', { name: 'author-test' });
    const call = (method, args = {}) => client.call(method, { projectId: project.id, ...args });
    await fs.writeFile(path.join(project.root, 'notes.md'), '共享内容 🧬');
    const document = await call('document.open', { path: 'notes.md' });
    const catalog = await call('capability.list');
    const component = catalog.components.find(c => c.id === 'example.notes');
    assert.equal(component.pluginId, 'documents');
    assert.equal(component.uiPackage, '@example/notes');
    assert.ok(!catalog.operations.some(o => o.method.startsWith('example.')));
    const view = { id: 'notes', kind: 'view', component: 'example.notes', version: '1.0.0', props: { title: 'Notes' }, bindings: { document: { kind: 'live-document', documentId: document.id } } };
    const apply = candidate => call('composition.apply', { compositionId: 'author', expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['notes'] }, candidate] }] });
    await assert.rejects(apply({ ...view, props: { title: 4 } }), e => e.error.kind === 'invalid');
    await assert.rejects(apply({ ...view, bindings: {} }), e => e.error.kind === 'invalid');
    await apply(view);
    assert.equal((await call('composition.read', { compositionId: 'author' })).availability.notes.state, 'entry-installed');
    const other = await client.call('project.create', { name: 'other' });
    await fs.writeFile(path.join(other.root, 'private.md'), 'Other project');
    const otherDocument = await client.call('document.open', { projectId: other.id, path: 'private.md' });
    await assert.rejects(call('composition.apply', { compositionId: 'author', expectedVersion: 1, changeId: 'foreign', operations: [{ op: 'bind', id: 'notes', bindings: { document: { kind: 'live-document', documentId: otherDocument.id } } }] }));
    const pair = await client.call('session.browser.pair', {});
    const paired = await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { origin: service.url, 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code }) })).json();
    assert.ok(!paired.value.methods.includes('resource.register'));
    assert.equal(service.bridge.owned.size, 0);
    await service.close(); service = null;
    await fs.writeFile(path.join(webRoot, 'composition.json'), JSON.stringify({ ...manifest, ownerEntries: [] }));
    service = await new RhoService(config).start();
    const restored = new CheckedClient({ url: service.url, token: service.adminToken });
    const layout = await restored.call('composition.read', { projectId: project.id, compositionId: 'author' });
    assert.equal(layout.views[0].component, 'example.notes');
    // composition.read retains the original transaction facts; current availability
    // comes from the live catalog, without rewriting that record on observation.
    assert.equal(service.plugins.viewAvailability('example.notes', '1.0.0').state, 'unavailable');
    assert.ok(!(await restored.call('capability.list', { projectId: project.id })).components.some(c => c.id === 'example.notes'));
    assert.equal((await restored.call('document.read', { projectId: project.id, documentId: document.id })).content, '共享内容 🧬');
    assert.equal(service.bridge.owned.size, 0);
  } finally { await service?.close(); await f.cleanup(); }
});
