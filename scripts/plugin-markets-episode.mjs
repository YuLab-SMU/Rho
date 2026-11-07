// Real Chrome + a controlled HTTP index; the selected package is installed from
// its real public Git commit. No R, Agent or Core execution is part of this flow.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const root = path.resolve(process.env.RHO_MARKET_EPISODE ?? 'work/plugin-markets/run-' + Date.now());
const evidence = path.join(root, 'evidence'); await fs.mkdir(path.join(root, 'projects', 'trial'), { recursive: true }); await fs.mkdir(evidence, { recursive: true });
const index = JSON.parse(await fs.readFile(new URL('../site/market/rho.json', import.meta.url), 'utf8'));
let mode = 'valid', requests = 0;
const indexServer = http.createServer((_, response) => {
  requests++; response.setHeader('content-type', 'application/json');
  if (mode === 'unavailable') { response.writeHead(503); response.end('{}'); }
  else response.end(mode === 'invalid' ? '{bad json' : JSON.stringify(index));
});
await new Promise(resolve => indexServer.listen(0, '127.0.0.1', resolve));
const indexUrl = `http://127.0.0.1:${indexServer.address().port}/rho.json`;
const report = { passed: false, checks: [], widths: [], errors: [], source: index.plugins[0].source, indexKind: 'controlled loopback HTTP fixture' };
const done = message => { report.checks.push(message); console.log('ok · ' + message); };
let service, browser, page;
try {
  service = await new RhoService({ root: path.join(root, 'projects'), stateDir: path.join(root, 'state'), example: false, coreBinary: '/missing', rscript: '/missing' }).start();
  const client = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await client.call('project.open', { path: 'trial' });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.errors.push(e.message));
  const open = async () => {
    await page.goto(service.url + '/#project=' + project.id); await page.reload();
    await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find a plugin or capability' }).fill('clusterProfiler');
  };
  await open();
  mode = 'invalid';
  await page.getByLabel('Market index URL').fill(indexUrl); await page.getByRole('button', { name: 'Add market', exact: true }).click();
  await page.locator('.market-error').filter({ hasText: 'valid UTF-8 JSON' }).waitFor();
  assert.equal((await client.call('extension.list', {})).markets.length, 0);
  await page.locator('.extension-markets').screenshot({ path: path.join(evidence, 'invalid-index.png') });
  mode = 'valid'; await page.getByRole('button', { name: 'Add market', exact: true }).click();
  await page.getByRole('button', { name: 'Install Semantic figures 0.1.0', exact: true }).waitFor();
  let listing = await client.call('extension.list', {}); const market = listing.markets[0];
  report.marketDigest = market.digest;
  assert.equal(listing.plugins.length, 0);
  await page.locator('.extension-markets').screenshot({ path: path.join(evidence, 'search-before-install.png') });
  done('invalid index is refused without configuring a source; correcting it exposes clusterProfiler through market keywords');
  const beforeReads = requests;
  await client.call('extension.list', {}); await open();
  assert.equal(requests, beforeReads);
  done('listing, searching and reopening read the saved index without network requests or package installation');
  const showMarkets = async () => {
    if (!(await page.locator('.extension-markets > details').evaluate(d => d.open))) await page.locator('.extension-markets > details > summary').click();
  };
  mode = 'unavailable'; await showMarkets();
  await page.getByRole('button', { name: 'Refresh YuLab Rho plugins', exact: true }).click();
  await page.locator('.market-cached').filter({ hasText: 'HTTP 503' }).waitFor();
  assert.equal((await client.call('extension.list', {})).markets[0].digest, market.digest);
  await page.locator('.extension-markets').screenshot({ path: path.join(evidence, 'cached-index.png') });
  done('a failed refresh names the error and keeps the last successful index and its installable selection');
  await page.getByRole('button', { name: 'Install Semantic figures 0.1.0', exact: true }).click();
  await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).waitFor({ timeout: 180000 });
  listing = await client.call('extension.list', {}); const plugin = listing.plugins[0];
  assert.equal(plugin.id, index.plugins[0].id); assert.equal(plugin.version, index.plugins[0].version);
  assert.equal(plugin.sourceCommit, '50d2427683e9077a5141b011c9696c51a00c90c5'); assert.equal(plugin.market.digest, market.digest);
  report.installed = { id: plugin.id, version: plugin.version, digest: plugin.digest, sourceCommit: plugin.sourceCommit };
  await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).click();
  await page.frameLocator('.extension-view iframe').getByRole('heading', { name: 'Semantic figures' }).waitFor();
  done('a cached market entry installs the real fixed Git package, retains its origin and opens its declared view');
  await page.getByRole('button', { name: 'Close view', exact: true }).click();
  mode = 'valid'; await showMarkets();
  await page.getByRole('button', { name: 'Refresh YuLab Rho plugins', exact: true }).click();
  await page.locator('.extension-markets > [role="status"]').filter({ hasText: 'Market refreshed.' }).waitFor();
  assert.equal((await client.call('extension.list', {})).markets[0].error, null);
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 }); await page.waitForTimeout(300);
    await page.locator('.extension-markets').scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    report.widths.push({ width, overflow }); assert.equal(overflow, false);
    await page.screenshot({ path: path.join(evidence, `market-${width}.png`) });
  }
  done('refresh recovers and the source controls remain reachable at four viewport widths');
  await page.setViewportSize({ width: 1440, height: 1050 }); await showMarkets();
  await page.getByRole('button', { name: 'Remove YuLab Rho plugins', exact: true }).click();
  await page.locator('.extension-markets > [role="status"]').filter({ hasText: 'Installed plugins are kept.' }).waitFor();
  listing = await client.call('extension.list', {});
  assert.equal(listing.markets.length, 0); assert.equal(listing.plugins[0].digest, plugin.digest);
  await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Find a plugin or capability' }).fill('cnetplot');
  await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'removed-market.png') });
  assert.deepEqual((await client.call('kernel.read', { projectId: project.id })).sessions, []);
  done('removing the market keeps its installed plugin searchable by retained keywords and starts no scientific runtime');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await service?.close(); await new Promise(resolve => indexServer.close(resolve));
  console.log(JSON.stringify({ passed: report.passed, evidence }));
}
