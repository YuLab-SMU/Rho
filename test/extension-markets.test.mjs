import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Extensions } from '../dist/extensions.js';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { validateResponse } from '../dist/contract-runtime.js';
import { pluginCli } from '../dist/plugin-cli.js';
import { query } from './support/presentation.mjs';
import { Discovery } from '../dist/discovery.js';

const execute = promisify(execFile);
const index = JSON.parse(await fs.readFile(new URL('../site/market/rho.json', import.meta.url)));
async function fixture(t, limits = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-market-'));
  const state = { body: JSON.stringify(index), status: 200, requests: 0, delay: 0, redirect: false, chunked: false };
  const server = http.createServer((_, res) => {
    state.requests++;
    if (state.redirect) { res.writeHead(302, { location: '/redirected' }); res.end(); return; }
    const send = () => { res.writeHead(state.status); if (state.chunked) res.write(state.body.slice(0, 100)); res.end(state.chunked ? state.body.slice(100) : state.body); };
    if (state.delay) setTimeout(send, state.delay).unref(); else send();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/index.json`;
  const manager = new Extensions(path.join(root, 'plugins'), limits); await manager.init();
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); manager.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, state, url, manager, cleanup };
}
const change = (manager, market, action = 'refresh') => manager.changeMarket({ action, id: market.id, expectedRevision: market.revision });

test('saved market survives restart; reads and duplicate add do not fetch; refresh failure preserves the last index', async t => {
  const { manager, state, url } = await fixture(t);
  const [first] = (await manager.changeMarket({ action: 'add', url })).markets;
  assert.equal(first.plugins[0].id, 'yulab.semantic-figures');
  const before = state.requests;
  await manager.changeMarket({ action: 'add', url }); manager.list(); manager.markets.list();
  const restarted = new Extensions(manager.directory); await restarted.init();
  assert.equal(state.requests, before); assert.equal(restarted.list().markets[0].digest, first.digest);
  state.status = 503;
  const [cached] = (await change(restarted, first)).markets;
  assert.match(cached.error, /HTTP 503/); assert.equal(cached.digest, first.digest); assert.deepEqual(cached.plugins, first.plugins);
  await assert.rejects(change(restarted, first, 'remove'), /source changed/);
  state.status = 200;
  const [recovered] = (await change(restarted, cached)).markets;
  assert.equal(recovered.error, null); assert.ok(recovered.revision > cached.revision);
});

test('indexes reject incompatible formats, duplicate ids and unpinned or local package sources before retaining anything', async t => {
  const { manager, state, url } = await fixture(t);
  const invalid = [
    '{bad', JSON.stringify({ format: 1, title: 'Harness format', plugins: [] }),
    JSON.stringify({ ...index, plugins: [index.plugins[0], index.plugins[0]] }),
    ...['/private/package', 'file:../package', '@lab/plugin@latest', '@lab/plugin@^0.1.0', 'git+https://example.com/x.git#main', 'git+https://example.com/x.git#' + 'a'.repeat(40) + ':../escape'].map(source => JSON.stringify({ ...index, plugins: [{ ...index.plugins[0], source }] })),
    JSON.stringify({ ...index, plugins: [{ ...index.plugins[0], repository: 'javascript:alert(1)' }] }),
  ];
  for (const body of invalid) { state.body = body; await assert.rejects(manager.changeMarket({ action: 'add', url })); assert.equal(manager.list().markets.length, 0); }
  state.body = JSON.stringify(index); state.redirect = true;
  const before = state.requests; await assert.rejects(manager.changeMarket({ action: 'add', url }), /redirects are not followed/);
  assert.equal(state.requests, before + 1);
  for (const url of ['http://example.com/index.json', 'file:///tmp/index.json', 'https://user:password@example.com/index.json', 'https://example.com/index.json?token=private']) await assert.rejects(manager.changeMarket({ action: 'add', url }), /HTTPS/);
});

test('source count, streamed bytes, entry count and timeout bounds refuse new data without replacing cached data', async t => {
  const { manager, state, url } = await fixture(t, { maxMarkets: 1, maxMarketBytes: 2048, maxMarketEntries: 1, marketTimeoutMs: 1000 });
  let [market] = (await manager.changeMarket({ action: 'add', url })).markets;
  await assert.rejects(manager.changeMarket({ action: 'add', url: url + '/other' }), /maxMarkets/);
  const digest = market.digest;
  state.body = 'x'.repeat(3000); state.chunked = true;
  [market] = (await change(manager, market)).markets; assert.match(market.error, /maxMarketBytes/); assert.equal(market.digest, digest);
  state.chunked = false; state.body = JSON.stringify({ ...index, plugins: [index.plugins[0], { ...index.plugins[0], id: 'other' }] });
  [market] = (await change(manager, market)).markets; assert.match(market.error, /maxMarketEntries/);
  state.body = JSON.stringify(index); state.delay = 2000;
  [market] = (await change(manager, market)).markets; assert.match(market.error, /marketTimeoutMs/); assert.equal(market.digest, digest);
});

test('market selection binds the configured source and exact retained index; changed or removed indexes refuse stale installs', async t => {
  const { manager, state, url } = await fixture(t);
  const [market] = (await manager.changeMarket({ action: 'add', url })).markets;
  const selection = { id: market.id, expectedDigest: market.digest, pluginId: index.plugins[0].id };
  assert.equal(manager.markets.select(selection, index.plugins[0].source).entry.version, '0.1.0');
  await assert.rejects(manager.install('/tmp/different-package', undefined, undefined, selection), /does not match/);
  state.body = JSON.stringify({ ...index, title: 'Changed index' });
  const [updated] = (await change(manager, market)).markets;
  await assert.rejects(manager.install(index.plugins[0].source, undefined, undefined, selection), /changed or was removed/);
  await change(manager, updated, 'remove');
  await assert.rejects(manager.install(index.plugins[0].source, undefined, undefined, { ...selection, expectedDigest: updated.digest }), /changed or was removed/);
  assert.deepEqual(manager.list().plugins, []);
});

test('the staged package must match the selected market identity and version before replacing an installed package', async t => {
  const { manager, root } = await fixture(t);
  const source = path.join(root, 'package'); await pluginCli(['create', source, '--id', 'market-check']);
  const previous = await manager.install(source);
  // Only transport/selection is substituted; the real npm staging, manifest
  // checker and atomic installed selection are exercised with a local fixture.
  for (const entry of [{ id: 'wrong-id', version: '0.1.0' }, { id: previous.id, version: '9.0.0' }]) {
    manager.markets.select = () => ({ entry, origin: { id: 'fixture', title: 'Fixture', url: 'https://example.com/index.json', digest: 'a'.repeat(64) } });
    await assert.rejects(manager.install(source, previous.id, previous.digest, { id: 'fixture', expectedDigest: 'a'.repeat(64), pluginId: entry.id }), /identity or version/);
    assert.equal(manager.describe(previous.id).digest, previous.digest);
  }
});

test('HTTP and CLI expose the same cached markets; Agent grants cannot add, refresh or remove sources', async t => {
  const { root, state, url, cleanup } = await fixture(t);
  await fs.mkdir(path.join(root, 'project'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'service'), example: false, coreBinary: '/missing', rscript: '/missing' }).start();
  cleanup.push(() => service.close());
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await admin.call('project.open', { path: 'project' });
  // Project the new local operation alone. Agent grants below deliberately do
  // not include it; this checks its full schema can be projected without damage.
  const principal = { ...service.state.principals.find(p => p.id === 'operator'), methods: ['extension.market.change'] };
  const discovery = await new Discovery(service.plugins, project, principal, null, []).index({ role: 'business', query: { ...query, search: 'extension.market' } });
  assert.equal(discovery.entries[0].id, 'extension.market.change');
  const file = path.join(root, 'agent.json');
  const connection = await service.agentConnection(project.id, 'market-agent', file, undefined, undefined, 'layered-business');
  assert.ok(!connection.methods.includes('extension.market.change'));
  const agent = await RhoClient.fromFile(file);
  await assert.rejects(agent.call('extension.market.change', { action: 'add', url }), /authoriz|grant|permitted|scope/i); assert.equal(state.requests, 0);
  const connectionFile = path.join(root, 'service', 'connection.json');
  const run = args => execute(process.execPath, ['dist/cli.js', 'plugin', 'market', ...args, '--connection', connectionFile]);
  const added = JSON.parse((await run(['add', url])).stdout); assert.equal(validateResponse('extension.market.change', added), true);
  const list = await agent.call('extension.list', { projectId: project.id }); assert.equal(validateResponse('extension.list', list), true);
  const before = state.requests; assert.equal(JSON.parse((await run(['list'])).stdout)[0].digest, list.markets[0].digest); assert.equal(state.requests, before);
  await run(['remove', list.markets[0].id]); assert.equal((await admin.call('extension.list', {})).markets.length, 0);
  assert.deepEqual((await admin.call('kernel.read', { projectId: project.id })).sessions, []);
});
