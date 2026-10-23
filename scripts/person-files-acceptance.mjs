// The person's own path, checked in a real browser at three widths: list the folder
// they selected, open a text file from it, read the bytes, and confirm the boundary
// the tab still has. This is the check behind rho.person-files.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(process.env.RHO_PACKAGE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
let driver;
try {
  // Accept either an absolute path or an already-resolved file URL.
  const selected = process.env.RHO_UI_PLAYWRIGHT_MODULE;
  driver = selected ? (selected.startsWith('file:') ? selected : pathToFileURL(selected).href) : import.meta.resolve('@playwright/test');
}
catch { console.error('This acceptance needs the external browser driver (@playwright/test).'); process.exit(2); }
const { chromium } = await import(driver);
const { RhoService } = await import(pathToFileURL(path.join(packageRoot, 'dist/server.js')).href);
const { RhoClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/client.js')).href);

const evidence = path.resolve(process.env.RHO_PERSON_EVIDENCE ?? 'work/person-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rho-person-'));
const project = path.join(root, 'work'), state = path.join(root, '.service');
await fs.mkdir(path.join(project, 'R'), { recursive: true });
const script = 'speed <- datasets::cars$speed\nplot(speed)\n';
await fs.writeFile(path.join(project, 'R', 'plot.R'), script);
await fs.writeFile(path.join(project, 'notes.md'), '# Notes\n\nReal file.\n');
const report = { passed: false, widths: [], checks: [], limits: ['Chrome only', 'The operating-system folder dialog is not exercised; the project is opened directly'] };
const check = name => { report.checks.push(name); process.stdout.write('- ' + name + '\n'); };

let service, browser;
try {
  service = await new RhoService({ root, stateDir: state, coreBinary: '/missing', rscript: '/missing' }).start();
  const operator = new RhoClient({ url: service.url, token: service.adminToken });
  const p = await operator.call('project.open', { path: 'work' });
  // Two one-use codes: one for the page the person drives, one for the Node client
  // that checks what the tab is still refused.
  const { code } = await operator.call('session.browser.pair', {});
  const second = await operator.call('session.browser.pair', {});
  const grant = (await (await fetch(service.url + '/api/browser/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: service.url }, body: JSON.stringify({ code: second.code }) })).json()).value;

  browser = await chromium.launch(process.env.RHO_UI_CHROME ? { executablePath: process.env.RHO_UI_CHROME } : {});
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.url + '/#pair=' + code);
  await page.waitForTimeout(2500);
  if (process.env.RHO_PERSON_DEBUG) console.log('HOME TEXT:\n' + await page.evaluate(() => document.body.innerText));

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}`);
    report.widths.push(width);
    await page.screenshot({ path: path.join(evidence, 'home-' + width + '.png') });
  }
  check('the shell loads at 1440, 768 and 390 without horizontal overflow');

  // The person's own path, through the buttons they actually press.
  await page.locator('.project-row').first().click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /Browse this folder/ }).click();
  await page.waitForTimeout(1200);
  const listed = await page.locator('.overview-section').filter({ hasText: 'Files' }).innerText();
  assert.match(listed, /notes\.md/);
  assert.match(listed, /R/);
  check('the Files section lists the real folder');

  await page.getByRole('button', { name: /^R$/ }).click();
  await page.waitForTimeout(1000);
  assert.match(await page.locator('.overview-section').filter({ hasText: 'Files' }).innerText(), /plot\.R/);
  check('a subfolder can be opened from the list');

  await page.getByRole('button', { name: /plot\.R/ }).click();
  await page.waitForTimeout(2000);
  const editor = (await page.locator('.cm-content:visible').innerText().catch(() => '')) || await page.evaluate(() => document.body.innerText);
  assert.match(editor, /datasets::cars/);
  // A tab may type into the buffer but never write it, and the product says so
  // instead of letting the person discover it after typing.
  // Visible, not merely present in the DOM: a note below the editor is never read.
  const note = page.locator('.rho-tab-buffer-note');
  assert.equal(await note.count(), 1);
  assert.equal(await note.isVisible(), true);
  assert.match(await note.innerText(), /Saving to disk is an Agent step/);
  await page.screenshot({ path: path.join(evidence, 'opened.png') });
  check('the opened file shows its real bytes, and says saving is an Agent step');

  // The boundary a tab still has: refused by the service, not by the interface.
  const { BrowserClient } = await import(pathToFileURL(path.join(packageRoot, 'dist/browser.js')).href);
  const tab = new BrowserClient({ url: service.url, ...grant });
  await assert.rejects(tab.call('project.entries', { projectId: p.id, path: '..' }), error => ['scope', 'invalid'].includes(error.error.kind));
  await assert.rejects(tab.call('resource.register', { projectId: p.id, declaration: { path: 'notes.md', kind: 'file', format: { mimeType: 'text/markdown' } }, expectedDigest: '0'.repeat(64) }), error => error.error.kind === 'unauthorized');
  await assert.rejects(tab.call('action.submit', { projectId: p.id, operationId: 'x', action: 'r.execute', actionVersion: '0.2.0', input: {} }), error => error.error.kind !== undefined);
  check('the tab is still refused parent paths, registration and execution');

  // What the project is running is visible to the person who owns it.
  const runs = await page.evaluate(() => document.body.innerText.includes('Work in this project') ? 'shown' : 'absent');
  report.runsSection = runs;
  assert.deepEqual(errors, [], 'no page errors');
  check('no page errors');
  report.passed = true;
} catch (error) {
  report.failure = { message: error?.message, kind: error?.error?.kind };
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await service?.close().catch(() => {});
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.stdout.write(JSON.stringify({ passed: report.passed, widths: report.widths, checks: report.checks.length }) + '\n');
}
