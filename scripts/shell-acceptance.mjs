// W1 exit checks for the composition-tree shell (docs/WORKSPACE-PLAN.md): the hard case
// (an unsaved script survives an Agent's layout, a re-layout and a layout switch, and undo
// continues), composition fidelity at desktop and collapsed widths, and the rulers on a
// static layout. Assertions read owner records and the DOM, never the shell's own state.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
import { rulers, profiles, firstUnit } from './rulers.mjs';
const evidence = path.resolve(process.env.RHO_SHELL_EVIDENCE ?? 'work/shell-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-shell-'), state = path.join(root, '.service');
const report = { scenario: 'W1-shell', passed: false, checks: [], fidelity: [], rulers: [] };
const check = name => { report.checks.push(name); process.stdout.write(name + '\n'); };
async function poll(read, predicate, label, attempts = 160) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out: ' + label);
}
let child, browser;
try {
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--core', native.coreBinary, '--rscript', native.rscript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('Launcher readiness timed out')), 20000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
  });
  const admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const project = await admin.call('project.create', { name: 'Shell 中文' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  await fs.writeFile(path.join(project.root, 'analysis.R'), 'base <- 1\n');
  await fs.writeFile(path.join(project.root, 'notes.md'), 'Notes 🧬\n');
  const script = await call('document.open', { path: 'analysis.R' }), notes = await call('document.open', { path: 'notes.md' });
  const csv = 'id,score\n' + Array.from({ length: 60 }, (_, i) => `r${i},${i}`).join('\n') + '\n';
  await fs.writeFile(path.join(project.root, 'results.csv'), csv);
  const table = await call('resource.register', { expectedDigest: createHash('sha256').update(csv).digest('hex'), declaration: { path: 'results.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }], key: { column: 'id', namespace: 'rows' } } } });
  const editor = (id, documentId) => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: id }, bindings: { document: { kind: 'live-document', documentId } } });
  const grid = id => ({ id, kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: id }, bindings: { data: { id: table.id, version: table.version } } });
  let workspace = await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'start', operations: [{ op: 'replace', rootId: 'root', nodes: [
    { id: 'root', kind: 'group', children: ['Script', 'side'], presentation: { mode: 'split', axis: 'horizontal', weights: [3, 2] } },
    { id: 'side', kind: 'group', children: ['Notes', 'Table'] }, editor('Script', script.id), editor('Notes', notes.id), grid('Table'),
  ] }] });
  await call('composition.apply', { compositionId: 'other', expectedVersion: 0, changeId: 'other', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['Elsewhere'] }, editor('Elsewhere', notes.id)] }] });
  const grant = await call('session.grant', { externalSessionId: 'shell-agent', methods: ['composition.apply', 'composition.read', 'document.read', 'task.map.declare'] });
  const agent = await RhoClient.fromFile(grant.connectionFile);

  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ready.openUrl);
  await page.locator('.project-row').filter({ hasText: 'Shell 中文' }).click();
  const layoutNav = name => page.locator('.nav-row').filter({ hasText: name }).first();
  await layoutNav('workspace').click();
  const scriptView = page.locator('[data-owner-view="Script"]');
  await scriptView.locator('.cm-content').waitFor();
  const read = () => call('document.read', { documentId: script.id });

  // The hard case.
  await scriptView.locator('.cm-content').click(); await page.keyboard.press('Meta+End');
  await page.keyboard.insertText('first <- "人类 🧬"\n');
  await poll(read, d => d.content.includes('first <-'), 'first person edit');
  await page.waitForTimeout(1500); // Documents starts a new undo group after a 1 s pause.
  await page.keyboard.insertText('second <- 2\n');
  const drafted = await poll(read, d => d.content.includes('second <-'), 'second person edit');
  assert.equal(drafted.dirty, true, 'the script is unsaved');
  await scriptView.locator('.cm-editor').evaluate(e => { e.__rhoProbe = 'kept'; });
  const kept = () => scriptView.locator('.cm-editor').evaluate(e => e.__rhoProbe === 'kept').catch(() => false);
  const focusInScript = () => page.evaluate(() => !!document.activeElement?.closest('[data-owner-view="Script"] .cm-content'));
  // The Agent composes a further view while the person is typing.
  workspace = await agent.call('composition.apply', { projectId: project.id, compositionId: 'workspace', expectedVersion: workspace.version, changeId: 'agent-view', operations: [{ op: 'insert', parentId: 'side', index: 2, node: editor('Agent-view', notes.id) }] });
  await page.waitForTimeout(1200);
  assert.equal(await kept(), true, "an Agent's layout does not remount the person's editor");
  assert.equal(await focusInScript(), true, "an Agent's layout does not take the person's focus");
  // A person's or operator's re-layout restructures the tree around the same editor element.
  workspace = await call('composition.apply', { compositionId: 'workspace', expectedVersion: workspace.version, changeId: 'relayout', operations: [{ op: 'replace', rootId: 'top', nodes: [
    { id: 'top', kind: 'group', children: ['root', 'bottom'], presentation: { mode: 'split', axis: 'vertical', weights: [2, 1] } },
    { id: 'root', kind: 'group', children: ['Script', 'side'], presentation: { mode: 'split', axis: 'horizontal', weights: [1, 1] } },
    { id: 'side', kind: 'group', children: ['Notes', 'Agent-view'] }, { id: 'bottom', kind: 'group', children: ['Table'] },
    editor('Script', script.id), editor('Notes', notes.id), editor('Agent-view', notes.id), grid('Table'),
  ] }] });
  await page.locator('[data-split="top"]').waitFor();
  assert.equal(await kept(), true, 'a re-layout moves the editor element instead of remounting it');
  assert.equal((await read()).content, drafted.content);
  // Switching layout and coming back reads the same unsaved buffer.
  await layoutNav('other').click(); await page.locator('[data-owner-view="Elsewhere"] .cm-content').waitFor();
  await layoutNav('workspace').click(); await scriptView.locator('.cm-content').waitFor();
  await poll(() => scriptView.locator('.cm-content').innerText(), t => t.includes('second <- 2'), 'draft shown after the layout switch');
  await scriptView.locator('.cm-content').click(); await page.keyboard.press('Meta+z');
  const undone = await poll(read, d => !d.content.includes('second <-'), 'own undo continues after the switch');
  assert.ok(undone.content.includes('first <- "人类 🧬"'), 'undo takes back only the latest edit');
  assert.equal(undone.dirty, true);
  assert.equal(await focusInScript(), true);
  const history = (await call('document.history', { documentId: script.id })).entries ?? (await call('document.history', { documentId: script.id })).history ?? [];
  assert.ok(history.every(h => !String(h.author ?? '').startsWith('agent:')), 'only the person changed the script');
  // Collapsing to one view at a time and back moves the editor; the person's focus moves with it.
  await scriptView.locator('.cm-editor').evaluate(e => { e.__rhoProbe = 'kept'; });
  for (const [width, height, narrow] of [[390, 844, 'attached'], [1440, 900, 'detached']]) {
    await page.setViewportSize({ width, height }); await page.locator('.shell-header-narrow').waitFor({ state: narrow });
    await poll(focusInScript, Boolean, 'focus kept in the editor at ' + width, 30);
    assert.equal(await kept(), true);
  }
  check('hard case: unsaved script keeps its element and focus through an Agent layout, a re-layout and a collapse to one view, survives a layout switch, and own undo continues');

  // Composition fidelity: the DOM reproduces the owner's tree.
  const samples = [
    ['single', [{ id: 'r', kind: 'group', children: ['A'] }, editor('A', notes.id)]],
    ['two tabs', [{ id: 'r', kind: 'group', children: ['A', 'B'], presentation: { mode: 'tabs' } }, editor('A', notes.id), editor('B', script.id)]],
    ['left right', [{ id: 'r', kind: 'group', children: ['A', 'B'], presentation: { mode: 'split', axis: 'horizontal', weights: [1, 1] } }, editor('A', notes.id), grid('B')]],
    ['top bottom', [{ id: 'r', kind: 'group', children: ['A', 'B'], presentation: { mode: 'split', axis: 'vertical', weights: [1, 1] } }, editor('A', notes.id), grid('B')]],
    ['three levels', [{ id: 'r', kind: 'group', children: ['A', 'm'], presentation: { mode: 'split', axis: 'horizontal', weights: [1, 2] } }, { id: 'm', kind: 'group', children: ['B', 't'], presentation: { mode: 'split', axis: 'vertical', weights: [3, 1] } }, { id: 't', kind: 'group', children: ['C', 'D'] }, editor('A', notes.id), grid('B'), editor('C', script.id), editor('D', notes.id)]],
    ['uneven', [{ id: 'r', kind: 'group', children: ['A', 'B', 'C'], presentation: { mode: 'split', axis: 'horizontal', weights: [5, 2, 3] } }, editor('A', notes.id), grid('B'), editor('C', script.id)]],
  ];
  // One layout per sample: a view the person selected stays theirs (S7), so samples must not share live state.
  for (const [i, [, nodes]] of samples.entries()) await call('composition.apply', { compositionId: 'fidelity-' + i, expectedVersion: 0, changeId: 'f' + i, operations: [{ op: 'replace', rootId: 'r', nodes }] });
  const expected = (nodes, id = 'r') => {
    const n = nodes.find(x => x.id === id);
    if (n.kind === 'view') return { tabs: [n.id] };
    if (n.presentation?.mode === 'split') return { axis: n.presentation.axis, weights: n.presentation.weights, children: n.children.map(c => expected(nodes, c)) };
    const leaves = c => { const x = nodes.find(y => y.id === c); return x.kind === 'view' ? [x.id] : x.children.flatMap(leaves); };
    return { tabs: n.children.flatMap(leaves) };
  };
  const observed = () => page.evaluate(() => {
    const read = el => {
      if (el.matches('.shell-group')) return { tabs: [...el.querySelectorAll('[role=tab]')].map(t => t.title.split(' · ')[0]) };
      const panes = [...el.children].filter(c => c.matches('.shell-pane')), row = el.dataset.axis === 'horizontal';
      const sizes = panes.map(p => { const r = p.getBoundingClientRect(); return row ? r.width : r.height; }), total = sizes.reduce((a, b) => a + b, 0);
      return { axis: el.dataset.axis, shares: sizes.map(s => s / total), children: panes.map(p => read(p.firstElementChild)) };
    };
    const top = document.querySelector('.shell-stage > .shell-split, .shell-stage > .shell-group');
    return top ? read(top) : null;
  });
  const compare = (want, got, at) => {
    if (want.tabs) { assert.deepEqual(got.tabs, want.tabs, at); return 0; }
    assert.equal(got.axis, want.axis, at); assert.equal(got.children.length, want.children.length, at);
    const total = want.weights.reduce((a, b) => a + b, 0);
    let worst = Math.max(...want.weights.map((w, i) => Math.abs(w / total - got.shares[i])));
    want.children.forEach((c, i) => { worst = Math.max(worst, compare(c, got.children[i], at)); });
    return worst;
  };
  for (const [i, [name, nodes]] of samples.entries()) {
    await layoutNav('fidelity-' + i).click();
    for (const [width, height] of [[1440, 900], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.shell-header-narrow').waitFor({ state: 'detached' });
      const want = expected(nodes);
      let last = null;
      const got = await poll(observed, g => { last = g; try { compare(want, g, name); return true; } catch { return false; } }, `${name} at ${width}`, 60).catch(e => { throw new Error(e.message + ': ' + JSON.stringify(last)); });
      const error = compare(want, got, name);
      assert.ok(error <= 0.02, `${name} ${width}: weight error ${(error * 100).toFixed(1)}%`);
      report.fidelity.push({ name, width, maxWeightError: Math.round(error * 1000) / 1000 });
    }
    // Collapsed: one tab list in reading order, keyboard selection, and an unchanged record.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.shell-header-narrow').waitFor({ state: 'attached' });
    const list = page.getByRole('tablist', { name: 'Views', exact: true });
    const order = (function leaves(id) { const x = nodes.find(y => y.id === id); return x.kind === 'view' ? [x.id] : x.children.flatMap(leaves); })('r');
    await poll(() => list.getByRole('tab').allTextContents(), t => JSON.stringify(t.map(s => s.split(' · ')[0])) === JSON.stringify(order), `${name} collapsed order`);
    if (order.length > 1) {
      await list.getByRole('tab', { selected: true }).focus(); const before = await list.getByRole('tab', { selected: true }).textContent();
      await page.keyboard.press('ArrowRight');
      const after = await poll(() => list.getByRole('tab', { selected: true }).textContent(), t => t !== before, `${name}: ArrowRight selects the next view (was ${before})`, 30);
      assert.notEqual(after, before);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'tab', `${name}: focus follows the selected tab, not ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))}`);
    }
    assert.ok((await list.getByRole('tab').evaluateAll(tabs => tabs.every(t => (t.textContent ?? '').trim()))), `${name}: every tab is named`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.shell-header-narrow').waitFor({ state: 'detached' });
    const record = await call('composition.read', { compositionId: 'fidelity-' + i });
    assert.equal(record.version, 1, `${name}: collapsing changes no record`);
  }
  check('composition fidelity: six trees reproduce axis, order and weights within 2% at 1440 and 1024, collapse to keyboard tabs in reading order at 390, and leave the record unchanged');

  // A divider is a keyboard window splitter and changes only this tab's view of the layout.
  await layoutNav('fidelity-2').click();
  const divider = page.getByRole('separator').first();
  await divider.waitFor(); const start = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.ok(Number(await divider.getAttribute('aria-valuenow')) >= start + 9, 'arrows move the divider');
  assert.equal((await call('composition.read', { compositionId: 'fidelity-2' })).version, 1);
  check('a divider is a named, focusable separator moved by arrows; it changes no owner record');

  // A declared item is the Agent's statement: on the view it names and in the evidence, nowhere else.
  await agent.call('task.map.declare', { projectId: project.id, expectedVersion: 0, changeId: 'items', question: 'Do the scores hold?', vocabulary: { kinds: { check: { label: 'Check' } }, states: { open: { label: 'still open' } } }, items: [{ id: 'scores', kind: 'check', state: 'open', title: 'Scores rise with row order', view: 'Table' }], next: [] });
  await layoutNav('workspace').click(); await scriptView.locator('.cm-content').waitFor();
  const note = page.locator('[data-owner-view="Table"] [data-fact="agent"]');
  await poll(() => note.textContent().catch(() => ''), t => t === 'Agent: Scores rise with row order · still open', 'declared item on the view it names');
  assert.equal(await page.locator('[data-owner-view="Script"] [data-fact="agent"]').count(), 0);
  const evidenceToggle = page.getByRole('button', { name: /Recorded evidence$/ });
  assert.match(await evidenceToggle.textContent(), /^1 Agent note · /);
  await evidenceToggle.click();
  await page.getByRole('region', { name: "The Agent's notes", exact: true }).getByText('Scores rise with row order', { exact: true }).waitFor();
  await evidenceToggle.click();
  check("a declared item shows as the Agent's statement on the view it names and in the recorded evidence");

  // Rulers on a static layout: the editor has focus, the table shares the screen.
  await layoutNav('workspace').click(); await scriptView.locator('.cm-content').waitFor();
  await rulers(page, { name: 'static', profile: profiles.shell, first: () => firstUnit(scriptView, 'editor'), evidence, report });
  const required = ['M1', 'M4', 'M6', 'M7', 'M8', 'M9', 'M10'];
  const failing = report.rulers.flatMap(r => r.failures.filter(f => required.some(m => f.startsWith(m))).map(f => `${r.width}: ${f}`));
  assert.deepEqual(failing, [], 'rulers');
  check('M1, M4, M6-M10 hold on a static split layout at four viewports');
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack?.split('\n').filter(l => l.includes('.mjs')).slice(0, 3).join(' | ') }; process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, report: path.join(evidence, 'report.json') }) + '\n');
}
