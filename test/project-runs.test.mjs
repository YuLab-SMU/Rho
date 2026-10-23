import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { BrowserClient } from '../dist/browser.js';
import { digest } from '@rho-workspace/plugin-contracts';

// A person owns the project, so they may see what it is running. What they see is a
// summary: enough to tell waiting from finished, never the submitted code.
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-runs-'));
  const state = path.join(root, '.service'), project = path.join(root, 'work');
  await fs.mkdir(project);
  const marker = path.join(root, 'host-ready'), answers = path.join(root, 'lookup.json');
  await fs.writeFile(answers, JSON.stringify({ ok: true, value: { status: { Finished: { exit: { Code: 0 } } }, terminal: true, held: false, stdout: {}, stderr: {} } }));
  const core = path.join(root, 'core-stub.mjs');
  await fs.writeFile(core, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), method = args[0], marker = ${JSON.stringify(marker)}, project = ${JSON.stringify(project)};
const value = (json, code = 0) => { process.stdout.write(JSON.stringify(json) + '\\n'); process.exit(code); };
if (method === 'serve') { fs.writeFileSync(marker, 'ready'); process.stdout.write(JSON.stringify({ ready: {} }) + '\\n'); setInterval(() => {}, 1000); }
if (method === 'capability') { if (!fs.existsSync(marker)) value({ ok: false, error: { kind: 'host_unavailable', message: 'no host' } }, 3); value({ ok: true, value: { project_root: project, executors: [{ name: 'r', program: 'Rscript', args: ['--vanilla'] }] } }); }
if (method === 'submit') value({ ok: true, value: { accepted_at: '2026-10-23T00:00:00.000Z', request_id: 'x', held: true, terminal: false, status: { Running: { pid: 1 } }, stdout: {}, stderr: {} } });
if (method === 'lookup') value(JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8')));
value({ ok: false, error: { kind: 'usage', message: 'unsupported' } }, 1);
`, { mode: 0o755 });
  const service = await new RhoService({ root, stateDir: state, coreBinary: core, rscript: 'Rscript' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  await fs.writeFile(path.join(project, 'secret-analysis.R'), 'SYNTHETIC-SECRET-CODE <- 1\n');
  const grant = await operator.call('session.grant', { projectId: p.id, externalSessionId: 'worker', methods: ['action.submit', 'action.lookup'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);
  return { root, project, service, p, operator, agent, cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('a person sees what the project is running, and never the submitted code', async () => {
  const f = await fixture();
  try {
    const script = path.join(f.project, 'secret-analysis.R');
    await f.agent.call('action.submit', {
      projectId: f.p.id, operationId: 'visible-1', action: 'r.execute', actionVersion: '0.2.0',
      input: { script: { kind: 'disk', path: 'secret-analysis.R', digest: digest(await fs.readFile(script)) }, args: [], requirements: [], artifacts: [{ path: 'out.png', kind: 'file', format: { mimeType: 'image/png' } }], completion: null }
    });
    const { code } = await f.operator.call('session.browser.pair', {});
    const grant = (await (await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.service.url }, body: JSON.stringify({ code }) })).json()).value;
    const tab = new BrowserClient({ url: f.service.url, ...grant });
    const listed = await tab.call('project.runs', { projectId: f.p.id });
    assert.equal(listed.total, 1);
    const run = listed.runs[0];
    assert.equal(run.operationId, 'visible-1');
    assert.equal(run.author, 'Agent');
    assert.deepEqual(run.artifacts, ['out.png'], 'the declared artifact is visible');
    // Reconciled on read: the Host says finished, so the person is not shown "running".
    assert.equal(run.execution, 'completed');
    // Nothing that could leak the submitted work.
    const text = JSON.stringify(listed);
    assert.doesNotMatch(text, /SYNTHETIC-SECRET-CODE/);
    assert.doesNotMatch(text, /secret-analysis/);
    assert.equal(run.request, undefined);
    assert.equal(run.plan, undefined);
  } finally { await f.cleanup(); }
});

test('a tab cannot pull another project runs through its own credential', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'other'));
    const other = await f.operator.call('project.open', { path: 'other' });
    const narrowed = await f.operator.call('session.browser.pair', { path: 'work' });
    const grant = (await (await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.service.url }, body: JSON.stringify({ code: narrowed.code }) })).json()).value;
    const tab = new BrowserClient({ url: f.service.url, ...grant });
    await assert.rejects(tab.call('project.runs', { projectId: other.id }), error => ['scope', 'unauthorized', 'not_found'].includes(error.error.kind));
  } finally { await f.cleanup(); }
});

test('granting a session for a project opened at the service root works', async () => {
  // A project whose root is the service root has an empty relative path, which used to
  // be refused as traversal: the project opened but no session could be granted for it.
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-root-project-'));
  const state = path.join(root, '..', path.basename(root) + '-state');
  const service = await new RhoService({ root, stateDir: state, coreBinary: '/missing', rscript: '/missing' }).start();
  try {
    const operator = new RhoClient({ url: service.url, token: service.adminToken });
    const p = await operator.call('project.open', { path: '.' });
    const grant = await operator.call('session.grant', { projectId: p.id, externalSessionId: 'at-root', methods: ['action.lookup'] });
    assert.ok(grant.connectionFile);
    const agent = await RhoClient.fromFile(grant.connectionFile);
    // Opening the session is the point; a lookup that reaches the owner proves it works.
    await assert.rejects(agent.call('action.lookup', { projectId: p.id, operationId: 'absent' }), error => error.error.kind === 'not_found');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(state, { recursive: true, force: true }); }
});
