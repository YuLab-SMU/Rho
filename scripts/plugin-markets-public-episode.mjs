import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

// A real public HTTPS index and its fixed public Git package; no fixture server.
const url = 'https://raw.githubusercontent.com/YuLab-SMU/Rho/main/site/market/rho.json';
const root = process.env.RHO_MARKET_EPISODE ?? await fs.mkdtemp(path.join(os.tmpdir(), 'rho-market-public-'));
const evidence = path.join(root, 'evidence'); await fs.mkdir(evidence, { recursive: true });
await fs.mkdir(path.join(root, 'projects', 'trial'), { recursive: true });
const execute = promisify(execFile);
const report = { passed: false, url, checks: [], errors: [] };
let service, browser, page;
try {
  service = await new RhoService({ root: path.join(root, 'projects'), stateDir: path.join(root, 'state'), example: false, coreBinary: '/missing', rscript: '/missing' }).start();
  const client = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await client.call('project.open', { path: 'trial' });
  const cli = args => execute(process.execPath, ['dist/cli.js', 'plugin', 'market', ...args, '--connection', path.join(root, 'state', 'connection.json')]);
  const added = JSON.parse((await cli(['add', url])).stdout), market = added.markets[0];
  assert.equal(market.url, url); assert.equal(market.plugins[0].id, 'yulab.semantic-figures');
  assert.equal(JSON.parse((await cli(['list'])).stdout)[0].digest, market.digest);
  report.index = { title: market.title, digest: market.digest, fetchedAt: market.fetchedAt, source: market.plugins[0].source };
  report.checks.push('CLI adds the published HTTPS index and lists its retained digest');
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(service.url + '/#project=' + project.id); await page.reload();
  await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find a plugin or capability' }).fill('clusterProfiler');
  await page.getByRole('button', { name: 'Install Semantic figures 0.1.0', exact: true }).waitFor();
  await page.locator('.extension-markets > details > summary').click();
  await page.locator('.extension-markets').screenshot({ path: path.join(evidence, 'public-search.png') });
  report.checks.push('the browser finds the public entry by clusterProfiler and displays its public source');
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.locator('.extension-markets').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.locator('.extension-markets').screenshot({ path: path.join(evidence, 'public-narrow.png') });
  report.checks.push('the full public HTTPS URL and market controls fit the 390 px view');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Install Semantic figures 0.1.0', exact: true }).click();
  await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).waitFor({ timeout: 180000 });
  const plugin = (await client.call('extension.list', {})).plugins[0];
  assert.equal(plugin.market.url, url); assert.equal(plugin.market.digest, market.digest);
  assert.equal(plugin.sourceCommit, '50d2427683e9077a5141b011c9696c51a00c90c5');
  report.installed = { id: plugin.id, version: plugin.version, digest: plugin.digest, sourceCommit: plugin.sourceCommit };
  await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).click();
  await page.frameLocator('.extension-view iframe').getByRole('heading', { name: 'Semantic figures' }).waitFor();
  await page.locator('.extension-open').screenshot({ path: path.join(evidence, 'public-installed.png') });
  report.checks.push('the public Git package installs at the selected identity and its actual view opens');
  const refreshed = JSON.parse((await cli(['refresh', market.id])).stdout).markets[0];
  assert.equal(refreshed.error, null); assert.equal(refreshed.digest, market.digest);
  assert.deepEqual((await client.call('kernel.read', { projectId: project.id })).sessions, []);
  report.checks.push('explicit public refresh succeeds and no scientific runtime has started');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = error.stack;
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await service?.close();
  console.log(JSON.stringify({ passed: report.passed, evidence, checks: report.checks }));
}
