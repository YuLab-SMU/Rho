// Exercise a reduced application tarball whose optional packages are physically
// absent, in a fresh process outside every source checkout.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const artifact = path.resolve(process.argv[2] ?? '');
assert.ok(artifact.endsWith('.tgz'), 'Select a documents/files-only application tarball.');
const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-minimal-install-'));
const report = { status: 'running', artifactSha256: createHash('sha256').update(await fs.readFile(artifact)).digest('hex'), checks: [] };
try {
  const install = spawnSync('npm', ['install', '--prefix', root, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(install.status, 0, install.stderr);
  const pkg = path.join(root, 'node_modules/@rho-workspace/local');
  const composition = JSON.parse(await fs.readFile(path.join(pkg, 'vendor/composition.json'), 'utf8'));
  report.composition = composition;
  assert.deepEqual(composition.plugins.selected, ['documents', 'files']);
  assert.deepEqual((await fs.readdir(path.join(pkg, 'node_modules/@rho-workspace'))).sort(), ['plugin-contracts', 'plugin-documents', 'plugin-files']);
  for (const optional of ['csv-parse', '@modelcontextprotocol/sdk']) await assert.rejects(fs.stat(path.join(pkg, 'node_modules', optional)), { code: 'ENOENT' });
  const script = `import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { RhoService } from './node_modules/@rho-workspace/local/dist/server.js';
import { RhoClient } from './node_modules/@rho-workspace/local/dist/client.js';
import { runtime } from './node_modules/@rho-workspace/local/dist/runtime.js';
const root = path.resolve('projects'); await fs.mkdir(root);
const service = await new RhoService({ root, stateDir: path.resolve('state'), ...await runtime(undefined, path.resolve('missing-Rscript')) }).start();
try {
 const c = new RhoClient({ url: service.url, token: service.adminToken });
 const p = await c.call('project.create', { name: 'ordinary' });
 const catalog = await c.call('capability.list', { projectId: p.id });
 assert.deepEqual(catalog.capabilities, ['documents', 'files']);
 assert.deepEqual(catalog.actions, []);
 assert.equal(catalog.plugins.filter(p => p.state === 'available').length, 2);
 assert.ok(catalog.plugins.filter(p => p.state === 'unavailable').every(p => p.selected && p.reason.includes('missing')));
 const d = await c.call('document.open', { projectId: p.id, path: 'draft.R' });
 const edited = await c.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: '# 中文 🧬' }], undoGroup: 'minimal' });
 assert.equal(edited.content, '# 中文 🧬');
 await assert.rejects(c.call('requirements.check', { projectId: p.id, requirements: [] }), e => e.error.kind === 'unavailable');
 const exported = await c.call('workspace.export', { projectId: p.id, destination: 'export' });
 assert.equal(exported.state, 'complete');
 assert.equal((await c.call('observation.snapshot', { projectId: p.id })).host.exitCode, 3);
} finally { await service.close(); }
`;
  const file = path.join(root, 'check.mjs'); await fs.writeFile(file, script);
  const checked = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr);
  report.checks.push('Only contracts/documents/files installed; no CSV parser, MCP SDK, R plugin or aggregate package.');
  report.checks.push('Missing optional packages report unavailable; Unicode draft/edit/export and project observations work without R or Host startup.');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.failure = e.message; process.exitCode = 1; }
await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ status: report.status, report: path.join(root, 'report.json'), failure: report.failure }) + '\n');
