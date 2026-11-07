// Pictures of the real views for the Plugins page. Starts this checkout's service on a new
// state with the shipped PA14 example project, opens every view of every built-in plugin
// with "Show it here" on the Plugins page, and keeps what Chrome drew, with the component
// version and the file it showed. Nothing is drawn by hand and no runtime is started.
//
//   npm run build && node scripts/plugin-previews.mjs && npm run build:web
//
// Writes web/previews/<component>.png and web/previews/index.json; a view nothing in the
// example fits (a registered R value, a review draft) is reported and left without a picture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { inspectPage } from './browser-checks.mjs';

const output = path.resolve('web/previews');
const evidence = path.resolve(process.env.RHO_PREVIEW_EVIDENCE ?? 'work/plugin-previews/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp('/tmp/rho-previews-');
const report = { passed: false, project: '', browser: '', captured: [], unpictured: [], checks: [], errors: [] };
const done = text => { report.checks.push(text); console.log('ok · ' + text); };
let service, browser, page;
try {
  // With RHO_CORE_BINARY, one owned R session runs two cells so the Notebook's companion views
  // (variables, plots, data flow) picture real values; without it they picture their empty states.
  const core = process.env.RHO_CORE_BINARY, rscript = process.env.RHO_PREVIEW_RSCRIPT ?? '/usr/local/bin/Rscript';
  service = await new RhoService({ root, stateDir: path.join(root, 'state'), coreBinary: core ?? '/missing', rscript: core ? rscript : '/missing', example: true }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const projects = await admin.call('project.list', {});
  const project = projects.find(p => /PA14/i.test(p.name)) ?? projects[0];
  assert.ok(project, 'The service seeded no example project.');
  report.project = project.name;
  const catalog = await admin.call('capability.list', { projectId: project.id });
  // A plot of points shows a table registered with a key column, as an Agent registers one; the
  // example ships none, so this run registers the swarming dishes (one row per dish) for the picture.
  const dishes = 'data/swarming/single_cultures.csv';
  const bytes = await fs.readFile(path.join(project.root, dishes));
  const column = (name, type) => ({ name, type, nullValues: ['', 'NA'] });
  const registered = await admin.call('resource.register', { projectId: project.id, expectedDigest: createHash('sha256').update(bytes).digest('hex'), declaration: { kind: 'table', path: dishes,
    format: { encoding: 'csv', key: { column: 'dish', namespace: 'pa14-swarming-dish' }, columns: [column('dish', 'string'), column('genotype', 'string'), column('strain', 'number'), column('ratio', 'string'), column('replicate', 'number'), column('area', 'number'), column('circularity', 'number'), column('roundness', 'number')] } } });
  report.registered = { path: dishes, id: registered.id ?? registered.resource?.id ?? null };
  const counts = { hostStarts: 0 };
  if (!core) service.bridge.ensureOwnedHost = async () => { counts.hostStarts++; throw new Error('A preview must not start a Host.'); };
  report.session = core ? [] : 'none: RHO_CORE_BINARY is not set';
  const liveSession = async () => {
    if (!core || report.session.length) return;
    for (const cell of [
      { changeId: 'preview-read', purpose: 'Read the swarming dishes', code: 'sw <- read.csv("data/swarming/single_cultures.csv", fileEncoding = "UTF-8")\nstr(sw)' },
      { changeId: 'preview-plot', purpose: 'Plot colony area by genotype', code: 'boxplot(area ~ genotype, data = sw, log = "y", xlab = "Genotype", ylab = "Colony area")' },
    ]) {
      const reply = await admin.call('kernel.run', { projectId: project.id, language: 'r', waitMs: 180000, ...cell });
      report.session.push({ changeId: cell.changeId, state: reply.cell?.state ?? reply.state, problem: reply.cell?.problem ?? reply.problem ?? null });
      console.log('cell · ' + cell.changeId + ' · ' + (reply.cell?.state ?? reply.state));
    }
    // The open views read the session on their own schedule; give them a moment.
    await page.waitForTimeout(3000);
  };
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(service.url + '/#project=' + project.id);
  await page.reload();
  await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-card').first().waitFor();
  // The file walk that feeds "Show it here" runs after the project opens; wait for it once.
  await page.waitForTimeout(1500);
  const index = [];
  const settled = async () => {
    const body = page.locator('.plugin-view-live-body');
    await body.locator('.shell-owner, .studio-empty, .unavailable').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.plugin-view-live-body .loading-state'), null, { timeout: 20000 });
    // Editors, grids and images draw after their data arrives; give them a moment, then settle.
    await page.waitForTimeout(2500);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  for (const plugin of catalog.plugins) {
    const views = plugin.listing?.views ?? [];
    if (!views.length) continue;
    await page.locator('.plugin-card').filter({ has: page.getByText(plugin.presentation.displayName, { exact: true }) }).click();
    await page.locator('#plugin-views-title').waitFor();
    const rows = page.locator('.plugin-views > ul > li');
    const total = await rows.count();
    for (let i = 0; i < total; i++) {
      const row = rows.nth(i);
      const identity = await row.getAttribute('data-component'), version = await row.getAttribute('data-version');
      assert.ok(identity && version, 'Each view row names its component and version.');
      const name = (await row.locator('.plugin-entry-name').textContent()).trim();
      const show = row.getByRole('button', { name: 'Show it here', exact: true });
      if (await show.isDisabled()) { report.unpictured.push({ component: identity, version, reason: 'Not in this browser build' }); continue; }
      if (identity === 'rho.variables') await liveSession();
      await show.click();
      await settled();
      const body = row.locator('.plugin-view-live-body');
      const mounted = await body.locator('.shell-owner').count();
      let shows = (await row.locator('.plugin-view-live-bar code').first().textContent().catch(() => '')).trim() || 'this project';
      // The plot is pictured as a person would choose it: colony area against circularity, not the
      // first two numeric columns (strain and replicate), through the same column pickers.
      if (mounted && identity === 'rho.scatter') {
        await row.getByRole('combobox', { name: 'Column across' }).selectOption('area');
        await row.getByRole('combobox', { name: 'Column up' }).selectOption('circularity');
        await settled();
        shows += ', circularity against area';
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'live-scatter-1440.png') });
      }
      if (mounted && identity === 'rho.table') {
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'live-table-1440.png') });
        await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(600);
        const narrow = await inspectPage(page); assert.equal(narrow.overflow, false, 'a live view scrolls the page sideways at 390 px'); assert.deepEqual(narrow.unnamed, []);
        await row.locator('.plugin-view-live').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, 'live-table-390.png') });
        await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(600);
        done('a live table opens on the Plugins page at 1440 and 390 px without sideways scrolling');
      }
      if (!mounted) {
        const why = (await body.innerText()).replace(/\s+/g, ' ').trim();
        report.unpictured.push({ component: identity, version, reason: why });
        await row.locator('.plugin-view-hide').click();
        continue;
      }
      const image = identity + '.png';
      await body.screenshot({ path: path.join(output, image) });
      await fs.copyFile(path.join(output, image), path.join(evidence, image));
      const component = catalog.components.find(c => c.id === identity && c.version === version);
      index.push({ component: identity, version, package: component?.uiPackage ?? plugin.package, packageVersion: component?.uiPackageVersion ?? plugin.packageVersion, shows, capturedAt: new Date().toISOString(), image });
      report.captured.push({ component: identity, version, name, shows });
      console.log('captured · ' + plugin.id + ' · ' + name + ' · ' + shows);
      await row.locator('.plugin-view-hide').click();
    }
    const finding = await inspectPage(page); assert.equal(finding.overflow, false, plugin.id + ' scrolls horizontally'); assert.deepEqual(finding.unnamed, []);
    await page.screenshot({ path: path.join(evidence, 'detail-' + plugin.id + '.png') });
    await page.locator('main').getByRole('button', { name: 'All plugins', exact: true }).click();
    await page.locator('.plugin-card').first().waitFor();
  }
  if (!core) { assert.equal(counts.hostStarts, 0); assert.equal(service.bridge.owned.size, 0); }
  // The index is exactly this run: a picture from an earlier run does not outlive its record.
  index.sort((a, b) => a.component.localeCompare(b.component));
  for (const file of await fs.readdir(output)) if (file.endsWith('.png') && !index.some(n => n.image === file)) await fs.rm(path.join(output, file), { force: true });
  await fs.writeFile(path.join(output, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  done(`${index.length} views pictured in ${project.name}; ${report.unpictured.length} left without a picture`);
  report.passed = report.errors.length === 0;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  await service?.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, captured: report.captured.length, unpictured: report.unpictured, errors: report.errors.slice(0, 3), evidence }, null, 2));
if (!report.passed) process.exit(1);
