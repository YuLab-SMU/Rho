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
const { platformKind } = await import(pathToFileURL(path.join(packageRoot, 'dist/browser.js')));
const { runtime } = await import(pathToFileURL(path.join(packageRoot, 'dist/runtime.js')));
const native = await runtime();
const directory = path.resolve(process.env.RHO_UI_EVIDENCE ?? 'work/ui-u1/browser-' + Date.now());
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
const report = { scenario: 'u1-browser-shell', passed: false, node: process.version, npmInstall: process.env.RHO_UI_INSTALLED === '1' ? 'outside-checkouts' : 'source-build', browser: '', counts: { hostStarts: 0, nativeDispatches: 0 }, widths: [], checks: [], limits: ['U1 shell regression; owner input is checked by acceptance:ui:u2', 'Chrome 154 not installed on this host', 'Native editor IME/clipboard and U2-U4 are not accepted'], assets: JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8')) };
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
  // Tab and Shift+Tab keep focus inside an open overlay.
  async function trapped(container) {
    for (const key of [...Array(12).fill('Tab'), ...Array(4).fill('Shift+Tab')]) {
      await page.keyboard.press(key);
      assert.equal(await container.evaluate(element => element.contains(document.activeElement) && element !== document.activeElement), true);
    }
  }
  const heights = locator => locator.evaluateAll(list => list.map(element => element.getBoundingClientRect().height));
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
  // The copy names the reader's own platform, from the same reading the interface
  // uses: userAgentData where a browser has it, navigator.platform otherwise.
  const reported = await page.evaluate(() => navigator.userAgentData?.platform ?? navigator.platform);
  const kind = platformKind(reported);
  const where = kind === 'macos' ? 'this Mac' : 'this computer';
  assert.equal(await page.locator('.home-title p').textContent(), 'Open a folder on ' + where + ', or start a new project.');
  // The command trigger shows the key that this platform's keyboard actually has.
  assert.equal(await page.locator('.command-trigger kbd').textContent(), kind === 'other' ? 'Ctrl K' : '⌘K');
  assert.doesNotMatch(await page.locator('main').textContent(), /pair/i);
  await widths('home-empty');
  const sheet = page.getByRole('dialog'), field = sheet.getByRole('textbox'), hint = sheet.locator('.field-hint'), inSheet = () => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'));
  const openTrigger = await page.getByRole('button', { name: 'Open folder…', exact: true }).elementHandle();
  await openTrigger.click();
  await page.waitForFunction(() => !document.querySelector('.home-actions button')?.disabled);
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(await sheet.count(), 0);
  await focused(openTrigger);
  assert.deepEqual(await admin.call('project.list', {}), []);
  report.checks.push('native-picker-cancel-returns-focus-without-path-form-or-project');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create project', exact: true }).waitFor();
  await field.fill('x'.repeat(81));
  assert.equal(await sheet.getByRole('alert').textContent(), 'Use a name of 80 characters or fewer.');
  await field.fill('notes 中文');
  for (const name of ['Source A', 'Source B']) {
    await fs.writeFile(folderResult, JSON.stringify(path.join(sourceFixtures, name)));
    await sheet.getByRole('button', { name: 'Add folder…', exact: true }).click();
    await sheet.getByText(path.join(sourceFixtures, name), { exact: true }).waitFor();
    await sheet.getByRole('button', { name: 'Add folder…', exact: true }).waitFor();
  }
  assert.equal(await sheet.locator('.source-folders li').count(), 2);
  await widths('sheet-new', async () => assert.equal(await inSheet(), true));
  await sheet.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByText('No saved layout yet', { exact: true }).waitFor();
  await focused(await page.locator('main').elementHandle());
  // Inside a project: the sidebar lists Layouts and Content; the overview lists what the project holds, without JSON.
  const sidebar = page.getByRole('complementary', { name: 'Project navigation', exact: true });
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'notes 中文');
  assert.equal(await sidebar.getByRole('button', { name: 'Overview', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await sidebar.getByRole('group', { name: 'Layouts', exact: true }).textContent(), 'None saved yet');
  assert.equal(await sidebar.getByText('Retained operations').count(), 0);
  assert.deepEqual(await page.locator('main h2').allTextContents(), ['Source folders', 'Documents 0', 'Files 0']);
  const noJson = async () => { assert.equal(await page.locator('main pre, main code').count(), 0); assert.doesNotMatch(await page.locator('main').innerText(), /[{[]\s*"/); };
  await noJson();
  await widths('overview', noJson);
  await sidebar.getByRole('button', { name: /^Files/ }).click();
  await focused(await page.locator('#overview-files').elementHandle());
  report.checks.push('project-overview-no-saved-layout-sidebar-layouts-content-no-zero-operations-no-json');
  const [p] = await admin.call('project.list', {});
  const d = await admin.call('document.open', { projectId: p.id, path: 'notes 中文.md' });
  const edited = await admin.call('document.edit', { projectId: p.id, documentId: d.id, expectedVersion: d.version, edits: [{ from: 0, to: 0, insert: 'Shared notes 中文 🧬\n' }], undoGroup: 'initial' });
  // Charts' scatter view is not in this build, so it explains itself; the editor views render.
  const csv = 'id,x,y\n001,1,2\n002,3,4\n';
  await fs.writeFile(path.join(p.root, 'trend.csv'), csv);
  const table = await admin.call('resource.register', { projectId: p.id, expectedDigest: createHash('sha256').update(csv).digest('hex'), declaration: { path: 'trend.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'x', type: 'number', nullValues: [] }, { name: 'y', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'trend' } } } });
  let composition = await admin.call('composition.apply', { projectId: p.id, compositionId: 'workspace', expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['notes'] }, { id: 'notes', kind: 'view', component: 'rho.scatter', version: '0.2.0', props: { title: 'Shared notes', x: 'x', y: 'y' }, bindings: { data: { id: table.id, version: table.version } } }] }] });
  // A layout saved elsewhere appears in the overview without moving the reader; choosing it opens it.
  await page.locator('#overview-layouts').waitFor();
  assert.deepEqual(await page.locator('main h2').allTextContents(), ['Source folders', 'Layouts 1', 'Documents 1', 'Files 1']);
  assert.equal(await sidebar.getByRole('button', { name: 'Overview', exact: true }).getAttribute('aria-current'), 'page');
  await sidebar.getByRole('button', { name: /^workspace/ }).click();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).waitFor();
  // The view explains itself in the reader's terms; identifiers wait behind View reference.
  assert.deepEqual(await page.locator('.unavailable-facts dt').allTextContents(), ['Shows', 'Needs', 'In this build']);
  assert.equal(await page.locator('.unavailable-facts dd').first().textContent(), 'trend.csv · table');
  assert.equal(await page.getByText(table.id, { exact: false }).isVisible(), false);
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).getAttribute('aria-current'), 'page');
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).locator('.nav-row-count').textContent(), '1 view');
  await page.locator('.retained-tab').filter({ hasText: 'Shared notes' }).waitFor();
  await noJson();
  await widths('layout-unavailable', noJson);
  await page.getByText('View reference', { exact: true }).click();
  await page.getByText(table.id, { exact: false }).waitFor();
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
      // Below 768 there is no rail or sidebar. The toolbar is 48 high with 36-pixel targets and two lines of location.
      assert.equal(await page.locator('.app-rail').isVisible(), false);
      assert.equal(await sidebar.count(), 0);
      assert.equal(await page.locator('header').evaluate(element => element.getBoundingClientRect().height), 48);
      // An editing grant has no Read-only chip; the access copy says what this tab can do.
      assert.deepEqual(await page.locator('header .location-stack > span').allTextContents(), ['workspace', 'notes 中文']);
      assert.equal(await page.getByRole('button', { name: /Commands/ }).isVisible(), false);
      for (const size of await heights(page.locator('header button:visible'))) assert.ok(size >= 36);
      const opener = await page.getByRole('button', { name: 'Open navigation', exact: true }).elementHandle();
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
      await opener.click();
      await drawer.waitFor();
      assert.equal(await drawer.locator('.drawer-top strong').textContent(), 'Rho');
      assert.deepEqual(await drawer.getByRole('navigation', { name: 'Application' }).getByRole('button').allTextContents(), ['Home', 'Projects', 'Plugins']);
      assert.equal(await drawer.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'), 'page');
      assert.equal(await drawer.getByRole('button', { name: /^workspace/ }).getAttribute('aria-current'), 'page');
      assert.equal(await drawer.locator('.drawer-foot').textContent(), 'Commands');
      for (const size of await heights(drawer.getByRole('button'))) assert.ok(size >= 36);
      await page.screenshot({ path: path.join(directory, 'navigation-390.png'), fullPage: true });
      await trapped(drawer);
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      await focused(opener);
      // Commands in the drawer opens the palette, which returns focus to the navigation button.
      await opener.click();
      await drawer.getByRole('button', { name: 'Commands', exact: true }).click();
      await palette.waitFor();
      assert.equal(await drawer.count(), 0);
      assert.equal(await palette.getByRole('option', { name: 'Show navigation', exact: true }).count(), 1);
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
      await focused(opener);
      // A choice closes the drawer.
      await opener.click();
      await drawer.getByRole('button', { name: 'Overview', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.locator('header .location-stack > span').allTextContents(), ['notes 中文', 'Overview']);
      await opener.click();
      await drawer.getByRole('button', { name: /^workspace/ }).click();
      await drawer.waitFor({ state: 'hidden' });
      await focused(opener);
      report.checks.push('narrow-no-rail-or-sidebar-toolbar-48-drawer-traps-focus-and-returns-it');
    }
    if (width === 1600) {
      assert.deepEqual(await page.locator('header .location > span').allTextContents(), ['notes 中文', '/', 'workspace']);
      assert.equal(await page.locator('header .read-only').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Projects', exact: true }).getAttribute('aria-current'), 'page');
    }
    await page.screenshot({ path: path.join(directory, 'workspace-' + width + '.png'), fullPage: true });
    const contextToggle = await page.getByRole('button', { name: 'Context & access', exact: true }).elementHandle();
    await contextToggle.click();
    // Below 768 context is a bottom sheet with Done.
    const contextPanel = width === 390 ? page.getByRole('dialog', { name: 'Context and access', exact: true }) : page.getByRole('complementary', { name: 'Context and access' });
    await contextPanel.waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'context-' + width + '.png'), fullPage: true });
    if (width === 390) {
      assert.equal(await contextPanel.evaluate(element => Math.round(element.getBoundingClientRect().bottom) === innerHeight && Math.round(element.getBoundingClientRect().width) === innerWidth), true);
      assert.deepEqual(await contextPanel.locator('h3').allTextContents(), ['Connection', 'This tab', 'Agents']);
      for (const size of await heights(contextPanel.getByRole('button'))) assert.ok(size >= 34);
      await trapped(contextPanel);
      await contextPanel.getByRole('button', { name: 'Done', exact: true }).click();
      await contextPanel.waitFor({ state: 'hidden' });
      await focused(contextToggle);
      await page.keyboard.press('Enter');
      await contextPanel.waitFor();
      await page.keyboard.press('Escape');
      await contextPanel.waitFor({ state: 'hidden' });
      await focused(contextToggle);
      report.checks.push('narrow-context-bottom-sheet-done-escape-traps-focus-and-returns-it');
      report.widths.push({ width, noDocumentOverflow: true, screenshot: 'workspace-' + width + '.png' });
      continue;
    }
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
  // The editor view now renders. An exact-version binding shows that version and cannot be edited.
  await page.locator('.retained-tab').filter({ hasText: 'Second view' }).click();
  await page.locator('.rho-doc .cm-content').filter({ hasText: 'Shared notes 中文 🧬' }).waitFor();
  assert.equal(await page.locator('.rho-doc .cm-content').getAttribute('contenteditable'), 'false');
  assert.match(await page.locator('.rho-doc-exact').textContent(), /^Showing version \d+\. This view is pinned/);
  await page.locator('.retained-tab').filter({ hasText: 'Shared notes' }).click();
  report.checks.push('editor-view-renders-exact-version-read-only');
  report.checks.push('stable-id-remote-view-update-preserves-command-focus');
  // Below 768 the views are tabs; arrows, Home and End move between them and show the view.
  await page.setViewportSize({ width: 390, height: 844 });
  const viewTabs = page.getByRole('tablist', { name: 'Views', exact: true });
  await viewTabs.waitFor();
  assert.deepEqual(await viewTabs.getByRole('tab').allTextContents(), ['Shared notes', 'Second view']);
  assert.equal(await viewTabs.getByRole('tab', { selected: true }).textContent(), 'Shared notes');
  assert.equal(await page.locator('select').count(), 0);
  await viewTabs.getByRole('tab', { name: 'Shared notes', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await viewTabs.getByRole('tab', { selected: true }).textContent(), 'Second view');
  assert.equal(await viewTabs.getByRole('tab', { name: 'Second view', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await page.getByRole('tabpanel').getAttribute('aria-labelledby'), await viewTabs.getByRole('tab', { name: 'Second view', exact: true }).getAttribute('id'));
  for (const size of await heights(viewTabs.getByRole('tab'))) assert.ok(size >= 32);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(directory, 'tabs-390.png'), fullPage: true });
  await page.keyboard.press('Home');
  assert.equal(await viewTabs.getByRole('tab', { selected: true }).textContent(), 'Shared notes');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.rho-dock .retained-tab').nth(1).waitFor();
  report.checks.push('narrow-view-tabs-arrow-home-end-no-select');
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
  for (const method of requests) assert.match(method, /^(project\.list|observation\.[a-z]+|events|capability\.list|composition\.read|document\.read)$/);
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
  // The plugin opens under Plugins, with its own sidebar, the project's state and the way back.
  const pluginSidebar = page.getByRole('complementary', { name: 'Plugin navigation', exact: true });
  assert.equal(await pluginSidebar.getByRole('button', { name: pluginName, exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.app-rail').getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current'), 'page');
  assert.deepEqual(await page.locator('header .location > :not(.location-separator)').allTextContents(), ['Plugins', pluginName]);
  assert.equal(await page.locator('.plugin-information dt').first().textContent(), 'In notes 中文');
  assert.equal(await page.locator('.plugin-use').textContent(), 'On. Claude Code can use it in this project.');
  await page.screenshot({ path: path.join(directory, 'plugin-about-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'Back to notes 中文', exact: true }).click();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).first().waitFor();
  assert.equal(await sidebar.getByRole('button', { name: /^workspace/ }).getAttribute('aria-current'), 'page');
  report.checks.push('unavailable-view-shows-needs-build-about-plugin-and-back-to-project');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Plugins', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('header .location').textContent(), 'Plugins');
  report.checks.push('toolbar-location-read-only-chip-and-rail-highlight');
  // Plugins: a usable plugin shows no state; no Capabilities wording, state flags or method names appear.
  const owner = await operator(), catalog = await owner.call('capability.list', { projectId: p.id });
  const methods = catalog.operations.map(o => o.method);
  async function pluginWording() {
    const text = await page.locator('main').innerText();
    assert.doesNotMatch(text, /capabilit|\bPresent\b|\bEnabled\b|\bSatisfied\b/i);
    for (const method of methods) assert.equal(text.includes(method), false, method);
  }
  await pluginWording();
  assert.equal(await page.locator('main .plugin-card-state').count(), 0);
  // The catalog says what plugins are for; its sidebar lists all plugins and each installed one.
  assert.equal(await page.locator('.plugin-page-heading p').textContent(), 'Plugins let Claude Code work with your code, data and figures, and let you see that work here.');
  const pluginSidebar2 = page.getByRole('complementary', { name: 'Plugin navigation', exact: true });
  assert.equal(await pluginSidebar2.getByRole('button', { name: 'All plugins', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await pluginSidebar2.locator('.project-heading span').textContent(), catalog.plugins.filter(x => x.selected && x.packagePresent).length + ' installed on this machine');
  assert.equal(await pluginSidebar2.getByRole('group', { name: 'Installed' }).getByRole('button').count(), catalog.plugins.length);
  await page.screenshot({ path: path.join(directory, 'plugins-1280.png'), fullPage: true });
  await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(directory, 'plugins-bottom-1280.png'), fullPage: true });
  // With Tables off for this project, Tables says so and Charts waits for it; each names who can change it.
  const enabled = catalog.configuration.enabled;
  await owner.call('capability.configure', { projectId: p.id, expectedVersion: catalog.configuration.version, changeId: 'ui-tables-off', enabled: enabled.filter(id => id !== 'tables') });
  const card = name => page.locator('.plugin-card').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
  await card('Tables').locator('.plugin-card-state').filter({ hasText: 'Off in notes 中文' }).waitFor();
  assert.equal(await card('Charts').locator('.plugin-card-state').textContent(), 'Waiting for Tables');
  assert.equal(await page.locator('main .plugin-card-state').count(), 2);
  await pluginWording();
  await page.locator('main').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(directory, 'plugins-states-1280.png'), fullPage: true });
  await card('Charts').click();
  await page.getByRole('heading', { name: 'Charts', exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-installed').textContent(), 'Installed');
  assert.equal(await page.locator('.plugin-notice strong').textContent(), 'Waiting for Tables');
  assert.equal(await page.locator('.plugin-notice p').textContent(), 'Charts needs Tables, which is off in notes 中文.');
  assert.deepEqual(await page.locator('.plugin-detail h2:not(.visually-hidden)').evaluateAll(list => list.map(h => h.firstChild.textContent)), ['Skills ', 'What Claude Code can do with it', 'Views ', 'Information']);
  assert.equal(await page.locator('.plugin-prompts-note').textContent(), 'Copy one and ask Claude Code.');
  assert.equal(await page.locator('.plugin-use').textContent(), 'On, but waiting for Tables.');
  assert.deepEqual(await page.locator('.plugin-needs button').allTextContents(), ['Tables']);
  await pluginWording();
  await page.screenshot({ path: path.join(directory, 'plugin-waiting-1280.png'), fullPage: true });
  await page.getByRole('button', { name: 'About Tables', exact: true }).click();
  await page.getByRole('heading', { name: 'Tables', exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-notice strong').textContent(), 'Off in notes 中文');
  assert.equal(await page.locator('.plugin-notice p').textContent(), "Claude Code can't use Tables in this project. Whoever runs Rho can turn it on for this project.");
  assert.equal(await page.locator('.plugin-use').textContent(), "Off. Claude Code can't use it in this project.");
  await pluginWording();
  await page.screenshot({ path: path.join(directory, 'plugin-off-1280.png'), fullPage: true });
  await owner.call('capability.configure', { projectId: p.id, expectedVersion: catalog.configuration.version + 1, changeId: 'ui-tables-on', enabled });
  await page.locator('.plugin-notice').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.plugin-use').textContent(), 'On. Claude Code can use it in this project.');
  await widths('plugin-detail', async width => {
    assert.equal(await page.getByRole('button', { name: 'All plugins', exact: true }).isVisible(), true);
    if (width === 390) assert.deepEqual(await page.locator('header .location-stack > span').allTextContents(), ['Tables', 'Plugins']);
  });
  // The toolbar's Plugins returns to the catalog and to the card the plugin was opened from.
  await page.locator('header').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
  await focused(await card('Tables').elementHandle());
  assert.equal(await page.locator('main .plugin-card-state').count(), 0);
  report.checks.push('plugins-catalog-sidebar-detail-sections-information-project-state-breadcrumb-back');
  report.checks.push('plugins-no-capabilities-or-state-flags-or-methods-unusable-says-why-and-who');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  // A row shows the project, where it is and when it was added; the full time is in the tooltip.
  const row = page.locator('.project-row');
  assert.equal(await row.count(), 1);
  assert.equal(await row.locator('strong').textContent(), 'notes 中文');
  assert.equal(await row.locator('small').textContent(), '2 source folders');
  assert.match(await row.locator('.project-row-time').textContent(), /^Added Today at \d\d:\d\d$/);
  assert.match(await row.locator('.project-row-time').getAttribute('title'), /\d{4}/);
  assert.equal(await assertTheme(), 1);
  report.checks.push('u1-theme-weights-400-600-and-accent-primary');
  await widths('home', async width => {
    if (width !== 390) return;
    // On Home the drawer has the three sections and Commands, without a project section.
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await drawer.waitFor();
    assert.equal(await drawer.getByRole('button', { name: 'Home', exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await drawer.locator('.drawer-project').count(), 0);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
  });
  // A project name is a display label, with no same-name directory collision.
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await field.fill('notes 中文');
  assert.equal(await sheet.getByRole('alert').count(), 0);
  assert.equal(await sheet.getByRole('button', { name: 'Create project', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await row.click();
  await page.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).first().waitFor();
  assert.equal((await (await operator()).call('project.list', {})).length, 1);
  // "Open another project…" returns home with focus on the most recent project.
  await page.keyboard.press('Meta+k');
  await palette.getByRole('option', { name: 'Open another project…', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor();
  await focused(await row.elementHandle());
  report.checks.push('home-welcome-relative-time-multiple-sources-display-name-and-command-focus');
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
  await fs.rm(sourceFixtures, { recursive: true, force: true });
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, browser: report.browser, counts: report.counts, report: path.join(directory, 'report.json') }));
