/** One generic Host and ordinary plugin Manager compose the scientific window. */
import { test, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scientificContinuity } from './fixtures/scientific-continuity';
import { installPluginSet } from '../../scripts/plugin-set.mjs';
import { buildManagerPlugin } from '../../scripts/build-manager-plugin.mjs';
import { buildConsolePlugin } from '../../scripts/build-console-plugin.mjs';
import { buildObjectsPlugin } from '../../scripts/build-objects-plugin.mjs';
import { buildPlotsPlugin } from '../../scripts/build-plots-plugin.mjs';
import { buildViewerPlugin } from '../../scripts/build-viewer-plugin.mjs';
import { buildPackagesPlugin } from '../../scripts/build-packages-plugin.mjs';
import { buildHelpPlugin } from '../../scripts/build-help-plugin.mjs';
let directory: string, project: string, url: URL, host: ReturnType<typeof spawn>, managerView: any, completed = false;
const windowId = 'scientific-workspace', filename = '分析.R';
async function port(method: string, params: unknown) {
  const reply = await fetch(new URL('/api/host', url), { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json', 'X-Rho-Studio-Window': windowId },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(response => response.json());
  if (!reply.ok) throw Error(reply.error); return reply.result;
}
async function query(id: string, args: unknown) { return (await port('query_snapshot', { capability: { id, version: 1 }, arguments: args })).data; }
test.beforeAll(async () => {
  test.setTimeout(180000);
  expect(process.env.RHO_SCIENTIFIC_PACKAGES || process.env.RHO_SCIENTIFIC_PLUGIN_SET).toBeTruthy(); expect(process.env.RHO_ARK).toBeTruthy(); expect(process.env.RHO_R_HOME).toBeTruthy();
  const native = process.env.RHO_SCIENTIFIC_PACKAGES ? JSON.parse(readFileSync(process.env.RHO_SCIENTIFIC_PACKAGES, 'utf8')) : {};
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'rho-scientific-window-'))); project = join(directory, 'project'); mkdirSync(project);
  writeFileSync(join(project, filename), 'answer <- 1L\n'); execFileSync('git', ['init', '-q', project]);
  const binary = resolve('../target/debug/rho'), database = join(directory, 'state.sqlite');
  const snapshot = (path: string, target: string) => JSON.parse(execFileSync(binary, ['--database', database, 'plugins', 'snapshot', path, '--target', target], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' })).result;
  if (process.env.RHO_SCIENTIFIC_PLUGIN_SET) {
    const delivery = JSON.parse(readFileSync(join(process.env.RHO_SCIENTIFIC_PLUGIN_SET, 'plugin-set.json'), 'utf8'));
    expect(delivery.profile).toBe('rho-default');
    expect(installPluginSet({rho: binary, directory: process.env.RHO_SCIENTIFIC_PLUGIN_SET, database}).imported).toHaveLength(16);
  } else {
    for (const key of ['r', 'files', 'editor']) snapshot(native[key], 'aarch64-apple-darwin');
    for (const key of ['process', 'remote', 'environment', 'annotations', 'agent']) if (native[key]) snapshot(native[key], 'aarch64-apple-darwin');
    if (native.studio) snapshot(native.studio, 'ui-web');
    for (const [key, build] of Object.entries({ console: buildConsolePlugin, objects: buildObjectsPlugin, plots: buildPlotsPlugin, viewer: buildViewerPlugin, packages: buildPackagesPlugin, help: buildHelpPlugin })) snapshot(native[key] ?? build(join(directory, key)), 'ui-web');
    snapshot(buildManagerPlugin(join(directory, 'manager')), 'ui-web');
  }
  const assets = process.env.RHO_WORKBENCH_DEV_ASSETS;
  host = spawn(binary, ['--database', database, 'workbench', ...(assets ? ['--dev-assets', realpathSync(assets)] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = '', errors = ''; const timer = setTimeout(() => reject(Error(`Generic Host startup deadline: ${errors}`)), 60000);
    host.stderr!.on('data', bytes => errors += bytes); host.stdout!.on('data', bytes => {
      output += bytes; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/);
      if (found) { clearTimeout(timer); done(found[0]); }
    }); host.once('exit', code => { clearTimeout(timer); reject(Error(`Generic Host exited ${code}: ${errors}`)); });
  }));
});
test.afterAll(async () => {
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill('SIGINT');
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { host.kill('SIGKILL'); reject(Error('Disposable scientific Host did not confirm shutdown')); }, 60000);
      host.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
  if (directory && completed) rmSync(directory, { recursive: true, force: true });
  else if (directory) console.error(`Scientific workspace acceptance retained at ${directory}`);
});
test('Manager prepares the ordinary scientific scene; Files opens a runnable Editor and original R results reach Objects and Plots', async ({ page }, info) => {
  test.setTimeout(240000);
  const address = new URL(url); address.searchParams.set('window', windowId); await page.goto(address.href);
  await page.getByLabel('Absolute Project Path', { exact: true }).fill(project);
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  const selector = page.getByLabel('Installed workspace view', { exact: true });
  const choice = selector.locator('option').filter({ hasText: /^Plugins ·/ });
  await expect(choice).toHaveCount(1); await selector.selectOption((await choice.getAttribute('value'))!);
  await page.screenshot({ path: info.outputPath('scientific-launcher.png') });
  let lost = false, lostWorkspace = false, workspaceReplyLost = false;
  const full = !!process.env.RHO_SCIENTIFIC_PLUGIN_SET;
  await page.route('**/api/host', async route => {
    const request = route.request().postDataJSON()?.frame?.request;
    if (!lost && request?.method === 'invoke' && request.params.capability.id === 'plugins.activate') {
      lost = true; await route.fetch(); await route.abort(); return;
    }
    await route.continue();
  });
  if (full) await page.route('**/api/plugin-view', async route => {
    const body = route.request().postDataJSON()?.message?.body;
    if (!lostWorkspace && body?.type === 'invoke' && body.capability.id === 'plugins.activate' && body.arguments.alias === 'r') {
      lostWorkspace = true; await route.fetch(); await route.abort(); workspaceReplyLost = true; return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Open view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect original request', exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Inspect original request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue opening view', exact: true })).toBeEnabled();
  expect((await query('plugins.instances', { after: null, limit: 100 })).total).toBe(1);
  expect((await query('windows.layout', { window: windowId })).layout.kind).toBe('empty');
  await page.getByRole('button', { name: 'Continue opening view', exact: true }).click();
  await expect.poll(async () => {
    const layout = (await query('windows.layout', { window: windowId })).layout;
    if (layout.kind !== 'tabs' || layout.views.length !== 1) return null;
    managerView = await query('views.inspect', { view: layout.views[0] }); return managerView.contribution;
  }).toBe('manager');
  const frame = (id: string) => page.locator(`[data-plugin-frame="${id}"]`).frameLocator('iframe');
  const manager = frame(managerView.view);
  await manager.getByRole('button', { name: 'Scenarios', exact: true }).click();
  await manager.getByRole('button', { name: 'New R workspace', exact: true }).click();
  const dialog = manager.getByRole('dialog', { name: 'New R workspace', exact: true });
  await dialog.getByLabel('Existing Ark executable', { exact: true }).fill(realpathSync(process.env.RHO_ARK!));
  await dialog.getByLabel('Existing R home', { exact: true }).fill(realpathSync(process.env.RHO_R_HOME!));
  await page.screenshot({ path: info.outputPath('scientific-setup.png') });
  if (full) {
    for (const width of [1920, 390]) {
      await page.setViewportSize({width,height:900});
      await dialog.getByRole('button',{name:'Prepare workspace',exact:true}).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole('button',{name:'Prepare workspace',exact:true})).toBeVisible();
      await page.screenshot({path:info.outputPath(`default-setup-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:900});
  }
  await dialog.getByRole('button', { name: 'Prepare workspace', exact: true }).click();
  if (full) {
    // A transport loss fences the old iframe. Reload reconnects its retained
    // view; expecting controls on the retired document would hide that boundary.
    await expect.poll(() => workspaceReplyLost, {timeout:60000}).toBe(true);
    await expect.poll(async () => (await query('plugins.instances', {after:null,limit:100})).total).toBe(2);
    await page.reload();
    await manager.getByRole('button', {name:'Inspect original request',exact:true}).click();
    await expect(manager.locator('#notice')).not.toHaveText('Working…');
    await expect.poll(async () => (await query('plugins.instances', {after:null,limit:100})).total).toBe(2);
    await manager.getByRole('button', {name:'Continue R workspace preparation',exact:true}).click();
    await expect(manager.locator('#notice')).not.toHaveText('Working…', {timeout:90000});
  }
  await expect(manager.locator('#notice')).not.toHaveText('Working…', {timeout:90000});
  await expect(manager.locator('#error')).toBeHidden();
  await expect(manager.getByRole('button', { name: 'Switch to R workspace', exact: true })).toBeEnabled();
  expect((await query('windows.scenario', { window: windowId })).scenario).toBeNull();
  const prepared = await query('views.inspect', { view: managerView.view }), mapping = prepared.state.preparation.request;
  if (full) {
    expect(Object.keys(mapping.instances)).toHaveLength(16);
    expect(Object.keys(mapping.views)).toHaveLength(11);
    const agent = await query('views.inspect', {view: mapping.views.agent});
    expect(agent.configuration.tools).toHaveLength(14);
    for (const tool of agent.configuration.tools) {
      expect(tool.target.binding.provider).toEqual(mapping.instances[tool.target.binding.provider.plugin.slice(8)]);
      expect(tool.target.binding.project).toBe(agent.project);
    }
  }
  const source = mapping.instances.r;
  const session = async () => query('r.session', { binding: await query('plugins.resolve', { instance: source, capability: { id: 'r.session', version: 1 } }), arguments: {} });
  expect((await session()).state).toBe('unstarted');
  await manager.getByRole('button', { name: 'Switch to R workspace', exact: true }).click();
  await expect.poll(async () => (await query('windows.scenario', { window: windowId })).scenario?.revision).toBe(mapping.revision);
  const consoleView = frame(mapping.views.console), filesView = frame(mapping.views.files), objectsView = frame(mapping.views.objects);
  await page.getByRole('tab', { name: 'Help', exact: true }).click();
  await expect(frame(mapping.views.help).getByText('Choose a package in Packages to browse its help.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(consoleView.getByRole('button', { name: 'Start R', exact: true })).toBeVisible();
  await consoleView.getByRole('button', { name: 'Start R', exact: true }).click();
  await expect.poll(async () => (await session()).state, { timeout: 60000 }).toBe('idle');
  const nativeSession = (await session()).session_id;
  await filesView.getByRole('button', { name: 'Open…', exact: true }).click();
  await filesView.getByLabel('Path within this project', { exact: true }).fill(filename);
  await filesView.getByRole('dialog').getByRole('button', { name: 'Open', exact: true }).click();
  let editorView: any;
  await expect.poll(async () => {
    const layout = (await query('windows.layout', { window: windowId })).layout;
    const documentGroup = layout.children[0].children[0];
    editorView = await query('views.inspect', { view: documentGroup.selected });
    return editorView.configuration.file?.path;
  }).toBe(filename);
  expect(editorView.configuration.runtime).toEqual(source);
  const editor = frame(editorView.view), code = editor.getByRole('textbox', { name: 'Code Editor', exact: true });
  await code.click(); await code.press('Meta+a');
  await page.keyboard.insertText('answer <- 42L\npoints <- data.frame(x = 1:4, y = c(1, 4, 2, 5))\nplot(points, col = "#2863d6", pch = 19)\ncat("scene-original-result\\n")\n');
  await editor.getByRole('button', { name: 'Save and Run', exact: true }).click();
  const executions = async () => (await query('operation.list_recent', { limit: 100 })).operations.filter((record: any) => record.capability.id === 'r.execute');
  await expect.poll(async () => (await executions()).length).toBe(1);
  const id = (await executions())[0].operation_id;
  await expect.poll(async () => (await query('operation.get', { operation_id: id })).record.status, { timeout: 60000 }).toBe('succeeded');
  const record = (await query('operation.get', { operation_id: id })).record;
  expect(record.operation.normalized_arguments.binding.provider).toEqual(source);
  expect(record.operation.normalized_arguments.arguments.expected_session).toBe(nativeSession);
  expect(record.output.outputs.some((output: any) => output.reference.media_type === 'image/png')).toBe(true);
  expect(readFileSync(join(project, filename), 'utf8')).toContain('answer <- 42L');
  await expect(consoleView.locator('body')).toContainText('scene-original-result');
  const answer = objectsView.locator('.object-entry').filter({ has: objectsView.locator('.object-name code').getByText('answer', { exact: true }) });
  await expect(answer.locator('.directory-content:visible, .directory-compact-summary:visible').getByText('42', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('scientific-objects.png') });
  await page.getByRole('tab', { name: 'Plots', exact: true }).click();
  const plots = frame(mapping.views.plots);
  await expect.poll(async () => plots.locator('img').evaluateAll(images => images.some(image => image.complete && image.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: info.outputPath('scientific-plots.png') });
  await page.reload(); await expect(editor.getByRole('textbox', { name: 'Code Editor', exact: true })).toContainText('answer <- 42L');
  expect(await executions()).toHaveLength(1); expect((await session()).session_id).toBe(nativeSession);
  if (full) {
    await page.getByRole('tab', {name:'Agent', exact:true}).click();
    const agent = frame(mapping.views.agent);
    await expect(agent.getByRole('button', {name:'New task',exact:true})).toBeVisible();
    await agent.getByRole('button', {name:'Tools',exact:true}).click();
    await expect(agent.locator('#tools-menu input[type=checkbox]')).toHaveCount(14);
    expect(await agent.locator('#tools-menu input:checked').count()).toBe(0);
    await page.screenshot({path:info.outputPath('default-agent-tools.png')});
    await agent.locator('#tools-menu input[type=checkbox]').last().scrollIntoViewIfNeeded();
    await page.keyboard.press('Escape');
    await expect(agent.locator('#tools-menu')).toBeHidden();
    await page.getByRole('tab', {name:'Plugin Studio',exact:true}).click();
    await expect(frame(mapping.views.studio).getByRole('heading', {name:'Plugin Studio',exact:true})).toBeVisible();
    await expect(frame(mapping.views.studio).getByRole('button', {name:'Choose revision',exact:true})).toBeEnabled();
    expect((await query('plugins.instances',{after:null,limit:100})).total).toBe(16);
    expect(await executions()).toHaveLength(1);
    await page.screenshot({path:info.outputPath('default-studio.png')});
  }
  const continuity = full ? await scientificContinuity({page, info, query, port, mapping, editorView, project, windowId, nativeSession}) : null;
  if (process.env.RHO_SCIENTIFIC_EVIDENCE) writeFileSync(process.env.RHO_SCIENTIFIC_EVIDENCE, JSON.stringify({completed:true,full_delivery:full,
    set:process.env.RHO_SCIENTIFIC_PLUGIN_SET ?? null,instances:mapping.instances,views:mapping.views,scenario:mapping.revision,
    original_execution:id,native_session:nativeSession,agent_tools_offered_unchecked:full,studio_opened:full,continuity,
    screenshots:info.outputDir,limits:['No new model/tool execution or native service operation acceptance; no user installation or Host restart.']},null,2)+'\n');
  completed = true;
});
