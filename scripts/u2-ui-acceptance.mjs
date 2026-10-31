import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { selectionScope } from '../dist/shell-layout.js';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
let driver;
try { driver = process.env.RHO_UI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.RHO_UI_PLAYWRIGHT_MODULE).href : import.meta.resolve('@playwright/test'); }
catch { throw new Error('Browser acceptance needs the external test driver. Set RHO_UI_PLAYWRIGHT_MODULE to an installed @playwright/test entry; the product does not install a browser driver.'); }
const { chromium } = await import(driver);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')));
const { runtime } = await import(pathToFileURL(path.join(packageRoot, 'dist/runtime.js')));
const native = await runtime();
const directory = path.resolve(process.env.RHO_UI_EVIDENCE ?? 'work/u2-ui-closeout/browser-' + Date.now());
await fs.mkdir(directory, { recursive: true });
const root = await fs.mkdtemp('/tmp/rhou-');
const state = path.join(root, '.service');
const limitsFile = path.join(root, 'limits.json');
await fs.writeFile(limitsFile, JSON.stringify({ documents: { maxHistoryEntries: 8 } }));
const countsFile = path.join(root, 'native-counts.jsonl');
const instrument = path.join(root, 'instrument.mjs');
await fs.writeFile(instrument, `import { appendFileSync } from 'node:fs';
import { CoreBridge } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist/bridge.js')).href)};
const file = ${JSON.stringify(countsFile)};
const start = CoreBridge.prototype.ensureOwnedHost, call = CoreBridge.prototype.call;
CoreBridge.prototype.ensureOwnedHost = function(...args) { appendFileSync(file, '{"event":"host-start"}\\n'); return start.apply(this, args); };
CoreBridge.prototype.call = function(...args) { if (args[1] === 'submit') appendFileSync(file, '{"event":"dispatch"}\\n'); return call.apply(this, args); };
`);
let child, browser, context, page, url, originalClipboard, port = 0;
const errors = [];
const requests = [];
const run = promisify(execFile);
const report = { scenario: 'u2-documents-tables', passed: false, node: process.version, npmInstall: process.env.RHO_UI_INSTALLED === '1' ? 'outside-checkouts' : 'source-build', browser: '', counts: { hostStarts: 0, nativeDispatches: 0 }, widths: [], checks: [], limits: ['IME uses real Chrome CDP composition, not a physical macOS candidate-window trial', 'Actual model collaboration is separate evidence'], assets: JSON.parse(await fs.readFile(path.join(packageRoot, 'dist/web/composition.json'), 'utf8')) };
async function start() {
  child = spawn(process.execPath, ['--import', instrument, path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--port', String(port), '--limits', limitsFile, '--core', native.coreBinary, '--rscript', native.rscript, ...(process.env.RHO_UI_PLUGINS ? ['--plugins', process.env.RHO_UI_PLUGINS] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RHO_CORE_BINARY: native.coreBinary } });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Launcher readiness timed out.')), 15000);
    child.stdout.on('data', data => {
      output += data.toString(); let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try { const value = JSON.parse(line); if (value.ready) { clearTimeout(timer); resolve(value.ready); } } catch {}
      }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Launcher exited before readiness.')); });
  });
  url = ready.url; port = Number(new URL(url).port);
  return ready;
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
}
async function operator() { return RhoClient.fromFile(path.join(state, 'connection.json')); }
const recordCheck = report.checks.push.bind(report.checks);
report.checks.push = (...items) => { process.stdout.write(items.join('\n') + '\n'); return recordCheck(...items); };
const poll = async (read, predicate, label) => {
  for (let i = 0; i < 100; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out: ' + label);
};
const text = () => page.locator('.cm-content:visible').evaluate(e => [...e.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
// The workspace's views are ARIA tabs at every width.
const tab = name => page.getByRole('tab').filter({ hasText: name }).first().click();
try {
  const ready = await start();
  const admin = await operator();
  const p = await admin.call('project.create', { name: 'U2 中文' });
  const call = (m, b = {}) => admin.call(m, { projectId: p.id, ...b });
  await fs.writeFile(path.join(p.root, 'notes.R'), 'base <- 1\n');
  const d = await call('document.open', { path: 'notes.R' });
  const csv = 'id,score,flag,optional\n' + Array.from({ length: 1400 }, (_, i) => `id-${String(i).padStart(4, '0')},${i},${i % 2 === 0},${i % 3 ? 'value' : ''}`).join('\n') + '\n';
  await fs.writeFile(path.join(p.root, 'results.csv'), csv);
  const table = await call('resource.register', { expectedDigest: createHash('sha256').update(csv).digest('hex'), declaration: { path: 'results.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }, { name: 'flag', type: 'boolean', nullValues: [] }, { name: 'optional', type: 'string', nullValues: [''] }], key: { column: 'id', namespace: 'samples' } } } });
  await fs.writeFile(path.join(p.root, 'plain.csv'), csv);
  const unkeyed = await call('resource.register', { expectedDigest: createHash('sha256').update(csv).digest('hex'), declaration: { path: 'plain.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }, { name: 'flag', type: 'boolean', nullValues: [] }, { name: 'optional', type: 'string', nullValues: [''] }], key: null } } });
  const view = (id, document) => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: id }, bindings: { document } });
  const live = { kind: 'live-document', documentId: d.id };
  await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'layout', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['Editor-A', 'Editor-B', 'Pinned', 'Table', 'Unkeyed'] }, view('Editor-A', live), view('Editor-B', live), view('Pinned', { documentId: d.id, version: 1 }), { id: 'Table', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'Table' }, bindings: { data: { id: table.id, version: table.version } } }, { id: 'Unkeyed', kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: 'Unkeyed' }, bindings: { data: { id: unkeyed.id, version: unkeyed.version } } }] }] });
  const grant = await call('session.grant', { externalSessionId: 'ui-agent', methods: ['document.read', 'document.edit', 'document.save'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);
  let loseEdit = false;
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const consoleIssues = [];
  page.on('console', m => { if (m.text().startsWith('AG Grid:') && consoleIssues.length < 20) consoleIssues.push(m.text().slice(0, 500)); });
  page.on('request', r => { if (r.url().includes('/api/v2/data.page')) requests.push(JSON.parse(r.postData())); });
  await page.route('**/api/v2/document.edit', async route => {
    if (!loseEdit) return route.continue();
    loseEdit = false;
    await route.fetch(); await route.abort('failed');
  });
  await page.goto(ready.openUrl);
  await page.locator('.project-row').filter({ hasText: 'U2 中文' }).click();
  await page.locator('.nav-row:not(.nav-new)').filter({ hasText: 'workspace' }).click();
  await page.locator('.cm-content:visible').waitFor();
  // The editor mounts before the buffer's first read arrives.
  await poll(text, t => t === 'base <- 1\n', 'the script buffer shown');
  const current = () => call('document.read', { documentId: d.id });
  const input = page.locator('.cm-content:visible');
  await input.click(); await page.keyboard.press('Meta+End');
  loseEdit = true; await page.keyboard.insertText('\n人类 🧬');
  await poll(current, b => b.content.endsWith('人类 🧬'), 'human edit');
  await page.waitForTimeout(400);
  let state = await current(); assert.equal(state.history.filter(h => h.author.startsWith('browser:')).length, 1);
  await tab('Editor-B'); await poll(text, t => t.includes('人类 🧬'), 'shared second editor');
  state = await current();
  await agent.call('document.edit', { documentId: d.id, expectedVersion: state.version, expectedRevision: state.revision, changeId: 'agent-edit', undoGroup: 'agent', edits: [{ from: 0, to: 0, insert: '# Claude 中文 🧬\n' }] });
  await poll(text, t => t.startsWith('# Claude'), 'agent observed');
  await input.click(); await page.keyboard.press('Meta+z');
  state = await poll(current, b => !b.content.includes('人类'), 'own undo'); assert.match(state.content, /^# Claude/);
  await page.getByRole('button', { name: 'Connection & access', exact: true }).click();
  await page.getByRole('region', { name: 'Changes', exact: true }).waitFor();
  assert.equal(await page.getByText('You', { exact: true }).count() > 0, true);
  const agentChange = page.locator('.rho-doc-changes li.agent').first();
  await agentChange.getByRole('button', { name: 'Show before', exact: true }).click();
  await agentChange.locator('pre').waitFor();
  const highlights = page.getByRole('checkbox', { name: 'Highlight changes', exact: true });
  assert.ok(await highlights.evaluate(e => e.getBoundingClientRect().height <= 16));
  await highlights.uncheck(); assert.equal(await page.locator('.rho-doc-agent-line:visible').count(), 0);
  await highlights.check(); assert.ok(await page.locator('.rho-doc-agent-line:visible').count() > 0);
  await agentChange.getByRole('button', { name: 'Revert', exact: true }).click();
  await poll(current, b => !b.content.includes('Claude'), 'agent change reverted');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close context', exact: true }).click();
  report.checks.push('dual-editor-unicode-lost-edit-response-stable-identity-own-undo-show-before-single-agent-revert');

  // Chrome's actual composition engine: intermediate text causes no document edit.
  await input.click(); await page.keyboard.press('Meta+End');
  const cdp = await context.newCDPSession(page), prior = await current();
  await cdp.send('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 });
  await page.waitForTimeout(200); assert.equal((await current()).revision, prior.revision);
  await cdp.send('Input.insertText', { text: '中文输入' });
  await poll(current, b => b.content.endsWith('中文输入'), 'IME commit');
  originalClipboard = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate(() => navigator.clipboard.writeText('粘贴 🧪'));
  await input.click(); await page.keyboard.press('Meta+End'); await page.keyboard.press('Meta+v');
  await poll(current, b => b.content.endsWith('粘贴 🧪'), 'clipboard paste');
  const beforeLimit = await current();
  await page.evaluate(() => navigator.clipboard.writeText('x'.repeat(1024 * 1024)));
  await page.keyboard.press('Meta+v');
  await page.getByRole('status').filter({ hasText: 'input byte limit' }).waitFor();
  assert.equal((await current()).revision, beforeLimit.revision);
  assert.equal(await text(), beforeLimit.content);
  report.checks.push('chrome-ime-composition-no-intermediate-send-and-real-clipboard-unicode-paste');

  // A concurrent confirmed edit must retain the unsent composition in a recovery copy.
  await input.click(); await page.keyboard.press('Meta+End');
  await cdp.send('Input.imeSetComposition', { text: '未确认', selectionStart: 3, selectionEnd: 3 });
  state = await current();
  await agent.call('document.edit', { documentId: d.id, expectedVersion: state.version, expectedRevision: state.revision, changeId: 'conflict-agent', undoGroup: 'conflict', edits: [{ from: 0, to: 0, insert: '# concurrent\n' }] });
  await cdp.send('Input.insertText', { text: '未确认' });
  await page.getByRole('button', { name: 'Copy them', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Copy them', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /未确认$/);
  assert.doesNotMatch((await current()).content, /未确认/);
  await page.screenshot({ path: path.join(directory, 'recovery-copy-1600.png'), fullPage: true });
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await tab('Pinned'); await poll(text, t => t === 'base <- 1\n', 'exact pinned version');
  assert.equal(await page.locator('.cm-content:visible').getAttribute('contenteditable'), 'false');
  await page.getByRole('button', { name: 'Connection & access', exact: true }).click();
  assert.equal(await page.getByRole('region', { name: 'Changes', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close context', exact: true }).click();
  report.checks.push('conflict-stops-auto-submit-copy-retained-no-rebase-pinned-content-readonly-no-live-changes');

  // The Overview's cards may already have read a table's first rows (previewLimits.rows) while the
  // project opened, depending on how fast its folders were read; the grid's own reads start here.
  const gridReads = requests.length;
  await tab('Table'); await page.locator('.ag-row[row-index="0"] [col-id="id"]').waitFor();
  assert.match(await page.getByRole('toolbar', { name: 'Table', exact: true }).innerText(), /1,400 rows/);
  const keyCell = page.locator('.ag-row[row-index="0"] [col-id="id"]');
  assert.equal(await keyCell.innerText(), 'id-0000');
  await page.locator('.ag-row[row-index="0"] input[type="checkbox"]').check();
  // The table's channel is the one every view of this version shares (shell-layout.ts).
  const scope = selectionScope({ id: 'Table', bindings: { data: { id: table.id, version: table.version } } });
  const readSelection = () => call('interaction.selection.read', { scope });
  await poll(readSelection, s => s.selection?.entities.includes('id-0000'), 'shared keyed selection');
  await page.locator('.ag-header-cell[col-id="score"]').click();
  await page.locator('.ag-header-cell[col-id="score"]').click();
  await poll(() => keyCell.innerText(), t => t === 'id-1399', 'descending numeric sort');
  assert.deepEqual((await readSelection()).selection.entities, ['id-0000']);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('combobox', { name: 'Column', exact: true }).selectOption('score');
  await page.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('gt');
  await page.getByRole('textbox', { name: 'Value', exact: true }).fill('1300');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await poll(() => page.getByRole('toolbar', { name: 'Table', exact: true }).innerText(), t => t.includes('99 of 1,400 rows'), 'typed filter');
  assert.deepEqual((await readSelection()).selection.entities, ['id-0000']);
  await page.getByRole('button', { name: 'Remove filter', exact: true }).click();
  await poll(() => page.getByRole('toolbar', { name: 'Table', exact: true }).innerText(), t => t.includes('1,400 rows') && !t.includes(' of '), 'remove filter');
  await page.waitForFunction(() => [...document.querySelectorAll('[class*="ag-"]')].some(e => e.scrollHeight > 40000));
  const rowHeight = await page.locator('.ag-row').first().evaluate(row => row.getBoundingClientRect().height);
  assert.ok(rowHeight > 0);
  for (const offset of [200, 400, 600, 800, 1000, 1200]) {
    await page.locator('.ag-grid-viewport').evaluate((root, top) => { const e = [root, ...root.querySelectorAll('*')].find(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > 40000); if (e) e.scrollTop = top; }, (offset + 20) * rowHeight);
    await poll(() => Promise.resolve(requests), rs => rs.some(r => r.offset === offset), 'block ' + offset);
  }
  assert.ok(requests.slice(gridReads).every(r => r.limit === 200));
  assert.ok(requests.slice(gridReads).filter(r => r.sort).every(r => r.sort.column === 'score'));
  await tab('Unkeyed'); await page.getByText("Rows have no key, so they can't be selected for Claude Code.", { exact: true }).waitFor();
  assert.equal(await page.locator('.ag-row input[type="checkbox"]').count(), 0);
  report.checks.push('table-200-row-blocks-sort-typed-filter-stable-key-selection-through-cache-and-unkeyed-readable');

  for (const width of [1600, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await tab('Editor-A'); await page.locator('.cm-content:visible').waitFor();
    await page.screenshot({ path: path.join(directory, 'editor-' + width + '.png'), fullPage: true });
    await tab('Table'); await page.locator('.ag-root').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // The grid stays mounted with its sort below 768; the toolbar names the kept selection.
    if (width === 390) await poll(() => page.getByRole('toolbar', { name: 'Table', exact: true }).innerText().then(t => t.includes('1 selected')), Boolean, 'selected key retained at narrow width');
    await page.screenshot({ path: path.join(directory, 'table-' + width + '.png'), fullPage: true });
    report.widths.push(width);
  }
  await page.setViewportSize({ width: 1600, height: 1000 }); await tab('Editor-A');
  // Force historical eviction while the exact binding keeps its identity.
  for (let n = 0; n < 9; n++) {
    state = await current();
    await agent.call('document.edit', { documentId: d.id, expectedVersion: state.version, expectedRevision: state.revision, changeId: 'expiry-' + n, undoGroup: 'expiry-' + n, edits: [{ from: state.content.length, to: state.content.length, insert: '.' }] });
  }
  await page.reload(); await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
  if (await page.locator('.project-row').count()) await page.locator('.project-row').first().click();
  await page.locator('.nav-row:not(.nav-new)').filter({ hasText: 'workspace' }).click();
  await tab('Pinned'); await page.getByRole('alert').filter({ hasText: 'Version 1 is no longer available' }).waitFor();
  assert.equal(await page.locator('.cm-content:visible').count(), 0);
  await page.screenshot({ path: path.join(directory, 'exact-unavailable-1600.png'), fullPage: true });
  await tab('Editor-A');
  // Eight mounted heavy entries is a rendering budget, never a buffer eviction: the view on
  // screen renders even after eight others were shown, and at most eight stay mounted.
  const extra = Array.from({ length: 9 }, (_, n) => view('Budget-' + n, live));
  await call('composition.apply', { compositionId: 'budget', expectedVersion: 0, changeId: 'budget', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: extra.map(v => v.id) }, ...extra] }] });
  await page.locator('.nav-row').filter({ hasText: 'budget' }).click();
  for (let n = 0; n < 9; n++) await tab('Budget-' + n);
  await page.locator('.cm-content:visible').first().waitFor();
  assert.equal(await page.getByRole('heading', { name: 'This layout has reached its view limit', exact: true }).count(), 0);
  assert.ok(await page.locator('.cm-editor').count() <= 8);
  await page.screenshot({ path: path.join(directory, 'view-budget-1600.png'), fullPage: true });
  await page.locator('.nav-row:not(.nav-new)').filter({ hasText: 'workspace' }).click(); await tab('Editor-A');
  report.checks.push('expired-pinned-version-unavailable-never-live-and-eight-heavy-view-budget-preserves-buffers');
  state = await current(); const confirmed = state.content;
  const saved = await agent.call('document.save', { documentId: d.id, expectedVersion: state.version, expectedRevision: state.revision, changeId: 'agent-save', expectedDiskDigest: state.diskDigest });
  assert.equal(await fs.readFile(path.join(p.root, 'notes.R'), 'utf8'), confirmed);
  state = saved;
  await fs.writeFile(path.join(p.root, 'notes.R'), 'outside disk');
  await assert.rejects(agent.call('document.save', { documentId: d.id, expectedVersion: state.version, expectedRevision: state.revision, changeId: 'save-conflict', expectedDiskDigest: saved.diskDigest }), e => e.error.kind === 'conflict');
  assert.equal((await current()).content, confirmed);
  await page.reload();
  // Project/layout choice is local presentation; reopen if refresh returns Home.
  if (await page.locator('.project-row').count()) await page.locator('.project-row').first().click();
  await page.locator('.nav-row:not(.nav-new)').filter({ hasText: 'workspace' }).click();
  await tab('Editor-A'); await poll(text, t => t === confirmed, 'refresh acknowledged buffer');
  await context.setOffline(true); await page.waitForTimeout(300); await context.setOffline(false);
  await poll(text, t => t === confirmed, 'reconnected content');
  await stop(); await start();
  await page.reload(); if (await page.locator('.project-row').count()) await page.locator('.project-row').first().click();
  await page.locator('.nav-row:not(.nav-new)').filter({ hasText: 'workspace' }).click();
  await tab('Editor-A'); await poll(text, t => t === confirmed, 'service restart same session');
  report.checks.push('disk-conflict-preserves-buffer-refresh-disconnect-reconnect-service-restart-same-session');
  assert.deepEqual(errors, []); assert.deepEqual(consoleIssues, []);
  const events = await fs.readFile(countsFile, 'utf8').catch(() => '');
  report.counts.hostStarts = events.split('\n').filter(l => l.includes('host-start')).length;
  report.counts.nativeDispatches = events.split('\n').filter(l => l.includes('dispatch')).length;
  assert.deepEqual(report.counts, { hostStarts: 0, nativeDispatches: 0 });
  report.passed = true;
} catch (error) {
  report.tableRequests = requests?.map(r => ({ offset: r.offset, limit: r.limit }));
  report.failure = { name: error.name, message: error.message.slice(0, 1500), pageErrors: errors };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (originalClipboard !== undefined && page && !page.isClosed()) await page.evaluate(value => navigator.clipboard.writeText(value), originalClipboard).catch(() => {});
  await context?.close(); await browser?.close(); await stop();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, browser: report.browser, counts: report.counts, report: path.join(directory, 'report.json') }));
