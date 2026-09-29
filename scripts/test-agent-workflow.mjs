import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agentAcceptanceOptions, agentBuildInputDigest, agentBuildMode, agentSourceCopies, recordAgentBuild, verifyAgentBuild} from './agent-plugin-artifact.mjs';

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
assert.equal(parse(['--package', '/tmp/example', '--browser'], {browser: true}).browser, true);
assert.throws(() => parse(['--build', '--browser'], {browser: true}), /never starts another build/);
assert.throws(() => parse(['--package', '/tmp/example', '--browser']), /Unknown option/);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rho-agent-workflow-'));
try {
  const checkout = path.join(temporary, 'checkout'), pkg = path.join(temporary, 'external');
  const write = (file, text) => {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text);};
  for (const [source] of agentSourceCopies) write(path.join(checkout, source, 'source.rs'), source);
  for (const source of ['Cargo.toml', 'Cargo.lock', 'LICENSE', 'rust-toolchain.toml', 'scripts/build-agent-plugin.mjs', 'scripts/agent-plugin-artifact.mjs']) write(path.join(checkout, source), source);
  write(path.join(pkg, 'plugin.json'), '{}');
  write(path.join(pkg, 'dist/backend'), 'fixture artifact');
  const inputs = agentBuildInputDigest(checkout);
  assert.throws(() => verifyAgentBuild(pkg, checkout), /no build receipt/);
  recordAgentBuild(pkg, inputs, checkout);
  assert.equal(agentBuildMode(pkg), 'independent');
  assert.equal(verifyAgentBuild(pkg, checkout), fs.realpathSync(pkg));
  const workspacePackage = path.join(temporary, 'workspace-built');
  write(path.join(workspacePackage, 'plugin.json'), '{}');
  recordAgentBuild(workspacePackage, inputs, checkout, 'workspace');
  assert.equal(agentBuildMode(workspacePackage), 'workspace');
  assert.equal(verifyAgentBuild(workspacePackage, checkout), fs.realpathSync(workspacePackage));
  const manifest = path.join(checkout, 'Cargo.toml');
  fs.appendFileSync(manifest, '\nchanged workspace configuration');
  assert.throws(() => verifyAgentBuild(workspacePackage, checkout), /Agent sources changed/);
  write(manifest, 'Cargo.toml');
  const receiptFile = `${workspacePackage}.build.json`, receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  delete receipt.build_mode; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.throws(() => verifyAgentBuild(workspacePackage, checkout), /identify its build mode/);
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
  // The combined browser fixture must support the explicit model-catalog probe,
  // whose ACP session intentionally has no scientific MCP endpoint.
  const peer = path.join(temporary, 'kimi');
  write(path.join(temporary, 'rho-science-fixture'), 'disposable');
  fs.copyFileSync(path.join(root, 'crates/host/tests/fixtures/agent-science.cjs'), peer);
  const messages = [
    {jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:1}},
    {jsonrpc:'2.0', id:2, method:'session/new', params:{cwd:temporary, mcpServers:[]}},
    {jsonrpc:'2.0', id:3, method:'session/close', params:{}},
  ];
  const probe = spawnSync(process.execPath, [peer], {input:messages.map(m => JSON.stringify(m)).join('\n')+'\n', encoding:'utf8', timeout:5000});
  assert.equal(probe.status, 0, probe.stderr);
  const replies = probe.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1,2,3]);
  assert.equal(replies[1].result.configOptions[0].currentValue, 'fixture');
  assert.ok(!fs.existsSync(path.join(temporary, 'native-science-evidence.json')), 'Discovery must not start a scientific turn');
  // The restart fixture restores only its persisted native session. Loading
  // history cannot issue a prompt or require a live scientific MCP provider.
  const mcpServers = [{name:'disposable', url:'http://127.0.0.1:9', headers:[]}];
  const nativeMessages = structuredClone(messages);
  nativeMessages[1].params.mcpServers = mcpServers;
  const start = spawnSync(process.execPath, [peer], {input:nativeMessages.map(m => JSON.stringify(m)).join('\n')+'\n', encoding:'utf8', timeout:5000});
  assert.equal(start.status, 0, start.stderr);
  const {session} = JSON.parse(fs.readFileSync(path.join(temporary, 'native-science-session.json'), 'utf8'));
  const load = [...messages];
  load[1] = {jsonrpc:'2.0', id:2, method:'session/load', params:{cwd:temporary, sessionId:session, mcpServers}};
  const resumed = spawnSync(process.execPath, [peer], {input:load.map(m => JSON.stringify(m)).join('\n')+'\n', encoding:'utf8', timeout:5000});
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout.trim().split('\n')[1]).result.sessionId, session);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'native-science-resumes.json'), 'utf8')), {session, resumes:1, prompts:0});
  assert.ok(!fs.existsSync(path.join(temporary, 'native-science-evidence.json')), 'Resume must not start a scientific turn');
} finally { fs.rmSync(temporary, {recursive: true, force: true}); }
console.log('Agent acceptance requires an explicit mode; source/artifact reuse rejects stale, modified or missing evidence. Local ACP discovery and original-session resume passed without a scientific turn. No Cargo build ran.');
