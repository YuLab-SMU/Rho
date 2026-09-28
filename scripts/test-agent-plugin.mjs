// Compile the generic Host harness first, then build the external package without
// changing those Host bytes. Both use disposable project and instance storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildAgentPlugin} from './build-agent-plugin.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-native-')));
const env = {...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2'};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  const output = execFileSync('cargo', ['test', '-p', 'rho-host', '--test', 'agent_plugin', '--locked', '--offline', '--no-run', '--message-format=json'], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024,
  });
  const executable = output.trim().split('\n').map(line => JSON.parse(line)).find(item => item.reason === 'compiler-artifact' && item.target.name === 'agent_plugin' && item.executable)?.executable;
  assert.ok(executable, 'Cargo did not identify the generic Host harness');
  const original = digest(executable);
  const source = process.env.RHO_AGENT_PLUGIN_PACKAGE ? fs.realpathSync(process.env.RHO_AGENT_PLUGIN_PACKAGE) : buildAgentPlugin(path.join(directory, 'package'));
  assert.ok(!source.startsWith(root + path.sep), 'Use an independent package');
  assert.equal(digest(executable), original);
  execFileSync(executable, ['--ignored', '--nocapture'], {cwd: root, env: {...env, RHO_AGENT_PLUGIN_PACKAGE: source}, stdio: 'inherit'});
  assert.equal(digest(executable), original);
  console.log(`Independent Agent metadata package passed generic Host identity, isolation, idempotency and journal retention checks. Host harness SHA256 ${original}`);
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
