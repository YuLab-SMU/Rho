import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { digest } from '@rho-workspace/plugin-contracts';

// A run that finishes while nobody asks must not keep reading as running. A stand-in
// Host answers submit with an active run and lookup with the terminal one, so the
// check is about reconciliation and needs no R.
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-reconcile-'));
  const state = path.join(root, '.service'), project = path.join(root, 'work');
  await fs.mkdir(project);
  const marker = path.join(root, 'host-ready');
  const answers = path.join(root, 'lookup.json');
  await fs.writeFile(answers, JSON.stringify({ ok: true, value: { status: { Finished: { exit: { Code: 0 } } }, terminal: true, held: false, stdout: {}, stderr: {} } }));
  const core = path.join(root, 'core-stub.mjs');
  await fs.writeFile(core, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), method = args[0], marker = ${JSON.stringify(marker)}, project = ${JSON.stringify(project)};
const value = (json, code = 0) => { process.stdout.write(JSON.stringify(json) + '\\n'); process.exit(code); };
if (method === 'serve') {
  fs.writeFileSync(marker, 'ready');
  process.stdout.write(JSON.stringify({ ready: { socket: project + '/.rho/host.sock' } }) + '\\n');
  setInterval(() => {}, 1000);
}
if (method === 'capability') {
  if (!fs.existsSync(marker)) value({ ok: false, error: { kind: 'host_unavailable', message: 'no host' } }, 3);
  value({ ok: true, value: { project_root: project, executors: [{ name: 'r', program: 'Rscript', args: ['--vanilla'] }] } });
}
if (method === 'submit') value({ ok: true, value: { accepted_at: '2026-10-23T00:00:00.000Z', request_id: 'x', held: true, terminal: false, status: { Running: { pid: 1 } }, stdout: {}, stderr: {} } });
if (method === 'lookup') value(JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8')));
value({ ok: false, error: { kind: 'usage', message: 'unsupported' } }, 1);
`, { mode: 0o755 });
  const service = await new RhoService({ root, stateDir: state, coreBinary: core, rscript: 'Rscript' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  const grant = await operator.call('session.grant', { projectId: p.id, externalSessionId: 'reconcile', methods: ['action.submit', 'action.observe', 'action.lookup', 'observation.snapshot'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);
  return { root, project, service, p, agent, answers, cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

async function submit(agent, projectId, project) {
  await fs.writeFile(path.join(project, 'analysis.R'), 'cat("hi\\n")\n');
  return agent.call('action.submit', {
    projectId, operationId: 'run-1', action: 'r.execute', actionVersion: '0.2.0',
    input: { script: { kind: 'disk', path: 'analysis.R', digest: digest(await fs.readFile(path.join(project, 'analysis.R'))) }, args: [], requirements: [], artifacts: [], completion: null }
  });
}

test('a finished run reads as finished without an explicit observe', async () => {
  const f = await fixture();
  try {
    const submitted = await submit(f.agent, f.p.id, f.project);
    assert.equal(submitted.execution, 'active');
    // No observe call: the next read sees the finished run.
    const read = await f.agent.call('action.lookup', { projectId: f.p.id, operationId: 'run-1' });
    assert.equal(read.execution, 'completed');
  } finally { await f.cleanup(); }
});

test('an unanswered Host leaves the stored outcome unknown instead of inventing one', async () => {
  const f = await fixture();
  try {
    await submit(f.agent, f.p.id, f.project);
    // The owner answers with an error: nothing may be concluded from it.
    await fs.writeFile(f.answers, JSON.stringify({ ok: false, error: { kind: 'condition', message: 'no host' } }));
    const read = await f.agent.call('action.lookup', { projectId: f.p.id, operationId: 'run-1' });
    assert.equal(read.execution, 'active');
  } finally { await f.cleanup(); }
});
