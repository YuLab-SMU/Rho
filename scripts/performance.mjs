// Workspace performance (docs/WORKSPACE-PLAN.md §2.3), measured in real Chrome against the
// launcher this checkout builds. RHO_SHELL=next selects the new shell. RHO_PERF_ENFORCE=1
// compares with the committed W0 baseline and the fixed budgets; otherwise it only records.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { RhoClient, native, packageRoot } from './support.mjs';
const shell = process.env.RHO_SHELL === 'next' ? 'next' : 'legacy', enforce = process.env.RHO_PERF_ENFORCE === '1';
const evidence = path.resolve(process.env.RHO_PERF_EVIDENCE ?? 'work/performance-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp('/tmp/rho-perf-'), state = path.join(root, '.service');
const report = { shell, passed: false, machine: { platform: process.platform + '-' + process.arch, cpu: (await import('node:os')).cpus()[0]?.model, node: process.version }, bundle: {}, timings: {}, latency: {}, memory: {} };
const p95 = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const rss = pid => Number(spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || 0;
let child, browser;
try {
  // Bytes a first visit downloads (the entry the page references) and everything shipped.
  const web = path.join(packageRoot, 'dist/web'), html = await fs.readFile(path.join(web, 'index.html'), 'utf8');
  const assets = (await fs.readdir(path.join(web, 'assets'))).map(f => 'assets/' + f), gz = async f => gzipSync(await fs.readFile(path.join(web, f))).length;
  const initial = assets.filter(f => html.includes(f));
  report.bundle = { initialGzip: (await Promise.all(initial.map(gz))).reduce((a, b) => a + b, 0), totalGzip: (await Promise.all(assets.map(gz))).reduce((a, b) => a + b, 0), initial };
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/cli.js'), '--root', root, '--state-dir', state, '--core', native.coreBinary, '--rscript', native.rscript], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(new Error('Launcher readiness timed out')), 20000);
    child.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { const v = JSON.parse(line); if (v.ready) { clearTimeout(timer); resolve(v.ready); } } catch {} } });
  });
  const admin = await RhoClient.fromFile(path.join(state, 'connection.json'));
  const project = await admin.call('project.create', { name: 'Performance' });
  const call = (m, b = {}) => admin.call(m, { projectId: project.id, ...b });
  await fs.writeFile(path.join(project.root, 'analysis.R'), Array.from({ length: 40 }, (_, i) => `x${i} <- rnorm(${i + 10})`).join('\n') + '\n');
  const doc = await call('document.open', { path: 'analysis.R' });
  const csv = 'id,score,flag\n' + Array.from({ length: 1400 }, (_, i) => `id-${String(i).padStart(4, '0')},${(i * 7919) % 1000},${i % 2 === 0}`).join('\n') + '\n';
  await fs.writeFile(path.join(project.root, 'results.csv'), csv);
  const table = await call('resource.register', { expectedDigest: createHash('sha256').update(csv).digest('hex'), declaration: { path: 'results.csv', kind: 'table', format: { encoding: 'csv', columns: [{ name: 'id', type: 'string', nullValues: [] }, { name: 'score', type: 'number', nullValues: [] }, { name: 'flag', type: 'boolean', nullValues: [] }], key: { column: 'id', namespace: 'samples' } } } });
  const ref = { id: table.id, version: table.version }, live = { kind: 'live-document', documentId: doc.id };
  const editors = ['Editor-1', 'Editor-2', 'Editor-3', 'Editor-4'], tables = ['Table-1', 'Table-2', 'Table-3', 'Table-4'];
  await call('composition.apply', { compositionId: 'workspace', expectedVersion: 0, changeId: 'perf', operations: [{ op: 'replace', rootId: 'root', nodes: [
    { id: 'root', kind: 'group', children: [...editors, ...tables] },
    ...editors.map(id => ({ id, kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: id }, bindings: { document: live } })),
    ...tables.map(id => ({ id, kind: 'view', component: 'rho.table', version: '0.2.0', props: { title: id }, bindings: { data: ref } })),
  ] }] });
  report.memory.serviceIdleRssKiB = rss(child.pid);
  let peak = report.memory.serviceIdleRssKiB; const sampler = setInterval(() => { peak = Math.max(peak, rss(child.pid)); }, 200);
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__events = [];
    new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.interactionId) window.__events.push({ id: e.interactionId, name: e.name, duration: e.duration }); }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  });
  await page.goto(ready.openUrl + (shell === 'next' ? '&shell=next' : ''));
  await page.locator('.project-row').filter({ hasText: 'Performance' }).click();
  const opened = Date.now();
  await page.locator('.nav-row').filter({ hasText: 'workspace' }).click();
  await page.locator('.cm-content:visible').first().waitFor();
  report.timings.openWorkspaceMs = Date.now() - opened;
  const tab = name => shell === 'next' ? page.getByRole('tab', { name, exact: true }) : page.locator('.dv-tab').filter({ hasText: name }).first();
  // Interactions are counted by interactionId; ones under the 16 ms reporting threshold count as 16.
  const measured = async (count, act) => {
    const before = await page.evaluate(() => window.__events.length); await act();
    await page.waitForTimeout(300);
    const entries = (await page.evaluate(() => window.__events)).slice(before), byId = new Map();
    for (const e of entries) byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.duration));
    const values = [...byId.values()]; while (values.length < count) values.push(16);
    return { p95: p95(values), max: Math.max(...values), interactions: count, reported: byId.size };
  };
  const editor = page.locator('.cm-content:visible').first();
  await editor.click(); await page.keyboard.press('Meta+End');
  const typed = 'summary(x1) # 中文 note';
  report.latency.typing = await measured([...typed].length, () => page.keyboard.type(typed, { delay: 40 }));
  report.latency.switchView = await measured(16, async () => { for (let i = 0; i < 2; i++) for (const name of [...editors, ...tables]) { await tab(name).click(); await page.waitForTimeout(60); } });
  await tab('Table-1').click(); await page.locator('.ag-header-cell[col-id="score"]:visible').first().waitFor();
  report.latency.sort = await measured(4, async () => { for (let i = 0; i < 4; i++) { await page.locator('.ag-header-cell[col-id="score"]:visible .ag-header-cell-label').first().click(); await page.waitForTimeout(150); } });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  report.memory.browserHeapUsedKiB = Math.round(metrics.JSHeapUsedSize / 1024);
  clearInterval(sampler); report.memory.servicePeakRssKiB = peak;
  assert.deepEqual(errors, []);
  if (enforce) {
    const base = JSON.parse(await fs.readFile(path.join(packageRoot, 'scripts/performance-baseline.json'), 'utf8'));
    assert.ok(report.timings.openWorkspaceMs <= 1500, `open ${report.timings.openWorkspaceMs} ms > 1500`);
    assert.ok(report.latency.typing.p95 <= 50, `typing p95 ${report.latency.typing.p95} ms > 50`);
    for (const k of ['switchView', 'sort']) assert.ok(report.latency[k].p95 <= 100, `${k} p95 ${report.latency[k].p95} ms > 100`);
    for (const k of ['browserHeapUsedKiB', 'servicePeakRssKiB']) assert.ok(report.memory[k] <= base.memory[k] * 1.2, `${k} ${report.memory[k]} > baseline ${base.memory[k]} + 20%`);
    for (const k of ['initialGzip', 'totalGzip']) assert.ok(report.bundle[k] <= base.bundle[k], `${k} ${report.bundle[k]} > baseline ${base.bundle[k]}`);
  }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message }; process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, bundle: report.bundle, timings: report.timings, latency: report.latency, memory: report.memory }) + '\n');
}
