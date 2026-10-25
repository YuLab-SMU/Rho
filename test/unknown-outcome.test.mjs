import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { RhoService } from '../dist/server.js';
import { CheckedClient as RhoClient } from './checked-client.mjs';
import { runtime } from '../dist/runtime.js';
import { digest } from '@rho-workspace/plugin-contracts';

// When Core's Host dies mid-run nobody can answer for the process (Host recovery is an
// explicit operator action). A read then says the outcome is unknown, never "running", and
// leaves the stored facts as they were (the stop mapping for this case: execution-facts.test).
test('a run whose Host stopped answering reads as unknown, not running', { timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'rho-unknown-'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), ...await runtime() }).start();
  let orphan;
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await operator.call('project.create', { name: 'u' });
    const call = (m, b = {}) => operator.call(m, { projectId: p.id, ...b });
    const script = 'cat("waiting\\n")\nSys.sleep(20)\n';
    await fs.writeFile(path.join(p.root, 'w.R'), script);
    await call('action.submit', { operationId: 'u1', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'w.R', digest: digest(script) }, args: [], requirements: [], artifacts: [], completion: null } });
    let run;
    for (let i = 0; i < 50 && run?.native?.status?.Running === undefined; i++) { run = await call('action.lookup', { operationId: 'u1' }); await setTimeout(100); }
    assert.equal(run.execution, 'active');
    orphan = run.native.status.Running.pid;
    process.kill((await call('observation.snapshot')).host.reply.value.host.pid, 'SIGKILL');
    await setTimeout(300);
    const summary = (await call('project.runs')).runs.find(r => r.operationId === 'u1');
    assert.equal(summary.execution, 'unknown');
    assert.equal((await call('action.lookup', { operationId: 'u1' })).execution, 'unknown');
    // The stored facts were not rewritten by an absent answer.
    const stored = JSON.parse(await fs.readFile(path.join(p.root, '.rho/rho/operations', (await fs.readdir(path.join(p.root, '.rho/rho/operations'))).find(f => f.endsWith('.json'))), 'utf8'));
    assert.notEqual(stored.execution, 'unknown');
  } finally {
    if (orphan) { try { process.kill(orphan, 'SIGKILL'); } catch {} }
    await service.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
