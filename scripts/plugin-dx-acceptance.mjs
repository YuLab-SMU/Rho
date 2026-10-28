// A new author package, its standalone preview and its selected production UI.
// No Core, R, model or existing user service is needed for this flow.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createUiPlugin } from './ui-plugin.mjs';
import { RhoService } from '../dist/server.js';
import { RhoClient } from '../dist/client.js';
import { inspectResponsive } from './browser-checks.mjs';
const application = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(process.env.RHO_PLUGIN_DX_EVIDENCE ?? 'work/plugin-dx/acceptance');
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-plugin-dx-')), plugin = path.join(root, 'notes');
const report = { passed: false, checks: [], responsive: [] };
let browser, preview, service;
const pass = name => { report.checks.push(name); console.log('ok · ' + name); };
async function run(command, args, cwd, log, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-24000); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await fs.writeFile(path.join(evidence, log), output);
  assert.equal(code, 0, command + ' failed: ' + output.slice(-3000));
  return output;
}
try {
  await createUiPlugin(plugin, { name: '@example/author-notes', component: 'example.author-notes' });
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], plugin, 'install.log');
  await run('npm', ['run', 'check'], plugin, 'check.log');
  await run('npm', ['run', 'build'], plugin, 'plugin-build.log');
  pass('a fresh package outside the repositories installs, typechecks and compiles');
  preview = spawn(process.execPath, [path.join(application, 'scripts/ui-plugin.mjs'), 'dev', plugin, '--port', '0'], { cwd: plugin, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; preview.stdout.on('data', b => { output = (output + b).slice(-4000); }); preview.stderr.on('data', b => { output = (output + b).slice(-4000); });
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => { const line = output.split('\n').find(l => l.startsWith('{"preview":')); if (line) { clearInterval(timer); clearTimeout(deadline); resolve(JSON.parse(line).preview); } }, 50);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Preview startup: ' + output)); }, 30000);
    preview.once('exit', code => { clearInterval(timer); clearTimeout(deadline); reject(new Error('Preview exited ' + code + ': ' + output)); });
  });
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('heading', { name: 'Research notes', exact: true }).waitFor();
  await page.getByText('保留 Unicode 🧬', { exact: false }).waitFor();
  await inspectResponsive(page, { name: 'preview', evidence, report });
  for (const [mode, message] of [['loading', 'Reading document…'], ['error', 'Preview: the owner is unavailable.'], ['unbound', 'Bind a document to get started.']]) {
    await page.getByLabel('State', { exact: true }).selectOption(mode); await page.getByText(message, { exact: true }).waitFor();
  }
  await page.getByLabel('State', { exact: true }).selectOption('ready');
  await page.getByLabel('View props', { exact: true }).fill('{"title":"Preview edited props"}');
  await page.getByRole('button', { name: 'Apply props' }).click(); await page.getByRole('heading', { name: 'Preview edited props' }).waitFor();
  const source = path.join(plugin, 'src/ui.tsx');
  await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('characters</p>', 'Unicode characters</p>'));
  await page.getByText(/\d+ Unicode characters/).waitFor();
  assert.equal((await fetch(url + '/@fs' + path.join(application, 'AGENTS.md'))).status, 403);
  pass('preview states, editable props, Unicode and source refresh work without project access');
  await page.screenshot({ path: path.join(evidence, 'preview-refreshed.png') });
  preview.kill('SIGTERM'); await new Promise(resolve => preview.once('exit', resolve)); preview = null;
  await run('npm', ['run', 'build'], plugin, 'plugin-rebuild.log');
  const packed = JSON.parse(await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], plugin, 'pack.log'))[0];
  const selected = path.join(root, 'selected'); await fs.mkdir(selected);
  await fs.writeFile(path.join(selected, 'package.json'), JSON.stringify({ name: 'author-selection', version: '1.0.0', private: true }));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(root, packed.filename)], selected, 'selected-install.log');
  const selectionFile = path.join(selected, 'rho-selection.json');
  await fs.writeFile(selectionFile, JSON.stringify({ format: 'rho.ui-selection/1', packages: [{ package: '@example/author-notes', version: '0.1.0' }] }));
  const webRoot = path.join(root, 'web');
  await run('npm', ['run', 'build:web'], application, 'application-build.log', { RHO_UI_EXTENSIONS: selectionFile, RHO_WEB_OUTPUT: webRoot });
  const manifest = JSON.parse(await fs.readFile(path.join(webRoot, 'composition.json'), 'utf8'));
  const record = manifest.ownerEntries.find(e => e.component === 'example.author-notes');
  assert.equal(record.packageVersion, '0.1.0'); assert.match(record.entrySha256, /^[a-f0-9]{64}$/); assert.equal(record.localOverride, false);
  await fs.mkdir(path.join(root, 'projects'));
  service = await new RhoService({ root: path.join(root, 'projects'), stateDir: path.join(root, 'state'), coreBinary: '/missing', rscript: '/missing', webRoot }).start();
  const client = new RhoClient({ url: service.url, token: service.adminToken });
  const project = await client.call('project.create', { name: 'Plugin author trial' });
  const call = (method, input = {}) => client.call(method, { projectId: project.id, ...input });
  await fs.writeFile(path.join(project.root, 'notes.md'), '# Shared notes\n\n作者与 Agent 使用同一份内容。');
  const document = await call('document.open', { path: 'notes.md' });
  await call('composition.apply', { compositionId: 'author-workspace', expectedVersion: 0, changeId: 'initial', operations: [{ op: 'replace', rootId: 'root', nodes: [{ id: 'root', kind: 'group', children: ['summary', 'editor'] },
    { id: 'summary', kind: 'view', component: 'example.author-notes', version: '1.0.0', props: { title: 'Shared summary' }, bindings: { document: { kind: 'live-document', documentId: document.id } } },
    { id: 'editor', kind: 'view', component: 'rho.editor', version: '0.2.0', props: { title: 'notes.md' }, bindings: { document: { kind: 'live-document', documentId: document.id } } }
  ] }] });
  const pairing = await client.call('session.browser.pair', {});
  await page.goto(service.url + '/#pair=' + pairing.code);
  await page.locator('.project-row').filter({ hasText: project.name }).click(); await page.locator('.workspace-card').click();
  await page.getByRole('tab', { name: 'Shared summary', exact: true }).click();
  await page.locator('[data-owner-view="summary"]').getByText('作者与 Agent 使用同一份内容。', { exact: false }).waitFor();
  await inspectResponsive(page, { name: 'installed-view', evidence, report });
  await call('document.edit', { documentId: document.id, expectedVersion: document.version, edits: [{ from: document.content.length, to: document.content.length, insert: '\nNew shared update 🧬' }], undoGroup: 'owner-edit' });
  await page.locator('[data-owner-view="summary"]').getByText('New shared update 🧬', { exact: false }).waitFor();
  await page.getByText('Arrange views', { exact: true }).click(); await page.locator('.view-menu').getByRole('button', { name: 'Split right', exact: true }).click();
  await page.locator('.shell-split').waitFor();
  await page.reload(); await page.locator('.shell-split').waitFor();
  await page.locator('[data-owner-view="summary"]').getByText('New shared update 🧬', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'composed.png') });
  assert.equal(service.bridge.owned.size, 0);
  assert.deepEqual(errors, []);
  pass('the configured production view reads the real shared buffer and survives split and reload');
  report.entry = record; report.hostsStarted = 0; report.passed = true;
} catch (error) { report.failure = error.stack ?? String(error); throw error; }
finally { await browser?.close(); preview?.kill('SIGTERM'); await service?.close(); await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); if (report.passed) await fs.rm(root, { recursive: true, force: true }); }
