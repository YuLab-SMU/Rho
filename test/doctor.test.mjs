import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

// "Nothing happened" is not a diagnosis. doctor answers whether this project can do
// work at all, and names the next action for whatever is wrong.
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'rho-doctor-'));
  await fs.mkdir(path.join(root, 'work'));
  const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing-core', rscript: '/missing-Rscript' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  return { root, project: path.join(root, 'work'), service, operator, p, cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('doctor reports a writable project with no Host as ready to work', async () => {
  const f = await fixture();
  try {
    const report = await f.operator.call('project.doctor', { projectId: f.p.id });
    const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
    assert.equal(byId['project-write'].state, 'ok');
    assert.equal(byId['state-write'].state, 'ok');
    // No Host yet is normal: the first execution starts one.
    assert.equal(byId.core.state, 'ok');
    assert.match(byId.core.detail, /first execution starts one/);
    // The selected Rscript does not exist here, and that is named with its remedy.
    assert.equal(byId.rscript.state, 'fail');
    assert.match(byId.rscript.remedy, /--rscript|RHO_RSCRIPT/);
    assert.equal(report.ok, false, 'a missing interpreter is not a healthy project');
  } finally { await f.cleanup(); }
});

test('doctor turns a folder it may not write into the exact remedy', async () => {
  const f = await fixture();
  try {
    // A read-only project folder is the condition that produced "nothing happened"
    // after choosing a folder, with no error shown anywhere.
    await fs.chmod(f.project, 0o500);
    const report = await f.operator.call('project.doctor', { projectId: f.p.id });
    const write = report.checks.find(check => check.id === 'project-write');
    assert.equal(write.state, 'fail');
    assert.match(write.detail, /cannot write in/);
    assert.match(write.remedy, /write access|sandbox/);
    assert.equal(report.ok, false);
  } finally {
    await fs.chmod(f.project, 0o700).catch(() => {});
    await f.cleanup();
  }
});

test('doctor is available to the person in the tab, and changes nothing', async () => {
  const f = await fixture();
  try {
    const { code } = await f.operator.call('session.browser.pair', {});
    const grant = (await (await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.service.url }, body: JSON.stringify({ code }) })).json()).value;
    const { BrowserClient } = await import('../dist/browser.js');
    const tab = new BrowserClient({ url: f.service.url, ...grant });
    const before = await tab.call('observation.snapshot', { projectId: f.p.id });
    const report = await tab.call('project.doctor', { projectId: f.p.id });
    assert.ok(report.checks.length >= 4);
    const after = await tab.call('observation.snapshot', { projectId: f.p.id });
    // Reading a diagnosis must not create documents, runs or a Host.
    assert.deepEqual(after.documents, before.documents);
    assert.deepEqual(after.operations, before.operations);
  } finally { await f.cleanup(); }
});
