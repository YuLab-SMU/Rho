import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { pluginEntries } from '../dist/plugin-presentation.js';

const driver = process.env.RHO_UI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.RHO_UI_PLAYWRIGHT_MODULE).href : import.meta.resolve('@playwright/test');
const { chromium } = await import(driver);
const directory = path.resolve(process.env.RHO_UI_EVIDENCE ?? 'work/plugin-ui/' + Date.now());
await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp('/tmp/rhop-');
const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: '/missing' }).start();
const counts = { hostStarts: 0, nativeDispatches: 0 };
service.bridge.ensureOwnedHost = async () => { counts.hostStarts++; throw new Error('Presentation must not start a Host.'); };
const originalCall = service.bridge.call.bind(service.bridge);
service.bridge.call = (...args) => { if (args[1] === 'submit') counts.nativeDispatches++; return originalCall(...args); };
const report = { scope: 'plugin-presentation', passed: false, node: process.version, browser: '', counts, plugins: [], widths: [], checks: [], assets: JSON.parse(await fs.readFile(new URL('../dist/web/composition.json', import.meta.url), 'utf8')) };
let browser, page;
const errors = [];
try {
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await operator.call('project.create', { name: 'Metadata 中文' });
  const catalog = await operator.call('capability.list', { projectId: project.id });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: service.url });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.url);
  const pairing = await service.browser.createPairing();
  await page.evaluate(async ({ code, projectId }) => {
    const response = await fetch('/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const result = await response.json();
    if (!result.ok) throw new Error('Test pairing failed.');
    sessionStorage.setItem('rho.browser.session.v1', JSON.stringify({ url: location.origin, ...result.value }));
    sessionStorage.setItem('rho.browser.project.v1', projectId);
  }, { code: pairing.code, projectId: project.id });
  await page.reload();
  await page.locator('.app-rail').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-card').first().waitFor();
  assert.equal(await page.locator('.plugin-card').count(), catalog.plugins.length);
  await page.screenshot({ path: path.join(directory, 'catalog-1600.png'), fullPage: true });
  for (const plugin of catalog.plugins) {
    const p = plugin.presentation, entries = pluginEntries(catalog, plugin.id);
    const card = page.locator('.plugin-card').filter({ has: page.getByText(p.displayName, { exact: true }) });
    assert.equal(await card.locator('.plugin-tagline').textContent(), p.tagline);
    await card.focus(); await page.keyboard.press('Enter');
    const heading = page.locator('.plugin-detail h1'); await heading.waitFor();
    assert.equal(await heading.textContent(), p.displayName);
    assert.equal(await heading.evaluate(element => element === document.activeElement), true);
    assert.deepEqual(await page.locator('.plugin-prompts li > span').allTextContents(), p.examplePrompts);
    assert.deepEqual(await page.locator('.plugin-entry-section').first().locator('.plugin-entry-name').allTextContents(), entries.actions.map(a => a.displayName));
    assert.deepEqual(await page.locator('.plugin-entry-section').nth(1).locator('.plugin-entry-name').allTextContents(), entries.views.map(v => v.displayName));
    assert.equal(await page.locator('.plugin-view-note').textContent(), p.viewNote ?? '');
    for (const [index, prompt] of p.examplePrompts.entries()) {
      const copy = page.getByRole('button', { name: 'Copy prompt ' + (index + 1), exact: true });
      await copy.click(); await copy.filter({ hasText: 'Copied' }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), prompt);
    }
    await page.screenshot({ path: path.join(directory, 'detail-' + plugin.id + '-1600.png'), fullPage: true });
    await page.getByRole('button', { name: 'All plugins', exact: true }).click();
    await card.waitFor(); assert.equal(await card.evaluate(element => element === document.activeElement), true);
    report.plugins.push({ id: plugin.id, version: plugin.version, displayName: p.displayName, prompts: p.examplePrompts.length });
  }
  report.checks.push('all-nine-owner-copies-and-27-real-clipboard-copies', 'keyboard-detail-entry-and-focus-return');
  for (const width of [1600, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'catalog-' + width + '.png'), fullPage: true });
    await page.locator('.plugin-card').first().click(); await page.locator('.plugin-detail').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'detail-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'All plugins', exact: true }).click();
    report.widths.push({ width, noOverflow: true });
  }
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.locator('.plugin-card').first().click();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Injected clipboard failure.'); }; });
  await page.getByRole('button', { name: 'Copy prompt 1', exact: true }).click();
  await page.getByText('Could not copy. Select and copy the prompt text instead.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'All plugins', exact: true }).click();
  report.checks.push('clipboard-failure-keeps-selectable-owner-prompt');
  // Simulate an older owner catalog with no optional display fields.
  await page.route('**/api/v2/observation.snapshot', async route => {
    const response = await route.fetch(), body = await response.json(), c = body.value.catalog;
    for (const entry of [...c.plugins, ...c.operations, ...c.components, ...(c.actions ?? []), ...(c.unavailableActions ?? [])]) delete entry.presentation;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page.locator('.app-rail').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-card').first().waitFor();
  assert.deepEqual(await page.locator('.plugin-card strong').allTextContents(), catalog.plugins.map(p => p.id));
  assert.ok((await page.locator('.plugin-tagline').allTextContents()).every(t => t === ''));
  assert.equal(await page.locator('.plugin-group > h2').count(), 0);
  await page.locator('.plugin-card').first().click(); await page.locator('.plugin-detail').waitFor();
  assert.equal(await page.locator('.plugin-detail h1').textContent(), catalog.plugins[0].id);
  assert.equal(await page.locator('.plugin-prompts').count(), 0);
  assert.equal(await page.locator('.plugin-entry-section li').count(), 0);
  assert.equal(await page.locator('.plugin-marker').count(), 0);
  assert.equal(await page.locator('.plugin-view-note').textContent(), '');
  await page.screenshot({ path: path.join(directory, 'missing-metadata-1280.png'), fullPage: true });
  report.checks.push('missing-metadata-renders-only-raw-plugin-name-with-empty-copy');
  assert.deepEqual(errors, []);
  assert.equal((await operator.call('action.list', { projectId: project.id })).length, 0);
  await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
  assert.deepEqual(counts, { hostStarts: 0, nativeDispatches: 0 });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, pageErrors: errors };
  await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, browser: report.browser, counts, report: path.join(directory, 'report.json') }));
