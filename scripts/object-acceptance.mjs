// Browser behavior: object-level collaboration in the default shell.
// A table and a chart of one version select the same entities, through sort and filter; a
// code selection reaches the Agent as an exact buffer range with its version and whether it
// is saved, and a selection the buffer moved past is refused with a request to select again;
// split, move, close, divider, undo and a layout switch keep drafts, undo and selection;
// the Agent's compositions are applied or refused mechanically, a missing component keeps its
// reference and offers a recovery, and closing a view never cancels its run.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
import { inspectResponsive, firstUnit } from './browser-checks.mjs';
import { selectionScope } from '../dist/shell-layout.js';
const evidence = path.resolve(process.env.RHO_OBJECT_EVIDENCE ?? 'work/objects-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-objects-'), state = path.join(root, '.service');
const report = { scenario: 'object-collaboration', passed: false, checks: [], responsive: [] };
const passed = (name, detail = {}) => { report.checks.push({ name, ...detail }); process.stdout.write(`ok · ${name}\n`); };
const digestOf = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (predicate(value)) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + label + ' · last ' + JSON.stringify(value)?.slice(0, 400)); await sleep(150); }
}
let child, browser, page;
try {
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--core', native.coreBinary, '--rscript', native.rscript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('Launcher readiness timed out')), 20000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
  });
  const admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const project = await admin.call('project.create', { name: 'Objects' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  const grant = await call('session.grant', { externalSessionId: 'w5-agent', methods: ['composition.apply', 'composition.read', 'context.read', 'document.read', 'document.edit', 'action.submit', 'action.lookup'] });
  const agentClient = await RhoClient.fromFile(grant.connectionFile);
  const agent = (m, b = {}) => agentClient.call(m, { projectId: project.id, ...b });

  // A keyed table with two numeric columns, and a script in the shared buffer.
  const csv = 'id,x,y,score\n' + Array.from({ length: 12 }, (_, i) => `r${String(i).padStart(2, '0')},${i},${i * i},${11 - i}`).join('\n') + '\n';
  await fs.writeFile(path.join(project.root, 'results.csv'), csv);
  const table = await call('resource.register', { expectedDigest: digestOf(csv), declaration: { path: 'results.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'x', type: 'number', nullValues: [] }, { name: 'y', type: 'number', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'rows' } } } });
  const ref = { id: table.id, version: table.version };
  await fs.writeFile(path.join(project.root, 'notes.R'), 'library(stats)\nfit <- lm(y ~ x)\nsummary(fit)\n');
  const notes = await call('document.open', { path: 'notes.R' });
  const view = (id, component, props, bindings) => ({ id, kind: 'view', component, version: '0.2.0', props, bindings });
  let layout = await agent('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'w5-layout', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['editor', 'table', 'scatter'] },
    view('editor', 'rho.editor', { title: 'notes.R' }, { document: { kind: 'live-document', documentId: notes.id } }),
    view('table', 'rho.table', { title: 'Results' }, { data: ref }),
    view('scatter', 'rho.scatter', { title: 'y by x', x: 'x', y: 'y' }, { data: ref })] }] });
  const scope = selectionScope({ id: 'table', bindings: { data: ref } });
  const channel = async () => ((await call('interaction.selection.read', { scope })).selection?.entities ?? []).slice().sort();

  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ready.openUrl).origin });
  page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ready.openUrl);
  await page.locator('.project-row').filter({ hasText: 'Objects' }).click();
  await page.locator('.nav-row').filter({ hasText: 'workspace' }).first().click();
  const tab = name => page.getByRole('tab', { name, exact: true });
  const owner = id => page.locator(`[data-owner-view="${id}"]`);
  const row = (id, key) => owner(id).locator('.ag-center-cols-container .ag-row').filter({ has: page.locator(`[col-id="id"]`, { hasText: new RegExp('^' + key + '$') }) });
  const checked = async (id, key) => (await owner(id).locator(`.ag-row[row-id="rows:${key}"]`).first().getAttribute('class'))?.includes('ag-row-selected');
  const point = (id, key) => owner(id).locator(`[data-entity="${key}"]`);
  const command = async label => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const input = page.getByRole('combobox', { name: 'Command', exact: true });
    await input.fill(label);
    await page.getByRole('option', { name: new RegExp('^' + label) }).first().waitFor();
    await input.press('Enter');
  };
  const composition = () => call('composition.read', { compositionId: 'workspace' });

  // 1. Linked selection: one channel for every view of this table version.
  await tab('Results').click();
  await owner('table').locator('.ag-row[row-id="rows:r03"]').first().waitFor();
  await owner('table').locator('.ag-row[row-id="rows:r03"] input[type="checkbox"]').first().check();
  await until(channel, e => e.join() === 'r03', 'table selection in the shared channel');
  await tab('y by x').click();
  await point('scatter', 'r03').and(page.locator('[data-selected]')).waitFor();
  await point('scatter', 'r07').click();
  await until(channel, e => e.join() === 'r03,r07', 'chart selection in the same channel');
  await tab('Results').click();
  await until(() => checked('table', 'r07'), on => on === true, 'the chart selection shows in the table');
  // Sorting and filtering change which rows show, never which entities are selected.
  await owner('table').locator('.ag-header-cell[col-id="score"]').click();
  await owner('table').locator('.ag-header-cell[col-id="score"]').click();
  await until(() => owner('table').locator('.ag-row[row-index="0"] [col-id="id"]').innerText(), t => t === 'r00', 'descending score');
  assert.equal(await checked('table', 'r03'), true); assert.equal(await checked('table', 'r07'), true);
  assert.deepEqual(await channel(), ['r03', 'r07']);
  await owner('table').getByRole('button', { name: 'Filter', exact: true }).click();
  await owner('table').getByRole('combobox', { name: 'Column', exact: true }).selectOption('score');
  await owner('table').getByRole('combobox', { name: 'Condition', exact: true }).selectOption('gt');
  await owner('table').getByRole('textbox', { name: 'Value', exact: true }).fill('5');
  await owner('table').getByRole('button', { name: 'Apply', exact: true }).click();
  await until(() => owner('table').getByRole('toolbar', { name: 'Table', exact: true }).innerText(), t => t.includes('6 of 12 rows'), 'filtered rows');
  assert.equal(await checked('table', 'r03'), true);
  assert.deepEqual(await channel(), ['r03', 'r07']);
  await owner('table').getByRole('button', { name: 'Remove filter', exact: true }).click();
  passed('table and chart share one selection; sort and filter keep the same entities', { entities: await channel() });

  // 2. Layout commands without dragging, with a draft and an undo in the editor.
  await tab('notes.R').click();
  const editor = owner('editor').locator('.cm-content');
  await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.type('plot(fit)\n');
  await until(() => call('document.read', { documentId: notes.id }), d => d.content.endsWith('plot(fit)\n'), 'the draft reached the shared buffer');
  await tab('y by x').click();
  await command('Split right');
  await until(composition, c => c.nodes.some(n => n.presentation?.mode === 'split'), 'the split was written to the layout');
  await point('scatter', 'r07').and(page.locator('[data-selected]')).waitFor();
  // The chart draws at its new pane's size once the pane has one.
  await until(() => owner('scatter').locator('svg[role=img]').evaluate(svg => Math.abs(Number(svg.getAttribute('width')) - svg.parentElement.getBoundingClientRect().width) <= 1), same => same, 'the chart fills its pane');
  await page.screenshot({ path: path.join(evidence, 'split.png') });
  // Both sides show at once: the editor's text and the chart's points.
  await owner('editor').locator('.cm-content').waitFor();
  // A divider moved by keyboard is written back.
  const before = (await composition()).nodes.find(n => n.presentation?.mode === 'split').presentation.weights;
  await page.getByRole('separator').first().focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await until(async () => (await composition()).nodes.find(n => n.presentation?.mode === 'split')?.presentation.weights, w => w && w.join() !== before.join(), 'the divider was written back');
  await tab('Results').click();
  await command('Move to the next group');
  await until(composition, c => { const g = c.nodes.find(n => n.children?.includes('scatter')); return g?.children.includes('table'); }, 'the table moved beside the chart');
  await tab('y by x').click();
  await command('Close view');
  await until(composition, c => !c.nodes.some(n => n.id === 'scatter'), 'the chart closed');
  await command('Undo layout change');
  await until(composition, c => c.nodes.some(n => n.id === 'scatter'), 'the chart restored');
  // Another layout and back.
  await agent('composition.apply', { compositionId: 'review', expectedVersion: 0, changeId: 'w5-review', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['only'] }, view('only', 'rho.table', { title: 'Review' }, { data: ref })] }] });
  await page.locator('.nav-row').filter({ hasText: 'review' }).first().click();
  await owner('only').locator('.ag-row[row-id="rows:r03"]').first().waitFor();
  assert.equal(await checked('only', 'r03'), true, 'the selection of this version shows in another layout too');
  await page.locator('.nav-row').filter({ hasText: 'workspace' }).first().click();
  await tab('notes.R').click();
  assert.match(await editor.innerText(), /plot\(fit\)\s*$/);
  await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await until(() => call('document.read', { documentId: notes.id }), d => !d.content.includes('plot(fit)'), 'own undo after the layout changes');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.type('plot(fit)\n');
  await until(() => call('document.read', { documentId: notes.id }), d => d.content.endsWith('plot(fit)\n'), 'the draft again');
  assert.deepEqual(await channel(), ['r03', 'r07']);
  passed('split, divider, move, close, undo and a layout switch kept the draft, undo and selection', { version: (await composition()).version });

  // 3. A code selection goes to the Agent as an exact, unsaved buffer range.
  const line = owner('editor').locator('.cm-line').filter({ hasText: 'fit <- lm(y ~ x)' });
  // The line's own start and end: on macOS Home and End move through the whole document.
  const mac = process.platform === 'darwin';
  const selectLine = async () => { await page.keyboard.press(mac ? 'Meta+ArrowLeft' : 'Home'); await page.keyboard.press(mac ? 'Meta+Shift+ArrowRight' : 'Shift+End'); };
  await line.click(); await selectLine();
  const header = page.locator('[data-owner-header="editor"]');
  await header.getByRole('button', { name: 'Ask the Agent about this', exact: true }).click();
  await header.getByRole('button', { name: 'Copy request for the Agent', exact: true }).click();
  const request = await page.evaluate(() => navigator.clipboard.readText());
  const contextId = request.match(/context ([a-f0-9]{64})/)?.[1];
  assert.ok(contextId, request);
  assert.match(request, /line 2 of notes\.R at buffer version \d+, unsaved text/);
  const handed = (await agent('context.read', { contextId })).document;
  assert.equal(handed.text, 'fit <- lm(y ~ x)');
  assert.equal(handed.source.kind, 'buffer'); assert.equal(handed.source.dirty, true); assert.equal(handed.source.path, 'notes.R');
  assert.equal(handed.source.version, (await call('document.read', { documentId: notes.id })).version);
  // A selection the buffer has moved past is refused, and the person is asked to select again.
  await page.route('**/api/v2/context.create', async route => {
    const body = route.request().postDataJSON(); body.document.version -= 1;
    await route.continue({ postData: JSON.stringify(body) });
  });
  await line.click(); await selectLine();
  await header.getByRole('button', { name: 'Ask the Agent about this', exact: true }).click();
  await header.getByText('The text changed after you selected it. Select it again.', { exact: true }).waitFor();
  await page.unroute('**/api/v2/context.create');
  passed('a code selection reaches the Agent with its buffer version and unsaved state; a stale one is refused', { version: handed.source.version });

  // 4. The Agent composes from the registered catalog: what is legal applies, the rest is refused.
  layout = await composition();
  const group = layout.nodes.find(n => n.children?.includes('table')).id;
  const insert = (expectedVersion, node, index = 0) => agent('composition.apply', { compositionId: 'workspace', expectedVersion, changeId: 'w5-' + node.id + '-' + expectedVersion, operations: [{ op: 'insert', parentId: group, index, node }] });
  const kind = promise => promise.then(() => 'applied', e => e.error?.kind ?? 'unknown');
  const refusals = {
    malformed: await kind(insert(layout.version, view('bad', 'rho.scatter', { title: 'No axes' }, { data: ref }))),
    stale: await kind(insert(layout.version - 1, view('late', 'rho.scatter', { title: 'Late', x: 'x', y: 'y' }, { data: ref }))),
    'out-of-bounds': await kind(insert(layout.version, { ...view('gone', 'rho.table', { title: 'Gone' }, { data: ref }), selection: ['r99'] })),
    'out-of-range': await kind(insert(layout.version, view('far', 'rho.table', { title: 'Far' }, { data: ref }), 99)),
  };
  assert.deepEqual(refusals, { malformed: 'invalid', stale: 'stale', 'out-of-bounds': 'stale', 'out-of-range': 'invalid' });
  // While the person works, an Agent's layout waits as a suggestion until they open it.
  const openUpdate = async () => { await page.locator('[data-rho-interruption]').getByRole('button', { name: 'Open update', exact: true }).click(); };
  await insert(layout.version, view('zoom', 'rho.scatter', { title: 'Zoom', x: 'x', y: 'score' }, { data: ref }));
  await openUpdate();
  await tab('Zoom').click();
  await point('zoom', 'r03').and(page.locator('[data-selected]')).waitFor();
  layout = await composition();
  await insert(layout.version, view('heat', 'rho.heatmap', { title: 'Heat map' }, { data: ref }));
  await openUpdate();
  await tab('Heat map').click();
  const missing = owner('heat');
  await missing.getByRole('heading', { name: "This view can't be shown here yet", exact: true }).waitFor();
  await missing.getByText('View reference', { exact: true }).click();
  assert.match(await missing.locator('.view-reference').innerText(), new RegExp(table.id.slice(0, 12)));
  await missing.getByRole('button', { name: 'Open this version in a table', exact: true }).click();
  await until(composition, c => c.nodes.some(n => n.kind === 'view' && n.component === 'rho.table' && n.props.title === 'Heat map · as a table') && c.nodes.some(n => n.id === 'heat'), 'the recovery opened beside the kept view');
  passed('legal composition applied with the selection; malformed, stale and out-of-bounds refused; missing component kept with a recovery', refusals);

  // 5. Closing a view never cancels its run.
  const slow = 'cat("working\\n")\nSys.sleep(3)\n';
  await fs.writeFile(path.join(project.root, 'slow.R'), slow);
  layout = await composition();
  await agent('composition.apply', { compositionId: 'workspace', expectedVersion: layout.version, changeId: 'w5-form', operations: [{ op: 'insert', parentId: group, index: 0, node: { id: 'form', kind: 'view', component: 'rho.action', version: '1', props: { title: 'Slow run', action: 'r.execute', actionVersion: '0.2.0', operationId: 'w5-slow', input: { script: { kind: 'disk', path: 'slow.R', digest: digestOf(slow) }, args: [], requirements: [], artifacts: [], completion: null } }, bindings: {} } }] });
  await openUpdate();
  await tab('Slow run').click();
  await owner('form').getByRole('button', { name: 'Run', exact: true }).and(page.locator(':enabled')).click();
  await owner('form').locator('[data-rho-submitted="w5-slow"]').waitFor();
  await command('Close view');
  await until(composition, c => !c.nodes.some(n => n.id === 'form'), 'the form closed');
  const finished = await until(() => agent('action.lookup', { operationId: 'w5-slow' }), r => r.execution !== 'active' && r.execution !== 'unobserved', 'the run ended on its own');
  assert.equal(finished.execution, 'completed'); assert.equal(finished.cancellation, undefined);
  passed('closing the view left its run to finish', { execution: finished.execution });

  await tab('Results').click();
  await inspectResponsive(page, { name: 'objects', first: () => firstUnit(owner('table'), 'table'), evidence, report });
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: String(error.message).slice(0, 3000), stack: String(error.stack ?? '').split('\n').filter(l => l.includes('.mjs')).slice(0, 4) }; process.exitCode = 1;
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  report.failure.page = await page?.locator('main').innerText().then(t => t.slice(0, 1500)).catch(() => null);
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, report: path.join(evidence, 'report.json') }) + '\n');
}
