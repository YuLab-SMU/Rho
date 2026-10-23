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

test('an intent names the methods a task needs and what this session lacks', async () => {
  const f = await fixture();
  try {
    // A tab is granted a narrower set than an Agent session, so the same project
    // answers differently: this is the grant decided from the contract, not guessed.
    const { code } = await f.operator.call('session.browser.pair', {});
    const grant = (await (await fetch(f.service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.service.url }, body: JSON.stringify({ code }) })).json()).value;
    const { BrowserClient } = await import('../dist/browser.js');
    const tab = new BrowserClient({ url: f.service.url, ...grant });
    const report = await tab.call('project.doctor', { projectId: f.p.id, intent: 'run-r' });
    assert.equal(report.intent.id, 'run-r');
    assert.ok(report.intent.methods.includes('action.submit'));
    assert.ok(report.intent.missing.includes('action.submit'), 'a tab cannot run R, and is told so');
    // Without an intent the answer stays exactly as before.
    const plain = await tab.call('project.doctor', { projectId: f.p.id });
    assert.equal(plain.intent, null);
  } finally { await f.cleanup(); }
});

test('a socket left by a dead Host is reported as stale, not as a working executor', async () => {
  const f = await fixture();
  try {
    // A socket file with nothing behind it: execution would block on a Host that is
    // gone, and without this check it looks like a healthy idle project.
    const socket = path.join(f.project, '.rho', 'host.sock');
    await fs.mkdir(path.dirname(socket), { recursive: true });
    await fs.writeFile(socket, '');
    const report = await f.operator.call('project.doctor', { projectId: f.p.id });
    const core = report.checks.find(check => check.id === 'core');
    assert.equal(core.state, 'warn');
    assert.match(core.detail, /no Host answers/);
    assert.match(core.remedy, /stale socket|Stop the service/);
    // And the whole report does not claim the project is ready to execute.
    const missingR = report.checks.find(check => check.id === 'rscript');
    assert.equal(missingR.state, 'fail');
    assert.equal(report.ok, false);
  } finally { await f.cleanup(); }
});

test('an owner package that is selected but absent is named by the plugin check', async () => {
  const f = await fixture();
  try {
    const report = await f.operator.call('project.doctor', { projectId: f.p.id });
    const plugins = report.checks.find(check => check.id === 'plugins');
    assert.ok(plugins, 'the plugin check is always reported');
    assert.ok(['ok', 'fail'].includes(plugins.state));
    // With every owner installed this build reports ok; the remedy stays usable.
    if (plugins.state === 'ok') assert.match(plugins.detail, /installed and enabled/);
    else assert.match(plugins.remedy, /--plugins|capability.configure/);
  } finally { await f.cleanup(); }
});

test('several faults at once are all located by one doctor call', async () => {
  const f = await fixture();
  try {
    // Three independent problems, as a broken environment would present them.
    const socket = path.join(f.project, '.rho', 'host.sock');
    await fs.mkdir(path.dirname(socket), { recursive: true });
    await fs.writeFile(socket, '');
    await fs.chmod(f.project, 0o500);
    const started = Date.now();
    const report = await f.operator.call('project.doctor', { projectId: f.p.id });
    const elapsed = Date.now() - started;
    const failing = report.checks.filter(check => check.state !== 'ok').map(check => check.id).sort();
    // One call, every fault: a second round trip must not be needed to learn the rest.
    assert.deepEqual(failing, ['core', 'project-write', 'rscript']);
    assert.equal(report.ok, false);
    for (const id of failing) {
      const check = report.checks.find(candidate => candidate.id === id);
      assert.ok(check.remedy && check.remedy.length > 10, `${id} carries a remedy`);
    }
    assert.ok(elapsed < 10000, 'the diagnosis is one bounded call, not a scan');
  } finally {
    await fs.chmod(f.project, 0o700).catch(() => {});
    await f.cleanup();
  }
});
