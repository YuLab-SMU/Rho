import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')));
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')));
const { pluginEntries, pluginGroups } = await import(pathToFileURL(path.join(packageRoot, 'dist/plugin-presentation.js')));

const driver = process.env.RHO_UI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.RHO_UI_PLAYWRIGHT_MODULE).href : import.meta.resolve('@playwright/test');
const { chromium } = await import(driver);
const directory = path.resolve(process.env.RHO_UI_EVIDENCE ?? 'work/plugin-ui/' + Date.now());
await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp('/tmp/rhop-');
const service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: '/missing', rscript: process.env.RHO_UI_RSCRIPT ?? '/usr/local/bin/Rscript' }).start();
const counts = { hostStarts: 0, nativeDispatches: 0 };
service.bridge.ensureOwnedHost = async () => { counts.hostStarts++; throw new Error('Presentation must not start a Host.'); };
const originalCall = service.bridge.call.bind(service.bridge);
service.bridge.call = (...args) => { if (args[1] === 'submit') counts.nativeDispatches++; return originalCall(...args); };
const report = { scope: 'plugin-presentation', passed: false, node: process.version, browser: '', counts, plugins: [], widths: [], checks: [], assets: JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8')) };
let browser, page;
const errors = [];
try {
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await operator.call('project.create', { name: 'Metadata 中文' });
  const catalog = await operator.call('capability.list', { projectId: project.id });
  const absent = catalog.plugins.filter(p => !p.selected || !p.packagePresent);
  for (const plugin of absent) {
    await assert.rejects(fs.stat(path.join(packageRoot, 'node_modules', plugin.package)), { code: 'ENOENT' });
    assert.equal(service.plugins.optional(plugin.id), undefined);
    assert.equal(catalog.operations.some(o => o.owner === plugin.id && o.state === 'available'), false);
    assert.equal(catalog.skills.some(s => s.id.startsWith(plugin.id + '.')), false);
  }
  report.absent = absent.map(p => p.id);
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
  await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-card').first().waitFor();
  assert.equal(await page.locator('.plugin-card').count(), catalog.plugins.length);
  const ordered = [...pluginGroups(catalog.plugins.filter(p => !absent.includes(p))).flatMap(group => group.plugins), ...absent];
  assert.deepEqual(await page.locator('.plugin-card strong').allTextContents(), ordered.map(p => p.presentation.displayName));
  await page.screenshot({ path: path.join(directory, 'catalog-1600.png'), fullPage: false });
  for (const plugin of catalog.plugins) {
    const p = plugin.presentation, entries = pluginEntries(catalog, plugin.id);
    const card = page.locator('.plugin-card').filter({ has: page.getByText(p.displayName, { exact: true }) });
    if (absent.includes(plugin)) assert.equal(await card.locator('.plugin-card-state').textContent(), 'Not part of this installation');
    else assert.equal(await card.locator('.plugin-tagline').textContent(), p.tagline);
    await card.focus(); await page.keyboard.press('Enter');
    const heading = page.locator('.plugin-detail h1'); await heading.waitFor();
    assert.equal(await heading.textContent(), p.displayName);
    assert.equal(await heading.evaluate(element => element === document.activeElement), true);
    if (absent.includes(plugin)) {
      assert.equal(await page.locator('.plugin-installed').textContent(), 'Not installed');
      assert.match(await page.locator('.plugin-notice p').textContent(), /Reinstall Rho with the full plugin set/);
      assert.equal(await page.locator('.plugin-use').count(), 0);
    }
    assert.deepEqual(await page.locator('.plugin-prompts li > span').allTextContents(), p.examplePrompts);
    assert.equal(await page.locator('.plugin-description').textContent(), p.description);
    assert.deepEqual(await page.locator('.plugin-actions .plugin-entry-name').allTextContents(), entries.actions.map(a => a.displayName));
    assert.deepEqual(await page.locator('.plugin-actions .plugin-entry-description').allTextContents(), entries.actions.map(a => a.description));
    assert.deepEqual(await page.locator('.plugin-views .plugin-entry-name').allTextContents(), entries.views.map(v => v.displayName));
    assert.deepEqual(await page.locator('.plugin-skills .plugin-entry-name').allTextContents(), entries.skills.map(s => s.presentation.displayName));
    assert.equal(await page.locator('.plugin-information').getByText(p.license, { exact: true }).count(), 1);
    assert.deepEqual(await page.locator('.plugin-information a').evaluateAll(links => links.map(a => a.href)), p.links.map(link => link.url));
    assert.equal(await page.locator('.plugin-view-note').textContent(), p.viewNote ?? '');
    for (const [index, prompt] of p.examplePrompts.entries()) {
      const copy = page.getByRole('button', { name: 'Copy prompt ' + (index + 1), exact: true });
      await copy.click(); await copy.filter({ hasText: 'Copied' }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), prompt);
    }
    await page.screenshot({ path: path.join(directory, 'detail-' + plugin.id + '-1600.png'), fullPage: false });
    await page.locator('.plugin-information').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'detail-' + plugin.id + '-bottom-1600.png'), fullPage: false });
    await page.locator('main').getByRole('button', { name: 'All plugins', exact: true }).click();
    await card.waitFor(); assert.equal(await card.evaluate(element => element === document.activeElement), true);
    report.plugins.push({ id: plugin.id, version: plugin.version, displayName: p.displayName, prompts: p.examplePrompts.length });
  }
  report.checks.push('all-nine-owner-copies-and-27-real-clipboard-copies', 'keyboard-detail-entry-and-focus-return');
  if (absent.length) report.checks.push('physically-absent-owners-have-description-only-no-imports-tools-skills-or-project-use');
  for (const width of [1600, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('main').evaluate(element => { element.scrollTop = 0; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'catalog-' + width + '.png'), fullPage: false });
    await page.locator('.plugin-card').first().click(); await page.locator('.plugin-detail').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, 'detail-' + width + '.png'), fullPage: false });
    await page.locator('.plugin-information').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'detail-bottom-' + width + '.png'), fullPage: false });
    await page.locator('main').getByRole('button', { name: 'All plugins', exact: true }).click();
    report.widths.push({ width, noOverflow: true });
  }
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.locator('.plugin-card').first().click();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Injected clipboard failure.'); }; });
  await page.getByRole('button', { name: 'Copy prompt 1', exact: true }).click();
  await page.getByText('Could not copy. Select and copy the prompt text instead.', { exact: true }).waitFor();
  await page.locator('main').getByRole('button', { name: 'All plugins', exact: true }).click();
  report.checks.push('clipboard-failure-keeps-selectable-owner-prompt');
  // Observe a genuinely missing selected executable, then restore it. Neither
  // catalog observation nor the R object's read path executes that program.
  if (service.plugins.optional('r')) {
    const configuredRscript = service.plugins.config.rscript;
    service.plugins.config.rscript = path.join(root, 'missing-Rscript');
    await page.reload();
    await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
    const rCard = page.locator('.plugin-card').filter({ has: page.getByText('R', { exact: true }) });
    await rCard.locator('.plugin-card-state').filter({ hasText: "Can't run scripts on this machine" }).waitFor();
    await rCard.click();
    await page.getByText("Can't run scripts on this machine", { exact: true }).waitFor();
    assert.match(await page.locator('.plugin-notice p').textContent(), /Reading objects.*still works/);
    await page.screenshot({ path: path.join(directory, 'native-tool-missing-1280.png'), fullPage: false });
    service.plugins.config.rscript = configuredRscript;
    await page.reload();
    report.checks.push('missing-selected-Rscript-preserves-exported-object-capability');
  }
  // Simulate an older owner catalog with no optional display fields.
  await page.route('**/api/v2/observation.snapshot', async route => {
    const response = await route.fetch(), body = await response.json(), c = body.value.catalog;
    for (const entry of [...c.plugins, ...c.operations, ...c.components, ...(c.actions ?? []), ...(c.unavailableActions ?? [])]) delete entry.presentation;
    for (const plugin of c.plugins) for (const entry of Object.values(plugin.listing ?? {}).flat()) delete entry.presentation;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-card').first().waitFor();
  assert.deepEqual(await page.locator('.plugin-card strong').allTextContents(), [...catalog.plugins.filter(p => !absent.includes(p)), ...absent].map(p => p.id));
  assert.ok((await page.locator('.plugin-tagline').allTextContents()).every(t => t === ''));
  assert.equal(await page.locator('.plugin-group > h2').count(), absent.length ? 1 : 0);
  await page.locator('.plugin-card').first().click(); await page.locator('.plugin-detail').waitFor();
  assert.equal(await page.locator('.plugin-detail h1').textContent(), catalog.plugins[0].id);
  assert.equal(await page.locator('.plugin-prompts').count(), 0);
  assert.equal(await page.locator('.plugin-entry-section li').count(), 0);
  assert.equal(await page.locator('.plugin-marker').count(), 0);
  assert.equal(await page.locator('.plugin-view-note').textContent(), '');
  await page.screenshot({ path: path.join(directory, 'missing-metadata-1280.png'), fullPage: false });
  report.checks.push('missing-metadata-renders-only-raw-plugin-name-with-empty-copy');
  assert.deepEqual(errors, []);
  assert.equal((await operator.call('action.list', { projectId: project.id })).length, 0);
  await assert.rejects(fs.stat(path.join(project.root, '.rho/host.sock')), { code: 'ENOENT' });
  assert.deepEqual(counts, { hostStarts: 0, nativeDispatches: 0 });
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, pageErrors: errors };
  await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await service.close(); await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, browser: report.browser, counts, report: path.join(directory, 'report.json') }));
