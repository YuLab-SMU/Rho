#!/usr/bin/env node
// Exercise the platform resolver and service descriptor contract without pretending that one
// operating system proves native service registration on the other two.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(repo, 'dist', 'cli.js');
const output = path.resolve(process.env.RHO_FOUNDATION_MATRIX ?? path.join(repo, 'work', 'foundation-episode', 'platform-matrix.json'));

async function command(args, cwd, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: 1, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rho-foundation-matrix-'));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), fixture: root, platforms: [] };
try {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const base = path.join(root, platform), home = path.join(base, 'home');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RHO_HOME: home,
      RHO_PLATFORM: platform,
      TMPDIR: path.join(base, 'tmp'),
      APPDATA: path.join(base, 'appdata'),
      LOCALAPPDATA: path.join(base, 'localappdata'),
      XDG_CONFIG_HOME: path.join(base, 'xdg-config'),
      XDG_STATE_HOME: path.join(base, 'xdg-state'),
      XDG_DATA_HOME: path.join(base, 'xdg-data'),
      XDG_CACHE_HOME: path.join(base, 'xdg-cache'),
      XDG_RUNTIME_DIR: path.join(base, 'xdg-runtime'),
      RHO_SERVICE_NO_APPLY: '1',
    };
    const pathsResult = await command(['paths'], root, env);
    assert.equal(pathsResult.code, 0, `${platform}: ${pathsResult.stderr}`);
    const paths = JSON.parse(pathsResult.stdout);
    const installResult = await command(['install', '--json'], root, env);
    assert.equal(installResult.code, 0, `${platform}: ${installResult.stderr}`);
    const serviceResult = await command(['service', 'install', 'matrix'], root, env);
    assert.equal(serviceResult.code, 0, `${platform}: ${serviceResult.stderr}`);
    const service = JSON.parse(serviceResult.stdout).service;
    const expectedSuffix = platform === 'darwin' ? '.plist.json' : platform === 'win32' ? '.task.json' : '.service.json';
    assert.ok(service.file.endsWith(expectedSuffix), `${platform}: unexpected service descriptor ${service.file}`);
    assert.equal(await fs.access(service.descriptor).then(() => true, () => false), true, `${platform}: native descriptor was not written`);
    assert.ok((await fs.readFile(service.descriptor, 'utf8')).includes(platform === 'linux' ? '[Service]' : platform === 'darwin' ? '<plist' : '<Task'), `${platform}: native descriptor has unexpected content`);
    if (platform === 'darwin') assert.equal(paths.paths.config.path, path.join(base, 'home', 'Library', 'Application Support', 'Rho'));
    if (platform === 'linux') {
      assert.equal(paths.paths.config.path, path.join(base, 'xdg-config', 'rho'));
      assert.equal(paths.paths.state.path, path.join(base, 'xdg-state', 'rho'));
      assert.equal(paths.paths.runtime.path, path.join(base, 'xdg-runtime', 'rho'));
    }
    if (platform === 'win32') {
      assert.equal(paths.paths.config.path, path.join(base, 'appdata', 'Rho'));
      assert.equal(paths.paths.state.path, path.join(base, 'localappdata', 'Rho', 'state'));
    }
    report.platforms.push({ platform, paths: paths.paths, service: { file: service.file, platform: service.platform } });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, report: output, fixture: root, ...(report.failure ? { failure: report.failure } : {}) }) + '\n');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
