import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
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
const run = promisify(execFile);
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
// U1 spec: rendered text uses only weights 400/600 and an enabled primary action is the accent blue.
async function assertTheme() {
  const facts = await page.evaluate(() => ({
    weights: [...new Set([...document.querySelectorAll('body *')].filter(element => element.checkVisibility()).map(element => getComputedStyle(element).fontWeight))],
    primary: [...document.querySelectorAll('button.primary:enabled')].map(element => getComputedStyle(element).backgroundColor),
  }));
  assert.deepEqual(facts.weights.filter(weight => weight !== '400' && weight !== '600'), []);
  for (const color of facts.primary) assert.equal(color, 'rgb(58, 104, 240)');
  return facts.primary.length;
}
// Each home state is compared with its board at every representative width; the page never scrolls sideways.
async function widths(name, check = async () => {}) {
  const { width: restore, height } = page.viewportSize();
  for (const width of [1600, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await assertTheme(); await check(width);
    await page.screenshot({ path: path.join(directory, name + '-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: restore, height });
}
try {
  const ready = await start();
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  // Without a link the page only says how to get one; there is no code to type.
  await page.goto(url);
  await page.getByRole('heading', { name: 'Open Rho from your Agent', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(await assertTheme(), 0);
  await page.screenshot({ path: path.join(directory, 'not-connected-1600.png'), fullPage: true });
  // The launcher's openUrl carries the one-time code in the fragment; the page redeems it and removes it.
  assert.equal(ready.openUrl, url + '/#pair=' + ready.pairingCode);
  await page.goto('about:blank');
  await page.goto(ready.openUrl);
  await page.getByRole('heading', { name: 'Welcome to Rho', exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
  assert.equal(new URL(page.url()).search, '');
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  const stored = await page.evaluate(() => Object.keys(sessionStorage));
  assert.deepEqual(stored, ['rho.browser.session.v1']);
  assert.equal(await page.locator('.wordmark').count(), 0);
  assert.equal(await page.locator('header .location').textContent(), 'Home');
  const admin = await operator();
  const focused = handle => page.waitForFunction(element => element === document.activeElement, handle, { timeout: 2000 });
  assert.ok(!(await page.content()).includes(admin.connection.token));
  assert.ok(!(await page.content()).includes(ready.pairingCode));
  // Another tab: the operator command prints a fresh link, which connects exactly one tab.
  const { stdout } = await run(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--pair', path.join(state, 'connection.json')]);
  const another = JSON.parse(stdout);
  assert.equal(another.openUrl, url + '/#pair=' + another.pairingCode);
  const second = await context.newPage(), third = await context.newPage();
  for (const other of [second, third]) other.on('pageerror', error => errors.push(error.message));
  await second.goto(another.openUrl);
  await second.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
  await third.goto(another.openUrl);
  await third.getByRole('heading', { name: 'This link has already been used', exact: true }).waitFor();
  assert.deepEqual(await third.evaluate(() => [location.hash, Object.keys(sessionStorage)]), ['', []]);
  await third.screenshot({ path: path.join(directory, 'link-used-1600.png'), fullPage: true });
  await second.close(); await third.close();
  report.checks.push('agent-opened-one-time-link-fragment-redeemed-removed-and-not-reusable');
  // The empty home offers both entries once, inside its panel, and names the tab's folder.
  const label = await page.evaluate(() => JSON.parse(sessionStorage.getItem('rho.browser.session.v1')).rootLabel);
  assert.equal(label, await fs.realpath(root));
  assert.equal(await page.locator('.home-header button').count(), 0);
  assert.deepEqual(await page.locator('.home-empty').getByRole('button').allTextContents(), ['Open folder…', 'New project']);
  assert.ok((await page.locator('.home-title p').textContent()).includes(label));
  assert.doesNotMatch(await page.locator('main').textContent(), /pair/i);
  await widths('home-empty');
  const sheet = page.getByRole('dialog'), field = sheet.getByRole('textbox'), hint = sheet.locator('.field-hint'), inSheet = () => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'));
  const openTrigger = await page.getByRole('button', { name: 'Open folder…', exact: true }).elementHandle();
  await openTrigger.click();
  await page.getByRole('dialog', { name: 'Open folder', exact: true }).waitFor();
  assert.equal(await field.evaluate(element => element === document.activeElement), true);
  assert.equal(await sheet.locator('.input-prefix').textContent(), label + '/');
  assert.equal(await sheet.getByRole('button', { name: 'Open', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(directory, 'sheet-open-1600.png'), fullPage: true });
  // A path outside the folder is refused before any request, and the hint says what to do instead.
  await field.fill('../escape');
  assert.match(await hint.textContent(), /^That path is outside .+\. Ask your Agent to open Rho for a folder that includes it\.$/);
  assert.equal(await field.getAttribute('aria-invalid'), 'true');
  assert.equal(await sheet.getByRole('button', { name: 'Open', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(directory, 'sheet-open-outside-1600.png'), fullPage: true });
  // Tab and Shift+Tab cycle inside the sheet; Escape closes it and returns focus to its trigger.
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) { await page.keyboard.press(key); assert.equal(await inSheet(), true, key); }
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await focused(openTrigger);
  // A pasted full path inside the folder is accepted; a missing single folder offers to create it.
  await openTrigger.click();
  await field.fill(label + '/missing');
  assert.equal(await field.inputValue(), 'missing');
  await sheet.getByRole('button', { name: 'Open', exact: true }).click();
  await sheet.getByRole('button', { name: 'Create it', exact: true }).waitFor();
  assert.equal(await hint.textContent(), `missing isn't in ${label}. Check the name, or create it as a new project.`);
  await page.screenshot({ path: path.join(directory, 'sheet-open-missing-1600.png'), fullPage: true });
  await page.mouse.click(8, 8);
  await sheet.waitFor({ state: 'hidden' });
  await focused(openTrigger);
  assert.deepEqual(await admin.call('project.list', {}), []);
  report.checks.push('home-sheets-focus-trap-escape-backdrop-return-and-outside-missing-next-actions');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('dialog', { name: 'New project', exact: true }).waitFor();
  await field.fill('notes/中文');
  assert.match(await hint.textContent(), /^A name can't include “\/”\. To open a folder inside .+, use Open folder\.$/);
  await sheet.getByRole('button', { name: 'Use Open folder', exact: true }).waitFor();
  await field.fill('notes 中文');
  assert.equal(await hint.textContent(), `Creates an empty folder at ${label}/notes 中文. Nothing is installed.`);
  await widths('sheet-new', async () => assert.equal(await inSheet(), true));
  await page.keyboard.press('Enter');
  await page.getByText('No saved layout yet', { exact: true }).waitFor();
  await focused(await page.locator('main').elementHandle());
  // Inside a project: the sidebar lists Layouts and Content; the overview lists what the project holds, without JSON.
  const sidebar = page.getByRole('complementary', { name: 'Project navigation', exact: true });
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'notes 中文');
  assert.equal(await sidebar.getByRole('button', { name: 'Overview', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await sidebar.getByRole('group', { name: 'Layouts', exact: true }).textContent(), 'None saved yet');
  assert.equal(await sidebar.getByText('Retained operations').count(), 0);
  assert.deepEqual(await page.locator('main h2').allTextContents(), ['Documents 0', 'Files 0']);
  const noJson = async () => { assert.equal(await page.locator('main pre, main code').count(), 0); assert.doesNotMatch(await page.locator('main').innerText(), /[{[]\s*"/); };
  await noJson();
  await widths('overview', noJson);
  await sidebar.getByRole('button', { name: /^Files/ }).click();
  await focused(await page.locator('#overview-files').elementHandle());
  report.checks.push('project-overview-no-saved-layout-sidebar-layouts-content-no-zero-operations-no-json');
  const [p] = await admin.call('project.list', {});
  const d = await admin.call('document.open', { projectId: p.id, path: 'notes 中文.md' });
  const edited = await admin.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'Shared notes 中文 🧬\n' }], undoGroup: 'initial' });
  let composition = await admin.call('composition.apply', { projectId: p.id, compositionId: 'workspace', expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['notes'] }, { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Shared notes' }, bindings: { document: { documentId: d.id, version: edited.version } } }] }] });
  // A layout saved elsewhere appears in the overview without moving the reader; choosing it opens it.
  await page.locator('#overview-layouts').waitFor();
  assert.deepEqual(await page.locator('main h2').allTextContents(), ['Layouts 1', 'Documents 1', 'Files 0']);
  assert.equal(await sidebar.getByRole('button', { name: 'Overview', exact: true }).getAttribute('aria-current'), 'page');
  await sidebar.getByRole('button', { name: /^workspace/ }).click();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).waitFor();
  // The view explains itself in the reader's terms; identifiers wait behind View reference.
  assert.deepEqual(await page.locator('.unavailable-facts dt').allTextContents(), ['Shows', 'Needs', 'In this build']);
  assert.match(await page.locator('.unavailable-facts dd').first().textContent(), /^notes 中文\.md · version \d+ · unsaved changes$/);
  assert.equal(await page.getByText(d.id, { exact: false }).isVisible(), false);
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).getAttribute('aria-current'), 'page');
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).locator('.nav-row-count').textContent(), '1 view');
  await page.locator('.retained-tab').filter({ hasText: 'Shared notes' }).waitFor();
  await noJson();
  await widths('layout-unavailable', noJson);
  await page.getByText('View reference', { exact: true }).click();
  await page.getByText(d.id, { exact: false }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).waitFor();
  report.checks.push('unicode-project-create-real-catalog-unavailable-view-refresh');
  const commandTrigger = await page.getByRole('button', { name: /Commands/ }).elementHandle();
  const palette = page.getByRole('dialog', { name: 'Commands', exact: true }), filter = palette.getByRole('combobox', { name: 'Command', exact: true });
  const chosen = () => palette.getByRole('option', { selected: true }).textContent();
  await page.keyboard.press('Meta+k');
  await palette.waitFor();
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  // The dialog hides before its asynchronous close event returns focus to the trigger.
  await focused(commandTrigger);
  report.checks.push('keyboard-command-dialog-and-focus-return');
  // Commands: a filter, groups and a footer. Verbs follow the current state; arrows move the selection; typed questions run nothing.
  await page.keyboard.press('Meta+k');
  await focused(await filter.elementHandle());
  assert.equal(await filter.getAttribute('placeholder'), 'Type a command');
  assert.deepEqual(await palette.locator('.command-heading').allTextContents(), ['Go to', 'View', 'Connection', 'This tab']);
  assert.deepEqual(await palette.getByRole('option').allTextContents(), ['Home', 'Overviewnotes 中文', 'Plugins', 'Open another project…', 'Hide project navigation', 'Show context & access', 'RefreshReads again · starts nothing', 'Disconnect this tab']);
  assert.equal(await palette.locator('.command-footer p').textContent(), 'Commands only. To ask about your work, use Claude Code.');
  assert.equal(await chosen(), 'Home');
  await page.keyboard.press('ArrowUp');
  assert.equal(await chosen(), 'Disconnect this tab');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.equal(await chosen(), 'Overviewnotes 中文');
  await page.screenshot({ path: path.join(directory, 'commands-1600.png'), fullPage: true });
  await widths('commands', async () => assert.equal(await palette.isVisible(), true));
  await filter.fill('context');
  assert.deepEqual(await palette.getByRole('option').allTextContents(), ['Show context & access']);
  await page.keyboard.press('Enter');
  await page.getByRole('complementary', { name: 'Context and access' }).waitFor();
  await focused(commandTrigger);
  await page.keyboard.press('Meta+k');
  await filter.fill('context');
  assert.deepEqual(await palette.getByRole('option').allTextContents(), ['Hide context & access']);
  await filter.fill('why is my plot empty');
  assert.equal(await palette.getByRole('option').count(), 0);
  assert.equal(await palette.locator('.command-none').textContent(), 'No command matches “why is my plot empty”.');
  await page.keyboard.press('Enter');
  assert.equal(await palette.isVisible(), true);
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  await focused(commandTrigger);
  await page.getByRole('button', { name: 'Close context', exact: true }).click();
  report.checks.push('command-palette-filter-groups-footer-arrow-keys-state-verbs-runs-no-questions');
  // Disconnecting asks first; Escape cancels and returns focus to what opened the confirmation.
  await page.keyboard.press('Meta+k');
  await palette.getByRole('option', { name: 'Disconnect this tab', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disconnect this tab?' }).waitFor();
  await page.screenshot({ path: path.join(directory, 'disconnect-confirm-1600.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Disconnect this tab?' }).waitFor({ state: 'hidden' });
  await focused(commandTrigger);
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage).sort()), ['rho.browser.project.v1', 'rho.browser.session.v1']);
  for (const width of [1600, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await assertTheme();
    if (width === 390) {
      await page.getByRole('complementary', { name: 'Project navigation', exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Toggle project navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Close project navigation', exact: true }).waitFor();
      await page.screenshot({ path: path.join(directory, 'navigation-390.png'), fullPage: true });
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Toggle project navigation', exact: true }).evaluate(element => element === document.activeElement), true);
    }
    if (width === 1600) {
      assert.deepEqual(await page.locator('header .location > span').allTextContents(), ['notes 中文', '/', 'workspace', 'Read-only']);
      assert.equal(await page.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'), 'page');
    }
    await page.screenshot({ path: path.join(directory, 'workspace-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Context & access', exact: true }).click();
    await page.getByRole('complementary', { name: 'Context and access' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'context-' + width + '.png'), fullPage: true });
    if (width === 1600) {
      const trigger = await page.getByRole('button', { name: 'Disconnect this tab', exact: true }).elementHandle();
      await trigger.click();
      await page.getByRole('dialog', { name: 'Disconnect this tab?' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Disconnect this tab?' }).waitFor({ state: 'hidden' });
      await focused(trigger);
      await page.getByRole('complementary', { name: 'Context and access' }).waitFor();
      report.checks.push('disconnect-confirmation-from-commands-and-context-escape-returns-focus');
    }
    await page.getByRole('button', { name: 'Close context', exact: true }).click();
    report.widths.push({ width, noDocumentOverflow: true, screenshot: 'workspace-' + width + '.png' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.rho-dock .retained-tab').first().waitFor();
  const viewReference = page.locator('.view-reference summary');
  await viewReference.focus();
  composition = await admin.call('composition.apply', { projectId: p.id, compositionId: 'workspace', expectedVersion: composition.version, changeId: 'remote-second-view', operations: [{ op: 'insert', parentId: 'root', index: 1, node: { id: 'second', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Second view' }, bindings: { document: { documentId: d.id, version: edited.version } } } }] });
  await page.locator('.retained-tab').filter({ hasText: 'Second view' }).waitFor();
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).locator('.nav-row-count').textContent(), '2 views');
  assert.equal(await viewReference.evaluate(element => element === document.activeElement), true);
  report.checks.push('stable-id-remote-view-update-preserves-command-focus');
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
  assert.match(await page.locator('header').getByRole('status').textContent(), /^Up to date \d\d:\d\d$/);
  await page.screenshot({ path: path.join(directory, 'status-online-1280.png'), fullPage: true });
  await context.setOffline(true);
  await page.getByRole('status').filter({ hasText: 'Offline' }).waitFor();
  assert.match(await page.locator('header').getByRole('status').textContent(), /^Offline last read \d\d:\d\d$/);
  // A grey notice says what is shown; everything already read stays on screen.
  const notice = page.getByRole('alert').and(page.locator('.offline-bar'));
  assert.match(await notice.locator('p').textContent(), /^Can't reach Rho\. You're seeing what was read at \d\d:\d\d\.$/);
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).first().waitFor();
  assert.equal(await page.locator('.rho-dock .retained-tab').count(), 2);
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).locator('.nav-row-count').textContent(), '2 views');
  await page.keyboard.press('Meta+k');
  assert.equal(await palette.getByRole('option', { name: /^Reconnect/ }).count(), 1);
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(directory, 'status-offline-1280.png'), fullPage: true });
  await widths('offline', async () => assert.equal(await notice.isVisible(), true));
  await page.setViewportSize({ width: 1440, height: 900 });
  // Coming back from the narrow select, the views return as tabs of one group in layout order.
  await page.locator('.rho-dock .retained-tab').nth(1).waitFor();
  assert.equal(await page.locator('.rho-dock .dv-groupview').count(), 1);
  assert.deepEqual(await page.locator('.rho-dock .retained-tab').allTextContents(), ['Shared notes', 'Second view']);
  await page.getByRole('button', { name: 'Context & access', exact: true }).click();
  assert.match(await page.locator('.connection-line strong').textContent(), /^Offline since \d\d:\d\d$/);
  await page.screenshot({ path: path.join(directory, 'offline-context-1440.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close context', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.setOffline(false);
  // Hold the next snapshot so the in-progress state is observable, then release it.
  let release; const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/v2/observation.snapshot', async route => { await held; await route.continue(); }, { times: 1 });
  const requests = [], record = request => { const { pathname } = new URL(request.url()); if (pathname.startsWith('/api/')) requests.push(pathname.replace(/^\/api\/(v2\/)?/, '')); };
  page.on('request', record);
  await notice.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Connecting' }).waitFor();
  assert.match(await page.locator('header').getByRole('status').textContent(), /^Connecting last read \d\d:\d\d$/);
  assert.match(await notice.locator('p').textContent(), /^Reconnecting\. You're seeing what was read at \d\d:\d\d\.$/);
  assert.equal(await notice.getByRole('button', { name: 'Reconnect', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(directory, 'status-connecting-1280.png'), fullPage: true });
  release();
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
  await notice.waitFor({ state: 'hidden' });
  page.off('request', record);
  // Reconnect only reads again: every request it made is a read.
  assert.ok(requests.length > 0);
  for (const method of requests) assert.match(method, /^(project\.list|observation\.[a-z]+|events|capability\.list|composition\.read)$/);
  report.reconnectReads = [...new Set(requests)];
  report.checks.push('offline-notice-keeps-what-was-read-reconnect-reads-only');
  report.checks.push('offline-retains-last-snapshot-explicit-resnapshot-status-up-to-date-offline-connecting');
  await stop(); await start();
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Up to date' }).waitFor();
  assert.equal((await (await operator()).call('document.read', { projectId: p.id, documentId: d.id })).content, edited.content);
  report.checks.push('same-origin-service-restart-retains-browser-session-and-confirmed-owner-state');
  // About opens the view's plugin from the project, and Back returns to the same layout.
  const aboutButton = page.getByRole('button', { name: /^About / }).first();
  const pluginName = (await aboutButton.textContent()).slice('About '.length);
  await aboutButton.click();
  await page.getByRole('heading', { name: pluginName, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to notes 中文', exact: true }).click();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).first().waitFor();
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).getAttribute('aria-current'), 'page');
  report.checks.push('unavailable-view-shows-needs-build-about-plugin-and-back-to-project');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('header .location').textContent(), 'Plugins');
  report.checks.push('toolbar-location-read-only-chip-and-rail-highlight');
  await page.screenshot({ path: path.join(directory, 'capabilities-1280.png'), fullPage: true });
  await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(directory, 'capabilities-bottom-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  // A row shows the project, where it is and when it was added; the full time is in the tooltip.
  const row = page.locator('.project-row');
  assert.equal(await row.count(), 1);
  assert.equal(await row.locator('strong').textContent(), 'notes 中文');
  assert.equal(await row.locator('small').textContent(), label + '/notes 中文');
  assert.match(await row.locator('.project-row-time').textContent(), /^Added Today at \d\d:\d\d$/);
  assert.match(await row.locator('.project-row-time').getAttribute('title'), /\d{4}/);
  assert.equal(await assertTheme(), 1);
  report.checks.push('u1-theme-weights-400-600-and-accent-primary');
  await widths('home');
  // Creating an existing name says so and offers to open it instead.
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await field.fill('notes 中文');
  await sheet.getByRole('button', { name: 'Create', exact: true }).click();
  await sheet.getByRole('button', { name: 'Open existing', exact: true }).waitFor();
  assert.equal(await hint.textContent(), `${label}/notes 中文 already exists.`);
  await page.screenshot({ path: path.join(directory, 'sheet-exists-1280.png'), fullPage: true });
  await sheet.getByRole('button', { name: 'Open existing', exact: true }).click();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).first().waitFor();
  assert.equal((await (await operator()).call('project.list', {})).length, 1);
  // "Open another project…" returns home with focus on the most recent project.
  await page.keyboard.press('Meta+k');
  await palette.getByRole('option', { name: 'Open another project…', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  await focused(await row.elementHandle());
  report.checks.push('home-welcome-relative-time-existing-name-open-instead-and-command-focus');
  await page.getByRole('button', { name: 'Context & access', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect this tab', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disconnect this tab?' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'This tab is disconnected', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => Object.keys(sessionStorage)), []);
  await page.screenshot({ path: path.join(directory, 'disconnected-1280.png'), fullPage: true });
  report.checks.push('confirmed-disconnect-forgets-only-this-tab-credential');
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
