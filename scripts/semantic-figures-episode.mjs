// Two real native plot adapters, installed as a separate package in an owned Rho.
// Scientific inputs are public package data; this checks interaction, not biology.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';

const repo = path.resolve(import.meta.dirname, '..');
const owner = path.resolve(repo, '../Rho-plugins');
const episode = path.resolve(process.env.RHO_FIGURE_EPISODE ?? path.join(repo, 'work/semantic-figures', 'run-' + Date.now()));
const projectPath = path.join(episode, 'projects', 'figure-trial'), evidence = path.join(episode, 'evidence');
const report = { passed: false, checks: [], errors: [], widths: [], at: new Date().toISOString() };
const done = message => { report.checks.push(message); console.log('ok · ' + message); };
const execute = (program, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(program + ': ' + output)));
});
let service, browser, client, project, plugin, sequence = 0;
const cellText = cell => cell.outputs.map(o => o.text ?? '').join('\n') + (cell.error ? JSON.stringify(cell.error) : '');
async function finished(cellId) {
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    const cell = (await client.call('kernel.read', { projectId: project.id, cellId })).cells[0];
    if (['done', 'error', 'unknown', 'interrupted'].includes(cell.state)) return cell;
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('Observation deadline reached for original cell ' + cellId);
}
async function invoke(operation, input = {}, changeId = 'episode-' + ++sequence) {
  const receipt = await client.call('extension.call', { projectId: project.id, pluginId: plugin.id, expectedDigest: plugin.digest, operation, input, changeId });
  assert.equal(receipt.state, 'completed', receipt.error); return receipt.value;
}
async function capture(adapter, source, title) {
  const value = await invoke('capture', { adapter, source, title, showCategory: 3 });
  const cell = await finished(value.cell.cellId); assert.equal(cell.state, 'done', cellText(cell));
  const figure = await invoke('read', { id: value.id });
  report[adapter] = { id: value.id, cellId: cell.cellId, digest: figure.digest, source: figure.figure.source, versions: figure.figure.versions, entities: figure.figure.entities.length, plots: figure.figure.plots.map(({ id, boundMarks }) => ({ id, boundMarks })), output: cellText(cell) };
  return figure;
}
try {
  await fs.mkdir(projectPath, { recursive: true }); await fs.mkdir(evidence, { recursive: true });
  const prepare = path.join(owner, 'examples/semantic-figures/prepare.R');
  if (process.env.RHO_FIGURE_INPUT) {
    await fs.cp(path.resolve(process.env.RHO_FIGURE_INPUT), projectPath, { recursive: true, filter: source => !source.split(path.sep).includes('.rho') && !source.split(path.sep).includes('.rho-figures') });
    report.preparation = 'Reused the previously prepared public data and recorded enrichment result, without refitting.';
  } else report.preparation = await execute(process.env.RHO_RSCRIPT ?? 'Rscript', [prepare, projectPath, ...(process.env.RHO_FIGURE_R_LIBRARY ? [path.resolve(process.env.RHO_FIGURE_R_LIBRARY)] : [])]);
  const packed = await execute('npm', ['pack', '--ignore-scripts', '--pack-destination', episode, '--json'], { cwd: path.join(owner, 'plugins/semantic-figures') });
  const tarball = path.join(episode, JSON.parse(packed)[0].filename);
  service = await new RhoService({ root: path.join(episode, 'projects'), stateDir: path.join(episode, 'state'), example: false }).start();
  client = new RhoClient({ url: service.url, token: service.adminToken });
  project = await client.call('project.open', { path: 'figure-trial' });
  plugin = await client.call('extension.install', { source: tarball }); report.plugin = { name: plugin.name, version: plugin.version, digest: plugin.digest };
  assert.deepEqual((await invoke('list')).figures, []);
  assert.equal((await client.call('kernel.read', { projectId: project.id, limit: 1 })).sessions.length, 0);
  const seeded = await client.call('kernel.run', { projectId: project.id, language: 'r', code: 'set.seed(153); .rho_figure_episode_rng <- .Random.seed', purpose: 'Check capture preserves the shared R random state', waitMs: 0, changeId: 'episode-seed' });
  assert.equal((await finished(seeded.cell.cellId)).state, 'done');
  const tree = await capture('ggtree', 'data/bird-orders.rds', 'Bird orders · one tree, two layouts');
  const enrichment = await capture('enrichplot', 'results/go-bp.rds', 'GO enrichment · terms and contributing genes');
  assert.deepEqual(tree.figure.plots.map(p => p.boundMarks), [45, 45]);
  assert.equal(enrichment.figure.plots[0].boundMarks, 3);
  assert.equal(enrichment.figure.plots[1].boundMarks, enrichment.figure.entities.length);
  done('packed independent plugin captured real ggtree and clusterProfiler/enrichplot outputs in Rho');
  const rng = await client.call('kernel.run', { projectId: project.id, language: 'r', code: 'stopifnot(identical(.Random.seed, .rho_figure_episode_rng)); rm(.rho_figure_episode_rng, .Random.seed)', purpose: 'Verify the original random state after both native captures', waitMs: 0, changeId: 'episode-check-seed' });
  const rngCell = await finished(rng.cell.cellId); assert.equal(rngCell.state, 'done', cellText(rngCell));
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  async function open() {
    await page.goto(service.url + '/#project=' + project.id); await page.reload();
    await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find a plugin or capability' }).fill('Semantic figures');
    await page.getByRole('button', { name: 'Open Interactive figures', exact: true }).click();
    await page.locator('.extension-view').scrollIntoViewIfNeeded();
    const frame = page.frameLocator('.extension-view iframe'); await frame.locator('#work').waitFor(); return frame;
  }
  let frame = await open();
  await frame.locator('#figure-picker').selectOption(tree.id);
  const clade = tree.figure.entities.find(e => e.kind === 'clade' && e.members.length >= 4 && e.members.length <= 9);
  assert.ok(clade); report.clade = clade;
  const mark = frame.locator(`[data-rho-key="${clade.key}"]`);
  await mark.click(); await frame.locator('#status').filter({ hasText: 'Selection saved' }).waitFor();
  assert.equal(await frame.locator('#members li').count(), clade.members.length);
  await frame.getByRole('button', { name: 'Circular', exact: true }).click();
  assert.equal(await frame.locator('.selected').getAttribute('data-rho-key'), clade.key);
  assert.deepEqual((await invoke('selection', { id: tree.id, expectedDigest: tree.digest })).entities[0].members, clade.members);
  await frame.locator('.workspace').screenshot({ path: path.join(evidence, 'tree-circular-workspace.png') });
  await page.screenshot({ path: path.join(evidence, 'tree-circular-1440.png') });
  await frame.getByRole('button', { name: 'Rectangular', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'tree-rectangular-1440.png') });
  done('clicking a clade selects exact descendants; rectangular/circular switch retains selection and Agent-readable members');
  frame = await open(); await frame.locator('#figure-picker').selectOption(tree.id);
  assert.equal(await frame.locator('.selected').getAttribute('data-rho-key'), clade.key);
  done('closing and reopening the plugin restores the acknowledged semantic selection');
  await frame.locator('#figure-picker').selectOption(enrichment.id);
  const term = enrichment.figure.entities.find(e => e.kind === 'term'); report.term = term;
  await frame.locator(`[data-plot="dotplot"] [data-rho-key="${term.key}"]`).click();
  await frame.locator('#status').filter({ hasText: 'Selection saved' }).waitFor();
  assert.equal(await frame.locator(`[data-plot="cnetplot"] .selected`).count(), 1);
  assert.equal(await frame.locator(`[data-plot="cnetplot"] .linked`).count(), term.members.length);
  await frame.locator('.workspace').screenshot({ path: path.join(evidence, 'enrichment-term-workspace.png') });
  await page.screenshot({ path: path.join(evidence, 'enrichment-term-1440.png') });
  const gene = enrichment.figure.entities.find(e => e.kind === 'gene' && e.members.length > 1); assert.ok(gene); report.gene = gene;
  await frame.locator(`[data-plot="cnetplot"] [data-rho-key="${gene.key}"]`).focus();
  await frame.locator(`[data-plot="cnetplot"] [data-rho-key="${gene.key}"]`).press('Enter');
  await frame.locator('#selection-title').filter({ hasText: gene.label }).waitFor();
  await frame.locator('#status').filter({ hasText: 'Selection saved' }).waitFor();
  assert.equal(await frame.locator(`[data-plot="dotplot"] .linked`).count(), gene.members.length);
  await page.screenshot({ path: path.join(evidence, 'enrichment-gene-1440.png') });
  await frame.getByRole('button', { name: 'Show Agent context' }).click();
  await frame.locator('#context').waitFor();
  assert.deepEqual(JSON.parse(await frame.locator('#context').textContent()).keys, [gene.key]);
  done('dotplot term selects matching cnetplot genes; keyboard selection of a shared gene links its terms back to dotplot');
  // Hold only the response; the native selection still commits through the real host.
  await frame.locator('body').evaluate(() => {
    const original = rho.call.bind(rho);
    rho.call = async (...args) => {
      const reply = await original(...args);
      if (args[0] === 'select') {
        rho.call = original;
        await new Promise(resolve => { window.releaseFigureSelection = resolve; });
      }
      return reply;
    };
  });
  await frame.locator('#clear').click();
  await frame.locator('body').evaluate(async () => {
    for (let i = 0; i < 200 && !window.releaseFigureSelection; i++) await new Promise(r => setTimeout(r, 25));
    if (!window.releaseFigureSelection) throw new Error('Selection response did not arrive.');
  });
  await frame.locator('#figure-picker').selectOption(tree.id);
  await frame.locator('#figure-title').filter({ hasText: 'Bird orders' }).waitFor();
  await frame.locator('body').evaluate(() => { window.releaseFigureSelection(); delete window.releaseFigureSelection; });
  await frame.locator('#clear:not(:disabled)').waitFor();
  assert.equal(await frame.locator('.selected').getAttribute('data-rho-key'), clade.key);
  assert.deepEqual((await invoke('selection', { id: enrichment.id, expectedDigest: enrichment.digest })).keys, []);
  await frame.locator('#figure-picker').selectOption(enrichment.id);
  await frame.locator('#entity-picker').selectOption(gene.key);
  await frame.locator('#status').filter({ hasText: 'Selection saved' }).waitFor();
  await frame.locator('.workspace').screenshot({ path: path.join(evidence, 'enrichment-gene-workspace.png') });
  done('a delayed selection receipt stays with its original figure when the view switches to another capture');
  const current = await invoke('selection', { id: enrichment.id, expectedDigest: enrichment.digest });
  const rejected = await client.call('extension.call', { projectId: project.id, pluginId: plugin.id, expectedDigest: plugin.digest, operation: 'select', input: { id: enrichment.id, expectedDigest: enrichment.digest, expectedRevision: current.revision - 1, keys: [] }, changeId: 'stale-selection' });
  assert.equal(rejected.state, 'unknown'); assert.match(rejected.error, /another view/); assert.deepEqual((await invoke('selection', { id: enrichment.id, expectedDigest: enrichment.digest })).keys, [gene.key]);
  done('stale selection write is refused and leaves the acknowledged selection intact');
  await frame.locator('#context-button').click(); // leave context available, then hide by selection
  await frame.locator('#clear').click(); await frame.locator('#status').filter({ hasText: 'Selection saved' }).waitFor();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.waitForTimeout(300);
    const finding = await frame.locator('body').evaluate(body => ({ width: innerWidth, overflow: body.scrollWidth > innerWidth + 1, svg: [...document.querySelectorAll('svg')].map(s => ({ width: s.getBoundingClientRect().width, height: s.getBoundingClientRect().height })) }));
    report.widths.push({ viewport: width, ...finding }); assert.equal(finding.overflow, false);
    await page.screenshot({ path: path.join(evidence, `enrichment-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.waitForTimeout(300);
  if (!(await frame.locator('#prepare').evaluate(details => details.open))) await frame.locator('#prepare summary').click();
  await frame.locator('#adapter').waitFor({ state: 'visible' });
  await frame.locator('#adapter').selectOption('ggtree');
  await frame.locator('#source').fill('data/not-a-tree.rds'); await frame.locator('#capture').click();
  await frame.locator('#error').filter({ hasText: 'phylo' }).waitFor({ timeout: 120000 });
  await page.screenshot({ path: path.join(evidence, 'capture-failure.png') });
  await frame.locator('#source').fill('data/bird-orders.rds'); await frame.locator('#capture').click();
  await frame.locator('#figure-title').filter({ hasText: 'bird-orders.rds' }).waitFor({ timeout: 120000 });
  await page.screenshot({ path: path.join(evidence, 'capture-recovered.png') });
  done('invalid R object fails visibly; correcting the source makes a new successful capture without replacing earlier figures');
  const unseeded = await client.call('kernel.run', { projectId: project.id, language: 'r', code: 'stopifnot(!exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE))', purpose: 'Verify capture also preserves a session without a random seed', waitMs: 0, changeId: 'episode-check-unseeded' });
  const unseededCell = await finished(unseeded.cell.cellId); assert.equal(unseededCell.state, 'done', cellText(unseededCell));
  done('captures restore the shared R random state, including an originally absent seed');
  await fs.appendFile(path.join(projectPath, 'data/bird-orders.rds'), 'changed-after-capture');
  assert.equal((await invoke('read', { id: tree.id })).sourceState, 'changed');
  await frame.locator('#figure-picker').selectOption(tree.id); await frame.locator('#source-state').filter({ hasText: 'Source changed' }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'source-changed.png') });
  done('changed original file is reported while its captured figure and selection remain available');
  await fs.copyFile(path.join(projectPath, '.rho-figures', tree.id, 'source.rds'), path.join(projectPath, 'data/bird-orders.rds'));
  await frame.locator('#figure-picker').selectOption(enrichment.id);
  await frame.locator('#entity-picker').selectOption(term.key);
  await frame.locator('#status').filter({ hasText: 'Selection saved' }).waitFor();
  assert.deepEqual(report.errors, []); report.passed = true;
  report.url = service.url + '/#project=' + project.id;
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, evidence, url: report.url }));
  if (process.argv.includes('--keep')) {
    await fs.writeFile(path.join(episode, 'connection.json'), JSON.stringify({ url: service.url, token: service.adminToken, projectId: project.id }), { mode: 0o600 });
    console.log('Owned trial stays open until this process is stopped.');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} catch (error) {
  report.failure = error.stack;
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(evidence, 'episode-failure.png') }).catch(() => {});
  throw error;
}
finally {
  await fs.mkdir(evidence, { recursive: true }); await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await service?.close();
}
