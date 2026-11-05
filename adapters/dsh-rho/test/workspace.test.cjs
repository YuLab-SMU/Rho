const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { workspace, apply } = require('../src/host.cjs');

test('only the local project address leaves the credential file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-launcher-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agent.json');
  await fs.writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:1234', projectId: 'project-1', token: 'private-token' }));
  assert.deepEqual(await workspace(file), { url: 'http://127.0.0.1:1234/#project=project-1' });
  for (const url of ['https://example.com', 'http://127.0.0.1/?token=secret', 'http://user:secret@localhost/', 'http://127.0.0.1/#pair=secret']) {
    await fs.writeFile(file, JSON.stringify({ url, projectId: 'project-1' }));
    await assert.rejects(workspace(file));
  }
  await fs.writeFile(file, ' '.repeat(65537));
  await assert.rejects(workspace(file));
});

test('unavailable configuration keeps the launcher mounted and retryable', async () => {
  let route;
  apply({ effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {}; } } } }, {});
  const response = await route.fetch();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /connection file/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
