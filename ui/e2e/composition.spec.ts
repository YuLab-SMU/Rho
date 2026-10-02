import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {coreArtifact, root} from '../../scripts/components.mjs';

test('external application assets select the application-owned example on an empty core', async ({page}) => {
  const core = coreArtifact();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-app-browser-'));
  const demo = path.join(directory, 'demo');
  fs.cpSync(path.join(root, 'examples/rho-demo'), demo, {recursive: true});
  let host: ChildProcess | undefined;
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  try {
    host = spawn(core.absolute, ['--database', path.join(directory, 'catalog.sqlite'), 'workbench',
      '--assets', path.join(root, 'target/app-assets'), '--default-project', demo], {stdio: ['ignore', 'pipe', 'pipe']});
    const lines = createInterface({input: host.stdout!});
    const [url] = await once(lines, 'line');
    await page.goto(url);
    await expect(page.getByRole('heading', {name: 'Your scientific workspace'})).toBeVisible();
    await page.getByRole('button', {name: 'Open Rho Demo', exact: true}).click();
    await expect(page.getByRole('main', {name: 'Plugin workspace'})).toBeVisible();
    await expect(page.getByText('No views are open in this window.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('main', {name: 'Plugin workspace'})).toBeVisible();
    expect(failures).toEqual([]);
    await page.screenshot({path: path.join(root, 'target/composition-browser.png'), fullPage: true});
  } finally {
    if (host && host.exitCode === null && host.signalCode === null) {
      const ended = once(host, 'exit'); host.kill('SIGINT');
      await ended;
    }
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
