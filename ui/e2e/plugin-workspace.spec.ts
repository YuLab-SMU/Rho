import { test, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildUiFixture, buildControlFixture } from "../../scripts/fixtures/plugin-ui.mjs";

let directory: string, project: string, url: URL, process_: ReturnType<typeof spawn>, view: any, instance: any;
let completed = false;
const windowId = "external.composed-window";
async function port(method: string, params: any) {
  const reply = await fetch(new URL("/api/host", url), { method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(7)}`, "Content-Type": "application/json", "X-Rho-Studio-Window": windowId },
    body: JSON.stringify({ project_root: project, frame: { id: crypto.randomUUID(), request: { method, params } } }) }).then(r => r.json());
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
async function invoke(id: string, args: any) {
  const result = await port("invoke", { capability: { id, version: 1 }, arguments: args, preconditions: [], client_request_id: crypto.randomUUID() });
  expect(result.status, JSON.stringify(result.error)).toBe("succeeded"); return result.output;
}
async function query(id: string, args: any) { return (await port("query_snapshot", { capability: { id, version: 1 }, arguments: args })).data; }

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rho-external-ui-"));
  project = join(directory, "project"); await mkdir(project); project = await realpath(project);
  const plugin = buildUiFixture(directory), database = join(directory, "state.sqlite");
  const installed = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", plugin], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" })).result;
  const native = JSON.parse(execFileSync(resolve("../target/debug/rho"), ["--database", database, "plugins", "snapshot", buildControlFixture(directory), "--target", "aarch64-apple-darwin"], { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL" })).result;
  process_ = spawn(resolve("../target/debug/rho"), ["--database", database, "--project", project, "--plugins-only", "workbench"], { stdio: ["ignore", "pipe", "pipe"] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = "", errors = "";
    const timer = setTimeout(() => reject(new Error(`Fixture Host startup timed out: ${errors}`)), 40000);
    process_.stderr!.on("data", b => errors += b);
    process_.stdout!.on("data", b => { output += b; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    process_.once("exit", code => { clearTimeout(timer); reject(new Error(`Fixture Host exited ${code}: ${errors}`)); });
  }));
  expect(url.searchParams.has('plugin-window')).toBe(true);
  const info = await fetch(new URL('/api/info', url), { headers: { Authorization: `Bearer ${url.hash.slice(7)}` } }).then(r => r.json());
  expect(info.runtime).toBe('plugins');
  expect(info.capabilities.some((entry: any) => entry.capability.id === 'workspace.run_r' || entry.capability.id === 'runtime.instances')).toBe(false);
  expect((await query('plugins.instances', { after: null, limit: 100 })).total).toBe(0);
  const nativeInstance = (await invoke("plugins.activate", { revision: native.revision, artifact: native.artifacts[0], target: "aarch64-apple-darwin", alias: "native", configuration: {} })).instance;
  instance = (await invoke("plugins.activate", { revision: installed.revision, artifact: installed.artifacts[0], target: "ui-web", alias: "external", configuration: {} })).instance;
  const binding = await query("plugins.resolve", { capability: { id: "fixture.answer", version: 2 }, instance: nativeInstance.identity });
  view = (await invoke("windows.open_view", { expected_layout_version: 0, group: null, view: { instance: instance.identity, contribution: "view", window: windowId, configuration: { binding, external_url: "https://rho-external.invalid/document?read=1#topic" }, state: { text: "Initial Ω" } } })).view;
});
test.afterAll(async () => {
  if (process_?.exitCode === null) {
    process_.kill("SIGINT"); await new Promise<void>(done => process_.once("exit", () => done()));
  }
  if (directory && completed) await rm(directory, { recursive: true, force: true });
  else if (directory) console.error(`External UI fixture retained at ${directory}`);
});
test('the generic window composes live plugin views, captures closure and retries a lost original acknowledgement', async ({ page }, info) => {
  const address = new URL(url); address.searchParams.set('window', windowId); address.searchParams.set('plugin-window', '');
  const faults: string[] = []; page.on('pageerror', error => faults.push(error.message)); await page.goto(address.href);
  const region = (id: string) => page.locator(`[data-plugin-frame="${id}"]`);
  const original = region(view.view).frameLocator('iframe'), input = original.getByLabel('View note');
  await expect(input).toHaveValue('Initial Ω');
  await input.fill('Still live — 未保存 Ω');
  const lifetime = await input.evaluate(() => { (window as any).fixtureLifetime = crypto.randomUUID(); return (window as any).fixtureLifetime; });
  const firstLayout = await query('windows.layout', { window: windowId });
  const opened = await invoke('windows.open_view', { expected_layout_version: firstLayout.version, group: firstLayout.layout.id,
    view: { instance: instance.identity, contribution: 'view', window: windowId, configuration: view.configuration, state: { text: 'Second view' } } });
  const second = opened.view, secondFrame = region(second.view).frameLocator('iframe');
  await expect(secondFrame.getByLabel('View note')).toHaveValue('Second view'); await expect(input).toBeHidden();
  const tabs = page.getByRole('tab', { name: 'Independent View', exact: true }); await expect(tabs).toHaveCount(2);
  await tabs.nth(0).click(); await expect(input).toHaveValue('Still live — 未保存 Ω');
  expect(await input.evaluate(() => (window as any).fixtureLifetime)).toBe(lifetime);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 }); await input.click(); await expect(input).toBeFocused();
    expect(await input.evaluate(() => (window as any).fixtureLifetime)).toBe(lifetime);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`plugin-workspace-${width}.png`) });
  }
  // A genuine SDK composition guard refuses the close and keeps the original
  // document. The shell cannot remove it merely because the close button fired.
  await input.dispatchEvent('compositionstart');
  await tabs.nth(0).locator('[data-layout-path$="/button/close"]').click();
  await expect(page.getByRole('button', { name: 'Try closing again', exact: true })).toBeVisible();
  expect((await query('views.inspect', { view: view.view })).closed).toBe(false);
  await expect(input).toHaveValue('Still live — 未保存 Ω');
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Try closing again', exact: true }).click();
  await expect(region(view.view)).toHaveCount(0);
  expect((await query('views.inspect', { view: view.view })).state.text).toBe('Still live — 未保存 Ω');
  await expect(secondFrame.getByLabel('View note')).toBeVisible();
  await secondFrame.getByLabel('View note').fill('Original close captures this draft 中文');
  let originalRequest = '', intercepted = false;
  await page.route('**/api/host', async route => {
    const payload = route.request().postDataJSON()?.frame?.request;
    if (!intercepted && payload?.method === 'invoke' && payload.params.capability.id === 'views.close') {
      intercepted = true; originalRequest = payload.params.client_request_id;
      await route.fetch(); await route.abort('failed');
    } else await route.continue();
  });
  await tabs.nth(0).locator('[data-layout-path$="/button/close"]').click();
  await expect(page.getByRole('button', { name: 'Retry original close', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry original close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry original close', exact: true })).toHaveCount(0);
  await expect(region(second.view)).toHaveCount(0); await expect(page.getByText('No views are open in this window.')).toBeVisible();
  const records = (await query('operation.list_recent', { limit: 100 })).operations;
  const closes = records.filter((record: any) => record.capability.id === 'views.close');
  expect(closes).toHaveLength(3);
  expect(closes.filter((record: any) => record.client_request_id === originalRequest)).toHaveLength(1);
  expect((await query('views.inspect', { view: second.view })).state.text).toBe('Original close captures this draft 中文');
  expect((await query('plugins.instance', { instance: instance.identity })).instance.state).toBe('active');
  // Saved-state recovery is an explicit choice after a confirmed flush refusal.
  // Cancelling this dialog leaves the unsaved document untouched.
  const empty = await query('windows.layout', { window: windowId });
  const recover = (await invoke('windows.open_view', { expected_layout_version: empty.version,
    group: empty.layout.kind === 'tabs' ? empty.layout.id : null,
    view: { instance: instance.identity, contribution: 'view', window: windowId, configuration: view.configuration, state: { text: 'Acknowledged recovery choice' } } })).view;
  const recoverInput = region(recover.view).frameLocator('iframe').getByLabel('View note');
  await recoverInput.fill('Unsaved state to discard explicitly'); await recoverInput.dispatchEvent('compositionstart');
  await tabs.nth(0).locator('[data-layout-path$="/button/close"]').click();
  await page.getByRole('button', { name: 'Close with saved state…', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Saved version: 0');
  await page.getByRole('button', { name: 'Keep view open', exact: true }).click();
  await expect(recoverInput).toHaveValue('Unsaved state to discard explicitly');
  expect((await query('views.inspect', { view: recover.view })).closed).toBe(false);
  await page.getByRole('button', { name: 'Close with saved state…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Saved version: 0');
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath('plugin-workspace-saved-recovery-390.png') });
  await page.getByRole('button', { name: 'Keep saved state and close', exact: true }).click();
  await expect(region(recover.view)).toHaveCount(0);
  const recovered = await query('views.inspect', { view: recover.view });
  expect(recovered.closed).toBe(true); expect(recovered.state.text).toBe('Acknowledged recovery choice');
  // A document that never registered cooperation is explicitly rejected before
  // admission. Its correlated diagnostic also permits saved-state recovery;
  // a network failure above still requires retry of the original request.
  const finalLayout = await query('windows.layout', { window: windowId });
  const unavailable = (await invoke('windows.open_view', { expected_layout_version: finalLayout.version,
    group: finalLayout.layout.kind === 'tabs' ? finalLayout.layout.id : null,
    view: { instance: instance.identity, contribution: 'view', window: windowId,
      configuration: { ...view.configuration, cooperative_close: false }, state: { text: 'Saved without a handler' } } })).view;
  const unavailableInput = region(unavailable.view).frameLocator('iframe').getByLabel('View note');
  await unavailableInput.fill('Never acknowledged');
  const beforeRejection = await query('operation.list_recent', { limit: 100 });
  await tabs.nth(0).locator('[data-layout-path$="/button/close"]').click();
  await expect(page.getByRole('button', { name: 'Close with saved state…', exact: true })).toBeVisible();
  expect(await query('operation.list_recent', { limit: 100 })).toEqual(beforeRejection);
  expect((await query('views.inspect', { view: unavailable.view })).closed).toBe(false);
  await page.getByRole('button', { name: 'Close with saved state…', exact: true }).click();
  await page.getByRole('button', { name: 'Keep saved state and close', exact: true }).click();
  await expect(region(unavailable.view)).toHaveCount(0);
  expect((await query('views.inspect', { view: unavailable.view })).state.text).toBe('Saved without a handler');
  expect(faults).toEqual([]); await invoke('plugins.release', { instance: instance.identity }); completed = true;
});
