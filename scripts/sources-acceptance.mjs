// Sources acceptance: a project's files by kind and by folder, as views of the person's workspace
// in Studio, through the real service and Chrome, without model credentials. It checks that the
// arrow at the end of a kind's row lists its files in the sidebar, that the row itself puts the
// kind's list in the workspace, that a file chosen in the sidebar, in a list or in the Files
// explorer opens as a view beside it, that keys inside a table or editor stay with that view,
// that a Markdown note reads as formatted text, and that the listed kinds survive a reload.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const evidence = path.resolve(process.env.RHO_SOURCES_EVIDENCE ?? 'work/sources-acceptance/' + new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-sources-acceptance-');
const report = { passed: false, root, checks: [], screenshots: [], browserErrors: [] };
const passed = name => { report.checks.push(name); process.stdout.write('ok · ' + name + '\n'); };
let service, browser, page;
const svg = (fill, height) => `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#fff"/><rect x="30" y="${100 - height}" width="40" height="${height}" fill="${fill}"/></svg>`;
const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(path.basename(file)); };
// The tab of the view on show in the pane that holds it, and that view's body.
const tab = name => page.getByRole('tab', { name, exact: true });
const shown = name => tab(name).and(page.locator('[aria-selected=true]')).waitFor({ timeout: 20000 });
const body = () => page.locator('[data-owner-view]:visible');
try {
  const project = path.join(root, 'study');
  for (const [file, text] of Object.entries({
    'data/airquality.csv': 'month,temp,ozone\n5,67,41\n6,72,36\n7,84,59\n', 'data/stations.csv': 'id,name\n1,Central Park\n2,La Guardia\n',
    'analysis.R': '# analysis\nair <- read.csv("data/airquality.csv")\nsummary(air)\n', 'scripts/plot.R': 'library(ggplot2)\n',
    'notes.md': '# Notes\n\nOzone by month. 臭氧 See [the script](analysis.R); temperature explains half ($R^2 = 0.49$).\n\n![Wind](figures/wind.svg)\n\n| Month | Ozone |\n|---|--:|\n| 5 | 41 |\n\n```r\nair <- read.csv("data/airquality.csv") # load\n```\n',
    'results/ozone.svg': svg('#2a78d6', 60), 'results/temp.svg': svg('#c0504d', 80), 'figures/wind.svg': svg('#4f9d69', 40),
  })) { await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true }); await fs.writeFile(path.join(project, file), text); }
  service = await new RhoService({ root, stateDir: path.join(root, '.service'), coreBinary: path.join(root, 'absent-core'), rscript: 'Rscript' }).start();
  const admin = new RhoClient({ url: service.url, token: service.adminToken });
  const opened = await admin.call('project.open', { path: 'study' });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(service.url);
  await page.locator('.project-row').first().click();
  const nav = page.locator('.project-nav');
  const files = () => nav.locator('.nav-file').allTextContents();
  await page.waitForFunction(() => document.querySelector('.project-nav')?.textContent?.includes('Results & figures3'), null, { timeout: 20000 });

  const fold = noun => nav.getByRole('button', { name: new RegExp('^(List|Hide) the ' + noun + 's here$') });
  for (const noun of ['data file', 'script', 'result']) {
    assert.equal(await fold(noun).getAttribute('aria-expanded'), 'false');
    await fold(noun).click();
    assert.equal(await fold(noun).getAttribute('aria-expanded'), 'true');
  }
  assert.deepEqual(await files(), ['airquality.csv', 'stations.csv', 'analysis.R', 'plot.R', 'wind.svg', 'ozone.svg', 'temp.svg']);
  assert.deepEqual(await nav.locator('.nav-folder').allTextContents(), ['study', 'scripts', 'figures', 'results']);
  assert.deepEqual((await admin.call('observation.snapshot', { projectId: opened.id })).compositions, [], 'listing writes no layout');
  await shot('01-unfolded');
  passed('the arrow at the end of each kind lists its files in the sidebar: the top level first, then by folder');

  // A kind's own row puts its list in the workspace, and a file chosen there opens beside it.
  await nav.getByRole('button', { name: 'Results & figures', exact: true }).click();
  await page.locator('.place-tabs [aria-current=page]', { hasText: 'Studio' }).waitFor();
  await shown('Results & figures');
  const list = page.locator('.tool-kind');
  assert.deepEqual((await list.locator('.files-name').evaluateAll(es => es.map(e => e.firstChild?.textContent))).sort(), ['ozone.svg', 'temp.svg', 'wind.svg']);
  await list.getByRole('button', { name: /^wind\.svg/ }).click();
  await shown('wind.svg');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-owner-view] img')].some(img => img.complete && img.naturalWidth > 0), null, { timeout: 20000 });
  assert.ok(await list.isVisible(), 'the list stays beside the file it opened');
  const placed = (await admin.call('observation.snapshot', { projectId: opened.id })).compositions;
  assert.deepEqual(placed.map(c => c.compositionId), ['workspace']);
  assert.deepEqual(placed[0].views.map(v => v.component).sort(), ['rho.media', 'rho.sources']);
  await shot('02-list-and-figure');
  passed("a kind's row puts its list in the workspace, and a file chosen in it opens as a view beside the list");

  // A file chosen in the sidebar opens in the same workspace.
  await nav.locator('.nav-file').filter({ hasText: 'airquality.csv' }).click(); await shown('airquality.csv');
  await page.locator('[data-owner-view] .ag-row[row-index="0"]').first().waitFor({ timeout: 20000 });
  await page.locator('[data-owner-view] .ag-cell').first().click();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
  assert.equal(await tab('airquality.csv').getAttribute('aria-selected'), 'true', 'arrow keys in the table move between cells');
  await shot('03-table');
  await nav.locator('.nav-file').filter({ hasText: 'analysis.R' }).click(); await shown('analysis.R');
  const content = () => page.locator('[data-owner-view] .cm-content:visible').last();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-owner-view] .cm-content')].some(e => /summary\(air\)/.test(e.textContent ?? '')), null, { timeout: 20000 });
  await content().click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300);
  assert.equal(await tab('analysis.R').getAttribute('aria-selected'), 'true', 'arrow keys in the editor move the cursor');
  // The script is highlighted as R once its language loads: comment and string in the code colours.
  const colour = text => page.evaluate(t => { const span = [...document.querySelectorAll('[data-owner-view] .cm-content span')].find(s => s.textContent === t); return span ? getComputedStyle(span).color : null; }, text);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-owner-view] .cm-content span')].some(s => s.textContent === '# analysis'), null, { timeout: 20000 });
  assert.equal(await colour('# analysis'), 'rgb(104, 115, 111)'); assert.equal(await colour('"data/airquality.csv"'), 'rgb(61, 103, 67)');
  await shot('04-code');
  passed('a CSV chosen in the sidebar opens in its table and a script in the editor, highlighted as R; arrow keys inside a view stay with that view');

  // The folders as a file explorer, in the pane the list is in: a folder opens in place, a name is found.
  await nav.getByRole('button', { name: 'Files', exact: true }).click();
  await shown('Files');
  const explorer = page.locator('.tool-files');
  await explorer.getByRole('button', { name: /^scripts/ }).click();
  await explorer.getByRole('button', { name: /^plot\.R/ }).waitFor();
  assert.equal(await explorer.getByRole('button', { name: /^scripts/ }).getAttribute('aria-expanded'), 'true');
  await explorer.getByRole('searchbox', { name: 'Find a file by name' }).fill('stations');
  await explorer.getByRole('button', { name: /^stations\.csv/ }).click(); await shown('stations.csv');
  await explorer.getByRole('searchbox', { name: 'Find a file by name' }).fill('nothing-like-this');
  await explorer.getByText('No file name has', { exact: false }).waitFor();
  await explorer.getByRole('searchbox', { name: 'Find a file by name' }).fill('');
  await explorer.getByRole('button', { name: /^plot\.R/ }).waitFor();
  await shot('05-explorer');
  passed('Files is an explorer beside the work: a folder opens in place, a file is found by name and opens as a view');

  await page.reload();
  await nav.locator('.nav-file').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await files(), ['airquality.csv', 'stations.csv', 'analysis.R', 'plot.R', 'wind.svg', 'ozone.svg', 'temp.svg']);
  passed('the kinds listed in the sidebar are kept when the page is reloaded');

  await fold('note').click();
  await nav.locator('.nav-file').filter({ hasText: 'notes.md' }).click(); await shown('notes.md');
  const reader = page.locator('[data-owner-view] .rho-md-page:visible');
  await reader.locator('h1', { hasText: 'Notes' }).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => { const img = document.querySelector('[data-owner-view] .rho-md-page img'); return img?.complete && img.naturalWidth > 0; }, null, { timeout: 20000 });
  assert.equal(await reader.locator('.katex').count(), 1);
  assert.equal(await reader.locator('td').nth(1).textContent(), '41');
  assert.match(await reader.textContent(), /臭氧/);
  await page.waitForFunction(() => document.querySelector('[data-owner-view] pre[data-language=r] .rho-tok-string'), null, { timeout: 20000 });
  assert.equal(await reader.locator('pre .rho-tok-string').evaluate(e => getComputedStyle(e).color), 'rgb(61, 103, 67)');
  await shot('06-markdown');
  // Another writer's edit to the shared buffer, as an Agent's would be, shows in the reader.
  const notes = await admin.call('document.open', { projectId: opened.id, path: 'notes.md' });
  await admin.call('document.edit', { projectId: opened.id, documentId: notes.id, expectedVersion: notes.version, edits: [{ from: 2, to: 7, insert: 'Field notes' }], undoGroup: 'acceptance-notes' });
  await reader.locator('h1', { hasText: 'Field notes' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: /^(Edit|Source)$/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-owner-view] .cm-content')].some(e => /# Field notes/.test(e.textContent ?? '')), null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await reader.getByRole('link', { name: 'the script' }).click(); await shown('analysis.R');
  passed('a Markdown note reads as formatted text with its image, math, table and highlighted code; an edit to its buffer shows; Edit shows the editor and Read returns; a link opens the file');

  await nav.locator('.nav-file').filter({ hasText: 'temp.svg' }).click(); await shown('temp.svg');
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    await shot('07-workspace-' + width);
  }
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('dialog.drawer .nav-file').filter({ hasText: 'ozone.svg' }).click();
  await page.waitForFunction(() => !document.querySelector('dialog.drawer'), null, { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[role=tab][aria-selected=true]')].some(t => /ozone\.svg/.test(t.textContent ?? '')) || /ozone\.svg/.test(document.querySelector('.workspace')?.textContent ?? ''), null, { timeout: 20000 });
  await shot('08-drawer-pick-390');
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, a file chosen from the drawer opens in the workspace, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
