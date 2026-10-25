// Install smoke (docs/WORKSPACE-PLAN.md W0): the assembled tarball, installed outside every
// checkout with no development overrides, starts from its own launcher, serves the home page
// to a paired Chrome tab and leaves no Host behind. No registry publish; no scientific flow.
// The pairing link stays in memory: it is a credential and is not written to the report.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { measure, failures, profiles, viewports } from './rulers.mjs';
const tarball = path.resolve(process.argv[2] ?? '');
assert.ok(tarball.endsWith('.tgz'), 'Select the assembled application tarball.');
const evidence = path.resolve(process.env.RHO_SMOKE_EVIDENCE ?? 'work/install-smoke-' + Date.now());
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rho-smoke-'));
const env = { ...process.env }; delete env.RHO_CORE_BINARY; delete env.RHO_PACKAGE_ROOT;
const report = { schemaVersion: 1, passed: false, platform: process.platform + '-' + process.arch, node: process.version, tarballSha256: createHash('sha256').update(await fs.readFile(tarball)).digest('hex'), timings: {}, memory: {}, rulers: [] };
let child, browser;
try {
  const install = path.join(root, 'installation'), projects = path.join(root, 'projects'), state = path.join(root, 'state');
  await fs.mkdir(install); await fs.mkdir(projects);
  const t = Date.now(), npm = spawnSync('npm', ['install', '--prefix', install, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, env, encoding: 'utf8' });
  assert.equal(npm.status, 0, 'npm install failed: ' + npm.stderr.slice(-2000)); report.timings.installMs = Date.now() - t;
  const pkg = path.join(install, 'node_modules/@rho-workspace/local');
  const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'vendor/composition.json'), 'utf8'));
  report.core = { located: 'vendor/rho-core', platform: manifest.platform, artifactSha256: manifest.core?.artifactSha256 };
  assert.equal(manifest.platform, report.platform);
  const started = Date.now();
  child = spawn(path.join(install, 'node_modules/.bin/rho'), ['--root', projects, '--state-dir', state], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
  const lines = []; let buffer = '';
  child.stdout.on('data', b => { buffer += b; let i; while ((i = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Launcher did not report ready: ' + stderr)), 60000);
    const look = setInterval(() => { const line = lines.find(l => l.includes('"ready"')); if (line) { clearInterval(look); clearTimeout(timer); resolve(JSON.parse(line).ready); } }, 25);
    child.once('exit', code => { clearInterval(look); clearTimeout(timer); reject(new Error('Launcher exited ' + code + ': ' + stderr)); });
  });
  report.timings.readyMs = Date.now() - started;
  assert.ok(ready.startup.core.startsWith(pkg), 'The installed launcher must use its own vendored Core');
  assert.ok(new URL(ready.url).hostname === '127.0.0.1' || new URL(ready.url).hostname === 'localhost', 'The service binds loopback only');
  browser = await chromium.launch({ executablePath: process.env.RHO_UI_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ready.openUrl);
  await page.getByRole('button', { name: /open folder/i }).first().waitFor();
  report.timings.coldStartMs = Date.now() - started;
  assert.equal(new URL(page.url()).hash, '', 'The pairing code leaves the address bar before anything renders');
  report.memory.serviceIdleRssKiB = Number(spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim());
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    const m = await measure(page, profiles.shell, {});
    // The home page has no owner view: M1 and the shell-layer budgets do not apply to it.
    const failed = failures(m).filter(f => !f.startsWith('M1 no first unit'));
    report.rulers.push({ name: 'home', width, height, failures: failed });
    await page.screenshot({ path: path.join(evidence, `home-${width}.png`) });
    for (const ruler of ['M4', 'M8', 'M9']) assert.deepEqual(failed.filter(f => f.startsWith(ruler)), [], `${ruler} home ${width}x${height}`);
  }
  assert.deepEqual(errors, []);
  await browser.close(); browser = null;
  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.once('exit', resolve)); child = null;
  assert.equal(code === 0 || code === null, true, 'Launcher shutdown failed: ' + stderr);
  const shutdown = lines.find(l => l.includes('"shutdown"')); report.shutdown = shutdown ? JSON.parse(shutdown).shutdown : 'not reported';
  const left = spawnSync('pgrep', ['-f', path.join(pkg, 'vendor/rho-core')], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'A Core process started by this installation is still running');
  report.hostsLeft = 0; report.passed = true;
} catch (error) {
  report.failure = { message: error.message }; process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {}); child?.kill('SIGKILL');
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (report.passed) await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ passed: report.passed, failure: report.failure, timings: report.timings, report: path.join(evidence, 'report.json') }) + '\n');
}
