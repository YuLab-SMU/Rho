import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildUiFixture, buildControlFixture } from '../../scripts/fixtures/plugin-ui.mjs';

let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, observed: any, childView: any, parentView: any;
let completed = false;
const windowId = 'external.test-window';
async function port(selection: string | null, method: string, params: any) {
  const reply = await fetch(new URL('/api/host', url), { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': windowId },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), test_project: selection, request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw new Error(reply.error); return reply.result;
}
async function invoke(selection: string | null, id: string, args: any) {
  const result = await port(selection, 'invoke', { capability: { id, version: 1 }, arguments: args, preconditions: [], client_request_id: crypto.randomUUID() });
  expect(result.status, JSON.stringify(result.error)).toBe('succeeded'); return result.output;
}
async function query(selection: string | null, id: string, args: any) { return (await port(selection, 'query_snapshot', { capability: { id, version: 1 }, arguments: args })).data; }

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rho-child-ui-'));
  project = join(directory, 'analysis'); await mkdir(project); project = await realpath(project);
  const database = join(directory, 'state.sqlite'), binary = resolve('../target/debug/rho');
  const ui = JSON.parse(execFileSync(binary, ['--database', database, 'plugins', 'snapshot', buildUiFixture(directory)], { encoding: 'utf8' })).result;
  const native = JSON.parse(execFileSync(binary, ['--database', database, 'plugins', 'snapshot', buildControlFixture(directory), '--target', 'aarch64-apple-darwin'], { encoding: 'utf8' })).result;
  process_ = spawn(binary, ['--database', database, '--project', project, '--plugins-only', 'workbench'], { stdio: ['ignore', 'pipe', 'pipe'] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`Test Host startup timed out: ${errors}`)), 40000);
    process_.stderr!.on('data', b => errors += b);
    process_.stdout!.on('data', b => { output += b; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    process_.once('exit', code => { clearTimeout(timer); reject(new Error(`Test Host exited ${code}: ${errors}`)); });
  }));
  const parentNative = (await invoke(null, 'plugins.activate', { revision: native.revision, artifact: native.artifacts[0], target: 'aarch64-apple-darwin', alias: 'native', configuration: {} })).instance.identity;
  const parentUi = (await invoke(null, 'plugins.activate', { revision: ui.revision, artifact: ui.artifacts[0], target: 'ui-web', alias: 'ui', configuration: {} })).instance.identity;
  const parentBinding = await query(null, 'plugins.resolve', { capability: { id: 'fixture.answer', version: 2 }, instance: parentNative });
  parentView = (await invoke(null, 'windows.open_view', { expected_layout_version: 0, group: null, view: { instance: parentUi, contribution: 'view', window: windowId, configuration: { binding: parentBinding }, state: { text: 'Current analysis draft' } } })).view;
  observed = await invoke(null, 'plugins.test_create', { name: 'Backend test · 中文 Ω', instances: {
    native: { plugin: 'example.external-control', revision: native.revision, artifact: native.artifacts[0], configuration: {}, dependencies: {} },
    ui: { plugin: 'example.external-ui', revision: ui.revision, artifact: ui.artifacts[0], configuration: {}, dependencies: {} },
  } });
  const id = observed.project.id, binding = await query(id, 'plugins.resolve', { capability: { id: 'fixture.answer', version: 2 }, instance: observed.project.instances.native });
  childView = (await invoke(id, 'windows.open_view', { expected_layout_version: 0, group: null, view: { instance: observed.project.instances.ui, contribution: 'view', window: windowId, configuration: { binding }, state: { text: 'Independent test draft' } } })).view;
  // The public connected CLI reaches this exact live child without another Host.
  const launch = join(directory, 'private-launch'); await writeFile(launch, url.href, { mode: 0o600 });
  const result = JSON.parse(execFileSync(binary, ['--connect-url-file', launch, '--project', project, '--test-project', id, 'query', '--capability', 'views.inspect', '--arguments', JSON.stringify({ view: childView.view })], { encoding: 'utf8' }));
  expect(result.observation.data.view).toBe(childView.view);
});
test.afterAll(async () => {
  if (process_?.exitCode === null) { process_.kill('SIGINT'); await new Promise<void>(done => process_.once('exit', () => done())); }
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`Test-project fixture retained at ${directory}`);
});
test('the child workspace preserves its selection, public SDK and state without changing analysis', async ({ page, context }, info) => {
  const address = new URL(url); address.searchParams.set('window', windowId);
  const parent = await context.newPage(); await parent.goto(address.href);
  const analysis = parent.frameLocator('iframe').getByLabel('View note'); await expect(analysis).toHaveValue('Current analysis draft');
  await analysis.fill('Unsaved analysis remains here 中文');
  address.searchParams.set('test-project', observed.project.id);
  const faults: string[] = []; page.on('pageerror', error => faults.push(error.message)); await page.bringToFront(); await page.goto(address.href);
  await expect(page.getByRole('note')).toContainText('Disposable test workspace · Backend test · 中文 Ω');
  const frame = page.frameLocator('iframe'), input = frame.getByLabel('View note'); await expect(input).toHaveValue('Independent test draft');
  expect(await page.locator('iframe').getAttribute('src')).toContain(`/view/plugin-test/${observed.project.id}/`);
  await frame.getByRole('button', { name: 'Answer native input', exact: true }).click();
  await expect(frame.locator('#result')).toHaveText('Answer accepted');
  await frame.getByRole('button', { name: 'Try undeclared read', exact: true }).click();
  await expect(frame.locator('#result')).toContainText('not granted');
  await input.fill('Test-only saved Ω'); await frame.getByRole('button', { name: 'Save note', exact: true }).click(); await expect(frame.locator('#result')).toHaveText('Saved');
  const layout = await query(observed.project.id, 'windows.layout', { window: windowId });
  const fresh = (await invoke(observed.project.id, 'windows.open_view', { expected_layout_version: layout.version, group: layout.layout.id,
    view: { instance: observed.project.instances.ui, contribution: 'view', window: windowId, configuration: childView.configuration, state: { text: 'Fresh view' } } })).view;
  const freshRegion = page.locator(`[data-plugin-frame="${fresh.view}"]`), freshFrame = freshRegion.frameLocator('iframe');
  await freshFrame.getByLabel('View note').fill('Ordinary close flushes this 中文');
  await expect(freshFrame.getByRole('button', { name: 'Answer native input', exact: true })).toBeVisible();
  await page.locator('.flexlayout__tab_button').nth(1).locator('[data-layout-path$="/button/close"]').click();
  await expect(freshRegion).toHaveCount(0);
  expect((await query(observed.project.id, 'views.inspect', { view: fresh.view })).state.text).toBe('Ordinary close flushes this 中文');
  await page.reload(); await expect(input).toHaveValue('Test-only saved Ω');
  expect(new URL(page.url()).searchParams.get('test-project')).toBe(observed.project.id); expect(new URL(page.url()).hash).toBe('');
  for (const width of [1440, 1920, 390, 220]) {
    await page.setViewportSize({ width, height: 900 }); await input.click(); await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`test-workspace-${width}.png`) });
  }
  const standalone = new URL(address); standalone.searchParams.set('plugin-view', childView.view);
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto(standalone.href);
  await expect(page.getByRole('note')).toContainText('Disposable test workspace');
  await expect(page.frameLocator('iframe').getByLabel('View note')).toHaveValue('Test-only saved Ω');
  await page.screenshot({ path: info.outputPath('test-standalone-390.png') });
  await page.goto(address.href); await expect(input).toHaveValue('Test-only saved Ω');
  await input.fill('Closed test retains this 中文');
  await page.locator('.flexlayout__tab_button [data-layout-path$="/button/close"]').click();
  // Old documents are not assumed to have flushed merely because a browser
  // refreshed. Their retained registrations require explicit saved-state recovery.
  await expect(page.getByRole('button', { name: 'Close with saved state…', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Close with saved state…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Saved version:');
  await page.screenshot({ path: info.outputPath('test-workspace-close-recovery-390.png') });
  await page.getByRole('button', { name: 'Keep saved state and close', exact: true }).click();
  await expect(page.getByText('No views are open in this window.')).toBeVisible();
  expect((await query(observed.project.id, 'views.inspect', { view: childView.view })).state.text).toBe('Closed test retains this 中文');
  await expect(analysis).toHaveValue('Unsaved analysis remains here 中文');
  expect((await query(null, 'views.inspect', { view: parentView.view })).state.text).toBe('Current analysis draft');
  const stopped = await invoke(null, 'plugins.test_stop', { id: observed.project.id, expected_version: observed.project.version });
  expect(stopped.project.state).toBe('stopped');
  await page.reload(); await expect(page.getByRole('alert')).toContainText('unavailable');
  await expect(page.locator('iframe')).toHaveCount(0); await expect(analysis).toHaveValue('Unsaved analysis remains here 中文');
  await page.screenshot({ path: info.outputPath('test-workspace-stopped.png') });
  await parent.close(); expect(faults).toEqual([]); completed = true;
});
