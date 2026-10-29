// Sources acceptance: browsing a project's files by kind from the sidebar, through the real
// service and Chrome, without model credentials. It checks that each kind unfolds into its
// files by folder, that choosing one shows it in place in its own view without writing a
// layout, that the arrow keys and buttons move through the kind while keys inside a table or
// editor stay with that view, that Open in Studio places the file, and that the unfolded kinds
// survive a reload.
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
const shown = name => page.waitForFunction(n => document.querySelector('#preview-title')?.textContent === n && !document.querySelector('.preview-body.switching'), name, { timeout: 20000 });
const state = () => page.evaluate(() => ({
  title: document.querySelector('#preview-title')?.textContent ?? null, position: document.querySelector('.preview-position')?.textContent ?? null,
  current: document.querySelector('.project-nav .nav-file[aria-current=page]')?.textContent ?? null,
  crumbs: [...document.querySelectorAll('.location .crumb, .location .location-name')].map(e => e.textContent),
}));
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

  for (const kind of ['Data', 'Code', 'Results & figures']) {
    const row = nav.getByRole('button', { name: kind, exact: true });
    assert.equal(await row.getAttribute('aria-expanded'), 'false');
    await row.click();
    assert.equal(await row.getAttribute('aria-expanded'), 'true');
  }
  assert.deepEqual(await files(), ['airquality.csv', 'stations.csv', 'analysis.R', 'plot.R', 'wind.svg', 'ozone.svg', 'temp.svg']);
  assert.deepEqual(await nav.locator('.nav-folder').allTextContents(), ['study', 'scripts', 'figures', 'results']);
  await shot('01-unfolded');
  passed('each kind unfolds in the sidebar into its files: the top level first, then by folder');

  await nav.locator('.nav-file').filter({ hasText: 'wind.svg' }).click();
  await shown('wind.svg');
  await page.locator('.preview-body img').waitFor();
  let now = await state();
  assert.equal(now.position, '1 of 3');
  assert.equal(now.current, 'wind.svg');
  assert.deepEqual(now.crumbs, ['Projects', 'study', 'Results & figures', 'wind.svg']);
  assert.match(await page.locator('.preview-name small').textContent(), /^figures · 174 B$/);
  const snapshot = await admin.call('observation.snapshot', { projectId: opened.id });
  assert.deepEqual(snapshot.compositions, [], 'browsing writes no layout');
  await shot('02-figure');
  passed('choosing a file shows it in place with its folder, size and place in its kind, without writing a layout');

  await page.locator('#preview-title').click();
  await page.keyboard.press('ArrowRight'); await shown('ozone.svg');
  await page.keyboard.press('ArrowRight'); await shown('temp.svg');
  now = await state();
  assert.equal(now.position, '3 of 3'); assert.equal(now.current, 'temp.svg');
  assert.ok(await page.getByRole('button', { name: 'Next file' }).isDisabled(), 'no next file at the end');
  await page.getByRole('button', { name: 'Previous: ozone.svg' }).click(); await shown('ozone.svg');
  await nav.locator('.nav-file[aria-current=page]').focus();
  await page.keyboard.press('ArrowUp'); await shown('wind.svg');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'wind.svg', 'focus moves with the shown file');
  passed('the arrow keys and buttons move through the kind; in the sidebar Up and Down do too, and the sidebar marks the file shown');

  await nav.locator('.nav-file').filter({ hasText: 'airquality.csv' }).click(); await shown('airquality.csv');
  await page.locator('.preview-body .ag-row[row-index="0"]').first().waitFor({ timeout: 20000 });
  await page.locator('.preview-body .ag-cell').first().click();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300);
  assert.equal((await state()).title, 'airquality.csv', 'arrow keys in the table move between cells');
  await shot('03-table');
  await nav.locator('.nav-file').filter({ hasText: 'analysis.R' }).click(); await shown('analysis.R');
  const editor = page.locator('.preview-body .cm-content');
  await page.waitForFunction(() => /summary\(air\)/.test(document.querySelector('.preview-body .cm-content')?.textContent ?? ''), null, { timeout: 20000 });
  await editor.click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300);
  assert.equal((await state()).title, 'analysis.R', 'arrow keys in the editor move the cursor');
  // The script is highlighted as R once its language loads: comment and string in the code colours.
  const colour = text => page.evaluate(t => { const span = [...document.querySelectorAll('.preview-body .cm-content span')].find(s => s.textContent === t); return span ? getComputedStyle(span).color : null; }, text);
  await page.waitForFunction(() => [...document.querySelectorAll('.preview-body .cm-content span')].some(s => s.textContent === '# analysis'), null, { timeout: 20000 });
  assert.equal(await colour('# analysis'), 'rgb(104, 115, 111)'); assert.equal(await colour('"data/airquality.csv"'), 'rgb(61, 103, 67)');
  await shot('04-code');
  passed('a CSV shows in its table and a script in the editor, highlighted as R; arrow keys inside a view stay with that view');

  await page.getByRole('button', { name: 'Open in Studio' }).click();
  await page.locator('.studio-tab[aria-current=page]').waitFor();
  await page.getByRole('tab', { name: 'analysis.R' }).waitFor();
  await page.locator('[data-owner-view] .cm-content').first().waitFor();
  await shot('05-studio');
  await nav.locator('.nav-file').filter({ hasText: 'stations.csv' }).click(); await shown('stations.csv');
  assert.equal((await state()).position, '2 of 2');
  passed('Open in Studio places the file in the workspace; choosing another file returns to browsing');

  await page.reload();
  await nav.locator('.nav-file').first().waitFor({ timeout: 20000 });
  assert.deepEqual(await files(), ['airquality.csv', 'stations.csv', 'analysis.R', 'plot.R', 'wind.svg', 'ozone.svg', 'temp.svg']);
  passed('the unfolded kinds are kept when the page is reloaded');

  await nav.getByRole('button', { name: 'Notes', exact: true }).click();
  await nav.locator('.nav-file').filter({ hasText: 'notes.md' }).click(); await shown('notes.md');
  const reader = page.locator('.preview-body .rho-md-page');
  await reader.locator('h1', { hasText: 'Notes' }).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => { const img = document.querySelector('.preview-body .rho-md-page img'); return img?.complete && img.naturalWidth > 0; }, null, { timeout: 20000 });
  assert.equal(await reader.locator('.katex').count(), 1);
  assert.equal(await reader.locator('td').nth(1).textContent(), '41');
  assert.match(await reader.textContent(), /臭氧/);
  await page.waitForFunction(() => document.querySelector('.preview-body pre[data-language=r] .rho-tok-string'), null, { timeout: 20000 });
  assert.equal(await reader.locator('pre .rho-tok-string').evaluate(e => getComputedStyle(e).color), 'rgb(61, 103, 67)');
  await shot('06-markdown');
  // Another writer's edit to the shared buffer, as an Agent's would be, shows in the reader.
  const notes = await admin.call('document.open', { projectId: opened.id, path: 'notes.md' });
  await admin.call('document.edit', { projectId: opened.id, documentId: notes.id, expectedVersion: notes.version, edits: [{ from: 2, to: 7, insert: 'Field notes' }], undoGroup: 'acceptance-notes' });
  await reader.locator('h1', { hasText: 'Field notes' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.waitForFunction(() => /# Field notes/.test(document.querySelector('.preview-body .cm-content')?.textContent ?? ''), null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await reader.getByRole('link', { name: 'the script' }).click(); await shown('analysis.R');
  passed('a Markdown note reads as formatted text with its image, math, table and highlighted code; an edit to its buffer shows; Source shows the editor; a link opens the file');

  await nav.locator('.nav-file').filter({ hasText: 'temp.svg' }).click(); await shown('temp.svg');
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at ' + width);
    await shot('06-preview-' + width);
  }
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('dialog.drawer .nav-file').filter({ hasText: 'ozone.svg' }).click(); await shown('ozone.svg');
  assert.equal(await page.locator('dialog.drawer').count(), 0, 'choosing a file closes the drawer');
  await shot('07-drawer-pick-390');
  assert.deepEqual(report.browserErrors, []);
  passed('no horizontal overflow at 1024 and 390, a file chosen from the drawer is shown, and no page errors');
  report.passed = true;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
  await browser?.close();
  await service?.close().catch(() => {});
}
