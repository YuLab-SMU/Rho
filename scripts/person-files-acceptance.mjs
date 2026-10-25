// The person's own path, checked in a real browser at three widths: list the folder
// they selected, open, edit and conditionally save a text file without an Agent.
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
  // Documents and files wait behind their disclosure on the project page.
  await page.locator('main summary').filter({ hasText: 'Documents and files' }).click();
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
  const editorInput = page.locator('.cm-content:visible');
  const save = page.getByRole('button', { name: 'Save document', exact: true });
  const disk = path.join(project, 'R', 'plot.R');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await editorInput.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(`# saved at ${width} · 中文 🧬\n`);
    await save.waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Save document"]')?.disabled);
    if (width === 768) await page.keyboard.press('ControlOrMeta+s');
    else await save.click();
    for (let n = 0; n < 100 && !(await fs.readFile(disk, 'utf8')).includes(`saved at ${width}`); n++) await page.waitForTimeout(50);
    assert.match(await fs.readFile(disk, 'utf8'), new RegExp(`saved at ${width} · 中文 🧬`));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `editor fits ${width}`);
    await page.screenshot({ path: path.join(evidence, 'saved-' + width + '.png') });
  }
  check('button and keyboard save real Unicode bytes at all three widths');
  await page.reload();
  await editorInput.waitFor();
  // The editor mounts before the document text arrives; read once it has.
  await editorInput.getByText(/saved at 390/).waitFor({ timeout: 10000 });
  assert.match(await editorInput.innerText(), /saved at 390/);
  check('a refreshed tab reads the saved document');

  await editorInput.click(); await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# collaborator save\n');
  const documentId = (await operator.call('observation.snapshot', { projectId: p.id })).documents[0].id;
  let shared;
  for (let n = 0; n < 100; n++) {
    shared = await operator.call('document.read', { projectId: p.id, documentId });
    if (shared.content.includes('collaborator save')) break;
    await page.waitForTimeout(50);
  }
  await operator.call('document.save', { projectId: p.id, documentId, expectedVersion: shared.version, expectedRevision: shared.revision, expectedDiskDigest: shared.diskDigest, changeId: 'collaborator-save' });
  await page.waitForFunction(() => document.querySelector('[aria-label="Save document"]')?.disabled === true);
  check('another writer saving the same text version updates the tab through the owner revision');

  await fs.writeFile(disk, 'External writer preserved.\n');
  await editorInput.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('# unsaved local edit\n');
  await page.waitForFunction(() => !document.querySelector('[aria-label="Save document"]')?.disabled);
  await save.click();
  await page.getByRole('status').filter({ hasText: /file changed on disk/i }).waitFor();
  assert.equal(await fs.readFile(disk, 'utf8'), 'External writer preserved.\n');
  assert.match(await editorInput.innerText(), /unsaved local edit/);
  check('an external disk write refuses save and preserves both disk and buffer');

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
