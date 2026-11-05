import { query } from './support/presentation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Extensions } from '../dist/extensions.js';
import { RhoService, layeredGrantLimits } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { pluginCli } from '../dist/plugin-cli.js';

async function fixture(t, limits = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-ext-')), source = path.join(root, 'source');
  await pluginCli(['create', source, '--id', 'test-plugin']);
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  pkg.scripts = { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(path.join(root, 'HOOK-RAN'))},'bad')"` };
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(pkg));
  const file = path.join(source, 'rho-plugin.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.operations.push(...['write', 'crash', 'delegate', 'after-delegate', 'slow'].map(id => ({ id, title: id, description: id, effect: 'native', methods: ['delegate', 'after-delegate'].includes(id) ? ['kernel.run'] : [], inputSchema: { type: 'object', additionalProperties: true } })));
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(source, 'host.mjs'), `import fs from 'node:fs/promises';
export async function run(op, input, ctx) {
 if(op==='greet') return {greeting:'Hello, '+input.name+'!'};
 if(op==='delegate') return ctx.call('kernel.run',input);
 if(op==='after-delegate') { await ctx.call('kernel.run',input); process.exit(9); }
 if(op==='crash') { await fs.appendFile(ctx.projectRoot+'/writes','x'); process.exit(9); }
 if(op==='slow') await new Promise(r=>setTimeout(r,200));
 await fs.appendFile(ctx.projectRoot+'/writes','x'); return {written:true};
}`);
  const manager = new Extensions(path.join(root, 'state'), { timeoutMs: 5000, ...limits }); await manager.init();
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, source, manager, manifest, manifestFile: file, cleanup };
}
const request = p => ({ pluginId: p.id, expectedDigest: p.digest, projectId: 'project', operation: 'write', input: {}, changeId: 'original' });

test('independent package installs without hooks; update stages, disable/remove preserve results, tampering refuses', async t => {
  const { root, source, manager, manifest, manifestFile } = await fixture(t);
  const p = await manager.install(source);
  await assert.rejects(fs.access(path.join(root, 'HOOK-RAN')));
  assert.equal(manager.list().plugins[0].enabled, true);
  assert.match((await manager.content(p.id, p.digest, 'view', 'main')).text, /rho.call/);
  const b = request(p), first = await manager.call(b, 'person', root, () => assert.fail());
  assert.equal(first.state, 'completed');
  await assert.rejects(manager.call({ ...b, input: { changed: true } }, 'person', root, () => assert.fail()), /different/);
  manifest.host = '../escape.mjs'; await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(manager.install(source, p.id, p.digest), /relative file/);
  assert.equal(manager.describe(p.id).digest, p.digest);
  manifest.host = 'host.mjs'; await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.appendFile(path.join(source, 'host.mjs'), '\n// new revision\n');
  const updated = await manager.install(source, p.id, p.digest); assert.notEqual(updated.digest, p.digest);
  assert.deepEqual(await manager.call(b, 'person', root, () => assert.fail()), first, 'update still observes the original package invocation');
  await assert.rejects(manager.call({ ...b, changeId: 'new' }, 'person', root, () => assert.fail()), /changed/);
  await manager.manage(p.id, updated.digest, 'disable');
  await assert.rejects(manager.call({ ...request(updated), changeId: 'disabled' }, 'person', root, () => assert.fail()), /disabled/);
  await manager.manage(p.id, updated.digest, 'remove');
  assert.deepEqual(await manager.call(b, 'person', root, () => assert.fail()), first);
  assert.equal(await fs.readFile(path.join(root, 'writes'), 'utf8'), 'x');
  const again = await manager.install(source);
  await fs.appendFile(path.join(manager.directory, 'versions', again.digest, 'node_modules', again.name, 'host.mjs'), '// tamper');
  await assert.rejects(manager.content(again.id, again.digest, 'view', 'main'), /bytes changed/);
});

test('concurrent same identity runs once; crash/restart remain unknown and caller scoped', async t => {
  const { root, source, manager } = await fixture(t); const p = await manager.install(source);
  const b = { ...request(p), operation: 'slow' };
  const [first, second] = await Promise.all([manager.call(b, 'person', root, () => assert.fail()), manager.call(b, 'person', root, () => assert.fail())]);
  assert.equal(first.invocationId, second.invocationId); assert.equal(await fs.readFile(path.join(root, 'writes'), 'utf8'), 'x');
  const crash = { ...b, changeId: 'crash', operation: 'crash' }, unknown = await manager.call(crash, 'person', root, () => assert.fail());
  assert.equal(unknown.state, 'unknown'); assert.match(unknown.error, /exited/);
  const delegated = await manager.call({ ...b, changeId: 'delegated', operation: 'after-delegate', input: { changeId: 'native-original' } }, 'person', root, async () => ({ cell: { cellId: 'native-cell', state: 'running' } }));
  assert.equal(delegated.state, 'unknown');
  assert.equal(delegated.delegations[0].request.changeId, 'native-original');
  assert.equal(delegated.delegations[0].value.cell.cellId, 'native-cell');
  const restarted = new Extensions(manager.directory); await restarted.init();
  assert.deepEqual(await restarted.call(crash, 'person', root, () => assert.fail()), unknown);
  assert.equal(await fs.readFile(path.join(root, 'writes'), 'utf8'), 'xx');
  await assert.rejects(restarted.read(unknown.invocationId, 'other', b.projectId), /another caller/);
  const pendingFile = path.join(manager.directory, 'receipts', unknown.invocationId + '.json');
  await fs.writeFile(pendingFile, JSON.stringify({ ...unknown, state: 'pending' }));
  await restarted.init(); assert.equal((await restarted.read(unknown.invocationId, 'person', b.projectId)).state, 'unknown');
});

test('service discovers plugins without starting sessions, preserves grants and rejects cross-project delegation', async t => {
  const { root, source, cleanup } = await fixture(t);
  await fs.mkdir(path.join(root, 'project')); await fs.mkdir(path.join(root, 'other'));
  const service = await new RhoService({ root, stateDir: path.join(root, 'service'), rscript: '/missing', extensions: { timeoutMs: 2000 } }).start();
  cleanup.push(() => service.close());
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await admin.call('project.open', { path: 'project' }), other = await admin.call('project.open', { path: 'other' });
  const p = await admin.call('extension.install', { source });
  const grant = path.join(root, 'agent.json');
  const connection = await service.agentConnection(project.id, 'plugin-test', grant, undefined, undefined, 'layered-business');
  assert.ok(connection.methods.length <= layeredGrantLimits.maxMethods);
  assert.ok(connection.methods.includes('extension.call')); assert.ok(!connection.methods.includes('extension.install'));
  const agent = await RhoClient.fromFile(grant);
  const catalog = await agent.call('extension.list', { projectId: project.id }); assert.equal(catalog.plugins.length, 1);
  assert.deepEqual((await agent.call('kernel.read', { projectId: project.id })).sessions, []);
  const discovered = await agent.call('capability.index', { projectId: project.id, role: 'business', query: { ...query, owner: 'rho' } }); assert.ok(JSON.stringify(discovered).includes('extension'));
  await assert.rejects(agent.call('extension.manage', { pluginId: p.id, expectedDigest: p.digest, action: 'disable' }), /authoriz|grant|permitted|scope/i);
  const denied = await agent.call('extension.call', { ...request(p), projectId: project.id, operation: 'delegate', input: { projectId: other.id, language: 'r', code: '1', changeId: 'wrong' } });
  assert.equal(denied.state, 'unknown'); assert.match(denied.error, /another project/);
  assert.deepEqual((await admin.call('kernel.read', { projectId: other.id })).sessions, []);
});
