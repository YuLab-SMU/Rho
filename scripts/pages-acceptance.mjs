// Connected and unpaired project pages, with real owner records.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
import { inspectResponsive } from './browser-checks.mjs';
const evidence = path.resolve(process.env.RHO_PAGES_EVIDENCE ?? 'work/pages-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-pages-'), state = path.join(root, '.service');
const report = { scenario: 'project-pages', passed: false, pages: [], responsive: [] };
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
    const results = await inspectResponsive(page, { name, evidence, restore: [1440, 900] });
    const failing = results.flatMap(r => r.failures.map(f => `${name} ${r.width}: ${f}`));
    report.pages.push({ name, failing });
    report.responsive.push(...results);
    process.stdout.write(`${name}: ${failing.length ? failing.join('; ') : 'no page overflow or unnamed buttons at four widths'}\n`);
    return failing;
  };
  const failing = [];

  // A tab opened without any link is the application on this machine. Measured in its own tab:
  // adding a link's fragment to the same document would not load it again.
  const unpaired = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await unpaired.goto(new URL(ready.openUrl).origin + '/');
  await unpaired.getByRole('heading', { name: 'Your projects', exact: true }).waitFor();
  const results = await inspectResponsive(unpaired, { name: 'direct', evidence, restore: [1440, 900] });
  const missing = results.flatMap(r => r.failures.map(f => `direct ${r.width}: ${f}`));
  report.pages.push({ name: 'direct', failing: missing }); report.responsive.push(...results); failing.push(...missing);
  process.stdout.write(`direct: ${missing.length ? missing.join('; ') : 'no page overflow or unnamed buttons at four widths'}\n`);
  await unpaired.close();
  await page.goto(ready.openUrl);
  await page.getByRole('heading', { name: 'Your projects', exact: true }).waitFor();
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
  await page.getByRole('heading', { name: 'Pages 中文', exact: true }).waitFor();
  await page.getByText('pages-run', { exact: false }).first().waitFor();
  failing.push(...await measure('overview'));
  await page.locator('.project-nav').getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByRole('button', { name: 'Check project', exact: true }).click();
  await page.getByText(/Rho can write in /).first().waitFor();
  failing.push(...await measure('settings'));

  await page.locator('.project-nav').getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
  failing.push(...await measure('plugins'));
  await page.locator('.plugin-card').first().click();
  await page.getByRole('button', { name: /^Back to / }).or(page.getByRole('complementary', { name: 'Plugin navigation', exact: true })).first().waitFor();
  failing.push(...await measure('plugin'));

  // The Agent page's Outside Rho names the Agent session with access, what it may do and when
  // it last acted.
  await page.locator('.project-nav').getByRole('button', { name: 'Back to project', exact: true }).click();
  await page.locator('.project-nav').getByRole('button', { name: /^Agent(,|$)/ }).click();
  await page.getByRole('tab', { name: /^Outside Rho/ }).click();
  const session = page.locator('[data-rho-agent-session="granted"]').filter({ hasText: 'pages-agent' });
  await session.waitFor();
  assert.match(await session.innerText(), /Can read, change and run code[\s\S]*last call today \d\d:\d\d/);
  failing.push(...await measure('outside'));
  await page.getByRole('button', { name: 'Connection & access', exact: true }).click();
  await page.locator('#project-context').waitFor();
  failing.push(...await measure('context'));
  // This tab was opened on this machine, so it has no link to leave: the panel says where the
  // access comes from instead of offering a disconnect it cannot perform.
  assert.equal(await page.getByRole('button', { name: "Use this machine's access instead", exact: true }).count(), 0);
  assert.match(await page.locator('#project-context').innerText(), /opened directly on this machine/);
  failing.push(...await measure('direct-access'));

  assert.deepEqual(failing, [], 'inspectResponsive outside the workspace');
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
