import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { BrowserClient } from '../dist/browser.js';

// A person opens a project folder and reads their own files in it. The tab lists one
// bounded level and opens a text file; it still may not register resources, save or run.
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-entries-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  await fs.mkdir(path.join(root, 'work', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'notes.R'), 'base <- 1\n');
  await fs.writeFile(path.join(root, 'work', 'data.csv'), 'id,value\na,1\n');
  await fs.writeFile(path.join(root, 'work', 'nested', 'deeper.txt'), 'x\n');
  await fs.writeFile(path.join(root, 'work', 'notes.R.duplicate'), 'base <- 2\n');
  await fs.symlink(path.join(root, '../escape'), path.join(root, 'work', 'link')).catch(() => {});
  const p = await operator.call('project.open', { path: 'work' });
  const { code } = await operator.call('session.browser.pair', {});
  const grant = (await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code }) })).json()).value;
  const browser = new BrowserClient({ url: service.url, ...grant });
  return { root, service, p, browser, operator, cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('a person lists their own project folder one level, without owner state or links', async () => {
  const f = await fixture();
  try {
    const listed = await f.browser.call('project.entries', { projectId: f.p.id });
    assert.deepEqual(listed.entries.map(entry => entry.path), ['data.csv', 'nested', 'notes.R', 'notes.R.duplicate']);
    assert.deepEqual(listed.entries.map(entry => entry.kind), ['file', 'folder', 'file', 'file']);
    // No owner state, no followed symlink, no recursion into the subfolder.
    assert.ok(listed.entries.every(entry => !entry.path.startsWith('.rho')));
    assert.ok(!listed.entries.some(entry => entry.path === 'link'));
    assert.ok(!listed.entries.some(entry => entry.path.includes('deeper')));
    assert.equal(listed.truncated, false);
    assert.equal(listed.path, '');
    // Folders are navigable without leaving the project root.
    const nested = await f.browser.call('project.entries', { projectId: f.p.id, path: 'nested' });
    assert.deepEqual(nested.entries.map(entry => entry.path), ['nested/deeper.txt']);
    assert.equal(nested.path, 'nested');
    await assert.rejects(f.browser.call('project.entries', { projectId: f.p.id, path: '..' }), e => ['scope', 'invalid', 'not_found'].includes(e.error.kind));
    assert.equal(listed.entries.find(entry => entry.path === 'notes.R').bytes, 10);
    // Listing is a read: it opens nothing.
    assert.deepEqual((await f.browser.call('observation.snapshot', { projectId: f.p.id })).documents, []);
  } finally { await f.cleanup(); }
});

test('opening a file shows it once and keeps the person confined to their project', async () => {
  const f = await fixture();
  try {
    const opened = await f.browser.call('project.openFile', { projectId: f.p.id, path: 'notes.R', compositionId: 'workspace', expectedVersion: 0, changeId: 'open-1' });
    assert.equal(opened.document.path, 'notes.R');
    assert.equal(opened.document.content, 'base <- 1\n');
    const views = opened.composition.views;
    assert.equal(views.length, 1);
    assert.equal(views[0].bindings.document.documentId, opened.document.id);
    // Opening the same file again folds into the same view instead of stacking tabs.
    const again = await f.browser.call('project.openFile', { projectId: f.p.id, path: 'notes.R', compositionId: 'workspace', expectedVersion: opened.composition.version, changeId: 'open-2' });
    assert.equal(again.composition.views.length, 1);
    assert.equal(again.viewId, opened.viewId);
    // A second file gets its own view and the first one is kept.
    const other = await f.browser.call('project.openFile', { projectId: f.p.id, path: 'data.csv', compositionId: 'workspace', expectedVersion: again.composition.version, changeId: 'open-3' });
    assert.equal(other.composition.views.length, 2);
    // Escaping the project root is refused, not silently resolved.
    await assert.rejects(f.browser.call('project.openFile', { projectId: f.p.id, path: '../outside.R', compositionId: 'workspace', expectedVersion: other.composition.version, changeId: 'open-4' }), e => ['scope', 'not_found', 'invalid'].includes(e.error.kind));
    await assert.rejects(f.browser.call('project.openFile', { projectId: f.p.id, path: '.rho/rho/task-map.json', compositionId: 'workspace', expectedVersion: other.composition.version, changeId: 'open-5' }), e => e.error.kind === 'scope');
    // Reading a folder is not permission to declare resources or execute.
    await assert.rejects(f.browser.call('resource.register', { projectId: f.p.id }), e => e.error.kind === 'unauthorized');
    await assert.rejects(f.browser.call('action.retry', { projectId: f.p.id, operationId: 'x' }), e => e.error.kind === 'unauthorized');
    await assert.rejects(f.browser.call('action.submit', { projectId: f.p.id }), e => e.error.kind === 'invalid');
  } finally { await f.cleanup(); }
});

test('the person at this machine opens a folder with the native dialog and reads it', async () => {
  const f = await fixture();
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'rho-entries-local-'));
  try {
    const chosen = await fs.realpath(await fs.mkdtemp(path.join(outside, 'picked-')));
    await fs.writeFile(path.join(chosen, 'table.csv'), 'id,value\na,1\n');
    // No credential: the tab is this machine's own person, whose access does not expire.
    const local = new BrowserClient({ url: f.service.url });
    assert.ok(f.service.state.principals.some(p => p.id === 'browser:local' && !p.expiresAt));
    f.service.folderPicker.choose = async () => chosen;
    const picked = await local.call('project.pick', {});
    assert.equal(picked.cancelled, false);
    assert.equal(picked.project.root, chosen);
    // The folder the person chose is the folder they can list and open from.
    assert.deepEqual((await local.call('project.entries', { projectId: picked.project.id })).entries.map(entry => entry.name), ['table.csv']);
    const opened = await local.call('project.openFile', { projectId: picked.project.id, path: 'table.csv', compositionId: 'workspace', expectedVersion: 0, changeId: 'open-picked' });
    assert.equal(opened.document.content, 'id,value\na,1\n');
    // Cancelling still changes nothing.
    f.service.folderPicker.choose = async () => null;
    assert.deepEqual(await local.call('project.pick', {}), { cancelled: true, project: null });
  } finally { await f.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});

test('entries and openFile stay inside the folder this tab was granted', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'other'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'other', 'secret.txt'), 'no\n');
    const otherProject = await f.operator.call('project.open', { path: 'other' });
    // A credential narrowed to `work` must not reach a sibling project's files.
    const narrowed = await f.operator.call('session.browser.pair', { path: 'work' });
    const grant = (await (await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.service.url }, body: JSON.stringify({ code: narrowed.code }) })).json()).value;
    const tab = new BrowserClient({ url: f.service.url, ...grant });
    const mine = await tab.call('project.open', { path: '.' });
    assert.equal(mine.id, f.p.id);
    await assert.rejects(tab.call('project.entries', { projectId: otherProject.id }), e => ['scope', 'unauthorized', 'not_found'].includes(e.error.kind));
    await assert.rejects(tab.call('project.openFile', { projectId: otherProject.id, path: 'secret.txt', compositionId: 'workspace', expectedVersion: 0, changeId: 'cross' }), e => ['scope', 'unauthorized', 'not_found'].includes(e.error.kind));
  } finally { await f.cleanup(); }
});

// A project made from source folders keeps its own (internal) directory; the folders a
// person chose are the work. They are listed through the project, never merged into it.
async function workspaceFixture() {
  const f = await fixture();
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'rho-entries-source-'));
  return {
    ...f, outside,
    cleanup: async () => { await f.cleanup(); await fs.rm(outside, { recursive: true, force: true }); },
  };
}

test('a project made from source folders lists them, descends into them and opens their files', async () => {
  const f = await workspaceFixture();
  try {
    const folder = await fs.realpath(await fs.mkdtemp(path.join(f.outside, 'airquality-')));
    await fs.writeFile(path.join(folder, 'readings.csv'), 'month,ozone\n5,24.1\n');
    await fs.writeFile(path.join(folder, 'readings.R'), 'd <- read.csv("readings.csv")\n');
    await fs.mkdir(path.join(folder, 'scripts'));
    await fs.writeFile(path.join(folder, 'scripts', 'clean.R'), '# clean\n');
    f.service.folderPicker.choose = async () => folder;
    const { selection } = await f.browser.call('project.source.pick', {});
    const project = await f.browser.call('project.createWorkspace', { name: 'Airquality study', selectionIds: [selection.selectionId], changeId: 'create-source' });
    const call = (method, input = {}) => f.browser.call(method, { projectId: project.id, ...input });
    // A source keeps the stable ID its root digest gives it, not the one-time selection receipt.
    const [source] = project.sources;
    assert.equal(source.root, folder);
    // The project's own folder is empty; the chosen folder appears beside its contents.
    const root = await call('project.entries');
    assert.deepEqual(root.entries.map(entry => [entry.name, entry.kind]), [[source.name, 'folder']]);
    const listed = root.entries.find(entry => entry.kind === 'folder');
    assert.equal(listed.path, '@' + source.id);
    assert.equal(listed.bytes, 0);
    assert.equal(root.path, '');
    // Descending through the alias lists the folder itself, under the same addressing
    // project.openFile accepts.
    const inside = await call('project.entries', { path: listed.path });
    assert.deepEqual(inside.entries.map(entry => entry.name).sort(), ['readings.R', 'readings.csv', 'scripts']);
    assert.ok(inside.entries.every(entry => entry.path.startsWith(listed.path + '/')));
    assert.equal(inside.path, listed.path);
    const nested = await call('project.entries', { path: listed.path + '/scripts' });
    assert.deepEqual(nested.entries.map(entry => entry.path), [listed.path + '/scripts/clean.R']);
    // Opening a file from the source folder places one editor view for it.
    const opened = await call('project.openFile', { path: listed.path + '/readings.R', compositionId: 'workspace', expectedVersion: 0, changeId: 'open-source' });
    assert.equal(opened.document.path, listed.path + '/readings.R');
    assert.equal(opened.document.content, 'd <- read.csv("readings.csv")\n');
    assert.equal(opened.composition.views.length, 1);
    // A folder that is not part of this project, a parent step and an absolute path stay refused.
    await assert.rejects(call('project.entries', { path: '@not-a-source' }), e => e.error.kind === 'scope');
    await assert.rejects(call('project.entries', { path: listed.path + '/../..' }), e => ['scope', 'invalid', 'not_found'].includes(e.error.kind));
    await assert.rejects(call('project.entries', { path: '/etc' }), e => ['scope', 'invalid', 'not_found'].includes(e.error.kind));
    // Internal state of the project never appears, and listing opens nothing.
    assert.ok(!inside.entries.some(entry => entry.path.includes('.rho')));
    assert.deepEqual((await call('observation.snapshot')).documents.map(document => document.path), [listed.path + '/readings.R']);
  } finally { await f.cleanup(); }
});

test('a source folder that moved is reported instead of followed to whatever is there now', async () => {
  const f = await workspaceFixture();
  try {
    const folder = await fs.realpath(await fs.mkdtemp(path.join(f.outside, 'moved-')));
    await fs.writeFile(path.join(folder, 'notes.md'), '# notes\n');
    f.service.folderPicker.choose = async () => folder;
    const { selection } = await f.browser.call('project.source.pick', {});
    const project = await f.browser.call('project.createWorkspace', { name: 'Moved study', selectionIds: [selection.selectionId], changeId: 'create-moved' });
    const alias = '@' + project.sources[0].id;
    assert.deepEqual((await f.browser.call('project.entries', { projectId: project.id, path: alias })).entries.map(entry => entry.name), ['notes.md']);
    const moved = folder + '-elsewhere';
    await fs.rename(folder, moved).catch(() => {});
    await fs.symlink(moved, folder).catch(() => {});
    await assert.rejects(f.browser.call('project.entries', { projectId: project.id, path: alias }), e => e.error.kind === 'scope');
    await fs.unlink(folder).catch(() => {});
    await assert.rejects(f.browser.call('project.entries', { projectId: project.id, path: alias }), e => e.error.kind === 'scope');
    // The project still lists the folder it was made from; only reading it is refused.
    const listed = await f.browser.call('project.entries', { projectId: project.id });
    assert.deepEqual(listed.entries.map(entry => entry.path), [alias]);
  } finally { await f.cleanup(); }
});
