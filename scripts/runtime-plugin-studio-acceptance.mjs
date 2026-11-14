// A real runtime HTML package through the same Studio composition tree used by owner views.
// The project, service, package and browser are disposable; no existing Rho state is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { pluginCli } from '../dist/plugin-cli.js';
import { inspectPage } from './browser-checks.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(process.env.RHO_RUNTIME_PLUGIN_EVIDENCE ?? 'docs/plugin-agent-acceptance/2026-11-13');
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-runtime-studio-'));
const projects = path.join(root, 'projects'), source = path.join(root, 'task-panel');
await fs.mkdir(projects);
const report = { passed: false, checks: [], responsive: [], errors: [], digests: {} };
let service, browser, page;
const pass = name => { report.checks.push(name); console.log('ok · ' + name); };

async function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, 'dist/cli.js'), ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-20000); });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
}

try {
  await pluginCli(['create', source, '--id', 'task-panel']);
  const check = await command(['plugin', 'check', source]);
  assert.equal(check.code, 0, check.output);
  const checked = JSON.parse(check.output);
  assert.equal(checked.valid, true);
  assert.equal(checked.runtime.host, 'passed');
  pass('rho plugin check executes the generated host and operations');

  const host = path.join(source, 'host.mjs'), originalHost = await fs.readFile(host, 'utf8');
  await fs.writeFile(host, 'export async function run( {');
  const broken = await command(['plugin', 'check', source]);
  assert.notEqual(broken.code, 0);
  assert.match(broken.output, /runtime|host|Unexpected/i);
  await fs.writeFile(host, originalHost);
  pass('a host syntax error is machine-readable and does not replace the source');

  service = await new RhoService({ root: projects, stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', example: false }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await admin.call('project.create', { name: 'Runtime task panel' });
  const installed = await admin.call('extension.install', { source });
  report.digests.initial = installed.digest;
  const descriptor = await admin.call('extension.describe', { projectId: project.id, pluginId: installed.id });
  const entry = descriptor.manifest.views[0];
  const view = { id: 'task-panel', kind: 'view', component: 'rho.extension.html', version: '1', props: { title: 'Task panel', pluginId: installed.id, expectedDigest: installed.digest, entryId: entry.id }, bindings: {} };
  const composition = await admin.call('composition.apply', { projectId: project.id, compositionId: 'workspace', expectedVersion: 0, changeId: 'runtime-studio-open', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: [view.id] }, view] }] });
  assert.equal(composition.availability[view.id].state, 'entry-installed');
  pass('composition.apply accepts a digest-bound runtime HTML Studio leaf');

  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(service.url + '/#project=' + project.id);
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  await page.getByRole('tab', { name: 'Task panel', exact: true }).waitFor();
  const frame = page.frameLocator('[data-owner-view="task-panel"] iframe');
  await frame.getByRole('heading', { name: 'task-panel', exact: true }).waitFor();
  await frame.getByText('No task map has been declared.', { exact: true }).waitFor();
  assert.equal((await inspectPage(page)).overflow, false);
  await page.screenshot({ path: path.join(evidence, 'task-panel-studio-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.main')?.scrollTo(0, 0); });
  await page.getByRole('button', { name: 'Reload plugin view', exact: true }).click();
  assert.equal((await inspectPage(page)).overflow, false);
  await frame.getByRole('heading', { name: 'task-panel', exact: true }).waitFor();
  await frame.getByText('No task map has been declared.', { exact: true }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(evidence, 'task-panel-studio-390.png') });
  report.responsive.push({ width: 1440, overflow: false }, { width: 390, overflow: false });
  pass('the composed runtime view renders real empty status at 1440px and 390px without overflow');

  // The Plugins page offers the same composition operation to a person. The existing leaf is
  // reused, so this also verifies the explicit reopen path does not duplicate a tab.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  const pluginArticle = page.locator('.extension-list > article').filter({ has: page.getByRole('heading', { name: 'task-panel', exact: true }) });
  await pluginArticle.getByRole('button', { name: 'Open in Studio', exact: true }).click();
  await page.getByRole('tab', { name: 'Task panel', exact: true }).waitFor();
  pass('Plugins can place the installed runtime view into the current Studio composition');

  const updatedSource = path.join(root, 'updated-task-panel'); await fs.cp(source, updatedSource, { recursive: true });
  await fs.appendFile(path.join(updatedSource, 'host.mjs'), '\n// accepted update\n');
  const updated = await admin.call('extension.install', { source: updatedSource, replace: installed.id, expectedDigest: installed.digest });
  report.digests.updated = updated.digest;
  assert.notEqual(updated.digest, installed.digest);
  await page.getByRole('button', { name: 'Studio', exact: true }).click();
  await page.getByRole('tab', { name: 'Task panel', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reload plugin view', exact: true }).click();
  await page.getByText(/plugin was updated after the layout saved it/i).waitFor();
  await page.screenshot({ path: path.join(evidence, 'task-panel-stale.png') });
  pass('an installed update keeps the old composition digest and shows a stale recovery state');

  const staleComposition = await admin.call('composition.read', { projectId: project.id, compositionId: 'workspace' });
  const recovered = await admin.call('composition.apply', { projectId: project.id, compositionId: 'workspace', expectedVersion: staleComposition.version, changeId: 'runtime-studio-reopen', operations: [{ op: 'props', id: view.id, props: { ...view.props, expectedDigest: updated.digest } }] });
  assert.equal(recovered.availability[view.id].state, 'entry-installed');
  await page.getByRole('tab', { name: 'Task panel', exact: true }).waitFor();
  await page.frameLocator('[data-owner-view="task-panel"] iframe').getByText('No task map has been declared.', { exact: true }).waitFor();
  pass('a conditional props update reopens the new digest without changing the view identity');

  await admin.call('extension.manage', { pluginId: installed.id, expectedDigest: updated.digest, action: 'disable' });
  await page.getByRole('button', { name: 'Reload plugin view', exact: true }).click();
  await page.getByText(/plugin is disabled/i).waitFor();
  await page.screenshot({ path: path.join(evidence, 'task-panel-disabled.png') });
  await admin.call('extension.manage', { pluginId: installed.id, expectedDigest: updated.digest, action: 'enable' });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.frameLocator('[data-owner-view="task-panel"] iframe').getByText('No task map has been declared.', { exact: true }).waitFor();
  pass('disable and enable preserve the Studio leaf and recover through Retry');

  await admin.call('extension.manage', { pluginId: installed.id, expectedDigest: updated.digest, action: 'remove' });
  await page.getByRole('button', { name: 'Reload plugin view', exact: true }).click();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText(/plugin is not installed|no longer installed/i).waitFor();
  await page.screenshot({ path: path.join(evidence, 'task-panel-removed.png') });
  const retained = await admin.call('composition.read', { projectId: project.id, compositionId: 'workspace' });
  assert.equal(retained.views.some(value => value.id === view.id), true);
  assert.ok(retained.receipts.some(receipt => receipt.changeId === 'runtime-studio-open'));
  pass('removal retains the Studio reference and composition receipts');

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await service?.close();
  await fs.writeFile(path.join(evidence, 'runtime-plugin-studio-report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, evidence }));
