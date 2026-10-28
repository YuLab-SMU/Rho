import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { inspectResponsive } from './browser-checks.mjs';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
let driver;
try { driver = process.env.RHO_UI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.RHO_UI_PLAYWRIGHT_MODULE).href : import.meta.resolve('@playwright/test'); }
catch { throw new Error('Browser acceptance needs the external test driver. Set RHO_UI_PLAYWRIGHT_MODULE to an installed @playwright/test entry; the product does not install a browser driver.'); }
const { chromium } = await import(driver);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')));
const { platformKind } = await import(pathToFileURL(path.join(packageRoot, 'dist/browser.js')));
const { runtime } = await import(pathToFileURL(path.join(packageRoot, 'dist/runtime.js')));
const native = await runtime();
const directory = path.resolve(process.env.RHO_UI_EVIDENCE ?? 'work/frontend-entry-' + Date.now());
await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp('/tmp/rhou-');
const state = path.join(root, '.service');
const sourceFixtures = await fs.mkdtemp('/private/tmp/rho-source-ui-');
for (const name of ['Source A', 'Source B', 'Source C']) await fs.mkdir(path.join(sourceFixtures, name));
const countsFile = path.join(root, 'native-counts.jsonl');
const instrument = path.join(root, 'instrument.mjs');
const folderResult = path.join(root, 'folder-result.json');
await fs.writeFile(folderResult, 'null');
await fs.writeFile(instrument, `import { appendFileSync, readFileSync } from 'node:fs';
import { CoreBridge } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist/bridge.js')).href)};
import { NativeFolderPicker } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist/native-folders.js')).href)};
NativeFolderPicker.prototype.choose = async function() { return JSON.parse(readFileSync(${JSON.stringify(folderResult)}, 'utf8')); };
const file = ${JSON.stringify(countsFile)};
const start = CoreBridge.prototype.ensureOwnedHost, call = CoreBridge.prototype.call;
CoreBridge.prototype.ensureOwnedHost = function(...args) { appendFileSync(file, '{"event":"host-start"}\\n'); return start.apply(this, args); };
CoreBridge.prototype.call = function(...args) { if (args[1] === 'submit') appendFileSync(file, '{"event":"dispatch"}\\n'); return call.apply(this, args); };
`);
let child, browser, context, page, url, port = 0;
const errors = [];
const run = promisify(execFile);
const report = { scenario: 'entry-and-recovery', passed: false, node: process.version, npmInstall: process.env.RHO_UI_INSTALLED === '1' ? 'outside-checkouts' : 'source-build', browser: '', counts: { hostStarts: 0, nativeDispatches: 0 }, widths: [], checks: [], limits: ['Folder chooser result is injected at the native boundary; no physical OS picker interaction is claimed'], assets: JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8')) };
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
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
const focused = locator => page.waitForFunction(selector => document.activeElement?.matches(selector), locator);
const inspect = name => inspectResponsive(page, { name, evidence: directory, report });
async function trapped(container) {
  for (const key of [...Array(12).fill('Tab'), ...Array(4).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    assert.equal(await container.evaluate(el => el.contains(document.activeElement)), true, key + ': ' + await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 250)));
  }
}
try {
  const ready = await start();
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  // Opening this url on this machine is the access: no link, no code, no credential.
  await page.goto(url);
  await page.getByRole('heading', { name: 'Your projects', exact: true }).waitFor();
  await inspect('direct');
  assert.deepEqual(await page.evaluate(() => [Object.keys(sessionStorage), Object.keys(localStorage)]), [[], []]);
  await page.goto('about:blank'); await page.goto(ready.openUrl);
  await page.getByRole('heading', { name: 'Your projects', exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  assert.equal(new URL(page.url()).hash, ''); assert.equal(new URL(page.url()).search, '');
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  const admin = await operator();
  assert.ok(!(await page.content()).includes(admin.connection.token));
  assert.ok(!(await page.content()).includes(admin.connection.token));
  const { stdout } = await run(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--pair', path.join(state, 'connection.json')]);
  const another = JSON.parse(stdout), second = await context.newPage(), third = await context.newPage();
  await second.goto(another.openUrl); await second.getByRole('heading', { name: 'Your projects' }).waitFor();
  await third.goto(another.openUrl); await third.getByRole('heading', { name: 'This link has already been used' }).waitFor();
  assert.deepEqual(await third.evaluate(() => [location.hash, Object.keys(sessionStorage)]), ['', []]);
  await second.close(); await third.close();
  passed('pairing is removed from the URL, scoped to the tab and cannot be reused');
  await inspect('home-empty');
  const open = page.getByRole('button', { name: 'Open folder…', exact: true });
  await open.click(); await open.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.textContent === 'Open folder…');
  assert.deepEqual(await admin.call('project.list', {}), []);
  passed('cancelled folder selection returns focus and creates no project');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Create project', exact: true }), field = sheet.getByRole('textbox');
  await field.fill('x'.repeat(81));
  await sheet.getByRole('alert').filter({ hasText: '80 characters' }).waitFor();
  assert.equal(await sheet.getByRole('button', { name: 'Create project', exact: true }).isDisabled(), true);
  await field.fill('notes 中文');
  for (const name of ['Source A', 'Source B']) {
    await fs.writeFile(folderResult, JSON.stringify(path.join(sourceFixtures, name)));
    await sheet.getByRole('button', { name: 'Add folder…', exact: true }).click();
    await sheet.getByText(path.join(sourceFixtures, name), { exact: true }).waitFor();
  }
  await trapped(sheet); await inspect('create-project');
  await sheet.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('heading', { name: 'notes 中文', exact: true }).waitFor();
  const [project] = await admin.call('project.list', {}), call = (method, args = {}) => admin.call(method, { projectId: project.id, ...args });
  assert.equal(project.sources.length, 2);
  await page.locator('.project-nav').getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check project', exact: true }).click();
  await page.getByText(/Rho can write in /).first().waitFor();
  await inspect('project-settings');
  passed('project creation validates input and retains the two selected source folders');
  const document = await call('document.open', { path: 'notes 中文.md' });
  const edited = await call('document.edit', { documentId: document.id, expectedVersion: document.version, edits: [{ from: 0, to: 0, insert: 'Shared notes 中文 🧬\n' }], undoGroup: 'initial' });
  const model = '{"coefficients":[1.5,-0.2]}'; await fs.writeFile(path.join(project.root, 'model.json'), model);
  const object = await call('resource.register', { expectedDigest: createHash('sha256').update(model).digest('hex'), declaration: { path: 'model.json', kind: 'object', format: { encoding: 'json', observation: 'exported-snapshot', classes: ['list'] } } });
  await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [
    { id: 'root', kind: 'group', children: ['object', 'notes'] },
    { id: 'object', kind: 'view', component: 'rho.object', version: '0.2.0', props: { title: 'Model' }, bindings: { data: { id: object.id, version: object.version } } },
    { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Pinned notes' }, bindings: { document: { documentId: document.id, version: edited.version } } }
  ] }] });
  await page.locator('.project-nav').getByRole('button', { name: /^workspace/ }).click();
  await page.getByRole('heading', { name: "This view can't be shown here yet" }).waitFor();
  await inspect('unavailable-view');
  await page.getByText('View reference', { exact: true }).click();
  await page.getByText(object.id, { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Pinned notes', exact: true }).click();
  await page.locator('.rho-doc .cm-content').filter({ hasText: 'Shared notes 中文 🧬' }).waitFor();
  assert.equal(await page.locator('.rho-doc .cm-content').getAttribute('contenteditable'), 'false');
  await page.reload(); await page.locator('.rho-doc .cm-content').waitFor();
  passed('unsupported views explain their source and exact document versions remain read-only after reload');
  const palette = page.getByRole('dialog', { name: 'Commands', exact: true });
  await page.keyboard.press('Meta+k'); await palette.waitFor();
  await palette.getByRole('combobox', { name: 'Command', exact: true }).fill('why is my plot empty');
  assert.equal(await palette.getByRole('option').count(), 0);
  await page.keyboard.press('Enter'); assert.equal(await palette.isVisible(), true);
  await page.keyboard.press('Escape'); await focused('.command-trigger');
  await context.setOffline(true); await page.getByRole('status').filter({ hasText: 'Offline' }).waitFor();
  const notice = page.locator('.offline-bar[role="alert"]'); await notice.waitFor();
  assert.match(await page.locator('.rho-doc .cm-content').innerText(), /Shared notes 中文/);
  await inspect('offline');
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v2/observation.snapshot', async route => { await held; await route.continue(); }, { times: 1 });
  await context.setOffline(false);
  const requests = [], record = request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith('/api/')) requests.push(pathname.replace(/^\/api\/(v2\/)?/, '')); };
  page.on('request', record);
  await notice.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Connecting' }).waitFor();
  assert.equal(await notice.getByRole('button', { name: 'Reconnect', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(directory, 'reconnecting.png') }); release();
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor(); await notice.waitFor({ state: 'hidden' });
  page.off('request', record); assert.ok(requests.length > 0);
  for (const method of requests) assert.match(method, /^(project\.list|observation\.[a-z]+|events|capability\.list|composition\.read|document\.read)$/);
  await stop(); await start(); await page.reload();
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  assert.equal((await (await operator()).call('document.read', { projectId: project.id, documentId: document.id })).content, edited.content);
  passed('offline retains the read snapshot; reconnect only reads; restart retains acknowledged text');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await trapped(drawer); await page.keyboard.press('Escape'); await focused('.topbar > button');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const agentPanel = page.getByRole('dialog', { name: 'Agent panel', exact: true });
  await agentPanel.getByRole('textbox').fill('Draft 中文'); await trapped(agentPanel);
  await page.keyboard.press('Escape'); await focused('.agent-toggle');
  passed('navigation and Agent dialogs contain keyboard focus and return it on Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Connection & access', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect this tab', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Disconnect this tab?' });
  const before = await page.evaluate(() => Object.keys(sessionStorage).sort());
  await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).sort()), before);
  await page.getByRole('button', { name: 'Disconnect this tab', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'This tab is disconnected', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), []);
  await inspect('disconnected');
  passed('cancelled disconnect keeps state; confirmed disconnect clears this tab including the request draft');
  await page.close(); assert.equal((await (await operator()).call('action.list', { projectId: project.id })).length, 0);
  assert.deepEqual(errors, []);
  for (const entry of report.assets.assets) {
    const bytes = await fs.readFile(path.join(packageRoot, 'dist/web', entry.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  let events = ''; try { events = await fs.readFile(countsFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  report.counts.hostStarts = events.split('\n').filter(l => l.includes('host-start')).length;
  report.counts.nativeDispatches = events.split('\n').filter(l => l.includes('dispatch')).length;
  assert.deepEqual(report.counts, { hostStarts: 0, nativeDispatches: 0 });
  passed('entry and observation start no Host and dispatch no scientific work'); report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message.slice(0, 1800), pageErrors: errors };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await context?.close(); await browser?.close(); await stop();
  await fs.rm(sourceFixtures, { recursive: true, force: true });
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, browser: report.browser, counts: report.counts, report: path.join(directory, 'report.json') }));
