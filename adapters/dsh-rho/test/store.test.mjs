import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResultStore, defaults } from '../lib/store.mjs';

const input = { path: 'summary.csv', title: 'Group means', columns: [{ name: 'group', type: 'string' }, { name: 'mean', type: 'number' }], key: 'group' };
async function fixture(t, limits) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rho-dsh-')));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const store = new ResultStore(project, path.join(root, 'state'), limits);
  await store.start();
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(project, 'summary.csv'), 'group,mean\nalpha,3.5\nbeta,8.25\n');
  return { root, project, store, session: { id: 'original-dsh-session', cwd: project } };
}

test('a row question preserves captured bytes after overwrite and restarts', async t => {
  const { store, project, session } = await fixture(t);
  const first = await store.present(session, 'call-1', input);
  await fs.writeFile(path.join(project, 'summary.csv'), 'group,mean\nalpha,999\nbeta,1\n');
  const page = await store.call(session, 'data.page', { resource: first.resource });
  assert.equal(page.rows[0].mean, 3.5);
  const question = await store.question(session, first.resource, ['alpha'], '为什么这一组较低？');
  assert.match(question.text, /3\.5/); assert.doesNotMatch(question.text, /999/);
  assert.match(question.text, /为什么/); assert.match(question.text, new RegExp(first.resource.version));
  await store.close(); await store.start();
  assert.equal((await store.list(session)).results.length, 1);
  assert.deepEqual((await store.call(session, 'data.page', { resource: first.resource })).rows, page.rows);
});

test('original tool retries return the original snapshot and changed reuse is refused', async t => {
  const { store, project, session } = await fixture(t);
  const first = await store.present(session, 'call-1', input);
  const second = await store.present(session, 'call-2', { ...input, title: 'Another presentation' });
  assert.equal(second.resource.id, first.resource.id);
  const question = await store.question(session, second.resource, ['alpha'], 'Why?', 'call-2');
  assert.match(question.text, /Another presentation/);
  await assert.rejects(store.question(session, second.resource, ['alpha'], 'Why?', 'missing'), /not part/);
  await fs.unlink(path.join(project, 'summary.csv'));
  assert.deepEqual(await store.present(session, 'call-1', input), first);
  await assert.rejects(store.present(session, 'call-1', { ...input, title: 'Different' }), /different content/);
  assert.equal((await store.list(session)).results.length, 2);
});

test('session, project, path and entity boundaries reject mismatches', async t => {
  const { store, project, root, session } = await fixture(t);
  const first = await store.present(session, 'call-1', input);
  await assert.rejects(store.call({ ...session, id: 'another' }, 'data.page', { resource: first.resource }), /not part/);
  await assert.rejects(store.list({ ...session, cwd: root }), /outside/);
  await fs.writeFile(path.join(root, 'outside.csv'), 'group,mean\nsecret,123\n');
  await fs.symlink(path.join(root, 'outside.csv'), path.join(project, 'linked.csv'));
  await assert.rejects(store.present(session, 'call-2', { ...input, path: '../outside.csv' }));
  await assert.rejects(store.present(session, 'call-3', { ...input, path: 'linked.csv' }));
  await assert.rejects(store.question(session, first.resource, ['missing'], 'Why?'), /stable entity keys/);
  await assert.rejects(store.call(session, 'kernel.run', { resource: first.resource }), /not exposed/);
});

test('budgets refuse extra work without discarding the earlier result', async t => {
  const { store, session } = await fixture(t, { ...defaults, maxResults: 1 });
  const first = await store.present(session, 'call-1', input);
  await assert.rejects(store.present(session, 'call-2', input), /limit/);
  await assert.rejects(store.question(session, first.resource, Array(21).fill('alpha'), 'Why?'), /20 rows/);
  assert.equal((await store.list(session)).results[0].resource.id, first.resource.id);
});

test('a second archive owner is refused', async t => {
  const { store, project } = await fixture(t);
  await assert.rejects(new ResultStore(project, store.stateDir).start(), /Another Rho service holds/);
});
