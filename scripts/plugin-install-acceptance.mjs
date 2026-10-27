// Exercise a reduced application tarball whose optional packages are physically
// absent, in a fresh process outside every source checkout.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const artifact = path.resolve(process.argv[2] ?? '');
assert.ok(artifact.endsWith('.tgz'), 'Select a documents/files or files/r application tarball.');
const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-minimal-install-'));
const report = { status: 'running', artifactSha256: createHash('sha256').update(await fs.readFile(artifact)).digest('hex'), checks: [] };
try {
  const install = spawnSync('npm', ['install', '--prefix', root, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(install.status, 0, install.stderr);
  const pkg = path.join(root, 'node_modules/@rho-workspace/local');
  const composition = JSON.parse(await fs.readFile(path.join(pkg, 'vendor/composition.json'), 'utf8'));
  report.composition = composition;
  const selected = composition.plugins.selected;
  assert.ok([['documents', 'files'], ['files', 'r']].some(ids => JSON.stringify(ids) === JSON.stringify(selected)), 'Unsupported reduced composition.');
  assert.deepEqual((await fs.readdir(path.join(pkg, 'node_modules/@rho-workspace'))).sort(), ['plugin-contracts', ...selected.map(id => 'plugin-' + id)].sort());
  for (const optional of ['csv-parse', '@modelcontextprotocol/sdk', '@agentclientprotocol/sdk', '@agentclientprotocol/claude-agent-acp', '@anthropic-ai/claude-agent-sdk']) await assert.rejects(fs.stat(path.join(pkg, 'node_modules', optional)), { code: 'ENOENT' });
  const script = `import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { RhoService } from './node_modules/@rho-workspace/local/dist/server.js';
import { RhoClient } from './node_modules/@rho-workspace/local/dist/client.js';
import { runtime } from './node_modules/@rho-workspace/local/dist/runtime.js';
import { createHash } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
const selected = ${JSON.stringify(selected)};
const root = path.resolve('projects'); await fs.mkdir(root);
const service = await new RhoService({ root, stateDir: path.resolve('state'), ...await runtime(undefined, path.resolve('missing-Rscript')) }).start();
try {
 const c = new RhoClient({ url: service.url, token: service.adminToken });
 const p = await c.call('project.create', { name: 'ordinary' });
 const catalog = await c.call('capability.list', { projectId: p.id });
 assert.deepEqual(catalog.actions, []);
 assert.equal(catalog.plugins.filter(p => p.state === 'available').length, 2);
 assert.ok(catalog.plugins.filter(p => p.state === 'unavailable').every(p => p.selected && p.reason.includes('missing')));
 if (selected.includes('documents')) {
  assert.deepEqual(catalog.capabilities, ['documents', 'files']);
  const d = await c.call('document.open', { projectId: p.id, path: 'draft.R' });
  const edited = await c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: '# 中文 🧬' }], undoGroup: 'minimal' });
  assert.equal(edited.content, '# 中文 🧬');
 } else {
  assert.deepEqual(catalog.capabilities, ['files', 'r-objects']);
  assert.deepEqual(catalog.unavailableActions, [{ id: 'r.execute', version: '0.2.0', state: 'unavailable', missing: ['requirements'] }]);
  const bytes = '{"value":"中文 🧬"}';
  await fs.writeFile(path.join(p.root, 'object.json'), bytes);
  const resource = await c.call('resource.register', { projectId: p.id, expectedDigest: digest(bytes), declaration: { path: 'object.json', kind: 'object', format: { encoding: 'json', observation: 'exported-snapshot', classes: ['list'] } } });
  assert.equal((await c.call('object.read', { projectId: p.id, resource: { id: resource.id, version: resource.version } })).value.value, '中文 🧬');
  await assert.rejects(c.call('action.submit', { projectId: p.id, operationId: 'absent-provider', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'absent.R', digest: digest('') }, args: [], requirements: [], artifacts: [], completion: null } }), e => e.error.kind === 'unavailable');
 }
 await assert.rejects(c.call('requirements.check', { projectId: p.id, requirements: [] }), e => e.error.kind === 'unavailable');
 const exported = await c.call('workspace.export', { projectId: p.id, destination: 'export' });
 assert.equal(exported.state, 'complete');
 const observed = await c.call('observation.snapshot', { projectId: p.id });
 assert.equal(observed.host.exitCode, 3); assert.deepEqual(observed.operations, []);
} finally { await service.close(); }
`;
  const file = path.join(root, 'check.mjs'); await fs.writeFile(file, script);
  const checked = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr);
  report.checks.push('Only contracts/' + selected.join('/') + ' installed; no CSV parser, MCP/ACP/Claude SDK, Claude ACP adapter, unselected plugin or aggregate package.');
  report.checks.push(selected.includes('documents')
    ? 'Missing optional packages report unavailable; Unicode draft/edit/export and observations work without R or Host startup.'
    : 'Exported object reads/export work without Documents, requirements or R; execution is unavailable and no request or Host is created.');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.failure = e.message; process.exitCode = 1; }
await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: report.status, report: path.join(root, 'report.json'), failure: report.failure }) + '\n');
