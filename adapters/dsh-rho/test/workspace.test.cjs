const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { readConnection, resolveWorkspace, publicError } = require('../src/connection.cjs');
const { apply } = require('../src/host.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-dsh-match-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const roots = await Promise.all(['first/项目', 'second/项目', 'unconnected'].map(async name => { const root = path.join(dir, name); await fs.mkdir(root, { recursive: true }); return fs.realpath(root); }));
  const servers = [], files = [];
  for (let i = 0; i < 2; i++) {
    const server = http.createServer((request, response) => {
      assert.equal(request.url, '/api/v2/observation.snapshot');
      assert.equal(request.headers.authorization, 'Bearer private-token-' + i);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, value: { project: { id: 'p' + i, root: roots[i] }, unrelated: 'private snapshot content' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const file = path.join(dir, 'agent-' + i + '.json');
    await fs.writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, projectId: 'p' + i, token: 'private-token-' + i }));
    files.push(file);
  }
  return { dir, roots, files, servers, config: { connectionFiles: files } };
}

test('conversation paths select the correct grant across two services, including Unicode and symlinks', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const value = await resolveWorkspace(f.config, f.roots[i]);
    assert.equal(value.connectionFile, f.files[i]);
    assert.equal(value.project.id, 'p' + i);
    assert.equal(new URL(value.project.url).hash, '#project=p' + i);
    assert.doesNotMatch(JSON.stringify(value.project), /private-token|unrelated|connectionFile/);
  }
  const alias = path.join(f.dir, 'alias'); await fs.symlink(f.roots[1], alias);
  assert.equal((await resolveWorkspace(f.config, alias)).project.id, 'p1');
});

test('a different conversation, missing cwd, and ambiguous grants never fall back to the first project', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveWorkspace(f.config, f.roots[2]), error => {
    const value = publicError(error);
    assert.equal(value.conversationRoot, f.roots[2]);
    assert.equal(value.projects.length, 2);
    assert.doesNotMatch(JSON.stringify(value), /private-token|private snapshot/);
    return /not connected/.test(value.error);
  });
  await assert.rejects(resolveWorkspace(f.config), /Open a Harness conversation/);
  const copy = path.join(f.dir, 'duplicate.json'); await fs.copyFile(f.files[0], copy);
  await assert.rejects(resolveWorkspace({ connectionFiles: [f.files[0], copy] }, f.roots[0]), /More than one/);
  await fs.mkdir(path.join(f.roots[0], 'child'));
  await assert.rejects(resolveWorkspace(f.config, path.join(f.roots[0], 'child')), /not connected/);
});

test('invalid, remote, credential-bearing and oversized descriptors are refused', async t => {
  const f = await fixture(t);
  for (const url of ['https://example.com', 'http://localhost/?token=secret', 'http://user:secret@localhost/', 'http://127.0.0.1/#pair=secret']) {
    await fs.writeFile(f.files[0], JSON.stringify({ url, projectId: 'p0', token: 'private' }));
    await assert.rejects(readConnection(f.files[0]));
  }
  await fs.writeFile(f.files[0], ' '.repeat(65537));
  await assert.rejects(readConnection(f.files[0]), /64 KiB/);
  await assert.rejects(readConnection('relative.json'), /absolute/);
});

test('one offline grant does not redirect either project to another service; retry uses the same grant', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.files[0]);
  await fs.writeFile(f.files[0], '{');
  assert.equal((await resolveWorkspace(f.config, f.roots[1])).project.id, 'p1');
  await assert.rejects(resolveWorkspace(f.config, f.roots[0]), error => publicError(error).unavailable === 1);
  await fs.writeFile(f.files[0], original);
  assert.equal((await resolveWorkspace(f.config, f.roots[0])).project.id, 'p0');
});

async function hostFixture(t, f) {
  const hooks = {}, cleanups = [], mounts = [];
  const agents = f.roots.map((cwd, i) => ({ session: { id: 'session-' + i, header: { cwd } } }));
  const tools = { get: () => undefined, guard: fn => { hooks.guard = fn; return () => {}; } };
  for (const agent of agents) agent.ctx = { tools: { get: () => ({}) }, plugin: (_plugin, config) => { mounts.push({ agent, config }); const fiber = Promise.resolve(); fiber.dispose = async () => {}; return fiber; } };
  const ctx = {
    effect: fn => { cleanups.push(fn()); }, on: (name, fn) => { hooks[name] = fn; }, tools,
    agents: { list: () => agents, get: id => agents.find(value => value.session.id === id) },
    sessionController: { inspect: () => { throw new Error('Unknown session'); } },
    connection: { fetch: { register: route => { hooks.route = route; return () => {}; } } },
  };
  await apply(ctx, { ...f.config, command: 'node', args: ['/selected/rho/cli.js'] });
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup?.(); });
  const request = (i, method = 'GET', extra = '') => hooks.route.fetch(new Request('http://harness/api/dsh-rho/workspace?sessionId=session-' + i + extra, { method }));
  return { hooks, mounts, agents, ctx, request };
}

test('the launcher and MCP use one per-conversation binding; no-session reads start nothing', async t => {
  const f = await fixture(t), h = await hostFixture(t, f);
  assert.equal(h.mounts.length, 2);
  for (let i = 0; i < 2; i++) {
    const response = await h.request(i), value = await response.json();
    assert.equal(value.id, 'p' + i); assert.equal(value.toolsReady, true);
    const mount = h.mounts.find(value => value.agent === h.agents[i]);
    assert.deepEqual(mount.config.args, ['/selected/rho/cli.js', '--mcp', f.files[i]]);
    assert.equal(h.hooks.guard({ name: 'mcp__rho__rho_index', agent: h.agents[i] }), undefined);
    assert.equal(new URL(value.url).hash, '#project=p' + i);
  }
  const mismatch = await h.request(2);
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).url, undefined);
  assert.match(h.hooks.guard({ name: 'mcp__rho__rho_call', agent: h.agents[2] }), /not connected/);
  assert.equal((await h.request(99)).status, 409);
  assert.equal(h.mounts.length, 2);
  h.hooks['agent/disposed']({ agent: h.agents[0] });
  await h.hooks['agent/created']({ agent: h.agents[0] });
  assert.equal(h.mounts.length, 3);
  assert.equal((await (await h.request(0)).json()).id, 'p0');
});

test('replacement connection files cannot split the already running tools from the launcher', async t => {
  const f = await fixture(t), h = await hostFixture(t, f);
  await fs.copyFile(f.files[1], f.files[0]);
  const decision = await h.hooks['tools/pre-execute']({ name: 'mcp__rho__rho_call', agent: h.agents[0] }, () => { throw new Error('must not execute'); });
  assert.equal(decision.kind, 'deny'); assert.match(decision.reason, /connection changed/);
  assert.match(h.hooks.guard({ name: 'mcp__rho__rho_call', agent: h.agents[0] }), /not connected/);
  assert.equal((await h.request(0, 'POST')).status, 409);
  assert.equal(h.mounts.length, 2);
});
