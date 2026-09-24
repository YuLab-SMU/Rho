import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-files-plugin-acceptance-')));
const source = process.env.RHO_FILES_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_FILES_PLUGIN_PACKAGE) : path.join(directory, 'package');
assert.ok(source !== root && !source.startsWith(root + path.sep), 'Use an independently built package outside the checkout');
const env = { ...process.env, CARGO_BUILD_JOBS: '1' };
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  // Compile the Host harness first. The independently built artifact must work
  // with these unchanged Host bytes; no private Files backend dependency exists.
  const output = execFileSync('cargo', ['test', '-p', 'rho-host', '--test', 'files_plugin', '--locked', '--no-run', '--message-format=json'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
  const executable = output.trim().split('\n').map(line => JSON.parse(line)).find(item => item.reason === 'compiler-artifact' && item.target.name === 'files_plugin' && item.executable)?.executable;
  assert.ok(executable, 'Cargo did not identify the Files Host harness');
  const original = digest(executable);
  if (!process.env.RHO_FILES_PLUGIN_PACKAGE) execFileSync(process.execPath, [path.join(root, 'scripts/build-files-plugin.mjs'), source], { cwd: root, env, stdio: 'inherit' });
  assert.equal(digest(executable), original, 'Building an external Files plugin changed the compiled Host');
  execFileSync('python3', [path.join(source, 'tests/protocol.py'), path.join(source, 'dist/rho-files-backend')], { cwd: source, env, stdio: 'inherit' });
  execFileSync(executable, ['--ignored', '--nocapture'], { cwd: root, env: { ...env, RHO_FILES_PLUGIN_PACKAGE: source }, stdio: 'inherit' });
  assert.equal(digest(executable), original);
  console.log(`Independent Files package passed public wire, real Host, revision coexistence, journal recovery and retained replay acceptance. Host harness SHA256 ${original}`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
