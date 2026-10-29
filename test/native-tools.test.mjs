import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { CheckedClient } from './checked-client.mjs';
import { CoreBridge } from '../dist/bridge.js';

test('default runtime works without Core; a bad explicit selection still fails', () => {
  const env = { ...process.env, PATH: '', RHO_CORE_BINARY: '', RHO_RSCRIPT: '' };
  const script = `import { runtime } from './dist/runtime.js';
    const native = await runtime();
    if (native.coreBinary !== undefined) throw new Error('Unexpected Core');
    try { await runtime('/missing-selected-core'); throw new Error('Accepted missing selection'); }
    catch (e) { if (e.kind !== 'unavailable') throw e; }
    console.log('native-ready');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' }).trim(), 'native-ready');
});

test('native output is available in the workspace without Core or a managed record', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-native-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), rscript: '/missing-Rscript' }).start();
  try {
    const client = new CheckedClient({ url: service.url, token: service.adminToken });
    const project = await client.call('project.create', { name: 'native' });
    execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync('answer.txt', ${JSON.stringify('Native result 你好\n')})`], { cwd: project.root });
    const entries = await client.call('project.entries', { projectId: project.id });
    assert.ok(entries.entries.some(e => e.name === 'answer.txt'));
    const document = await client.call('document.open', { projectId: project.id, path: 'answer.txt' });
    assert.equal(document.content, 'Native result 你好\n');
    const diagnosis = await client.call('project.doctor', { projectId: project.id });
    assert.equal(diagnosis.ok, true);
    const managed = await client.call('project.doctor', { projectId: project.id, intent: 'run-r' });
    assert.equal(managed.ok, false);
    assert.deepEqual((await client.call('observation.snapshot', { projectId: project.id })).operations, []);
    const bridge = new CoreBridge(undefined, '/missing-Rscript');
    assert.equal((await bridge.capability(project.root)).reply.error.kind, 'core_unavailable');
    await assert.rejects(bridge.ensureOwnedHost(project.root), e => e.kind === 'unavailable');
    await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
