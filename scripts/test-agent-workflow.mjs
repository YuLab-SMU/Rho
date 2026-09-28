import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentAcceptanceOptions, agentBuildInputDigest, agentSourceCopies, recordAgentBuild, verifyAgentBuild} from './agent-plugin-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parse = (args, extra = {}) => agentAcceptanceOptions(args, {environment: {}, ...extra});
assert.throws(() => parse([]), /Milestone acceptance requires/);
assert.equal(parse(['--build']).build, true);
assert.equal(parse(['--package', '/tmp/example']).packagePath, '/tmp/example');
assert.equal(parse([], {environment: {RHO_AGENT_PLUGIN_PACKAGE: '/tmp/example'}}).packagePath, '/tmp/example');
for (const args of [['--build', '--package', '/tmp/example'], ['--package'], ['--package', '--build'], ['--build', '--build'], ['--typo'], ['--build', '--skip-framed']]) {
  assert.throws(() => parse(args));
}
assert.equal(parse(['--build', '--skip-framed'], {framed: true}).skipFramed, true);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-workflow-'));
try {
  const checkout = path.join(temporary, 'checkout'), pkg = path.join(temporary, 'external');
  const write = (file, text) => {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text);};
  for (const [source] of agentSourceCopies) write(path.join(checkout, source, 'source.rs'), source);
  for (const source of ['Cargo.lock', 'LICENSE', 'rust-toolchain.toml', 'scripts/build-agent-plugin.mjs', 'scripts/agent-plugin-artifact.mjs']) write(path.join(checkout, source), source);
  write(path.join(pkg, 'plugin.json'), '{}');
  write(path.join(pkg, 'dist/backend'), 'fixture artifact');
  const inputs = agentBuildInputDigest(checkout);
  assert.throws(() => verifyAgentBuild(pkg, checkout), /no build receipt/);
  recordAgentBuild(pkg, inputs, checkout);
  assert.equal(verifyAgentBuild(pkg, checkout), fs.realpathSync(pkg));
  write(path.join(checkout, 'docs/notes.md'), 'An unrelated documentation edit');
  assert.equal(verifyAgentBuild(pkg, checkout), fs.realpathSync(pkg));
  const source = path.join(checkout, 'plugins/agent/source.rs');
  const original = fs.readFileSync(source);
  write(source, 'changed');
  assert.throws(() => verifyAgentBuild(pkg, checkout), /Agent sources changed/);
  assert.throws(() => recordAgentBuild(pkg, inputs, checkout), /changed during the build/);
  fs.writeFileSync(source, original);
  fs.appendFileSync(path.join(pkg, 'dist/backend'), 'tampered');
  assert.throws(() => verifyAgentBuild(pkg, checkout), /package changed/);
  write(path.join(pkg, 'dist/backend'), 'fixture artifact');
  fs.chmodSync(path.join(pkg, 'dist/backend'), 0o755);
  assert.throws(() => verifyAgentBuild(pkg, checkout), /package changed/);
  fs.chmodSync(path.join(pkg, 'dist/backend'), 0o644);
  fs.symlinkSync(source, path.join(pkg, 'source-link'));
  assert.throws(() => verifyAgentBuild(pkg, checkout), /symlinks/);
  fs.unlinkSync(path.join(pkg, 'source-link'));
  assert.equal(verifyAgentBuild(pkg, checkout), fs.realpathSync(pkg));
  assert.throws(() => verifyAgentBuild(checkout, checkout), /external Agent package/);

  // A forgotten mode must fail before any compiler or fixture can start.
  const bin = path.join(temporary, 'bin'), marker = path.join(temporary, 'compiler-started');
  write(path.join(bin, 'cargo'), '#!/bin/sh\ntouch "$RHO_WORKFLOW_MARKER"\nexit 99\n');
  fs.chmodSync(path.join(bin, 'cargo'), 0o755);
  const env = {...process.env, PATH: bin + path.delimiter + process.env.PATH, RHO_WORKFLOW_MARKER: marker};
  delete env.RHO_AGENT_PLUGIN_PACKAGE;
  for (const runner of ['test-agent-plugin.mjs', 'test-agent-core-tools.mjs', 'test-agent-plugin-real-r.mjs']) {
    for (const [args, expected] of [[[], /Milestone acceptance requires/], [['--package', pkg], /Agent sources changed/]]) {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts', runner), ...args], {env, encoding: 'utf8', timeout: 5000});
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expected);
      assert.ok(!fs.existsSync(marker), `${runner} unexpectedly started Cargo`);
    }
  }
} finally { fs.rmSync(temporary, {recursive: true, force: true}); }
console.log('Agent acceptance requires an explicit mode; source/artifact reuse rejects stale, modified or missing evidence. No Cargo build ran.');
