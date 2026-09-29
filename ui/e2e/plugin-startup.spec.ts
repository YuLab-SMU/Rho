import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let directory: string, project: string, host: ReturnType<typeof spawn>, url: URL, completed = false;
test.beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'rho-default-startup-'))); project = join(directory, '项目'); mkdirSync(project);
  host = spawn(resolve('../target/debug/rho'), ['--database', join(directory, 'state.sqlite'), 'workbench'], { stdio: ['ignore', 'pipe', 'pipe'] });
  url = new URL(await new Promise<string>((done, reject) => {
    let output = '', errors = ''; const timer = setTimeout(() => reject(Error(`Default Host launch timed out: ${errors}`)), 60000);
    host.stderr!.on('data', bytes => errors += bytes);
    host.stdout!.on('data', bytes => { output += bytes; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?plugin-window#token=[a-z0-9]+/); if (found) { clearTimeout(timer); done(found[0]); } });
    host.once('exit', code => { clearTimeout(timer); reject(Error(`Default Host exited ${code}: ${errors}`)); });
  }));
});
test.afterAll(async () => {
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill('SIGINT'); await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { host.kill('SIGKILL'); reject(Error('Disposable default Host did not confirm shutdown')); }, 60000);
      host.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
  if (completed) rmSync(directory, { recursive: true, force: true });
  else console.error(`Default startup fixture retained at ${directory}`);
});
test('default entry selects a project and keeps absent packages absent across reload', async ({ page }, info) => {
  await page.goto(url.href);
  for (const width of [1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Open Project', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`project-startup-${width}.png`) });
  }
  await page.getByLabel('Absolute Project Path', { exact: true }).fill('relative/project');
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('absolute local project');
  await page.getByLabel('Absolute Project Path', { exact: true }).fill(project);
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  await expect(page.getByText(/No standalone workspace views are installed/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('missing-workspace.png') });
  await page.reload(); await expect(page.getByText(/No standalone workspace views are installed/)).toBeVisible();
  const bare = new URL(page.url()); bare.searchParams.delete('plugin-window');
  await page.goto(bare.href); await expect(page.getByText(/No standalone workspace views are installed/)).toBeVisible();
  const state = await fetch(new URL('/api/info', url), { headers: { Authorization: `Bearer ${url.hash.slice(7)}` } }).then(response => response.json());
  expect(state.runtime).toBe('plugins'); expect(state.project_root).toBe(project);
  expect(state.capabilities.some((entry: any) => ['workspace.run_r', 'runtime.instances'].includes(entry.capability.id))).toBe(false);
  const catalog = await fetch(new URL('/api/host', url), { method: 'POST', headers: { Authorization: `Bearer ${url.hash.slice(7)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_root: project, frame: { id: 'inventory', request: { method: 'query_snapshot', params: { capability: { id: 'plugins.list', version: 1 }, arguments: { after: null, limit: 100 } } } } }) }).then(response => response.json());
  expect(catalog.result.data.total).toBe(0); completed = true;
});
