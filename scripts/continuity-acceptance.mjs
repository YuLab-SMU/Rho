// Browser behavior: work outlives the tab, the service and the shell
// that showed it. A run opens from the project page in the workspace's own run view; a run's
// script, tables and figure export as ordinary files with where they came from and what was
// checked, partial and missing files said as such, and unsaved text exported only by choice;
// a lost submit reply, a disconnect and a refresh find the original run, dispatched once; a
// normal restart keeps projects, artifacts, drafts, the layout and prepared contexts; after a
// sudden exit only what was stored comes back, and what was not is marked unconfirmed until
// the service confirms it. Real Core and R; the Agent is a deterministic protocol client.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
import { inspectResponsive } from './browser-checks.mjs';
const evidence = path.resolve(process.env.RHO_CONTINUITY_EVIDENCE ?? 'work/continuity-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-continuity-'), state = path.join(root, '.service');
const report = { scenario: 'recovery-and-export', passed: false, checks: [], responsive: [] };
const passed = (name, detail = {}) => { report.checks.push({ name, ...detail }); process.stdout.write(`ok · ${name}\n`); };
const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + label + ' · last ' + JSON.stringify(value)?.slice(0, 400)); await sleep(200); }
}
let child, browser, port = 0;
async function start() {
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--port', String(port), '--core', native.coreBinary, '--rscript', native.rscript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('Launcher readiness timed out')), 20000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Launcher exited before readiness')); });
  });
  port = Number(new URL(ready.url).port);
  return ready;
}
// Observe the page and any open dialog at different viewport widths.
const inspectState = async (page, name, first) => {
  const results = await inspectResponsive(page, { name, first, evidence, report, restore: [1440, 900] });
  const failing = results.flatMap(r => r.failures.map(f => `${name} ${r.width}: ${f}`));
  assert.deepEqual(failing, []);
};
async function stop(signal = 'SIGTERM') {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(signal); await exited; }
}
try {
  const ready = await start();
  // The operator's credential is issued again at each start; read it after every restart.
  let admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const restart = async signal => {
    await stop(signal);
    for (let attempt = 0; ; attempt++) { try { await start(); break; } catch (error) { if (attempt > 10) throw error; await sleep(300); } }
    admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  };
  const project = await admin.call('project.create', { name: 'Continuity' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  const grant = await call('session.grant', { externalSessionId: 'w6-agent', methods: ['action.submit', 'action.lookup', 'action.output', 'context.read', 'composition.apply', 'composition.read', 'document.open'] });
  const agentClient = await RhoClient.fromFile(grant.connectionFile);
  const agent = (m, b = {}) => agentClient.call(m, { projectId: project.id, ...b });
  const write = async (file, text) => { await fs.writeFile(path.join(project.root, file), text); return text; };
  const input = (file, text, artifacts = []) => ({ script: { kind: 'disk', path: file, digest: digestOf(text) }, args: [], requirements: [], artifacts, completion: null });

  // A failed run the project page lists as needing attention.
  const broken = await write('broken.R', 'message("reading the samples")\nstop("Sample sheet has no id column")\n');
  await agent('action.submit', { operationId: 'w6-broken', action: 'r.execute', actionVersion: '0.2.0', input: input('broken.R', broken) });
  await until(() => agent('action.lookup', { operationId: 'w6-broken' }), r => r.execution === 'failed', 'the broken run fails');

  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.openUrl).origin });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ready.openUrl);
  await page.locator('.project-row').filter({ hasText: 'Continuity' }).click();

  // 1. The project page opens a run in the workspace's run view: the same facts, the stop and
  // the output, without loading a second account of an execution. Closing returns focus.
  const row = page.locator('.activity-row').filter({ hasText: 'w6-broken' });
  await row.click();
  const dialog = page.locator('dialog.run-dialog[open]');
  await dialog.locator('[data-rho-execution="failed"]').waitFor();
  await dialog.getByRole('button', { name: 'Show output', exact: true }).click();
  await dialog.locator('[data-rho-output="stderr"]').getByText(/Sample sheet has no id column/).waitFor();
  // The repair context it prepares is working context a restart must keep (check 5).
  await dialog.getByRole('button', { name: 'Ask the Agent to fix', exact: true }).click();
  await dialog.getByRole('button', { name: 'Copy request for the Agent', exact: true }).click();
  const contextId = (await page.evaluate(() => navigator.clipboard.readText())).match(/read context (\S+?),/)?.[1];
  assert.ok(contextId, 'the copied request names its context');
  await inspectState(page, 'run-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await row.evaluate(element => element === document.activeElement), true, 'focus returns to the run row');
  passed('the project page opens a run in the run view; closing returns focus');

  // 2. Export: a run that wrote a table and a figure, declared a file it never wrote, and
  // listed what it wrote in an inventory. Its script was edited afterwards and not saved.
  const analysis = await write('analysis.R', [
    'out <- commandArgs(trailingOnly = TRUE)[1]',
    'write.csv(data.frame(id = c("s1", "s2", "s3"), value = c(1.5, 2.5, 4)), file.path(out, "table.csv"), row.names = FALSE)',
    'png(file.path(out, "figure.png"), width = 640, height = 420)', 'plot(1:3, c(1.5, 2.5, 4), pch = 19)', 'invisible(dev.off())',
    'files <- c("table.csv", "figure.png")',
    'entries <- vapply(files, function(f) { p <- file.path(out, f); sprintf(\'{"path":"%s","bytes":%d,"sha256":"%s"}\', f, as.integer(file.size(p)), unname(tools::sha256sum(p))) }, "")',
    'writeLines(sprintf(\'{"schemaVersion":1,"complete":true,"artifacts":[%s]}\', paste(entries, collapse = ",")), file.path(dirname(out), "inventory.json"))', ''
  ].join('\n'));
  const outputs = [{ path: 'table.csv', kind: 'file', format: { mimeType: 'text/csv' } }, { path: 'figure.png', kind: 'file', format: { mimeType: 'image/png' } }, { path: 'summary.txt', kind: 'file', format: { mimeType: 'text/plain' } }];
  await agent('action.submit', { operationId: 'w6-export', action: 'r.execute', actionVersion: '0.2.0', input: { ...input('analysis.R', analysis, outputs), completion: 'inventory.json' } });
  await until(() => agent('action.lookup', { operationId: 'w6-export' }), r => r.execution === 'completed', 'the analysis completes');
  const code = await agent('document.open', { path: 'analysis.R' });
  await call('document.edit', { documentId: code.id, expectedVersion: code.version, edits: [{ from: 0, to: 0, insert: '# next idea\n' }], undoGroup: 'later' });
  await page.locator('.project-nav').getByRole('button', { name: 'Activity', exact: true }).click();
  await page.locator('.activity-row').filter({ hasText: 'w6-export' }).click();
  await dialog.locator('[data-rho-execution="completed"]').waitFor();
  await dialog.getByRole('button', { name: 'Export files…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  // The owner asks about the unsaved text; nothing is written until the person answers.
  await dialog.getByText('analysis.R has unsaved changes.').waitFor();
  await assert.rejects(fs.access(path.join(project.root, 'exports/w6-export')));
  await inspectState(page, 'export-choice');
  await dialog.getByRole('button', { name: 'Include them', exact: true }).click();
  await dialog.locator('[data-rho-export="done"]').getByText('Exported 4 files to exports/w6-export · partial').waitFor();
  await dialog.getByText('summary.txt · The run declared this file but did not write it.').waitFor();
  await inspectState(page, 'export-done');
  const exported = path.join(project.root, 'exports/w6-export'), bytes = name => fs.readFile(path.join(exported, name));
  // Each file opens without Rho: the CSV parses, the PNG is a 640×420 image, the script is the code that ran.
  const table = String(await bytes('outputs/table.csv')).trim().split('\n').map(line => line.split(','));
  assert.deepEqual(table, [['"id"', '"value"'], ['"s1"', '1.5'], ['"s2"', '2.5'], ['"s3"', '4']]);
  const png = await bytes('outputs/figure.png');
  assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [640, 420]);
  assert.equal(String(await bytes('script/analysis.R')), analysis);
  assert.equal(String(await bytes('script/analysis.unsaved.R')), '# next idea\n' + analysis);
  const record = JSON.parse(String(await bytes('provenance.json')));
  for (const f of record.files.filter(f => f.state === 'exported')) assert.equal(f.sha256, digestOf(await bytes(f.file)), f.file);
  assert.equal(record.partial, true); assert.equal(record.files.find(f => f.path === 'summary.txt').state, 'not-written');
  assert.match(String(await bytes('PROVENANCE.md')), /## What was checked\n- Each exported file has its SHA-256 here/);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  passed('a run exports as ordinary files with provenance; the missing file is named; unsaved text only by choice', { files: record.files.map(f => [f.path, f.state]) });

  // 3. A submit whose reply is lost: the form says so, finds the run in the project's runs, and
  // Core receives it once. The Agent proposes the run as a form beside the script.
  const slow = await write('slow.R', 'cat("working\\n")\nSys.sleep(6)\ncat("done\\n")\n');
  const view = (id, component, props, bindings, version = '0.2.0') => ({ id, kind: 'view', component, version, props, bindings });
  await agent('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'w6-layout', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['code', 'form'] },
    view('code', 'rho.editor', { title: 'analysis.R' }, { document: { kind: 'live-document', documentId: code.id } }),
    view('form', 'rho.action', { title: 'Run the slow step', action: 'r.execute', actionVersion: '0.2.0', operationId: 'w6-form', input: input('slow.R', slow) }, {}, '1')] }] });
  const owner = id => page.locator(`[data-owner-view="${id}"]`), form = page.locator('[data-rho-action-form="w6-form"]');
  const openLayout = async () => {
    const projectRow = page.locator('.project-row').filter({ hasText: 'Continuity' }), layoutRow = page.locator('.nav-row').filter({ hasText: 'workspace' }).first();
    await form.or(projectRow).or(layoutRow).first().waitFor();
    if (await form.isVisible()) return;
    if (await projectRow.isVisible()) await projectRow.click();
    await layoutRow.click();
    await page.getByRole('tab', { name: 'Run the slow step', exact: true }).click();
    await form.waitFor();
  };
  await openLayout();
  const dispatches = async operationId => {
    const events = JSON.parse(await fs.readFile(path.join(project.root, '.rho/rho/events.json'), 'utf8')).events.filter(e => e.subject === operationId);
    return { accepted: events.filter(e => e.type === 'operation.accepted').length, delivered: events.filter(e => e.type === 'operation.delivery').length };
  };
  // The reply to the submit is lost, and so is every read of the runs until the person acts.
  await page.route('**/api/v2/action.submit', async route => { await route.fetch(); await route.abort('connectionreset'); });
  await page.route('**/api/v2/project.runs', route => route.abort('connectionreset'));
  await form.getByRole('button', { name: 'Run', exact: true }).click();
  await form.locator('[data-rho-lost="w6-form"]').waitFor();
  assert.equal(await form.locator('[role=alert]').count(), 0, 'a lost reply is not shown as a refusal');
  assert.deepEqual(await dispatches('w6-form'), { accepted: 1, delivered: 1 });
  await page.unroute('**/api/v2/action.submit'); await page.unroute('**/api/v2/project.runs');
  // Sending the same operationId again is answered with the run already accepted.
  await form.getByRole('button', { name: 'Send again', exact: true }).click();
  await form.locator('[data-rho-submitted="w6-form"]').waitFor();
  assert.deepEqual(await dispatches('w6-form'), { accepted: 1, delivered: 1 });
  passed('a lost submit reply is said as lost; sending it again finds the run, and Core receives it once');

  // 4. A disconnect and a refresh during the run find the same run; nothing is sent again.
  await context.setOffline(true);
  await page.getByRole('status').filter({ hasText: /Offline|Connecting/ }).first().waitFor();
  await context.setOffline(false);
  await page.reload();
  await openLayout();
  await form.locator('[data-rho-submitted="w6-form"]').waitFor();
  await form.getByRole('button', { name: 'Open run', exact: true }).click();
  await page.locator('section.shell-run[aria-label="w6-form"]').waitFor();
  await until(() => agent('action.lookup', { operationId: 'w6-form' }), r => r.execution === 'completed', 'the slow run completes');
  assert.deepEqual(await dispatches('w6-form'), { accepted: 1, delivered: 1 });
  passed('a disconnect and a refresh during the run find the original run, dispatched once');

  // 5. A normal restart keeps the project, its artifacts, the person's unsaved draft, the
  // layout and the prepared context; the open tab reconnects to all of it.
  await page.getByRole('tab', { name: 'analysis.R', exact: true }).click();
  const editor = owner('code').locator('.cm-content');
  await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.type('# draft kept\n');
  await until(() => call('document.read', { documentId: code.id }), d => d.content.endsWith('# draft kept\n'), 'the draft reached the shared buffer');
  const registered = (await call('resource.list', { operationId: 'w6-export' })).resources.find(r => r.path.endsWith('table.csv'));
  const before = { tabs: await page.getByRole('tab').allTextContents(), layout: (await call('composition.read', { compositionId: 'workspace' })).version };
  await restart('SIGTERM');
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 30000 });
  assert.ok((await admin.call('project.list', {})).some(p => p.id === project.id));
  assert.equal((await call('resource.read', { resource: { id: registered.id, version: registered.version }, offset: 0 })).resource.version, registered.version);
  const restored = await call('document.read', { documentId: code.id });
  assert.equal(restored.dirty, true); assert.ok(restored.content.endsWith('# draft kept\n'));
  await editor.getByText('# draft kept').waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(), before.tabs);
  assert.equal((await call('composition.read', { compositionId: 'workspace' })).version, before.layout);
  assert.equal((await agent('context.read', { contextId })).run.operationId, 'w6-broken');
  passed('a normal restart keeps the project, artifacts, unsaved draft, layout and prepared context');

  // 6. A sudden exit: an edit in flight never reached storage. After the restart only what was
  // stored is there; the tab marks its change unconfirmed until the service confirms it, once.
  const held = [];
  await page.route('**/api/v2/document.edit', route => { held.push(route); });
  await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.type('# unsent\n');
  await until(async () => held.length, n => n > 0, 'the edit is in flight');
  await stop('SIGKILL');
  await page.unroute('**/api/v2/document.edit');
  await page.route('**/api/v2/document.edit', route => route.abort('connectionrefused'));
  for (const route of held) await route.abort('connectionreset').catch(() => undefined);
  await owner('code').locator('[data-rho-unconfirmed]').waitFor();
  await restart();
  const stored = await call('document.read', { documentId: code.id });
  assert.ok(stored.content.endsWith('# draft kept\n'), 'only what was stored comes back');
  assert.equal(stored.content.includes('# unsent'), false);
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 30000 });
  assert.equal(await owner('code').locator('[data-rho-unconfirmed]').count(), 1, 'the change stays marked unconfirmed');
  await inspectResponsive(page, { name: 'unconfirmed', first: () => editor, transientAllowed: true, evidence, report });
  await page.unroute('**/api/v2/document.edit');
  await owner('code').locator('[data-rho-unconfirmed]').waitFor({ state: 'detached', timeout: 15000 });
  const confirmed = await call('document.read', { documentId: code.id });
  assert.equal(confirmed.content.split('# unsent').length - 1, 1, 'the change is applied once');
  passed('after a sudden exit only stored text returns; the unsent change is marked unconfirmed, then applied once');

  // 7. The legacy shell is gone from everything that ships or tests it.
  const left = (() => { try { return execFileSync('git', ['grep', '-n', 'dockview', '--', ':!docs', ':!scripts/continuity-acceptance.mjs'], { cwd: packageRoot, encoding: 'utf8' }); } catch (error) { if (error.status === 1) return ''; throw error; } })();
  assert.equal(left, '');
  passed('git grep dockview outside docs is empty');

  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack ?? error);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await stop();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ passed: report.passed, report: path.join(evidence, 'report.json') }) + '\n');
}
