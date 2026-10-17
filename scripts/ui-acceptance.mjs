import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
let driver;
try { driver = process.env.RHO_UI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.RHO_UI_PLAYWRIGHT_MODULE).href : import.meta.resolve('@playwright/test'); }
catch { throw new Error('Browser acceptance needs the external test driver. Set RHO_UI_PLAYWRIGHT_MODULE to an installed @playwright/test entry; the product does not install a browser driver.'); }
const { chromium } = await import(driver);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')));
const { runtime } = await import(pathToFileURL(path.join(packageRoot, 'dist/runtime.js')));
const native = await runtime();
const directory = path.resolve(process.env.RHO_UI_EVIDENCE ?? 'work/ui-u1/browser-' + Date.now());
await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp('/tmp/rhou-');
const state = path.join(root, '.service');
const countsFile = path.join(root, 'native-counts.jsonl');
const instrument = path.join(root, 'instrument.mjs');
await fs.writeFile(instrument, `import { appendFileSync } from 'node:fs';
import { CoreBridge } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist/bridge.js')).href)};
const file = ${JSON.stringify(countsFile)};
const start = CoreBridge.prototype.ensureOwnedHost, call = CoreBridge.prototype.call;
CoreBridge.prototype.ensureOwnedHost = function(...args) { appendFileSync(file, '{"event":"host-start"}\\n'); return start.apply(this, args); };
CoreBridge.prototype.call = function(...args) { if (args[1] === 'submit') appendFileSync(file, '{"event":"dispatch"}\\n'); return call.apply(this, args); };
`);
let child, browser, context, page, url, port = 0;
const errors = [];
const report = { scenario: 'u1-browser-shell', passed: false, node: process.version, npmInstall: process.env.RHO_UI_INSTALLED === '1' ? 'outside-checkouts' : 'source-build', browser: '', counts: { hostStarts: 0, nativeDispatches: 0 }, widths: [], checks: [], limits: ['U1 only; no owner renderer', 'Chrome 154 not installed on this host', 'Native editor IME/clipboard and U2-U4 are not accepted'], assets: JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8')) };
async function start() {
  child = spawn(process.execPath, ['--import', instrument, path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--port', String(port), '--core', native.coreBinary, '--rscript', native.rscript, ...(process.env.RHO_UI_PLUGINS ? ['--plugins', process.env.RHO_UI_PLUGINS] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RHO_CORE_BINARY: native.coreBinary } });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Launcher readiness timed out.')), 15000);
    child.stdout.on('data', data => {
      output += data.toString(); let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timer); resolve(value.ready); } } catch {}
      }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Launcher exited before readiness.')); });
  });
  url = ready.url; port = Number(new URL(url).port);
  return ready;
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
}
async function operator() { return RhoClient.fromFile(path.join(state, 'connection.json')); }
try {
  const ready = await start();
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.screenshot({ path: path.join(directory, 'pairing-1600.png'), fullPage: true });
  await page.getByLabel('Pairing code', { exact: true }).fill(ready.pairingCode);
  await page.getByRole('button', { name: 'Pair this browser', exact: true }).click();
  await page.getByRole('heading', { name: 'A workspace for your next project', exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, 'home-empty-1600.png'), fullPage: true });
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  const stored = await page.evaluate(() => Object.keys(sessionStorage));
  assert.deepEqual(stored, ['rho.browser.session.v1']);
  const admin = await operator();
  assert.ok(!(await page.content()).includes(admin.connection.token));
  assert.ok(!(await page.content()).includes(ready.pairingCode));
  report.checks.push('npm-launcher-and-same-origin-one-time-pairing');
  await page.getByLabel('Project path, relative to your paired root').fill('../escape');
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Project path, relative to your paired root').fill('notes 中文');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('heading', { name: 'No composition yet', exact: true }).waitFor();
  const [p] = await admin.call('project.list', {});
  const d = await admin.call('document.open', { projectId: p.id, path: 'notes 中文.md' });
  const edited = await admin.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'Shared notes 中文 🧬\n' }], undoGroup: 'initial' });
  let composition = await admin.call('composition.apply', { projectId: p.id, compositionId: 'workspace', expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['notes'] }, { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Shared notes' }, bindings: { document: { documentId: d.id, version: edited.version } } }] }] });
  await page.getByRole('heading', { name: 'This view is unavailable', exact: true }).waitFor();
  await page.getByText('View reference', { exact: true }).click();
  await page.getByText(d.id, { exact: false }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'This view is unavailable', exact: true }).waitFor();
  report.checks.push('unicode-project-create-scope-rejection-real-catalog-unavailable-view-refresh');
  await page.keyboard.press('Meta+k');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: /Commands/ }).evaluate(element => element === document.activeElement), true);
  report.checks.push('keyboard-command-dialog-and-focus-return');
  for (const width of [1600, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) {
      await page.getByRole('complementary', { name: 'Project navigation', exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Toggle project navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Close project navigation', exact: true }).waitFor();
      await page.screenshot({ path: path.join(directory, 'navigation-390.png'), fullPage: true });
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Toggle project navigation', exact: true }).evaluate(element => element === document.activeElement), true);
    }
    await page.screenshot({ path: path.join(directory, 'workspace-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Context', exact: true }).click();
    await page.getByRole('complementary', { name: 'Context and access' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'context-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Close context', exact: true }).click();
    report.widths.push({ width, noDocumentOverflow: true, screenshot: 'workspace-' + width + '.png' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('View', { exact: true }).focus();
  composition = await admin.call('composition.apply', { projectId: p.id, compositionId: 'workspace', expectedVersion: composition.version, changeId: 'remote-second-view', operations: [{ op: 'insert', parentId: 'root', index: 1, node: { id: 'second', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Second view' }, bindings: { document: { documentId: d.id, version: edited.version } } } }] });
  await page.getByLabel('View', { exact: true }).getByRole('option', { name: 'Second view' }).waitFor({ state: 'attached' });
  assert.equal(await page.getByLabel('View', { exact: true }).evaluate(element => element === document.activeElement), true);
  report.checks.push('stable-id-remote-view-update-preserves-command-focus');
  await context.setOffline(true);
  await page.getByRole('status').filter({ hasText: 'Disconnected' }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'Observation interrupted' }).waitFor();
  await page.screenshot({ path: path.join(directory, 'disconnected-1280.png'), fullPage: true });
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Reconnect and inspect', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Observing' }).waitFor();
  report.checks.push('offline-retains-last-snapshot-explicit-resnapshot');
  await stop(); await start();
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Observing' }).waitFor();
  assert.equal((await (await operator()).call('document.read', { projectId: p.id, documentId: d.id })).content, edited.content);
  report.checks.push('same-origin-service-restart-retains-browser-session-and-confirmed-owner-state');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Capabilities & access', exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, 'capabilities-1280.png'), fullPage: true });
  await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(directory, 'capabilities-bottom-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('heading', { name: 'Continue your work', exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, 'home-1280.png'), fullPage: true });
  await page.close();
  const probe = new RhoClient((await operator()).connection);
  assert.equal((await probe.call('action.list', { projectId: p.id })).length, 0);
  await assert.rejects(fs.stat(path.join(p.root, '.rho/host.sock')), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
  report.checks.push('browser-close-no-task-cancel-or-host-shutdown-no-page-errors');
  for (const entry of report.assets.assets) {
    const bytes = await fs.readFile(path.join(packageRoot, 'dist/web', entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  let events = ''; try { events = await fs.readFile(countsFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  report.counts.hostStarts = events.split('\n').filter(l => l.includes('host-start')).length;
  report.counts.nativeDispatches = events.split('\n').filter(l => l.includes('dispatch')).length;
  assert.deepEqual(report.counts, { hostStarts: 0, nativeDispatches: 0 });
  report.passed = true;
} catch (error) {
  // No launcher readiness (which includes a pairing code) or session data is saved.
  report.failure = { name: error.name, message: error.message.slice(0, 1800), pageErrors: errors };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close(); await browser?.close(); await stop();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, browser: report.browser, counts: report.counts, report: path.join(directory, 'report.json') }));
