import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManagerPlugin } from '../../scripts/build-manager-plugin.mjs';
import { buildUiFixture } from '../../scripts/fixtures/plugin-ui.mjs';

let directory: string, project: string, archive: string, subject: any, url: URL, host: ReturnType<typeof spawn>, managerView: any, analysisView: any, completed = false;
const managerWindow = 'archive-manager', analysisWindow = 'archive-analysis';
async function port(method: string, params: any, window = managerWindow) {
  const reply = await fetch(new URL('/api/host', url), { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': window },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw Error(reply.error); return reply.result;
}
async function query(id: string, args: any) { return (await port('query_snapshot', { capability: { id, version: 1 }, arguments: args })).data; }
async function invoke(id: string, args: any, window = managerWindow) {
  const record = await port('invoke', { capability: { id, version: 1 }, arguments: args, client_request_id: crypto.randomUUID(), preconditions: [] }, window);
  expect(record.status, record.error).toBe('succeeded'); return record.output;
}
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rho-manager-archive-')); project = join(directory, 'project'); await mkdir(project); project = await realpath(project);
  const binary = resolve('../target/debug/rho'), database = join(directory, 'host.sqlite'), seed = join(directory, 'source-catalog', 'host.sqlite');
  await mkdir(join(directory, 'source-catalog'));
  const cli = (db: string, args: string[]) => JSON.parse(execFileSync(binary, ['--database', db, 'plugins', ...args], { encoding: 'utf8' })).result;
  const managerPackage = cli(database, ['snapshot', buildManagerPlugin(join(directory, 'manager'))]);
  const source = buildUiFixture(directory), manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
  manifest.requires = manifest.requires.filter((r: any) => r.capability.id !== 'fixture.answer');
  await writeFile(join(source, 'plugin.json'), JSON.stringify(manifest)); const analysis = cli(database, ['snapshot', source]);
  const local = join(directory, 'local-package'); await cp(source, local, { recursive: true });
  manifest.id = 'example.archive-import'; manifest.name = 'Local report package'; manifest.version = '2.0';
  manifest.description = 'A local archive with Unicode source and an exact built view.';
  manifest.source.files.push('source-note.txt');
  await writeFile(join(local, 'source-note.txt'), 'Archive content 中文 Ω\n'.repeat(12000));
  await writeFile(join(local, 'plugin.json'), JSON.stringify(manifest)); subject = cli(seed, ['snapshot', local]);
  archive = join(directory, '本地报告与完整源码-科学检查-Ω.rho-plugin'); cli(seed, ['export', subject.revision, archive]);
  host = spawn(binary, ['--database', database, '--project', project, '--plugins-only', 'workbench'], { stdio: ['ignore', 'pipe', 'pipe'] });
  url = new URL(await new Promise<string>((done, reject) => {
    let out = '', errors = ''; const timer = setTimeout(() => reject(Error(`Archive Host startup timed out: ${errors}`)), 40000);
    host.stderr!.on('data', bytes => errors += bytes); host.stdout!.on('data', bytes => { out += bytes; const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (match) { clearTimeout(timer); done(match[0]); } });
    host.once('exit', code => { clearTimeout(timer); reject(Error(`Archive Host exited ${code}: ${errors}`)); });
  }));
  for (const [pkg, alias, window, contribution] of [[managerPackage, 'manager', managerWindow, 'manager'], [analysis, 'analysis', analysisWindow, 'view']] as const) {
    const instance = (await invoke('plugins.activate', { revision: pkg.revision, artifact: pkg.artifacts[0], target: 'ui-web', alias, configuration: {} }, window)).instance.identity;
    const view = (await invoke('windows.open_view', { expected_layout_version: 0, group: null, view: { instance, window, contribution, configuration: {}, state: contribution === 'view' ? { text: 'Saved analysis' } : {} } }, window)).view;
    if (contribution === 'manager') managerView = view; else analysisView = view;
  }
});
test.afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGINT'); await new Promise<void>(done => host.once('exit', () => done())); }
  if (completed) await rm(directory, { recursive: true, force: true }); else if (directory) console.error(`Archive fixture retained at ${directory}`);
});
test('imports a chosen archive through an ordinary view and recovers original requests without activating code', async ({ page, context }, info) => {
  test.setTimeout(180000);
  const address = (window: string) => { const result = new URL(url); result.searchParams.set('window', window); return result.href; };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const analysisPage = await context.newPage(); await analysisPage.goto(address(analysisWindow));
  const note = analysisPage.locator(`[data-plugin-frame="${analysisView.view}"]`).frameLocator('iframe').getByLabel('View note');
  await expect(note).toHaveValue('Saved analysis'); await note.fill('Unsaved analysis 中文 Ω');
  await page.goto(address(managerWindow));
  const region = page.locator(`[data-plugin-frame="${managerView.view}"]`), frame = region.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
  const initialCount = (await query('plugins.instances', { after: null, limit: 100 })).total;
  const baseline = await query('plugins.list', { after: null, limit: 100 }), initialCatalog = baseline.total;
  expect(baseline.items.some((item: any) => item.revision === subject.revision)).toBe(false);
  let lostChunk = false;
  await page.route('**/api/plugin-view', async route => {
    const body = route.request().postDataJSON()?.message?.body;
    if (!lostChunk && body?.type === 'control' && body.capability.id === 'plugins.archive_stage') {
      lostChunk = true; const response = await route.fetch(), reply = await response.json(); expect(reply.ok).toBe(true);
      await route.fulfill({ response, json: { ...reply, ok: false, result: undefined, error: 'Original upload acknowledgement lost' } });
    } else await route.continue();
  });
  await frame.getByRole('button', { name: 'Import package', exact: true }).click();
  await frame.locator('#archive-file').setInputFiles(archive);
  await expect(frame.getByRole('button', { name: 'Upload and inspect', exact: true })).toBeEnabled();
  const original = (await query('views.inspect', { view: managerView.view })).state.upload.reference;
  await frame.getByRole('button', { name: 'Upload and inspect', exact: true }).click();
  await expect(frame.locator('#import-error')).toContainText('acknowledgement lost'); expect(lostChunk).toBe(true);
  expect((await query('plugins.list', { after: null, limit: 100 })).total).toBe(initialCatalog);
  await page.unroute('**/api/plugin-view'); await page.reload();
  await frame.getByRole('button', { name: 'Import package', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Upload and inspect', exact: true })).toBeDisabled();
  await frame.getByRole('button', { name: 'Inspect retained upload', exact: true }).click();
  await expect(frame.locator('#archive-progress')).toContainText('65,536');
  await frame.locator('#archive-file').setInputFiles({ name: 'different.rho-plugin', mimeType: 'application/json', buffer: Buffer.from('different bytes') });
  await expect(frame.locator('#import-error')).toContainText('exact retained file');
  expect((await query('views.inspect', { view: managerView.view })).state.upload.reference).toEqual(original);
  await frame.locator('#archive-file').setInputFiles(archive); await expect(frame.getByRole('button', { name: 'Upload and inspect', exact: true })).toBeEnabled();
  await frame.getByRole('button', { name: 'Upload and inspect', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Local report package', exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Import revision', exact: true })).toBeEnabled();
  expect((await query('plugins.list', { after: null, limit: 100 })).total).toBe(initialCatalog);
  for (const width of [1440, 1920, 390, 220]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => Math.abs(await frame.locator('body').evaluate(() => innerWidth) - width)).toBeLessThan(5);
    await frame.locator('body').evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect(await frame.getByRole('dialog').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`archive-inspection-${width}.png`) });
    if (width <= 390) { await frame.getByRole('button', { name: 'Import revision', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`archive-actions-${width}.png`) }); }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  let lostImport = false;
  await page.route('**/api/plugin-view', async route => {
    const body = route.request().postDataJSON()?.message?.body;
    if (!lostImport && body?.type === 'invoke' && body.capability.id === 'plugins.archive_import') {
      lostImport = true; const response = await route.fetch(), reply = await response.json(); expect(reply.ok).toBe(true);
      await route.fulfill({ response, json: { ...reply, ok: false, result: undefined, error: 'Original import acknowledgement lost' } });
    } else await route.continue();
  });
  await frame.getByRole('button', { name: 'Import revision', exact: true }).click();
  await expect(frame.locator('#import-error')).toContainText('import acknowledgement lost'); await page.unroute('**/api/plugin-view'); await page.reload();
  await frame.getByRole('button', { name: 'Inspect original request', exact: true }).click(); await expect(frame.locator('#recovery')).toBeHidden();
  expect(lostImport).toBe(true); expect((await query('plugins.list', { after: null, limit: 100 })).total).toBe(initialCatalog + 1);
  expect((await query('plugins.instances', { after: null, limit: 100 })).total).toBe(initialCount);
  expect((await query('operation.list_recent', { limit: 100 })).operations.filter((r: any) => r.capability.id === 'plugins.archive_import')).toHaveLength(1);
  await frame.getByRole('button', { name: 'Import package', exact: true }).click();
  await expect(frame.getByText('Original import succeeded. View the revision to inspect its current references.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('archive-imported-1440.png') });
  await frame.getByRole('button', { name: 'View imported revision', exact: true }).click();
  await expect(frame.getByRole('dialog')).toBeHidden();
  await expect(frame.locator('#contents').getByRole('heading', { name: 'Local report package', exact: true })).toBeVisible();
  expect((await query('views.inspect', { view: managerView.view })).state.selected).toBe(subject.revision);
  await frame.getByRole('button', { name: 'Import package', exact: true }).click();
  await frame.getByRole('button', { name: 'Inspect original import', exact: true }).click(); await expect(frame.locator('#import-notice')).toContainText('confirmed');
  await frame.getByRole('button', { name: 'Discard transfer', exact: true }).click(); await expect(frame.locator('#archive-progress')).toHaveText('No archive selected.');
  expect((await query('plugins.inspect', { revision: subject.revision })).summary.revision).toBe(subject.revision);
  await expect(note).toHaveValue('Unsaved analysis 中文 Ω'); expect((await query('views.inspect', { view: analysisView.view })).state.text).toBe('Saved analysis');
  expect(errors).toEqual([]); await analysisPage.close(); completed = true;
});
