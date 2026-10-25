// W3 exit check (docs/WORKSPACE-PLAN.md): the pages outside the workspace — the unpaired
// landing, Home, the project overview with every disclosure closed and open, the plugin
// catalog and a plugin page, the context panel with its Agents (W4), and the disconnected
// tab — hold M4, M5 and M7–M10 at four viewports. Content is created through the owners, never by editing the page.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
import { rulers, profiles } from './rulers.mjs';
const evidence = path.resolve(process.env.RHO_PAGES_EVIDENCE ?? 'work/pages-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-pages-'), state = path.join(root, '.service');
const report = { scenario: 'W3-pages', passed: false, pages: [], rulers: [] };
const required = ['M4', 'M5', 'M7', 'M8', 'M9', 'M10'];
let child, browser;
try {
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--core', native.coreBinary, '--rscript', native.rscript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('Launcher readiness timed out')), 20000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
  });
  const admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const measure = async name => {
    const results = await rulers(page, { name, profile: profiles.shell, evidence, restore: [1440, 900] });
    const failing = results.flatMap(r => r.failures.filter(f => required.some(m => f.startsWith(m + ' '))).map(f => `${name} ${r.width}: ${f}`));
    report.pages.push({ name, failing });
    report.rulers.push(...results);
    process.stdout.write(`${name}: ${failing.length ? failing.join('; ') : 'M4 M5 M7-M10 hold at four widths'}\n`);
    return failing;
  };
  const failing = [];

  // A tab that was never paired says how to get a connected one. Measured in its own tab:
  // adding the link's fragment to the same document would not load it again.
  const unpaired = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await unpaired.goto(new URL(ready.openUrl).origin + '/');
  await unpaired.getByRole('heading', { name: 'Open Rho from your Agent', exact: true }).waitFor();
  const results = await rulers(unpaired, { name: 'unpaired', profile: profiles.shell, evidence, restore: [1440, 900] });
  const missing = results.flatMap(r => r.failures.filter(f => required.some(m => f.startsWith(m + ' '))).map(f => `unpaired ${r.width}: ${f}`));
  report.pages.push({ name: 'unpaired', failing: missing }); report.rulers.push(...results); failing.push(...missing);
  process.stdout.write(`unpaired: ${missing.length ? missing.join('; ') : 'M4 M5 M7-M10 hold at four widths'}\n`);
  await unpaired.close();
  await page.goto(ready.openUrl);
  await page.getByRole('heading', { name: /^Welcome/ }).waitFor();
  failing.push(...await measure('home-empty'));

  // A project with a document, a registered table, a run and a layout gives every page content.
  const project = await admin.call('project.create', { name: 'Pages 中文' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  await fs.writeFile(path.join(project.root, 'notes.md'), 'Notes 🧬\n');
  const notes = await call('document.open', { path: 'notes.md' });
  const csv = 'id,score\n' + Array.from({ length: 12 }, (_, i) => `r${i},${i}`).join('\n') + '\n';
  await fs.writeFile(path.join(project.root, 'results.csv'), csv);
  const table = await call('resource.register', { expectedDigest: createHash('sha256').update(csv).digest('hex'), declaration: { path: 'results.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'rows' } } } });
  // The same real R run as S7: a declared table, a completion inventory, owner-verified bytes.
  await fs.writeFile(path.join(project.root, 'analysis.R'), ['out <- commandArgs(trailingOnly=TRUE)[1]', 'write.csv(data.frame(id=c("a","b"),v=c(1,2)),file.path(out,"out.csv"),row.names=FALSE,quote=TRUE)', 'f <- file.path(out,"out.csv")',
    'inventory <- list(schemaVersion=1L,complete=TRUE,artifacts=list(list(path="out.csv",bytes=unname(file.size(f)),sha256=digest::digest(f,algo="sha256",file=TRUE))))', 'writeLines(jsonlite::toJSON(inventory,auto_unbox=TRUE),file.path(dirname(out),"inventory.json"))', ''].join('\n'));
  const script = await call('document.open', { path: 'analysis.R' });
  const grant = await call('session.grant', { externalSessionId: 'pages-agent', methods: ['action.submit', 'action.lookup', 'task.map.declare'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);
  await agent.call('action.submit', { projectId: project.id, operationId: 'pages-run', action: 'r.execute', actionVersion: '0.2.0', input: { script: { kind: 'disk', path: 'analysis.R', digest: script.diskDigest }, args: [], requirements: [{ package: 'digest', source: 'cran' }, { package: 'jsonlite', source: 'cran' }], artifacts: [{ path: 'out.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'v', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'pages' } } }], completion: 'inventory.json' } });
  for (let i = 0; i < 120; i++) { const run = await agent.call('action.lookup', { projectId: project.id, operationId: 'pages-run' }); if (!['active', 'unobserved'].includes(run.execution)) break; await new Promise(r => setTimeout(r, 250)); }
  await agent.call('task.map.declare', { projectId: project.id, expectedVersion: 0, changeId: 'pages', question: 'Do the scores rise?', vocabulary: { kinds: { check: { label: 'Check' } }, states: { open: { label: 'still open' } } }, items: [{ id: 'rise', kind: 'check', state: 'open', title: 'Scores rise with row order' }], next: [] });
  await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'pages', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['notes', 'table'] }, { id: 'notes', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'Notes' }, bindings: { document: { kind: 'live-document', documentId: notes.id } } }, { id: 'table', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'Results' }, bindings: { data: { id: table.id, version: table.version } } }] }] });

  await page.reload();
  const row = page.locator('.project-row').filter({ hasText: 'Pages 中文' });
  await row.waitFor();
  failing.push(...await measure('home'));
  await row.click();
  await page.getByRole('heading', { name: 'Do the scores rise?', exact: true }).waitFor();
  await page.getByText('pages-run', { exact: false }).first().waitFor();
  failing.push(...await measure('overview'));
  for (const summary of await page.locator('main details > summary').all()) await summary.click();
  await page.getByRole('button', { name: 'Check this project…', exact: true }).click();
  await page.getByText(/Rho can write in /).first().waitFor();
  failing.push(...await measure('overview-open'));

  await page.locator('.app-rail').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
  failing.push(...await measure('plugins'));
  await page.locator('.plugin-card').first().click();
  await page.getByRole('button', { name: /^Back to / }).or(page.getByRole('complementary', { name: 'Plugin navigation', exact: true })).first().waitFor();
  failing.push(...await measure('plugin'));

  // The context panel names the Agent session with access, what it may do and when it last acted.
  await page.locator('.project-row').or(page.locator('.app-rail').getByRole('button', { name: 'Projects', exact: true })).first().click();
  await page.getByRole('button', { name: 'Context & access', exact: true }).click();
  const session = page.locator('[data-rho-agent-session="granted"]').filter({ hasText: 'pages-agent' });
  await session.waitFor();
  assert.match(await session.innerText(), /Can read, change and run code[\s\S]*Last active \d\d:\d\d/);
  failing.push(...await measure('context'));
  await page.getByRole('button', { name: 'Disconnect this tab', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disconnect this tab?' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('heading', { name: 'This tab is disconnected', exact: true }).waitFor();
  failing.push(...await measure('disconnected'));

  assert.deepEqual(failing, [], 'rulers outside the workspace');
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message.slice(0, 3000) }; process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, report: path.join(evidence, 'report.json') }) + '\n');
}
